import { useRef, useState } from 'react';
import { getAuth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

type Fields = Record<string, unknown>;
type BackupDocument = { id: string; fields: Fields };

const collectionPath = (appId: string) => `artifacts/${appId}/public/data/project_measurements`;
const validSegment = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('/') &&
  value !== '.' && value !== '..' && !/^__.*__$/.test(value);
const isRecord = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseBackup(text: string): BackupDocument[] {
  const backup = JSON.parse(text);
  if (backup?.format !== 'curtoprazo-firestore-v1' || !Array.isArray(backup.documents)) {
    throw new Error('Selecione um arquivo exportado pelo curtoprazo.');
  }
  const ids = new Set<string>();
  for (const entry of backup.documents) {
    if (!validSegment(entry?.id) || !isRecord(entry.fields) || ids.has(entry.id)) {
      throw new Error('O arquivo contém documentos inválidos ou repetidos.');
    }
    ids.add(entry.id);
  }
  return backup.documents;
}

// REST preserves Firestore types and supports conditional writes without a server.
async function backupConnection(db: Firestore, appId: string) {
  const projectId = db.app.options.projectId;
  const user = getAuth(db.app).currentUser;
  if (!projectId || !user || !validSegment(appId)) {
    throw new Error('Conecte-se ao Firebase antes de continuar.');
  }
  const token = await user.getIdToken();
  const root = `projects/${projectId}/databases/(default)/documents`;
  const url = `https://firestore.googleapis.com/v1/${root}`;
  const path = collectionPath(appId);

  async function request(endpoint: string, body?: string) {
    const response = await fetch(`${url}${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (response.status === 403) throw new Error('As regras do Firebase não permitem esta operação nesta sessão.');
    if (response.status === 429) throw new Error('A cota do Firestore foi atingida. Tente novamente após a renovação da cota.');
    if (response.status === 409) throw new Error('Um documento mudou durante a importação. Confira o destino e tente novamente.');
    if (!response.ok) throw new Error(`O Firestore recusou a operação (HTTP ${response.status}).`);
    return response.json();
  }

  return {
    projectId,
    async list(): Promise<BackupDocument[]> {
      const documents: BackupDocument[] = [];
      let pageToken = '';
      do {
        const query = new URLSearchParams({ pageSize: '200' });
        if (pageToken) query.set('pageToken', pageToken);
        const page = await request(`/${path.split('/').map(encodeURIComponent).join('/')}?${query}`);
        for (const entry of page.documents ?? []) {
          documents.push({ id: entry.name.slice(entry.name.lastIndexOf('/') + 1), fields: entry.fields ?? {} });
        }
        pageToken = page.nextPageToken ?? '';
      } while (pageToken);
      return documents;
    },
    async create(documents: BackupDocument[]) {
      const writes = documents.map(({ id, fields }) => ({
        update: { name: `${root}/${path}/${id}`, fields },
        currentDocument: { exists: false },
      }));
      await request(':commit', JSON.stringify({ writes }));
    },
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

export default function FirestoreBackup({ db, appId }: { db: Firestore | null; appId: string }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function perform(action: (connection: Awaited<ReturnType<typeof backupConnection>>) => Promise<void>) {
    if (!db || running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('Conectando ao Firestore…');
    try {
      await action(await backupConnection(db, appId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível concluir a operação.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function exportData() {
    void perform(async connection => {
      setMessage('Lendo documentos…');
      const documents = await connection.list();
      if (!documents.length) {
        setMessage('Nenhum documento encontrado para exportar.');
        return;
      }
      const payload = { format: 'curtoprazo-firestore-v1', sourceProject: connection.projectId, documents };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
      const download = document.createElement('a');
      download.href = url;
      download.download = `curtoprazo-${connection.projectId}-${new Date().toISOString().slice(0, 10)}.json`;
      download.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`Exportação concluída. ${documents.length.toLocaleString('pt-BR')} documentos no arquivo.`);
    });
  }

  function importData(file: File) {
    void perform(async connection => {
      const documents = parseBackup(await file.text());
      if (!documents.length) {
        setMessage('O arquivo não contém documentos.');
        return;
      }
      setMessage('Verificando documentos no destino…');
      const existing = new Map((await connection.list()).map(entry => [entry.id, entry.fields]));
      const pending = documents.filter(entry => {
        const previous = existing.get(entry.id);
        if (!previous) return true;
        if (canonicalJson(previous) !== canonicalJson(entry.fields)) {
          throw new Error(`O documento “${entry.id}” já existe com dados diferentes. Use um destino vazio.`);
        }
        return false;
      });
      if (!pending.length) {
        setMessage('Todos os documentos do arquivo já existem no destino.');
        return;
      }
      if (!window.confirm(`Importar ${pending.length.toLocaleString('pt-BR')} documentos para o Firebase “${connection.projectId}” (app “${appId}”)?`)) {
        setMessage('Importação cancelada.');
        return;
      }
      let created = 0;
      try {
        // A Firestore document is at most 1 MiB. Small batches also limit request size.
        const encoder = new TextEncoder();
        let batch: BackupDocument[] = [];
        let bytes = 0;
        async function flush() {
          if (!batch.length) return;
          await connection.create(batch);
          created += batch.length;
          setMessage(`Importando… ${created} de ${pending.length} documentos.`);
          batch = [];
          bytes = 0;
        }
        for (const entry of pending) {
          const size = encoder.encode(JSON.stringify(entry)).length + 1024;
          if (batch.length === 100 || bytes + size > 8 * 1024 * 1024) await flush();
          batch.push(entry);
          bytes += size;
        }
        await flush();
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Falha de conexão.';
        throw new Error(`Importação interrompida após ${created} gravações confirmadas. ${detail} Você pode selecionar o mesmo arquivo para continuar.`, { cause: error });
      }
      setMessage(`Importação concluída. ${created.toLocaleString('pt-BR')} documentos gravados.`);
    });
  }

  const buttonClass = 'rounded-xl border border-slate-600 px-3 py-2 text-xs font-bold text-slate-100 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-50';
  return (
    <section className="space-y-3 border-t border-slate-800 pt-4">
      <h4 className="text-sm font-bold text-white">Cópia dos dados do app</h4>
      <p className="text-xs text-slate-300">
        Baixe um arquivo JSON neste ambiente. Para restaurar a cópia, abra o app conectado ao Firebase de destino.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!db || busy} onClick={exportData}>Exportar dados</button>
        <button type="button" className={buttonClass} disabled={!db || busy} onClick={() => fileInput.current?.click()}>Importar dados</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) importData(file);
        }} />
      </div>
      <p role="status" className="text-xs text-slate-300">{message}</p>
    </section>
  );
}
