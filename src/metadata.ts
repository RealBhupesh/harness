import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function assertMetadata(path: string) {
  if (realpathSync(dirname(path)) !== resolve(dirname(path)))
    throw new Error('Metadata directory must not be a symlink');
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)
      throw new Error('Metadata must be a regular unlinked repository file');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}
