import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256, sshfsWinInstaller, winFspInstaller } from '../src/windows-installer';

test('pins official Windows installer versions and checksums', () => {
  assert.equal(winFspInstaller.fileName, 'winfsp-2.2.26194.msi');
  assert.match(winFspInstaller.url, /^https:\/\/github\.com\/winfsp\/winfsp\/releases\/download\//);
  assert.match(winFspInstaller.sha256, /^[a-f0-9]{64}$/);
  assert.equal(sshfsWinInstaller.fileName, 'sshfs-win-3.7.21011-x64.msi');
  assert.match(sshfsWinInstaller.url, /^https:\/\/github\.com\/winfsp\/sshfs-win\/releases\/download\//);
  assert.match(sshfsWinInstaller.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    sha256(Buffer.from('serverless-remote')),
    '4272c86f61f89ad2bb30686af1e410faff11f1c238f108d2e05aacd7219c05f1'
  );
});
