import type { ScheduleVersion } from './scheduleVersions';
const slugify = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '_')
  .replace(/^_+|_+$/g, '') || 'sem_nome';

const clampPercent = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
};

const roundPercentValue = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(clampPercent(n) * 1000) / 1000;
};

const getBudgetFamilyKey = (item) => `${item?.floor || ''}||${slugify(item?.macro || item?.sectionId || '')}`;

export const isParentBudgetItem = (item) => {
  if (!item) return false;
  if (item.isParent !== undefined) return !!item.isParent;
  return slugify(item.service || item.activityName || '') === slugify(item.macro || item.sectionId || '');
};

export const getFamiliesWithBudgetChildren = (items) => new Set(
  (Array.isArray(items) ? items : [])
    .filter(item => item && !isParentBudgetItem(item))
    .map(item => getBudgetFamilyKey(item))
);

export const buildBudgetDiffs = (previousItems, nextItems, fileName = '') => {
  if (!Array.isArray(previousItems) || previousItems.length === 0 || !Array.isArray(nextItems)) return [];

  const importId = `budget_${Date.now()}`;
  const importedAt = new Date().toISOString();
  const previousById = new Map();
  const nextById = new Map();
  const nextFamiliesWithChildren = getFamiliesWithBudgetChildren(nextItems);

  previousItems.forEach(item => {
    if (item?.id) previousById.set(item.id, item);
  });
  nextItems.forEach(item => {
    if (item?.id) nextById.set(item.id, item);
  });

  const diffs = [];

  nextItems.forEach(item => {
    if (!item?.id) return;
    if (isParentBudgetItem(item) && nextFamiliesWithChildren.has(getBudgetFamilyKey(item))) return;

    const previous = previousById.get(item.id);
    const previousProgress = previous ? roundPercentValue(previous.progress || 0) : 0;
    const newProgress = roundPercentValue(item.progress || 0);
    const delta = Math.round((newProgress - previousProgress) * 1000) / 1000;
    const isNew = !previous;

    if (!isNew && Math.abs(delta) < 0.001) return;
    if (isNew && newProgress <= 0) return;

    diffs.push({
      id: `${importId}_${slugify(item.id)}`,
      importId,
      importedAt,
      fileName,
      kind: isNew ? 'new' : (delta > 0 ? 'progress_increase' : 'progress_decrease'),
      itemId: item.id,
      floor: item.floor,
      macro: item.macro,
      sectionId: slugify(item.macro),
      service: item.service,
      responsible: item.responsible,
      start: item.start,
      end: item.end,
      duration: item.duration,
      cost: item.cost,
      predecessors: item.predecessors || [],
      successors: item.successors || [],
      inheritedDependenciesFrom: item.inheritedDependenciesFrom || '',
      originalId: item.originalId || '',
      replicationGroup: item.replicationGroup || '',
      previousProgress,
      newProgress,
      delta
    });
  });

  previousItems.forEach(item => {
    if (!item?.id || nextById.has(item.id)) return;
    diffs.push({
      id: `${importId}_removed_${slugify(item.id)}`,
      importId,
      importedAt,
      fileName,
      kind: 'removed',
      itemId: item.id,
      floor: item.floor,
      macro: item.macro,
      sectionId: slugify(item.macro),
      service: item.service,
      responsible: item.responsible,
      predecessors: item.predecessors || [],
      successors: item.successors || [],
      inheritedDependenciesFrom: item.inheritedDependenciesFrom || '',
      originalId: item.originalId || '',
      replicationGroup: item.replicationGroup || '',
      previousProgress: roundPercentValue(item.progress || 0),
      newProgress: 0,
      delta: 0
    });
  });

  return diffs;
};

export function getLatestImportedVersion(versions: ScheduleVersion[]): ScheduleVersion | null {
  return versions.filter(v => v.origin === 'import' || (!v.origin && v.sourceFileName && !v.description?.startsWith('Promovido a Previsto Oficial a partir do cenário:')))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}

