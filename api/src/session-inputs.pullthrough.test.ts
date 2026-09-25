import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { Job, resetSessionCachesForTest, type TFile } from './job';
import {
  SESSION_INPUT_CACHE_DIR,
  hasCachedInput,
  inputCacheKey,
  openCachedInput,
  storeCachedInputFile,
} from './session-inputs';

/**
 * Pull-through population: a read-only input downloaded once is served from
 * the runner's own disk on every later execute. In production each file costs
 * a ~50ms round trip through the egress gateway, and an Office turn carries
 * ~70 of them, so what these tests pin is which requests happen at all.
 */

let tmpDir: string;
let served: string[];
let server: http.Server;
let baseUrl: string;
const originalConfig = {
  pullThrough: config.pull_through_cache,
  markerTtl: config.marker_cache_ttl_ms,
  fileServerUrl: config.file_server_url,
};

/** Stands in for the file server: records every request so a test can assert
 *  a later execute never asked for the object again. */
function startFileServer(objects: Record<string, { body: string; readOnly: boolean }>): Promise<void> {
  served = [];
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    served.push(url.pathname + url.search);
    const listing = url.pathname.endsWith('/objects');
    if (listing) {
      const sid = url.pathname.split('/')[2];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([
        { id: 'marker', name: 'empty/.dirkeep', storage_session_id: sid, size: 0 },
      ]));
      return;
    }
    const id = decodeURIComponent(path.basename(url.pathname));
    const object = objects[id];
    if (!object) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, object.readOnly ? { 'x-read-only': 'true' } : {});
    res.end(object.body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
}

function makeJob(files: TFile[]): Job {
  return new Job({
    session_id: 'pull-through-test',
    runtime: { language: 'bash', version: '5.0.0', aliases: [], runtime: 'bash' } as never,
    args: [],
    stdin: '',
    files,
    timeouts: { run: 5000, compile: 5000 },
    cpu_times: { run: 5000, compile: 5000 },
    memory_limits: { run: 128 * 1024 * 1024, compile: 128 * 1024 * 1024 },
  } as never);
}

async function primeInto(dir: string, file: TFile): Promise<string> {
  const job = makeJob([file]);
  (job as unknown as { submissionDir: string }).submissionDir = dir;
  return job.downloadAndWriteFile({ ...file });
}

beforeEach(() => {
  resetSessionCachesForTest();
  config.pull_through_cache = true;
  config.marker_cache_ttl_ms = 60_000;
});

afterEach(async () => {
  config.pull_through_cache = originalConfig.pullThrough;
  config.marker_cache_ttl_ms = originalConfig.markerTtl;
  config.file_server_url = originalConfig.fileServerUrl;
  resetSessionCachesForTest();
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  server = undefined as unknown as http.Server;
  await fsp.rm(SESSION_INPUT_CACHE_DIR, { recursive: true, force: true }).catch(() => {});
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('storeCachedInputFile', () => {
  test('commits data and metadata so a later probe hits', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-store-'));
    const source = path.join(tmpDir, 'skill.md');
    await fsp.writeFile(source, '# skill\n');

    const stored = await storeCachedInputFile('s1', 'f1', source, { readOnly: true }, 1024 * 1024);
    expect(stored).toBe(true);

    const entry = await openCachedInput('s1', 'f1');
    expect(entry?.meta.readOnly).toBe(true);
    await entry?.handle.close();
  });

  test('does not rewrite an object that is already cached', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-store-twice-'));
    const source = path.join(tmpDir, 'skill.md');
    await fsp.writeFile(source, '# skill\n');

    expect(await storeCachedInputFile('s1', 'f1', source, { readOnly: true }, 1024 * 1024)).toBe(true);
    expect(await storeCachedInputFile('s1', 'f1', source, { readOnly: true }, 1024 * 1024)).toBe(false);
  });

  test('refuses an object larger than the whole cache budget', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-store-big-'));
    const source = path.join(tmpDir, 'big.bin');
    await fsp.writeFile(source, Buffer.alloc(4096));

    expect(await storeCachedInputFile('s1', 'big', source, { readOnly: true }, 1024)).toBe(false);
    expect(await hasCachedInput('s1', 'big')).toBe(false);
  });

  test('leaves no staging directory behind', async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-store-staging-'));
    const source = path.join(tmpDir, 'skill.md');
    await fsp.writeFile(source, '# skill\n');
    await storeCachedInputFile('s1', 'f1', source, { readOnly: true }, 1024 * 1024);

    const entries = await fsp.readdir(SESSION_INPUT_CACHE_DIR);
    expect(entries.filter(name => name.startsWith('.staging-'))).toEqual([]);
  });
});

