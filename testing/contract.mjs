import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--test', 'test/contract.test.mjs', 'test/auth-runtime-contract.test.mjs', 'test/host-auth-runtime-contract.test.mjs', 'test/private-workflow-runtime-contract.test.mjs'], {
  env: { ...process.env, AUTO_RESET_CONTRACT_MODE: 'app-server' }, stdio: 'inherit',
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code; });
