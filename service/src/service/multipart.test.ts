import { describe, expect, test } from 'bun:test';
import { Readable } from 'stream';
import { createUploadParser } from './multipart';

const BOUNDARY = 'synapse-test-boundary';

/** Parses one multipart file part whose filename is sent as raw UTF-8, as form-data does. */
function parseFilename(filename: string): Promise<string> {
  const body = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="`),
    Buffer.from(filename, 'utf8'),
    Buffer.from(`"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n--${BOUNDARY}--\r\n`),
  ]);
  const parser = createUploadParser({ 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, 1024);
  return new Promise((resolve, reject) => {
    parser.on('file', (_field, file, info) => {
      file.resume();
      resolve(info.filename);
    });
    parser.on('error', reject);
    Readable.from([body]).pipe(parser);
  });
}

describe('createUploadParser', () => {
  test('decodes a long Bangla filename as UTF-8 within the 255-byte limit', async () => {
    const name = 'প্রধানমন্ত্রী_স্বর্ণপদক_২০১৯__২০২০_ও_২০২১_প্রদানসংক্রান্ত_জরুরি_বিজ্ঞপ্তি.pdf';
    const parsed = await parseFilename(name);
    expect(parsed).toBe(name);
    expect(Buffer.byteLength(parsed)).toBeLessThanOrEqual(255);
  });

  test('keeps subdirectory components in skill file paths', async () => {
    expect(await parseFilename('skills/pdf-to-docx/scripts/convert.py')).toBe('skills/pdf-to-docx/scripts/convert.py');
  });
});
