// Banco local vazio por padrão. Dados entram apenas por cadastro ou importação explícita.
const STORAGE_PREFIX = 'curtoprazo_local_db_';
const CLOUD_STORAGE_PREFIX = 'curtoprazo_cloud_db_';
const LOCAL_MODE_KEY = 'curtoprazo_use_local_db';
const LOCAL_VIEWS_KEY = 'curtoprazo_views_local';
const CLOUD_VIEWS_KEY = 'curtoprazo_views_cloud';
export const MAX_LOCAL_BACKUP_BYTES = 25 * 1024 * 1024;
type DocumentData = Record<string, unknown> | unknown[] | null;
export type LocalBackup = {
  format: 'curtoprazo-local-backup'; version: 1; exportedAt: string;
  documents: Record<string, DocumentData>; storage: Record<string, string>;
};
const inMemoryCache = new Map<string, DocumentData>();
const listeners = new Map<string, Set<(snapshot: any) => void>>();
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeKey = (key: string) => typeof key === 'string' && key.length > 0 && key.length <= 1500
  && !['__proto__', 'prototype', 'constructor'].includes(key) && !key.includes('/') && !key.includes('\\')
  && ![...key].some(char => char.charCodeAt(0) < 32);
const snapshot = (data: DocumentData) => ({ exists: () => data !== null, data: () => data === null ? {} : JSON.parse(JSON.stringify(data)) });
const isViewKey = (key: string) => key.startsWith('curtoprazo_') && !key.startsWith(STORAGE_PREFIX) && !key.startsWith(CLOUD_STORAGE_PREFIX) && ![LOCAL_MODE_KEY, LOCAL_VIEWS_KEY, CLOUD_VIEWS_KEY].includes(key);
const documentKey = (id: string) => (isLocalDbMode() ? STORAGE_PREFIX : CLOUD_STORAGE_PREFIX) + id;

function activeViews(): Record<string, string> {
  const views = Object.create(null);
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (isViewKey(key)) views[key] = localStorage.getItem(key)!;
  }
  return views;
}
function storedViews(key: string): Record<string, string> {
  const raw = localStorage.getItem(key);
  const views = raw === null ? {} : JSON.parse(raw);
  if (!isObject(views) || Object.entries(views).some(([k, v]) => !isViewKey(k) || typeof v !== 'string')) throw new Error('As configurações do banco local estão inválidas.');
  return views;
}
function persistTogether(entries: [string, string | null][]) {
  const previous = new Map(entries.map(([key]) => [key, localStorage.getItem(key)]));
  const written: string[] = [];
  try {
    for (const [key, value] of entries) {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
      written.push(key);
    }
  } catch {
    for (const key of written.reverse()) {
      const value = previous.get(key);
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value!);
    }
    throw new Error('Não foi possível gravar os dados. Verifique o espaço disponível no navegador; os dados anteriores foram mantidos.');
  }
}

export function isLocalDbMode(): boolean {
  try { return localStorage.getItem(LOCAL_MODE_KEY) !== 'false'; }
  catch { return true; }
}
export function setLocalDbMode(enabled: boolean): void {
  if (enabled === isLocalDbMode()) return;
  const current = activeViews();
  const next = storedViews(enabled ? LOCAL_VIEWS_KEY : CLOUD_VIEWS_KEY);
  persistTogether([
    [enabled ? CLOUD_VIEWS_KEY : LOCAL_VIEWS_KEY, JSON.stringify(current)],
    ...[...new Set([...Object.keys(current), ...Object.keys(next)])].map(key => [key, next[key] ?? null] as [string, string | null]),
    [LOCAL_MODE_KEY, String(enabled)]
  ]);
}
export function getLocalDocData(docId: string): any {
  const key = documentKey(docId);
  if (inMemoryCache.has(key)) return inMemoryCache.get(key);
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const data = JSON.parse(raw);
      inMemoryCache.set(key, data);
      return data;
    }
  } catch (error) { console.warn('Erro ao ler documento local:', docId, error); }
  return null;
}
export function setLocalDocData(docId: string, data: any): void {
  const key = documentKey(docId);
  localStorage.setItem(key, JSON.stringify(data));
  inMemoryCache.set(key, data);
  listeners.get(key)?.forEach(callback => {
    try { callback(snapshot(data)); } catch (error) { console.error('Erro no observador local:', error); }
  });
}
export function subscribeLocalDoc(docId: string, callback: (value: any) => void): () => void {
  const key = documentKey(docId);
  const set = listeners.get(key) || new Set();
  set.add(callback); listeners.set(key, set);
  const timer = setTimeout(() => { if (set.has(callback)) callback(snapshot(getLocalDocData(docId))); }, 0);
  return () => { clearTimeout(timer); set.delete(callback); };
}

