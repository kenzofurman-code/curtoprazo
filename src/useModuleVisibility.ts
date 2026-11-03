import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { createModuleVisibilityStore, DEFAULT_MODULE_VISIBILITY } from './moduleVisibility';
import type { ModuleVisibility } from './moduleVisibility';

export function useModuleVisibility(db: any, appId: string) {
  const [visibility, setVisibility] = useState(DEFAULT_MODULE_VISIBILITY);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const store = useMemo(() => db ? createModuleVisibilityStore({
    watch: (path, receive, fail) => onSnapshot(doc(db, path), snapshot => receive(snapshot.exists() ? snapshot.data() : null), fail),
    write: (path, data, options) => setDoc(doc(db, path), data, options)
  }, appId) : null, [db, appId]);
  useEffect(() => {
    setReady(false); setError(''); setVisibility(DEFAULT_MODULE_VISIBILITY);
    if (!store) return;
    return store.subscribe(value => { setVisibility(value); setReady(true); setError(''); }, () => {
      setVisibility(DEFAULT_MODULE_VISIBILITY); setReady(false);
      setError('Não foi possível carregar a configuração global. Os módulos em desenvolvimento permanecem ocultos.');
    });
  }, [store]);
  const save = async (value: ModuleVisibility, isAdmin: boolean, author: string) => {
    if (!store || !ready) throw new Error('Aguarde a conexão com o Firebase para salvar a configuração para todos.');
    await store.save(value, isAdmin, author);
  };
  return { visibility, ready, error, save };
}
