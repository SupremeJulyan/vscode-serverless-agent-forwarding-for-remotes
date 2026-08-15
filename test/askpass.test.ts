import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAskpassCredentials, platformUsesAskpass } from '../src/askpass';
import { executeCaptured } from '../src/process';

test('all SSH platforms, including WSL, use ASKPASS', () => {
  assert.equal(platformUsesAskpass('macos'), true);
  assert.equal(platformUsesAskpass('linux'), true);
  assert.equal(platformUsesAskpass('windows'), true);
  assert.equal(platformUsesAskpass('wsl'), true);
});

test('ASKPASS supplies a terminal login password without exposing it in arguments', async () => {
  const credentials = await createAskpassCredentials('terminal secret');
  const helper = credentials.env.SSH_ASKPASS;
  const passwordFile = credentials.env.SERVERLESS_REMOTE_ASKPASS_FILE;
  assert.equal(helper.includes('terminal secret'), false);
  assert.equal(await readFile(passwordFile, 'utf8'), 'terminal secret');

  const result = await executeCaptured(
    { command: helper, args: ['alice@host password:'], env: credentials.env },
    undefined, 16 * 1024
  );
  assert.equal(result.stdout.trim(), 'terminal secret');
  // Windows 的 .bat helper 自删除（del "%~f0"）会让 cmd 以错误码 1 收尾，
  // 但密码已输出；OpenSSH 只消费 stdout，退出码不影响。POSIX 下为 0。
  if (process.platform !== 'win32') assert.equal(result.exitCode, 0);
  await assert.rejects(access(passwordFile));
  await credentials.cleanup();
});

test('ASKPASS refuses to use a login password as a private-key passphrase', async () => {
  const credentials = await createAskpassCredentials('login password');
  const result = await executeCaptured(
    {
      command: credentials.env.SSH_ASKPASS,
      args: ['Enter passphrase for key:'],
      env: credentials.env
    },
    undefined, 16 * 1024
  );
  assert.notEqual(result.exitCode, 0);
  assert.equal(
    await readFile(credentials.env.SERVERLESS_REMOTE_ASKPASS_FILE, 'utf8'),
    'login password'
  );
  await credentials.cleanup();
});

test('ASKPASS cleanup removes unused terminal credentials', async () => {
  const credentials = await createAskpassCredentials('unused secret');
  const passwordFile = credentials.env.SERVERLESS_REMOTE_ASKPASS_FILE;
  await credentials.cleanup();
  await assert.rejects(access(passwordFile));
});
