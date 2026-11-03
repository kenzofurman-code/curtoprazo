import { cloudStorage } from './firebaseDocuments';
/**
 * Módulo de Orçamento, Vínculo com Cronograma e Ponderação de Pesos e Custos
 * Baseado no modelo Prevision (app/budget/index.html e WeightDistributorService).
 */

import type { LobActivity, LobActivityJob, ScheduleFloor, ScheduleServicePackage } from './longTermSchedule';

export type PonderationMode = 'equal' | 'time' | 'quantity' | 'area';

export interface BudgetItem {
  id: string;                      // e.g. "bgt_01_01_01_01_47"
  eapCode: string;                 // e.g. "01.01.01.01.47"
  name: string;                    // e.g. "PROJETO ELETRICA PROVISORIA"
  totalCost: number;               // e.g. 6057.56
  materialCost?: number;           // Material (R$)
  laborCost?: number;              // Mão de Obra (R$)
  unit?: string;                   // e.g. "m2", "un", "vb"
  quantity?: number;               // e.g. 1
  unitPrice?: number;              // e.g. 6057.56
  level: number;                   // 1..10
  parentId?: string;               // ID do item pai na EAP
  isLeaf: boolean;                 // true se não possui filhos
  linkedScheduleIds: string[];     // IDs de LobActivity ou LobActivityJob vinculados
  weights?: Record<string, number>; // scheduleId -> percentual (0..100)
  quantities?: Record<string, number>; // scheduleId -> quantidade física direta
}

export interface ProjectBudgetState {
  projectId: string;
  budgetName: string;
  totalCost: number;
  items: BudgetItem[];
  lastUpdated: string;
}

export interface LinkedScheduleItemDetail {
  id: string;                      // LobActivity.id ou LobActivityJob.id
  activityId: string;
  jobId?: string;
  name: string;
  floorName: string;
  floorId: string;
  serviceId: string;
  serviceName: string;
  serviceColor: string;
  duration: number;                // Dias úteis
  area: number;                    // m² do pavimento
  quantity: number;                // Quantidade física
  weight: number;                  // Percentual (0..100)
  cost: number;                    // R$ calculado
}

export interface BudgetLinkingRow {
  level?: number;
  eapCode: string;
  description: string;
  cost?: number;
  packageName: string;
  serviceName?: string;
  lotName: string;
  partName?: string;
  weightPercent: number;
}

/**
 * Normaliza o nome do lote/pavimento para compatibilidade entre cronograma e orçamento.
 * Ex: "Fachada D -- Sete - (07º-03º)" -> "Fachada D - (07º-03º)"
 */
export function normalizeLotName(lot: string): string {
  let s = (lot || '').trim();
  const m = s.match(/^Fachada\s+([A-D])\s*--?\s*.*?\s*-\s*(\(\d+º-\d+º\))$/i);
  if (m) {
    return `Fachada ${m[1].toUpperCase()} - ${m[2]}`;
  }
  return s;
}

/**
 * Converte strings formatadas com moeda, vírgulas e pontos em número float seguro.
 */
export function cleanBudgetNumber(val: any): number {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  let str = String(val).trim();
  if (str.includes('.') && str.includes(',')) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (str.includes(',')) {
    str = str.replace(',', '.');
  }
  str = str.replace(/[^\d.-]/g, '');
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

/**
 * 1. Ponderação Igualitária (=):
 * Distribui 100% igualmente entre N itens, ajustando o resíduo no último
 * para eliminar qualquer erro de arredondamento ou dízima periódica.
 */
export function distributeWeightsEqually(count: number): number[] {
  if (count <= 0) return [];
  const base = parseFloat((100 / count).toFixed(4));
  let accumulated = 0;
  const percentages: number[] = [];

  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      percentages.push(parseFloat((100 - accumulated).toFixed(4)));
    } else {
      percentages.push(base);
      accumulated += base;
    }
  }
  return percentages;
}

/**
 * 2. Ponderação por Tempo (Duração em Dias Úteis):
 * Distribui o peso proporcionalmente à duração de cada atividade no cronograma.
 */
