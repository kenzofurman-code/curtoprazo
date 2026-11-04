import { useMemo } from 'react';
import { calculatePpcByTeam, getPpcSignal } from './ppcDetail';
import { formatDateBR } from './dates';

type Props = {
  planning: any[];
  weeks: string[];
  teams: string[];
};

export default function PpcVisualBoard({ planning, weeks, teams }: Props) {
  const rows = useMemo(() => calculatePpcByTeam(planning, weeks, teams), [planning, weeks, teams]);
  return <div className="lg:col-span-12 bg-white p-5 rounded-2xl shadow-md border border-slate-200">
    <div className="border-b border-slate-100 pb-3 mb-4">
      <h3 className="text-sm font-black uppercase text-indigo-900 tracking-wider">Gestão à vista — Atendimento a prazo</h3>
      <p className="text-xs text-slate-500 mt-1">Cumprimento do planejamento semanal por empreiteiro / equipe.</p>
    </div>
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full border-collapse text-center text-sm">
        <thead className="bg-yellow-400 text-slate-900">
          <tr>
            <th scope="col" rowSpan={2} className="sticky left-0 z-10 bg-yellow-400 p-4 text-left font-black border border-slate-300 min-w-[200px]">Fornecedor / Equipe</th>
            <th scope="colgroup" colSpan={weeks.length} className="p-3 font-bold border border-slate-300">Atendimento a prazo</th>
          </tr>
          <tr>
            {weeks.map(week => <th scope="col" key={week} className="p-3 text-xs font-bold border border-slate-300 min-w-[160px]">
              Semana de {formatDateBR(week)}
            </th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => <tr key={row.team}>
            <th scope="row" className="sticky left-0 z-10 px-4 py-2 text-left font-bold text-slate-800 border border-slate-300 bg-slate-50">{row.team}</th>
            {row.weeks.map(week => {
              const signal = getPpcSignal(week.ppc, week.plannedCount);
              return <td key={week.weekId} className="px-3 py-2 border border-slate-300">
                {signal ? <>
                <img src={`/ppc/${signal.image}.png`} alt={signal.label} title={`${row.team}: ${week.completedCount} de ${week.plannedCount} atividades concluídas — ${signal.label}`} width={40} height={40} className="w-10 h-10 object-contain mx-auto" />
                <span className="block text-[10px] text-slate-500">{week.completedCount} de {week.plannedCount} atividades concluídas</span>
                </> : <>
                  <span className="h-10 flex items-center justify-center text-xl text-slate-400" aria-hidden="true">—</span>
                  <span className="block text-[10px] text-slate-500">Sem atividades</span>
                </>}
              </td>;
            })}
          </tr>)}
          {!rows.length && <tr><td colSpan={weeks.length + 1} className="p-8 text-slate-500">Nenhum empreiteiro / equipe disponível.</td></tr>}
        </tbody>
      </table>
    </div>
    <p className="mt-3 text-xs text-slate-500">Triste: abaixo de 40% · Normal: de 40% a 80% · Feliz: acima de 80% · Traço: sem atividades planejadas.</p>
  </div>;
}
