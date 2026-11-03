import { isLocalDbMode } from './localDatabase';
const DATABASE = 'curtoprazo-schedule-history';
const STORE = 'documents';
export const LOCAL_VERSION_PREFIX = 'curtoprazo_local_db_curtoprazo_schedule_versions_';
const CLOUD_VERSION_PREFIX = 'curtoprazo_cloud_db_curtoprazo_schedule_versions_';
export const VERSION_HISTORY_EVENT = 'curtoprazo:versions-updated';
const notify = (key: string) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(VERSION_HISTORY_EVENT, { detail: { key } }));
};
let connection: Promise<IDBDatabase> | null = null;
export const versionStorageKey = (projectId: string) => (isLocalDbMode() ? LOCAL_VERSION_PREFIX : CLOUD_VERSION_PREFIX) + (projectId || 'projeto_principal');

function openHistory(): Promise<IDBDatabase> {
  if (connection) return connection;
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('O navegador não disponibilizou o armazenamento de versões. Habilite o armazenamento de dados deste site.')); return; }
    const request = indexedDB.open(DATABASE, 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(new Error('Não foi possível abrir o histórico de versões no navegador.'));
    request.onblocked = () => { failed = true; reject(new Error('Feche as outras abas deste aplicativo e tente abrir o histórico novamente.')); };
    request.onsuccess = () => {
      if (failed) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); connection = null; };
      resolve(request.result);
    };
  }).catch(error => { connection = null; throw error; });
  return connection;
}
const failure = () => new Error('Não foi possível salvar o histórico de versões. Verifique o espaço disponível e a permissão de armazenamento deste site. Os dados anteriores foram mantidos.');
function legacyVersions(key: string): any[] {
  const raw = localStorage.getItem(key);
  if (raw === null) return [];
  const value = JSON.parse(raw);
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('O histórico antigo de versões está inválido. Exporte uma cópia antes de continuar.');
  return value;
}

export async function readVersionList(key: string): Promise<any[]> {
  const db = await openHistory();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get(key);
    transaction.onabort = () => reject(failure());
    transaction.onerror = () => reject(failure());
    transaction.oncomplete = () => {
      try {
        const value = request.result;
        if (value !== undefined && !Array.isArray(value)) throw new Error('O histórico de versões está inválido. Faça uma cópia dos dados antes de continuar.');
        resolve(value === undefined ? legacyVersions(key) : value);
      } catch (error) { reject(error); }
    };
  });
}

// Read/modify/write is one IndexedDB transaction, including across tabs.
// Legacy localStorage data remains untouched for recovery/rollback.
export async function updateVersionList(key: string, update: (versions: any[]) => any[]): Promise<any[]> {
  const db = await openHistory();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const request = store.get(key);
    let result: any[];
    let error: unknown;
    request.onsuccess = () => {
      try {
        result = update(request.result === undefined ? legacyVersions(key) : request.result);
      } catch (err) { error = err; transaction.abort(); }
      if (error) return;
      try { store.put(result, key); } catch { transaction.abort(); }
    };
    transaction.onabort = () => reject(error || failure());
    transaction.onerror = () => reject(error || failure());
    transaction.oncomplete = () => { resolve(result); notify(key); };
  });
}

export async function listVersionDocuments(prefix = LOCAL_VERSION_PREFIX): Promise<Record<string, any[]>> {
  const db = await openHistory();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const result: Record<string, any[]> = Object.create(null);
    const cursor = transaction.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      if (String(item.key).startsWith(prefix)) result[String(item.key)] = item.value;
      item.continue();
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure());
    transaction.onerror = () => reject(failure());
  });
}

export async function replaceVersionDocuments(entries: Record<string, any[] | undefined>): Promise<void> {
  if (!Object.keys(entries).length) return;
  const db = await openHistory();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    transaction.oncomplete = () => { resolve(); Object.keys(entries).forEach(notify); };
    transaction.onabort = () => reject(failure());
    transaction.onerror = () => reject(failure());
    try {
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) store.delete(key); else store.put(value, key);
      }
    } catch { transaction.abort(); }
  });
}
