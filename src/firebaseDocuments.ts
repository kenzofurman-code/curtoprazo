import { doc, getDocFromServer, runTransaction } from 'firebase/firestore';
import { createCloudDocumentRepository } from './cloudDocumentRepository';
export const CLOUD_DOCUMENT_EVENT = 'curtoprazo:cloud-document';
export const CLOUD_STATUS_EVENT = 'curtoprazo:cloud-status';
const cache = new Map<string, any>();
const queues = new Map<string, Promise<any>>();
const failures = new Map<string, { value: any; message: string }>();
let repository: ReturnType<typeof createCloudDocumentRepository> | null = null;
let pending = 0;
let generation = 0;
const clone = (value: any) => value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
function event(name: string, detail: any) { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail })); }
function status() { event(CLOUD_STATUS_EVENT, { pending, error: [...failures.values()][0]?.message || '', retryable: [...failures.values()].some(failed => failed.value !== undefined) }); }
export function configureFirebaseDocuments(db: any, appId: string): void {
  generation++; cache.clear(); queues.clear(); failures.clear(); pending = 0;
  if (!db) { repository = null; return; }
  const reference = (id: string) => {
    if (!id || id.includes('/')) throw new Error('Identificação inválida para gravar no Firebase.');
    return doc(db, `artifacts/${appId}/public/data/project_measurements`, id);
  };
  repository = createCloudDocumentRepository({
    read: async id => { const result = await getDocFromServer(reference(id)); return result.exists() ? result.data() : null; },
    transact: operation => runTransaction(db, transaction => operation({
      get: async id => { const result = await transaction.get(reference(id)); return result.exists() ? result.data() : null; },
      set: (id, data) => { transaction.set(reference(id), data); }
    }))
  });
}
function connected() {
  if (!repository) throw new Error('A conexão com o Firebase ainda não está pronta. Nenhum dado foi salvo no navegador.');
  return repository;
}
export async function readFirebaseDocument(id: string): Promise<any> {
  const current = generation;
  const value = await connected().read(id);
  if (current === generation) cache.set(id, clone(value));
  return value;
}
export const getCachedFirebaseDocument = (id: string): any => clone(cache.get(id));
export async function mutateFirebaseDocument<T>(id: string, update: (previous: any) => T): Promise<T> {
  const backend = connected();
  const current = generation;
  pending++; status();
  try {
    const value = await backend.mutate(id, update);
    if (current === generation) {
      cache.set(id, clone(value)); failures.delete(id); event(CLOUD_DOCUMENT_EVENT, { key: id });
    }
    return value;
  } catch (err) {
    if (current === generation) failures.set(id, { value: undefined, message: err instanceof Error ? err.message : 'Não foi possível salvar no Firebase.' });
    throw err;
  } finally { if (current === generation) { pending--; status(); } }
}
export function saveFirebaseDocument(id: string, value: any): Promise<void> {
  const current = generation;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return Promise.reject(new Error('Dados inválidos para salvar no Firebase.'));
  const queued = queues.get(id) || Promise.resolve();
  const write = queued.catch(() => {}).then(async () => {
    if (current !== generation) throw new Error('A sessão do Firebase mudou. Recarregue os dados antes de salvar.');
    if (cache.has(id) && JSON.stringify(cache.get(id)) === serialized) {
      failures.delete(id); status(); return;
    }
    await mutateFirebaseDocument(id, () => JSON.parse(serialized));
  });
  queues.set(id, write);
  return write.catch(err => {
    if (current === generation) {
      failures.set(id, { value: JSON.parse(serialized), message: err instanceof Error ? err.message : 'Não foi possível salvar no Firebase.' });
      status();
    }
    throw err;
  });
}
export async function retryFirebaseWrites(): Promise<void> {
  for (const [id, failed] of [...failures]) if (failed.value !== undefined) await saveFirebaseDocument(id, failed.value);
}
// Only UI memory mirrors confirmed cloud data. This facade never uses browser storage.
export const cloudStorage = {
  getItem: (id: string): string | null => cache.has(id) && cache.get(id) !== null ? JSON.stringify(cache.get(id)) : null,
  setItem: (id: string, serialized: string): void => { void saveFirebaseDocument(id, JSON.parse(serialized)).catch(() => {}); },
  saveItem: (id: string, serialized: string): Promise<void> => saveFirebaseDocument(id, JSON.parse(serialized))
};
export async function primeProjectFirebaseDocuments(projectId: string): Promise<void> {
  const prefixes = ['budget', 'curvas_config', 'macroflow', 'lob_config', 'gantt_config'];
  await Promise.all(prefixes.map(prefix => readFirebaseDocument(`curtoprazo_${prefix}_${projectId}`)));
}
