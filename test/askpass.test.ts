import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createAskpassCredentials, platformUsesAskpass } from '../src/askpass';

const execFileAsync = promisify(execFile);

test('native macOS and Linux use ASKPASS, while Windows and WSL keep their own flows', () => {
  assert.equal(platformUsesAskpass('macos'), true);
  assert.equal(platformUsesAskpass('linux'), true);
  assert.equal(platformUsesAskpass('windows'), false);
  assert.equal(platformUsesAskpass('wsl'), false);
});

test('ASKPASS returns the password without placing it in command arguments', async () => {
  const credentials = await createAskpassCredentials('secret value');
  const helper = credentials.env.SSH_ASKPASS;
  const passwordFile = credentials.env.SERVERLESS_REMOTE_ASKPASS_FILE;
  assert.equal(helper.includes('secret value'), false);
  assert.equal((await readFile(passwordFile, 'utf8')), 'secret value');

  const result = await execFileAsync(helper, ['alice@host password:'], {
    env: { ...process.env, ...credentials.env }
  });
  assert.equal(result.stdout, 'secret value');
  await assert.rejects(access(passwordFile));
  await credentials.cleanup();
});

test('ASKPASS does not use a login password for a private-key passphrase prompt', async () => {
  const credentials = await createAskpassCredentials('login password');
  const helper = credentials.env.SSH_ASKPASS;
  await assert.rejects(execFileAsync(helper, ['Enter passphrase for key:'], {
    env: { ...process.env, ...credentials.env }
  }));
  assert.equal(await readFile(credentials.env.SERVERLESS_REMOTE_ASKPASS_FILE, 'utf8'), 'login password');
  await credentials.cleanup();
});

test('ASKPASS cleanup removes unused credentials', async () => {
  const credentials = await createAskpassCredentials('unused secret');
  const passwordFile = credentials.env.SERVERLESS_REMOTE_ASKPASS_FILE;
  await credentials.cleanup();
  await assert.rejects(access(passwordFile));
});
