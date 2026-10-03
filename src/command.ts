import { deadlineOf } from './limits.js';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from './memory.js';
import type { CommandResult } from './tools.js';
import type { Config } from './schema.js';
// An independent host owns the timeout, so a killed harness cannot orphan a command indefinitely.
const HOST = String.raw`
const {spawn}=require('node:child_process');const fs=require('node:fs');
const [encoded,cwd,deadlineText,statePath,nonce]=process.argv.slice(1);const deadline=Number(deadlineText);
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
if(Date.now()>=deadline){process.exit(124);}
const temp=statePath+'.'+nonce+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({hostPid:process.pid,deadline,nonce}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,statePath);
const argv=JSON.parse(encoded);const child=spawn(argv[0],argv.slice(1),{cwd,env:process.env,shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
let code=null;
function stop(status){code=status;try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
process.on('SIGTERM',()=>stop(143));const timer=setTimeout(()=>stop(124),Math.max(1,deadline-Date.now()));
child.stdout.on('data',data=>{try{process.stdout.write(data);}catch{}});child.stderr.on('data',data=>{try{process.stderr.write(data);}catch{}});
child.on('error',error=>{clearTimeout(timer);process.stderr.write(error.message);process.exitCode=1;});
child.on('close',status=>{clearTimeout(timer);process.exitCode=code??status??1;});
`;
const State = z.object({
  hostPid: z.number().int().positive().nullable(),
  deadline: z.number(),
  nonce: z.string().uuid(),
});
const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
function alive(pid: number, nonce: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
  if (process.platform === 'linux') {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (!command) return false;
    if (!command.includes(nonce))
      throw new Error(
        'Command process identity changed; inspect .relay/active-command.json before retrying',
      );
  }
  return true;
}
export async function runCommand(
  root: string,
  config: Config,
  argv: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw signal.reason;
  const dir = join(root, '.relay');
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
    throw new Error('Command state must remain inside repository');
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'active-command.json');
  if (existsSync(statePath) && lstatSync(statePath).isSymbolicLink())
    throw new Error('Command state must not be a symlink');
  if (existsSync(statePath)) {
    let state = State.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    while (state.hostPid === null && Date.now() < state.deadline) {
      await delay(5, signal);
      state = State.parse(JSON.parse(readFileSync(statePath, 'utf8')));
    }
    if (state.hostPid !== null && alive(state.hostPid, state.nonce)) {
      process.kill(state.hostPid, 'SIGTERM');
      const end = Date.now() + 2000;
      while (alive(state.hostPid, state.nonce) && Date.now() < end)
        await delay(5, signal);
      if (alive(state.hostPid, state.nonce))
        throw new Error(
          'Previous command has not stopped; refusing concurrent replay',
        );
    }
    unlinkSync(statePath);
  }
  if (signal?.aborted) throw signal.reason;
  const nonce = randomUUID(),
    deadline = Math.min(
      Date.now() + config.commandTimeoutMs,
      deadlineOf(signal),
    );
  atomicWrite(statePath, JSON.stringify({ hostPid: null, deadline, nonce }));
  const safeEnv: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'HOME',
    'COREPACK_HOME',
    'npm_config_cache',
    'npm_config_devdir',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
  ])
    if (process.env[name]) safeEnv[name] = process.env[name];
  safeEnv.GIT_PAGER = 'cat';
  safeEnv.CI = '1';
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        HOST,
        JSON.stringify(argv),
        root,
        String(deadline),
        statePath,
        nonce,
      ],
      {
        cwd: root,
        env: safeEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '',
      bytes = 0,
      truncated = false;
    const capture = (kind: 'out' | 'err', data: Buffer) => {
      const room = Math.max(0, config.maxOutputBytes - bytes),
        text = data.subarray(0, room).toString();
      bytes += data.length;
      truncated ||= bytes > config.maxOutputBytes;
      if (kind === 'out') stdout += text;
      else stderr += text;
    };
    child.stdout.on('data', (d: Buffer) => capture('out', d));
    child.stderr.on('data', (d: Buffer) => capture('err', d));
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      if (
        existsSync(statePath) &&
        State.parse(JSON.parse(readFileSync(statePath, 'utf8'))).nonce === nonce
      )
        unlinkSync(statePath);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr: stderr + (code === 124 ? '\nCommand timeout' : ''),
        truncated,
      });
    });
  });
}
