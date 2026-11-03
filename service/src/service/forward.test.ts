import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'http';
import { Readable } from 'stream';
import { createHash, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { putFileObject } from './forward';

interface Received {
  bytes: number;
  sha256: string;
}

const MAX_SIZE = 32 * 1024 * 1024;
const CHUNK = 32 * 1024;

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/reject') {
      res.statusCode = 500;
      res.end('{}');
      return;
    }
    const hash = createHash('sha256');
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ bytes, sha256: hash.digest('hex') }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sends the first chunk, waits for the request to start streaming, then
 * pushes the rest and ends in one tick — what busboy does when the parser
 * catches up on a fast inbound socket while the outbound PUT is still slow.
 */
async function sendInBursts(data: Buffer, burstAfter: number): Promise<Received> {
  const file = new Readable({ read() {} });
  const sent = putFileObject({
    url: `${baseUrl}/object`,
    file,
    headers: { 'Content-Type': 'application/pdf' },
    maxSize: MAX_SIZE,
    signal: new AbortController().signal,
  });
  file.push(data.subarray(0, burstAfter));
  await tick(50);
  for (let offset = burstAfter; offset < data.length; offset += CHUNK) {
    file.push(data.subarray(offset, offset + CHUNK));
  }
  file.push(null);
  const response = await sent;
  return response.data as unknown as Received;
}

describe('putFileObject', () => {
  test('delivers every byte when chunks arrive in a burst before the stream ends', async () => {
    const data = randomBytes(10 * CHUNK);
    const received = await sendInBursts(data, CHUNK);
    expect(received.bytes).toBe(data.length);
    expect(received.sha256).toBe(sha256(data));
  });

  test('round-trips a 12.7 MB incompressible scan byte for byte', async () => {
    const data = randomBytes(12_700_000);
    const received = await sendInBursts(data, 4 * CHUNK);
    expect(received.bytes).toBe(data.length);
    expect(received.sha256).toBe(sha256(data));
  });

  test('keeps draining the file stream when the file server rejects the upload', async () => {
    const file = Readable.from((function* () {
      for (let i = 0; i < 64; i++) yield Buffer.alloc(CHUNK, i);
    })());
    const ended = new Promise<void>(resolve => file.once('end', resolve));
    const sent = putFileObject({
      url: `${baseUrl}/reject`,
      file,
      headers: { 'Content-Type': 'application/pdf' },
      maxSize: MAX_SIZE,
      signal: new AbortController().signal,
    });
    await expect(sent).rejects.toThrow();
    file.resume();
    await ended;
  });
});
