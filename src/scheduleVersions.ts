/**
 * Gestão de Versões de Cronograma e Linha de Base (Baseline)
 * Permite congelar, alternar e definir a Linha de Base Oficial da Obra,
 * comparando o cronograma ativo com a baseline na Linha de Balanço e no Físico-Financeiro.
 */

import { getLocalDocData, setLocalDocData } from './localDatabase';

export interface ScheduleVersionSnapshot {
  cronogramaInicial: any[];
  floors: string[];
  allFloorsData: Record<string, any>;
  weights?: Record<string, Record<string, number>>;
  teams?: string[];
  matrices?: any[];
}

export type ScheduleVersionType = 'baseline' | 'scenario' | 'meta' | 'backup' | 'forecast';

export interface ScheduleVersion {
  id: string;
  name: string;
  description?: string;
  type?: ScheduleVersionType;
  author?: string;
  createdAt: string;
  isBaseline: boolean;
  isActive: boolean;
  snapshot: ScheduleVersionSnapshot;
  // Campos de rastreabilidade e histórico de importação
  sourceFileName?: string;
  referenceDate?: string;
  totalActivities?: number;
  totalFloors?: number;
  notes?: string;
}

const STORAGE_PREFIX = 'curtoprazo_schedule_versions_';

export function getScheduleVersionsDocId(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId || 'projeto_principal'}`;
}

export function loadScheduleVersions(projectId: string, fallbackSnapshot?: ScheduleVersionSnapshot): ScheduleVersion[] {
  const docId = getScheduleVersionsDocId(projectId);
  const data = getLocalDocData(docId);

  if (Array.isArray(data) && data.length > 0) {
    return data;
  }

  // Se ainda não existir nenhuma versão salva, cria a versão inicial padrão (Linha de Base Inicial)
  if (fallbackSnapshot && fallbackSnapshot.cronogramaInicial && fallbackSnapshot.cronogramaInicial.length > 0) {
    const defaultBaseline: ScheduleVersion = {
      id: 'versao_baseline_inicial',
      name: 'Linha de Base Inicial (Oficial)',
      description: 'Versão inicial congelada como Linha de Base de referência da obra.',
      type: 'baseline',
      author: 'Planejamento Inicial',
      createdAt: new Date().toISOString(),
      isBaseline: true,
      isActive: true,
      snapshot: {
        cronogramaInicial: JSON.parse(JSON.stringify(fallbackSnapshot.cronogramaInicial)),
        floors: [...(fallbackSnapshot.floors || [])],
        allFloorsData: JSON.parse(JSON.stringify(fallbackSnapshot.allFloorsData || {})),
        weights: fallbackSnapshot.weights ? JSON.parse(JSON.stringify(fallbackSnapshot.weights)) : {},
        teams: fallbackSnapshot.teams ? [...fallbackSnapshot.teams] : [],
        matrices: fallbackSnapshot.matrices ? JSON.parse(JSON.stringify(fallbackSnapshot.matrices)) : [],
      },
    };

    saveScheduleVersions(projectId, [defaultBaseline]);
    return [defaultBaseline];
  }

  return [];
}

export function saveScheduleVersions(projectId: string, versions: ScheduleVersion[]): void {
  const docId = getScheduleVersionsDocId(projectId);
  setLocalDocData(docId, versions);
}

export function createNewScheduleVersion(
  projectId: string,
  name: string,
  description: string,
  isBaseline: boolean,
  snapshot: ScheduleVersionSnapshot,
  options?: {
    type?: ScheduleVersionType;
    author?: string;
    sourceFileName?: string;
    referenceDate?: string;
    totalActivities?: number;
    totalFloors?: number;
    notes?: string;
  }
): { versions: ScheduleVersion[]; created: ScheduleVersion } {
  const existing = loadScheduleVersions(projectId, snapshot);
  const newId = `ver_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const versionType = options?.type || (isBaseline ? 'baseline' : 'forecast');

  let updatedList = existing.map((v) => {
    return {
      ...v,
      isBaseline: isBaseline ? false : v.isBaseline,
      isActive: false,
    };
  });

  const created: ScheduleVersion = {
    id: newId,
    name: name.trim() || `Versão ${updatedList.length + 1}`,
    description: description.trim(),
    type: versionType,
    author: options?.author?.trim() || 'Usuário Atual',
    createdAt: new Date().toISOString(),
    isBaseline,
    isActive: true,
    sourceFileName: options?.sourceFileName,
    referenceDate: options?.referenceDate,
    totalActivities: options?.totalActivities,
    totalFloors: options?.totalFloors,
    notes: options?.notes,
    snapshot: {
      cronogramaInicial: JSON.parse(JSON.stringify(snapshot.cronogramaInicial || [])),
      floors: [...(snapshot.floors || [])],
      allFloorsData: JSON.parse(JSON.stringify(snapshot.allFloorsData || {})),
      weights: snapshot.weights ? JSON.parse(JSON.stringify(snapshot.weights)) : {},
      teams: snapshot.teams ? [...snapshot.teams] : [],
      matrices: snapshot.matrices ? JSON.parse(JSON.stringify(snapshot.matrices)) : [],
    },
  };

  updatedList.unshift(created);
  saveScheduleVersions(projectId, updatedList);
  return { versions: updatedList, created };
}

