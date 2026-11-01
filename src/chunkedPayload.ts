// Compressed payloads contain ASCII only. Leave room for Firestore document metadata.
export const PAYLOAD_CHUNK_BYTES = 700_000;
export const MAX_SAVE_BYTES = 8_000_000;

type ChunkedPayload = { format: 'chunks-v1'; ids: string[]; length: number };

export async function preparePayload(payload: string, documentId: string): Promise<{
  value: string | ChunkedPayload;
  chunks: { id: string; payload: string }[];
}> {
  if (!/^[\x00-\x7f]*$/.test(payload)) throw new Error('Payload deve estar comprimido em ASCII.');
  if (payload.length <= PAYLOAD_CHUNK_BYTES) return { value: payload, chunks: [] };

  const chunks: { id: string; payload: string }[] = [];
  for (let offset = 0; offset < payload.length; offset += PAYLOAD_CHUNK_BYTES) {
    const part = payload.slice(offset, offset + PAYLOAD_CHUNK_BYTES);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(part));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    // Immutable, content-addressed parts allow readers to finish an older snapshot safely.
    // Unchanged parts reuse the same documents on subsequent saves.
    chunks.push({ id: `${documentId}_part_${hash}`, payload: part });
  }
  const value: ChunkedPayload = { format: 'chunks-v1', ids: chunks.map(chunk => chunk.id), length: payload.length };
  return { value, chunks };
}

export async function resolvePayload(value: unknown, readPart: (id: string) => Promise<unknown>): Promise<any> {
  if (!value || typeof value !== 'object' || !('format' in value)) return value;
  const manifest = value as ChunkedPayload;
  if (manifest.format !== 'chunks-v1' || !Array.isArray(manifest.ids) || !manifest.ids.length ||
      !Number.isSafeInteger(manifest.length) || manifest.length <= 0 || manifest.length > MAX_SAVE_BYTES ||
      manifest.ids.length !== Math.ceil(manifest.length / PAYLOAD_CHUNK_BYTES) ||
      manifest.ids.some(id => typeof id !== 'string' || !/^[^/]+_part_[a-f0-9]{64}$/.test(id))) {
    throw new Error('Manifesto de dados inválido.');
  }
  const parts = await Promise.all(manifest.ids.map(async (id, index) => {
    const part = await readPart(id);
    const expectedLength = Math.min(PAYLOAD_CHUNK_BYTES, manifest.length - index * PAYLOAD_CHUNK_BYTES);
    if (typeof part !== 'string' || part.length !== expectedLength) {
      throw new Error('Parte dos dados ausente ou incompleta.');
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(part));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!id.endsWith(`_part_${hash}`)) throw new Error('Parte dos dados corrompida.');
    return part;
  }));
  return parts.join('');
}
