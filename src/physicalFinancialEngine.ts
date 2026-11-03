/**
 * Motor de Cálculo Físico-Financeiro, Distribuição Nível 6, Medição e Replanejamento pelo Saldo
 * Transposto com 100% de equivalência matemática do sistema REPLANEJAMENTO DE OBRA (replan_engine.py).
 * 
 * Regras Fundamentais:
 * 1. Ciclos de Medição: Padrão dia 21 do mês M-1 ao dia 20 do mês M (ou dia 1 ao último dia).
 * 2. Distribuição Nível 6: Serviços N5 do orçamento distribuídos nas tarefas do cronograma por pesos ponderados.
 * 3. Físico-Financeiro Inicial: Rollup bottom-up na EAP (N5 -> N4 -> N3 -> N2 -> N1) ponderado em % da obra e R$.
 * 4. Medição Multinível: Histórico blindado até a Medição de Corte (M_corte) com saldo a medir = Orçado - Realizado.
 * 5. Replanejado pelo Saldo: Saldo restante é redistribuído estritamente sobre as tarefas futuras após a data de corte,
 *    fechando rigorosamente em 100% do orçamento da obra.
 */

import type { BudgetItem } from './budgetLinking';
import type { LobActivity, LobActivityJob } from './longTermSchedule';

export interface MeasurementCycle {
  num: number;
  name: string;             // e.g. "Mês 1"
  period_label: string;     // e.g. "Nov/25"
  full_label: string;       // e.g. "Mês 1 (Nov/25)"
  start: string;            // "YYYY-MM-DD"
  end: string;              // "YYYY-MM-DD"
  is_past: boolean;         // num <= cutoffMedNum
}

export interface PhysicalFinancialRow {
  level: number;
  code: string;
  parent_code?: string;
  description: string;
  budget: number;
  budget_pct: number;
  med_val?: number;
  med_pct?: number;
  saldo?: number;
  saldo_pct?: number;
  saldo_pct_obra?: number;
  duration?: number;
  weight_pct?: number;
  allocated_val?: number;
  cycle_vals: Record<string, number>;
  cycle_pcts?: Record<string, number>;
  cycle_pcts_service?: Record<string, number>;
  cycle_pcts_obra?: Record<string, number>;
  total: number;
  total_pct: number;
  total_pct_service?: number;
  total_pct_obra?: number;
  is_custom_weight?: boolean;
  tasks_l6?: MeasurementTaskL6Row[];
}

export interface MeasurementTaskL6Row {
  task_name: string;
  task_id?: string;
  duration: number;
  weight_pct: number;
  measured_pct: number;
  monthly_measurements: Record<string, number>;
}

export interface MeasurementMonthlyCol {
  med_num: number;
  cycle_name: string;
  previsto_pct: number;
  realizado_pct: number;
  realizado_val: number;
}

export interface MeasurementGridRow {
  level: number;
  code: string;
  parent_code?: string;
  description: string;
  unit?: string;
  quantity?: number;
  unit_price?: number;
  total_price: number;
  accum_realizado_pct: number;
  accum_realizado_val: number;
  saldo: number;
  measured_source: string;
  tasks_l6: MeasurementTaskL6Row[];
  monthly_measurements: MeasurementMonthlyCol[];
  monthly_map: Record<string, number>;
}

export interface SCurveData {
  labels: string[];
  baseline_accum_pcts: number[];
  realized_accum_pcts: (number | null)[];
  realized_month_vals: (number | null)[];
  replan_month_vals: number[];
  replan_month_pcts: number[];
  replan_accum_vals: number[];
  replan_accum_pcts: number[];
}

export interface PhysicalFinancialCalculationResult {
  projectName: string;
  totalBudget: number;
  totalMeasured: number;
  totalMeasuredPct: number;
  totalBalance: number;
  totalBalancePct: number;
  cutoffMedNum: number;
  cutoffDate: string;
  cycleConfig: {
    startDay: number;
    endDay: number;
  };
  cycles: MeasurementCycle[];
  sCurve: SCurveData;
  tabDistribuicao: PhysicalFinancialRow[];
  tabFisicoFinanceiro: PhysicalFinancialRow[];
  tabMedicao: MeasurementGridRow[];
  tabReplanejado: PhysicalFinancialRow[];
  tabFfReplanejado: PhysicalFinancialRow[];
}

// -------------------------------------------------------------
// Funções Utilitárias de Data e Calendário Útil (Segunda a Sexta)
// -------------------------------------------------------------