export function distributeWeightsByTime(durations: number[]): number[] {
  const count = durations.length;
  if (count === 0) return [];
  const totalDuration = durations.reduce((acc, d) => acc + Math.max(0.5, d || 1), 0);
  if (totalDuration <= 0) return distributeWeightsEqually(count);

  let accumulated = 0;
  const percentages: number[] = [];

  for (let i = 0; i < count; i++) {
    const d = Math.max(0.5, durations[i] || 1);
    if (i === count - 1) {
      percentages.push(parseFloat((100 - accumulated).toFixed(4)));
    } else {
      const pct = parseFloat(((d / totalDuration) * 100).toFixed(4));
      percentages.push(pct);
      accumulated += pct;
    }
  }
  return percentages;
}

/**
 * 3. Ponderação por Quantidade Física:
 * Distribui proporcionalmente às quantidades digitadas pelo usuário para cada local.
 */
export function distributeWeightsByQuantity(quantities: number[]): number[] {
  const count = quantities.length;
  if (count === 0) return [];
  const totalQty = quantities.reduce((acc, q) => acc + Math.max(0, q || 0), 0);
  if (totalQty <= 0) return distributeWeightsEqually(count);

  let accumulated = 0;
  const percentages: number[] = [];

  for (let i = 0; i < count; i++) {
    const q = Math.max(0, quantities[i] || 0);
    if (i === count - 1) {
      percentages.push(parseFloat((100 - accumulated).toFixed(4)));
    } else {
      const pct = parseFloat(((q / totalQty) * 100).toFixed(4));
      percentages.push(pct);
      accumulated += pct;
    }
  }
  return percentages;
}

/**
 * 4. Ponderação por Área do Pavimento / Local:
 * Distribui proporcionalmente às áreas em m² dos pavimentos vinculados.
 */
export function distributeWeightsByArea(areas: number[]): number[] {
  const count = areas.length;
  if (count === 0) return [];
  const totalArea = areas.reduce((acc, a) => acc + Math.max(0.1, a || 0), 0);
  if (totalArea <= 0) return distributeWeightsEqually(count);

  let accumulated = 0;
  const percentages: number[] = [];

  for (let i = 0; i < count; i++) {
    const a = Math.max(0.1, areas[i] || 0);
    if (i === count - 1) {
      percentages.push(parseFloat((100 - accumulated).toFixed(4)));
    } else {
      const pct = parseFloat(((a / totalArea) * 100).toFixed(4));
      percentages.push(pct);
      accumulated += pct;
    }
  }
  return percentages;
}

/**
 * Validação da soma de pesos (tolerância de 0.02% para arredondamentos)
 */
export function validateWeightsSum(weights: number[]): {
  sum: number;
  isValid: boolean;
  delta: number;
} {
  const sum = parseFloat(weights.reduce((acc, w) => acc + (w || 0), 0).toFixed(4));
  const delta = parseFloat((100 - sum).toFixed(4));
  const isValid = Math.abs(delta) <= 0.02;
  return { sum, isValid, delta };
}

/**
 * Gera um orçamento inicial automático a partir dos itens do cronograma ativo,
 * caso o projeto ainda não possua uma planilha de orçamento importada.
 */
