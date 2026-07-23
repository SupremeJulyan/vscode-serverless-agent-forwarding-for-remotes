import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  runWslBridgeUninstall, wslBridgeUninstallScript
} from '../src/lifecycle';

test('runs and removes the saved WSL bridge uninstall script', () => {
  const home = mkdtempSync(join(tmpdir(), 'serverless-remote-lifecycle-'));
  const script = join(home, wslBridgeUninstallScript);
  writeFileSync(script, '#!/bin/sh\n');
  let invoked = false;

  const status = runWslBridgeUninstall(home, (command, args) => {
    invoked = true;
    assert.equal(command, '/bin/bash');
    assert.deepEqual(args, [script]);
    return { status: 0 } as ReturnType<typeof import('node:child_process').spawnSync>;
  });

  assert.equal(status, 0);
  assert.equal(invoked, true);
  assert.equal(existsSync(script), false);
});

test('keeps the saved script when uninstall fails so it can be retried', () => {
  const home = mkdtempSync(join(tmpdir(), 'serverless-remote-lifecycle-'));
  const script = join(home, wslBridgeUninstallScript);
  writeFileSync(script, '#!/bin/sh\n');

  const status = runWslBridgeUninstall(home, () => (
    { status: 3 } as ReturnType<typeof import('node:child_process').spawnSync>
  ));

  assert.equal(status, 3);
  assert.equal(existsSync(script), true);
});
