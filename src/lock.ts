import { assertMetadata } from './metadata.js';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  linkSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export class RunLock {
  constructor(readonly dir: string) {}
  acquire(): () => void {
    const path = join(this.dir, 'run.lock');
    assertMetadata(path);
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text) {
        const owner = z
          .object({ pid: z.number().int().positive() })
          .parse(JSON.parse(text));
        let active = true;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ESRCH'
          )
            active = false;
          else throw error;
        }
        if (active)
          throw new Error('Relay is already running in this repository');
      }
      unlinkSync(path);
    }
    const nonce = randomUUID(),
      temp = join(this.dir, `lock-${nonce}.tmp`),
      fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } catch {
      throw new Error('Relay is already running in this repository');
    } finally {
      unlinkSync(temp);
    }
    return () => {
      if (
        existsSync(path) &&
        JSON.parse(readFileSync(path, 'utf8')).nonce === nonce
      )
        unlinkSync(path);
    };
  }
}
