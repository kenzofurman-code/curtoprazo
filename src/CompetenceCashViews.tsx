import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { BudgetItem } from './budgetLinking';
import type { PhysicalFinancialCalculationResult } from './physicalFinancialEngine';
import {
  computeCompetenceAndCashflow,
  loadCurvasConfig,
  saveCurvasConfig,
  exportCurvasConfigExcel,
  parseCurvasConfigExcelFile,
  type StageCurveConfig,
  type ProjectCurveParams,
  type CompetenceCashResult,
  type CompetenceCashRow,
  DEFAULT_PROJECT_PARAMS,
} from './competenceCashEngine';

interface CompetenceCashViewsProps {
  projectId: string;
  budgetItems: BudgetItem[];
  calcResult: PhysicalFinancialCalculationResult;
}

export type CompetenceCashTabType = 'comparativo' | 'competencia' | 'caixa';
export type ViewValueMode = 'val' | 'mat' | 'mo' | 'pct';

function formatCurrencyBRL(val?: number): string {
  if (val === undefined || isNaN(val)) return 'R$ 0,00';
  return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatPercent(val?: number, decimals = 2): string {
  if (val === undefined || isNaN(val)) return '0,00%';
  return `${val.toFixed(decimals).replace('.', ',')}%`;
}

export const CompetenceCashViews: React.FC<CompetenceCashViewsProps> = ({
  projectId,
  budgetItems,
  calcResult,
}) => {
  // Navegação de Sub-Abas
  const [activeTab, setActiveTab] = useState<CompetenceCashTabType>('comparativo');

  // Filtros de Tabela
  const [levelFilter, setLevelFilter] = useState<number>(3); // Padrão: até N3
  const [viewMode, setViewMode] = useState<ViewValueMode>('val');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [chartMode, setChartMode] = useState<'accum_pct' | 'month_val' | 'accum_val'>('accum_pct');
  const [sourceCurve, setSourceCurve] = useState<'replan' | 'baseline'>('replan');

  // Parâmetros Gerais e Configurações por Etapa
  const [projectParams, setProjectParams] = useState<ProjectCurveParams>(DEFAULT_PROJECT_PARAMS);
  const [stageConfigs, setStageConfigs] = useState<Record<string, StageCurveConfig>>(() =>
    loadCurvasConfig(projectId, budgetItems, DEFAULT_PROJECT_PARAMS)
  );

  // Modal de Configuração
  const [isConfigModalOpen, setIsConfigModalOpen] = useState<boolean>(false);
  const [configModalTab, setConfigModalTab] = useState<'etapas' | 'geral'>('etapas');
  const [editingConfigs, setEditingConfigs] = useState<Record<string, StageCurveConfig>>({});
  const [editingParams, setEditingParams] = useState<ProjectCurveParams>(DEFAULT_PROJECT_PARAMS);
  const [configSearch, setConfigSearch] = useState<string>('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Atualiza configurações quando o projeto muda
  useEffect(() => {
    const loaded = loadCurvasConfig(projectId, budgetItems, projectParams);
    setStageConfigs(loaded);
  }, [projectId, budgetItems]);

  // Escolhe a curva físico-financeira base (Replanejada ou Baseline Inicial)
  const baseFfRows = useMemo(() => {
    if (sourceCurve === 'baseline') {
      return calcResult.tabFisicoFinanceiro;
    }
    return calcResult.tabFfReplanejado && calcResult.tabFfReplanejado.length > 0
      ? calcResult.tabFfReplanejado
      : calcResult.tabFisicoFinanceiro;
  }, [sourceCurve, calcResult]);

  // Executa o cálculo central de Competência e Caixa
  const curvesResult: CompetenceCashResult = useMemo(() => {
    return computeCompetenceAndCashflow({
      budgetItems,
      tabFfRows: baseFfRows,
      cycles: calcResult.cycles,
      totalProjBudget: calcResult.totalBudget,
      stageConfigs,
      paramsObra: projectParams,
      cycleStartDay: calcResult.cycleConfig.startDay,
      cycleEndDay: calcResult.cycleConfig.endDay,
    });
  }, [budgetItems, baseFfRows, calcResult, stageConfigs, projectParams]);

  // Abre Modal de Configuração clonando o estado atual
  const handleOpenConfigModal = () => {
    setEditingConfigs(JSON.parse(JSON.stringify(stageConfigs)));
    setEditingParams({ ...projectParams });
    setIsConfigModalOpen(true);
  };

  // Salva configurações do Modal
  const handleSaveConfigs = () => {
    saveCurvasConfig(projectId, editingConfigs);
    setStageConfigs(editingConfigs);
    setProjectParams(editingParams);
    setIsConfigModalOpen(false);
  };

  // Restaura configurações para o padrão
  const handleResetToDefault = () => {
    const fresh = loadCurvasConfig(projectId, budgetItems, DEFAULT_PROJECT_PARAMS);
    setEditingConfigs(fresh);
    setEditingParams(DEFAULT_PROJECT_PARAMS);
  };

  // Exportar Excel
  const handleExportExcel = () => {
    exportCurvasConfigExcel(Object.values(stageConfigs));
  };

  // Importar Excel
  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await parseCurvasConfigExcelFile(file);
      const merged = { ...stageConfigs, ...imported };
      saveCurvasConfig(projectId, merged);
      setStageConfigs(merged);
      alert('Configurações importadas do Excel com sucesso!');
    } catch (err) {
      console.error(err);
      alert('Erro ao processar arquivo Excel. Verifique a formatação das colunas.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Atualiza um campo de etapa no modal
  const handleStageConfigChange = (code: string, field: keyof StageCurveConfig, value: any) => {
    setEditingConfigs((prev) => {
      const curr = prev[code] || {
        code,
        description: '',
        level: code.split('.').length,
        material_pct: 60,
        labor_pct: 40,
        anticipation_days: 15,
        distribution_type: 'continuo',
        payment_terms: '28',
        labor_payment_day: 5,
        is_custom: true,
      };

      const updated = { ...curr, [field]: value, is_custom: true, source: 'Personalizado' };

      // Se mudar Material %, ajusta MO % automaticamente para somar 100%
      if (field === 'material_pct') {
        const mat = Math.max(0, Math.min(100, Number(value) || 0));
        updated.material_pct = mat;
        updated.labor_pct = Math.max(0, 100 - mat);
      } else if (field === 'labor_pct') {
        const mo = Math.max(0, Math.min(100, Number(value) || 0));
        updated.labor_pct = mo;
        updated.material_pct = Math.max(0, 100 - mo);
      }

      return { ...prev, [code]: updated };
    });
  };

  // Linhas filtradas para a tabela de Competência ou Caixa
  const activeTableRows = useMemo(() => {
    const rows = activeTab === 'caixa' ? curvesResult.tabFinanceiro : curvesResult.tabCompetencia;
    return rows.filter((row) => {
      if (levelFilter > 0 && row.level > levelFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const mCode = row.code.toLowerCase().includes(q);
        const mDesc = row.description.toLowerCase().includes(q);
        if (!mCode && !mDesc) return false;
      }
      return true;
    });
  }, [activeTab, curvesResult, levelFilter, searchQuery]);

  // Linha Nível 1 Totalizadora
  const level1CompRow = useMemo(() => {
    return curvesResult.tabCompetencia.find((r) => r.level === 1) || curvesResult.tabCompetencia[0];
  }, [curvesResult]);

  const level1FinRow = useMemo(() => {
    return curvesResult.tabFinanceiro.find((r) => r.level === 1) || curvesResult.tabFinanceiro[0];
  }, [curvesResult]);

  // Helper para obter valor da célula conforme viewMode
  const getCellValue = (row: CompetenceCashRow, cycleNum: number): string => {
    const cKey = String(cycleNum);
    if (viewMode === 'mat') {
      const v = row.cycle_mat_vals?.[cKey] || 0;
      return v > 0 ? formatCurrencyBRL(v) : '-';
    }
    if (viewMode === 'mo') {
      const v = row.cycle_mo_vals?.[cKey] || 0;
      return v > 0 ? formatCurrencyBRL(v) : '-';
    }
    if (viewMode === 'pct') {
      const p = row.cycle_pcts?.[cKey] || 0;
      return p > 0 ? formatPercent(p) : '-';
    }
    const val = row.cycle_vals?.[cKey] || 0;
    return val > 0 ? formatCurrencyBRL(val) : '-';
  };

  // Helper para total da linha conforme viewMode
  const getCellTotal = (row: CompetenceCashRow): string => {
    if (viewMode === 'mat') return formatCurrencyBRL(row.total_mat);
    if (viewMode === 'mo') return formatCurrencyBRL(row.total_mo);
    if (viewMode === 'pct') return formatPercent(row.total_pct);
    return formatCurrencyBRL(row.total);
  };

  // Classes visuais por nível da EAP
  const getRowLevelClass = (level: number) => {
    if (level === 1) return 'bg-slate-900 text-white font-black';
    if (level === 2) return 'bg-slate-100 font-extrabold text-slate-900 hover:bg-slate-200/80';
    if (level === 3) return 'bg-slate-50/70 font-bold text-slate-800 hover:bg-slate-100';
    if (level === 4) return 'bg-white font-medium text-slate-700 hover:bg-slate-50';
    return 'bg-white text-slate-600 hover:bg-slate-50';
  };

  // Dados para o Gráfico das Curvas S
  const chartCycles = curvesResult.extendedCycles;
  const sData = curvesResult.sCurvesComparison;

  // Renderização do gráfico SVG
  const renderSVGChart = () => {
    if (!chartCycles || chartCycles.length === 0) return null;

    const width = 1000;
    const height = 360;
    const padding = { top: 25, right: 30, bottom: 45, left: 75 };

    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    let seriesFis: number[] = [];
    let seriesComp: number[] = [];
    let seriesFin: number[] = [];
    let yMax = 100;

    if (chartMode === 'accum_pct') {
      seriesFis = sData.fis_accum_pcts;
      seriesComp = sData.comp_accum_pcts;
      seriesFin = sData.fin_accum_pcts;
      yMax = Math.max(105, ...seriesFis, ...seriesComp, ...seriesFin);
    } else if (chartMode === 'month_val') {
      seriesFis = sData.fis_month_vals;
      seriesComp = sData.comp_month_vals;
      seriesFin = sData.fin_month_vals;
      yMax = Math.max(1, ...seriesFis, ...seriesComp, ...seriesFin) * 1.15;
    } else {
      seriesFis = sData.fis_accum_vals;
      seriesComp = sData.comp_accum_vals;
      seriesFin = sData.fin_accum_vals;
      yMax = Math.max(1, ...seriesFis, ...seriesComp, ...seriesFin) * 1.05;
    }

    const n = chartCycles.length;
    const getX = (i: number) => padding.left + (i / Math.max(1, n - 1)) * plotW;
    const getY = (val: number) => padding.top + plotH - (val / yMax) * plotH;

    const makePath = (series: number[]) => {
      return series
        .map((v, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(v).toFixed(1)}`)
        .join(' ');
    };

    const pathFis = makePath(seriesFis);
    const pathComp = makePath(seriesComp);
    const pathFin = makePath(seriesFin);

    // Linhas de Grade Y
    const yTicks = [0, 0.25, 0.5, 0.75, 1.0];

    return (
      <div className="w-full overflow-x-auto bg-slate-900 rounded-2xl p-4 shadow-inner">
        <div className="min-w-[750px]">
          <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
            {/* Grid Horizontal */}
            {yTicks.map((tick, idx) => {
              const yVal = tick * yMax;
              const yPos = getY(yVal);
              return (
                <g key={idx}>
                  <line
                    x1={padding.left}
                    y1={yPos}
                    x2={width - padding.right}
                    y2={yPos}
                    stroke="#334155"
                    strokeDasharray="4 4"
                    strokeWidth="1"
                  />
                  <text
                    x={padding.left - 8}
                    y={yPos + 4}
                    fill="#94a3b8"
                    fontSize="11"
                    fontFamily="monospace"
                    textAnchor="end"
                  >
                    {chartMode === 'accum_pct'
                      ? `${Math.round(yVal)}%`
                      : formatCurrencyBRL(yVal).replace('R$', '').trim()}
                  </text>
                </g>
              );
            })}

            {/* Grid Vertical e Labels dos Meses */}
            {chartCycles.map((c, i) => {
              const xPos = getX(i);
              return (
                <g key={c.num}>
                  <line
                    x1={xPos}
                    y1={padding.top}
                    x2={xPos}
                    y2={padding.top + plotH}
                    stroke="#1e293b"
                    strokeWidth="1"
                  />
                  <text
                    x={xPos}
                    y={height - padding.bottom + 20}
                    fill="#cbd5e1"
                    fontSize="10"
                    fontWeight="bold"
                    textAnchor="middle"
                  >
                    {c.period_label}
                  </text>
                </g>
              );
            })}

            {/* Curva 1: Físico-Financeiro (Azul) */}
            <path
              d={pathFis}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {seriesFis.map((v, i) => (
              <circle
                key={`fis-${i}`}
                cx={getX(i)}
                cy={getY(v)}
                r="4.5"
                fill="#0284c7"
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            ))}

            {/* Curva 2: Competência Teórica (Laranja/Âmbar) */}
            <path
              d={pathComp}
              fill="none"
              stroke="#fbbf24"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {seriesComp.map((v, i) => (
              <circle
                key={`comp-${i}`}
                cx={getX(i)}
                cy={getY(v)}
                r="4.5"
                fill="#d97706"
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            ))}

            {/* Curva 3: Caixa Teórico (Esmeralda/Verde) */}
            <path
              d={pathFin}
              fill="none"
              stroke="#34d399"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {seriesFin.map((v, i) => (
              <circle
                key={`fin-${i}`}
                cx={getX(i)}
                cy={getY(v)}
                r="4.5"
                fill="#059669"
                stroke="#ffffff"
                strokeWidth="1.5"
              />
            ))}
          </svg>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden flex flex-col min-h-[750px] animate-in fade-in duration-200">
      {/* =====================================================================
          HEADER PRINCIPAL
         ===================================================================== */}
      <div className="p-4 bg-slate-900 text-white border-b border-slate-800 flex flex-col gap-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">💵</span>
              <h2 className="text-sm font-black uppercase tracking-wider text-white">
                Competência & Caixa Teóricos
              </h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Visão Contábil (NF)
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                Visão Fluxo de Caixa
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Conversão matemática rigorosa da curva físico-financeira em emissão de notas fiscais (competência) e desembolso efetivo (fluxo de caixa).
            </p>
          </div>

          {/* BOTÕES DE AÇÃO SUPERIORES */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Seletor da Curva Base */}
            <div className="flex items-center bg-slate-800 p-1 rounded-xl border border-slate-700 text-xs">
              <span className="text-slate-400 font-bold px-1.5 uppercase text-[10px]">Base:</span>
              <button
                onClick={() => setSourceCurve('replan')}
                className={`px-2.5 py-1 rounded-lg font-bold transition ${
                  sourceCurve === 'replan'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Replanejado
              </button>
              <button
                onClick={() => setSourceCurve('baseline')}
                className={`px-2.5 py-1 rounded-lg font-bold transition ${
                  sourceCurve === 'baseline'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Inicial
              </button>
            </div>

            {/* Botão Configurar Prazos & Insumos */}
            <button
              onClick={handleOpenConfigModal}
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold px-3 py-2 rounded-xl border border-slate-700 transition cursor-pointer shadow-sm"
            >
              <span>⚙️</span>
              <span>Premissas & Prazos</span>
            </button>

            {/* Exportar Excel */}
            <button
              onClick={handleExportExcel}
              title="Baixar planilha Excel com parâmetros da EAP"
              className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold px-2.5 py-2 rounded-xl border border-slate-700 transition cursor-pointer"
            >
              <span>📥</span>
              <span className="hidden sm:inline">Exportar Excel</span>
            </button>

            {/* Importar Excel */}
            <label
              title="Importar parâmetros de prazos e insumos via Excel"
              className="flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold px-2.5 py-2 rounded-xl transition cursor-pointer shadow-sm"
            >
              <span>📤</span>
              <span className="hidden sm:inline">Importar Excel</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={handleImportExcel}
              />
            </label>
          </div>
        </div>

        {/* NAVEGAÇÃO DE SUB-ABAS */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
          <div className="flex items-center gap-1 bg-slate-800/90 p-1 rounded-xl border border-slate-700">
            <button
              onClick={() => setActiveTab('comparativo')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'comparativo'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <span>📊</span> Comparativo & Curva S Tríplice
            </button>

            <button
              onClick={() => setActiveTab('competencia')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'competencia'
                  ? 'bg-amber-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <span>📑</span> Competência Teórica (Contábil / NF)
            </button>

            <button
              onClick={() => setActiveTab('caixa')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 cursor-pointer ${
                activeTab === 'caixa'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              <span>💵</span> Caixa Teórico (Desembolso & Fluxo)
            </button>
          </div>

          {/* TOTALIZADORES RESUMIDOS */}
          <div className="flex items-center gap-4 text-xs font-mono">
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-slate-400 font-sans uppercase">Orçamento Fechado</span>
              <span className="font-bold text-slate-200">{formatCurrencyBRL(calcResult.totalBudget)}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-amber-400 font-sans uppercase">Competência Total</span>
              <span className="font-bold text-amber-300">{formatCurrencyBRL(curvesResult.kpis.totalCompetence)}</span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-emerald-400 font-sans uppercase">Caixa Total</span>
              <span className="font-bold text-emerald-300">{formatCurrencyBRL(curvesResult.kpis.totalCashflow)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          CARDS DE KPIS GERAIS
         ===================================================================== */}
      <div className="p-4 bg-slate-50 border-b border-slate-200 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-[10px] font-bold uppercase text-slate-400 block truncate">Orçamento EAP</span>
          <div className="text-base font-black text-slate-800 mt-0.5">{formatCurrencyBRL(calcResult.totalBudget)}</div>
          <span className="text-[10px] text-slate-500">100% da base física</span>
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-[10px] font-bold uppercase text-amber-600 block truncate">Competência Teórica</span>
          <div className="text-base font-black text-amber-700 mt-0.5">{formatCurrencyBRL(curvesResult.kpis.totalCompetence)}</div>
          <span className="text-[10px] text-amber-600">
            Mat: {formatCurrencyBRL(curvesResult.kpis.totalMaterialComp)} | MO: {formatCurrencyBRL(curvesResult.kpis.totalLaborComp)}
          </span>
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-[10px] font-bold uppercase text-emerald-600 block truncate">Caixa Teórico</span>
          <div className="text-base font-black text-emerald-700 mt-0.5">{formatCurrencyBRL(curvesResult.kpis.totalCashflow)}</div>
          <span className="text-[10px] text-emerald-600">
            Mat: {formatCurrencyBRL(curvesResult.kpis.totalMaterialFin)} | MO: {formatCurrencyBRL(curvesResult.kpis.totalLaborFin)}
          </span>
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-[10px] font-bold uppercase text-indigo-600 block truncate">Pico de Desembolso</span>
          <div className="text-base font-black text-indigo-700 mt-0.5">
            {formatCurrencyBRL(curvesResult.kpis.peakMonthlyCash.value)}
          </div>
          <span className="text-[10px] text-indigo-500">Mês: {curvesResult.kpis.peakMonthlyCash.cycleName}</span>
        </div>

        <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-[10px] font-bold uppercase text-slate-500 block truncate">Defasagem Média de Caixa</span>
          <div className="text-base font-black text-slate-800 mt-0.5">{curvesResult.kpis.averageCashLagDays} dias</div>
          <span className="text-[10px] text-slate-500">Físico vs Saída Financeira</span>
        </div>
      </div>

      {/* =====================================================================
          CONTEÚDO DA SUB-ABA 1: COMPARATIVO & CURVA S TRÍPLICE
         ===================================================================== */}
      {activeTab === 'comparativo' && (
        <div className="p-4 space-y-6 flex-1">
          {/* Controles do Gráfico */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3 rounded-xl border border-slate-200">
            <div className="flex items-center gap-4">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">
                Modo de Visualização do Gráfico:
              </span>
              <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
                <button
                  onClick={() => setChartMode('accum_pct')}
                  className={`px-3 py-1 rounded-md font-bold transition cursor-pointer ${
                    chartMode === 'accum_pct' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  % Acumulada
                </button>
                <button
                  onClick={() => setChartMode('month_val')}
                  className={`px-3 py-1 rounded-md font-bold transition cursor-pointer ${
                    chartMode === 'month_val' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  R$ Mensal
                </button>
                <button
                  onClick={() => setChartMode('accum_val')}
                  className={`px-3 py-1 rounded-md font-bold transition cursor-pointer ${
                    chartMode === 'accum_val' ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  R$ Acumulado
                </button>
              </div>
            </div>

            {/* Legenda do Gráfico */}
            <div className="flex flex-wrap items-center gap-4 text-xs font-bold">
              <div className="flex items-center gap-1.5">
                <span className="w-3.5 h-3.5 rounded-full bg-sky-400 border border-sky-600"></span>
                <span className="text-slate-700">Físico-Financeiro (Execução)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3.5 h-3.5 rounded-full bg-amber-400 border border-amber-600"></span>
                <span className="text-slate-700">Competência Teórica (NF)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3.5 h-3.5 rounded-full bg-emerald-400 border border-emerald-600"></span>
                <span className="text-slate-700">Caixa Teórico (Desembolso)</span>
              </div>
            </div>
          </div>

          {/* SVG Chart */}
          {renderSVGChart()}

          {/* Tabela Comparativa Mensal Tríplice */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
            <div className="p-3 bg-slate-800 text-white text-xs font-bold uppercase tracking-wider flex items-center justify-between">
              <span>Demonstrativo Mensal das Três Curvas (Físico x Competência x Caixa)</span>
              <span className="text-slate-400 font-normal">Valores em Reais (R$) e % Acumulado</span>
            </div>

            <div className="overflow-x-auto max-h-[450px]">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-100 text-slate-700 sticky top-0 z-10 border-b border-slate-300">
                  <tr>
                    <th className="py-2 px-3 font-bold border-r border-slate-200">Período / Ciclo</th>
                    <th className="py-2 px-3 text-right font-bold text-sky-800 border-r border-slate-200">Físico Mensal (R$)</th>
                    <th className="py-2 px-3 text-right font-bold text-sky-800 border-r border-slate-200">Físico Acum. (%)</th>
                    <th className="py-2 px-3 text-right font-bold text-amber-800 border-r border-slate-200">Competência Mensal (R$)</th>
                    <th className="py-2 px-3 text-right font-bold text-amber-800 border-r border-slate-200">Competência Acum. (%)</th>
                    <th className="py-2 px-3 text-right font-bold text-emerald-800 border-r border-slate-200">Caixa Mensal (R$)</th>
                    <th className="py-2 px-3 text-right font-bold text-emerald-800 border-r border-slate-200">Caixa Acum. (%)</th>
                    <th className="py-2 px-3 text-right font-bold text-indigo-800">Diferença Caixa - Comp (R$)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 font-mono">
                  {chartCycles.map((c, i) => {
                    const fisM = sData.fis_month_vals[i] || 0;
                    const fisAccPct = sData.fis_accum_pcts[i] || 0;
                    const compM = sData.comp_month_vals[i] || 0;
                    const compAccPct = sData.comp_accum_pcts[i] || 0;
                    const finM = sData.fin_month_vals[i] || 0;
                    const finAccPct = sData.fin_accum_pcts[i] || 0;
                    const diff = finM - compM;

                    return (
                      <tr key={c.num} className="hover:bg-slate-50 transition">
                        <td className="py-2 px-3 font-sans font-bold text-slate-800 border-r border-slate-200">
                          {c.full_label}
                        </td>
                        <td className="py-2 px-3 text-right text-sky-950 font-semibold border-r border-slate-200">
                          {formatCurrencyBRL(fisM)}
                        </td>
                        <td className="py-2 px-3 text-right text-sky-800 font-bold border-r border-slate-200">
                          {formatPercent(fisAccPct)}
                        </td>
                        <td className="py-2 px-3 text-right text-amber-950 font-semibold border-r border-slate-200">
                          {formatCurrencyBRL(compM)}
                        </td>
                        <td className="py-2 px-3 text-right text-amber-800 font-bold border-r border-slate-200">
                          {formatPercent(compAccPct)}
                        </td>
                        <td className="py-2 px-3 text-right text-emerald-950 font-semibold border-r border-slate-200">
                          {formatCurrencyBRL(finM)}
                        </td>
                        <td className="py-2 px-3 text-right text-emerald-800 font-bold border-r border-slate-200">
                          {formatPercent(finAccPct)}
                        </td>
                        <td
                          className={`py-2 px-3 text-right font-bold ${
                            diff > 0 ? 'text-amber-700' : diff < 0 ? 'text-emerald-700' : 'text-slate-400'
                          }`}
                        >
                          {formatCurrencyBRL(diff)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          CONTEÚDO DAS SUB-ABAS 2 E 3: TABELAS MULTINÍVEIS (COMPETÊNCIA E CAIXA)
         ===================================================================== */}
      {(activeTab === 'competencia' || activeTab === 'caixa') && (
        <div className="p-4 space-y-4 flex-1 flex flex-col">
          {/* Barra de Filtros e Visualização */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-2.5 rounded-xl border border-slate-200 text-xs">
            {/* Filtro de Nível */}
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-[11px] font-bold">
              <span className="text-[10px] text-slate-400 px-1 uppercase">Nível:</span>
              <button
                onClick={() => setLevelFilter(2)}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  levelFilter === 2 ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Até N2
              </button>
              <button
                onClick={() => setLevelFilter(3)}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  levelFilter === 3 ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Até N3 (Padrão)
              </button>
              <button
                onClick={() => setLevelFilter(4)}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  levelFilter === 4 ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Até N4
              </button>
              <button
                onClick={() => setLevelFilter(0)}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  levelFilter === 0 ? 'bg-indigo-600 text-white shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Todos
              </button>
            </div>

            {/* Modo de Visualização do Valor */}
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-[11px] font-bold">
              <button
                onClick={() => setViewMode('val')}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  viewMode === 'val' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                R$ Total
              </button>
              <button
                onClick={() => setViewMode('mat')}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  viewMode === 'mat' ? 'bg-white text-amber-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                R$ Material
              </button>
              <button
                onClick={() => setViewMode('mo')}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  viewMode === 'mo' ? 'bg-white text-emerald-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                R$ Mão de Obra
              </button>
              <button
                onClick={() => setViewMode('pct')}
                className={`px-2 py-0.5 rounded transition cursor-pointer ${
                  viewMode === 'pct' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                % Obra
              </button>
            </div>

            {/* Campo de Busca */}
            <div className="flex items-center gap-1.5 flex-1 max-w-xs">
              <input
                type="text"
                placeholder="Filtrar código ou etapa..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1 text-xs outline-none focus:border-indigo-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-slate-400 hover:text-slate-600 text-xs px-1"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Tabela EAP Multinível */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden flex-1">
            <div className="overflow-x-auto max-h-[600px] 2xl:max-h-[720px]">
              <table className="w-full text-left text-xs border-separate border-spacing-0">
                <thead className="bg-slate-900 text-white sticky top-0 z-30">
                  <tr className="h-9">
                    <th className="py-1 px-2 w-10 text-center border-b border-r border-slate-800 sticky left-0 z-40 bg-slate-900">
                      Nív
                    </th>
                    <th className="py-1 px-2 w-28 border-b border-r border-slate-800 sticky left-[40px] z-40 bg-slate-900 font-mono">
                      Código
                    </th>
                    <th className="py-1 px-3 min-w-[280px] max-w-[320px] border-b border-r border-slate-800 sticky left-[152px] z-40 bg-slate-900">
                      Descrição EAP
                    </th>
                    <th className="py-1 px-2 w-28 text-right border-b border-r border-slate-800 sticky left-[432px] z-40 bg-slate-900 font-mono">
                      Orçamento
                    </th>
                    <th className="py-1 px-2 w-20 text-right border-b border-r border-slate-800 sticky left-[544px] z-40 bg-slate-900 text-emerald-400 font-mono shadow-md">
                      % Obra
                    </th>

                    {/* Colunas Mensais dos Ciclos */}
                    {chartCycles.map((c) => (
                      <th
                        key={c.num}
                        className="py-1 px-2 text-right min-w-[95px] border-b border-r border-slate-800 bg-slate-900 font-sans"
                      >
                        <span className="block font-bold">{c.period_label}</span>
                        <span className="text-[9px] text-slate-400 block font-normal">
                          {viewMode === 'pct' ? '%' : 'R$'}
                        </span>
                      </th>
                    ))}

                    <th className="py-1 px-3 text-right min-w-[110px] bg-slate-800 border-b border-slate-800 sticky right-0 z-20">
                      Total
                    </th>
                  </tr>

                  {/* Linha Pinned Nível 1 Totalizador */}
                  {(() => {
                    const r1 = activeTab === 'caixa' ? level1FinRow : level1CompRow;
                    if (!r1) return null;
                    return (
                      <tr className="bg-black text-white font-black sticky top-[36px] z-30 shadow-md">
                        <td className="py-1 px-2 text-center border-b border-r border-slate-800 sticky left-0 z-40 bg-black">
                          1
                        </td>
                        <td className="py-1 px-2 font-mono text-[11px] border-b border-r border-slate-800 sticky left-[40px] z-40 bg-black">
                          {r1.code}
                        </td>
                        <td className="py-1 px-3 border-b border-r border-slate-800 sticky left-[152px] z-40 bg-black truncate">
                          {r1.description || 'Total Geral da Obra'}
                        </td>
                        <td className="py-1 px-2 text-right border-b border-r border-slate-800 sticky left-[432px] z-40 bg-black font-mono">
                          {formatCurrencyBRL(r1.budget)}
                        </td>
                        <td className="py-1 px-2 text-right border-b border-r border-slate-800 sticky left-[544px] z-40 bg-black font-mono text-emerald-300 shadow-md">
                          100,00%
                        </td>

                        {chartCycles.map((c) => (
                          <td
                            key={c.num}
                            className="py-1 px-2 text-right border-b border-r border-slate-800 font-mono text-white"
                          >
                            {getCellValue(r1, c.num)}
                          </td>
                        ))}

                        <td className="py-1 px-3 text-right border-b border-slate-800 bg-slate-900 font-mono text-amber-300 sticky right-0 z-20">
                          {getCellTotal(r1)}
                        </td>
                      </tr>
                    );
                  })()}
                </thead>

                <tbody className="divide-y divide-slate-200">
                  {activeTableRows.map((row) => (
                    <tr key={row.code} className={getRowLevelClass(row.level)}>
                      <td
                        className={`py-1 px-2 text-center border-b border-r sticky left-0 z-10 ${
                          row.level <= 2 ? 'bg-slate-100 font-bold' : 'bg-white'
                        }`}
                      >
                        {row.level}
                      </td>
                      <td
                        className={`py-1 px-2 font-mono text-[11px] border-b border-r sticky left-[40px] z-10 ${
                          row.level <= 2 ? 'bg-slate-100 font-bold' : 'bg-white'
                        }`}
                      >
                        {row.code}
                      </td>
                      <td
                        className={`py-1 px-3 border-b border-r sticky left-[152px] z-10 truncate ${
                          row.level <= 2 ? 'bg-slate-100 font-bold' : 'bg-white'
                        }`}
                        style={{ paddingLeft: `${(row.level - 1) * 12 + 8}px` }}
                        title={row.description}
                      >
                        {row.description}
                      </td>
                      <td
                        className={`py-1 px-2 text-right border-b border-r font-mono font-semibold sticky left-[432px] z-10 ${
                          row.level <= 2 ? 'bg-slate-100' : 'bg-white'
                        }`}
                      >
                        {formatCurrencyBRL(row.budget)}
                      </td>
                      <td
                        className={`py-1 px-2 text-right border-b border-r font-mono font-bold sticky left-[544px] z-10 shadow-sm ${
                          row.level <= 2
                            ? 'bg-slate-100 text-emerald-800'
                            : 'bg-white text-indigo-700'
                        }`}
                      >
                        {formatPercent(row.budget_pct)}
                      </td>

                      {/* Valores Mensais */}
                      {chartCycles.map((c) => (
                        <td
                          key={c.num}
                          className="py-1 px-2 text-right border-b border-r font-mono text-[11px]"
                        >
                          {getCellValue(row, c.num)}
                        </td>
                      ))}

                      <td className="py-1 px-3 text-right font-mono font-bold border-b text-indigo-900 bg-slate-50 sticky right-0 z-10">
                        {getCellTotal(row)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL DE CONFIGURAÇÃO DE PRAZOS, INSUMOS & ENTREGAS POR ETAPA
         ===================================================================== */}
      {isConfigModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">
            {/* Header do Modal */}
            <div className="px-6 py-4 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-white shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-xl">⚙️</span>
                <div>
                  <h3 className="font-bold text-sm tracking-wide">
                    Configuração de Prazos, Insumos & Entregas por Etapa (EAP)
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Parametrize Material vs Mão de Obra e prazos. As definições no Nível 2 propagam automaticamente para os subníveis por herança.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleExportExcel}
                  className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold px-3 py-1.5 rounded-lg border border-slate-700 transition"
                >
                  <span>📥</span> Modelo Excel
                </button>
                <button
                  onClick={() => setIsConfigModalOpen(false)}
                  className="w-8 h-8 rounded-lg hover:bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white transition cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Sub-abas do Modal */}
            <div className="px-6 pt-2 bg-slate-100 border-b border-slate-200 flex space-x-2 shrink-0 text-xs">
              <button
                onClick={() => setConfigModalTab('etapas')}
                className={`px-4 py-2 border-b-2 font-bold transition rounded-t-lg cursor-pointer ${
                  configModalTab === 'etapas'
                    ? 'border-indigo-600 text-indigo-600 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                1. Configuração por Etapa (EAP)
              </button>
              <button
                onClick={() => setConfigModalTab('geral')}
                className={`px-4 py-2 border-b-2 font-bold transition rounded-t-lg cursor-pointer ${
                  configModalTab === 'geral'
                    ? 'border-indigo-600 text-indigo-600 bg-white'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                2. Parâmetros Gerais da Obra
              </button>
            </div>

            {/* CONTEÚDO DO MODAL: ABA 1 - ETAPAS */}
            {configModalTab === 'etapas' && (
              <div className="p-4 overflow-y-auto flex-1 flex flex-col space-y-3 text-xs">
                {/* Barra de Busca de Etapas */}
                <div className="flex items-center justify-between gap-3">
                  <input
                    type="text"
                    placeholder="Filtrar por código ou descrição da etapa..."
                    value={configSearch}
                    onChange={(e) => setConfigSearch(e.target.value)}
                    className="w-80 bg-slate-50 border border-slate-300 rounded-lg px-3 py-1.5 text-xs outline-none focus:border-indigo-500 font-medium"
                  />
                  <button
                    onClick={handleResetToDefault}
                    className="text-xs text-rose-600 hover:text-rose-800 font-bold underline cursor-pointer"
                  >
                    Restaurar Padrão Geral da Obra
                  </button>
                </div>

                {/* Tabela de Parametrização */}
                <div className="border border-slate-200 rounded-xl overflow-hidden flex-1 max-h-[500px] overflow-y-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="bg-slate-900 text-white sticky top-0 z-20">
                      <tr>
                        <th className="py-2 px-2.5 w-16 text-center border-r border-slate-800">Nível</th>
                        <th className="py-2 px-2.5 w-28 border-r border-slate-800 font-mono">Código</th>
                        <th className="py-2 px-3 min-w-[220px] border-r border-slate-800">Descrição</th>
                        <th className="py-2 px-2.5 w-24 text-center border-r border-slate-800">Material (%)</th>
                        <th className="py-2 px-2.5 w-24 text-center border-r border-slate-800">M.O. (%)</th>
                        <th className="py-2 px-2.5 w-24 text-center border-r border-slate-800">Antecedência (d)</th>
                        <th className="py-2 px-2.5 w-28 text-center border-r border-slate-800">Distribuição</th>
                        <th className="py-2 px-2.5 w-20 text-center border-r border-slate-800">Nº Lotes</th>
                        <th className="py-2 px-2.5 w-28 text-center border-r border-slate-800">Condição Pgto</th>
                        <th className="py-2 px-3 w-32 border-r border-slate-800">Origem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 font-sans">
                      {Object.values(editingConfigs)
                        .filter((cfg) => {
                          if (cfg.code === 'padrao') return false;
                          if (configSearch.trim()) {
                            const q = configSearch.toLowerCase();
                            return (
                              cfg.code.toLowerCase().includes(q) ||
                              cfg.description.toLowerCase().includes(q)
                            );
                          }
                          return true;
                        })
                        .sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }))
                        .map((cfg) => {
                          const lvl = cfg.level || 2;
                          return (
                            <tr
                              key={cfg.code}
                              className={`hover:bg-slate-50 transition ${
                                lvl === 2 ? 'bg-slate-100/70 font-bold' : ''
                              }`}
                            >
                              <td className="py-1.5 px-2.5 text-center border-r border-slate-200">
                                {lvl}
                              </td>
                              <td className="py-1.5 px-2.5 font-mono text-[11px] border-r border-slate-200 font-bold text-slate-800">
                                {cfg.code}
                              </td>
                              <td
                                className="py-1.5 px-3 border-r border-slate-200 truncate max-w-[220px]"
                                style={{ paddingLeft: `${Math.max(0, lvl - 2) * 14 + 12}px` }}
                                title={cfg.description}
                              >
                                {cfg.description}
                              </td>
                              <td className="py-1.5 px-2 text-center border-r border-slate-200">
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  value={cfg.material_pct}
                                  onChange={(e) =>
                                    handleStageConfigChange(cfg.code, 'material_pct', e.target.value)
                                  }
                                  className="w-16 text-center bg-white border border-slate-300 rounded px-1 py-0.5 font-mono font-bold text-amber-700 outline-none focus:border-indigo-500"
                                />
                              </td>
                              <td className="py-1.5 px-2 text-center border-r border-slate-200">
                                <span className="font-mono font-bold text-emerald-700">
                                  {cfg.labor_pct}%
                                </span>
                              </td>
                              <td className="py-1.5 px-2 text-center border-r border-slate-200">
                                <input
                                  type="number"
                                  min="0"
                                  max="120"
                                  value={cfg.anticipation_days}
                                  onChange={(e) =>
                                    handleStageConfigChange(cfg.code, 'anticipation_days', e.target.value)
                                  }
                                  className="w-14 text-center bg-white border border-slate-300 rounded px-1 py-0.5 font-mono outline-none focus:border-indigo-500"
                                />
                              </td>
                              <td className="py-1.5 px-2 text-center border-r border-slate-200">
                                <select
                                  value={cfg.distribution_type}
                                  onChange={(e) =>
                                    handleStageConfigChange(cfg.code, 'distribution_type', e.target.value)
                                  }
                                  className="bg-white border border-slate-300 rounded px-1.5 py-0.5 text-xs outline-none focus:border-indigo-500"
                                >
                                  <option value="continuo">Contínuo</option>
                                  <option value="lotes">Em Lotes</option>
                                </select>
                              </td>
                              <td className="py-1.5 px-2 text-center border-r border-slate-200">
                                {cfg.distribution_type === 'lotes' ? (
                                  <input
                                    type="number"
                                    min="2"
                                    max="24"
                                    value={cfg.num_batches || 3}
                                    onChange={(e) =>
                                      handleStageConfigChange(cfg.code, 'num_batches', e.target.value)
                                    }
                                    className="w-12 text-center bg-white border border-slate-300 rounded px-1 py-0.5 font-mono outline-none focus:border-indigo-500"
                                  />
                                ) : (
                                  <span className="text-slate-400">-</span>
                                )}
                              </td>
                              <td className="py-1.5 px-2 text-center border-r border-slate-200">
                                <input
                                  type="text"
                                  placeholder="28 ou 30/60"
                                  value={cfg.payment_terms}
                                  onChange={(e) =>
                                    handleStageConfigChange(cfg.code, 'payment_terms', e.target.value)
                                  }
                                  className="w-24 text-center bg-white border border-slate-300 rounded px-1 py-0.5 font-mono outline-none focus:border-indigo-500"
                                />
                              </td>
                              <td className="py-1.5 px-3 border-r border-slate-200 text-[10px]">
                                <span
                                  className={`px-1.5 py-0.5 rounded font-bold ${
                                    cfg.is_custom
                                      ? 'bg-indigo-100 text-indigo-800'
                                      : 'bg-slate-100 text-slate-600'
                                  }`}
                                >
                                  {cfg.source || 'Padrão'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* CONTEÚDO DO MODAL: ABA 2 - PARÂMETROS GERAIS DA OBRA */}
            {configModalTab === 'geral' && (
              <div className="p-6 overflow-y-auto flex-1 text-xs space-y-6">
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-start gap-3">
                  <span className="text-xl">ℹ️</span>
                  <div className="text-indigo-950 leading-relaxed">
                    Premissas globais aplicadas às etapas que não possuírem regras personalizadas.
                    A mão de obra segue medição mensal e pagamento até o dia 05 do mês subsequente.
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Card Material */}
                  <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
                    <div className="font-bold text-slate-800 text-xs flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
                      <span>Material: Prazos e Entregas Padrão</span>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 block mb-1">
                          Dias de Antecedência Padrão de Entrega
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            max="180"
                            value={editingParams.dias_antecedencia_padrao}
                            onChange={(e) =>
                              setEditingParams((p) => ({
                                ...p,
                                dias_antecedencia_padrao: Number(e.target.value) || 0,
                              }))
                            }
                            className="w-24 bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-xs font-bold outline-none focus:border-indigo-500"
                          />
                          <span className="text-slate-500 text-[11px]">dias antes do início físico</span>
                        </div>
                      </div>

                      <div>
                        <label className="text-[11px] font-bold text-slate-600 block mb-1">
                          Prazo de Pagamento Padrão de Material
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            max="180"
                            value={editingParams.prazo_pagamento_padrao_dias}
                            onChange={(e) =>
                              setEditingParams((p) => ({
                                ...p,
                                prazo_pagamento_padrao_dias: Number(e.target.value) || 0,
                              }))
                            }
                            className="w-24 bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-xs font-bold outline-none focus:border-indigo-500"
                          />
                          <span className="text-slate-500 text-[11px]">dias corridos após entrega/NF</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Card Mão de Obra */}
                  <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
                    <div className="font-bold text-slate-800 text-xs flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
                      <span>Mão de Obra: Ciclo & Pagamento</span>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className="text-[11px] font-bold text-slate-600 block mb-1">
                          Dia de Corte da Medição de M.O.
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="1"
                            max="31"
                            value={editingParams.dia_corte_medicao_mo}
                            onChange={(e) =>
                              setEditingParams((p) => ({
                                ...p,
                                dia_corte_medicao_mo: Number(e.target.value) || 20,
                              }))
                            }
                            className="w-24 bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-xs font-bold outline-none focus:border-indigo-500"
                          />
                          <span className="text-slate-500 text-[11px]">de 21 a 20 pertence à competência M</span>
                        </div>
                      </div>

                      <div>
                        <label className="text-[11px] font-bold text-slate-600 block mb-1">
                          Dia de Pagamento da M.O. (Mês Subsequente)
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="1"
                            max="31"
                            value={editingParams.dia_pagamento_mo}
                            onChange={(e) =>
                              setEditingParams((p) => ({
                                ...p,
                                dia_pagamento_mo: Number(e.target.value) || 5,
                              }))
                            }
                            className="w-24 bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-xs font-bold outline-none focus:border-indigo-500"
                          />
                          <span className="text-slate-500 text-[11px]">dia do desembolso de caixa (+1 ciclo)</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Footer do Modal com Botões de Ação */}
            <div className="px-6 py-3 bg-slate-100 border-t border-slate-200 flex items-center justify-between shrink-0">
              <span className="text-xs text-slate-500">
                Alterações recalculam automaticamente toda a curva de competência e caixa teóricos.
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsConfigModalOpen(false)}
                  className="px-4 py-2 bg-white hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl border border-slate-300 transition cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleSaveConfigs}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-xl transition cursor-pointer shadow-md"
                >
                  Salvar e Recalcular
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
