export const AUTOMATIC_CARRY_OVER_NOTE = 'Saldo de avanço físico reprogramado';

export function cleanCarriedTask<T extends { isCarryOver?: boolean; carriedFromWeekId?: string; carriedFromTaskId?: string; observations?: string; isUnplannedDetected?: boolean }>(task: T): T {
  const automaticNote = task.observations === AUTOMATIC_CARRY_OVER_NOTE;
  if (!task.isCarryOver && !task.carriedFromWeekId && !task.carriedFromTaskId && !automaticNote) return task;
  return { ...task, isCarryOver: true, isUnplannedDetected: false, observations: automaticNote ? '' : task.observations };
}
