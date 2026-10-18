import { afterEach, describe, expect, test } from 'bun:test';
import * as http from 'http';

import {
  authorizeSessionOwnership,
  clearSessionOwnership,
  deniedDeleteTargetsAbsentObject,
  fileServerReportsAbsent,
  recordSessionOwnership,
  sessionCacheKey,
  sessionOwnerKey,
  type SessionOwnershipStore,
} from './session-ownership';

interface Written {
  value: string;
  ttl: number;
}

function createStore(seed: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(seed));
  const writes: Record<string, Written> = {};
  const store: SessionOwnershipStore = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, _expiryMode, ttlSeconds) => {
      values.set(key, value);
      writes[key] = { value, ttl: ttlSeconds };
      return 'OK';
    },
    del: async (...keys) => {
      let removed = 0;
      for (const key of keys) {
        if (values.delete(key)) removed += 1;
      }
      return removed;
    },
  };
  return { store, writes, values };
}

const SESSION_ID = 'session-1';
const OWNER = 'tenant-1:user:user-1';

describe('recordSessionOwnership', () => {
  test('writes the cache key and the durable owner record together', async () => {
    const { store, writes } = createStore();

    await recordSessionOwnership(store, SESSION_ID, OWNER, { cacheTtl: 100, ownerTtl: 9000 });

    expect(writes[sessionCacheKey(SESSION_ID)]).toEqual({ value: OWNER, ttl: 100 });
    expect(writes[sessionOwnerKey(SESSION_ID)]).toEqual({ value: OWNER, ttl: 9000 });
  });
});

describe('clearSessionOwnership', () => {
  test('rolls back both records', async () => {
    const { store, values } = createStore();
    await recordSessionOwnership(store, SESSION_ID, OWNER, { cacheTtl: 100, ownerTtl: 9000 });

    await clearSessionOwnership(store, SESSION_ID);

    expect(values.has(sessionCacheKey(SESSION_ID))).toBe(false);
    expect(values.has(sessionOwnerKey(SESSION_ID))).toBe(false);
  });
});

describe('authorizeSessionOwnership', () => {
  test('authorizes from the cache key while it is live', async () => {
    const { store } = createStore({ [sessionCacheKey(SESSION_ID)]: OWNER });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: false,
    });

    expect(result).toEqual({ authorized: true, source: 'session' });
  });

  test('denies a read once the cache key has expired, even with an owner record', async () => {
    const { store } = createStore({ [sessionOwnerKey(SESSION_ID)]: OWNER });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: false,
    });

    expect(result).toEqual({ authorized: false, reason: 'expired', cachedSessionKey: null });
  });

  test('authorizes a delete from the owner record once the cache key has expired', async () => {
    const { store } = createStore({ [sessionOwnerKey(SESSION_ID)]: OWNER });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({ authorized: true, source: 'owner' });
  });

  test('a live cache key naming another owner is authoritative and blocks the fallback', async () => {
    const { store } = createStore({
      [sessionCacheKey(SESSION_ID)]: 'tenant-1:user:someone-else',
      /* Stale owner record that would otherwise match — a re-registered
       * session must not be deletable by its previous owner. */
      [sessionOwnerKey(SESSION_ID)]: OWNER,
    });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({
      authorized: false,
      reason: 'mismatch',
      cachedSessionKey: 'tenant-1:user:someone-else',
    });
  });

  test('denies a delete when the owner record names someone else', async () => {
    const { store } = createStore({ [sessionOwnerKey(SESSION_ID)]: 'tenant-2:user:user-2' });

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({
      authorized: false,
      reason: 'mismatch',
      cachedSessionKey: 'tenant-2:user:user-2',
    });
  });

  test('reports sessions that predate the owner record as unknown', async () => {
    const { store } = createStore();

    const result = await authorizeSessionOwnership(store, {
      session_id: SESSION_ID,
      expectedSessionKey: OWNER,
      allowExpiredCache: true,
    });

    expect(result).toEqual({ authorized: false, reason: 'unknown', cachedSessionKey: null });
  });

  test('a session registered through recordSessionOwnership stays deletable past the cache TTL', async () => {
    const { store, values } = createStore();
    await recordSessionOwnership(store, SESSION_ID, OWNER, { cacheTtl: 1, ownerTtl: 9000 });

    /* Simulate the cache key aging out while the owner record lives on. */
    values.delete(sessionCacheKey(SESSION_ID));

    expect(
      await authorizeSessionOwnership(store, {
        session_id: SESSION_ID,
        expectedSessionKey: OWNER,
        allowExpiredCache: true,
      }),
    ).toEqual({ authorized: true, source: 'owner' });
  });
});

describe('deniedDeleteTargetsAbsentObject', () => {
  test('an unknown owner with the object gone answers absent', async () => {
    expect(await deniedDeleteTargetsAbsentObject('unknown', async () => true)).toBe(true);
  });

  test('an expired owner with the object gone answers absent', async () => {
    expect(await deniedDeleteTargetsAbsentObject('expired', async () => true)).toBe(true);
  });

  test('an unknown owner with the object present stays refused', async () => {
    expect(await deniedDeleteTargetsAbsentObject('unknown', async () => false)).toBe(false);
  });

  test('a recorded different owner is refused without probing', async () => {
    let probed = false;
    const absent = await deniedDeleteTargetsAbsentObject('mismatch', async () => {
      probed = true;
      return true;
    });
    expect(absent).toBe(false);
    expect(probed).toBe(false);
  });

  test('a failing probe fails closed', async () => {
    const absent = await deniedDeleteTargetsAbsentObject('unknown', async () => {
      throw new Error('file server down');
    });
    expect(absent).toBe(false);
  });
});

describe('fileServerReportsAbsent', () => {
  let server: http.Server | undefined;
  let requests: Array<{ url: string; token: string | undefined }> = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    requests = [];
  });

  /** Stands in for the file server's metadata route with a fixed status. */
  async function startFileServer(status: number, delayMs = 0): Promise<string> {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? '', token: req.headers['x-codeapi-internal-token'] as string | undefined });
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      }, delayMs);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  test('404 from the metadata route means absent', async () => {
    const baseUrl = await startFileServer(404);
    const headers = { 'X-CodeAPI-Internal-Token': 'internal' };
    expect(await fileServerReportsAbsent(baseUrl, 'sess', 'file', headers)).toBe(true);
    expect(requests).toEqual([{ url: '/sessions/sess/objects/file/metadata', token: 'internal' }]);
  });

  test('a present object is not absent', async () => {
    const baseUrl = await startFileServer(200);
    expect(await fileServerReportsAbsent(baseUrl, 'sess', 'file', {})).toBe(false);
  });

  test('a file server error is not absent', async () => {
    const baseUrl = await startFileServer(500);
    expect(await fileServerReportsAbsent(baseUrl, 'sess', 'file', {})).toBe(false);
  });

  test('a slow file server times out, and the caller treats that as present', async () => {
    const baseUrl = await startFileServer(404, 500);
    const absent = await deniedDeleteTargetsAbsentObject('unknown', () =>
      fileServerReportsAbsent(baseUrl, 'sess', 'file', {}, 50),
    );
    expect(absent).toBe(false);
  });

  test('an unreachable file server is treated as present', async () => {
    const absent = await deniedDeleteTargetsAbsentObject('unknown', () =>
      fileServerReportsAbsent('http://127.0.0.1:1', 'sess', 'file', {}),
    );
    expect(absent).toBe(false);
  });
});
