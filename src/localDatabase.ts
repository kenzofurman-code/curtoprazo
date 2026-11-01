// Banco de Dados Local (Modo Isolado / Offline)
// Permite trabalhar com 100% de segurança sem risco de alterar ou corromper o Firestore em nuvem

import initialAccessControl from '../local_db/documents/access_control.json';
import initialProjectsMetadata from '../local_db/documents/all_projects_metadata.json';
import initialProjetoPrincipal from '../local_db/documents/projeto_principal.json';
import initialProjetoPrincipalCrono from '../local_db/documents/projeto_principal_crono.json';
import initialProjetoPrincipalFloors from '../local_db/documents/projeto_principal_floors.json';
import initialProjetoPrincipalPlanning from '../local_db/documents/projeto_principal_planning.json';
import initialProjetoPrincipalBudget from '../local_db/documents/curtoprazo_budget_projeto_principal.json';

const INITIAL_SNAPSHOTS: Record<string, any> = {
  access_control: initialAccessControl,
  all_projects_metadata: initialProjectsMetadata,
  projeto_principal: initialProjetoPrincipal,
  projeto_principal_crono: initialProjetoPrincipalCrono,
  projeto_principal_floors: initialProjetoPrincipalFloors,
  projeto_principal_planning: initialProjetoPrincipalPlanning,
  curtoprazo_budget_projeto_principal: initialProjetoPrincipalBudget,
};

const STORAGE_PREFIX = 'curtoprazo_local_db_';
const LOCAL_MODE_KEY = 'curtoprazo_use_local_db';

// Por padrão ativado (true) para proteger a nuvem
export function isLocalDbMode(): boolean {
  try {
    const val = localStorage.getItem(LOCAL_MODE_KEY);
    if (val === null) return true; // Default ativo
    return val === 'true';
  } catch {
    return true;
  }
}

export function setLocalDbMode(enabled: boolean): void {
  try {
    localStorage.setItem(LOCAL_MODE_KEY, String(enabled));
  } catch (e) {
    console.error('Erro ao alternar modo do banco de dados:', e);
  }
}

// Memória cache local para garantir desempenho instantâneo O(1)
const inMemoryCache = new Map<string, any>();
const listeners = new Map<string, Set<(snap: { exists: () => boolean; data: () => any }) => void>>();

export function getLocalDocData(docId: string): any {
  if (inMemoryCache.has(docId)) {
    return inMemoryCache.get(docId);
  }

  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + docId);
    if (raw) {
      const parsed = JSON.parse(raw);
      inMemoryCache.set(docId, parsed);
      return parsed;
    }
  } catch (e) {
    console.warn('Erro ao ler do localStorage para ' + docId, e);
  }

  // Fallback para o snapshot inicial baixado do Firestore
  if (INITIAL_SNAPSHOTS[docId]) {
    const snap = INITIAL_SNAPSHOTS[docId];
    inMemoryCache.set(docId, snap);
    return snap;
  }

  return null;
}

export function setLocalDocData(docId: string, data: any): void {
  inMemoryCache.set(docId, data);
  try {
    localStorage.setItem(STORAGE_PREFIX + docId, JSON.stringify(data));
  } catch (e) {
    console.warn('LocalStorage cheio ou indisponível; mantendo dados em memória para ' + docId, e);
  }

  // Notifica todos os observadores locais (equivalente a onSnapshot)
  const docListeners = listeners.get(docId);
  if (docListeners) {
    const snap = {
      exists: () => data !== null && data !== undefined,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : {}),
    };
    docListeners.forEach((cb) => {
      try {
        cb(snap);
      } catch (err) {
        console.error('Erro no listener local para ' + docId, err);
      }
    });
  }
}

export function subscribeLocalDoc(
  docId: string,
  callback: (snap: { exists: () => boolean; data: () => any }) => void
): () => void {
  let set = listeners.get(docId);
  if (!set) {
    set = new Set();
    listeners.set(docId, set);
  }
  set.add(callback);

  // Emite o valor atual de imediato
  const current = getLocalDocData(docId);
  setTimeout(() => {
    callback({
      exists: () => current !== null && current !== undefined,
      data: () => (current ? JSON.parse(JSON.stringify(current)) : {}),
    });
  }, 0);

  return () => {
    set?.delete(callback);
  };
}

export function exportAllLocalData(): string {
  const exportPayload: Record<string, any> = {};
  // Snapshots conhecidos
  Object.keys(INITIAL_SNAPSHOTS).forEach((k) => {
    exportPayload[k] = getLocalDocData(k);
  });
  // Cache em memória
  inMemoryCache.forEach((val, k) => {
    exportPayload[k] = val;
  });
  // Chaves dinâmicas do localStorage
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) {
        const docId = key.slice(STORAGE_PREFIX.length);
        if (!exportPayload[docId]) {
          exportPayload[docId] = getLocalDocData(docId);
        }
      }
    }
  } catch (err) {
    console.warn('Erro ao ler chaves do localStorage para exportação:', err);
  }
  return JSON.stringify(exportPayload, null, 2);
}

export function resetLocalDataToFirestoreSnapshot(): void {
  inMemoryCache.clear();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) {
      localStorage.removeItem(key);
    }
  }
  // Re-emite snapshots para todos os listeners ativos
  listeners.forEach((set, docId) => {
    const data = INITIAL_SNAPSHOTS[docId] || null;
    const snap = {
      exists: () => data !== null,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : {}),
    };
    set.forEach((cb) => cb(snap));
  });
}
