import React, { useState, useMemo } from 'react';
import {
  getBrazilianHolidays,
  isWorkDay,
  countWorkingDays,
  createDefaultCalendar,
  type ProjectCalendar,
} from './longTermSchedule';

interface CalendarViewProps {
  projectId: string;
  projectName?: string;
  calendar?: ProjectCalendar;
  onSaveCalendar?: (updated: ProjectCalendar) => Promise<void>;
}

const BRAZILIAN_HOLIDAY_NAMES: Record<string, string> = {
  '01-01': 'Confraternização Universal',
  '04-21': 'Tiradentes',
  '05-01': 'Dia do Trabalho',
  '09-07': 'Independência do Brasil',
  '10-12': 'Nossa Senhora Aparecida',
  '11-02': 'Finados',
  '11-15': 'Proclamação da República',
  '11-20': 'Dia da Consciência Negra',
  '12-25': 'Natal',
};

function getHolidayLabel(dateStr: string): string {
  const md = dateStr.slice(5, 10);
  return BRAZILIAN_HOLIDAY_NAMES[md] || 'Feriado / Recesso';
}

export const CalendarView: React.FC<CalendarViewProps> = ({
  projectId,
  projectName = 'Obra Principal',
  calendar,
  onSaveCalendar,
}) => {
  const [activeCal, setActiveCal] = useState<ProjectCalendar>(() => {
    return calendar || createDefaultCalendar('2025-01-01');
  });

  const [currentYear, setCurrentYear] = useState<number>(2025);
  const [currentMonth, setCurrentMonth] = useState<number>(9); // 0-indexed (9 = Outubro)

  const [customHolidayDate, setCustomHolidayDate] = useState('');
  const [customHolidayDesc, setCustomHolidayDesc] = useState('');

  // Calculadora de ritmo / dias úteis
  const [calcStart, setCalcStart] = useState('2025-10-01');
  const [calcEnd, setCalcEnd] = useState('2025-10-31');

  const workingDaysBetween = useMemo(() => {
    if (!calcStart || !calcEnd) return 0;
    return countWorkingDays(calcStart, calcEnd, activeCal);
  }, [calcStart, calcEnd, activeCal]);

  const holidaysMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of activeCal.holidays || []) {
      const dateStr = typeof h === 'string' ? h : (h as any).date;
      if (dateStr) {
        const desc = typeof h === 'string' ? getHolidayLabel(dateStr) : (h as any).description || getHolidayLabel(dateStr);
        map.set(dateStr, desc);
      }
    }
    return map;
  }, [activeCal]);

  // Dias do mês visualizado
  const monthDays = useMemo(() => {
    const firstDay = new Date(Date.UTC(currentYear, currentMonth, 1));
    const lastDayNum = new Date(Date.UTC(currentYear, currentMonth + 1, 0)).getUTCDate();
    const startWeekDay = firstDay.getUTCDay(); // 0 = Dom, 1 = Seg...

    const cells: Array<{
      dateStr: string;
      dayNum: number;
      isWorking: boolean;
      isHoliday: boolean;
      holidayName?: string;
      isCurrentMonth: boolean;
    }> = [];

    // Células vazias do início da semana
    for (let i = 0; i < startWeekDay; i++) {
      cells.push({
        dateStr: '',
        dayNum: 0,
        isWorking: false,
        isHoliday: false,
        isCurrentMonth: false,
      });
    }

    for (let d = 1; d <= lastDayNum; d++) {
      const mStr = String(currentMonth + 1).padStart(2, '0');
      const dStr = String(d).padStart(2, '0');
      const dateStr = `${currentYear}-${mStr}-${dStr}`;

      const hName = holidaysMap.get(dateStr);
      const isH = Boolean(hName);
      const isW = isWorkDay(dateStr, activeCal);

      cells.push({
        dateStr,
        dayNum: d,
        isWorking: isW,
        isHoliday: isH,
        holidayName: hName,
        isCurrentMonth: true,
      });
    }

    return cells;
  }, [currentYear, currentMonth, activeCal, holidaysMap]);

  const handleAddCustomHoliday = () => {
    if (!customHolidayDate) return;
    const cleanDate = customHolidayDate.slice(0, 10);

    const prevList = (activeCal.holidays || []).map((h) => (typeof h === 'string' ? h : (h as any).date));
    const nextHolidays = Array.from(new Set([...prevList, cleanDate]));
    nextHolidays.sort();

    const nextCal: ProjectCalendar = {
      ...activeCal,
      holidays: nextHolidays,
    };
    setActiveCal(nextCal);
    if (onSaveCalendar) onSaveCalendar(nextCal);

    setCustomHolidayDate('');
    setCustomHolidayDesc('');
  };

  const handleRemoveHoliday = (dateStr: string) => {
    const nextHolidays = (activeCal.holidays || [])
      .map((h) => (typeof h === 'string' ? h : (h as any).date))
      .filter((h) => h !== dateStr);
    const nextCal: ProjectCalendar = {
      ...activeCal,
      holidays: nextHolidays,
    };
    setActiveCal(nextCal);
    if (onSaveCalendar) onSaveCalendar(nextCal);
  };

  const MONTH_NAMES = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-300 pb-16">
      {/* HEADER DA TELA */}
      <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">🗓️</span>
            <h2 className="text-lg font-black uppercase tracking-tight text-slate-800">
              Calendário da Obra & Dias Úteis
            </h2>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200">
              Segunda a Sexta (5d úteis/sem)
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Configure feriados nacionais, recesso de canteiro e calcule prazos em dias úteis com precisão.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* COLUNA ESQUERDA: CALENDÁRIO INTERATIVO */}
        <div className="lg:col-span-2 bg-white rounded-2xl p-6 shadow-md border border-slate-200 space-y-4">
          <div className="flex items-center justify-between border-b pb-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-black text-slate-900 uppercase">
                {MONTH_NAMES[currentMonth]} {currentYear}
              </span>
              <span className="text-xs text-slate-400">
                ({monthDays.filter((d) => d.isCurrentMonth && d.isWorking).length} dias úteis)
              </span>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (currentMonth === 0) {
                    setCurrentMonth(11);
                    setCurrentYear((y) => y - 1);
                  } else {
                    setCurrentMonth((m) => m - 1);
                  }
                }}
                className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 font-bold text-xs"
              >
                ◀ Anterior
              </button>
              <button
                type="button"
                onClick={() => {
                  if (currentMonth === 11) {
                    setCurrentMonth(0);
                    setCurrentYear((y) => y + 1);
                  } else {
                    setCurrentMonth((m) => m + 1);
                  }
                }}
                className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 font-bold text-xs"
              >
                Próximo ▶
              </button>
            </div>
          </div>

          {/* GRID DO MÊS */}
          <div className="grid grid-cols-7 gap-1 text-center font-bold text-xs">
            {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((dw, idx) => (
              <div
                key={dw}
                className={`py-2 text-[10px] uppercase font-black tracking-wider ${
                  idx === 0 || idx === 6 ? 'text-slate-400' : 'text-slate-700'
                }`}
              >
                {dw}
              </div>
            ))}

            {monthDays.map((cell, idx) => {
              if (!cell.isCurrentMonth) {
                return <div key={idx} className="h-14 rounded-xl bg-slate-50/40" />;
              }

              return (
                <div
                  key={idx}
                  title={cell.holidayName ? `${cell.dateStr}: ${cell.holidayName}` : cell.dateStr}
                  className={`h-14 rounded-xl p-1.5 flex flex-col justify-between border transition-all text-left ${
                    cell.isHoliday
                      ? 'bg-rose-50 border-rose-300 text-rose-900'
                      : cell.isWorking
                      ? 'bg-emerald-50/50 border-emerald-200 text-emerald-950 hover:bg-emerald-100/60'
                      : 'bg-slate-100/80 border-slate-200 text-slate-400'
                  }`}
                >
                  <span className="font-mono text-xs font-black">{cell.dayNum}</span>
                  {cell.isHoliday && (
                    <span className="text-[9px] font-sans font-bold leading-tight line-clamp-2 text-rose-700">
                      {cell.holidayName}
                    </span>
                  )}
                  {cell.isWorking && !cell.isHoliday && (
                    <span className="text-[8px] font-bold text-emerald-600 uppercase tracking-tight">Útil</span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-4 text-xs pt-3 border-t">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-emerald-100 border border-emerald-300"></span>
              <span className="text-slate-600">Dia Útil de Produção</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-rose-100 border border-rose-300"></span>
              <span className="text-slate-600">Feriado / Recesso</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-slate-100 border border-slate-300"></span>
              <span className="text-slate-600">Fim de Semana (Descanso)</span>
            </div>
          </div>
        </div>

        {/* COLUNA DIREITA: CALCULADORA DE PRAZO & GESTÃO DE FERIADOS */}
        <div className="space-y-6">
          {/* CALCULADORA DE RITMO */}
          <div className="bg-white rounded-2xl p-5 shadow-md border border-slate-200 space-y-3">
            <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
              <span>⚡</span> Calculadora de Dias Úteis
            </h3>
            <div className="space-y-2 text-xs">
              <div>
                <label className="text-[10px] font-bold uppercase text-slate-500 block mb-0.5">Data de Início:</label>
                <input
                  type="date"
                  value={calcStart}
                  onChange={(e) => setCalcStart(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 font-mono outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase text-slate-500 block mb-0.5">Data de Término:</label>
                <input
                  type="date"
                  value={calcEnd}
                  onChange={(e) => setCalcEnd(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 font-mono outline-none"
                />
              </div>
            </div>

            <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-center">
              <span className="text-[10px] font-black uppercase text-emerald-800 tracking-wider block">
                Total de Produção
              </span>
              <span className="text-2xl font-black text-emerald-700 font-mono">
                {workingDaysBetween} {workingDaysBetween === 1 ? 'dia útil' : 'dias úteis'}
              </span>
            </div>
          </div>

          {/* ADICIONAR FERIADO OU RECESSO */}
          <div className="bg-white rounded-2xl p-5 shadow-md border border-slate-200 space-y-3">
            <h3 className="font-bold text-slate-900 text-xs uppercase tracking-wider flex items-center gap-1.5">
              <span>➕</span> Adicionar Recesso / Feriado
            </h3>
            <div className="space-y-2 text-xs">
              <input
                type="date"
                value={customHolidayDate}
                onChange={(e) => setCustomHolidayDate(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 font-mono outline-none"
              />
              <input
                type="text"
                placeholder="Ex: Recesso de Ano Novo, Chuvas Fortes..."
                value={customHolidayDesc}
                onChange={(e) => setCustomHolidayDesc(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 outline-none"
              />
              <button
                type="button"
                onClick={handleAddCustomHoliday}
                disabled={!customHolidayDate}
                className="w-full py-2 bg-slate-800 hover:bg-slate-900 text-white font-bold rounded-lg text-xs transition disabled:opacity-40"
              >
                Cadastrar Feriado
              </button>
            </div>

            {/* LISTA DE FERIADOS */}
            <div className="pt-2 border-t max-h-48 overflow-y-auto space-y-1.5 scrollbar-thin">
              {(activeCal.holidays || []).map((rawH) => {
                const dateStr = typeof rawH === 'string' ? rawH : (rawH as any).date;
                const desc = holidaysMap.get(dateStr) || getHolidayLabel(dateStr);
                return (
                  <div
                    key={dateStr}
                    className="p-2 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between text-xs"
                  >
                    <div>
                      <span className="font-mono font-bold text-slate-800 block text-[11px]">{dateStr}</span>
                      <span className="text-slate-600 text-[10px]">{desc}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveHoliday(dateStr)}
                      className="text-rose-500 hover:text-rose-700 text-sm font-bold px-1"
                      title="Remover feriado"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
