import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptPassword, encryptPassword, isEncryptedPassword } from '../src/password';

test('encrypts and decrypts bridge-compatible password values', async () => {
  const encrypted = await encryptPassword('服务器 password !', 'master secret');
  assert.equal(isEncryptedPassword(encrypted), true);
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(await decryptPassword(encrypted, 'master secret'), '服务器 password !');
});

test('rejects an incorrect master password', async () => {
  const encrypted = await encryptPassword('secret', 'correct');
  await assert.rejects(() => decryptPassword(encrypted, 'incorrect'), /主口令错误/);
});
