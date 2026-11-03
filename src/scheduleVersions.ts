import { initializeVersionList, readVersionList, updateVersionList, versionStorageKey } from './scheduleVersionStorage';
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
  origin?: 'import' | 'snapshot' | 'promotion';
  referenceDate?: string;
  totalActivities?: number;
  totalFloors?: number;
  notes?: string;
}


const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export const getScheduleVersionsDocId = (projectId: string) => 'curtoprazo_schedule_versions_' + (projectId || 'projeto_principal');

export async function loadScheduleVersions(projectId: string, fallbackSnapshot?: ScheduleVersionSnapshot): Promise<ScheduleVersion[]> {
  const key = versionStorageKey(projectId);
  const existing = await readVersionList(key);
  if (existing.length || !fallbackSnapshot?.cronogramaInicial?.length) return existing;
  return initializeVersionList(key, {
    id: 'versao_baseline_inicial', name: 'Linha de Base Inicial (Oficial)',
    description: 'Versão inicial congelada como Linha de Base de referência da obra.',
    type: 'baseline', author: 'Planejamento Inicial', createdAt: new Date().toISOString(),
    isBaseline: true, isActive: true, snapshot: clone(fallbackSnapshot)
  });
}
export async function saveScheduleVersions(projectId: string, versions: ScheduleVersion[]): Promise<void> {
  await updateVersionList(versionStorageKey(projectId), () => clone(versions));
}
export async function createNewScheduleVersion(
  projectId: string, name: string, description: string, isBaseline: boolean, snapshot: ScheduleVersionSnapshot,
  options?: { type?: ScheduleVersionType; author?: string; sourceFileName?: string; referenceDate?: string; totalActivities?: number; totalFloors?: number; notes?: string; makeActive?: boolean }
): Promise<{ versions: ScheduleVersion[]; created: ScheduleVersion }> {
  let created: ScheduleVersion;
  const versions = await updateVersionList(versionStorageKey(projectId), existing => {
    created = {
      id: 'ver_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
      name: name.trim() || 'Versão ' + (existing.length + 1), description: description.trim(),
      type: options?.type || (isBaseline ? 'baseline' : 'forecast'), author: options?.author?.trim() || 'Usuário Atual',
      createdAt: new Date().toISOString(), isBaseline, isActive: options?.makeActive !== false,
      sourceFileName: options?.sourceFileName, referenceDate: options?.referenceDate,
      origin: options?.sourceFileName ? 'import' : 'snapshot',
      totalActivities: options?.totalActivities, totalFloors: options?.totalFloors, notes: options?.notes,
      snapshot: clone({ cronogramaInicial: snapshot.cronogramaInicial || [], floors: snapshot.floors || [],
        allFloorsData: snapshot.allFloorsData || {}, weights: snapshot.weights || {}, teams: snapshot.teams || [], matrices: snapshot.matrices || [] })
    };
    // First import creates one version; it does not clone the same import into a second baseline.
    return [created, ...existing.map(v => ({ ...v, isBaseline: isBaseline ? false : v.isBaseline, isActive: created.isActive ? false : v.isActive }))];
  });
  return { versions, created };
}
export async function setVersionAsBaseline(projectId: string, versionId: string): Promise<ScheduleVersion[]> {
  return updateVersionList(versionStorageKey(projectId), existing => {
    if (!existing.some(v => v.id === versionId)) throw new Error('Versão não encontrada. Recarregue o histórico.');
    return existing.map(v => ({ ...v, isBaseline: v.id === versionId, type: v.id === versionId ? 'baseline' : v.type }));
  });
}
export async function activateScheduleVersion(projectId: string, versionId: string): Promise<{ versions: ScheduleVersion[]; active: ScheduleVersion | null }> {
  const versions = await updateVersionList(versionStorageKey(projectId), existing => {
    if (!existing.some(v => v.id === versionId)) throw new Error('Versão não encontrada. Recarregue o histórico.');
    return existing.map(v => ({ ...v, isActive: v.id === versionId }));
  });
  return { versions, active: versions.find(v => v.id === versionId) || null };
}
export async function deleteScheduleVersion(projectId: string, versionId: string): Promise<ScheduleVersion[]> {
  return updateVersionList(versionStorageKey(projectId), existing => {
    if (!existing.some(v => v.id === versionId)) throw new Error('Versão não encontrada. Recarregue o histórico.');
    return existing.filter(v => v.id !== versionId);
  });
}
export async function deactivateScheduleVersion(projectId: string, versionId: string): Promise<ScheduleVersion[]> {
  return updateVersionList(versionStorageKey(projectId), existing => {
    if (!existing.some(v => v.id === versionId)) throw new Error('Versão não encontrada. Recarregue o histórico.');
    return existing.map(v => v.id === versionId ? { ...v, isActive: false } : v);
  });
}
export async function promoteScenarioToOfficial(projectId: string, scenarioId: string): Promise<{ versions: ScheduleVersion[]; active: ScheduleVersion | null }> {
  let active: ScheduleVersion | null = null;
  const versions = await updateVersionList(versionStorageKey(projectId), existing => {
    const scenario = existing.find(v => v.id === scenarioId);
    if (!scenario) return existing;
    active = { ...scenario, id: 'ver_' + Date.now() + '_oficial_' + Math.random().toString(36).slice(2, 9),
      name: scenario.name.replace(/\(Cenário.*?\)/gi, '').trim() + ' (Previsto Oficial)',
      description: 'Promovido a Previsto Oficial a partir do cenário: "' + scenario.name + '". ' + (scenario.description || ''),
      type: 'forecast', origin: 'promotion', author: scenario.author || 'Engenharia', createdAt: new Date().toISOString(), isBaseline: false, isActive: true, snapshot: clone(scenario.snapshot) };
    return [active, ...existing.map(v => ({ ...v, isActive: false }))];
  });
  return { versions, active };
}
export async function getBaselineVersion(projectId: string): Promise<ScheduleVersion | null> {
  const versions = await loadScheduleVersions(projectId);
  return versions.find(v => v.isBaseline) || null;
}
