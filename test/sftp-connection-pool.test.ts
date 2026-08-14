import assert from 'node:assert/strict';
import test from 'node:test';
import { SftpConnectionPool } from '../src/sftp/connection-pool';
import { SftpSession } from '../src/sftp/session';

function fakeSession(
  hostName: string, close: () => void, isAlive: () => boolean = () => true
): SftpSession {
  const unused = async () => {
    throw new Error('unused');
  };
  return {
    hostName,
    isAlive,
    realpath: unused,
    stat: unused,
    readDirectory: unused,
    readFile: unused,
    readFileRange: unused,
    writeFile: unused,
    chmod: unused,
    createDirectory: unused,
    deleteFile: unused,
    deleteDirectory: unused,
    rename: unused,
    close: async () => close()
  };
}

test('deduplicates concurrent connections to one host', async () => {
  let connections = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pool = new SftpConnectionPool(async (hostName) => {
    connections += 1;
    await pending;
    return fakeSession(hostName, () => undefined);
  });
  const first = pool.get('dev');
  const second = pool.get('dev');
  release();
  assert.equal(await first, await second);
  assert.equal(connections, 1);
  assert.equal(pool.state('dev'), 'connected');
});

test('closes and removes a connected session', async () => {
  let closes = 0;
  const pool = new SftpConnectionPool(async (hostName) =>
    fakeSession(hostName, () => {
      closes += 1;
    })
  );
  await pool.get('dev');
  await pool.disconnect('dev');
  assert.equal(closes, 1);
  assert.equal(pool.state('dev'), 'disconnected');
});

test('records connection errors and permits a retry', async () => {
  let attempts = 0;
  const pool = new SftpConnectionPool(async (hostName) => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return fakeSession(hostName, () => undefined);
  });
  await assert.rejects(pool.get('dev'), /offline/);
  assert.equal(pool.state('dev'), 'error');
  await pool.get('dev');
  assert.equal(attempts, 2);
  assert.equal(pool.state('dev'), 'connected');
});

test('reports a dead connected session as disconnected', async () => {
  let alive = true;
  const pool = new SftpConnectionPool(async (hostName) =>
    fakeSession(hostName, () => undefined, () => alive)
  );
  await pool.get('dev');
  assert.equal(pool.state('dev'), 'connected');
  alive = false;
  assert.equal(pool.state('dev'), 'disconnected');
});

test('notifies when connection state changes', async () => {
  const states: string[] = [];
  let pool!: SftpConnectionPool;
  pool = new SftpConnectionPool(
    async (hostName) => fakeSession(hostName, () => undefined),
    (hostName) => states.push(`${hostName}:${pool.state(hostName)}`)
  );
  await pool.get('dev');
  await pool.disconnect('dev');
  assert.deepEqual(states, ['dev:connecting', 'dev:connected', 'dev:disconnected']);
});

test('reconnects after an established session becomes disconnected', async () => {
  let alive = true;
  let attempts = 0;
  const pool = new SftpConnectionPool(async (hostName) => {
    attempts += 1;
    const currentAttempt = attempts;
    return fakeSession(
      hostName,
      () => undefined,
      () => currentAttempt > 1 || alive
    );
  });
  await pool.get('dev');
  alive = false;
  await pool.get('dev');
  assert.equal(attempts, 2);
  assert.equal(pool.state('dev'), 'connected');
});

test('closes the stale session when reconnecting over a dead one', async () => {
  let alive = true;
  let closes = 0;
  let attempts = 0;
  const pool = new SftpConnectionPool(async (hostName) => {
    attempts += 1;
    const currentAttempt = attempts;
    return fakeSession(
      hostName,
      () => { closes += 1; },
      () => currentAttempt > 1 || alive
    );
  });
  await pool.get('dev');
  alive = false;
  await pool.get('dev');
  assert.equal(attempts, 2);
  assert.equal(closes, 1);
});

test('closeIdle recycles only sessions idle beyond the threshold', async () => {
  const closed = new Set<string>();
  const pool = new SftpConnectionPool(async (hostName) =>
    fakeSession(hostName, () => { closed.add(hostName); })
  );
  await pool.get('a');
  await pool.get('b');
  await pool.closeIdle(0);
  assert.deepEqual([...closed].sort(), ['a', 'b']);
  assert.equal(pool.state('a'), 'disconnected');

  await pool.get('c');
  await pool.closeIdle(60_000);
  assert.deepEqual([...closed].sort(), ['a', 'b']);
});