export function generateInitialBudgetFromSchedule(
  projectId: string,
  activities: LobActivity[],
  services: ScheduleServicePackage[]
): ProjectBudgetState {
  if (!activities.length && !services.length) {
    return { projectId, budgetName: '', totalCost: 0, items: [], lastUpdated: new Date().toISOString() };
  }
  const serviceMap = new Map<string, ScheduleServicePackage>();
  services.forEach((s) => serviceMap.set(s.id, s));

  const costByService = new Map<string, { totalCost: number; actIds: string[] }>();
  let grandTotalCost = 0;

  activities.forEach((act) => {
    const cost = Number(act.cost) || 0;
    grandTotalCost += cost;
    const entry = costByService.get(act.serviceId) || { totalCost: 0, actIds: [] };
    entry.totalCost += cost;
    entry.actIds.push(act.id);
    costByService.set(act.serviceId, entry);
  });

  const items: BudgetItem[] = [];

  // Nível 1: Obra Geral
  const rootId = `bgt_${projectId}_01`;
  items.push({
    id: rootId,
    eapCode: '01',
    name: 'OBRA TOTAL - ORÇAMENTO EXECUTIVO',
    totalCost: grandTotalCost,
    level: 1,
    isLeaf: false,
    linkedScheduleIds: [],
  });

  // Nível 2: Pacotes de Trabalho como macro-etapas
  services.forEach((svc, sIdx) => {
    const code = `01.${String(sIdx + 1).padStart(2, '0')}`;
    const sId = `bgt_${projectId}_${code.replace(/\./g, '_')}`;
    const info = costByService.get(svc.id) || { totalCost: svc.defaultTotalCost || 0, actIds: [] };

    const weights: Record<string, number> = {};
    if (info.actIds.length > 0) {
      const equalWeights = distributeWeightsEqually(info.actIds.length);
      info.actIds.forEach((id, idx) => {
        weights[id] = equalWeights[idx];
      });
    }

    items.push({
      id: sId,
      eapCode: code,
      name: svc.name,
      totalCost: info.totalCost,
      level: 2,
      parentId: rootId,
      isLeaf: true,
      linkedScheduleIds: info.actIds,
      weights,
    });
  });

  return {
    projectId,
    budgetName: 'Orçamento Executivo do Projeto',
    totalCost: grandTotalCost,
    items,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Propaga a ponderação de pesos e custos do orçamento de volta para as
 * atividades e sub-tarefas da Linha de Balanço e para a matriz de pesos (weights).
 */
export function applyBudgetWeightsToSchedule(
  budgetState: ProjectBudgetState,
  activities: LobActivity[],
  floors: ScheduleFloor[],
  services: ScheduleServicePackage[],
  existingWeights: Record<string, Record<string, number>> = {}
): {
  updatedActivities: LobActivity[];
  updatedWeights: Record<string, Record<string, number>>;
} {
  const floorById = new Map<string, ScheduleFloor>();
  floors.forEach((f) => floorById.set(f.id, f));

  const serviceById = new Map<string, ScheduleServicePackage>();
  services.forEach((s) => serviceById.set(s.id, s));

  const assignedActivityCosts = new Map<string, number>();

  budgetState.items.forEach((item) => {
    if (!item.isLeaf || !item.weights || item.linkedScheduleIds.length === 0) return;

    item.linkedScheduleIds.forEach((schedId) => {
      const weightPct = item.weights?.[schedId] || 0;
      const allocatedCost = parseFloat(((weightPct / 100) * item.totalCost).toFixed(2));
      const cur = assignedActivityCosts.get(schedId) || 0;
      assignedActivityCosts.set(schedId, cur + allocatedCost);
    });
  });

  const updatedWeights = { ...existingWeights };

  const updatedActivities = activities.map((act) => {
    const budgetCost = assignedActivityCosts.get(act.id);
    if (budgetCost === undefined) return act;

    const floor = floorById.get(act.floorId);
    const service = serviceById.get(act.serviceId);

    let updatedJobs = (act.jobs || []).map((j) => ({ ...j }));
    if (updatedJobs.length > 0) {
      const oldTotalJobsCost = updatedJobs.reduce((acc, j) => acc + (Number(j.cost) || 0), 0);
      if (oldTotalJobsCost > 0) {
        updatedJobs = updatedJobs.map((j) => ({
          ...j,
          cost: parseFloat((((Number(j.cost) || 0) / oldTotalJobsCost) * budgetCost).toFixed(2)),
        }));
      } else {
        const equalJobsPct = distributeWeightsEqually(updatedJobs.length);
        updatedJobs = updatedJobs.map((j, idx) => ({
          ...j,
          cost: parseFloat(((equalJobsPct[idx] / 100) * budgetCost).toFixed(2)),
        }));
      }
    }

    if (floor && service) {
      if (!updatedWeights[floor.name]) updatedWeights[floor.name] = {};
      const macroKey = service.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (budgetCost > 0) {
        updatedWeights[floor.name][macroKey] = parseFloat((budgetCost / 1000).toFixed(4));
      }
    }

    return {
      ...act,
      cost: budgetCost,
      jobs: updatedJobs,
    };
  });

  return {
    updatedActivities,
    updatedWeights,
  };
}

/**
 * Converte matriz de linhas de arquivo Excel/CSV de Orçamento em BudgetItem[].
 * Suporta colunas: Nível, Código/EAP, Descrição, Material (R$), Mão de Obra (R$), Total (R$).
 */
export function parseBudgetRows(
  rows: any[][],
  projectId: string
): BudgetItem[] {
  if (!rows || rows.length < 2) return [];

  // Localiza cabeçalhos
  let headerIndex = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const rowStr = rows[i].map((c) => String(c || '').toLowerCase()).join(' ');
    if (
      rowStr.includes('eap') ||
      rowStr.includes('código') ||
      rowStr.includes('codigo') ||
      rowStr.includes('descri') ||
      rowStr.includes('total')
    ) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) headerIndex = 0;
  const header = rows[headerIndex].map((c) => String(c || '').trim().toLowerCase());

  const colLevel = header.findIndex((h) => h === 'nível' || h === 'nivel' || h === 'level');
  const colEap = header.findIndex((h) => h.includes('eap') || h.includes('código') || h.includes('codigo') || h.includes('item'));
  const colDesc = header.findIndex((h) => h.includes('descri') || h.includes('nome') || h.includes('serviço') || h.includes('servico'));
  const colMaterial = header.findIndex((h) => h.includes('material') || h === 'mat');
  const colLabor = header.findIndex((h) => h.includes('mão de obra') || h.includes('mao de obra') || h.includes('m.o.') || h === 'mo');
  let colTotal = header.findIndex((h) => h.includes('total'));
  if (colTotal === -1) {
    colTotal = header.findIndex((h) => (h.includes('valor') || h.includes('preço') || h.includes('preco') || h.includes('custo')) && !h.includes('unit'));
  }
  const colUnit = header.findIndex((h) => h.includes('unid') || h.includes('und') || h.includes('un'));
  const colQty = header.findIndex((h) => h.includes('quant') || h.includes('qtd'));
  const colUnitPrice = header.findIndex((h) => h.includes('unitário') || h.includes('unitario') || h.includes('unit'));

  const items: BudgetItem[] = [];

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const rawEap = colEap !== -1 ? String(row[colEap] || '').trim() : `${r}`;
    const rawDesc = colDesc !== -1 ? String(row[colDesc] || '').trim() : '';
    if (!rawDesc) continue;

    const materialCost = colMaterial !== -1 ? cleanBudgetNumber(row[colMaterial]) : undefined;
    const laborCost = colLabor !== -1 ? cleanBudgetNumber(row[colLabor]) : undefined;
    let totalCost = colTotal !== -1 ? cleanBudgetNumber(row[colTotal]) : 0;
    if (!totalCost && (materialCost !== undefined || laborCost !== undefined)) {
      totalCost = (materialCost || 0) + (laborCost || 0);
    }

    const unit = colUnit !== -1 ? String(row[colUnit] || '').trim() : undefined;
    const qty = colQty !== -1 ? cleanBudgetNumber(row[colQty]) : undefined;
    const unitPrice = colUnitPrice !== -1 ? cleanBudgetNumber(row[colUnitPrice]) : undefined;

    let level = colLevel !== -1 && !isNaN(parseInt(row[colLevel]))
      ? parseInt(row[colLevel])
      : Math.max(1, (rawEap.match(/\./g) || []).length + 1);

    items.push({
      id: `bgt_${projectId}_${rawEap.replace(/[^a-zA-Z0-9]/g, '_') || r}`,
      eapCode: rawEap,
      name: rawDesc,
      totalCost,
      materialCost,
      laborCost,
      unit,
      quantity: qty,
      unitPrice,
      level,
      isLeaf: true,
      linkedScheduleIds: [],
    });
  }

  // Recalcula parentId e isLeaf
  items.forEach((item) => {
    const isParent = items.some((other) => other.eapCode.startsWith(item.eapCode + '.') && other.eapCode !== item.eapCode);
    item.isLeaf = !isParent;

    if (item.level > 1) {
      const lastDot = item.eapCode.lastIndexOf('.');
      if (lastDot > 0) {
        const parentCode = item.eapCode.slice(0, lastDot);
        const parent = items.find((p) => p.eapCode === parentCode);
        if (parent) item.parentId = parent.id;
      }
    }
  });

  return items;
}

