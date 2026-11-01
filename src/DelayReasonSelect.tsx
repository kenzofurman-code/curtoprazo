import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const searchKey = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
export const filterDelayReasons = (options: string[], query: string) => options.filter(option => searchKey(option).includes(searchKey(query)));

type Props = {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  className?: string;
};

export default function DelayReasonSelect({ options, value, onChange, disabled = false,
  label = 'Motivo de atraso', placeholder = '⚠️ Motivo...', className = '' }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number }>({ left: 0, width: 400, maxHeight: 600 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const filtered = filterDelayReasons(options, query);

  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const select = (reason: string) => { onChange(reason); close(); };
  const toggle = () => {
    if (open) { close(); return; }
    const rect = triggerRef.current!.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 400), window.innerWidth - 16);
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const desiredHeight = options.length * 36 + 96;
    const above = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width,
      maxHeight: Math.max(0, above ? spaceAbove : spaceBelow),
      ...(above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
    setQuery(''); setActiveIndex(0); setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const reposition = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listId, open]);

  return <>
    <button ref={triggerRef} type="button" disabled={disabled} aria-label={label} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? listId : undefined} onClick={toggle}
      className={`w-full flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60 ${className}`}>
      <span className="min-w-0 break-words">{value || placeholder}</span><span aria-hidden="true" className="shrink-0 text-[9px]">▼</span>
    </button>
    {open && createPortal(<div ref={menuRef} style={position}
      className="fixed z-[200] flex flex-col bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden text-xs text-slate-800">
      <div className="shrink-0 p-2 border-b border-slate-100">
        <input ref={inputRef} type="search" role="combobox" aria-label={`Buscar ${label.toLowerCase()}`} aria-expanded="true"
          aria-controls={listId} aria-autocomplete="list" aria-activedescendant={filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          placeholder="Digite para buscar..." value={query}
          onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); close(); }
            if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => Math.min(index + 1, filtered.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => Math.max(0, index - 1)); }
            if (event.key === 'Enter') { event.preventDefault(); if (filtered[activeIndex]) select(filtered[activeIndex]); }
            if (event.key === 'Tab') setOpen(false);
          }}
          className="w-full p-2 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
      <button type="button" onClick={() => select('')} className="shrink-0 w-full px-3 py-2 text-left text-slate-500 hover:bg-slate-50">Limpar motivo</button>
      <div id={listId} role="listbox" aria-label={label} className="min-h-0 overflow-y-auto p-1">
        {filtered.map((reason, index) => <button key={reason} id={`${listId}-${index}`} type="button" role="option"
          aria-selected={reason === value} onClick={() => select(reason)}
          className={`w-full p-2 text-left rounded-lg whitespace-normal ${activeIndex === index ? 'bg-indigo-50 text-indigo-800' : 'hover:bg-slate-50'} ${reason === value ? 'font-bold' : ''}`}>
          {reason}
        </button>)}
        {!filtered.length && <div className="p-3 text-slate-500" role="status">Nenhum motivo encontrado.</div>}
      </div>
    </div>, document.body)}
  </>;
}
