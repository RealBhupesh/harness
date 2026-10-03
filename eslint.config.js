import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', '.relay/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  ...ts.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
