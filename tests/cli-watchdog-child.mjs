import { runCLI } from '../src/cli-process.ts';
const [root, script] = process.argv.slice(2);
await runCLI([process.execPath, script], root, '', 600, 16000);
