import { useRef, useState } from 'react';
import { exportAllLocalData, importLocalBackup, isLocalDbMode, MAX_LOCAL_BACKUP_BYTES, parseLocalBackup, setLocalDbMode } from './localDatabase';
import type { LocalBackup } from './localDatabase';

type Props = { cloudAvailable: boolean; onReload?: () => void };
export default function LocalDatabaseSettings({ cloudAvailable, onReload = () => window.location.reload() }: Props) {
  const localMode = isLocalDbMode();
  const input = useRef<HTMLInputElement>(null);
  const [backup, setBackup] = useState<LocalBackup | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const metadata = backup?.documents.all_projects_metadata;
  const projects = (metadata && !Array.isArray(metadata) ? metadata.list || [] : []) as { id: string; name: string }[];
  const count = backup ? Object.keys(backup.documents).length + Object.keys(backup.storage).length : 0;
  const activate = (local: boolean) => {
    setLocalDbMode(local);
    localStorage.removeItem('selected_project_id');
    onReload();
  };
  const download = () => {
    setError('');
    try {
      const url = URL.createObjectURL(new Blob([exportAllLocalData()], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `backup_local_curtoprazo_${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click(); URL.revokeObjectURL(url);
    } catch { setError('Não foi possível gerar a cópia. Verifique o acesso aos dados locais do navegador.'); }
  };
  const loadFile = async (file?: File) => {
    setBackup(null); setError(''); setFileName(file?.name || '');
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > MAX_LOCAL_BACKUP_BYTES) throw new Error('A cópia excede o limite de 25 MB.');
      setBackup(parseLocalBackup(await file.text()));
    } catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível ler a cópia.'); }
    finally { setBusy(false); }
  };
  const confirmImport = () => {
    if (!backup || !count) return;
    setError(''); setBusy(true);
    try { importLocalBackup(backup); activate(true); }
    catch (err) { setError(err instanceof Error ? err.message : 'Não foi possível carregar a cópia.'); setBusy(false); }
  };
  const button = 'rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50';
  return <section className="space-y-5 rounded-2xl bg-white p-5 text-slate-900 sm:p-6" aria-label="Banco de dados e cópias de segurança">
    <div>
      <h3 className="text-base font-bold">Banco de dados e cópias de segurança</h3>
      <p className="mt-2 text-sm text-slate-600">Banco ativo: <strong className="text-slate-900">{localMode ? 'Local, neste navegador' : 'Firebase, na nuvem'}</strong>.</p>
      <p className="mt-1 max-w-prose text-sm text-slate-600">Cada banco mantém seus próprios dados. Um banco vazio permanece vazio até você cadastrar uma obra ou carregar dados. Trocar de banco não copia nem apaga informações.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={busy || localMode} className={button} onClick={() => { try { activate(true); } catch { setError('Não foi possível abrir o banco local.'); } }}>Usar banco local</button>
        <button disabled={busy || !localMode || !cloudAvailable} className={button} onClick={() => { try { activate(false); } catch { setError('Não foi possível abrir o Firebase.'); } }}>Usar Firebase</button>
      </div>
      {!cloudAvailable && <p className="mt-2 text-sm text-slate-600">Configure a conexão do Firebase para habilitar o banco na nuvem.</p>}
    </div>
    <div className="border-t border-slate-200 pt-5">
      <h4 className="text-sm font-bold">Cópia dos dados locais</h4>
      <p className="mt-2 max-w-prose text-sm text-slate-600">Use um backup JSON do aplicativo para carregar dados neste navegador. A importação grava somente no banco local.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={download}>Baixar cópia local</button>
        <input ref={input} type="file" accept=".json,application/json" aria-label="Selecionar cópia de segurança JSON" className="sr-only" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void loadFile(file); }} />
        <button className={button} disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Processando cópia…' : 'Carregar cópia dos dados'}</button>
      </div>
      {backup && <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <p className="break-all text-sm font-semibold">Revisar cópia: {fileName}</p>
        <p className="text-sm text-slate-700">{Object.keys(backup.documents).length} documentos, {Object.keys(backup.storage).length} configurações e {projects.length} {projects.length === 1 ? 'obra' : 'obras'} na lista.</p>
        {!!projects.length && <ul className="max-h-36 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-slate-700">{projects.map(project => <li key={project.id}>{project.name}</li>)}</ul>}
        <p className="max-w-prose text-sm text-slate-700">Documentos e configurações com a mesma identificação serão substituídos pelos da cópia. As demais informações locais serão mantidas. Após carregar, o aplicativo abrirá o banco local.</p>
        {!count && <p className="text-sm text-slate-600">Esta cópia está vazia. Nenhum dado será importado.</p>}
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || !count} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50" onClick={confirmImport}>Carregar e abrir banco local</button>
          <button disabled={busy} className={button} onClick={() => { setBackup(null); setError(''); }}>Cancelar</button>
        </div>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm font-medium text-red-800">{error}</p>}
    </div>
  </section>;
}
