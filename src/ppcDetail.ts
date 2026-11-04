import { formatDateBR } from './dates';

export type PpcPeriod = 'last-week' | 'four-weeks' | 'history';

export function getPpcSignal(ppc: number, plannedCount?: number) {
  if (plannedCount === 0) return null;
  return ppc < 40
    ? { image: 'triste', label: 'Triste: PPC abaixo de 40%' }
    : ppc <= 80
      ? { image: 'normal', label: 'Normal: PPC de 40% a 80%' }
      : { image: 'feliz', label: 'Feliz: PPC acima de 80%' };
}

export function calculatePpcByTeam(planning: any[], weeks: string[], teams: string[]) {
  return [...new Set(teams)].map(team => ({ team, weeks: calculatePpcDetail(planning, weeks, [team]).rows }));
}

export function teamsWithPlannedActivities(planning: any[], weeks: string[], teams: string[]) {
  const period = new Set(weeks);
  const active = new Set(planning.filter(task => period.has(task.weekId) && (task.plannedThisWeek ?? 100) > 0)
    .map(task => task.responsible));
  return teams.filter(team => active.has(team));
}
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftWeek = (date: Date, weeks: number) => { const result = new Date(date); result.setDate(result.getDate() + 7 * weeks); return result; };

export function ppcPeriodWeeks(period: PpcPeriod, now: Date, existingWeeks: string[]): string[] {
  const current = new Date(now);
  current.setDate(current.getDate() - ((current.getDay() + 6) % 7));
  current.setHours(0, 0, 0, 0);
  if (period !== 'history') {
    const count = period === 'four-weeks' ? 4 : 1;
    return Array.from({ length: count }, (_, index) => dateKey(shiftWeek(current, index - count)));
  }
  const last = dateKey(shiftWeek(current, -1));
  const weeks = [...new Set(existingWeeks.filter(week => /^\d{4}-\d{2}-\d{2}$/.test(week) && week <= last))].sort();
  return weeks.length ? weeks : [last];
}

export function calculatePpcDetail(planning: any[], weeks: string[], teams: string[], selectedWeek = '') {
  const matchesTeam = (task: any) => !teams.length || teams.includes(task.responsible);
  const rows = weeks.map(weekId => {
    const planned = planning.filter(task => task.weekId === weekId && matchesTeam(task) && (task.plannedThisWeek ?? 100) > 0);
    const completed = planned.filter(task => (task.progressThisWeek ?? 0) >= (task.plannedThisWeek ?? 100));
    const end = new Date(weekId + 'T00:00:00'); end.setDate(end.getDate() + 6);
    return { weekId, startDateStr: formatDateBR(weekId), endDateStr: formatDateBR(end),
      ppc: planned.length ? Math.round(completed.length / planned.length * 100) : 0,
      plannedCount: planned.length, completedCount: completed.length };
  });
  const chartRows = selectedWeek ? rows.filter(row => row.weekId === selectedWeek) : rows;
  const activeWeeks = new Set(chartRows.map(row => row.weekId));
  const counts = new Map<string, number>();
  for (const task of planning) {
    if (!activeWeeks.has(task.weekId) || !matchesTeam(task) || (task.progressThisWeek ?? 0) >= (task.plannedThisWeek ?? 100)) continue;
    const reason = task.delayReason?.trim() || 'Sem motivo definido';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const reasons = [...counts].map(([reason, count]) => ({ reason, count, percent: Math.round(count / total * 100) })).sort((a, b) => b.count - a.count);
  const causes = reasons.length <= 7 ? reasons : [...reasons.slice(0, 6), {
    reason: 'Outros motivos', count: reasons.slice(6).reduce((sum, item) => sum + item.count, 0),
    percent: Math.round(reasons.slice(6).reduce((sum, item) => sum + item.count, 0) / total * 100)
  }];
  return { rows, chartRows, causes, average: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.ppc, 0) / rows.length) : 0 };
}
