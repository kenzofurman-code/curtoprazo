type Task = Record<string, any>;

const percent = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
};
const previousProgress = (task: Task) => percent(task.executedBeforeRaw ?? task.executedBefore ?? 0);
const progress = (task: Task) => Math.max(previousProgress(task), percent(task.progressThisWeek ?? 0));
const remaining = (value: number) => Math.round((100 - value) * 1000) / 1000;
const activityKey = (task: Task) => JSON.stringify([task.floor, task.sectionId, task.itemId || task.id]);

export class ClosedNextWeekError extends Error {
  weekId: string;
  constructor(weekId: string) {
    super('A semana seguinte está finalizada. Reabra-a antes de ajustar os saldos.');
    this.weekId = weekId;
  }
}

export function reopenPlanningWeek({ planning, ppcHistory, weekId, actor, now }: {
  planning: Task[]; ppcHistory: Task[]; weekId: string; actor: string; now: string;
}) {
  const tasks = planning.filter(task => task.weekId === weekId);
  if (!tasks.length) throw new Error('Não há atividades nesta semana para reabrir.');
  const previous = ppcHistory.find(record => record.weekId === weekId);
  const planned = tasks.filter(task => (task.plannedThisWeek ?? 100) > 0);
  const completed = planned.filter(task => (task.progressThisWeek ?? 0) >= (task.plannedThisWeek ?? 100));
  const record = {
    ...(previous || {
      weekId, weekStart: weekId, ppc: planned.length ? completed.length / planned.length * 100 : 0,
      totalPlanned: planned.length, completed: completed.length, timestamp: tasks[0].finalizedAt || now
    }),
    isReopened: true, reopenedAt: previous?.isReopened ? previous.reopenedAt : now, reopenedBy: actor
  };
  return {
    planning: planning.map(task => task.weekId === weekId ? { ...task, finalized: false, lastUpdatedBy: actor } : task),
    ppcHistory: [...ppcHistory.filter(record => record.weekId !== weekId), record]
  };
}

export function finalizePlanningWeek({
  planning, ppcHistory, weekId, nextWeekId, carryOver, actor = 'Sistema', now, makeId
}: {
  planning: Task[]; ppcHistory: Task[]; weekId: string; nextWeekId: string;
  carryOver: boolean; actor?: string; now: string; makeId: () => string;
}) {
  const sources = planning.filter(task => task.weekId === weekId);
  if (!sources.length) throw new Error('Não há atividades nesta semana para finalizar.');
  const byKey = new Map<string, Task>();
  sources.forEach(task => {
    const key = activityKey(task);
    if (!byKey.has(key) || progress(task) > progress(byKey.get(key)!)) byKey.set(key, task);
  });
  const nextTasks = planning.filter(task => task.weekId === nextWeekId);
  const nextClosed = nextTasks.some(task => task.finalized) || ppcHistory.some(record => record.weekId === nextWeekId && !record.isReopened);
  const assertEditable = () => { if (nextClosed) throw new ClosedNextWeekError(nextWeekId); };
  const isAutomatic = (task: Task) => task.carriedFromWeekId === weekId || (
    !task.carriedFromWeekId && byKey.has(activityKey(task)) &&
    (task.isCarryOver || String(task.observations || '').startsWith('Saldo de'))
  );
  const hasNextWeekWork = (task: Task, source?: Task) => (
    Number(task.progressThisWeek || 0) > 0 || Number(task.efetivo || 0) > 0 ||
    !!String(task.observations || '').replace(/^Saldo de avanço físico reprogramado$/, '').trim() ||
    !!task.delayReason || task.preFilledProgress !== undefined ||
    (task.dailyWork || []).some(Boolean) ||
    Number(task.plannedThisWeek ?? 100) !== Number(task.carryOverPlannedTarget ?? remaining(previousProgress(task))) ||
    (!!source && task.responsible !== source.responsible)
  );

  const result: Task[] = [];
  const covered = new Set<string>();
  for (const task of planning) {
    if (task.weekId === weekId) {
      result.push({ ...task, finalized: true, finalizedAt: now, finalizedBy: actor, lastUpdatedBy: actor });
      continue;
    }
    if (task.weekId !== nextWeekId) { result.push(task); continue; }
    const key = activityKey(task);
    const source = byKey.get(key);
    const automatic = isAutomatic(task);
    if (!source) {
      if (automatic && !hasNextWeekWork(task)) assertEditable();
      else result.push(task);
      continue;
    }
    const finalProgress = progress(source);
    const worked = hasNextWeekWork(task, source);
    if (automatic && finalProgress >= 100 && !worked) {
      assertEditable();
      continue;
    }
    covered.add(key);
    const target = automatic && !worked ? remaining(finalProgress) : task.plannedThisWeek;
    if (previousProgress(task) !== finalProgress || target !== task.plannedThisWeek) {
      assertEditable();
      result.push({
        ...task, executedBefore: finalProgress, executedBeforeRaw: finalProgress,
        ...(automatic ? { plannedThisWeek: target, carryOverPlannedTarget: remaining(finalProgress) } : {}),
        lastUpdatedBy: actor
      });
    } else result.push(task);
  }

  if (carryOver) {
    for (const [key, source] of byKey) {
      const finalProgress = progress(source);
      if (finalProgress >= 100 || covered.has(key)) continue;
      assertEditable();
      const {
        preFilledProgress, preFilledDelayReason, preFilledObservations, preFilledAt,
        finalizedAt, finalizedBy, ...base
      } = source;
      result.push({
        ...base, id: makeId(), weekId: nextWeekId, finalized: false,
        carriedFromWeekId: weekId, carriedFromTaskId: source.id, isCarryOver: true,
        executedBefore: finalProgress, executedBeforeRaw: finalProgress,
        plannedThisWeek: remaining(finalProgress), carryOverPlannedTarget: remaining(finalProgress), progressThisWeek: 0,
        dailyWork: [0, 0, 0, 0, 0], observations: '', delayReason: '',
        budgetDiffIds: [], source: 'carry-over', isUnplannedDetected: false, lastUpdatedBy: actor
      });
    }
  }

  const planned = sources.filter(task => (task.plannedThisWeek ?? 100) > 0);
  const completed = planned.filter(task => (task.progressThisWeek ?? 0) >= (task.plannedThisWeek ?? 100));
  const ppc = planned.length ? completed.length / planned.length * 100 : 0;
  const previous = ppcHistory.find(record => record.weekId === weekId);
  const closureHistory = [...(Array.isArray(previous?.closureHistory) ? previous.closureHistory : [])];
  if (previous) closureHistory.push({
    timestamp: previous.timestamp, ppc: previous.ppc, totalPlanned: previous.totalPlanned,
    completed: previous.completed, lastUpdatedBy: previous.lastUpdatedBy || previous.finalizedBy || 'Sistema',
    reopenedAt: previous.reopenedAt, reopenedBy: previous.reopenedBy,
    correctedAt: now, correctedBy: actor
  });
  const record = {
    ...previous, weekId, weekStart: weekId, ppc, totalPlanned: planned.length, completed: completed.length,
    timestamp: now, firstFinalizedAt: previous?.firstFinalizedAt || previous?.timestamp || now,
    lastUpdatedBy: actor, finalizedBy: actor, closureHistory, isReopened: false
  };
  return { planning: result, ppcHistory: [...ppcHistory.filter(record => record.weekId !== weekId), record], ppc };
}
