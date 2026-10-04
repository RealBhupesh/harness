import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deadlineOf } from './limits.js';
export type CLIResult = {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};
// This watchdog remains alive if the harness dies and owns the CLI process group.
const HOST = String.raw`
const {spawn}=require('node:child_process');
const [encoded,cwd,deadlineText,maxText]=process.argv.slice(1);const argv=JSON.parse(encoded),deadline=Number(deadlineText),max=Number(maxText);
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
if(Date.now()>=deadline)process.exit(124);
const child=spawn(argv[0],argv.slice(1),{cwd,env:process.env,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
let code=null,bytes=0;
function stop(status){code=status;try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
process.on('SIGTERM',()=>stop(143));const timer=setTimeout(()=>stop(124),Math.max(1,deadline-Date.now()));
child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin);
function forward(stream,data){bytes+=data.length;if(bytes>max){stop(125);return;}try{stream.write(data);}catch{}}
child.stdout.on('data',d=>forward(process.stdout,d));child.stderr.on('data',d=>forward(process.stderr,d));
child.on('error',error=>{clearTimeout(timer);process.stderr.write(error.message);process.exitCode=127;});
child.on('close',status=>{clearTimeout(timer);process.exitCode=code??status??1;});
`;
export function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TERM',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
export async function runCLI(
  argv: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<CLIResult> {
  if (signal?.aborted) throw signal.reason;
  const deadline = Math.min(Date.now() + timeoutMs, deadlineOf(signal));
  const env = subscriptionEnvironment();
  env.CODEX_SQLITE_HOME = join(cwd, 'state');
  mkdirSync(env.CODEX_SQLITE_HOME, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const host = spawn(
      process.execPath,
      [
        '-e',
        HOST,
        JSON.stringify(argv),
        cwd,
        String(deadline),
        String(maxBytes),
      ],
      {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let bytes = 0;
    const capture = (target: Buffer[], data: Buffer) => {
      bytes += data.length;
      if (bytes <= maxBytes) target.push(data);
    };
    host.stdout.on('data', (d: Buffer) => capture(out, d));
    host.stderr.on('data', (d: Buffer) => capture(err, d));
    host.stdin.on('error', () => {});
    host.stdin.end(input);
    const cancel = () => {
      host.kill('SIGTERM');
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    host.on('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(error);
    });
    host.on('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        truncated: code === 125 || bytes > maxBytes,
      });
    });
  });
}