export function isWorkdayDate(dateStr: string): boolean {
  if (!dateStr || dateStr.length < 10) return false;
  const d = new Date(dateStr.slice(0, 10) + 'T12:00:00Z');
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

export function parseISODate(dateStr: string): Date {
  const clean = dateStr.slice(0, 10);
  return new Date(clean + 'T12:00:00Z');
}

export function formatISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDaysISO(dateStr: string, days: number): string {
  const d = parseISODate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatISODate(d);
}

export function countWorkdaysBetween(startStr: string, endStr: string): number {
  if (!startStr || !endStr || endStr < startStr) return 0;
  let count = 0;
  let cur = startStr;
  while (cur <= endStr) {
    if (isWorkdayDate(cur)) {
      count++;
    }
    cur = addDaysISO(cur, 1);
  }
  return Math.max(1, count);
}

export function getWorkdaysInsideWindow(
  taskStart: string,
  taskEnd: string,
  winStart: string,
  winEnd: string
): number {
  if (!taskStart || !taskEnd || !winStart || !winEnd) return 0;
  const s = taskStart > winStart ? taskStart : winStart;
  const e = taskEnd < winEnd ? taskEnd : winEnd;
  if (e < s) return 0;
  let count = 0;
  let cur = s;
  while (cur <= e) {
    if (isWorkdayDate(cur)) count++;
    cur = addDaysISO(cur, 1);
  }
  return count;
}

const PT_MONTHS_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export function formatCycleMonthLabel(d: Date): string {
  const m = PT_MONTHS_SHORT[d.getUTCMonth()];
  const y = String(d.getUTCFullYear()).slice(2);
  return `${m}/${y}`;
}

export function getDaysInMonth(year: number, monthZeroIndexed: number): number {
  return new Date(Date.UTC(year, monthZeroIndexed + 1, 0)).getUTCDate();
}

/**
 * Gera lista de ciclos mensais de medição.
 * Se cycleStartDay <= 1: dia 1 ao último dia do mês corrente.
 * Se cycleStartDay > 1: dia 21 do mês M-1 ao dia 20 do mês M.
 */
export function generateCycles(
  startDateStr: string,
  endDateStr: string,
  cycleStartDay: number = 21,
  cycleEndDay: number = 20,
  cutoffMedNum: number = 1,
  maxMonths: number = 60
): MeasurementCycle[] {
  let startDay = cycleStartDay;
  let endDay = cycleEndDay;

  if (startDay <= 1) {
    startDay = 1;
    endDay = 31;
  } else {
    endDay = startDay - 1;
  }

  const sDate = parseISODate(startDateStr || '2025-01-01');
  const eDate = parseISODate(endDateStr || '2028-12-31');

  const cycles: MeasurementCycle[] = [];
  let currYear = sDate.getUTCFullYear();
  let currMonth = sDate.getUTCMonth(); // 0-indexed

  for (let i = 1; i <= maxMonths; i++) {
    let cStartStr = '';
    let cEndStr = '';
    let labelDate: Date;

    if (startDay === 1) {
      const daysInM = getDaysInMonth(currYear, currMonth);
      cStartStr = `${currYear}-${String(currMonth + 1).padStart(2, '0')}-01`;
      cEndStr = `${currYear}-${String(currMonth + 1).padStart(2, '0')}-${String(daysInM).padStart(2, '0')}`;
      labelDate = parseISODate(cEndStr);
    } else {
      // Mês anterior para início do ciclo
      const prevD = new Date(Date.UTC(currYear, currMonth - 1, 1));
      const pY = prevD.getUTCFullYear();
      const pM = prevD.getUTCMonth();
      const daysInPrev = getDaysInMonth(pY, pM);
      const actualStartDay = Math.min(startDay, daysInPrev);
      cStartStr = `${pY}-${String(pM + 1).padStart(2, '0')}-${String(actualStartDay).padStart(2, '0')}`;

      // Mês corrente para término do ciclo
      const daysInCurr = getDaysInMonth(currYear, currMonth);
      const actualEndDay = Math.min(endDay, daysInCurr);
      cEndStr = `${currYear}-${String(currMonth + 1).padStart(2, '0')}-${String(actualEndDay).padStart(2, '0')}`;
      labelDate = parseISODate(cEndStr);
    }

    const periodLabel = formatCycleMonthLabel(labelDate);
    cycles.push({
      num: i,
      name: `Mês ${i}`,
      period_label: periodLabel,
      full_label: `Mês ${i} (${periodLabel})`,
      start: cStartStr,
      end: cEndStr,
      is_past: i <= cutoffMedNum,
    });

    const cEndDate = parseISODate(cEndStr);
    if (cEndDate >= eDate && i >= cutoffMedNum + 2) {
      break;
    }

    // Avança 1 mês
    currMonth++;
    if (currMonth > 11) {
      currMonth = 0;
      currYear++;
    }
  }

  return cycles;
}

// -------------------------------------------------------------
// Ordenação canônica da EAP (1, 1.1, 1.1.1, 1.2, 1.10...)
// -------------------------------------------------------------
export function compareWbsCodes(aCode: string, bCode: string): number {
  if (aCode === '1' || aCode === '01') return -1;
  if (bCode === '1' || bCode === '01') return 1;

  const aParts = aCode.split('.').map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p : n;
  });
  const bParts = bCode.split('.').map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p : n;
  });

  const maxLen = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < maxLen; i++) {
    const a = aParts[i];
    const b = bParts[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') {
      if (a !== b) return a - b;
    } else {
      const cmp = String(a).localeCompare(String(b));
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// -------------------------------------------------------------
// Motor Central de Execução dos Cálculos
// -------------------------------------------------------------

export interface RunPhysicalFinancialParams {
  projectName?: string;
  budgetItems: BudgetItem[];
  scheduleTasks: any[]; // LobActivity[] ou cronogramaInicial[]
  cycleStartDay?: number;
  cycleEndDay?: number;
  cutoffMedNum?: number;
  customMeasurementsMonthly?: Record<string, Record<string, number>>; // eapCode -> { "1": 5.0, "2": 10.0 }
  customMeasurementsL6Monthly?: Record<string, Record<string, Record<string, number>>>; // eapCode -> { taskId -> { "1": 10.0 } }
  customReplanWeights?: Record<string, Record<string, number>>; // eapCode -> { taskId -> weight }
}

export function runPhysicalFinancialCalculation(
  params: RunPhysicalFinancialParams
): PhysicalFinancialCalculationResult {
  const {
    budgetItems,
    scheduleTasks,
    cycleStartDay = 21,
    cycleEndDay = 20,
    cutoffMedNum = 1,
    customMeasurementsMonthly = {},
    customMeasurementsL6Monthly = {},
    customReplanWeights = {},
  } = params;

  // 1. Mapear tarefas do cronograma por ID e por nome
  const tasksById = new Map<string, any>();
  const tasksByName = new Map<string, any>();
  const allTaskStarts: string[] = [];
  const allTaskEnds: string[] = [];

  for (const t of scheduleTasks) {
    const tid = String(t.id || t.tarefaId || '');
    const tname = String(t.name || t.serviceName || t.descricao || '').trim();
    if (tid) tasksById.set(tid, t);
    if (tname) tasksByName.set(tname.toLowerCase(), t);

    const s = t.startDate || t.start || t.inicio;
    const f = t.endDate || t.finish || t.fim;
    if (s && s.length >= 10) allTaskStarts.push(s.slice(0, 10));
    if (f && f.length >= 10) allTaskEnds.push(f.slice(0, 10));
  }

  // Define datas limites da obra
  allTaskStarts.sort();
  allTaskEnds.sort();
  const projStart = allTaskStarts[0] || formatISODate(new Date());
  const projEnd = allTaskEnds[allTaskEnds.length - 1] || projStart;

  // 2. Gerar ciclos de medição
  const cycles = generateCycles(
    projStart,
    projEnd,
    cycleStartDay,
    cycleEndDay,
    cutoffMedNum
  );

  const safeCutoffIdx = Math.min(cutoffMedNum - 1, cycles.length - 1);
  const cutoffCycle = cycles[safeCutoffIdx] || cycles[0];
  const cutoffDate = cutoffCycle.end;
  const pastCycles = cycles.filter((c) => c.is_past);
  const futureCycles = cycles.filter((c) => !c.is_past);

  // 3. Orçamento Total do Projeto (Nível 1 ou soma dos N5)
  let rootBudget = 0;
  let sumL5Budget = 0;
  for (const b of budgetItems) {
    if (b.level === 1 && b.totalCost > 0) rootBudget = b.totalCost;
    if (b.level === 5) sumL5Budget += b.totalCost;
  }
  const totalProjBudget = rootBudget > 0 ? rootBudget : Math.max(0, sumL5Budget);

  // 4. DISTRIBUIÇÃO (NÍVEL 6 & PESOS)
  const tabDistribuicao: PhysicalFinancialRow[] = [];
  const l5BaselineCycleVals: Record<string, Record<string, number>> = {};

  // Ordena itens do orçamento por código EAP
  const sortedBudget = [...budgetItems].sort((a, b) => compareWbsCodes(a.eapCode, b.eapCode));

  for (const item of sortedBudget) {
    if (item.level !== 5) continue;

    const bVal = item.totalCost || 0;
    const linkedIds = item.linkedScheduleIds || [];
    const childRows: PhysicalFinancialRow[] = [];

    // Busca detalhes das tarefas vinculadas
    const linkedTasks: Array<{
      id: string;
      name: string;
      duration: number;
      startDate: string;
      endDate: string;
      customWeight?: number;
    }> = [];

    for (const lid of linkedIds) {
      const t = tasksById.get(lid) || tasksByName.get(lid.toLowerCase());
      if (t) {
        const s = t.startDate || t.start || t.inicio || projStart;
        const f = t.endDate || t.finish || t.fim || s;
        const dur = t.duration || countWorkdaysBetween(s, f);
        const cw = item.weights?.[lid] ?? customReplanWeights[item.eapCode]?.[lid];
        linkedTasks.push({
          id: lid,
          name: t.name || t.serviceName || lid,
          duration: Math.max(1, dur),
          startDate: s,
          endDate: f,
          customWeight: cw,
        });
      }
    }

    const totalDur = linkedTasks.reduce((acc, lt) => acc + lt.duration, 0);
    const hasCustomWeights = linkedTasks.some((lt) => lt.customWeight !== undefined && lt.customWeight > 0);
    const sumCustomWeights = linkedTasks.reduce((acc, lt) => acc + (lt.customWeight || 0), 0);

    const l5CycleVals: Record<string, number> = {};
    for (const c of cycles) l5CycleVals[String(c.num)] = 0;

    linkedTasks.forEach((lt, idx) => {
      let weightPct = 0;
      if (hasCustomWeights && sumCustomWeights > 0) {
        weightPct = ((lt.customWeight || 0) / sumCustomWeights) * 100;
      } else if (totalDur > 0) {
        weightPct = (lt.duration / totalDur) * 100;
      }

      const allocatedVal = bVal * (weightPct / 100);
      const tCycleVals: Record<string, number> = {};
      const tCyclePctsService: Record<string, number> = {};
      const tCyclePctsObra: Record<string, number> = {};

      // Conta os dias úteis da tarefa em cada ciclo de medição
      const totalTaskWorkdays = countWorkdaysBetween(lt.startDate, lt.endDate);

      for (const cy of cycles) {
        const workdaysInCycle = getWorkdaysInsideWindow(lt.startDate, lt.endDate, cy.start, cy.end);
        let cyVal = 0;
        if (workdaysInCycle > 0 && totalTaskWorkdays > 0) {
          cyVal = allocatedVal * (workdaysInCycle / totalTaskWorkdays);
        }
        tCycleVals[String(cy.num)] = cyVal;
        l5CycleVals[String(cy.num)] = (l5CycleVals[String(cy.num)] || 0) + cyVal;

        tCyclePctsService[String(cy.num)] = allocatedVal > 0 ? (cyVal / allocatedVal) * 100 : 0;
        tCyclePctsObra[String(cy.num)] = totalProjBudget > 0 ? (cyVal / (totalProjBudget || 1)) * 100 : 0;
      }

      const tTotal = Object.values(tCycleVals).reduce((a, b) => a + b, 0);

      childRows.push({
        level: 6,
        code: `${item.eapCode}.${String(idx + 1).padStart(3, '0')}`,
        parent_code: item.eapCode,
        description: lt.name,
        duration: lt.duration,
        weight_pct: Math.round(weightPct * 100) / 100,
        allocated_val: Math.round(allocatedVal * 100) / 100,
        budget: allocatedVal,
        budget_pct: totalProjBudget > 0 ? (allocatedVal / (totalProjBudget || 1)) * 100 : 0,
        cycle_vals: tCycleVals,
        cycle_pcts: tCyclePctsObra,
        cycle_pcts_service: tCyclePctsService,
        cycle_pcts_obra: tCyclePctsObra,
        total: Math.round(tTotal * 100) / 100,
        total_pct: allocatedVal > 0 ? (tTotal / allocatedVal) * 100 : 0,
        total_pct_service: allocatedVal > 0 ? (tTotal / allocatedVal) * 100 : 0,
        total_pct_obra: totalProjBudget > 0 ? (tTotal / (totalProjBudget || 1)) * 100 : 0,
      });
    });

    l5BaselineCycleVals[item.eapCode] = l5CycleVals;
    const l5Total = Object.values(l5CycleVals).reduce((a, b) => a + b, 0);

    const l5CyclePctsService: Record<string, number> = {};
    const l5CyclePctsObra: Record<string, number> = {};
    for (const cy of cycles) {
      const v = l5CycleVals[String(cy.num)] || 0;
      l5CyclePctsService[String(cy.num)] = bVal > 0 ? (v / bVal) * 100 : 0;
      l5CyclePctsObra[String(cy.num)] = totalProjBudget > 0 ? (v / (totalProjBudget || 1)) * 100 : 0;
    }

    tabDistribuicao.push({
      level: 5,
      code: item.eapCode,
      parent_code: item.parentId,
      description: item.name,
      duration: totalDur,
      weight_pct: 100,
      allocated_val: bVal,
      budget: bVal,
      budget_pct: totalProjBudget > 0 ? (bVal / (totalProjBudget || 1)) * 100 : 0,
      cycle_vals: l5CycleVals,
      cycle_pcts: l5CyclePctsObra,
      cycle_pcts_service: l5CyclePctsService,
      cycle_pcts_obra: l5CyclePctsObra,
      total: Math.round(l5Total * 100) / 100,
      total_pct: bVal > 0 ? (l5Total / bVal) * 100 : 0,
      total_pct_service: bVal > 0 ? (l5Total / bVal) * 100 : 0,
      total_pct_obra: totalProjBudget > 0 ? (l5Total / (totalProjBudget || 1)) * 100 : 0,
    });

    tabDistribuicao.push(...childRows);
  }

  // 5. FÍSICO-FINANCEIRO BASELINE (Rollup EAP Níveis 5 -> 4 -> 3 -> 2 -> 1)
  const ffTree: Record<string, PhysicalFinancialRow> = {};

  for (const item of sortedBudget) {
    const b = item.totalCost || 0;
    const initialCycles: Record<string, number> = {};
    for (const cy of cycles) initialCycles[String(cy.num)] = 0;

    ffTree[item.eapCode] = {
      level: item.level,
      code: item.eapCode,
      parent_code: item.parentId,
      description: item.name,
      budget: b,
      budget_pct: totalProjBudget > 0 ? (b / (totalProjBudget || 1)) * 100 : 0,
      cycle_vals: initialCycles,
      total: 0,
      total_pct: 0,
    };
  }

  // Insere os valores calculados de Nível 5
  for (const [code, cVals] of Object.entries(l5BaselineCycleVals)) {
    if (ffTree[code]) {
      ffTree[code].cycle_vals = { ...cVals };
    }
  }

  // Rollup bottom-up: Nível 4, depois 3, depois 2, depois 1
  for (const lvl of [4, 3, 2, 1]) {
    const parentNodes = Object.values(ffTree).filter((it) => it.level === lvl);
    for (const p of parentNodes) {
      // Filhos diretos na hierarquia EAP (prefixo ou parent_code)
      const children = Object.values(ffTree).filter((c) => {
        if (c.parent_code && c.parent_code === p.code) return true;
        return c.level === lvl + 1 && c.code.startsWith(p.code + '.');
      });

      if (children.length > 0) {
        if (p.budget <= 0) {
          p.budget = children.reduce((acc, c) => acc + c.budget, 0);
          p.budget_pct = totalProjBudget > 0 ? (p.budget / (totalProjBudget || 1)) * 100 : 0;
        }

        for (const cy of cycles) {
          const cyKey = String(cy.num);
          p.cycle_vals[cyKey] = children.reduce((acc, c) => acc + (c.cycle_vals[cyKey] || 0), 0);
        }
      }
    }
  }

  // Monta tabFisicoFinanceiro final com percentuais e totais
  const tabFisicoFinanceiro: PhysicalFinancialRow[] = [];
  for (const code of Object.keys(ffTree).sort(compareWbsCodes)) {
    const node = ffTree[code];
    const cVals = node.cycle_vals;
    const cPcts: Record<string, number> = {};
    let rowTot = 0;
    for (const cy of cycles) {
      const v = cVals[String(cy.num)] || 0;
      rowTot += v;
      cPcts[String(cy.num)] = totalProjBudget > 0 ? (v / (totalProjBudget || 1)) * 100 : 0;
    }
    node.total = Math.round(rowTot * 100) / 100;
    node.total_pct = totalProjBudget > 0 ? (rowTot / (totalProjBudget || 1)) * 100 : 0;
    node.cycle_pcts = cPcts;
    tabFisicoFinanceiro.push(node);
  }

  // 6. BASE MEDIÇÃO (N5 + N6 MULTINÍVEL COM HISTÓRICO BLINDADO ATÉ O CORTE)
  const l5MonthlyMeasurements: Record<string, Record<number, number>> = {};
  const l6MonthlyMeasurements: Record<string, Record<string, Record<number, number>>> = {};

  for (const item of sortedBudget) {
    if (item.level !== 5) continue;
    const code = item.eapCode;
    const linkedIds = item.linkedScheduleIds || [];
    l5MonthlyMeasurements[code] = {};
    l6MonthlyMeasurements[code] = {};

    for (const cy of cycles) {
      const cNum = cy.num;
      let hasL6Val = false;
      let l6WeightedSum = 0;

      for (const lid of linkedIds) {
        if (!l6MonthlyMeasurements[code][lid]) l6MonthlyMeasurements[code][lid] = {};
        let tVal = 0;

        // Verifica inputs manuais de nível 6
        if (customMeasurementsL6Monthly[code]?.[lid]?.[String(cNum)] !== undefined) {
          hasL6Val = true;
          const raw = customMeasurementsL6Monthly[code][lid][String(cNum)];
          tVal = raw > 1 ? raw / 100 : raw;
        } else {
          // Valor previsto no ciclo baseline como fallback de medição
          const cyVal = l5BaselineCycleVals[code]?.[String(cNum)] || 0;
          tVal = item.totalCost > 0 ? cyVal / item.totalCost : 0;
        }

        l6MonthlyMeasurements[code][lid][cNum] = Math.max(0, Math.min(1, tVal));
        l6WeightedSum += tVal / (linkedIds.length || 1);
      }

      if (hasL6Val) {
        l5MonthlyMeasurements[code][cNum] = Math.max(0, Math.min(1, l6WeightedSum));
      } else if (customMeasurementsMonthly[code]?.[String(cNum)] !== undefined) {
        const raw = customMeasurementsMonthly[code][String(cNum)];
        const v = raw > 1 ? raw / 100 : raw;
        l5MonthlyMeasurements[code][cNum] = Math.max(0, Math.min(1, v));
      } else {
        // Fallback: se passado do corte ou sem medição, usa previsto da baseline
        const cyVal = l5BaselineCycleVals[code]?.[String(cNum)] || 0;
        const v = item.totalCost > 0 ? cyVal / item.totalCost : 0;
        l5MonthlyMeasurements[code][cNum] = Math.max(0, Math.min(1, v));
      }
    }
  }

  // Prepara árvore de medição (medTree)
  const medTree: Record<string, MeasurementGridRow> = {};

  for (const item of sortedBudget) {
    const bVal = item.totalCost || 0;
    const code = item.eapCode;

    if (item.level === 5) {
      const mVals = l5MonthlyMeasurements[code] || {};
      // Acumulado realizado somado estritamente até a medição de corte
      let calcAccumPct = 0;
      for (let m = 1; m <= cutoffMedNum; m++) {
        calcAccumPct += mVals[m] || 0;
      }
      const accumPct = Math.min(1.0, Math.max(0.0, calcAccumPct));
      const accumVal = bVal * accumPct;
      const saldo = Math.max(0.0, bVal - accumVal);

      // Colunas mensais
      const monthlyCols: MeasurementMonthlyCol[] = cycles.map((cy) => {
        const cNum = cy.num;
        const rPct = mVals[cNum] || 0;
        const bPct = bVal > 0 ? ((l5BaselineCycleVals[code]?.[String(cNum)] || 0) / bVal) * 100 : 0;
        return {
          med_num: cNum,
          cycle_name: cy.name,
          previsto_pct: Math.round(bPct * 100) / 100,
          realizado_pct: Math.round(rPct * 10000) / 100,
          realizado_val: Math.round(bVal * rPct * 100) / 100,
        };
      });

      const monthlyMap: Record<string, number> = {};
      monthlyCols.forEach((mc) => {
        monthlyMap[String(mc.med_num)] = mc.realizado_pct;
      });

      // Tarefas L6 filhas
      const tasksL6List: MeasurementTaskL6Row[] = (item.linkedScheduleIds || []).map((lid) => {
        const t = tasksById.get(lid) || tasksByName.get(lid.toLowerCase());
        const tDur = t?.duration || 1;
        const tMonthly: Record<string, number> = {};
        let tAccum = 0;
        for (const cy of cycles) {
          const v = (l6MonthlyMeasurements[code]?.[lid]?.[cy.num] || 0) * 100;
          tMonthly[String(cy.num)] = Math.round(v * 100) / 100;
          if (cy.num <= cutoffMedNum) tAccum += v;
        }

        return {
          task_name: t?.name || lid,
          task_id: lid,
          duration: tDur,
          weight_pct: Math.round((100 / (item.linkedScheduleIds?.length || 1)) * 100) / 100,
          measured_pct: Math.min(100, Math.round(tAccum * 100) / 100),
          monthly_measurements: tMonthly,
        };
      });

      medTree[code] = {
        level: 5,
        code,
        parent_code: item.parentId,
        description: item.name,
        unit: item.unit,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        total_price: bVal,
        accum_realizado_pct: Math.round(accumPct * 10000) / 100,
        accum_realizado_val: Math.round(accumVal * 100) / 100,
        saldo: Math.round(saldo * 100) / 100,
        measured_source: 'input',
        tasks_l6: tasksL6List,
        monthly_measurements: monthlyCols,
        monthly_map: monthlyMap,
      };
    } else {
      medTree[code] = {
        level: item.level,
        code,
        parent_code: item.parentId,
        description: item.name,
        unit: item.unit,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        total_price: bVal,
        accum_realizado_pct: 0,
        accum_realizado_val: 0,
        saldo: bVal,
        measured_source: 'rollup',
        tasks_l6: [],
        monthly_measurements: cycles.map((cy) => ({
          med_num: cy.num,
          cycle_name: cy.name,
          previsto_pct: 0,
          realizado_pct: 0,
          realizado_val: 0,
        })),
        monthly_map: {},
      };
    }
  }

  // Rollup de Medição para níveis 4, 3, 2, 1
  for (const lvl of [4, 3, 2, 1]) {
    const parentNodes = Object.values(medTree).filter((it) => it.level === lvl);
    for (const p of parentNodes) {
      const children = Object.values(medTree).filter((c) => {
        if (c.parent_code && c.parent_code === p.code) return true;
        return c.level === lvl + 1 && c.code.startsWith(p.code + '.');
      });

      if (children.length > 0) {
        if (p.total_price <= 0) {
          p.total_price = children.reduce((acc, c) => acc + c.total_price, 0);
        }
        const totRealVal = children.reduce((acc, c) => acc + c.accum_realizado_val, 0);
        p.accum_realizado_val = Math.round(totRealVal * 100) / 100;
        p.accum_realizado_pct = p.total_price > 0 ? Math.round((totRealVal / p.total_price) * 10000) / 100 : 0;
        p.saldo = Math.round(Math.max(0, p.total_price - totRealVal) * 100) / 100;

        for (let idx = 0; idx < cycles.length; idx++) {
          const sumMVal = children.reduce((acc, c) => acc + (c.monthly_measurements[idx]?.realizado_val || 0), 0);
          p.monthly_measurements[idx].realizado_val = Math.round(sumMVal * 100) / 100;
          const pPct = p.total_price > 0 ? Math.round((sumMVal / p.total_price) * 10000) / 100 : 0;
          p.monthly_measurements[idx].realizado_pct = pPct;
          p.monthly_map[String(cycles[idx].num)] = pPct;
        }
      }
    }
  }

  const tabMedicao = Object.keys(medTree)
    .sort(compareWbsCodes)
    .map((k) => medTree[k]);

  // 7. REPLANEJADO (SALDO REDISTRIBUÍDO A NÍVEL 6 NAS TAREFAS FUTURAS)
  const l5ReplanCycleVals: Record<string, Record<string, number>> = {};
  const tabReplanejado: PhysicalFinancialRow[] = [];
  let totalMeasuredL5 = 0;
  let totalBalanceL5 = 0;

  for (const item of sortedBudget) {
    if (item.level !== 5) continue;
    const code = item.eapCode;
    const bVal = item.totalCost || 0;
    const medRow = medTree[code];
    const medVal = medRow ? medRow.accum_realizado_val : 0;
    const medPct = bVal > 0 ? medVal / bVal : 0;
    const saldo = Math.max(0.0, bVal - medVal);

    totalMeasuredL5 += medVal;
    totalBalanceL5 += saldo;

    const l5Cycles: Record<string, number> = {};
    for (const cy of cycles) l5Cycles[String(cy.num)] = 0;

    // Passado: estritamente blindado com os valores medidos
    for (const pCy of pastCycles) {
      const cNum = pCy.num;
      const mPct = (medRow?.monthly_map[String(cNum)] || 0) / 100;
      l5Cycles[String(cNum)] = bVal * mPct;
    }

    // Futuro: redistribui saldo estritamente sobre as tarefas que terminam após o corte
    const linkedIds = item.linkedScheduleIds || [];
    const validFutureTasks: Array<{
      id: string;
      name: string;
      weight: number;
      futureWorkdays: number;
      startDate: string;
      endDate: string;
    }> = [];

    for (const lid of linkedIds) {
      const t = tasksById.get(lid) || tasksByName.get(lid.toLowerCase());
      if (t) {
        const s = t.startDate || t.start || t.inicio || projStart;
        const f = t.endDate || t.finish || t.fim || s;
        // Tarefa futura se seu término é estritamente posterior à data de corte
        if (f > cutoffDate) {
          const futDays = getWorkdaysInsideWindow(s, f, addDaysISO(cutoffDate, 1), f);
          const dur = t.duration || countWorkdaysBetween(s, f);
          validFutureTasks.push({
            id: lid,
            name: t.name || t.serviceName || lid,
            weight: Math.max(1, dur),
            futureWorkdays: futDays,
            startDate: s,
            endDate: f,
          });
        }
      }
    }

    const totalFutWorkdays = validFutureTasks.reduce((acc, vt) => acc + vt.futureWorkdays, 0);
    const totalFutWeight = validFutureTasks.reduce((acc, vt) => acc + vt.weight, 0);
    const childReplanRows: PhysicalFinancialRow[] = [];

    if (validFutureTasks.length > 0 && saldo > 0) {
      validFutureTasks.forEach((vt, idx) => {
        // Peso futuro proporcional aos dias úteis restantes
        const wPct = totalFutWorkdays > 0
          ? (vt.futureWorkdays / totalFutWorkdays) * 100
          : (vt.weight / (totalFutWeight || 1)) * 100;

        const taskSaldo = saldo * (wPct / 100);
        const tRepCycles: Record<string, number> = {};
        for (const cy of cycles) tRepCycles[String(cy.num)] = 0;

        for (const fCy of futureCycles) {
          const cyFutDays = getWorkdaysInsideWindow(vt.startDate, vt.endDate, fCy.start, fCy.end);
          if (cyFutDays > 0 && vt.futureWorkdays > 0) {
            const cyVal = taskSaldo * (cyFutDays / vt.futureWorkdays);
            tRepCycles[String(fCy.num)] = cyVal;
            l5Cycles[String(fCy.num)] = (l5Cycles[String(fCy.num)] || 0) + cyVal;
          }
        }

        const tSum = Object.values(tRepCycles).reduce((a, b) => a + b, 0);

        childReplanRows.push({
          level: 6,
          code: `${code}.${String(idx + 1).padStart(3, '0')}`,
          parent_code: code,
          description: vt.name,
          budget: taskSaldo,
          budget_pct: totalProjBudget > 0 ? (taskSaldo / (totalProjBudget || 1)) * 100 : 0,
          saldo: Math.round(taskSaldo * 100) / 100,
          saldo_pct: bVal > 0 ? (taskSaldo / bVal) * 100 : 0,
          saldo_pct_obra: totalProjBudget > 0 ? (taskSaldo / (totalProjBudget || 1)) * 100 : 0,
          duration: vt.weight,
          weight_pct: Math.round(wPct * 100) / 100,
          allocated_val: Math.round(taskSaldo * 100) / 100,
          cycle_vals: tRepCycles,
          cycle_pcts_service: Object.fromEntries(
            cycles.map((cy) => [String(cy.num), bVal > 0 ? (tRepCycles[String(cy.num)] / bVal) * 100 : 0])
          ),
          cycle_pcts_obra: Object.fromEntries(
            cycles.map((cy) => [String(cy.num), totalProjBudget > 0 ? (tRepCycles[String(cy.num)] / (totalProjBudget || 1)) * 100 : 0])
          ),
          total: Math.round(tSum * 100) / 100,
          total_pct: bVal > 0 ? (tSum / bVal) * 100 : 0,
          total_pct_service: bVal > 0 ? (tSum / bVal) * 100 : 0,
          total_pct_obra: totalProjBudget > 0 ? (tSum / (totalProjBudget || 1)) * 100 : 0,
        });
      });
    } else if (saldo > 0 && futureCycles.length > 0) {
      // Se não há tarefas futuras ativas, divide igualmente nos primeiros ciclos futuros
      const chunkLen = Math.min(6, futureCycles.length);
      const chunkVal = saldo / chunkLen;
      for (let i = 0; i < chunkLen; i++) {
        const cNum = String(futureCycles[i].num);
        l5Cycles[cNum] = (l5Cycles[cNum] || 0) + chunkVal;
      }
    }

    l5ReplanCycleVals[code] = l5Cycles;
    const l5Tot = Object.values(l5Cycles).reduce((a, b) => a + b, 0);

    tabReplanejado.push({
      level: 5,
      code,
      parent_code: item.parentId,
      description: item.name,
      budget: bVal,
      budget_pct: totalProjBudget > 0 ? (bVal / (totalProjBudget || 1)) * 100 : 0,
      med_val: Math.round(medVal * 100) / 100,
      med_pct: Math.round(medPct * 10000) / 100,
      saldo: Math.round(saldo * 100) / 100,
      saldo_pct: bVal > 0 ? Math.round((saldo / bVal) * 10000) / 100 : 0,
      saldo_pct_obra: totalProjBudget > 0 ? Math.round((saldo / (totalProjBudget || 1)) * 10000) / 100 : 0,
      weight_pct: 100,
      allocated_val: saldo,
      cycle_vals: l5Cycles,
      cycle_pcts_service: Object.fromEntries(
        cycles.map((cy) => [String(cy.num), bVal > 0 ? (l5Cycles[String(cy.num)] / bVal) * 100 : 0])
      ),
      cycle_pcts_obra: Object.fromEntries(
        cycles.map((cy) => [String(cy.num), totalProjBudget > 0 ? (l5Cycles[String(cy.num)] / (totalProjBudget || 1)) * 100 : 0])
      ),
      total: Math.round(l5Tot * 100) / 100,
      total_pct: bVal > 0 ? (l5Tot / bVal) * 100 : 0,
      total_pct_service: bVal > 0 ? (l5Tot / bVal) * 100 : 0,
      total_pct_obra: totalProjBudget > 0 ? (l5Tot / (totalProjBudget || 1)) * 100 : 0,
    });

    tabReplanejado.push(...childReplanRows);
  }

  // 8. FÍSICO-FINANCEIRO REPLANEJADO CONSOLIDADO (Rollup EAP Níveis 5 -> 4 -> 3 -> 2 -> 1)
  const ffRepTree: Record<string, PhysicalFinancialRow> = {};

  for (const item of sortedBudget) {
    const b = item.totalCost || 0;
    const initialCycles: Record<string, number> = {};
    for (const cy of cycles) initialCycles[String(cy.num)] = 0;

    ffRepTree[item.eapCode] = {
      level: item.level,
      code: item.eapCode,
      parent_code: item.parentId,
      description: item.name,
      budget: b,
      budget_pct: totalProjBudget > 0 ? (b / (totalProjBudget || 1)) * 100 : 0,
      med_val: 0,
      med_pct: 0,
      saldo: b,
      cycle_vals: initialCycles,
      total: 0,
      total_pct: 0,
    };
  }

  // Insere os valores calculados de Nível 5
  for (const [code, cVals] of Object.entries(l5ReplanCycleVals)) {
    if (ffRepTree[code]) {
      ffRepTree[code].cycle_vals = { ...cVals };
      const medRow = medTree[code];
      const mVal = medRow ? medRow.accum_realizado_val : 0;
      ffRepTree[code].med_val = mVal;
      ffRepTree[code].med_pct = ffRepTree[code].budget > 0 ? (mVal / ffRepTree[code].budget) * 100 : 0;
      ffRepTree[code].saldo = Math.max(0, ffRepTree[code].budget - mVal);
    }
  }

  // Rollup bottom-up: Nível 4, 3, 2, 1
  for (const lvl of [4, 3, 2, 1]) {
    const parentNodes = Object.values(ffRepTree).filter((it) => it.level === lvl);
    for (const p of parentNodes) {
      const children = Object.values(ffRepTree).filter((c) => {
        if (c.parent_code && c.parent_code === p.code) return true;
        return c.level === lvl + 1 && c.code.startsWith(p.code + '.');
      });

      if (children.length > 0) {
        if (p.budget <= 0) {
          p.budget = children.reduce((acc, c) => acc + c.budget, 0);
          p.budget_pct = totalProjBudget > 0 ? (p.budget / (totalProjBudget || 1)) * 100 : 0;
        }
        p.med_val = children.reduce((acc, c) => acc + (c.med_val || 0), 0);
        p.med_pct = p.budget > 0 ? (p.med_val / p.budget) * 100 : 0;
        p.saldo = Math.max(0, p.budget - p.med_val);

        for (const cy of cycles) {
          const cyKey = String(cy.num);
          p.cycle_vals[cyKey] = children.reduce((acc, c) => acc + (c.cycle_vals[cyKey] || 0), 0);
        }
      }
    }
  }

  const tabFfReplanejado: PhysicalFinancialRow[] = [];
  for (const code of Object.keys(ffRepTree).sort(compareWbsCodes)) {
    const node = ffRepTree[code];
    const cVals = node.cycle_vals;
    const cPcts: Record<string, number> = {};
    let rowTot = 0;
    for (const cy of cycles) {
      const v = cVals[String(cy.num)] || 0;
      rowTot += v;
      cPcts[String(cy.num)] = totalProjBudget > 0 ? (v / (totalProjBudget || 1)) * 100 : 0;
    }
    node.total = Math.round(rowTot * 100) / 100;
    node.total_pct = totalProjBudget > 0 ? (rowTot / (totalProjBudget || 1)) * 100 : 0;
    node.cycle_pcts = cPcts;
    tabFfReplanejado.push(node);
  }

  // 9. CURVA S (Previsto Baseline vs Realizado Medido vs Replanejado Futuro)
  const rootBaseline = ffTree['1'] || ffTree['01'] || tabFisicoFinanceiro[0];
  const rootReplan = ffRepTree['1'] || ffRepTree['01'] || tabFfReplanejado[0];

  const labels = cycles.map((c) => c.full_label);

  // Curva Baseline Acumulada (%)
  const baselineAccumPcts: number[] = [];
  let bRun = 0;
  for (const cy of cycles) {
    const v = rootBaseline?.cycle_vals[String(cy.num)] || 0;
    bRun += v;
    baselineAccumPcts.push(Math.round(Math.min(100, (bRun / (totalProjBudget || 1)) * 100) * 100) / 100);
  }

  // Curva Replanejada Mensal e Acumulada
  const replanMonthVals: number[] = [];
  const replanMonthPcts: number[] = [];
  const replanAccumVals: number[] = [];
  const replanAccumPcts: number[] = [];
  let rRun = 0;
  for (const cy of cycles) {
    const v = rootReplan?.cycle_vals[String(cy.num)] || 0;
    rRun += v;
    replanMonthVals.push(Math.round(v * 100) / 100);
    replanMonthPcts.push(Math.round((v / (totalProjBudget || 1)) * 10000) / 100);
    replanAccumVals.push(Math.round(rRun * 100) / 100);
    replanAccumPcts.push(Math.round(Math.min(100, (rRun / (totalProjBudget || 1)) * 100) * 100) / 100);
  }

  // Curva Realizada (Medições passadas até o corte)
  const realizedMonthVals: (number | null)[] = [];
  const realizedAccumPcts: (number | null)[] = [];
  let mRun = 0;
  for (const cy of cycles) {
    if (cy.is_past) {
      const v = rootReplan?.cycle_vals[String(cy.num)] || 0;
      mRun += v;
      realizedMonthVals.push(Math.round(v * 100) / 100);
      realizedAccumPcts.push(Math.round(Math.min(100, (mRun / (totalProjBudget || 1)) * 100) * 100) / 100);
    } else {
      realizedMonthVals.push(null);
      realizedAccumPcts.push(null);
    }
  }

  const sCurve: SCurveData = {
    labels,
    baseline_accum_pcts: baselineAccumPcts,
    realized_accum_pcts: realizedAccumPcts,
    realized_month_vals: realizedMonthVals,
    replan_month_vals: replanMonthVals,
    replan_month_pcts: replanMonthPcts,
    replan_accum_vals: replanAccumVals,
    replan_accum_pcts: replanAccumPcts,
  };

  return {
    projectName: params.projectName || '',
    totalBudget: Math.round(totalProjBudget * 100) / 100,
    totalMeasured: Math.round(totalMeasuredL5 * 100) / 100,
    totalMeasuredPct: Math.round((totalMeasuredL5 / (totalProjBudget || 1)) * 10000) / 100,
    totalBalance: Math.round(totalBalanceL5 * 100) / 100,
    totalBalancePct: Math.round((totalBalanceL5 / (totalProjBudget || 1)) * 10000) / 100,
    cutoffMedNum,
    cutoffDate,
    cycleConfig: {
      startDay: cycleStartDay,
      endDay: cycleEndDay,
    },
    cycles,
    sCurve,
    tabDistribuicao,
    tabFisicoFinanceiro,
    tabMedicao,
    tabReplanejado,
    tabFfReplanejado,
  };
}