/**
 * Converte matriz de linhas de arquivo Excel/CSV de Vínculos em BudgetLinkingRow[].
 * Suporta colunas: Nível, Código, Descrição, Custo, Pacote de trabalho/tarefas, Serviço, Lote, Parte, Peso (% Item).
 */
export function parseBudgetLinkingRows(rows: any[][]): BudgetLinkingRow[] {
  if (!rows || rows.length < 2) return [];

  let headerIndex = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const rowStr = rows[i].map((c) => String(c || '').toLowerCase()).join(' ');
    if (
      (rowStr.includes('código') || rowStr.includes('codigo') || rowStr.includes('eap')) &&
      (rowStr.includes('pacote') || rowStr.includes('lote') || rowStr.includes('serviço') || rowStr.includes('servico'))
    ) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) headerIndex = 0;
  const header = rows[headerIndex].map((c) => String(c || '').trim().toLowerCase());

  const colLevel = header.findIndex((h) => h === 'nível' || h === 'nivel' || h === 'level');
  const colCode = header.findIndex((h) => h.includes('código') || h.includes('codigo') || h.includes('eap') || h === 'code');
  const colDesc = header.findIndex((h) => h.includes('descri') || h.includes('nome') || h === 'item');
  const colCost = header.findIndex((h) => h.includes('custo') || h.includes('total') || h.includes('valor'));
  const colPkg = header.findIndex((h) => h.includes('pacote') || h.includes('macro'));
  const colSrv = header.findIndex((h) => h.includes('serviço') || h.includes('servico') || h.includes('tarefa'));
  const colLot = header.findIndex((h) => h.includes('lote') || h.includes('pavimento') || h.includes('local') || h === 'floor');
  const colPart = header.findIndex((h) => h.includes('parte') || h.includes('setor'));
  const colWeight = header.findIndex((h) => h.includes('peso') || h.includes('%') || h.includes('percentual'));

  const linkRows: BudgetLinkingRow[] = [];

  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const rawCode = colCode !== -1 ? String(row[colCode] || '').trim() : '';
    if (!rawCode) continue;

    const rawPkg = colPkg !== -1 ? String(row[colPkg] || '').trim() : '';
    const rawLot = colLot !== -1 ? String(row[colLot] || '').trim() : '';
    if (!rawPkg && !rawLot) continue;

    const rawDesc = colDesc !== -1 ? String(row[colDesc] || '').trim() : '';
    const rawSrv = colSrv !== -1 ? String(row[colSrv] || '').trim() : '-';
    const rawPart = colPart !== -1 ? String(row[colPart] || '').trim() : '-';
    const weightVal = colWeight !== -1 ? cleanBudgetNumber(row[colWeight]) : 100;
    const costVal = colCost !== -1 ? cleanBudgetNumber(row[colCost]) : undefined;
    const levelVal = colLevel !== -1 && !isNaN(parseInt(row[colLevel])) ? parseInt(row[colLevel]) : undefined;

    linkRows.push({
      level: levelVal,
      eapCode: rawCode,
      description: rawDesc,
      cost: costVal,
      packageName: rawPkg,
      serviceName: rawSrv,
      lotName: rawLot,
      partName: rawPart,
      weightPercent: weightVal,
    });
  }

  return linkRows;
}

