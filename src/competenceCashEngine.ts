/**
 * Motor de Cálculo para Curva de Competência Teórica (Contábil / Emissão de NF) e
 * Curva de Caixa Teórica (Desembolso Efetivo / Fluxo de Caixa).
 * Transposto e expandido a partir de REPLANEJAMENTO DE OBRA (competence_finance_engine.py).
 * 
 * Regras de Negócio:
 * 1. Curva de Competência:
 *    - Mão de Obra (MO): Medição do dia 21 do mês anterior ao dia 20 do mês atual.
 *      Nota fiscal emitida no mês da medição -> Competência no próprio mês do ciclo.
 *    - Material (MAT): A NF é emitida na entrega em obra do material.
 *      - Contínuo: Entrega com D dias de antecedência antes do período de execução física.
 *      - Em Lotes: Se informado o número de lotes N, o material total é dividido em N entregas,
 *        sendo a 1ª entrega com D dias de antecedência ao início e as demais distribuídas
 *        ao longo da duração do serviço.
 * 2. Curva Financeira (Desembolso / Caixa):
 *    - Mão de Obra: Pagamento realizado até o dia 05 do mês subsequente ao de competência (+1 ciclo).
 *      (Opcional: Retenção técnica liberada 1 ano após a conclusão da obra).
 *    - Material: Prazo de pagamento a partir da data de entrega/faturamento.
 *      - Padrão geral: 28 dias.
 *      - Flexível por etapa: configurável em até 6 parcelas (ex: 28, 35, 30/60, 30/60/90, 30:50,60:50).
 * 3. Herança da EAP:
 *    - Definições no Nível 2 propagam automaticamente para os subníveis (3, 4 e 5),
 *      a menos que haja personalização explícita na etapa.
 */

import * as XLSX from 'xlsx';
import type { BudgetItem } from './budgetLinking';
import type { MeasurementCycle, PhysicalFinancialRow } from './physicalFinancialEngine';
import { getLocalDocData, setLocalDocData } from './localDatabase';

// ==============================================================================
// Tipos e Interfaces
// ==============================================================================

export interface StageCurveConfig {
  code: string;
  description: string;
  level: number;
  parent_code?: string;
  material_pct: number;       // e.g. 60.0
  labor_pct: number;          // e.g. 40.0
  anticipation_days: number;  // e.g. 15
  distribution_type: 'continuo' | 'lotes';
  num_batches?: number | null; // e.g. 3, 5
  payment_terms: string;      // e.g. "28", "30/60", "30:50,60:50"
  labor_payment_day: number;  // e.g. 5
  is_custom?: boolean;
  source?: string;            // "Padrão da Obra", "Personalizado", "Herdado de ..."
  inherited_from?: string | null;
}

export interface ProjectCurveParams {
  dias_antecedencia_padrao: number;     // Padrão: 15 dias
  prazo_pagamento_padrao_dias: number;  // Padrão: 28 dias
  dia_corte_medicao_mo: number;         // Padrão: 20
  dia_pagamento_mo: number;             // Padrão: 5
  retencao_mo_ativa: boolean;           // Padrão: false
  retencao_mo_percentual: number;       // Padrão: 5.0
  data_fim_obra?: string;               // ISO YYYY-MM-DD
}

export interface CompetenceCashRow {
  level: number;
  code: string;
  parent_code?: string;
  description: string;
  budget: number;
  budget_pct: number;
  cycle_vals: Record<string, number>;
  cycle_mat_vals: Record<string, number>;
  cycle_mo_vals: Record<string, number>;
  cycle_pcts: Record<string, number>;
  total: number;
  total_mat: number;
  total_mo: number;
  total_pct: number;
}

export interface SCurvesComparisonData {
  labels: string[];          // e.g. ["Nov/25", "Dez/25", ...]
  full_labels: string[];     // e.g. ["Mês 1 (Nov/25)", ...]
  
  // Curva Físico-Financeira (Execução no canteiro)
  fis_month_vals: number[];
  fis_accum_vals: number[];
  fis_accum_pcts: number[];

  // Curva de Competência Teórica (Emissão de NFs)
  comp_month_vals: number[];
  comp_accum_vals: number[];
  comp_accum_pcts: number[];
  comp_mat_month_vals: number[];
  comp_mo_month_vals: number[];

  // Curva de Caixa Teórica (Desembolso Efetivo)
  fin_month_vals: number[];
  fin_accum_vals: number[];
  fin_accum_pcts: number[];
  fin_mat_month_vals: number[];
  fin_mo_month_vals: number[];
}

export interface CompetenceCashResult {
  tabCompetencia: CompetenceCashRow[];
  tabFinanceiro: CompetenceCashRow[];
  stageConfigs: StageCurveConfig[];
  extendedCycles: MeasurementCycle[];
  sCurvesComparison: SCurvesComparisonData;
  kpis: {
    totalBudget: number;
    totalCompetence: number;
    totalCashflow: number;
    totalMaterialComp: number;
    totalLaborComp: number;
    totalMaterialFin: number;
    totalLaborFin: number;
    peakMonthlyCash: {
      cycleName: string;
      value: number;
    };
    averageCashLagDays: number;
  };
}

// ==============================================================================
// Funções Auxiliares de Datas
// ==============================================================================

export function parseISODateStr(val?: string | null): Date {
  if (!val) return new Date(2025, 0, 1);
  const clean = String(val).slice(0, 10);
  const parts = clean.split('-');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      return new Date(Date.UTC(y, m, d, 12, 0, 0));
    }
  }
  return new Date(2025, 0, 1);
}

