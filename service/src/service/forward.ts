import axios from 'axios';
import type { Readable } from 'stream';
import type { AxiosResponse } from 'axios';
import type * as t from '../types';

export interface FileObjectPut {
  url: string;
  file: Readable;
  headers: Record<string, string>;
  maxSize: number;
  signal: AbortSignal;
}

interface RequestBody {
  body: ReadableStream<Uint8Array>;
  /** Stops feeding the body and lets the file stream drain to its end. */
  release: () => void;
}

/**
 * Adapts a busboy file stream to a web stream with backpressure.
 *
 * Releasing never destroys the source: busboy only finishes the form once
 * each file stream ends, so an abandoned body keeps draining instead.
 */
function toRequestBody(file: Readable): RequestBody {
  let open = true;
  const release = (): void => {
    open = false;
    file.resume();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      file.pause();
      file.on('data', (chunk: Buffer) => {
        if (!open) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) file.pause();
      });
      file.once('end', () => {
        if (!open) return;
        open = false;
        controller.close();
      });
      file.once('error', (err) => {
        if (!open) return;
        open = false;
        controller.error(err);
      });
    },
    pull() {
      file.resume();
    },
    cancel: release,
  });
  return { body, release };
}

/**
 * Streams an uploaded file to the file server.
 *
 * Sent through fetch rather than axios's default http adapter: Bun 1.3's
 * `node:http` ClientRequest drops every body chunk still queued when `end()`
 * arrives, so piped uploads were stored short while the PUT still succeeded.
 */
export function putFileObject({ url, file, headers, maxSize, signal }: FileObjectPut): Promise<AxiosResponse<t.UploadResult>> {
  const { body, release } = toRequestBody(file);
  return axios.put<t.UploadResult>(url, body, {
    adapter: 'fetch',
    headers,
    maxBodyLength: maxSize,
    maxContentLength: maxSize,
    signal,
  }).finally(release);
}
