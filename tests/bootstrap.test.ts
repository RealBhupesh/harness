import { expect, test } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
test('installed schema library rejects invalid configuration and scaffold supplies strict tooling', () => {
  expect(
    z
      .object({ maxTasks: z.number().int().positive() })
      .safeParse({ maxTasks: -1 }).success,
  ).toBe(false);
  const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
    compilerOptions: { strict: boolean };
  };
  expect(tsconfig.compilerOptions.strict).toBe(true);
  expect(readFileSync('AGENTS.md', 'utf8')).toContain('Next action');
});