export function setVersionAsBaseline(projectId: string, versionId: string): ScheduleVersion[] {
  const existing = loadScheduleVersions(projectId);
  const updated = existing.map((v) => ({
    ...v,
    isBaseline: v.id === versionId,
    type: v.id === versionId ? ('baseline' as ScheduleVersionType) : v.type,
  }));
  saveScheduleVersions(projectId, updated);
  return updated;
}

export function activateScheduleVersion(
  projectId: string,
  versionId: string
): { versions: ScheduleVersion[]; active: ScheduleVersion | null } {
  const existing = loadScheduleVersions(projectId);
  let activeVersion: ScheduleVersion | null = null;

  const updated = existing.map((v) => {
    if (v.id === versionId) {
      activeVersion = v;
      return { ...v, isActive: true };
    }
    return { ...v, isActive: false };
  });

  saveScheduleVersions(projectId, updated);
  return { versions: updated, active: activeVersion };
}

export function deleteScheduleVersion(projectId: string, versionId: string): ScheduleVersion[] {
  const existing = loadScheduleVersions(projectId);
  // Protege a versão se for a única ou se for a baseline
  if (existing.length <= 1) return existing;

  const target = existing.find((v) => v.id === versionId);
  if (!target || target.isBaseline) return existing;

  let updated = existing.filter((v) => v.id !== versionId);
  if (target.isActive && updated.length > 0) {
    updated[0].isActive = true;
  }
  saveScheduleVersions(projectId, updated);
  return updated;
}

export function promoteScenarioToOfficial(
  projectId: string,
  scenarioId: string
): { versions: ScheduleVersion[]; active: ScheduleVersion | null } {
  const existing = loadScheduleVersions(projectId);
  const scenario = existing.find((v) => v.id === scenarioId);
  if (!scenario) return { versions: existing, active: null };

  const officialId = `ver_${Date.now()}_oficial`;
  const officialVersion: ScheduleVersion = {
    id: officialId,
    name: `${scenario.name.replace(/\(Cenário.*?\)/gi, '').trim()} (Previsto Oficial)`,
    description: `Promovido a Previsto Oficial a partir do cenário: "${scenario.name}". ${scenario.description || ''}`.trim(),
    type: 'forecast',
    author: scenario.author || 'Engenharia',
    createdAt: new Date().toISOString(),
    isBaseline: false,
    isActive: true,
    snapshot: JSON.parse(JSON.stringify(scenario.snapshot)),
  };

  const updatedList = existing.map((v) => ({ ...v, isActive: false }));
  updatedList.unshift(officialVersion);
  saveScheduleVersions(projectId, updatedList);
  return { versions: updatedList, active: officialVersion };
}

export function getBaselineVersion(projectId: string): ScheduleVersion | null {
  const versions = loadScheduleVersions(projectId);
  return versions.find((v) => v.isBaseline) || versions[0] || null;
}
