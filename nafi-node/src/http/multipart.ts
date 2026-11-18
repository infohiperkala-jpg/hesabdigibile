import { UploadedFile } from './types.js';

/** Minimal, strict multipart/form-data parser (no external dependency). Returns text fields and uploaded files. */
export function parseMultipart(body: Buffer, contentType: string): { fields: URLSearchParams; files: UploadedFile[] } {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i); if (!m) throw new Error('bad multipart');
  const boundary = Buffer.from('--' + (m[1] ?? m[2]).trim()), fields = new URLSearchParams(), files: UploadedFile[] = [];
  let pos = body.indexOf(boundary); if (pos < 0) throw new Error('bad multipart');
  while (true) {
    pos += boundary.length; if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;   // closing boundary
    if (body[pos] === 0x0d) pos += 2;
    const headEnd = body.indexOf('\r\n\r\n', pos); if (headEnd < 0) break;
    const head = body.subarray(pos, headEnd).toString('utf8'), next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), headEnd + 4); if (next < 0) break;
    const data = body.subarray(headEnd + 4, next), name = head.match(/name="([^"]*)"/i)?.[1], fn = head.match(/filename="([^"]*)"/i)?.[1];
    if (name !== undefined) { if (fn !== undefined) { if (fn !== '' || data.length) files.push({ field: name, filename: fn, type: head.match(/content-type:\s*([^\r\n]+)/i)?.[1] ?? '', data: Buffer.from(data) }); } else fields.append(name, data.toString('utf8')); }
    pos = next + 2;
  }
  return { fields, files };
}