export function exportAllLocalData(): string {
  const documents: Record<string, DocumentData> = Object.create(null);
  const storage = isLocalDbMode() ? activeViews() : storedViews(LOCAL_VIEWS_KEY);
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    const raw = localStorage.getItem(key)!;
    if (key.startsWith(STORAGE_PREFIX)) documents[key.slice(STORAGE_PREFIX.length)] = JSON.parse(raw);
  }
  const backup: LocalBackup = { format: 'curtoprazo-local-backup', version: 1, exportedAt: new Date().toISOString(), documents, storage };
  return JSON.stringify(backup, null, 2);
}

export function parseLocalBackup(content: string): LocalBackup {
  if (new TextEncoder().encode(content).length > MAX_LOCAL_BACKUP_BYTES) throw new Error('A cópia excede o limite de 25 MB.');
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { throw new Error('Arquivo inválido. Selecione uma cópia de segurança JSON do aplicativo.'); }
  if (!isObject(parsed)) throw new Error('A cópia precisa conter um objeto com os documentos do banco.');
  const modern = parsed.format !== undefined;
  if (modern && (parsed.format !== 'curtoprazo-local-backup' || parsed.version !== 1)) throw new Error('Formato ou versão de cópia não suportado.');
  const documents = modern ? parsed.documents : parsed;
  const storage = modern ? parsed.storage : {};
  if (!isObject(documents) || !isObject(storage)) throw new Error('A cópia não contém documentos e configurações válidos.');
  for (const [key, value] of Object.entries(documents)) {
    if (!safeKey(key) || (value !== null && !isObject(value) && !Array.isArray(value))) throw new Error(`Documento inválido na cópia: ${key}.`);
  }
  for (const [key, value] of Object.entries(storage)) {
    if (!isViewKey(key) || typeof value !== 'string') throw new Error(`Configuração inválida na cópia: ${key}.`);
  }
  const metadata = documents.all_projects_metadata;
  if (metadata !== undefined && metadata !== null && (!Array.isArray(metadata.list) || metadata.list.some(p => !isObject(p) || !safeKey(p.id || '') || typeof p.name !== 'string'))) {
    throw new Error('A lista de obras da cópia é inválida.');
  }
  if (metadata?.list && new Set(metadata.list.map(p => p.id)).size !== metadata.list.length) throw new Error('A cópia contém identificadores de obras repetidos.');
  return { format: 'curtoprazo-local-backup', version: 1, exportedAt: modern ? String(parsed.exportedAt || '') : '', documents, storage };
}

export function importLocalBackup(backup: LocalBackup): void {
  const valid = parseLocalBackup(JSON.stringify(backup));
  const viewEntries: [string, string][] = isLocalDbMode() ? Object.entries(valid.storage)
    : [[LOCAL_VIEWS_KEY, JSON.stringify({ ...storedViews(LOCAL_VIEWS_KEY), ...valid.storage })]];
  const entries: [string, string][] = [
    ...Object.entries(valid.documents).map(([id, data]) => [STORAGE_PREFIX + id, JSON.stringify(data)] as [string, string]),
    ...viewEntries
  ];
  persistTogether(entries);
  for (const [id, data] of Object.entries(valid.documents)) inMemoryCache.set(STORAGE_PREFIX + id, data);
  for (const [id, data] of Object.entries(valid.documents)) listeners.get(STORAGE_PREFIX + id)?.forEach(callback => {
    try { callback(snapshot(data)); } catch (error) { console.error('Erro no observador local:', error); }
  });
}