describe('priming populates the cache', () => {
  test('a read-only input is downloaded once and served locally afterwards', async () => {
    await startFileServer({ ro: { body: 'SKILL\n', readOnly: true } });
    config.file_server_url = baseUrl;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pull-through-'));

    const file: TFile = { id: 'ro', storage_session_id: 's1', name: 'skill.md' };
    await primeInto(tmpDir, file);
    expect(served).toHaveLength(1);

    /* The copy is deliberately not awaited by priming, so wait for the entry
     * rather than asserting on a race. */
    const key = inputCacheKey('s1', 'ro');
    for (let attempt = 0; attempt < 50 && !(await hasCachedInput('s1', 'ro', key)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await hasCachedInput('s1', 'ro', key)).toBe(true);

    const second = await fsp.mkdtemp(path.join(os.tmpdir(), 'pull-through-2-'));
    await primeInto(second, file);
    expect(served).toHaveLength(1);
    expect(await fsp.readFile(path.join(second, 'skill.md'), 'utf8')).toBe('SKILL\n');
    await fsp.rm(second, { recursive: true, force: true });
  });

  test('a writable input is fetched every time', async () => {
    await startFileServer({ rw: { body: 'draft\n', readOnly: false } });
    config.file_server_url = baseUrl;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pull-through-rw-'));

    const file: TFile = { id: 'rw', storage_session_id: 's1', name: 'report.docx' };
    await primeInto(tmpDir, file);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await hasCachedInput('s1', 'rw')).toBe(false);

    await primeInto(tmpDir, file);
    expect(served).toHaveLength(2);
  });

  test('the flag off leaves the cache empty', async () => {
    config.pull_through_cache = false;
    await startFileServer({ ro: { body: 'SKILL\n', readOnly: true } });
    config.file_server_url = baseUrl;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pull-through-off-'));

    await primeInto(tmpDir, { id: 'ro', storage_session_id: 's1', name: 'skill.md' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await hasCachedInput('s1', 'ro')).toBe(false);
  });

  test('a new skill version misses, because its objects carry new ids', async () => {
    await startFileServer({
      v1: { body: 'old\n', readOnly: true },
      v2: { body: 'new\n', readOnly: true },
    });
    config.file_server_url = baseUrl;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pull-through-version-'));

    await primeInto(tmpDir, { id: 'v1', storage_session_id: 's1', name: 'skill.md' });
    const second = await fsp.mkdtemp(path.join(os.tmpdir(), 'pull-through-version-2-'));
    await primeInto(second, { id: 'v2', storage_session_id: 's2', name: 'skill.md' });

    expect(served).toHaveLength(2);
    expect(await fsp.readFile(path.join(second, 'skill.md'), 'utf8')).toBe('new\n');
    await fsp.rm(second, { recursive: true, force: true });
  });
});

describe('.dirkeep listing cache', () => {
  async function listMarkers(sid: string): Promise<unknown[]> {
    const job = makeJob([]);
    return (job as unknown as {
      fetchSessionMarkers: (id: string) => Promise<unknown[]>;
    }).fetchSessionMarkers(sid);
  }

  test('a session that served only read-only objects is listed once', async () => {
    await startFileServer({ ro: { body: 'SKILL\n', readOnly: true } });
    config.file_server_url = baseUrl;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'markers-ro-'));

    await primeInto(tmpDir, { id: 'ro', storage_session_id: 's1', name: 'skill.md' });
    const first = await listMarkers('s1');
    const second = await listMarkers('s1');

    expect(first).toEqual(second);
    expect(served.filter(url => url.includes('detail=normalized'))).toHaveLength(1);
  });

  test('a session holding a writable object is listed every time', async () => {
    await startFileServer({ rw: { body: 'draft\n', readOnly: false } });
    config.file_server_url = baseUrl;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'markers-rw-'));

    await primeInto(tmpDir, { id: 'rw', storage_session_id: 's1', name: 'report.docx' });
    await listMarkers('s1');
    await listMarkers('s1');

    expect(served.filter(url => url.includes('detail=normalized'))).toHaveLength(2);
  });

  test('an expired entry is listed again', async () => {
    await startFileServer({ ro: { body: 'SKILL\n', readOnly: true } });
    config.file_server_url = baseUrl;
    config.marker_cache_ttl_ms = 1;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'markers-ttl-'));

    await primeInto(tmpDir, { id: 'ro', storage_session_id: 's1', name: 'skill.md' });
    await listMarkers('s1');
    await new Promise(resolve => setTimeout(resolve, 10));
    await listMarkers('s1');

    expect(served.filter(url => url.includes('detail=normalized'))).toHaveLength(2);
  });

  test('the TTL at zero disables reuse', async () => {
    await startFileServer({ ro: { body: 'SKILL\n', readOnly: true } });
    config.file_server_url = baseUrl;
    config.marker_cache_ttl_ms = 0;
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'markers-off-'));

    await primeInto(tmpDir, { id: 'ro', storage_session_id: 's1', name: 'skill.md' });
    await listMarkers('s1');
    await listMarkers('s1');

    expect(served.filter(url => url.includes('detail=normalized'))).toHaveLength(2);
  });
});
