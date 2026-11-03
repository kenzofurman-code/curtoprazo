import { useEffect, useState } from 'react';
import { APP_MODULES, DEFAULT_MODULE_VISIBILITY } from './moduleVisibility';
import type { ModuleVisibility } from './moduleVisibility';
type Props = {
  visibility: ModuleVisibility; ready: boolean; error: string;
  onSave: (value: ModuleVisibility) => Promise<void>;
};
export default function ModuleVisibilitySettings({ visibility, ready, error, onSave }: Props) {
  const [draft, setDraft] = useState(visibility);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(visibility); }, [visibility, dirty]);
  const save = async () => {
    setSaving(true); setMessage(''); setSaveError('');
    try { await onSave(draft); setDirty(false); setMessage('Configuração salva para todos os usuários.'); }
    catch (err) { setSaveError(err instanceof Error ? err.message : 'Não foi possível salvar. Tente novamente.'); }
    finally { setSaving(false); }
  };
  return <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-4" aria-labelledby="visible-modules-title">
    <div>
      <h4 id="visible-modules-title" className="text-base font-bold text-white">Módulos visíveis para os usuários</h4>
      <p className="mt-2 text-sm leading-relaxed text-slate-300">Escolha quais módulos aparecem para os usuários em todas as obras. Administradores autenticados continuam vendo todos os módulos.</p>
    </div>
    <fieldset disabled={!ready || saving} className="grid gap-2 sm:grid-cols-2">
      <legend className="sr-only">Módulos liberados para usuários comuns</legend>
      {APP_MODULES.map(module => <label key={module.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-700 px-3 py-2.5 text-sm text-slate-100 focus-within:ring-2 focus-within:ring-indigo-400">
        <input type="checkbox" checked={draft[module.id]} className="h-4 w-4 accent-indigo-500" onChange={event => {
          setDraft(current => ({ ...current, [module.id]: event.target.checked })); setDirty(true); setMessage('');
        }} />{module.label}
      </label>)}
    </fieldset>
    {!ready && <p className="text-sm text-amber-200">{error || 'A configuração global precisa da conexão com o Firebase. Enquanto ela não estiver disponível, apenas Dashboard, Semanal e Configurações aparecem para os usuários.'}</p>}
    {ready && error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button disabled={!ready || saving || !dirty} onClick={save} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300">{saving ? 'Salvando…' : 'Salvar para todos'}</button>
      <button disabled={!ready || saving} onClick={() => { setDraft({ ...DEFAULT_MODULE_VISIBILITY }); setDirty(true); setMessage(''); }} className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:cursor-not-allowed disabled:opacity-50">Usar Dashboard, Semanal e Configurações</button>
    </div>
    {message && <p role="status" className="text-sm text-emerald-300">{message}</p>}
    {saveError && <p role="alert" className="text-sm text-red-300">{saveError}</p>}
  </section>;
}
