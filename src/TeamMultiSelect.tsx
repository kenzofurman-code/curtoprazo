import { useEffect, useRef, useState } from 'react';
import { filterDelayReasons } from './DelayReasonSelect';

export default function TeamMultiSelect({ options, value, onChange }: { options: string[]; value: string[]; onChange: (value: string[]) => void }) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDetailsElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return <details ref={ref} className="relative" onToggle={() => { if (ref.current?.open) input.current?.focus(); else setQuery(''); }}>
    <summary className="p-2.5 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold cursor-pointer whitespace-normal break-words">{value.length ? value.join(', ') : 'Todas as equipes'}</summary>
    <div className="absolute z-50 top-full mt-1 w-full min-w-60 bg-white border border-slate-200 rounded-xl shadow-xl p-2">
      <input ref={input} type="search" aria-label="Buscar empreiteiro ou equipe" placeholder="Digite para buscar equipe..." value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape' && ref.current) ref.current.open = false; }} className="w-full p-2 border rounded-lg text-xs mb-2" />
      <button type="button" onClick={() => onChange([])} className="p-2 text-xs text-indigo-700 font-bold">Todas as equipes</button>
      <div className="max-h-60 overflow-y-auto">
        {filterDelayReasons(options, query).map(team => <label key={team} className="flex items-center gap-2 p-2 text-xs cursor-pointer hover:bg-indigo-50 rounded-lg">
          <input type="checkbox" checked={value.includes(team)} onChange={() => onChange(value.includes(team) ? value.filter(item => item !== team) : [...value, team])} />{team}
        </label>)}
        {!filterDelayReasons(options, query).length && <p role="status" className="p-2 text-xs text-slate-500">Nenhuma equipe encontrada.</p>}
      </div>
    </div>
  </details>;
}