/**
 * Aplica uma lista de vínculos importados diretamente aos itens de orçamento existentes
 * e mapeia para as atividades da Linha de Balanço e tarefas do Cronograma.
 */
export function applyImportedLinksToBudget(
  currentBudget: ProjectBudgetState,
  linkRows: BudgetLinkingRow[],
  activities: LobActivity[],
  floors: ScheduleFloor[],
  services: ScheduleServicePackage[]
): {
  updatedBudget: ProjectBudgetState;
  matchedCount: number;
  unmatchedCount: number;
  unmatchedList: { code: string; pkg: string; lot: string; desc: string }[];
} {
  const floorById = new Map(floors.map((f) => [f.id, f]));
  const serviceById = new Map(services.map((s) => [s.id, s]));

  // Mapa rápido de busca das atividades: [pacote:::lote] -> activityId
  const scheduleLookup = new Map<string, string>();

  activities.forEach((act) => {
    const flr = floorById.get(act.floorId);
    const svc = serviceById.get(act.serviceId);
    if (!flr || !svc) return;

    const pkgName = svc.name.trim().toLowerCase();
    const flrName = flr.name.trim().toLowerCase();
    const flrNorm = normalizeLotName(flr.name).trim().toLowerCase();

    // Indexação por pacote e lote
    scheduleLookup.set(`${pkgName}:::${flrName}`, act.id);
    scheduleLookup.set(`${pkgName}:::${flrNorm}`, act.id);

    // Indexação por sub-tarefas (jobs)
    (act.jobs || []).forEach((j) => {
      const jName = j.name.trim().toLowerCase();
      scheduleLookup.set(`${jName}:::${flrName}`, act.id);
      scheduleLookup.set(`${jName}:::${flrNorm}`, act.id);
      scheduleLookup.set(`${pkgName}:::${jName}:::${flrName}`, act.id);
      scheduleLookup.set(`${pkgName}:::${jName}:::${flrNorm}`, act.id);
    });
  });

  // Agrupamento dos vínculos por código EAP
  const budgetByCode = new Map<string, BudgetItem>();
  const updatedItems = currentBudget.items.map((it) => {
    const copy = {
      ...it,
      linkedScheduleIds: [...(it.linkedScheduleIds || [])],
      weights: { ...(it.weights || {}) },
    };
    budgetByCode.set(copy.eapCode, copy);
    return copy;
  });

  let matchedCount = 0;
  let unmatchedCount = 0;
  const unmatchedList: { code: string; pkg: string; lot: string; desc: string }[] = [];

  linkRows.forEach((link) => {
    const budgetItem = budgetByCode.get(link.eapCode);
    if (!budgetItem) {
      unmatchedCount++;
      unmatchedList.push({
        code: link.eapCode,
        pkg: link.packageName,
        lot: link.lotName,
        desc: link.description,
      });
      return;
    }

    const pkgKey = link.packageName.trim().toLowerCase();
    const srvKey = (link.serviceName || '').trim().toLowerCase();
    const lotOrig = link.lotName.trim().toLowerCase();
    const lotNorm = normalizeLotName(link.lotName).trim().toLowerCase();

    const key1 = `${pkgKey}:::${lotNorm}`;
    const key2 = `${pkgKey}:::${lotOrig}`;
    const key3 = srvKey !== '-' ? `${srvKey}:::${lotNorm}` : null;
    const key4 = srvKey !== '-' ? `${srvKey}:::${lotOrig}` : null;
    const key5 = srvKey !== '-' ? `${pkgKey}:::${srvKey}:::${lotNorm}` : null;
    const key6 = srvKey !== '-' ? `${pkgKey}:::${srvKey}:::${lotOrig}` : null;

    const actId =
      scheduleLookup.get(key1) ||
      scheduleLookup.get(key2) ||
      (key3 ? scheduleLookup.get(key3) : null) ||
      (key4 ? scheduleLookup.get(key4) : null) ||
      (key5 ? scheduleLookup.get(key5) : null) ||
      (key6 ? scheduleLookup.get(key6) : null);

    if (actId) {
      matchedCount++;
      if (!budgetItem.linkedScheduleIds.includes(actId)) {
        budgetItem.linkedScheduleIds.push(actId);
      }
      budgetItem.weights = budgetItem.weights || {};
      const currentW = budgetItem.weights[actId] || 0;
      budgetItem.weights[actId] = parseFloat((currentW + link.weightPercent).toFixed(4));
    } else {
      unmatchedCount++;
      unmatchedList.push({
        code: link.eapCode,
        pkg: link.packageName,
        lot: link.lotName,
        desc: link.description,
      });
    }
  });

  return {
    updatedBudget: {
      ...currentBudget,
      items: updatedItems,
      lastUpdated: new Date().toISOString(),
    },
    matchedCount,
    unmatchedCount,
    unmatchedList,
  };
}

/**
 * Retorna o estado efetivo do orçamento de um projeto (dados salvos ou valores derivados do cronograma real).
 */
export function getEffectiveBudgetState(
  projectId: string,
  activities: LobActivity[] = [],
  floors: ScheduleFloor[] = [],
  services: ScheduleServicePackage[] = []
): ProjectBudgetState {
  try {
    const saved = cloudStorage.getItem(`curtoprazo_budget_${projectId}`);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.items)) {
        return parsed;
      }
    }
  } catch (_) {}

  return generateInitialBudgetFromSchedule(projectId, activities, services);
}

