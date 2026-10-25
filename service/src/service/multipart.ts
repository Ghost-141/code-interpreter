import busboy from 'busboy';
import type { IncomingHttpHeaders } from 'http';

/**
 * Busboy parser for session uploads.
 *
 * `defParamCharset: 'utf8'`: busboy decodes a plain `filename="…"` as latin1
 * by default, so a Bangla name arrived as mojibake at twice its byte length
 * and long ones overran the 255-byte filename limit (ENAMETOOLONG) in the
 * runner. `preservePath` keeps subdirectory components in the filename
 * (e.g. `pptx/editing.md`); the busboy 1.x default strips to basename, which
 * collapses skill-file paths and makes them look missing.
 */
export function createUploadParser(headers: IncomingHttpHeaders, fileSize: number): busboy.Busboy {
  return busboy({
    headers,
    limits: { fileSize },
    preservePath: true,
    defParamCharset: 'utf8',
  });
}
