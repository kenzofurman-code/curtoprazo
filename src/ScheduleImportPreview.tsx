import { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeSchedule, detectScheduleHeader, SCHEDULE_FIELDS, scheduleColumnName } from './scheduleImport';
import type { ImportOptions, ScheduleAnalysis, ScheduleField, ScheduleSheet } from './scheduleImport';

type Props = { fileName: string; sheets: ScheduleSheet[]; limit: number; onFinish: (result: ScheduleAnalysis | null) => void };
const control = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-600';
const display = (value: unknown) => value === undefined || value === null || value === '' ? '—'
  : /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value).split('-').reverse().join('/') : String(value);
const money = (value: unknown) => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export default function ScheduleImportPreview({ fileName, sheets, limit, onFinish }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sheetIndex, setSheetIndex] = useState(() => {
    const scores = sheets.map(s => detectScheduleHeader(s).score);
    return scores.indexOf(Math.max(...scores));
  });
  const [options, setOptions] = useState<ImportOptions>({});
  const analysis = useMemo(() => analyzeSchedule(sheets[sheetIndex], options), [sheets, sheetIndex, options]);
  const overLimit = analysis.records.length > limit;
  const canImport = !analysis.errors.length && !overLimit;
  useEffect(() => { dialog.current?.showModal(); }, []);
  const updateMapping = (field: ScheduleField, column: number) => setOptions(current => ({ ...current, mapping: { ...current.mapping, [field]: column }, duplicateRows: {} }));

  return (
    <dialog ref={dialog} aria-labelledby="schedule-import-title" onCancel={event => { event.preventDefault(); onFinish(null); }}
      className="m-auto max-h-[94dvh] w-[min(72rem,calc(100%-1.5rem))] max-w-none overflow-hidden rounded-2xl bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/70">
      <div className="flex max-h-[94dvh] flex-col">
        <header className="border-b border-slate-200 px-5 py-4 sm:px-7">
          <h2 id="schedule-import-title" className="text-xl font-bold">Revisar importação do cronograma</h2>
          <p className="mt-1 break-all text-sm text-slate-600">{fileName}</p>
          <p className="mt-2 text-sm text-slate-600">Confira as colunas e resolva as pendências antes de salvar no projeto.</p>
        </header>
        <div className="custom-scrollbar min-h-0 overflow-y-auto px-5 py-5 sm:px-7">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="space-y-1 text-sm font-semibold">Aba da planilha
              <select className={control} value={sheetIndex} onChange={e => { setSheetIndex(Number(e.target.value)); setOptions({}); }}>
                {sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-sm font-semibold">Linha dos nomes das colunas
              <input className={control} type="number" min={1} max={sheets[sheetIndex].rows.length || 1} value={analysis.headerIndex + 1}
                onChange={e => { const value = Number(e.target.value); if (value >= 1 && value <= sheets[sheetIndex].rows.length) setOptions({ headerIndex: value - 1 }); }} />
            </label>
            <label className="space-y-1 text-sm font-semibold">Escala do avanço realizado
              <select className={control} value={options.progressScale || 'auto'} onChange={e => setOptions(o => ({ ...o, progressScale: e.target.value as ImportOptions['progressScale'], duplicateRows: {} }))}>
                <option value="auto">Formato Excel; sem formato, 0 a 100</option>
                <option value="percent">Valores de 0 a 100</option>
                <option value="fraction">Valores de 0 a 1</option>
              </select>
            </label>
          </div>
          <p className="mt-3 text-sm text-slate-600">Dados a partir da linha {analysis.headerIndex + 2}. {analysis.sourceCount.toLocaleString('pt-BR')} registros válidos; {analysis.records.length.toLocaleString('pt-BR')} atividades selecionadas para importar.</p>
          {!!analysis.errors.length && <button className="mt-3 rounded text-sm font-semibold text-red-800 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-indigo-600"
            onClick={() => document.getElementById(analysis.conflicts.length ? 'schedule-conflicts-title' : 'schedule-import-errors')?.scrollIntoView({ block: 'start' })}>
            {analysis.conflicts.length ? `Revisar ${analysis.conflicts.length} conflito(s) antes de importar` : 'Revisar pendências da importação'}
          </button>}

          <h3 className="mb-3 mt-7 text-base font-bold">Colunas reconhecidas</h3>
          <p className="mb-3 text-sm text-slate-600">Pacote, local, início e término são obrigatórios. Os demais campos podem ficar sem associação.</p>
          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
            {(Object.entries(SCHEDULE_FIELDS) as [ScheduleField, string][]).map(([field, label]) => (
              <label key={field} className="space-y-1 text-sm font-semibold">{label}
                <select className={control} value={analysis.mapping[field]} onChange={e => updateMapping(field, Number(e.target.value))}>
                  <option value={-1}>Não importar</option>
                  {analysis.columns.map(c => <option key={c.index} value={c.index}>{scheduleColumnName(c.index)} — {c.label}</option>)}
                </select>
              </label>
            ))}
          </div>
          <details className="mt-4 text-sm text-slate-600">
            <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-indigo-600">{analysis.ignoredColumns.length} colunas não serão importadas</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">{analysis.ignoredColumns.map(c => <li key={c.index}>{scheduleColumnName(c.index)} — {c.leaf}</li>)}</ul>
          </details>

          {!!analysis.conflicts.length && <section className="mt-7" aria-labelledby="schedule-conflicts-title">
            <h3 id="schedule-conflicts-title" className="text-base font-bold">Registros conflitantes</h3>
            <p className="mt-1 text-sm text-slate-600">Escolha a linha que representa cada atividade. As outras versões desse registro não serão importadas. Se forem atividades diferentes, corrija os identificadores na planilha e envie o arquivo novamente.</p>
            {analysis.conflicts.map(conflict => <div key={conflict.key} className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="break-words text-sm font-semibold">{display(conflict.records[0].values.macro)} · {display(conflict.records[0].values.floor)} · {conflict.key.startsWith('id:') ? `ID ${conflict.key.slice(3)}` : 'Sem identificador'}</p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm"><caption className="sr-only">Comparação das versões conflitantes</caption>
                  <thead><tr>{['Linha', 'Serviço', 'Início', 'Término', 'Duração', 'Custo', 'Realizado'].map(h => <th key={h} className="whitespace-nowrap px-2 py-1 font-semibold">{h}</th>)}</tr></thead>
                  <tbody>{conflict.records.map(r => <tr key={r.rowNumber} className="border-t border-amber-200">
                    {[r.rowNumber, r.values.service === '-' ? r.values.macro : r.values.service, r.values.start, r.values.end, r.values.duration, money(r.values.cost), `${r.values.progress}%`].map((v, i) => <td key={i} className={`px-2 py-2 align-top ${i === 1 ? '' : 'whitespace-nowrap'}`}>{display(v)}</td>)}
                  </tr>)}</tbody>
                </table>
              </div>
              <details className="mt-2 text-sm"><summary className="cursor-pointer">Ver todos os campos das versões</summary>
                {conflict.records.map(r => <p key={r.rowNumber} className="mt-2 break-words">Linha {r.rowNumber}: {(Object.keys(SCHEDULE_FIELDS) as ScheduleField[]).map(f => `${SCHEDULE_FIELDS[f]}: ${display(r.values[f])}`).join(' · ')}</p>)}
              </details>
              <label className="mt-3 block space-y-1 text-sm font-semibold">Versão a importar
                <select className={control} value={options.duplicateRows?.[conflict.key] || ''} onChange={e => setOptions(o => ({ ...o, duplicateRows: { ...o.duplicateRows, [conflict.key]: Number(e.target.value) } }))}>
                  <option value="">Selecione uma linha</option>
                  {conflict.records.map(r => <option key={r.rowNumber} value={r.rowNumber}>Importar linha {r.rowNumber}</option>)}
                </select>
              </label>
            </div>)}
          </section>}

          {(analysis.errors.length > 0 || overLimit) && <section id="schedule-import-errors" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4" aria-label="Pendências da importação">
            <h3 className="text-sm font-bold text-red-900">Resolva as pendências para importar</h3>
            <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-red-900">
              {analysis.errors.map((error, i) => <li key={i}>{error}</li>)}
              {overLimit && <li>O limite é {limit.toLocaleString('pt-BR')} atividades por arquivo. Divida a planilha antes de importar.</li>}
            </ul>
          </section>}
          {!!analysis.warnings.length && <details open className="mt-5 rounded-lg border border-slate-200 p-4 text-sm">
            <summary className="cursor-pointer font-semibold">Avisos da importação ({analysis.warnings.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-700">{analysis.warnings.map(w => <li key={w}>{w}</li>)}</ul>
          </details>}
          {!!analysis.records.length && <section className="mt-7">
            <h3 className="mb-2 text-base font-bold">Amostra das atividades</h3>
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <caption className="sr-only">Primeiras cinco atividades selecionadas</caption>
              <thead><tr>{['Linha', 'Pacote / serviço', 'Local', 'Início', 'Término', 'Realizado'].map(h => <th key={h} className="whitespace-nowrap px-2 py-2">{h}</th>)}</tr></thead>
              <tbody>{analysis.records.slice(0, 5).map(r => <tr key={r.rowNumber} className="border-t border-slate-200">
                {[r.rowNumber, r.values.service === '-' ? r.values.macro : r.values.service, r.values.floor, r.values.start, r.values.end, `${r.values.progress}%`].map((v, i) => <td key={i} className={`px-2 py-2 align-top ${i > 2 ? 'whitespace-nowrap' : ''}`}>{display(v)}</td>)}
              </tr>)}</tbody>
            </table></div>
          </section>}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4 sm:px-7">
          <button autoFocus className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-indigo-600" onClick={() => onFinish(null)}>Cancelar</button>
          <button disabled={!canImport} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-600" onClick={() => onFinish(analysis)}>
            Importar {analysis.records.length.toLocaleString('pt-BR')} atividades
          </button>
        </footer>
      </div>
    </dialog>
  );
}
