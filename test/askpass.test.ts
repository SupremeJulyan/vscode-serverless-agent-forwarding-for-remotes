import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { createAskpassCredentials, platformUsesAskpass } from '../src/askpass';

const execFileAsync = promisify(execFile);

test('native macOS and Linux and Windows use ASKPASS, while WSL keeps its own flow', () => {
  assert.equal(platformUsesAskpass('macos'), true);
  assert.equal(platformUsesAskpass('linux'), true);
  assert.equal(platformUsesAskpass('windows'), true);
  assert.equal(platformUsesAskpass('wsl'), false);
});

test('ASKPASS supplies a terminal login password without exposing it in arguments', async () => {
  const credentials = await createAskpassCredentials('terminal secret');
  const helper = credentials.env.SSH_ASKPASS;
  const passwordFile = credentials.env.SERVERLESS_REMOTE_ASKPASS_FILE;
  assert.equal(helper.includes('terminal secret'), false);
  assert.equal(await readFile(passwordFile, 'utf8'), 'terminal secret');

  const result = await execFileAsync(helper, ['alice@host password:'], {
    env: { ...process.env, ...credentials.env }
  });
  assert.equal(result.stdout, 'terminal secret');
  await assert.rejects(access(passwordFile));
  await credentials.cleanup();
});

test('ASKPASS refuses to use a login password as a private-key passphrase', async () => {
  const credentials = await createAskpassCredentials('login password');
  await assert.rejects(execFileAsync(
    credentials.env.SSH_ASKPASS,
    ['Enter passphrase for key:'],
    { env: { ...process.env, ...credentials.env } }
  ));
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