export function formatISODateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDaysISOStr(dateStr: string, days: number): string {
  const d = parseISODateStr(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatISODateStr(d);
}

export function diffDaysISOStr(startIso: string, endIso: string): number {
  const d1 = parseISODateStr(startIso);
  const d2 = parseISODateStr(endIso);
  const diffTime = d2.getTime() - d1.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

export function getMonthYearISO(dateStr: string): string {
  return String(dateStr || '').slice(0, 7);
}

export function getNextMonthISO(monthIso: string): string {
  if (!monthIso || monthIso.length < 7) return monthIso;
  const y = parseInt(monthIso.slice(0, 4), 10);
  const m = parseInt(monthIso.slice(5, 7), 10);
  if (m === 12) return `${y + 1}-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function getLastDayOfMonth(year: number, month1To12: number): number {
  return new Date(Date.UTC(year, month1To12, 0)).getUTCDate();
}

export function addOneYearISOStr(dateStr?: string | null): string {
  if (!dateStr) return '2027-12-31';
  const parts = String(dateStr).slice(0, 10).split('-');
  const y = parseInt(parts[0], 10) + 1;
  const m = parseInt(parts[1], 10);
  let d = parseInt(parts[2], 10);
  const lastD = getLastDayOfMonth(y, m);
  if (d > lastD) d = lastD;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ==============================================================================
// Condições de Pagamento e Termos (Material & MO)
// ==============================================================================

export interface PaymentTermInstallment {
  days: number;
  ratio: number;
}

/**
 * Converte string de condição de pagamento em lista de (dias, proporção).
 * Exemplos:
 *  "28" -> [{ days: 28, ratio: 1.0 }]
 *  "30/60" -> [{ days: 30, ratio: 0.5 }, { days: 60, ratio: 0.5 }]
 *  "30, 60, 90" -> [{ days: 30, ratio: 0.3333 }, ...]
 *  "30:40,60:60" -> [{ days: 30, ratio: 0.4 }, { days: 60, ratio: 0.6 }]
 */
export function parsePaymentTerms(termsStr?: string | null): PaymentTermInstallment[] {
  if (!termsStr || !String(termsStr).trim()) {
    return [{ days: 28, ratio: 1.0 }];
  }

  const clean = String(termsStr).trim().replace(/\s+/g, '');

  // Formato com pesos percentuais: "30:40,60:60"
  if (clean.includes(':')) {
    const parts = clean.split(',');
    const list: { days: number; pct: number }[] = [];
    let totPct = 0;
    for (const p of parts) {
      if (p.includes(':')) {
        const [dStr, pctStr] = p.split(':');
        const d = parseInt(dStr, 10);
        const pct = parseFloat(pctStr);
        if (!isNaN(d) && !isNaN(pct) && pct > 0) {
          list.push({ days: Math.max(0, d), pct });
          totPct += pct;
        }
      }
    }
    if (list.length > 0 && totPct > 0) {
      return list.map((item) => ({ days: item.days, ratio: item.pct / totPct }));
    }
    return [{ days: 28, ratio: 1.0 }];
  }

  // Formato separado por barra ou vírgula: "30/60/90" ou "30,60,90"
  const sep = clean.includes('/') ? '/' : clean.includes(',') ? ',' : null;
  if (sep) {
    const parts = clean.split(sep);
    const daysList: number[] = [];
    for (const p of parts) {
      const d = parseInt(p, 10);
      if (!isNaN(d)) daysList.push(Math.max(0, d));
    }
    if (daysList.length > 0) {
      const limited = daysList.slice(0, 6);
      const ratio = 1.0 / limited.length;
      return limited.map((days) => ({ days, ratio }));
    }
  }

  // Único número de dias
  const single = parseInt(clean, 10);
  if (!isNaN(single)) {
    return [{ days: Math.max(0, single), ratio: 1.0 }];
  }

  return [{ days: 28, ratio: 1.0 }];
}

// ==============================================================================
// Ordenação e Herança de Configurações da EAP
// ==============================================================================

export function compareEAPCodes(a: string, b: string): number {
  const partsA = String(a || '').trim().split('.');
  const partsB = String(b || '').trim().split('.');
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const pa = partsA[i];
    const pb = partsB[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;

    const numA = Number(pa);
    const numB = Number(pb);
    if (!isNaN(numA) && !isNaN(numB)) {
      if (numA !== numB) return numA - numB;
    } else {
      const cmp = pa.localeCompare(pb, undefined, { numeric: true });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

export const DEFAULT_PROJECT_PARAMS: ProjectCurveParams = {
  dias_antecedencia_padrao: 15,
  prazo_pagamento_padrao_dias: 28,
  dia_corte_medicao_mo: 20,
  dia_pagamento_mo: 5,
  retencao_mo_ativa: false,
  retencao_mo_percentual: 5.0,
  data_fim_obra: '2026-12-31',
};

export interface GenericBudgetItem {
  code?: string;
  eapCode?: string;
  description?: string;
  name?: string;
  total_price?: number;
  totalCost?: number;
  budget?: number;
  level?: number;
  parent_code?: string;
  parentId?: string;
}

export function getBudgetItemCode(item: GenericBudgetItem): string {
  return String(item.code || item.eapCode || '').trim();
}

export function getBudgetItemDesc(item: GenericBudgetItem): string {
  return String(item.description || item.name || '').trim();
}

export function getBudgetItemBudget(item: GenericBudgetItem): number {
  return Number(item.totalCost ?? item.total_price ?? item.budget ?? 0);
}

export function getBudgetItemParent(item: GenericBudgetItem): string {
  return String(item.parent_code || item.parentId || '').trim();
}

/**
 * Cria configurações padrão para todos os itens da EAP (nível >= 2).
 */
export function getDefaultStageConfigs(
  budgetItems: BudgetItem[] | Record<string, BudgetItem>,
  params: ProjectCurveParams = DEFAULT_PROJECT_PARAMS
): Record<string, StageCurveConfig> {
  const itemsList: BudgetItem[] = Array.isArray(budgetItems)
    ? budgetItems
    : Object.values(budgetItems);

  const configs: Record<string, StageCurveConfig> = {};

  const sorted = [...itemsList].sort((a, b) =>
    compareEAPCodes(getBudgetItemCode(a as GenericBudgetItem), getBudgetItemCode(b as GenericBudgetItem))
  );

  for (const item of sorted) {
    const it = item as GenericBudgetItem;
    const lvl = Number(it.level || 0);
    if (lvl >= 2) {
      const code = getBudgetItemCode(it);
      if (!code) continue;
      const desc = getBudgetItemDesc(it);
      let parentCode = getBudgetItemParent(it);
      if (!parentCode && code.includes('.')) {
        parentCode = code.slice(0, code.lastIndexOf('.'));
      }

      configs[code] = {
        code,
        description: desc,
        level: lvl,
        parent_code: parentCode || undefined,
        material_pct: 60.0,
        labor_pct: 40.0,
        anticipation_days: params.dias_antecedencia_padrao,
        distribution_type: 'continuo',
        num_batches: null,
        payment_terms: String(params.prazo_pagamento_padrao_dias),
        labor_payment_day: params.dia_pagamento_mo,
        is_custom: false,
        source: 'Padrão da Obra',
        inherited_from: 'padrao',
      };
    }
  }

  // Entrada fallback 'padrao'
  configs['padrao'] = {
    code: 'padrao',
    description: 'Padrão Geral da Obra',
    level: 2,
    material_pct: 60.0,
    labor_pct: 40.0,
    anticipation_days: params.dias_antecedencia_padrao,
    distribution_type: 'continuo',
    num_batches: null,
    payment_terms: String(params.prazo_pagamento_padrao_dias),
    labor_payment_day: params.dia_pagamento_mo,
    is_custom: false,
    source: 'Padrão da Obra',
    inherited_from: null,
  };

  return configs;
}

/**
 * Encontra a configuração efetiva para um item de qualquer nível,
 * obedecendo a herança: item específico -> pai -> avô -> ... -> nível 2 -> padrão.
 */
export function resolveStageConfig(
  code: string,
  budgetItemsMap: Record<string, BudgetItem>,
  effectiveConfigs: Record<string, StageCurveConfig>,
  defaultParams: ProjectCurveParams = DEFAULT_PROJECT_PARAMS
): StageCurveConfig {
  const cleanCode = String(code || '').trim();

  // 1. Se o próprio nó possui configuração explicitamente personalizada
  const selfCfg = effectiveConfigs[cleanCode];
  if (selfCfg && selfCfg.is_custom) {
    return { ...selfCfg };
  }

  // 2. Busca nos ancestrais por um nó com is_custom = true
  let walk = cleanCode;
  while (walk) {
    const item = budgetItemsMap[walk];
    let parentCode = item ? getBudgetItemParent(item as GenericBudgetItem) : '';
    if (!parentCode && walk.includes('.')) {
      parentCode = walk.slice(0, walk.lastIndexOf('.'));
    }

    if (!parentCode) break;

    const ancestorCfg = effectiveConfigs[parentCode];
    if (ancestorCfg && ancestorCfg.is_custom) {
      return {
        ...ancestorCfg,
        code: cleanCode,
        source: `Herdado de ${parentCode}`,
        inherited_from: parentCode,
        is_custom: false,
      };
    }

    walk = parentCode;
  }

  // 3. Se nenhum ancestral for customizado, retorna a própria configuração ou padrão
  if (selfCfg) {
    return { ...selfCfg, source: selfCfg.source || 'Padrão da Obra' };
  }

  const fallback = effectiveConfigs['padrao'];
  if (fallback) {
    return { ...fallback, source: 'Padrão da Obra' };
  }

  return {
    code: 'padrao',
    description: 'Padrão da Obra',
    level: 2,
    material_pct: 60.0,
    labor_pct: 40.0,
    anticipation_days: defaultParams.dias_antecedencia_padrao,
    distribution_type: 'continuo',
    num_batches: null,
    payment_terms: String(defaultParams.prazo_pagamento_padrao_dias),
    labor_payment_day: defaultParams.dia_pagamento_mo,
    source: 'Padrão da Obra',
  };
}

// ==============================================================================
// Persistência das Configurações
// ==============================================================================

const CURVAS_CONFIG_PREFIX = 'curtoprazo_curvas_config_';

export function getCurvasConfigDocId(projectId: string): string {
  return `${CURVAS_CONFIG_PREFIX}${projectId || 'projeto_principal'}`;
}

export function loadCurvasConfig(
  projectId: string,
  budgetItems: BudgetItem[],
  params: ProjectCurveParams = DEFAULT_PROJECT_PARAMS
): Record<string, StageCurveConfig> {
  const allConfigs = getDefaultStageConfigs(budgetItems, params);
  const docId = getCurvasConfigDocId(projectId);
  const saved = getLocalDocData(docId) as Record<string, StageCurveConfig> | null;

  if (saved && typeof saved === 'object') {
    for (const [code, sCfg] of Object.entries(saved)) {
      const clean = String(code).trim();
      if (!clean) continue;
      if (allConfigs[clean]) {
        allConfigs[clean] = {
          ...allConfigs[clean],
          ...sCfg,
          is_custom: sCfg.is_custom !== undefined ? sCfg.is_custom : true,
          source: sCfg.is_custom ? 'Personalizado' : (sCfg.source || 'Personalizado'),
          inherited_from: null,
        };
      } else {
        allConfigs[clean] = {
          ...sCfg,
          is_custom: true,
          source: 'Personalizado',
          inherited_from: null,
        };
      }
    }
  }

  // Propagação em cascata da herança
  const budgetItemsMap: Record<string, BudgetItem> = {};
  for (const it of budgetItems) {
    const c = getBudgetItemCode(it as GenericBudgetItem);
    if (c) budgetItemsMap[c] = it;
  }

  const sortedCodes = Object.keys(allConfigs)
    .filter((k) => k !== 'padrao')
    .sort((a, b) => {
      const lvlA = allConfigs[a]?.level || 2;
      const lvlB = allConfigs[b]?.level || 2;
      if (lvlA !== lvlB) return lvlA - lvlB;
      return compareEAPCodes(a, b);
    });

  for (const code of sortedCodes) {
    const cfg = allConfigs[code];
    if (cfg.is_custom) continue;

    let pCode = cfg.parent_code;
    if (!pCode && code.includes('.')) {
      pCode = code.slice(0, code.lastIndexOf('.'));
    }

    let ancestorCfg: StageCurveConfig | null = null;
    let curr = pCode;
    while (curr) {
      if (allConfigs[curr] && allConfigs[curr].is_custom) {
        ancestorCfg = allConfigs[curr];
        break;
      }
      const item = budgetItemsMap[curr];
      const p = item ? getBudgetItemParent(item as GenericBudgetItem) : '';
      if (p) {
        curr = p;
      } else if (curr.includes('.')) {
        curr = curr.slice(0, curr.lastIndexOf('.'));
      } else {
        break;
      }
    }

    if (ancestorCfg) {
      cfg.material_pct = Number(ancestorCfg.material_pct);
      cfg.labor_pct = Number(ancestorCfg.labor_pct);
      cfg.anticipation_days = Number(ancestorCfg.anticipation_days);
      cfg.distribution_type = ancestorCfg.distribution_type;
      cfg.num_batches = ancestorCfg.num_batches;
      cfg.payment_terms = ancestorCfg.payment_terms;
      cfg.labor_payment_day = ancestorCfg.labor_payment_day;
      cfg.is_custom = false;
      cfg.source = `Herdado de ${ancestorCfg.code}`;
      cfg.inherited_from = ancestorCfg.code;
    } else {
      cfg.is_custom = false;
      cfg.source = 'Padrão da Obra';
      cfg.inherited_from = 'padrao';
    }
  }

  return allConfigs;
}

export function saveCurvasConfig(
  projectId: string,
  configs: Record<string, StageCurveConfig> | StageCurveConfig[]
): void {
  const docId = getCurvasConfigDocId(projectId);
  let mapToSave: Record<string, StageCurveConfig> = {};

  if (Array.isArray(configs)) {
    for (const c of configs) {
      if (c && c.code) mapToSave[c.code] = c;
    }
  } else {
    mapToSave = { ...configs };
  }

  setLocalDocData(docId, mapToSave);
}

// ==============================================================================
// Extensão de Ciclos de Medição no Futuro (Para Cobrir Desembolsos de Caixa)
// ==============================================================================

const MONTH_NAMES_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export function extendCyclesIfNeeded(
  cycles: MeasurementCycle[],
  maxDateIso: string,
  cycleStartDay = 21,
  cycleEndDay = 20
): MeasurementCycle[] {
  if (!cycles || cycles.length === 0) return [];

  const lastCycle = cycles[cycles.length - 1];
  if (lastCycle.end >= maxDateIso) {
    return cycles;
  }

  const newCycles: MeasurementCycle[] = [...cycles];
  let nextNum = lastCycle.num + 1;

  // Próximo mês de término
  const lastEndDate = parseISODateStr(lastCycle.end);
  let currYear = lastEndDate.getUTCFullYear();
  let currMonth = lastEndDate.getUTCMonth() + 1; // 1-12

  for (let step = 0; step < 18; step++) { // Limite de até 18 meses extras
    currMonth += 1;
    if (currMonth > 12) {
      currMonth = 1;
      currYear += 1;
    }

    let cStartIso: string;
    let cEndIso: string;

    if (cycleStartDay <= 1) {
      cStartIso = `${currYear}-${String(currMonth).padStart(2, '0')}-01`;
      const lastDay = getLastDayOfMonth(currYear, currMonth);
      cEndIso = `${currYear}-${String(currMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else {
      let prevMonth = currMonth - 1;
      let prevYear = currYear;
      if (prevMonth < 1) {
        prevMonth = 12;
        prevYear -= 1;
      }
      const lastDayPrev = getLastDayOfMonth(prevYear, prevMonth);
      const sDay = Math.min(cycleStartDay, lastDayPrev);
      cStartIso = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(sDay).padStart(2, '0')}`;

      const lastDayCurr = getLastDayOfMonth(currYear, currMonth);
      const eDay = Math.min(cycleEndDay, lastDayCurr);
      cEndIso = `${currYear}-${String(currMonth).padStart(2, '0')}-${String(eDay).padStart(2, '0')}`;
    }

    const monthLabel = `${MONTH_NAMES_SHORT[currMonth - 1]}/${String(currYear).slice(2)}`;

    newCycles.push({
      num: nextNum,
      name: `Mês ${nextNum}`,
      period_label: monthLabel,
      full_label: `Mês ${nextNum} (${monthLabel})`,
      start: cStartIso,
      end: cEndIso,
      is_past: false,
    });

    if (cEndIso >= maxDateIso) {
      break;
    }

    nextNum += 1;
  }

  return newCycles;
}

export function findCycleForDate(targetDateIso: string, cycles: MeasurementCycle[]): number {
  if (!cycles || cycles.length === 0) return 1;
  if (targetDateIso <= cycles[0].start) return cycles[0].num;

  for (const c of cycles) {
    if (c.start <= targetDateIso && targetDateIso <= c.end) {
      return c.num;
    }
  }

  if (targetDateIso >= cycles[cycles.length - 1].end) {
    return cycles[cycles.length - 1].num;
  }

  return cycles[0].num;
}

// ==============================================================================
// Motor Central: computeCompetenceAndCashflow
// ==============================================================================

export interface ComputeCurvesOptions {
  budgetItems: BudgetItem[];
  tabFfRows: PhysicalFinancialRow[]; // tabFfReplanejado ou tabFisicoFinanceiro
  cycles: MeasurementCycle[];
  totalProjBudget: number;
  stageConfigs?: Record<string, StageCurveConfig>;
  paramsObra?: ProjectCurveParams;
  cycleStartDay?: number;
  cycleEndDay?: number;
}

export function computeCompetenceAndCashflow({
  budgetItems,
  tabFfRows,
  cycles,
  totalProjBudget,
  stageConfigs,
  paramsObra = DEFAULT_PROJECT_PARAMS,
  cycleStartDay = 21,
  cycleEndDay = 20,
}: ComputeCurvesOptions): CompetenceCashResult {
  const budgetMap: Record<string, BudgetItem> = {};
  for (const b of budgetItems) {
    const c = getBudgetItemCode(b as GenericBudgetItem);
    if (c) budgetMap[c] = b;
  }

  // 1. Configurações por etapa com herança
  const defaultConfigs = getDefaultStageConfigs(budgetItems, paramsObra);
  const effectiveConfigs: Record<string, StageCurveConfig> = {};

  for (const [stCode, stCfg] of Object.entries(defaultConfigs)) {
    const userCfg = stageConfigs?.[stCode] as Partial<StageCurveConfig> | undefined;
    const matPct = userCfg?.material_pct !== undefined ? Number(userCfg.material_pct) : stCfg.material_pct;
    const moPct = Math.max(0, 100 - matPct);

    effectiveConfigs[stCode] = {
      code: stCode,
      description: userCfg?.description || stCfg.description,
      level: Number(userCfg?.level || stCfg.level || 2),
      parent_code: userCfg?.parent_code || stCfg.parent_code,
      material_pct: matPct,
      labor_pct: moPct,
      anticipation_days: Number(userCfg?.anticipation_days !== undefined ? userCfg.anticipation_days : stCfg.anticipation_days),
      distribution_type: (userCfg?.distribution_type || stCfg.distribution_type) as 'continuo' | 'lotes',
      num_batches: userCfg?.num_batches ? Number(userCfg.num_batches) : null,
      payment_terms: String(userCfg?.payment_terms || stCfg.payment_terms).trim(),
      labor_payment_day: Number(userCfg?.labor_payment_day !== undefined ? userCfg.labor_payment_day : stCfg.labor_payment_day),
      is_custom: Boolean(userCfg?.is_custom),
      source: userCfg?.source || (userCfg?.is_custom ? 'Personalizado' : 'Padrão da Obra'),
      inherited_from: userCfg?.inherited_from || null,
    };
  }

  // 2. Linhas de nível 5 da curva físico-financeira (com distribuição mensal)
  const l5Rows: Record<string, PhysicalFinancialRow> = {};
  for (const r of tabFfRows) {
    if (r.level === 5 && r.code) {
      l5Rows[r.code] = r;
    }
  }

  // Se não encontrar nenhuma linha N5 diretamente, tenta pegar as folhas da tabela
  if (Object.keys(l5Rows).length === 0) {
    for (const r of tabFfRows) {
      if (r.level >= 2 && r.code) {
        l5Rows[r.code] = r;
      }
    }
  }

  // 3. Mapear para cada L5: valores mensais planejados
  const l5PlannedByCycle: Record<string, Record<number, number>> = {};
  for (const [code, row] of Object.entries(l5Rows)) {
    const vals: Record<number, number> = {};
    for (const c of cycles) {
      const v = Number(row.cycle_vals?.[String(c.num)] || 0);
      vals[c.num] = v;
    }
    l5PlannedByCycle[code] = vals;
  }

  // 4. Extensão dos ciclos para cobrir pagamentos futuros (até 150 dias após o fim do cronograma)
  const lastCycleEnd = cycles.length > 0 ? cycles[cycles.length - 1].end : '2026-12-20';
  const maxProjectFutureDate = addDaysISOStr(lastCycleEnd, 150);
  const extendedCycles = extendCyclesIfNeeded(cycles, maxProjectFutureDate, cycleStartDay, cycleEndDay);
  const cycleByNum: Record<number, MeasurementCycle> = {};
  for (const c of extendedCycles) {
    cycleByNum[c.num] = c;
  }

  // 5. Inicializar mapas de resultado para cada item N5
  const l5CompMat: Record<string, Record<number, number>> = {};
  const l5CompMo: Record<string, Record<number, number>> = {};
  const l5FinMat: Record<string, Record<number, number>> = {};
  const l5FinMo: Record<string, Record<number, number>> = {};

  for (const code of Object.keys(l5Rows)) {
    l5CompMat[code] = {};
    l5CompMo[code] = {};
    l5FinMat[code] = {};
    l5FinMo[code] = {};
    for (const cy of extendedCycles) {
      l5CompMat[code][cy.num] = 0;
      l5CompMo[code][cy.num] = 0;
      l5FinMat[code][cy.num] = 0;
      l5FinMo[code][cy.num] = 0;
    }
  }

  // 6. Realizar o cálculo de Competência e Caixa para cada item N5
  for (const [code] of Object.entries(l5Rows)) {
    const cfg = resolveStageConfig(code, budgetMap, effectiveConfigs, paramsObra);

    const matPct = cfg.material_pct / 100.0;
    const moPct = cfg.labor_pct / 100.0;
    const anticipDays = cfg.anticipation_days;
    const numBatches = cfg.num_batches;
    const pmtTerms = parsePaymentTerms(cfg.payment_terms);

    const plannedCycles = l5PlannedByCycle[code] || {};
    const activeCyclesNums = Object.keys(plannedCycles)
      .map(Number)
      .filter((n) => (plannedCycles[n] || 0) > 0);

    // A. MÃO DE OBRA:
    // Competência: no próprio ciclo da medição
    // Desembolso Financeiro (Caixa): no ciclo seguinte (dia 05 do mês subsequente)
    for (const [cNumStr, val] of Object.entries(plannedCycles)) {
      const cNum = Number(cNumStr);
      if (val > 0) {
        const moVal = val * moPct;
        l5CompMo[code][cNum] = (l5CompMo[code][cNum] || 0) + moVal;

        // Desembolso no ciclo seguinte (cNum + 1)
        const finCNum = cNum + 1;
        if (l5FinMo[code][finCNum] !== undefined) {
          l5FinMo[code][finCNum] = (l5FinMo[code][finCNum] || 0) + moVal;
        } else if (extendedCycles.length > 0) {
          const lastNum = extendedCycles[extendedCycles.length - 1].num;
          l5FinMo[code][lastNum] = (l5FinMo[code][lastNum] || 0) + moVal;
        }
      }
    }

    // B. MATERIAL:
    const totalMatVal = Object.values(plannedCycles).reduce((sum, v) => sum + v * matPct, 0);

    if (totalMatVal > 0) {
      if (numBatches && numBatches > 1 && activeCyclesNums.length > 0) {
        // Distribuição em Lotes
        const firstC = Math.min(...activeCyclesNums);
        const lastC = Math.max(...activeCyclesNums);
        const batchVal = totalMatVal / Number(numBatches);

        const cStartIso = cycleByNum[firstC]?.start || '2025-10-21';
        const firstDelivIso = addDaysISOStr(cStartIso, -anticipDays);

        const spanCycles = Math.max(1, lastC - firstC);
        const step = numBatches > 1 ? spanCycles / Math.max(1, numBatches - 1) : 0;

        for (let bIdx = 0; bIdx < numBatches; bIdx++) {
          let delivIso: string;
          if (bIdx === 0) {
            delivIso = firstDelivIso;
          } else {
            const targetCNum = Math.min(lastC, Math.round(firstC + bIdx * step));
            const targetStart = cycleByNum[targetCNum]?.start || cStartIso;
            delivIso = addDaysISOStr(targetStart, -anticipDays);
          }

          // Competência (NF de entrega)
          const delivCNum = findCycleForDate(delivIso, extendedCycles);
          l5CompMat[code][delivCNum] = (l5CompMat[code][delivCNum] || 0) + batchVal;

          // Caixa (desembolso para cada parcela)
          for (const term of pmtTerms) {
            const dueIso = addDaysISOStr(delivIso, term.days);
            const dueCNum = findCycleForDate(dueIso, extendedCycles);
            l5FinMat[code][dueCNum] = (l5FinMat[code][dueCNum] || 0) + batchVal * term.ratio;
          }
        }
      } else {
        // Distribuição Contínua (mês a mês conforme execução física)
        for (const [cNumStr, val] of Object.entries(plannedCycles)) {
          const cNum = Number(cNumStr);
          if (val > 0) {
            const matVal = val * matPct;
            const cObj = cycleByNum[cNum];
            const cStartIso = cObj ? cObj.start : '2025-10-21';

            // Entrega 'anticipDays' antes do início do ciclo
            const delivIso = addDaysISOStr(cStartIso, -anticipDays);
            const delivCNum = findCycleForDate(delivIso, extendedCycles);
            l5CompMat[code][delivCNum] = (l5CompMat[code][delivCNum] || 0) + matVal;

            // Financeiro para cada parcela
            for (const term of pmtTerms) {
              const dueIso = addDaysISOStr(delivIso, term.days);
              const dueCNum = findCycleForDate(dueIso, extendedCycles);
              l5FinMat[code][dueCNum] = (l5FinMat[code][dueCNum] || 0) + matVal * term.ratio;
            }
          }
        }
      }
    }
  }

  // 7. Montagem e Rollup Bottom-Up na EAP (N5 -> N4 -> N3 -> N2 -> N1)
  function buildTree(
    dataMat: Record<string, Record<number, number>>,
    dataMo: Record<string, Record<number, number>>
  ): CompetenceCashRow[] {
    const tree: Record<string, {
      level: number;
      code: string;
      parent_code?: string;
      description: string;
      budget: number;
      cycle_vals: Record<number, number>;
      cycle_mat_vals: Record<number, number>;
      cycle_mo_vals: Record<number, number>;
    }> = {};

    // Inicializa nós da árvore a partir do orçamento
    for (const item of budgetItems) {
      const it = item as GenericBudgetItem;
      const code = getBudgetItemCode(it);
      if (!code) continue;
      const lvl = it.level || 5;
      const b = getBudgetItemBudget(it);

      const cVals: Record<number, number> = {};
      const cMatVals: Record<number, number> = {};
      const cMoVals: Record<number, number> = {};
      for (const cy of extendedCycles) {
        cVals[cy.num] = 0;
        cMatVals[cy.num] = 0;
        cMoVals[cy.num] = 0;
      }

      tree[code] = {
        level: lvl,
        code,
        parent_code: getBudgetItemParent(it) || undefined,
        description: getBudgetItemDesc(it),
        budget: b,
        cycle_vals: cVals,
        cycle_mat_vals: cMatVals,
        cycle_mo_vals: cMoVals,
      };
    }

    // Preenche nós folha (Nível 5)
    for (const code of Object.keys(l5Rows)) {
      if (tree[code]) {
        for (const cy of extendedCycles) {
          const mVal = dataMat[code]?.[cy.num] || 0;
          const moVal = dataMo[code]?.[cy.num] || 0;
          const tot = mVal + moVal;
          tree[code].cycle_mat_vals[cy.num] = mVal;
          tree[code].cycle_mo_vals[cy.num] = moVal;
          tree[code].cycle_vals[cy.num] = tot;
        }
      }
    }

    // Rollup bottom-up: Nível 4, 3, 2, 1
    for (const lvl of [4, 3, 2, 1]) {
      const parentNodes = Object.values(tree).filter((n) => n.level === lvl);
      for (const p of parentNodes) {
        const children = Object.values(tree).filter((c) => {
          if (c.parent_code) return c.parent_code === p.code;
          return c.code.startsWith(p.code + '.') && c.level === lvl + 1;
        });

        if (children.length > 0) {
          if (p.budget <= 0) {
            p.budget = children.reduce((sum, ch) => sum + ch.budget, 0);
          }
          for (const cy of extendedCycles) {
            const sumMat = children.reduce((sum, ch) => sum + (ch.cycle_mat_vals[cy.num] || 0), 0);
            const sumMo = children.reduce((sum, ch) => sum + (ch.cycle_mo_vals[cy.num] || 0), 0);
            p.cycle_mat_vals[cy.num] = sumMat;
            p.cycle_mo_vals[cy.num] = sumMo;
            p.cycle_vals[cy.num] = sumMat + sumMo;
          }
        }
      }
    }

    // Ordenar e formatar saída
    const sortedCodes = Object.keys(tree).sort(compareEAPCodes);
    const rowsOut: CompetenceCashRow[] = [];

    const baseBudget = totalProjBudget > 0 ? totalProjBudget : 1.0;

    for (const code of sortedCodes) {
      const node = tree[code];

      const cValsStr: Record<string, number> = {};
      const cMatStr: Record<string, number> = {};
      const cMoStr: Record<string, number> = {};
      const cPctsStr: Record<string, number> = {};

      let totVal = 0;
      let totMat = 0;
      let totMo = 0;

      for (const cy of extendedCycles) {
        const v = Math.round((node.cycle_vals[cy.num] || 0) * 100) / 100;
        const vm = Math.round((node.cycle_mat_vals[cy.num] || 0) * 100) / 100;
        const vmo = Math.round((node.cycle_mo_vals[cy.num] || 0) * 100) / 100;

        cValsStr[String(cy.num)] = v;
        cMatStr[String(cy.num)] = vm;
        cMoStr[String(cy.num)] = vmo;
        cPctsStr[String(cy.num)] = Math.round((v / baseBudget) * 10000) / 100;

        totVal += v;
        totMat += vm;
        totMo += vmo;
      }

      rowsOut.push({
        level: node.level,
        code: node.code,
        parent_code: node.parent_code,
        description: node.description,
        budget: Math.round(node.budget * 100) / 100,
        budget_pct: Math.round((node.budget / baseBudget) * 10000) / 100,
        cycle_vals: cValsStr,
        cycle_mat_vals: cMatStr,
        cycle_mo_vals: cMoStr,
        cycle_pcts: cPctsStr,
        total: Math.round(totVal * 100) / 100,
        total_mat: Math.round(totMat * 100) / 100,
        total_mo: Math.round(totMo * 100) / 100,
        total_pct: Math.round((totVal / baseBudget) * 10000) / 100,
      });
    }

    return rowsOut;
  }

  const tabCompetencia = buildTree(l5CompMat, l5CompMo);
  const tabFinanceiro = buildTree(l5FinMat, l5FinMo);

  // 8. Comparativo de Curvas S (Físico vs Competência vs Caixa)
  const rootComp = tabCompetencia.find((r) => r.level === 1) || tabCompetencia[0];
  const rootFin = tabFinanceiro.find((r) => r.level === 1) || tabFinanceiro[0];
  const rootFis = tabFfRows.find((r) => r.level === 1) || tabFfRows[0];

  const labels = extendedCycles.map((c) => c.period_label);
  const fullLabels = extendedCycles.map((c) => c.full_label);

  const baseBudget = totalProjBudget > 0 ? totalProjBudget : 1.0;

  // Curva Físico-Financeira
  const fisMonthVals = extendedCycles.map((c) => {
    return Number(rootFis?.cycle_vals?.[String(c.num)] || 0);
  });
  const fisAccumVals: number[] = [];
  const fisAccumPcts: number[] = [];
  let fisAcc = 0;
  for (const v of fisMonthVals) {
    fisAcc += v;
    fisAccumVals.push(Math.round(fisAcc * 100) / 100);
    fisAccumPcts.push(Math.round((fisAcc / baseBudget) * 10000) / 100);
  }

  // Curva de Competência
  const compMonthVals = extendedCycles.map((c) => {
    return Number(rootComp?.cycle_vals?.[String(c.num)] || 0);
  });
  const compMatMonthVals = extendedCycles.map((c) => {
    return Number(rootComp?.cycle_mat_vals?.[String(c.num)] || 0);
  });
  const compMoMonthVals = extendedCycles.map((c) => {
    return Number(rootComp?.cycle_mo_vals?.[String(c.num)] || 0);
  });
  const compAccumVals: number[] = [];
  const compAccumPcts: number[] = [];
  let compAcc = 0;
  for (const v of compMonthVals) {
    compAcc += v;
    compAccumVals.push(Math.round(compAcc * 100) / 100);
    compAccumPcts.push(Math.round((compAcc / baseBudget) * 10000) / 100);
  }

  // Curva de Caixa / Financeiro
  const finMonthVals = extendedCycles.map((c) => {
    return Number(rootFin?.cycle_vals?.[String(c.num)] || 0);
  });
  const finMatMonthVals = extendedCycles.map((c) => {
    return Number(rootFin?.cycle_mat_vals?.[String(c.num)] || 0);
  });
  const finMoMonthVals = extendedCycles.map((c) => {
    return Number(rootFin?.cycle_mo_vals?.[String(c.num)] || 0);
  });
  const finAccumVals: number[] = [];
  const finAccumPcts: number[] = [];
  let finAcc = 0;
  for (const v of finMonthVals) {
    finAcc += v;
    finAccumVals.push(Math.round(finAcc * 100) / 100);
    finAccumPcts.push(Math.round((finAcc / baseBudget) * 10000) / 100);
  }

  // 9. Cálculo de KPIs
  let maxCashVal = 0;
  let maxCashCycleName = '-';
  extendedCycles.forEach((c, idx) => {
    const val = finMonthVals[idx];
    if (val > maxCashVal) {
      maxCashVal = val;
      maxCashCycleName = c.period_label;
    }
  });

  // Média ponderada de dias de defasagem de caixa em relação ao físico
  const averageCashLagDays = Math.round(
    paramsObra.dias_antecedencia_padrao * 0.6 + paramsObra.prazo_pagamento_padrao_dias * 0.6 + 15 * 0.4
  );

  return {
    tabCompetencia,
    tabFinanceiro,
    stageConfigs: Object.values(effectiveConfigs),
    extendedCycles,
    sCurvesComparison: {
      labels,
      full_labels: fullLabels,
      fis_month_vals: fisMonthVals,
      fis_accum_vals: fisAccumVals,
      fis_accum_pcts: fisAccumPcts,
      comp_month_vals: compMonthVals,
      comp_accum_vals: compAccumVals,
      comp_accum_pcts: compAccumPcts,
      comp_mat_month_vals: compMatMonthVals,
      comp_mo_month_vals: compMoMonthVals,
      fin_month_vals: finMonthVals,
      fin_accum_vals: finAccumVals,
      fin_accum_pcts: finAccumPcts,
      fin_mat_month_vals: finMatMonthVals,
      fin_mo_month_vals: finMoMonthVals,
    },
    kpis: {
      totalBudget: Math.round(totalProjBudget * 100) / 100,
      totalCompetence: rootComp ? rootComp.total : 0,
      totalCashflow: rootFin ? rootFin.total : 0,
      totalMaterialComp: rootComp ? rootComp.total_mat : 0,
      totalLaborComp: rootComp ? rootComp.total_mo : 0,
      totalMaterialFin: rootFin ? rootFin.total_mat : 0,
      totalLaborFin: rootFin ? rootFin.total_mo : 0,
      peakMonthlyCash: {
        cycleName: maxCashCycleName,
        value: maxCashVal,
      },
      averageCashLagDays,
    },
  };
}

// ==============================================================================
// Importação e Exportação Excel de Parâmetros
// ==============================================================================

export function exportCurvasConfigExcel(configs: StageCurveConfig[]): void {
  const headers = [
    'Nível',
    'Código da Etapa',
    'Descrição da Etapa',
    'Material (%)',
    'Mão de Obra (%)',
    'Dias Antecedência Material',
    'Distribuição Material',
    'Número de Lotes',
    'Condição Pagamento Material',
    'Status / Origem',
  ];

  const rows: any[][] = [headers];

  const sorted = [...configs].sort((a, b) => compareEAPCodes(a.code, b.code));

  for (const cfg of sorted) {
    if (cfg.code === 'padrao') continue;
    const lvl = cfg.level || 2;
    const indent = '  '.repeat(Math.max(0, lvl - 2));
    rows.push([
      lvl,
      cfg.code,
      indent + cfg.description,
      cfg.material_pct,
      cfg.labor_pct,
      cfg.anticipation_days,
      cfg.distribution_type,
      cfg.num_batches || '',
      cfg.payment_terms,
      cfg.source || 'Padrão da Obra',
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Definir larguras de colunas
  ws['!cols'] = [
    { wch: 8 },  // Nível
    { wch: 18 }, // Código
    { wch: 45 }, // Descrição
    { wch: 14 }, // Material %
    { wch: 16 }, // MO %
    { wch: 26 }, // Dias Antecedência
    { wch: 22 }, // Distribuição
    { wch: 16 }, // Nº Lotes
    { wch: 28 }, // Condição Pgto
    { wch: 24 }, // Origem
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Parametros_Curvas');
  XLSX.writeFile(wb, 'Parametros_Curvas_Competencia_Caixa.xlsx');
}

export async function parseCurvasConfigExcelFile(file: File): Promise<Record<string, StageCurveConfig>> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  const rawRows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (!rawRows || rawRows.length < 2) {
    return {};
  }

  const header = (rawRows[0] || []).map((c) => String(c || '').toLowerCase().trim());

  const findCol = (keywords: string[]) => {
    return header.findIndex((h) => keywords.some((k) => h.includes(k)));
  };

  const idxCode = findCol(['código', 'codigo']);
  const idxDesc = findCol(['descrição', 'descricao']);
  const idxMat = findCol(['material']);
  const idxMo = findCol(['mão de obra', 'mao de obra', 'mo']);
  const idxAnt = findCol(['antecedência', 'antecedencia', 'dias']);
  const idxDist = findCol(['distribuição', 'distribuicao']);
  const idxLotes = findCol(['lotes', 'lote']);
  const idxPgto = findCol(['pagamento', 'condição', 'condicao']);

  const parsedConfigs: Record<string, StageCurveConfig> = {};

  for (let i = 1; i < rawRows.length; i++) {
    const r = rawRows[i];
    if (!r || r.length === 0) continue;

    const code = idxCode >= 0 && r[idxCode] !== undefined ? String(r[idxCode]).trim() : '';
    if (!code) continue;

    let desc = idxDesc >= 0 && r[idxDesc] !== undefined ? String(r[idxDesc]).trim() : '';
    desc = desc.trim();

    let matPct = idxMat >= 0 && r[idxMat] !== undefined ? parseFloat(r[idxMat]) : 60.0;
    if (isNaN(matPct)) matPct = 60.0;
    if (matPct > 0 && matPct <= 1.0) matPct *= 100.0;

    let moPct = idxMo >= 0 && r[idxMo] !== undefined ? parseFloat(r[idxMo]) : 100.0 - matPct;
    if (isNaN(moPct)) moPct = Math.max(0, 100.0 - matPct);
    if (moPct > 0 && moPct <= 1.0) moPct *= 100.0;

    let antDays = idxAnt >= 0 && r[idxAnt] !== undefined ? parseInt(r[idxAnt], 10) : 15;
    if (isNaN(antDays)) antDays = 15;

    let distType: 'continuo' | 'lotes' = 'continuo';
    if (idxDist >= 0 && r[idxDist] !== undefined) {
      const dtStr = String(r[idxDist]).toLowerCase().trim();
      if (dtStr.includes('lote')) distType = 'lotes';
    }

    let numBatches: number | null = null;
    if (distType === 'lotes') {
      const nb = idxLotes >= 0 && r[idxLotes] !== undefined ? parseInt(r[idxLotes], 10) : 5;
      numBatches = !isNaN(nb) && nb > 0 ? nb : 5;
    }

    let pgto = '28';
    if (idxPgto >= 0 && r[idxPgto] !== undefined) {
      pgto = String(r[idxPgto]).trim();
    }

    parsedConfigs[code] = {
      code,
      description: desc,
      level: code.split('.').length,
      material_pct: matPct,
      labor_pct: moPct,
      anticipation_days: antDays,
      distribution_type: distType,
      num_batches: numBatches,
      payment_terms: pgto,
      labor_payment_day: 5,
      is_custom: true,
      source: 'Personalizado via Excel',
    };
  }

  return parsedConfigs;
}
