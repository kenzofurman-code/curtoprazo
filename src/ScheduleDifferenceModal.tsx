import { useEffect, useRef, useState } from 'react';
import { loadScheduleVersions } from './scheduleVersions';
import type { ScheduleVersion } from './scheduleVersions';
import { getLatestImportedVersion } from './scheduleDifferences';

interface Props {
  projectId: string;
  weekId: string;
  onClose: () => void;
  onConfirm: (previous: ScheduleVersion, latest: ScheduleVersion) => Promise<void>;
}

export default function ScheduleDifferenceModal({ projectId, weekId, onClose, onConfirm }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<ScheduleVersion[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const latest = getLatestImportedVersion(versions);
  const choices = versions.filter(version => version.id !== latest?.id);
  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    loadScheduleVersions(projectId).then(value => {
      if (cancelled) return;
      const target = getLatestImportedVersion(value);
      const candidates = value.filter(v => v.id !== target?.id);
      setVersions(value);
      setSelectedId((getLatestImportedVersion(candidates) || candidates[0])?.id || '');
    }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Não foi possível carregar as versões. Feche e tente novamente.'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [projectId]);
  const confirm = async () => {
    if (busy || !latest || !selectedId) return;
    setBusy(true); setError('');
    try {
      // Refresh before applying: a deleted version or a newer import must not be used silently.
      const current = await loadScheduleVersions(projectId);
      const target = getLatestImportedVersion(current);
      const previous = current.find(v => v.id === selectedId);
      if (!previous || target?.id !== latest.id) throw new Error('As versões mudaram. Feche esta janela e abra novamente para atualizar a seleção.');
      await onConfirm(previous, target);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível gerar as diferenças. Tente novamente.');
    } finally { setBusy(false); }
  };
  return <dialog ref={dialog} aria-labelledby="schedule-difference-title" aria-describedby="schedule-difference-description"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-md max-h-[90dvh] overflow-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/60">
    <div className="mb-4 flex items-start justify-between gap-4">
      <h2 id="schedule-difference-title" className="text-lg font-bold">Gerar por diferença</h2>
      <button type="button" aria-label="Fechar" disabled={busy} onClick={onClose}
        className="rounded px-2 text-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:opacity-50">×</button>
    </div>
    <p id="schedule-difference-description" className="mb-4 text-sm text-slate-600">
      Compare com o último cronograma importado{latest ? <>: <strong className="text-slate-900">{latest.name}</strong>.</> : '.'}
      {' '}Os avanços serão lançados na semana de {weekId.split('-').reverse().join('/')}.
    </p>
    {busy && <p role="status" className="mb-3 text-sm text-slate-600">Carregando ou salvando dados…</p>}
    {!busy && !latest && <p className="mb-3 text-sm text-slate-600">Importe um cronograma para usar esta comparação.</p>}
    {!busy && latest && !choices.length && <p className="mb-3 text-sm text-slate-600">Você precisa de outra versão salva para comparar com a última importação.</p>}
    <label htmlFor="schedule-difference-reference" className="mb-2 block text-sm font-semibold">Cronograma de referência</label>
    <select id="schedule-difference-reference" value={selectedId} disabled={busy || !latest || !choices.length}
      onChange={event => setSelectedId(event.target.value)}
      className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:bg-slate-100">
      {!choices.length && <option value="">Nenhuma versão disponível</option>}
      {choices.map(version => <option key={version.id} value={version.id}>{version.name} — {new Date(version.createdAt).toLocaleString('pt-BR')}</option>)}
    </select>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="mt-6 flex justify-end">
      <button type="button" onClick={() => { void confirm(); }} disabled={busy || !latest || !selectedId}
        className="rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">OK</button>
    </div>
  </dialog>;
}
