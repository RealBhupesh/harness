import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
export class RunLock {
  constructor(readonly dir: string) {}
  acquire(): () => void {
    const path = join(this.dir, 'run.lock');
    if (existsSync(path)) {
      const owner = z
        .object({ pid: z.number().int().positive() })
        .parse(JSON.parse(readFileSync(path, 'utf8')));
      let active = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
          active = false;
        else throw error;
      }
      if (active)
        throw new Error('Relay is already running in this repository');
      unlinkSync(path);
    }
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    } finally {
      closeSync(fd);
    }
    return () => {
      if (
        existsSync(path) &&
        JSON.parse(readFileSync(path, 'utf8')).pid === process.pid
      )
        unlinkSync(path);
    };
  }
}