export function generatePlanningFromVersions(
  previous: ScheduleVersion, latest: ScheduleVersion, planning: any[], weekId: string,
  author: string, savedDiffs: any[] = []
) {
  if (!previous || !latest || previous.id === latest.id) throw new Error('Escolha uma versão diferente do último cronograma importado.');
  if (!previous.snapshot?.cronogramaInicial?.length || !latest.snapshot?.cronogramaInicial?.length) throw new Error('As duas versões precisam conter atividades para comparar.');
  if (planning.some(task => task.weekId === weekId && task.finalized)) throw new Error('A semana selecionada contém atividades finalizadas. Escolha uma semana aberta.');
  const applied = new Set([
    ...savedDiffs.filter(diff => diff.appliedWeekId).map(diff => diff.id),
    ...planning.flatMap(task => task.budgetDiffIds || [])
  ]);
  const weeklyIndex = new Map(planning.map((task, index) => ({task, index})).filter(({task}) => task.weekId === weekId).map(value => [value.task.itemId, value]));
  const diffKey = `schedule_diff_${encodeURIComponent(previous.id)}_${encodeURIComponent(latest.id)}_`;
  const diffs = buildBudgetDiffs(previous.snapshot.cronogramaInicial, latest.snapshot.cronogramaInicial, latest.sourceFileName || latest.name)
    .filter(diff => diff.delta > 0)
    .map(diff => ({ ...diff, id: diffKey + encodeURIComponent(diff.itemId), importId: diffKey, importedAt: latest.createdAt, previousVersionId: previous.id, targetVersionId: latest.id }))
    .filter(diff => {
      const task = weeklyIndex.get(diff.itemId)?.task;
      return !applied.has(diff.id) || (task?.targetVersionId === latest.id && task.previousVersionId !== previous.id);
    });
  const updatedPlanning = [...planning];
  const appliedInOtherWeeks = new Set(planning.filter(task => task.weekId !== weekId && task.targetVersionId === latest.id).map(task => task.itemId));
  const appliedAt = new Date().toISOString();
  for (const diff of diffs) {
    if (appliedInOtherWeeks.has(diff.itemId)) {
      throw new Error('Já existem avanços deste cronograma aplicados em outra semana. Revise os lançamentos antes de gerar novamente.');
    }
    const entry = weeklyIndex.get(diff.itemId);
    const existing = entry?.task;
    const fields = {
      executedBefore: diff.previousProgress, executedBeforeRaw: diff.previousProgress,
      comparisonPreviousProgress: diff.previousProgress, progressThisWeek: diff.newProgress,
      previousVersionId: previous.id, targetVersionId: latest.id, source: 'schedule-version-diff',
      budgetDiffIds: [...new Set([...(existing?.budgetDiffIds || []), diff.id])],
      lastUpdatedBy: author || 'Sistema'
    };
    if (existing) {
      updatedPlanning[entry.index] = { ...existing, ...fields };
    } else {
      updatedPlanning.push({
        id: crypto.randomUUID(), weekId, itemId: diff.itemId, floor: diff.floor,
        sectionId: diff.sectionId, activityName: diff.service, responsible: diff.responsible || 'Equipe Geral',
        weight: 100, plannedThisWeek: 0, finishDate: diff.end || weekId,
        dailyWork: [0, 0, 0, 0, 0], observations: 'Fora do planejado: avanço detectado entre versões de cronograma',
        delayReason: '', finalized: false, isUnplannedDetected: true,
        predecessors: diff.predecessors || [], successors: diff.successors || [],
        inheritedDependenciesFrom: diff.inheritedDependenciesFrom || '', originalId: diff.originalId || '', ...fields
      });
    }
  }
  const budgetDiffs = new Map(savedDiffs.map(diff => [diff.id, diff]));
  diffs.forEach(diff => budgetDiffs.set(diff.id, { ...diff, appliedWeekId: weekId, appliedAt }));
  return { planning: updatedPlanning, diffs, budgetDiffs: [...budgetDiffs.values()] };
}

