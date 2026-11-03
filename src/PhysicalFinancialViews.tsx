import { useScheduleVersionHistory } from './useScheduleVersionHistory';
import React, { useState, useMemo, useEffect } from 'react';
import type { BudgetItem } from './budgetLinking';
import {
  runPhysicalFinancialCalculation,
  type PhysicalFinancialCalculationResult,
  type PhysicalFinancialRow,
  type MeasurementGridRow,
  type MeasurementCycle,
} from './physicalFinancialEngine';
import {
  createNewScheduleVersion,
  setVersionAsBaseline,
  activateScheduleVersion,
  type ScheduleVersion,
} from './scheduleVersions';

interface PhysicalFinancialViewsProps {
  projectName?: string;
  projectId: string;
  budgetItems: BudgetItem[];
  scheduleTasks: any[];
  currentSnapshot?: {
    cronogramaInicial: any[];
    floors: string[];
    allFloorsData: Record<string, any>;
    weights?: Record<string, Record<string, number>>;
  };
  onApplyScheduleVersion?: (snapshot: any) => Promise<void>;
}

export type PfTabType = 'distribuicao' | 'fisico_financeiro' | 'medicao' | 'replanejado';
export type PfViewMode = 'pct' | 'pct_service' | 'val';

function formatCurrencyBRL(val?: number): string {
  if (val === undefined || isNaN(val)) return 'R$ 0,00';
  return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatPercent(val?: number, decimals = 2): string {
  if (val === undefined || isNaN(val)) return '0,00%';
  return `${val.toFixed(decimals).replace('.', ',')}%`;
}

export const PhysicalFinancialViews: React.FC<PhysicalFinancialViewsProps> = ({
  projectName = '',
  projectId,
  budgetItems,
  scheduleTasks,
  currentSnapshot,
  onApplyScheduleVersion,
}) => {
  const [activeTab, setActiveTab] = useState<PfTabType>('distribuicao');

  // Configurações de Ciclo e Corte
  const [cycleStartDay, setCycleStartDay] = useState<number>(21);
  const [cutoffMedNum, setCutoffMedNum] = useState<number>(1);
  const [viewMode, setViewMode] = useState<PfViewMode>('pct');
  const [levelFilter, setLevelFilter] = useState<number>(0); // 0 = todos, 2 = até N2, 3 = até N3, 4 = até N4, 5 = até N5
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedFilterMonth, setSelectedFilterMonth] = useState<number | null>(null);
  const [showSCurve, setShowSCurve] = useState<boolean>(true);
  const [expandedL5, setExpandedL5] = useState<Record<string, boolean>>({});

  // Medições mensais customizadas na tela de Medição
  const [customMonthlyMeasurements, setCustomMonthlyMeasurements] = useState<Record<string, Record<string, number>>>({});
  const [isApplyingMedicao, setIsApplyingMedicao] = useState<boolean>(false);

  // Versões de Cronograma e Linha de Base
  const {versions,setVersions,busy:versionsBusy,error:versionsError,run:runVersions} = useScheduleVersionHistory(projectId,currentSnapshot);
  const [isNewVersionModalOpen, setIsNewVersionModalOpen] = useState<boolean>(false);
  const [newVersionName, setNewVersionName] = useState<string>('');
  const [newVersionDesc, setNewVersionDesc] = useState<string>('');
  const [newVersionIsBaseline, setNewVersionIsBaseline] = useState<boolean>(false);

  const activeVersion = useMemo(() => {
    return versions.find((v) => v.isActive) || versions[0] || null;
  }, [versions]);

  const baselineVersion = useMemo(() => {
    return versions.find((v) => v.isBaseline) || versions[0] || null;
  }, [versions]);

  // Executa o motor central de cálculo com os parâmetros ativos
  const calcResult: PhysicalFinancialCalculationResult = useMemo(() => {
    return runPhysicalFinancialCalculation({
      projectName,
      budgetItems,
      scheduleTasks,
      cycleStartDay,
      cycleEndDay: cycleStartDay <= 1 ? 31 : cycleStartDay - 1,
      cutoffMedNum,
      customMeasurementsMonthly: customMonthlyMeasurements,
    });
  }, [projectName, budgetItems, scheduleTasks, cycleStartDay, cutoffMedNum, customMonthlyMeasurements]);

  // Alterna expansão de item Nível 5
  const toggleExpand = (code: string) => {
    setExpandedL5((prev) => ({ ...prev, [code]: !prev[code] }));
  };

  const expandAll = () => {
    const allCodes: Record<string, boolean> = {};
    calcResult.tabDistribuicao.forEach((r) => {
      if (r.level === 5) allCodes[r.code] = true;
    });
    setExpandedL5(allCodes);
  };

  const collapseAll = () => {
    setExpandedL5({});
  };

  // Filtra linhas ativas para exibição de acordo com levelFilter, searchQuery e selectedFilterMonth
  const filteredRows = useMemo(() => {
    let sourceRows: PhysicalFinancialRow[] = [];
    if (activeTab === 'distribuicao') sourceRows = calcResult.tabDistribuicao;
    else if (activeTab === 'fisico_financeiro') sourceRows = calcResult.tabFisicoFinanceiro;
    else if (activeTab === 'replanejado') sourceRows = calcResult.tabReplanejado;

    return sourceRows.filter((row) => {
      // Filtro de Nível
      if (levelFilter > 0 && row.level > levelFilter) return false;

      // Colapso de filhos Nível 6 se o Nível 5 pai estiver fechado
      if (row.level === 6 && row.parent_code && !expandedL5[row.parent_code]) {
        return false;
      }

      // Filtro de Texto (busca por código ou descrição)
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesCode = row.code.toLowerCase().includes(q);
        const matchesDesc = row.description.toLowerCase().includes(q);
        if (!matchesCode && !matchesDesc) return false;
      }

      // Filtro por Mês Selecionado
      if (selectedFilterMonth !== null) {
        const valInMonth = row.cycle_vals?.[String(selectedFilterMonth)] || 0;
        if (valInMonth <= 0.001) return false;
      }

      return true;
    });
  }, [activeTab, calcResult, levelFilter, searchQuery, selectedFilterMonth, expandedL5]);

  // Linhas para a tela de Medição
  const filteredMedRows = useMemo(() => {
    return calcResult.tabMedicao.filter((row) => {
      if (levelFilter > 0 && row.level > levelFilter) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesCode = row.code.toLowerCase().includes(q);
        const matchesDesc = row.description.toLowerCase().includes(q);
        if (!matchesCode && !matchesDesc) return false;
      }

      if (selectedFilterMonth !== null) {
        const m = row.monthly_map[String(selectedFilterMonth)] || 0;
        if (m <= 0) return false;
      }

      return true;
    });
  }, [calcResult.tabMedicao, levelFilter, searchQuery, selectedFilterMonth]);

  // Linha Nível 1 Totalizadora (sempre fixada no topo)
  const level1Row = useMemo(() => {
    if (activeTab === 'fisico_financeiro') {
      return calcResult.tabFisicoFinanceiro.find((r) => r.level === 1) || calcResult.tabFisicoFinanceiro[0];
    }
    if (activeTab === 'replanejado') {
      return calcResult.tabFfReplanejado.find((r) => r.level === 1) || calcResult.tabFfReplanejado[0];
    }
    return calcResult.tabFisicoFinanceiro.find((r) => r.level === 1) || calcResult.tabFisicoFinanceiro[0];
  }, [activeTab, calcResult]);

  // Criação de nova versão
  const handleCreateVersion = async () => {
    await runVersions(async () => {
      if (!currentSnapshot) return;
      const { versions: updated } = await createNewScheduleVersion(
        projectId,
        newVersionName || `Versão ${versions.length + 1}`,
        newVersionDesc,
        newVersionIsBaseline,
        currentSnapshot
      );
      setVersions(updated);
      setIsNewVersionModalOpen(false);
      setNewVersionName('');
      setNewVersionDesc('');
      setNewVersionIsBaseline(false);
    });
  };

  const handleSetBaseline = async (versionId: string) => {
    await runVersions(async () => {
      const updated = await setVersionAsBaseline(projectId, versionId);
      setVersions(updated);
    });
  };

  const handleActivateVersion = async (versionId: string) => {
    await runVersions(async () => {
      const { versions: updated, active } = await activateScheduleVersion(projectId, versionId);
      setVersions(updated);
      if (active && onApplyScheduleVersion && active.snapshot) {
        await onApplyScheduleVersion(active.snapshot);
      }
    });
  };

  const handleMedicaoChange = (code: string, medNum: number, value: number) => {
    setCustomMonthlyMeasurements((prev) => {
      const copy = { ...prev };
      if (!copy[code]) copy[code] = {};
      copy[code][String(medNum)] = Math.max(0, Math.min(100, value));
      return copy;
    });
  };

  return (
    <div className="bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden flex flex-col min-h-[750px] animate-in fade-in duration-200">
      {versionsBusy && <p role="status" className="p-3 text-sm text-slate-600">Processando histórico de versões…</p>}
      {versionsError && !isNewVersionModalOpen && <p role="alert" className="bg-red-50 p-3 text-sm text-red-800">{versionsError}</p>}
      {/* =====================================================================
          HEADER PRINCIPAL COM NAVEGAÇÃO DE SUB-ABAS E BARRA DE VERSÕES
         ===================================================================== */}
      <div className="p-4 bg-slate-900 text-white border-b border-slate-800 flex flex-col gap-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">📊</span>
              <h2 className="text-sm font-black uppercase tracking-wider text-white">
                Físico-Financeiro & Replanejamento
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                100% Orçamento Fechado
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Distribuição nível 6, EAP baseline, apontamento mensal multinível e curva S replanejada pelo saldo restante.
            </p>
          </div>

          {/* BARRA DE VERSÕES & LINHA DE BASE */}
          <div className="flex flex-wrap items-center gap-2 bg-slate-800/80 p-1.5 rounded-xl border border-slate-700/60 text-xs">
            <span className="text-slate-400 font-bold text-[11px] uppercase tracking-wider ml-1">Versão:</span>
            <select
              value={activeVersion?.id || ''}
              onChange={(e) => handleActivateVersion(e.target.value)}
              className="bg-slate-900 border border-slate-600 text-white text-xs font-semibold rounded-lg px-2.5 py-1 outline-none cursor-pointer focus:ring-1 focus:ring-emerald-500"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} {v.isBaseline ? '⭐ (Linha de Base Oficial)' : ''}
                </option>
              ))}
            </select>

            <button
              onClick={() => setIsNewVersionModalOpen(true)}
              className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs transition shadow-sm flex items-center gap-1"
              title="Salvar o estado atual como uma nova versão congelada"
            >
              <span>💾</span> Salvar Versão
            </button>

            {activeVersion && !activeVersion.isBaseline && (
              <button
                onClick={() => handleSetBaseline(activeVersion.id)}
                className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs transition shadow-sm flex items-center gap-1"
                title="Definir esta versão como a Linha de Base oficial do projeto"
              >
                <span>⭐</span> Definir Linha de Base
              </button>
            )}
          </div>
        </div>

        {/* NAVEGAÇÃO DE SUB-ABAS (4 TELAS SOLICITADAS) */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
          <div className="flex items-center gap-1 bg-slate-800/90 p-1 rounded-xl border border-slate-700">
            <button
              onClick={() => setActiveTab('distribuicao')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                activeTab === 'distribuicao'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <span>📋</span> Distribuição (Nível 6 & Pesos)
            </button>

            <button
              onClick={() => setActiveTab('fisico_financeiro')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                activeTab === 'fisico_financeiro'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <span>📈</span> Físico-Financeiro Inicial
            </button>

            <button
              onClick={() => setActiveTab('medicao')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                activeTab === 'medicao'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <span>📏</span> Base Medição (N5 & N6)
            </button>

            <button
              onClick={() => setActiveTab('replanejado')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                activeTab === 'replanejado'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <span>🔄</span> Replanejado & Curva S
            </button>
          </div>

          {/* TOTALIZADORES RESUMIDOS */}
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-slate-400 font-sans uppercase">Orçamento Total</span>
              <span className="font-bold text-slate-200">{formatCurrencyBRL(calcResult.totalBudget)}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-emerald-400 font-sans uppercase">Realizado Acumulado</span>
              <span className="font-bold text-emerald-400">
                {formatCurrencyBRL(calcResult.totalMeasured)} ({calcResult.totalMeasuredPct.toFixed(2)}%)
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-blue-400 font-sans uppercase">Saldo a Medir</span>
              <span className="font-bold text-blue-300">
                {formatCurrencyBRL(calcResult.totalBalance)} ({calcResult.totalBalancePct.toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          BARRA DE CONTROLES SECUNDÁRIA (FILTRO DE NÍVEL, MODO % / R$, CORTE, CICLO)
         ===================================================================== */}
      <div className="p-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* Seletor de Corte (Mês de início do Replanejamento) */}
          <div className="flex items-center gap-1.5 bg-white border border-slate-300 px-2 py-1 rounded-lg">
            <span className="font-bold text-slate-600 text-[11px]">Medição de Corte:</span>
            <select
              value={cutoffMedNum}
              onChange={(e) => setCutoffMedNum(Number(e.target.value))}
              className="bg-slate-50 border border-slate-300 text-slate-800 font-semibold rounded px-1.5 py-0.5 outline-none cursor-pointer"
            >
              {calcResult.cycles.map((cy) => (
                <option key={cy.num} value={cy.num}>
                  {cy.name} ({cy.period_label})
                </option>
              ))}
            </select>
          </div>

          {/* Configuração de Ciclo: Dia 21 a 20 vs 1 a 30 */}
          <div className="flex items-center gap-1 bg-slate-200/80 p-0.5 rounded-lg border border-slate-300 text-[11px] font-semibold">
            <span className="text-[10px] text-slate-500 px-1 uppercase font-bold">Janela:</span>
            <button
              onClick={() => setCycleStartDay(21)}
              className={`px-2 py-0.5 rounded transition ${
                cycleStartDay === 21 ? 'bg-white text-slate-900 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              21 a 20
            </button>
            <button
              onClick={() => setCycleStartDay(1)}
              className={`px-2 py-0.5 rounded transition ${
                cycleStartDay === 1 ? 'bg-white text-slate-900 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              1 a 30
            </button>
          </div>

          {/* Filtro de Nível Rápido */}
          <div className="flex items-center gap-1 bg-slate-200/80 p-0.5 rounded-lg border border-slate-300 text-[11px] font-semibold">
            <span className="text-[10px] text-slate-500 px-1 uppercase font-bold">Nível:</span>
            <button
              onClick={() => setLevelFilter(2)}
              className={`px-2 py-0.5 rounded transition ${
                levelFilter === 2 ? 'bg-blue-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Até N2
            </button>
            <button
              onClick={() => setLevelFilter(3)}
              className={`px-2 py-0.5 rounded transition ${
                levelFilter === 3 ? 'bg-blue-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Até N3
            </button>
            <button
              onClick={() => setLevelFilter(4)}
              className={`px-2 py-0.5 rounded transition ${
                levelFilter === 4 ? 'bg-blue-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Até N4
            </button>
            <button
              onClick={() => setLevelFilter(0)}
              className={`px-2 py-0.5 rounded transition ${
                levelFilter === 0 ? 'bg-blue-600 text-white shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Todos
            </button>
          </div>

          {/* Seletor de Modo de Visualização (% Obra / % Serviço / R$) */}
          <div className="flex items-center gap-0.5 bg-slate-200/80 p-0.5 rounded-lg border border-slate-300 text-[11px] font-semibold">
            <button
              onClick={() => setViewMode('pct')}
              className={`px-2 py-0.5 rounded transition ${
                viewMode === 'pct' ? 'bg-white text-blue-700 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              % Obra
            </button>
            {(activeTab === 'distribuicao' || activeTab === 'replanejado') && (
              <button
                onClick={() => setViewMode('pct_service')}
                className={`px-2 py-0.5 rounded transition ${
                  viewMode === 'pct_service' ? 'bg-white text-blue-700 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                % Serviço
              </button>
            )}
            <button
              onClick={() => setViewMode('val')}
              className={`px-2 py-0.5 rounded transition ${
                viewMode === 'val' ? 'bg-white text-blue-700 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              R$ Financeiro
            </button>
          </div>

          {/* Botões de Expandir / Recolher todos */}
          {(activeTab === 'distribuicao' || activeTab === 'replanejado') && (
            <div className="flex items-center gap-1">
              <button
                onClick={expandAll}
                className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded font-semibold text-[11px] transition shadow-xs"
              >
                Expandir N6
              </button>
              <button
                onClick={collapseAll}
                className="px-2 py-1 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded font-semibold text-[11px] transition shadow-xs"
              >
                Recolher
              </button>
            </div>
          )}
        </div>

        {/* Campo de Busca e Toggle Curva S */}
        <div className="flex items-center gap-2">
          {activeTab === 'replanejado' && (
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showSCurve}
                onChange={(e) => setShowSCurve(e.target.checked)}
                className="rounded border-slate-300 text-indigo-600 focus:ring-0 cursor-pointer"
              />
              <span>Gráfico Curva S</span>
            </label>
          )}

          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filtrar por código ou descrição..."
            className="bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-xs w-56 outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* BANNER DE FILTRO POR MÊS ATIVO */}
      {selectedFilterMonth !== null && (
        <div className="mx-4 my-2 flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5 text-xs text-blue-900">
          <div className="flex items-center gap-2">
            <span>🔍</span>
            <span>
              Filtrando linhas ativas em:{' '}
              <strong className="font-bold text-blue-800">
                {calcResult.cycles.find((c) => c.num === selectedFilterMonth)?.full_label || `Mês ${selectedFilterMonth}`}
              </strong>
            </span>
          </div>
          <button
            onClick={() => setSelectedFilterMonth(null)}
            className="text-[11px] font-bold text-blue-700 hover:text-blue-900 bg-white border border-blue-300 rounded px-2 py-0.5 transition hover:bg-blue-100/60 shadow-2xs"
          >
            Limpar Filtro
          </button>
        </div>
      )}

      {/* =====================================================================
          GRÁFICO CURVA S INTERATIVO (PREVISTO BASELINE VS REALIZADO VS REPLANEJADO)
         ===================================================================== */}
      {activeTab === 'replanejado' && showSCurve && (
        <div className="p-4 bg-slate-900 text-white border-b border-slate-800">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">Curva S Comparativa (Físico Acumulado)</span>
              <span className="text-[11px] text-slate-400">
                Corte na Medição {cutoffMedNum} ({calcResult.cutoffDate})
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-blue-500 inline-block"></span>
                <span className="text-slate-300 font-semibold">Previsto Inicial (Baseline)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-emerald-400 inline-block"></span>
                <span className="text-slate-300 font-semibold">Realizado (Medições)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-indigo-400 inline-block"></span>
                <span className="text-slate-300 font-semibold">Replanejado (Saldo Futuro)</span>
              </div>
            </div>
          </div>

          {/* SVG RENDER DA CURVA S */}
          <div className="w-full h-44 relative bg-slate-950/60 rounded-xl p-2 border border-slate-800">
            <svg className="w-full h-full overflow-visible" viewBox="0 0 1000 120" preserveAspectRatio="none">
              {/* Grid Horizontal */}
              {[0, 25, 50, 75, 100].map((pct) => {
                const y = 110 - (pct / 100) * 100;
                return (
                  <g key={pct}>
                    <line x1="0" y1={y} x2="1000" y2={y} stroke="#334155" strokeWidth="0.5" strokeDasharray="3 3" />
                    <text x="5" y={y - 2} fill="#64748b" fontSize="8" fontFamily="monospace">
                      {pct}%
                    </text>
                  </g>
                );
              })}

              {/* Curva Baseline (Azul) */}
              {calcResult.sCurve.baseline_accum_pcts.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth="2.5"
                  points={calcResult.sCurve.baseline_accum_pcts
                    .map((val, idx) => {
                      const x = (idx / (calcResult.sCurve.baseline_accum_pcts.length - 1)) * 960 + 20;
                      const y = 110 - (Math.min(100, Math.max(0, val)) / 100) * 100;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />
              )}

              {/* Curva Replanejada (Índigo) */}
              {calcResult.sCurve.replan_accum_pcts.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#818cf8"
                  strokeWidth="2.5"
                  strokeDasharray="4 2"
                  points={calcResult.sCurve.replan_accum_pcts
                    .map((val, idx) => {
                      const x = (idx / (calcResult.sCurve.replan_accum_pcts.length - 1)) * 960 + 20;
                      const y = 110 - (Math.min(100, Math.max(0, val)) / 100) * 100;
                      return `${x},${y}`;
                    })
                    .join(' ')}
                />
              )}

              {/* Curva Realizada (Verde) */}
              {calcResult.sCurve.realized_accum_pcts.filter((v) => v !== null).length > 0 && (
                <polyline
                  fill="none"
                  stroke="#34d399"
                  strokeWidth="3.5"
                  points={calcResult.sCurve.realized_accum_pcts
                    .map((val, idx) => {
                      if (val === null) return null;
                      const x = (idx / (calcResult.sCurve.realized_accum_pcts.length - 1)) * 960 + 20;
                      const y = 110 - (Math.min(100, Math.max(0, val)) / 100) * 100;
                      return `${x},${y}`;
                    })
                    .filter(Boolean)
                    .join(' ')}
                />
              )}

              {/* Pontos nas Medições Passadas */}
              {calcResult.sCurve.realized_accum_pcts.map((val, idx) => {
                if (val === null) return null;
                const x = (idx / (calcResult.sCurve.realized_accum_pcts.length - 1)) * 960 + 20;
                const y = 110 - (Math.min(100, Math.max(0, val)) / 100) * 100;
                return <circle key={idx} cx={x} cy={y} r="3" fill="#10b981" stroke="#ffffff" strokeWidth="1" />;
              })}
            </svg>
          </div>
        </div>
      )}

      {/* =====================================================================
          TABELAS DINÂMICAS MULTINÍVEL (DISTRIBUIÇÃO, FÍSICO-FINANCEIRO, MEDIÇÃO, REPLANEJADO)
         ===================================================================== */}
      <div className="overflow-x-auto flex-1 max-h-[620px] scrollbar-thin">
        {activeTab !== 'medicao' ? (
          /* TABELAS PADRÃO (DISTRIBUIÇÃO / FÍSICO-FINANCEIRO / REPLANEJADO) */
          <table className="w-full text-left border-separate border-spacing-0 text-xs">
            <thead className="bg-slate-900 text-white sticky top-0 z-20">
              <tr className="h-9">
                <th className="py-1 px-2 w-10 text-center border-b border-r border-slate-800 sticky top-0 left-0 z-40 bg-slate-900">
                  Nív
                </th>
                <th className="py-1 px-2 w-28 border-b border-r border-slate-800 sticky top-0 left-[40px] z-40 bg-slate-900">
                  Código
                </th>
                <th className="py-1 px-3 min-w-[260px] border-b border-r border-slate-800 sticky top-0 left-[150px] z-40 bg-slate-900">
                  Descrição / Tarefa
                </th>
                {activeTab === 'distribuicao' && (
                  <>
                    <th className="py-1 px-2 text-center w-14 border-b border-r border-slate-800 sticky top-0 left-[410px] z-40 bg-slate-900">
                      Dur.
                    </th>
                    <th className="py-1 px-2 text-right w-16 border-b border-r border-slate-800 sticky top-0 left-[466px] z-40 bg-slate-900">
                      Peso
                    </th>
                  </>
                )}
                <th className="py-1 px-2 text-right w-28 border-b border-r border-slate-800 sticky top-0 left-[530px] z-40 bg-slate-900">
                  {viewMode === 'val' ? 'Orçado (R$)' : 'Orçado (% Obra)'}
                </th>

                {/* Colunas dos Ciclos de Medição */}
                {calcResult.cycles.map((cy) => (
                  <th
                    key={cy.num}
                    onClick={() => setSelectedFilterMonth(selectedFilterMonth === cy.num ? null : cy.num)}
                    title={`Clique para filtrar apenas linhas com valores no ${cy.name}`}
                    className={`py-1 px-2 text-right min-w-[85px] border-b border-r border-slate-800 cursor-pointer transition select-none ${
                      selectedFilterMonth === cy.num
                        ? 'bg-blue-600 text-white font-extrabold ring-1 ring-blue-300'
                        : cy.is_past
                        ? 'bg-slate-900 hover:bg-slate-800 text-emerald-300'
                        : 'bg-slate-900 hover:bg-slate-800 text-slate-300'
                    }`}
                  >
                    <div className="font-bold text-[11px]">{cy.name}</div>
                    <div className="text-[9px] text-slate-400 font-normal">{cy.period_label}</div>
                  </th>
                ))}

                <th className="py-1 px-2 text-right min-w-[95px] bg-slate-800 border-b border-slate-800 sticky top-0 right-0 z-30">
                  Total
                </th>
              </tr>

              {/* LINHA 2: TOTALIZADOR NÍVEL 1 PINADO */}
              {level1Row && (
                <tr className="h-8 bg-black text-white font-bold">
                  <th className="py-0.5 px-2 text-center border-b border-r border-neutral-800 sticky top-[36px] left-0 z-35 bg-black">
                    1
                  </th>
                  <th className="py-0.5 px-2 font-mono text-[10px] border-b border-r border-neutral-800 sticky top-[36px] left-[40px] z-35 bg-black">
                    {level1Row.code}
                  </th>
                  <th className="py-0.5 px-3 border-b border-r border-neutral-800 sticky top-[36px] left-[150px] z-35 bg-black truncate">
                    {level1Row.description}
                  </th>
                  {activeTab === 'distribuicao' && (
                    <>
                      <th className="py-0.5 px-2 text-center border-b border-r border-neutral-800 sticky top-[36px] left-[410px] z-35 bg-black text-slate-400">
                        -
                      </th>
                      <th className="py-0.5 px-2 text-right border-b border-r border-neutral-800 sticky top-[36px] left-[466px] z-35 bg-black text-slate-400">
                        -
                      </th>
                    </>
                  )}
                  <th className="py-0.5 px-2 text-right border-b border-r border-neutral-800 sticky top-[36px] left-[530px] z-35 bg-black">
                    {viewMode === 'val' ? formatCurrencyBRL(level1Row.budget) : '100,00%'}
                  </th>

                  {calcResult.cycles.map((cy) => {
                    const cyKey = String(cy.num);
                    const val = level1Row.cycle_vals?.[cyKey] || 0;
                    const pct = level1Row.cycle_pcts?.[cyKey] || 0;
                    return (
                      <th key={cy.num} className="py-0.5 px-2 text-right min-w-[85px] border-b border-r border-neutral-800 bg-neutral-950 font-mono">
                        {viewMode === 'val' ? formatCurrencyBRL(val) : formatPercent(pct)}
                      </th>
                    );
                  })}

                  <th className="py-0.5 px-2 text-right min-w-[95px] bg-neutral-900 border-b border-neutral-800 sticky top-[36px] right-0 z-35 font-mono">
                    {viewMode === 'val' ? formatCurrencyBRL(level1Row.total) : '100,00%'}
                  </th>
                </tr>
              )}
            </thead>

            <tbody className="divide-y divide-slate-200">
              {filteredRows.map((row) => {
                const isL5 = row.level === 5;
                const isL6 = row.level === 6;
                const isExpanded = expandedL5[row.code];

                return (
                  <tr
                    key={row.code}
                    className={`transition-colors hover:bg-slate-50 ${
                      row.level <= 2
                        ? 'bg-slate-100/80 font-bold text-slate-900'
                        : row.level === 3
                        ? 'bg-slate-50/60 font-semibold text-slate-800'
                        : isL6
                        ? 'bg-blue-50/20 text-slate-600'
                        : 'text-slate-700'
                    }`}
                  >
                    <td className="py-1 px-2 text-center border-b border-r border-slate-200 sticky left-0 z-10 bg-inherit font-mono">
                      {row.level}
                    </td>
                    <td className="py-1 px-2 font-mono text-[10px] border-b border-r border-slate-200 sticky left-[40px] z-10 bg-inherit">
                      {row.code}
                    </td>
                    <td
                      className="py-1 px-3 border-b border-r border-slate-200 sticky left-[150px] z-10 bg-inherit"
                      style={{ paddingLeft: `${Math.max(8, (row.level - 1) * 14)}px` }}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        {isL5 && (
                          <button
                            onClick={() => toggleExpand(row.code)}
                            className="w-4 h-4 rounded hover:bg-slate-200 text-slate-500 font-bold inline-flex items-center justify-center shrink-0"
                          >
                            {isExpanded ? '−' : '+'}
                          </button>
                        )}
                        {isL6 && <span className="text-blue-500 font-bold shrink-0">↳</span>}
                        <span className="truncate" title={row.description}>
                          {row.description}
                        </span>
                      </div>
                    </td>

                    {activeTab === 'distribuicao' && (
                      <>
                        <td className="py-1 px-2 text-center border-b border-r border-slate-200 sticky left-[410px] z-10 bg-inherit text-slate-500">
                          {row.duration || '-'}
                        </td>
                        <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[466px] z-10 bg-inherit font-mono">
                          {row.weight_pct !== undefined ? formatPercent(row.weight_pct) : '-'}
                        </td>
                      </>
                    )}

                    <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[530px] z-10 bg-inherit font-mono">
                      {viewMode === 'val'
                        ? formatCurrencyBRL(row.budget || row.allocated_val)
                        : formatPercent(row.budget_pct || row.total_pct_obra)}
                    </td>

                    {calcResult.cycles.map((cy) => {
                      const cyKey = String(cy.num);
                      const cyVal = row.cycle_vals?.[cyKey] || 0;
                      let displayVal = '-';

                      if (viewMode === 'val') {
                        displayVal = cyVal > 0 ? formatCurrencyBRL(cyVal) : '-';
                      } else if (viewMode === 'pct_service') {
                        const pctS = row.cycle_pcts_service?.[cyKey] || 0;
                        displayVal = pctS > 0 ? formatPercent(pctS) : '-';
                      } else {
                        const pctO = row.cycle_pcts?.[cyKey] || row.cycle_pcts_obra?.[cyKey] || 0;
                        displayVal = pctO > 0 ? formatPercent(pctO) : '-';
                      }

                      return (
                        <td
                          key={cy.num}
                          className={`py-1 px-2 text-right min-w-[85px] border-b border-r border-slate-200 font-mono text-[11px] ${
                            cyVal > 0 ? 'text-slate-800 font-medium' : 'text-slate-400'
                          } ${cy.is_past ? 'bg-emerald-50/20' : ''}`}
                        >
                          {displayVal}
                        </td>
                      );
                    })}

                    <td className="py-1 px-2 text-right min-w-[95px] border-b border-slate-200 font-mono font-bold bg-slate-50 sticky right-0 z-10">
                      {viewMode === 'val' ? formatCurrencyBRL(row.total) : formatPercent(row.total_pct)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          /* TABELA DE MEDIÇÃO (N5 & N6 COM COLUNAS M1..MN EDITÁVEIS E SALDO CALCULADO) */
          <table className="w-full text-left border-separate border-spacing-0 text-xs">
            <thead className="bg-slate-900 text-white sticky top-0 z-20">
              <tr className="h-9">
                <th className="py-1 px-2 w-10 text-center border-b border-r border-slate-800 sticky top-0 left-0 z-40 bg-slate-900">
                  Nív
                </th>
                <th className="py-1 px-2 w-28 border-b border-r border-slate-800 sticky top-0 left-[40px] z-40 bg-slate-900">
                  Código
                </th>
                <th className="py-1 px-3 min-w-[260px] border-b border-r border-slate-800 sticky top-0 left-[150px] z-40 bg-slate-900">
                  Descrição EAP / Tarefa
                </th>
                <th className="py-1 px-2 w-28 text-right border-b border-r border-slate-800 sticky top-0 left-[410px] z-40 bg-slate-900">
                  Orçado (R$)
                </th>
                <th className="py-1 px-2 w-20 text-right border-b border-r border-slate-800 text-emerald-400 sticky top-0 left-[520px] z-40 bg-slate-900">
                  Acum. Real. (%)
                </th>
                <th className="py-1 px-2 w-28 text-right border-b border-r border-slate-800 text-emerald-400 sticky top-0 left-[600px] z-40 bg-slate-900">
                  Acum. Real. (R$)
                </th>
                <th className="py-1 px-2 w-28 text-right border-b border-r border-slate-800 text-blue-300 sticky top-0 left-[710px] z-40 bg-slate-900">
                  Saldo a Medir
                </th>

                {/* Colunas Mensais M1..MN */}
                {calcResult.cycles.map((cy) => (
                  <th
                    key={cy.num}
                    className={`py-1 px-2 text-right min-w-[80px] border-b border-r border-slate-800 ${
                      cy.is_past ? 'bg-slate-900 text-emerald-300' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    <div className="font-bold text-[11px]">M{cy.num}</div>
                    <div className="text-[9px] text-slate-400 font-normal">{cy.period_label}</div>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-200">
              {filteredMedRows.map((row) => {
                const isL5 = row.level === 5;
                const isExpanded = expandedL5[row.code];

                return (
                  <React.Fragment key={row.code}>
                    <tr
                      className={`transition-colors hover:bg-slate-50 ${
                        row.level <= 2
                          ? 'bg-slate-100/90 font-bold text-slate-900'
                          : row.level === 3
                          ? 'bg-slate-50/80 font-semibold text-slate-800'
                          : isL5
                          ? 'bg-white font-medium text-slate-800'
                          : 'text-slate-700'
                      }`}
                    >
                      <td className="py-1 px-2 text-center border-b border-r border-slate-200 sticky left-0 z-10 bg-inherit font-mono">
                        {row.level}
                      </td>
                      <td className="py-1 px-2 font-mono text-[10px] border-b border-r border-slate-200 sticky left-[40px] z-10 bg-inherit">
                        {row.code}
                      </td>
                      <td
                        className="py-1 px-3 border-b border-r border-slate-200 sticky left-[150px] z-10 bg-inherit"
                        style={{ paddingLeft: `${Math.max(8, (row.level - 1) * 14)}px` }}
                      >
                        <div className="flex items-center gap-1.5 truncate">
                          {isL5 && row.tasks_l6?.length > 0 && (
                            <button
                              onClick={() => toggleExpand(row.code)}
                              className="w-4 h-4 rounded hover:bg-slate-200 text-slate-500 font-bold inline-flex items-center justify-center shrink-0"
                            >
                              {isExpanded ? '−' : '+'}
                            </button>
                          )}
                          <span className="truncate" title={row.description}>
                            {row.description}
                          </span>
                        </div>
                      </td>

                      <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[410px] z-10 bg-inherit font-mono">
                        {formatCurrencyBRL(row.total_price)}
                      </td>
                      <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[520px] z-10 bg-inherit font-mono text-emerald-600 font-bold">
                        {formatPercent(row.accum_realizado_pct)}
                      </td>
                      <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[600px] z-10 bg-inherit font-mono text-emerald-600 font-bold">
                        {formatCurrencyBRL(row.accum_realizado_val)}
                      </td>
                      <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[710px] z-10 bg-inherit font-mono text-blue-600 font-bold">
                        {formatCurrencyBRL(row.saldo)}
                      </td>

                      {/* Inputs Mensais Editáveis até a Medição de Corte */}
                      {calcResult.cycles.map((cy) => {
                        const mVal = row.monthly_map[String(cy.num)] || 0;
                        const isPast = cy.is_past;

                        return (
                          <td
                            key={cy.num}
                            className={`py-0.5 px-1 text-right min-w-[80px] border-b border-r border-slate-200 font-mono text-[11px] ${
                              isPast ? 'bg-emerald-50/20' : 'bg-slate-50/30'
                            }`}
                          >
                            {isL5 && isPast ? (
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.1"
                                value={mVal > 0 ? mVal : ''}
                                placeholder="0,0%"
                                onChange={(e) => handleMedicaoChange(row.code, cy.num, parseFloat(e.target.value) || 0)}
                                className="w-16 bg-white border border-slate-300 text-right px-1 py-0.5 rounded text-xs outline-none focus:ring-1 focus:ring-emerald-500 font-mono"
                              />
                            ) : (
                              <span>{mVal > 0 ? formatPercent(mVal) : '-'}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>

                    {/* Linhas Filhas Nível 6 Expandidas */}
                    {isL5 && isExpanded && row.tasks_l6?.map((tL6, idx) => (
                      <tr key={idx} className="bg-blue-50/20 text-slate-600 text-xs">
                        <td className="py-1 px-2 text-center border-b border-r border-slate-200 sticky left-0 z-10 bg-inherit font-mono">
                          6
                        </td>
                        <td className="py-1 px-2 font-mono text-[10px] border-b border-r border-slate-200 sticky left-[40px] z-10 bg-inherit">
                          {row.code}.{String(idx + 1).padStart(3, '0')}
                        </td>
                        <td className="py-1 px-3 border-b border-r border-slate-200 sticky left-[150px] z-10 bg-inherit pl-12 truncate">
                          <span className="text-blue-500 mr-1 font-bold">↳</span>
                          {tL6.task_name}
                        </td>
                        <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[410px] z-10 bg-inherit text-slate-400 font-mono">
                          -
                        </td>
                        <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[520px] z-10 bg-inherit font-mono text-emerald-600">
                          {formatPercent(tL6.measured_pct)}
                        </td>
                        <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[600px] z-10 bg-inherit font-mono text-slate-400">
                          -
                        </td>
                        <td className="py-1 px-2 text-right border-b border-r border-slate-200 sticky left-[710px] z-10 bg-inherit font-mono text-slate-400">
                          -
                        </td>

                        {calcResult.cycles.map((cy) => {
                          const v = tL6.monthly_measurements?.[String(cy.num)] || 0;
                          return (
                            <td key={cy.num} className="py-1 px-2 text-right border-b border-r border-slate-200 font-mono text-slate-500">
                              {v > 0 ? formatPercent(v) : '-'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* =====================================================================
          MODAL DE CRIAÇÃO DE NOVA VERSÃO DE CRONOGRAMA
         ===================================================================== */}
      {isNewVersionModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200 space-y-4">
            {versionsError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{versionsError}</p>}
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-black text-slate-900 text-sm uppercase tracking-wider flex items-center gap-1.5">
                <span>💾</span> Congelar Nova Versão do Cronograma
              </h3>
              <button
                onClick={() => setIsNewVersionModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="font-bold text-slate-700 block mb-1">Nome da Versão:</label>
                <input
                  type="text"
                  value={newVersionName}
                  onChange={(e) => setNewVersionName(e.target.value)}
                  placeholder={`Ex: Revisão 0${versions.length + 1} - Reprogramação`}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 font-medium outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="font-bold text-slate-700 block mb-1">Descrição / Justificativa:</label>
                <textarea
                  value={newVersionDesc}
                  onChange={(e) => setNewVersionDesc(e.target.value)}
                  rows={3}
                  placeholder="Ex: Ajuste de ritmo das fundações após atraso de chuvas..."
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 font-medium outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                />
              </div>

              <label className="flex items-center gap-2 p-3 bg-amber-50 rounded-xl border border-amber-200 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={newVersionIsBaseline}
                  onChange={(e) => setNewVersionIsBaseline(e.target.checked)}
                  className="w-4 h-4 rounded text-amber-600 focus:ring-0 cursor-pointer"
                />
                <div>
                  <span className="font-bold text-amber-900 block">Definir como Nova Linha de Base Oficial</span>
                  <span className="text-[11px] text-amber-700">
                    A Curva S e as comparações na Linha de Balanço passarão a utilizar esta versão como referência zero.
                  </span>
                </div>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                onClick={() => setIsNewVersionModalOpen(false)}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-bold text-xs"
              >
                Cancelar
              </button>
              <button
                disabled={versionsBusy}
                onClick={handleCreateVersion}
                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs shadow-md transition"
              >
                Salvar Versão
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
