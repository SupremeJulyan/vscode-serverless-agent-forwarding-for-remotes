import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAuthenticationFailure, isNetworkFailure, passwordValueOffset
} from '../src/authentication';

test('recognizes common SSH password authentication failures', () => {
  assert.equal(isAuthenticationFailure(new Error('Permission denied, please try again.')), true);
  assert.equal(isAuthenticationFailure(new Error('Authentication failed')), true);
  assert.equal(isAuthenticationFailure(new Error('Connection timed out')), false);
});

test('recognizes common SSH network failures separately from password failures', () => {
  assert.equal(isNetworkFailure(new Error('read: Connection reset by peer')), true);
  assert.equal(isNetworkFailure(new Error('ssh: connect to host x: Connection refused')), true);
  assert.equal(isNetworkFailure(new Error('Network is unreachable')), true);
  assert.equal(isNetworkFailure(new Error('Permission denied')), false);
});

test('finds the empty password value for a named host', () => {
  const content = JSON.stringify({
    hosts: [
      { name: 'first', password: 'enc:v1:old' },
      { name: 'dev.example', password: '' }
    ],
    mounts: []
  }, null, 2);
  const offset = passwordValueOffset(content, 'dev.example');
  assert.notEqual(offset, undefined);
  assert.equal(content.slice(offset!, offset! + 1), '"');
  assert.equal(content.slice(offset! - 13, offset! + 1), '"password": ""');
});
