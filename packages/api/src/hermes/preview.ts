import { extname, basename } from 'node:path';
import type { HermesPreview } from 'librechat-data-provider';
import { classifyCodeArtifact } from '../files/code/classify';
import { extractCodeArtifactText, hasOfficeHtmlPath } from '../files/code/extract';

/** Bound the stream itself: Content-Length is neither required nor trusted. */
export async function previewHermesFile(
  response: Response,
  path: string,
  limit: number,
): Promise<HermesPreview> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > limit) {
      throw new Error('preview_too_large');
    }
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > limit) {
          throw new Error('preview_too_large');
        }
        chunks.push(value);
      }
    }
  } finally {
    await reader?.cancel();
    reader?.releaseLock();
  }
  const buffer = Buffer.concat(chunks);
  const ext = extname(path).toLowerCase().slice(1);
  const media: Record<string, [HermesPreview['kind'], string]> = {
    png: ['image', 'image/png'],
    jpg: ['image', 'image/jpeg'],
    jpeg: ['image', 'image/jpeg'],
    webp: ['image', 'image/webp'],
    gif: ['image', 'image/gif'],
    avif: ['image', 'image/avif'],
    pdf: ['pdf', 'application/pdf'],
    mp3: ['audio', 'audio/mpeg'],
    wav: ['audio', 'audio/wav'],
    ogg: ['audio', 'audio/ogg'],
    m4a: ['audio', 'audio/mp4'],
    mp4: ['video', 'video/mp4'],
    webm: ['video', 'video/webm'],
  };
  if (media[ext]) {
    const [kind, mime] = media[ext];
    return { kind, mime, data: buffer.toString('base64') };
  }
  const name = basename(path);
  const mime = 'application/octet-stream';
  const category = classifyCodeArtifact(name, mime);
  const text = await extractCodeArtifactText(buffer, name, mime, category);
  return text == null
    ? { kind: 'unsupported', mime }
    : { kind: hasOfficeHtmlPath(name, mime) ? 'html' : 'text', mime: 'text/plain', text };
}
