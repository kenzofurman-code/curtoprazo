import { useEffect, useRef, useState } from 'react';
import { loadScheduleVersions } from './scheduleVersions';
import { VERSION_HISTORY_EVENT, versionStorageKey } from './scheduleVersionStorage';
import type { ScheduleVersion, ScheduleVersionSnapshot } from './scheduleVersions';

export function useScheduleVersionHistory(projectId: string, snapshot?: ScheduleVersionSnapshot, updateKey = 0) {
  const [versions, setVersions] = useState<ScheduleVersion[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const snapshotRef = useRef(snapshot);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  const request = useRef({ projectId, active: true, pending: true });
  useEffect(() => {
    const current = { projectId, active: true, pending: true };
    request.current = current;
    const key = versionStorageKey(projectId);
    setBusy(true); setError(''); setVersions([]);
    loadScheduleVersions(projectId, snapshotRef.current).then(value => {
      if (current.active) setVersions(value);
    }).catch(err => {
      if (current.active) setError(err instanceof Error ? err.message : 'Não foi possível carregar o histórico de versões.');
    }).finally(() => {
      if (current.active) { current.pending = false; setBusy(false); }
    });
    const refresh = () => {
      loadScheduleVersions(projectId).then(value => { if (current.active) setVersions(value); })
        .catch(err => { if (current.active) setError(err instanceof Error ? err.message : 'Não foi possível atualizar o histórico.'); });
    };
    const onWrite = (event: Event) => { if ((event as CustomEvent).detail?.key === key) refresh(); };
    window.addEventListener(VERSION_HISTORY_EVENT, onWrite);
    window.addEventListener('focus', refresh);
    return () => {
      current.active = false;
      window.removeEventListener(VERSION_HISTORY_EVENT, onWrite);
      window.removeEventListener('focus', refresh);
    };
  }, [projectId, updateKey]);
  const run = async (operation: () => Promise<void>) => {
    const current = request.current;
    if (!current.active || current.pending || current.projectId !== projectId) return;
    current.pending = true; setBusy(true); setError('');
    try { await operation(); }
    catch (err) { if (current.active) setError(err instanceof Error ? err.message : 'Não foi possível salvar a versão.'); }
    finally { if (current.active) { current.pending = false; setBusy(false); } }
  };
  const updateVersions = (value: ScheduleVersion[]) => {
    if (request.current.active && request.current.projectId === projectId) setVersions(value);
  };
  return { versions, setVersions: updateVersions, busy, error, run };
}
