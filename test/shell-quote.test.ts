import assert from 'node:assert/strict';
import test from 'node:test';
import { shellQuote } from '../src/shell-quote';

test('shellQuote keeps arbitrary text in one POSIX shell word', () => {
  assert.equal(shellQuote('plain path'), "'plain path'");
  assert.equal(shellQuote("it's\nremote"), "'it'\"'\"'s\nremote'");
  assert.equal(shellQuote(''), "''");
});
