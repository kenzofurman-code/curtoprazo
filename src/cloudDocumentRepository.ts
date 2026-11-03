import { MAX_SAVE_BYTES, preparePayload, resolvePayload } from './chunkedPayload';
export type CloudTransaction = { get: (id: string) => Promise<any>; set: (id: string, data: any) => void };
export type CloudDocumentAdapter = {
  read: (id: string) => Promise<any>;
  transact: <T>(operation: (transaction: CloudTransaction) => Promise<T>) => Promise<T>;
};
const ENCODING = 'gzip-json-v1';
async function encode(value: any, id: string) {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Dados inválidos para salvar no Firebase.');
  const compressed = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary = '';
  for (let i = 0; i < compressed.length; i += 32768) binary += String.fromCharCode(...compressed.subarray(i, i + 32768));
  const payload = btoa(binary);
  if (payload.length > MAX_SAVE_BYTES) throw new Error('O conjunto de dados excede o tamanho seguro de gravação no Firebase. Nenhum dado foi substituído.');
  const prepared = await preparePayload(payload, id);
  return { document: { encoding: ENCODING, payload: prepared.value, updatedAt: new Date().toISOString() }, chunks: prepared.chunks };
}
async function decode(record: any, get: (id: string) => Promise<any>) {
  if (!record || record.encoding !== ENCODING) return record ?? null;
  const encoded = await resolvePayload(record.payload, async id => (await get(id))?.payload);
  if (typeof encoded !== 'string') throw new Error('Dados do Firebase incompletos. Recarregue a página antes de editar.');
  const compressed = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
  return JSON.parse(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
}
export function createCloudDocumentRepository(adapter: CloudDocumentAdapter) {
  return {
    read: async (id: string) => decode(await adapter.read(id), adapter.read),
    mutate: async <T,>(id: string, update: (previous: any) => T): Promise<T> => adapter.transact(async transaction => {
      const previous = await decode(await transaction.get(id), transaction.get);
      const next = update(previous);
      const prepared = await encode(next, id);
      // Every read completes before any write. One transaction publishes the manifest and all parts.
      for (const chunk of prepared.chunks) transaction.set(chunk.id, { payload: chunk.payload });
      transaction.set(id, prepared.document);
      return next;
    })
  };
}
