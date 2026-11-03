// Motor de Planejamento de Longo Prazo (Linha de Balanço + EAP/Gantt)
// Otimizado para O(1) lookups e grafos de alta escala (milhares de atividades sem travamento)

export interface ProjectCalendar {
  startDate: string; // "YYYY-MM-DD"
  endDate: string;   // "YYYY-MM-DD"
  workdays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean]; // Dom..Sáb
  holidays: string[]; // "YYYY-MM-DD"[]
  customWorkdays: string[]; // "YYYY-MM-DD"[]
  removeGaps: boolean; // "Sem folga entre atividades"
}

export interface ReplicationGroup {
  id: string;
  name: string;
  position: number;
  linesPerFloor: number;
  color: string;
}

export interface ScheduleFloor {
  id: string;
  name: string;
  position: number;
  area?: number;
  replicationGroupId: string;
}

export interface ScheduleJobTemplate {
  id: string;
  name: string;
  position: number;
  defaultDuration: number;
  defaultResponsible: string;
  costWeight: number;
}

export interface ScheduleServicePackage {
  id: string;
  name: string;
  color: string;
  position: number;
  defaultLine: number;
  defaultDuration: number;
  defaultResponsible: string;
  defaultTotalCost: number;
  autoChainJobs: boolean;
  jobs: ScheduleJobTemplate[];
}

export type FloorDirection = 'same' | 'below' | 'above' | 'specific';

export interface DependencyRule {
  id: string;
  precedenceAttribute: 'start' | 'end';
  delay: number;
  timeOperation: 'after' | 'before';
  baseAttribute: 'end' | 'start';
  predecessorServiceId: string;
  floorDirection: FloorDirection;
  specificFloorId?: string;
}

export interface LobActivityJob {
  id: string;
  jobTemplateId?: string;
  name: string;
  duration: number;
  start: string;
  end: string;
  cost: number;
  responsible: string;
  progress: number;
  predecessors: string[];
  successors: string[];
  originalId?: string;
}

export interface LobActivity {
  id: string;
  originalId?: string;
  serviceId: string;
  floorId: string;
  line: number;
  start: string;
  end: string;
  duration: number;
  cost: number;
  responsible: string;
  progress: number;
  predecessorIds: string[];
  successorIds: string[];
  dependencyRules: DependencyRule[];
  jobs: LobActivityJob[];
}

export interface LongTermScheduleState {
  calendar: ProjectCalendar;
  replicationGroups: ReplicationGroup[];
  floors: ScheduleFloor[];
  services: ScheduleServicePackage[];
  activities: LobActivity[];
}

export const PACKAGE_COLORS: string[] = [
  '#1A665B',
  '#2563EB',
  '#D97706',
  '#7C3AED',
  '#0891B2',
  '#DC2626',
  '#059669',
  '#4F46E5',
  '#CA8A04',
  '#9333EA',
  '#EA580C',
  '#0D9488',
  '#BE185D',
  '#475569',
];

export const GROUP_COLORS: string[] = [
  '#E2E8F0',
  '#DBEAFE',
  '#DCFCE7',
  '#FEF3C7',
  '#F3E8FF',
  '#FFE4E6',
  '#CCFBF1',
];

export function slugifySchedule(text: string): string {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/(^_|_$)/g, '');
}

export function getTodayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getBrazilianHolidays(year: number): string[] {
  return [
    `${year}-01-01`,
    `${year}-04-21`,
    `${year}-05-01`,
    `${year}-09-07`,
    `${year}-10-12`,
    `${year}-11-02`,
    `${year}-11-15`,
    `${year}-11-20`,
    `${year}-12-25`,
  ];
}

export function createDefaultCalendar(startDate?: string): ProjectCalendar {
  const start = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : getTodayISO();
  const startYear = Number(start.slice(0, 4)) || new Date().getFullYear();
  const end = `${startYear + 2}-12-31`;
  return {
    startDate: start,
    endDate: end,
    workdays: [false, true, true, true, true, true, false],
    holidays: [
      ...getBrazilianHolidays(startYear),
      ...getBrazilianHolidays(startYear + 1),
    ],
    customWorkdays: [],
    removeGaps: true,
  };
}

// Cache O(1) para Sets de feriados e dias úteis por objeto de calendário
interface CompiledCalendarCache {
  holidaysSet: Set<string>;
  customWorkdaysSet: Set<string>;
  workdays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  hasAnyWorkday: boolean;
}

const calendarCacheMap = new WeakMap<ProjectCalendar, CompiledCalendarCache>();

function getCompiledCalendar(calendar: ProjectCalendar): CompiledCalendarCache {
  let cached = calendarCacheMap.get(calendar);
  if (!cached) {
    const workdays = calendar.workdays || [false, true, true, true, true, true, false];
    cached = {
      holidaysSet: new Set(calendar.holidays || []),
      customWorkdaysSet: new Set(calendar.customWorkdays || []),
      workdays,
      hasAnyWorkday: workdays.some(Boolean),
    };
    calendarCacheMap.set(calendar, cached);
  }
  return cached;
}

function parseUTCDateMs(dateStr: string): number {
  const clean = (dateStr || '').slice(0, 10);
  if (clean.length === 10 && clean.charCodeAt(4) === 45 && clean.charCodeAt(7) === 45) {
    const y = Number(clean.slice(0, 4));
    const m = Number(clean.slice(5, 7));
    const d = Number(clean.slice(8, 10));
    if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
      return Date.UTC(y, m - 1, d, 12, 0, 0);
    }
  }
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
}

function formatUTCDateMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addCalendarDays(dateStr: string, days: number): string {
  const ms = parseUTCDateMs(dateStr) + days * 86400000;
  return formatUTCDateMs(ms);
}

export function diffCalendarDays(startStr: string, endStr: string): number {
  return Math.round((parseUTCDateMs(endStr) - parseUTCDateMs(startStr)) / 86400000);
}

export function isWorkDay(dateStr: string, calendar: ProjectCalendar): boolean {
  const clean = (dateStr || '').slice(0, 10);
  const compiled = getCompiledCalendar(calendar);
  if (compiled.customWorkdaysSet.has(clean)) return true;
  if (compiled.holidaysSet.has(clean)) return false;
  const ms = parseUTCDateMs(clean);
  const dow = new Date(ms).getUTCDay();
  if (!compiled.hasAnyWorkday) return dow >= 1 && dow <= 5;
  return Boolean(compiled.workdays[dow]);
}

export function ensureWorkDay(dateStr: string, calendar: ProjectCalendar, direction: 1 | -1 = 1): string {
  let ms = parseUTCDateMs(dateStr || getTodayISO());
  let cursor = formatUTCDateMs(ms);
  let guard = 0;
  while (!isWorkDay(cursor, calendar) && guard < 366) {
    ms += direction * 86400000;
    cursor = formatUTCDateMs(ms);
    guard++;
  }
  return cursor;
}

export function addWorkingDays(startDateStr: string, durationDays: number, calendar: ProjectCalendar): string {
  const validDuration = Math.max(1, Math.round(Number(durationDays) || 1));
  const startClean = ensureWorkDay(startDateStr, calendar, 1);
  if (validDuration === 1) return startClean;

  let ms = parseUTCDateMs(startClean);
  let remaining = validDuration - 1;
  let guard = 0;
  while (remaining > 0 && guard < 5000) {
    ms += 86400000;
    const cursor = formatUTCDateMs(ms);
    if (isWorkDay(cursor, calendar)) {
      remaining--;
    }
    guard++;
  }
  return formatUTCDateMs(ms);
}

export function subtractWorkingDaysFromEnd(endDateStr: string, durationDays: number, calendar: ProjectCalendar): string {
  const validDuration = Math.max(1, Math.round(Number(durationDays) || 1));
  const endClean = ensureWorkDay(endDateStr, calendar, -1);
  if (validDuration === 1) return endClean;

  let ms = parseUTCDateMs(endClean);
  let remaining = validDuration - 1;
  let guard = 0;
  while (remaining > 0 && guard < 5000) {
    ms -= 86400000;
    const cursor = formatUTCDateMs(ms);
    if (isWorkDay(cursor, calendar)) {
      remaining--;
    }
    guard++;
  }
  return formatUTCDateMs(ms);
}

export function offsetWorkingDays(baseDateStr: string, offsetDays: number, calendar: ProjectCalendar): string {
  const steps = Math.round(Number(offsetDays) || 0);
  if (steps === 0) return ensureWorkDay(baseDateStr, calendar, 1);
  const dir: 1 | -1 = steps > 0 ? 1 : -1;
  let remaining = Math.abs(steps);
  let ms = parseUTCDateMs(baseDateStr || getTodayISO());
  let guard = 0;
  while (remaining > 0 && guard < 5000) {
    ms += dir * 86400000;
    const cursor = formatUTCDateMs(ms);
    if (isWorkDay(cursor, calendar)) {
      remaining--;
    }
    guard++;
  }
  return formatUTCDateMs(ms);
}

export function countWorkingDays(startDateStr: string, endDateStr: string, calendar: ProjectCalendar): number {
  if (!startDateStr || !endDateStr) return 1;
  const startMs = parseUTCDateMs(startDateStr);
  const endMs = parseUTCDateMs(endDateStr);
  if (endMs < startMs) return 1;
  const totalCalDays = Math.round((endMs - startMs) / 86400000) + 1;
  if (totalCalDays > 1500) {
    return Math.max(1, Math.round(totalCalDays * (5 / 7)));
  }
  let count = 0;
  let ms = startMs;
  for (let i = 0; i < totalCalDays; i++) {
    const cursor = formatUTCDateMs(ms);
    if (isWorkDay(cursor, calendar)) count++;
    ms += 86400000;
  }
  return Math.max(1, count);
}

export function createSequentialFloors(
  existingFloors: ScheduleFloor[],
  options: {
    prefix: string;
    suffix?: string;
    quantity: number;
    startsWith: number;
    area?: number;
    replicationGroupId: string;
    zeroPad?: boolean;
  }
): ScheduleFloor[] {
  const qty = Math.max(1, Math.min(200, Math.round(Number(options.quantity) || 1)));
  const startNum = Math.round(Number(options.startsWith) ?? 1);
  const maxPos = existingFloors.reduce((m, f) => Math.max(m, f.position || 0), 0);
  const created: ScheduleFloor[] = [];
  const stamp = Date.now().toString(36);

  for (let i = 0; i < qty; i++) {
    const num = startNum + i;
    const numStr = options.zeroPad && num < 10 && num >= 0 ? `0${num}` : String(num);
    const rawName = `${options.prefix || ''}${numStr}${options.suffix || ''}`.trim();
    const name = rawName || `Pavimento ${num}`;
    const id = `flr_${slugifySchedule(name)}_${stamp}_${i}`;
    created.push({
      id,
      name,
      position: maxPos + i + 1,
      area: options.area && options.area > 0 ? Number(options.area) : undefined,
      replicationGroupId: options.replicationGroupId,
    });
  }

  return [...existingFloors, ...created];
}

export function getVerticalBuildingPreset(): {
  replicationGroups: ReplicationGroup[];
  services: ScheduleServicePackage[];
} {
  const replicationGroups: ReplicationGroup[] = [
    { id: 'grp_fundacao', name: 'FUNDAÇÃO E SUBSOLOS', position: 1, linesPerFloor: 4, color: '#E2E8F0' },
    { id: 'grp_embasamento', name: 'EMBASAMENTO / TÉRREO', position: 2, linesPerFloor: 5, color: '#DBEAFE' },
    { id: 'grp_torre', name: 'TORRE (PAVIMENTOS TIPO)', position: 3, linesPerFloor: 5, color: '#DCFCE7' },
    { id: 'grp_cobertura', name: 'ÁTICO E COBERTURA', position: 4, linesPerFloor: 4, color: '#FEF3C7' },
    { id: 'grp_fachada', name: 'FACHADA EXTERNA', position: 5, linesPerFloor: 3, color: '#F3E8FF' },
  ];

  const services: ScheduleServicePackage[] = [
    {
      id: 'pkg_estrutura',
      name: 'ESTRUTURA DE CONCRETO',
      color: '#1A665B',
      position: 1,
      defaultLine: 1,
      defaultDuration: 6,
      defaultResponsible: 'EQUIPE ESTRUTURA',
      defaultTotalCost: 45000,
      autoChainJobs: true,
      jobs: [
        { id: 'job_est_forma', name: 'FÔRMA E ESCORAMENTO', position: 1, defaultDuration: 3, defaultResponsible: 'EQUIPE ESTRUTURA', costWeight: 18000 },
        { id: 'job_est_armadura', name: 'ARMADURA E EMBUTIDOS', position: 2, defaultDuration: 2, defaultResponsible: 'EQUIPE ESTRUTURA', costWeight: 15000 },
        { id: 'job_est_concretagem', name: 'CONCRETAGEM E CURA', position: 3, defaultDuration: 1, defaultResponsible: 'EQUIPE ESTRUTURA', costWeight: 12000 },
      ],
    },
    {
      id: 'pkg_alvenaria',
      name: 'ALVENARIA E VEDAÇÃO',
      color: '#D97706',
      position: 2,
      defaultLine: 2,
      defaultDuration: 5,
      defaultResponsible: 'EQUIPE ALVENARIA',
      defaultTotalCost: 22000,
      autoChainJobs: true,
      jobs: [
        { id: 'job_alv_marcacao', name: 'MARCAÇÃO DE ALVENARIA (1ª FIADA)', position: 1, defaultDuration: 1, defaultResponsible: 'EQUIPE ALVENARIA', costWeight: 4000 },
        { id: 'job_alv_elevacao', name: 'ELEVAÇÃO DE ALVENARIA', position: 2, defaultDuration: 3, defaultResponsible: 'EQUIPE ALVENARIA', costWeight: 13000 },
        { id: 'job_alv_encunhamento', name: 'ENCUNHAMENTO E FIXAÇÃO', position: 3, defaultDuration: 1, defaultResponsible: 'EQUIPE ALVENARIA', costWeight: 5000 },
      ],
    },
    {
      id: 'pkg_instalacoes',
      name: 'INSTALAÇÕES HIDRO E ELÉTRICA',
      color: '#2563EB',
      position: 3,
      defaultLine: 3,
      defaultDuration: 5,
      defaultResponsible: 'EQUIPE INSTALAÇÕES',
      defaultTotalCost: 28000,
      autoChainJobs: true,
      jobs: [
        { id: 'job_inst_prumadas', name: 'PRUMADAS E INFRAESTRUTURA', position: 1, defaultDuration: 2, defaultResponsible: 'EQUIPE INSTALAÇÕES', costWeight: 10000 },
        { id: 'job_inst_hidraulica', name: 'RAMAIS HIDRÁULICOS E TESTE ESTANQUEIDADE', position: 2, defaultDuration: 2, defaultResponsible: 'EQUIPE INSTALAÇÕES', costWeight: 10000 },
        { id: 'job_inst_eletrica', name: 'ELETRODUTOS, CAIXINHAS E QUADROS', position: 3, defaultDuration: 1, defaultResponsible: 'EQUIPE INSTALAÇÕES', costWeight: 8000 },
      ],
    },
    {
      id: 'pkg_revestimento',
      name: 'REVESTIMENTO E CONTRAPISO',
      color: '#7C3AED',
      position: 4,
      defaultLine: 4,
      defaultDuration: 5,
      defaultResponsible: 'EQUIPE ACABAMENTO',
      defaultTotalCost: 30000,
      autoChainJobs: true,
      jobs: [
        { id: 'job_rev_reboco', name: 'CHAPISCO E MASSA ÚNICA / GESSO', position: 1, defaultDuration: 2, defaultResponsible: 'EQUIPE ACABAMENTO', costWeight: 10000 },
        { id: 'job_rev_contrapiso', name: 'CONTRAPISO E IMPERMEABILIZAÇÃO ÁREAS FRIAS', position: 2, defaultDuration: 1, defaultResponsible: 'EQUIPE ACABAMENTO', costWeight: 8000 },
        { id: 'job_rev_ceramica', name: 'REVESTIMENTO CERÂMICO / PORCELANATO', position: 3, defaultDuration: 2, defaultResponsible: 'EQUIPE ACABAMENTO', costWeight: 12000 },
      ],
    },
    {
      id: 'pkg_acabamento_final',
      name: 'ESQUADRIAS, PINTURA E LOUÇAS',
      color: '#059669',
      position: 5,
      defaultLine: 5,
      defaultDuration: 5,
      defaultResponsible: 'EQUIPE PINTURA E FINALIZAÇÃO',
      defaultTotalCost: 25000,
      autoChainJobs: true,
      jobs: [
        { id: 'job_fin_forro', name: 'FORRO DE GESSO E EMASSAMENTO', position: 1, defaultDuration: 2, defaultResponsible: 'EQUIPE PINTURA E FINALIZAÇÃO', costWeight: 8000 },
        { id: 'job_fin_esquadrias', name: 'ESQUADRIAS, PORTAS E VIDROS', position: 2, defaultDuration: 2, defaultResponsible: 'EQUIPE PINTURA E FINALIZAÇÃO', costWeight: 9000 },
        { id: 'job_fin_pintura', name: 'PINTURA FINAL, LOUÇAS E METAIS', position: 3, defaultDuration: 1, defaultResponsible: 'EQUIPE PINTURA E FINALIZAÇÃO', costWeight: 8000 },
      ],
    },
  ];

  return { replicationGroups, services };
}

export function syncActivityJobs(
  activity: LobActivity,
  pkg: ScheduleServicePackage | undefined,
  calendar: ProjectCalendar,
  mode: 'from-jobs' | 'scale-to-activity' = 'from-jobs'
): LobActivity {
  const start = ensureWorkDay(activity.start, calendar, 1);
  const templates =
    pkg?.jobs && pkg.jobs.length > 0
      ? [...pkg.jobs].sort((a, b) => a.position - b.position)
      : [
          {
            id: `job_default_${activity.serviceId}`,
            name: (pkg?.name || 'EXECUÇÃO').toUpperCase(),
            position: 1,
            defaultDuration: Math.max(1, activity.duration || pkg?.defaultDuration || 5),
            defaultResponsible: activity.responsible || pkg?.defaultResponsible || 'EQUIPE GERAL',
            costWeight: activity.cost || pkg?.defaultTotalCost || 0,
          },
        ];

  let currentJobs: LobActivityJob[] = [];
  if (activity.jobs && activity.jobs.length > 0) {
    currentJobs = activity.jobs.map((j) => ({
      ...j,
      name: j.name.toUpperCase(),
      duration: Math.max(1, Math.round(Number(j.duration) || 1)),
      responsible: (j.responsible || activity.responsible || pkg?.defaultResponsible || 'EQUIPE GERAL').toUpperCase(),
      cost: Number(j.cost) || 0,
      progress: Math.max(0, Math.min(100, Number(j.progress) || 0)),
    }));
  } else {
    currentJobs = templates.map((tpl, idx) => ({
      id: `lob_job_${slugifySchedule(activity.floorId)}_${slugifySchedule(pkg?.name || activity.serviceId)}_${slugifySchedule(tpl.name)}_${idx + 1}`,
      jobTemplateId: tpl.id,
      name: tpl.name.toUpperCase(),
      duration: Math.max(1, Math.round(Number(tpl.defaultDuration) || 1)),
      start,
      end: start,
      cost: Number(tpl.costWeight) || 0,
      responsible: (tpl.defaultResponsible || activity.responsible || pkg?.defaultResponsible || 'EQUIPE GERAL').toUpperCase(),
      progress: activity.progress || 0,
      predecessors: [],
      successors: [],
    }));
  }

  const targetActivityDuration = Math.max(1, Math.round(Number(activity.duration) || 1));
  if (mode === 'scale-to-activity' && currentJobs.length > 0) {
    const sumJobDurations = currentJobs.reduce((acc, j) => acc + j.duration, 0);
    if (sumJobDurations !== targetActivityDuration) {
      if (currentJobs.length === 1) {
        currentJobs[0].duration = targetActivityDuration;
      } else {
        const ratio = targetActivityDuration / Math.max(1, sumJobDurations);
        let allocated = 0;
        currentJobs.forEach((j, idx) => {
          if (idx === currentJobs.length - 1) {
            j.duration = Math.max(1, targetActivityDuration - allocated);
          } else {
            const d = Math.max(1, Math.round(j.duration * ratio));
            j.duration = d;
            allocated += d;
          }
        });
      }
    }
  }

  const autoChain = pkg ? pkg.autoChainJobs !== false : true;
  let cursorDate = start;
  let latestEnd = start;
  let sumDurations = 0;

  const updatedJobs = currentJobs.map((job) => {
    const jobStart = autoChain ? cursorDate : start;
    const jobEnd = addWorkingDays(jobStart, job.duration, calendar);
    if (autoChain) {
      cursorDate = offsetWorkingDays(jobEnd, 1, calendar);
      sumDurations += job.duration;
    } else {
      sumDurations = Math.max(sumDurations, job.duration);
    }
    if (jobEnd > latestEnd) latestEnd = jobEnd;
    return {
      ...job,
      start: jobStart,
      end: jobEnd,
    };
  });

  for (let i = 0; i < updatedJobs.length; i++) {
    updatedJobs[i].predecessors = i > 0 && autoChain ? [updatedJobs[i - 1].id] : [];
    updatedJobs[i].successors = i < updatedJobs.length - 1 && autoChain ? [updatedJobs[i + 1].id] : [];
  }

  const totalDuration = Math.max(1, sumDurations);
  const totalCost = updatedJobs.reduce((acc, j) => acc + (Number(j.cost) || 0), 0) || Number(activity.cost) || 0;

  const weightedProgress =
    totalCost > 0
      ? updatedJobs.reduce((acc, j) => acc + (Number(j.progress) || 0) * (Number(j.cost) || 0), 0) / totalCost
      : updatedJobs.reduce((acc, j) => acc + (Number(j.progress) || 0), 0) / Math.max(1, updatedJobs.length);

  return {
    ...activity,
    start,
    end: latestEnd,
    duration: totalDuration,
    cost: totalCost,
    progress: Math.round(weightedProgress * 100) / 100,
    jobs: updatedJobs,
  };
}

/**
 * Análise ultrarrápida O(V + E) do grafo (sem loops de datas em todos os jobs)
 * usada para detectar ciclos e caminho crítico instantaneamente na UI.
 */
export function analyzeScheduleGraph(state: LongTermScheduleState): {
  hasCycle: boolean;
  cycleActivityIds: string[];
  criticalPathIds: string[];
} {
  const activities = state.activities;
  if (activities.length === 0) {
    return { hasCycle: false, cycleActivityIds: [], criticalPathIds: [] };
  }

  const actById = new Map<string, LobActivity>();
  const inDegree = new Map<string, number>();
  const succMap = new Map<string, string[]>();

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    actById.set(a.id, a);
    inDegree.set(a.id, 0);
    succMap.set(a.id, []);
  }

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    const preds = a.predecessorIds || [];
    let validPredCount = 0;
    for (let j = 0; j < preds.length; j++) {
      const pId = preds[j];
      if (actById.has(pId) && pId !== a.id) {
        validPredCount++;
        succMap.get(pId)!.push(a.id);
      }
    }
    inDegree.set(a.id, validPredCount);
  }

  const queue: string[] = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  let visitedCount = 0;
  const visitedSet = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    visitedCount++;
    visitedSet.add(curr);
    const succs = succMap.get(curr) || [];
    for (let i = 0; i < succs.length; i++) {
      const sId = succs[i];
      const nextDeg = (inDegree.get(sId) || 0) - 1;
      inDegree.set(sId, nextDeg);
      if (nextDeg === 0) queue.push(sId);
    }
  }

  const hasCycle = visitedCount < activities.length;
  const cycleActivityIds = hasCycle
    ? activities.filter((a) => !visitedSet.has(a.id)).map((a) => a.id)
    : [];

  const criticalPathIds: string[] = [];
  if (!hasCycle && activities.length > 0) {
    let maxEnd = '';
    for (let i = 0; i < activities.length; i++) {
      if (activities[i].end > maxEnd) maxEnd = activities[i].end;
    }

    const criticalSet = new Set<string>();
    const stack: string[] = [];
    for (let i = 0; i < activities.length; i++) {
      if (activities[i].end === maxEnd) stack.push(activities[i].id);
    }

    while (stack.length > 0) {
      const currId = stack.pop()!;
      if (criticalSet.has(currId)) continue;
      criticalSet.add(currId);
      const currAct = actById.get(currId);
      if (!currAct) continue;
      const preds = currAct.predecessorIds || [];
      for (let i = 0; i < preds.length; i++) {
        const pAct = actById.get(preds[i]);
        if (!pAct) continue;
        const diffDays = diffCalendarDays(pAct.end, currAct.start);
        if (diffDays <= 4) {
          stack.push(pAct.id);
        }
      }
    }
    criticalPathIds.push(...Array.from(criticalSet));
  }

  return { hasCycle, cycleActivityIds, criticalPathIds };
}

/**
 * Resolve regras de predecessoras (`DependencyRule`), propaga datas em cascata apenas
 * nas atividades afetadas e retorna o estado atualizado + diagnóstico de ciclo/caminho crítico.
 */
export function recalculateSchedule(
  state: LongTermScheduleState,
  options?: { forceRemoveGaps?: boolean; syncAllJobs?: boolean }
): {
  state: LongTermScheduleState;
  hasCycle: boolean;
  cycleActivityIds: string[];
  criticalPathIds: string[];
} {
  const { calendar, floors, services } = state;
  if (state.activities.length === 0) {
    return { state, hasCycle: false, cycleActivityIds: [], criticalPathIds: [] };
  }

  const serviceMap = new Map<string, ScheduleServicePackage>();
  services.forEach((s) => serviceMap.set(s.id, s));

  const groupPosMap = new Map<string, number>();
  state.replicationGroups.forEach((g) => groupPosMap.set(g.id, g.position));

  const orderedFloors = [...floors].sort((a, b) => {
    const ga = groupPosMap.get(a.replicationGroupId) ?? 999;
    const gb = groupPosMap.get(b.replicationGroupId) ?? 999;
    if (ga !== gb) return ga - gb;
    return (a.position || 0) - (b.position || 0);
  });
  const floorIndexMap = new Map<string, number>();
  orderedFloors.forEach((f, idx) => floorIndexMap.set(f.id, idx));

  // Só roda syncActivityJobs inicialmente se a atividade não tiver jobs populados ou se syncAllJobs for solicitado
  const activities: LobActivity[] = state.activities.map((act) => {
    if (options?.syncAllJobs || !act.jobs || act.jobs.length === 0) {
      return syncActivityJobs(act, serviceMap.get(act.serviceId), calendar, 'from-jobs');
    }
    return {
      ...act,
      predecessorIds: [...(act.predecessorIds || [])],
      successorIds: [...(act.successorIds || [])],
      jobs: act.jobs.map((j) => ({ ...j })),
    };
  });

  const actById = new Map<string, LobActivity>();
  const actByServiceAndFloor = new Map<string, LobActivity>();
  activities.forEach((act) => {
    actById.set(act.id, act);
    actByServiceAndFloor.set(`${act.serviceId}||${act.floorId}`, act);
  });

  const predEdges = new Map<string, Set<string>>();
  const succEdges = new Map<string, Set<string>>();
  activities.forEach((act) => {
    predEdges.set(act.id, new Set<string>());
    succEdges.set(act.id, new Set<string>());
  });

  const edgeRuleMap = new Map<string, DependencyRule>();
  let hasAnyRule = false;

  activities.forEach((act) => {
    const fIdx = floorIndexMap.get(act.floorId);
    const rules = act.dependencyRules || [];

    if (rules.length > 0) {
      hasAnyRule = true;
      rules.forEach((rule) => {
        let targetFloorId: string | undefined;
        if (rule.floorDirection === 'same') {
          targetFloorId = act.floorId;
        } else if (rule.floorDirection === 'below' && fIdx !== undefined && fIdx > 0) {
          targetFloorId = orderedFloors[fIdx - 1]?.id;
        } else if (rule.floorDirection === 'above' && fIdx !== undefined && fIdx < orderedFloors.length - 1) {
          targetFloorId = orderedFloors[fIdx + 1]?.id;
        } else if (rule.floorDirection === 'specific' && rule.specificFloorId) {
          targetFloorId = rule.specificFloorId;
        }

        if (!targetFloorId) return;
        const predAct = actByServiceAndFloor.get(`${rule.predecessorServiceId}||${targetFloorId}`);
        if (predAct && predAct.id !== act.id) {
          predEdges.get(act.id)?.add(predAct.id);
          succEdges.get(predAct.id)?.add(act.id);
          edgeRuleMap.set(`${predAct.id}->${act.id}`, rule);
        }
      });
    }

    (act.predecessorIds || []).forEach((pId) => {
      if (actById.has(pId) && pId !== act.id) {
        predEdges.get(act.id)?.add(pId);
        succEdges.get(pId)?.add(act.id);
      }
    });
  });

  const inDegree = new Map<string, number>();
  activities.forEach((act) => {
    inDegree.set(act.id, predEdges.get(act.id)?.size || 0);
  });

  const queue: string[] = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  const topoOrder: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    topoOrder.push(curr);
    succEdges.get(curr)?.forEach((succId) => {
      const nextDeg = (inDegree.get(succId) || 0) - 1;
      inDegree.set(succId, nextDeg);
      if (nextDeg === 0) queue.push(succId);
    });
  }

  const hasCycle = topoOrder.length < activities.length;
  const cycleActivityIds = hasCycle
    ? activities.filter((a) => !topoOrder.includes(a.id)).map((a) => a.id)
    : [];

  const shouldRemoveGaps = Boolean(options?.forceRemoveGaps || calendar.removeGaps);

  // Só propaga datas se houver regras ativas ou se forceRemoveGaps foi solicitado
  if (hasAnyRule || options?.forceRemoveGaps) {
    topoOrder.forEach((actId) => {
      const act = actById.get(actId)!;
      const preds = Array.from(predEdges.get(actId) || []);
      act.predecessorIds = preds;
      act.successorIds = Array.from(succEdges.get(actId) || []);

      if (preds.length === 0) return;
      // Se esta atividade não tem dependencyRules e forceRemoveGaps não foi pedido, preserva a data importada
      if (!options?.forceRemoveGaps && (!act.dependencyRules || act.dependencyRules.length === 0)) {
        return;
      }

      let requiredStart: string | null = null;

      preds.forEach((predId) => {
        const predAct = actById.get(predId);
        if (!predAct) return;
        const rule = edgeRuleMap.get(`${predId}->${actId}`) || {
          id: 'default',
          precedenceAttribute: 'start',
          delay: 1,
          timeOperation: 'after',
          baseAttribute: 'end',
          predecessorServiceId: predAct.serviceId,
          floorDirection: 'same',
        };

        const baseDate = rule.baseAttribute === 'start' ? predAct.start : predAct.end;
        const signedDelay = rule.timeOperation === 'before' ? -Math.abs(rule.delay) : Math.abs(rule.delay);
        const targetEndpointDate = offsetWorkingDays(baseDate, signedDelay, calendar);

        const candidateStart =
          rule.precedenceAttribute === 'end'
            ? subtractWorkingDaysFromEnd(targetEndpointDate, act.duration, calendar)
            : targetEndpointDate;

        if (!requiredStart || candidateStart > requiredStart) {
          requiredStart = candidateStart;
        }
      });

      if (requiredStart && requiredStart !== act.start) {
        if (shouldRemoveGaps || act.start < requiredStart) {
          act.start = requiredStart;
          const synced = syncActivityJobs(act, serviceMap.get(act.serviceId), calendar, 'from-jobs');
          Object.assign(act, synced);
        }
      }
    });
  }

  activities.forEach((act) => {
    act.predecessorIds = Array.from(predEdges.get(act.id) || []);
    act.successorIds = Array.from(succEdges.get(act.id) || []);
    if (act.jobs.length > 0 && (hasAnyRule || options?.forceRemoveGaps)) {
      const firstJob = act.jobs[0];
      const externalPredJobIds: string[] = [];
      act.predecessorIds.forEach((pId) => {
        const pAct = actById.get(pId);
        if (pAct && pAct.jobs.length > 0) {
          externalPredJobIds.push(pAct.jobs[pAct.jobs.length - 1].id);
        }
      });
      firstJob.predecessors = Array.from(new Set([...externalPredJobIds, ...(firstJob.predecessors || [])]));

      const lastJob = act.jobs[act.jobs.length - 1];
      const externalSuccJobIds: string[] = [];
      act.successorIds.forEach((sId) => {
        const sAct = actById.get(sId);
        if (sAct && sAct.jobs.length > 0) {
          externalSuccJobIds.push(sAct.jobs[0].id);
        }
      });
      lastJob.successors = Array.from(new Set([...(lastJob.successors || []), ...externalSuccJobIds]));
    }
  });

  const nextState: LongTermScheduleState = {
    ...state,
    activities,
  };

  const graphStats = analyzeScheduleGraph(nextState);

  return {
    state: nextState,
    hasCycle: graphStats.hasCycle,
    cycleActivityIds: graphStats.cycleActivityIds,
    criticalPathIds: graphStats.criticalPathIds,
  };
}

/**
 * Propaga o movimento ou redimensionamento de uma atividade respeitando regras de predecessoras
 * (não permite que a atividade inicie antes de suas predecessoras) e empurra todas as sucessoras
 * afetadas para frente em cascata (algoritmo CPM Forward Pass).
 */
export function propagateScheduleCascade(
  state: LongTermScheduleState,
  movedActivityId: string,
  candidateStart: string,
  candidateDuration?: number
): LongTermScheduleState {
  const { calendar, floors, services } = state;
  const pkgMap = new Map<string, ScheduleServicePackage>();
  services.forEach((s) => pkgMap.set(s.id, s));

  const groupPosMap = new Map<string, number>();
  state.replicationGroups.forEach((g) => groupPosMap.set(g.id, g.position));

  const orderedFloors = [...floors].sort((a, b) => {
    const ga = groupPosMap.get(a.replicationGroupId) ?? 999;
    const gb = groupPosMap.get(b.replicationGroupId) ?? 999;
    if (ga !== gb) return ga - gb;
    return (a.position || 0) - (b.position || 0);
  });
  const floorIndexMap = new Map<string, number>();
  orderedFloors.forEach((f, idx) => floorIndexMap.set(f.id, idx));

  // Clona atividades para mutação controlada
  const activities = state.activities.map((a) => ({
    ...a,
    jobs: a.jobs ? a.jobs.map((j) => ({ ...j })) : [],
    predecessorIds: [...(a.predecessorIds || [])],
    successorIds: [...(a.successorIds || [])],
  }));

  const actById = new Map<string, LobActivity>();
  const actByServiceAndFloor = new Map<string, LobActivity>();
  activities.forEach((act) => {
    actById.set(act.id, act);
    actByServiceAndFloor.set(`${act.serviceId}||${act.floorId}`, act);
  });

  const predEdges = new Map<string, Set<string>>();
  const succEdges = new Map<string, Set<string>>();
  activities.forEach((act) => {
    predEdges.set(act.id, new Set<string>());
    succEdges.set(act.id, new Set<string>());
  });

  const edgeRuleMap = new Map<string, DependencyRule>();

  activities.forEach((act) => {
    const fIdx = floorIndexMap.get(act.floorId);
    const rules = act.dependencyRules || [];

    rules.forEach((rule) => {
      let targetFloorId: string | undefined;
      if (rule.floorDirection === 'same') {
        targetFloorId = act.floorId;
      } else if (rule.floorDirection === 'below' && fIdx !== undefined && fIdx > 0) {
        targetFloorId = orderedFloors[fIdx - 1]?.id;
      } else if (rule.floorDirection === 'above' && fIdx !== undefined && fIdx < orderedFloors.length - 1) {
        targetFloorId = orderedFloors[fIdx + 1]?.id;
      } else if (rule.floorDirection === 'specific' && rule.specificFloorId) {
        targetFloorId = rule.specificFloorId;
      }

      if (!targetFloorId) return;
      const predAct = actByServiceAndFloor.get(`${rule.predecessorServiceId}||${targetFloorId}`);
      if (predAct && predAct.id !== act.id) {
        predEdges.get(act.id)?.add(predAct.id);
        succEdges.get(predAct.id)?.add(act.id);
        edgeRuleMap.set(`${predAct.id}->${act.id}`, rule);
      }
    });

    (act.predecessorIds || []).forEach((pId) => {
      if (actById.has(pId) && pId !== act.id) {
        predEdges.get(act.id)?.add(pId);
        succEdges.get(pId)?.add(act.id);
      }
    });
  });

  const targetAct = actById.get(movedActivityId);
  if (!targetAct) return state;

  const finalDuration = Math.max(1, candidateDuration ?? targetAct.duration);

  // 1. Calcula a data mínima de início permitida para a atividade movida com base em suas predecessoras
  let minAllowedStart: string | null = null;
  const directPreds = Array.from(predEdges.get(targetAct.id) || []);

  directPreds.forEach((predId) => {
    const predAct = actById.get(predId);
    if (!predAct) return;

    const rule = edgeRuleMap.get(`${predId}->${targetAct.id}`);
    let reqStart: string;

    if (rule) {
      const baseDate = rule.baseAttribute === 'start' ? predAct.start : predAct.end;
      const signedDelay = rule.timeOperation === 'before' ? -Math.abs(rule.delay) : Math.abs(rule.delay);
      const targetEndpointDate = offsetWorkingDays(baseDate, signedDelay, calendar);
      reqStart =
        rule.precedenceAttribute === 'end'
          ? subtractWorkingDaysFromEnd(targetEndpointDate, finalDuration, calendar)
          : targetEndpointDate;
    } else {
      reqStart = offsetWorkingDays(predAct.end, 1, calendar);
    }

    if (!minAllowedStart || reqStart > minAllowedStart) {
      minAllowedStart = reqStart;
    }
  });

  // Garante que não comece antes de suas predecessoras
  let finalStart = ensureWorkDay(candidateStart, calendar, 1);
  if (minAllowedStart && finalStart < minAllowedStart) {
    finalStart = minAllowedStart;
  }

  const pkg = pkgMap.get(targetAct.serviceId);

  // Aplica à atividade movida
  const syncedTarget = syncActivityJobs(
    {
      ...targetAct,
      start: finalStart,
      duration: finalDuration,
    },
    pkg,
    calendar,
    candidateDuration !== undefined ? 'scale-to-activity' : 'from-jobs'
  );
  Object.assign(targetAct, syncedTarget);

  // 2. Propaga em cascata para frente para todas as sucessoras (Forward Ripple)
  const queue: string[] = Array.from(succEdges.get(targetAct.id) || []);
  const processedCount = new Map<string, number>();

  while (queue.length > 0) {
    const succId = queue.shift()!;
    const succAct = actById.get(succId);
    if (!succAct) continue;

    const count = (processedCount.get(succId) || 0) + 1;
    if (count > 30) continue;
    processedCount.set(succId, count);

    const sPreds = Array.from(predEdges.get(succId) || []);
    let requiredSuccStart: string | null = null;

    sPreds.forEach((pId) => {
      const pAct = actById.get(pId);
      if (!pAct) return;

      const rule = edgeRuleMap.get(`${pId}->${succId}`);
      let reqS: string;
      if (rule) {
        const baseDate = rule.baseAttribute === 'start' ? pAct.start : pAct.end;
        const signedDelay = rule.timeOperation === 'before' ? -Math.abs(rule.delay) : Math.abs(rule.delay);
        const targetEndpointDate = offsetWorkingDays(baseDate, signedDelay, calendar);
        reqS =
          rule.precedenceAttribute === 'end'
            ? subtractWorkingDaysFromEnd(targetEndpointDate, succAct.duration, calendar)
            : targetEndpointDate;
      } else {
        reqS = offsetWorkingDays(pAct.end, 1, calendar);
      }

      if (!requiredSuccStart || reqS > requiredSuccStart) {
        requiredSuccStart = reqS;
      }
    });

    if (requiredSuccStart && succAct.start < requiredSuccStart) {
      succAct.start = requiredSuccStart;
      const sPkg = pkgMap.get(succAct.serviceId);
      const syncedSucc = syncActivityJobs(succAct, sPkg, calendar, 'from-jobs');
      Object.assign(succAct, syncedSucc);

      const nextSuccs = Array.from(succEdges.get(succId) || []);
      nextSuccs.forEach((nsId) => {
        if (!queue.includes(nsId)) queue.push(nsId);
      });
    }
  }

  return {
    ...state,
    activities,
  };
}

/**
 * Otimiza a distribuição de sub-linhas por pavimento:
 * 1. Garante que atividades predecessora e sucessora direta no mesmo pavimento fiquem em sub-linhas diferentes.
 * 2. Minimiza colisões visuais de barras no mesmo pavimento e sub-linha.
 */
export function optimizeSubLines(
  state: LongTermScheduleState,
  options?: { defaultLinesPerFloor?: number }
): LongTermScheduleState {
  const { floors, replicationGroups } = state;
  const groupLinesMap = new Map<string, number>();
  (replicationGroups || []).forEach((g) => {
    if (g.linesPerFloor) groupLinesMap.set(g.id, g.linesPerFloor);
  });

  const activitiesByFloor = new Map<string, LobActivity[]>();
  state.activities.forEach((act) => {
    const list = activitiesByFloor.get(act.floorId) || [];
    list.push(act);
    activitiesByFloor.set(act.floorId, list);
  });

  const updatedActivities = state.activities.map((a) => ({ ...a }));
  const actById = new Map<string, LobActivity>();
  updatedActivities.forEach((a) => actById.set(a.id, a));

  floors.forEach((flr) => {
    const floorActs = activitiesByFloor.get(flr.id);
    if (!floorActs || floorActs.length === 0) return;

    // Número de sub-linhas disponíveis no pavimento (padrão 5)
    const maxLines = Math.max(
      2,
      groupLinesMap.get(flr.replicationGroupId || '') || options?.defaultLinesPerFloor || 5
    );

    // Ordena as atividades por data de início ascendente, depois término, depois id
    const sorted = floorActs
      .map((a) => actById.get(a.id)!)
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id));

    // Registro das atividades alocadas em cada sub-linha deste pavimento
    const activitiesOnLine = new Map<number, LobActivity[]>();
    for (let l = 1; l <= maxLines; l++) {
      activitiesOnLine.set(l, []);
    }

    let prevAssignedLine = 0;

    sorted.forEach((act, actIdx) => {
      let bestLine = 1;
      let maxScore = -Infinity;

      // Preferência natural por rodízio em cascata (round-robin / escadinha diagonal)
      const preferredLine = (actIdx % maxLines) + 1;

      for (let candidateLine = 1; candidateLine <= maxLines; candidateLine++) {
        let score = 0;
        const lineActs = activitiesOnLine.get(candidateLine) || [];

        // 1. Linha completamente virgem/vazia recebe forte prioridade
        // Isso garante que TODAS as sub-linhas disponíveis (1, 2, 3, 4, 5) sejam aproveitadas
        // antes de qualquer linha ser reutilizada por outra atividade
        if (lineActs.length === 0) {
          score += 25000;
        }

        // 2. Bônus de harmonia visual de escadinha diagonal (round-robin)
        if (candidateLine === preferredLine) {
          score += 4000;
        }

        // 3. Penalidade severa se for a mesma linha da atividade imediatamente anterior na mesma frente
        // Evita estritamente que duas tarefas consecutivas fiquem na mesma linha
        if (candidateLine === prevAssignedLine && maxLines > 1) {
          score -= 60000;
        }

        // 4. Análise temporal e de dependência com as atividades já presentes nesta linha
        if (lineActs.length > 0) {
          const lastAct = lineActs[lineActs.length - 1];
          const actStartMs = parseUTCDateMs(act.start);
          const lastEndMs = parseUTCDateMs(lastAct.end);
          const gapDays = Math.round((actStartMs - lastEndMs) / 86400000);

          // Relação de dependência direta (predecessora ou sucessora)
          const isDirectPredecessor =
            (act.predecessorIds || []).includes(lastAct.id) ||
            (lastAct.predecessorIds || []).includes(act.id) ||
            (act.successorIds || []).includes(lastAct.id) ||
            (lastAct.successorIds || []).includes(act.id);

          if (isDirectPredecessor) {
            // Predecessora/sucessora na mesma linha é estritamente evitada
            score -= 100000;
          }

          if (gapDays < 0) {
            // Sobreposição direta de datas: colisão física de caixas no mesmo pavimento
            score -= 250000 + Math.abs(gapDays) * 100;
          } else if (gapDays < 3) {
            // Datas coladas (0 a 2 dias de intervalo): sobrepõe textos DD-DD/MM e tapa a barra anterior
            score -= 40000;
          } else if (gapDays < 7) {
            // Menos de 1 semana de intervalo: muito próximo
            score -= 20000;
          } else if (gapDays < 15) {
            // Menos de 2 semanas de intervalo: ainda próximo para a mesma sub-linha
            score -= 8000;
          } else {
            // Distância segura: quanto maior o espaçamento temporal entre as tarefas na mesma linha, melhor!
            score += Math.min(3000, gapDays * 20);
          }
        }

        if (score > maxScore) {
          maxScore = score;
          bestLine = candidateLine;
        }
      }

      act.line = bestLine;
      prevAssignedLine = bestLine;
      const list = activitiesOnLine.get(bestLine) || [];
      list.push(act);
      activitiesOnLine.set(bestLine, list);
    });
  });

  return {
    ...state,
    activities: updatedActivities,
  };
}

export function applyPaceAndGenerateActivities(
  state: LongTermScheduleState,
  options: {
    floorIds: string[];
    serviceIds: string[];
    startDate: string;
    pacedFloors: number;
    direction: 'up' | 'down';
    lagBetweenServicesDays: number;
    chainAcrossServices: boolean;
    chainAcrossFloors: boolean;
  }
): LongTermScheduleState {
  const { calendar } = state;
  const serviceMap = new Map<string, ScheduleServicePackage>();
  state.services.forEach((s) => serviceMap.set(s.id, s));

  const groupPosMap = new Map<string, number>();
  state.replicationGroups.forEach((g) => groupPosMap.set(g.id, g.position));

  const floorIdSet = new Set(options.floorIds);
  const selectedFloors = state.floors
    .filter((f) => floorIdSet.has(f.id))
    .sort((a, b) => {
      const ga = groupPosMap.get(a.replicationGroupId) ?? 999;
      const gb = groupPosMap.get(b.replicationGroupId) ?? 999;
      if (ga !== gb) return ga - gb;
      return (a.position || 0) - (b.position || 0);
    });

  if (options.direction === 'down') {
    selectedFloors.reverse();
  }

  const pace = Math.max(1, Math.round(Number(options.pacedFloors) || 1));
  const lagDays = Math.max(0, Math.round(Number(options.lagBetweenServicesDays) ?? 1));
  const baseStart = ensureWorkDay(options.startDate || calendar.startDate, calendar, 1);

  const nextActivities = [...state.activities];
  const existingIndexMap = new Map<string, number>();
  nextActivities.forEach((a, idx) => existingIndexMap.set(`${a.serviceId}||${a.floorId}`, idx));

  options.serviceIds.forEach((serviceId, sIdx) => {
    const pkg = serviceMap.get(serviceId);
    if (!pkg) return;

    const prevServiceId = sIdx > 0 ? options.serviceIds[sIdx - 1] : null;
    const pkgDuration = Math.max(
      1,
      pkg.jobs?.reduce((acc, j) => acc + (Number(j.defaultDuration) || 1), 0) || pkg.defaultDuration || 5
    );

    selectedFloors.forEach((floor, fIdx) => {
      const stepIndex = Math.floor(fIdx / pace);
      let initialStart = baseStart;
      if (stepIndex > 0) {
        initialStart = offsetWorkingDays(baseStart, stepIndex * pkgDuration, calendar);
      }

      const rules: DependencyRule[] = [];

      if (options.chainAcrossServices && prevServiceId) {
        rules.push({
          id: `rule_same_${prevServiceId}_${serviceId}`,
          precedenceAttribute: 'start',
          delay: Math.max(1, lagDays),
          timeOperation: 'after',
          baseAttribute: 'end',
          predecessorServiceId: prevServiceId,
          floorDirection: 'same',
        });
      }

      if (options.chainAcrossFloors && fIdx >= pace) {
        const predFloor = selectedFloors[fIdx - pace];
        if (predFloor) {
          const isImmediateBelow = pace === 1 && options.direction === 'up';
          const isImmediateAbove = pace === 1 && options.direction === 'down';
          rules.push({
            id: `rule_vert_${serviceId}_${predFloor.id}`,
            precedenceAttribute: 'start',
            delay: 1,
            timeOperation: 'after',
            baseAttribute: 'end',
            predecessorServiceId: serviceId,
            floorDirection: isImmediateBelow ? 'below' : isImmediateAbove ? 'above' : 'specific',
            specificFloorId: !isImmediateBelow && !isImmediateAbove ? predFloor.id : undefined,
          });
        }
      }

      const key = `${serviceId}||${floor.id}`;
      const existingIdx = existingIndexMap.get(key) ?? -1;
      if (existingIdx >= 0) {
        const existing = nextActivities[existingIdx];
        const updated = syncActivityJobs(
          {
            ...existing,
            start: sIdx === 0 && fIdx < pace ? baseStart : existing.start,
            dependencyRules: rules.length > 0 ? rules : existing.dependencyRules,
          },
          pkg,
          calendar,
          'from-jobs'
        );
        nextActivities[existingIdx] = updated;
      } else {
        const newAct: LobActivity = syncActivityJobs(
          {
            id: `lob_act_${slugifySchedule(floor.name)}_${slugifySchedule(pkg.name)}`,
            serviceId: pkg.id,
            floorId: floor.id,
            line: pkg.defaultLine || ((sIdx % 5) + 1),
            start: initialStart,
            end: addWorkingDays(initialStart, pkgDuration, calendar),
            duration: pkgDuration,
            cost: pkg.defaultTotalCost || 0,
            responsible: pkg.defaultResponsible || 'EQUIPE GERAL',
            progress: 0,
            predecessorIds: [],
            successorIds: [],
            dependencyRules: rules,
            jobs: [],
          },
          pkg,
          calendar,
          'from-jobs'
        );
        existingIndexMap.set(key, nextActivities.length);
        nextActivities.push(newAct);
      }
    });
  });

  const recalculated = recalculateSchedule(
    {
      ...state,
      activities: nextActivities,
    },
    { forceRemoveGaps: true }
  );

  return recalculated.state;
}

export function compileLobToCronograma(
  state: LongTermScheduleState,
  existingFloorsData: Record<string, any> = {},
  existingWeights: Record<string, Record<string, number>> = {},
  existingTeams: string[] = [],
  existingMatrices: any[] = []
): {
  cronogramaInicial: any[];
  floors: string[];
  allFloorsData: Record<string, any>;
  weights: Record<string, Record<string, number>>;
  teams: string[];
  matrices: any[];
} {
  const { state: syncedState } = recalculateSchedule(state);

  const groupMap = new Map<string, ReplicationGroup>();
  syncedState.replicationGroups.forEach((g) => groupMap.set(g.id, g));

  const serviceMap = new Map<string, ScheduleServicePackage>();
  syncedState.services.forEach((s) => serviceMap.set(s.id, s));

  const orderedFloors = [...syncedState.floors].sort((a, b) => {
    const ga = groupMap.get(a.replicationGroupId)?.position ?? 999;
    const gb = groupMap.get(b.replicationGroupId)?.position ?? 999;
    if (ga !== gb) return ga - gb;
    return (a.position || 0) - (b.position || 0);
  });

  const floorNames = orderedFloors.map((f) => f.name);
  const floorById = new Map<string, ScheduleFloor>();
  orderedFloors.forEach((f) => floorById.set(f.id, f));

  const updatedFloorsData: Record<string, any> = {};
  const updatedWeights: Record<string, Record<string, number>> = { ...existingWeights };
  const teamsSet = new Set<string>((existingTeams || []).map((t) => t.toUpperCase()));

  floorNames.forEach((fName) => {
    updatedFloorsData[fName] = existingFloorsData?.[fName] ? JSON.parse(JSON.stringify(existingFloorsData[fName])) : {};
    Object.keys(updatedFloorsData[fName]).forEach((macroKey) => {
      const sec = updatedFloorsData[fName][macroKey];
      if (sec && Array.isArray(sec.items)) {
        sec.items = sec.items.filter(
          (it: any) => it && !String(it.id).startsWith('lob_') && !String(it.id).startsWith('xls_')
        );
        if (sec.items.length === 0) {
          delete updatedFloorsData[fName][macroKey];
        }
      }
    });
    if (!updatedWeights[fName]) updatedWeights[fName] = {};
  });

  const orderedActivities = [...syncedState.activities].sort((a, b) => {
    const fa = floorById.get(a.floorId);
    const fb = floorById.get(b.floorId);
    const ga = fa ? groupMap.get(fa.replicationGroupId)?.position ?? 999 : 999;
    const gb = fb ? groupMap.get(fb.replicationGroupId)?.position ?? 999 : 999;
    if (ga !== gb) return ga - gb;
    const sa = serviceMap.get(a.serviceId)?.position ?? 999;
    const sb = serviceMap.get(b.serviceId)?.position ?? 999;
    if (sa !== sb) return sa - sb;
    return (fa?.position || 0) - (fb?.position || 0);
  });

  const cronogramaInicial: any[] = [];
  const macroKeysSet = new Set<string>();

  orderedActivities.forEach((act, actIdx) => {
    const floor = floorById.get(act.floorId);
    const pkg = serviceMap.get(act.serviceId);
    if (!floor || !pkg) return;

    const floorName = floor.name;
    const macroName = pkg.name.toUpperCase();
    const macroKey = slugifySchedule(macroName);
    macroKeysSet.add(macroKey);

    const groupName = (groupMap.get(floor.replicationGroupId)?.name || 'NÃO AGRUPADO').toUpperCase();
    const responsible = (act.responsible || pkg.defaultResponsible || 'EQUIPE GERAL').toUpperCase();
    teamsSet.add(responsible);

    if (!updatedFloorsData[floorName]) updatedFloorsData[floorName] = {};
    if (!updatedFloorsData[floorName][macroKey]) {
      updatedFloorsData[floorName][macroKey] = {
        title: macroName,
        items: [],
      };
    }
    if (updatedWeights[floorName][macroKey] === undefined) {
      updatedWeights[floorName][macroKey] = 1;
    }

    const parentOriginalId = act.originalId || String((actIdx + 1) * 10);

    const jobs = act.jobs && act.jobs.length > 0 ? act.jobs : [];
    jobs.forEach((job, jIdx) => {
      const jobResponsible = (job.responsible || responsible).toUpperCase();
      teamsSet.add(jobResponsible);
      const jobOriginalId = job.originalId || `${parentOriginalId}.${jIdx + 1}`;
      const jobServiceName = job.name.toUpperCase();

      const mergedPredecessors = Array.from(
        new Set([...(act.predecessorIds || []), ...(job.predecessors || [])].filter(Boolean))
      );
      const mergedSuccessors = Array.from(
        new Set([...(act.successorIds || []), ...(job.successors || [])].filter(Boolean))
      );

      const cronoChild = {
        id: job.id,
        macro: macroName,
        floor: floorName,
        service: jobServiceName,
        duration: Math.max(1, Number(job.duration) || 1),
        start: job.start,
        end: job.end,
        cost: Number(job.cost) || 0,
        responsible: jobResponsible,
        progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
        predecessors: mergedPredecessors,
        successors: mergedSuccessors,
        inheritedDependenciesFrom: act.id || '',
        originalId: jobOriginalId,
        replicationGroup: groupName,
        isParent: false,
      };

      cronogramaInicial.push(cronoChild);

      const floorItemPayload = {
        id: job.id,
        name: jobServiceName,
        actualPercent: cronoChild.progress,
        predecessors: cronoChild.predecessors,
        successors: cronoChild.successors,
        inheritedDependenciesFrom: cronoChild.inheritedDependenciesFrom,
        originalId: cronoChild.originalId,
        replicationGroup: groupName,
      };
      updatedFloorsData[floorName][macroKey].items.push(floorItemPayload);
    });
  });

  const macroKeysList = Array.from(macroKeysSet);
  let updatedMatrices = existingMatrices && existingMatrices.length > 0 ? [...existingMatrices] : [];
  if (updatedMatrices.length === 0) {
    updatedMatrices = [
      {
        id: 'default_matrix',
        name: 'Matriz Principal',
        floors: floorNames,
        macros: macroKeysList,
      },
    ];
  } else {
    updatedMatrices = updatedMatrices.map((m, idx) => {
      if (idx === 0 || m.id === 'default_matrix') {
        return {
          ...m,
          floors: Array.from(new Set([...(m.floors || []), ...floorNames])),
          macros: Array.from(new Set([...(m.macros || []), ...macroKeysList])),
        };
      }
      return m;
    });
  }

  return {
    cronogramaInicial,
    floors: floorNames,
    allFloorsData: updatedFloorsData,
    weights: updatedWeights,
    teams: Array.from(teamsSet),
    matrices: updatedMatrices,
  };
}

/**
 * Hidratação O(N) em passagem única a partir de `cronogramaInicial`
 */
export function hydrateLobFromCronograma(
  cronogramaInicial: any[] = [],
  floorsList: string[] = [],
  allFloorsData: Record<string, any> = {},
  existingCalendar?: Partial<ProjectCalendar>
): LongTermScheduleState {
  let minStart = '';
  let maxEnd = '';
  const groupNamesOrder: string[] = [];
  const groupNameSet = new Set<string>();
  const floorToGroupName = new Map<string, string>();
  const macroNamesOrder: string[] = [];
  const macroNameSet = new Set<string>();
  const itemsByMacro = new Map<string, any[]>();
  const itemsByMacroAndFloor = new Map<string, any[]>();

  // Passagem única O(N) sobre cronogramaInicial
  const len = cronogramaInicial ? cronogramaInicial.length : 0;
  for (let i = 0; i < len; i++) {
    const item = cronogramaInicial[i];
    if (!item) continue;
    if (item.start && (!minStart || item.start < minStart)) minStart = item.start;
    if (item.end && (!maxEnd || item.end > maxEnd)) maxEnd = item.end;

    const fName = item.floor;
    if (fName) {
      const gName = (item.replicationGroup || 'TORRE PRINCIPAL').toUpperCase();
      if (!groupNameSet.has(gName)) {
        groupNameSet.add(gName);
        groupNamesOrder.push(gName);
      }
      if (!floorToGroupName.has(fName)) {
        floorToGroupName.set(fName, gName);
      }
    }

    if (item.macro && fName) {
      const mName = item.macro.toUpperCase();
      if (!macroNameSet.has(mName)) {
        macroNameSet.add(mName);
        macroNamesOrder.push(mName);
        itemsByMacro.set(mName, []);
      }
      itemsByMacro.get(mName)!.push(item);

      const mfKey = `${mName}||${fName}`;
      let mfList = itemsByMacroAndFloor.get(mfKey);
      if (!mfList) {
        mfList = [];
        itemsByMacroAndFloor.set(mfKey, mfList);
      }
      mfList.push(item);
    }
  }

  const baseCal = createDefaultCalendar(minStart || existingCalendar?.startDate);
  const calendar: ProjectCalendar = {
    ...baseCal,
    ...existingCalendar,
    startDate: minStart || existingCalendar?.startDate || baseCal.startDate,
    endDate: maxEnd && maxEnd > baseCal.endDate ? maxEnd : existingCalendar?.endDate || baseCal.endDate,
  };

  if (len === 0 && (!floorsList || floorsList.length === 0)) {
    return {
      calendar,
      replicationGroups: [],
      floors: [],
      services: [],
      activities: [],
    };
  }

  if (groupNamesOrder.length === 0) {
    groupNamesOrder.push('TORRE PRINCIPAL');
  }

  const replicationGroups: ReplicationGroup[] = groupNamesOrder.map((name, idx) => ({
    id: `grp_${slugifySchedule(name) || idx}`,
    name,
    position: idx + 1,
    linesPerFloor: 5,
    color: GROUP_COLORS[idx % GROUP_COLORS.length],
  }));
  const groupIdByName = new Map<string, string>();
  replicationGroups.forEach((g) => groupIdByName.set(g.name, g.id));

  const allFloorNamesSet = new Set<string>(floorsList || []);
  for (let i = 0; i < len; i++) {
    const f = cronogramaInicial[i]?.floor;
    if (f) allFloorNamesSet.add(f);
  }
  const allFloorNames = Array.from(allFloorNamesSet);

  const floors: ScheduleFloor[] = allFloorNames.map((fName, idx) => {
    const gName = floorToGroupName.get(fName) || groupNamesOrder[0];
    return {
      id: `flr_${slugifySchedule(fName) || idx}`,
      name: fName,
      position: idx + 1,
      replicationGroupId: groupIdByName.get(gName) || replicationGroups[0].id,
    };
  });
  const floorIdByName = new Map<string, string>();
  floors.forEach((f) => floorIdByName.set(f.name, f.id));

  const services: ScheduleServicePackage[] = macroNamesOrder.map((mName, mIdx) => {
    const serviceId = `pkg_${slugifySchedule(mName) || mIdx}`;
    const jobTemplatesMap = new Map<string, ScheduleJobTemplate>();
    const macroItems = itemsByMacro.get(mName) || [];

    for (let i = 0; i < macroItems.length; i++) {
      const c = macroItems[i];
      if (c.isParent) continue;
      const sName = (c.service || mName).toUpperCase();
      if (!jobTemplatesMap.has(sName)) {
        jobTemplatesMap.set(sName, {
          id: `tpl_${slugifySchedule(mName)}_${slugifySchedule(sName)}`,
          name: sName,
          position: jobTemplatesMap.size + 1,
          defaultDuration: Math.max(1, Number(c.duration) || 5),
          defaultResponsible: (c.responsible || 'EQUIPE GERAL').toUpperCase(),
          costWeight: Number(c.cost) || 0,
        });
      }
    }

    const jobsList = Array.from(jobTemplatesMap.values());
    const defaultDuration = jobsList.reduce((acc, j) => acc + j.defaultDuration, 0) || 5;
    const defaultTotalCost = jobsList.reduce((acc, j) => acc + j.costWeight, 0) || 0;

    return {
      id: serviceId,
      name: mName,
      color: PACKAGE_COLORS[mIdx % PACKAGE_COLORS.length],
      position: mIdx + 1,
      defaultLine: (mIdx % 5) + 1,
      defaultDuration,
      defaultResponsible: jobsList[0]?.defaultResponsible || 'EQUIPE GERAL',
      defaultTotalCost,
      autoChainJobs: true,
      jobs: jobsList,
    };
  });

  const serviceByName = new Map<string, ScheduleServicePackage>();
  services.forEach((s) => serviceByName.set(s.name, s));

  const activities: LobActivity[] = [];
  const actByServiceAndFloor = new Map<string, LobActivity>();
  const itemIdToActivityId = new Map<string, string>();
  const originalIdToActivityId = new Map<string, string>();

  itemsByMacroAndFloor.forEach((groupItems, key) => {
    const [mName, fName] = key.split('||');
    const pkg = serviceByName.get(mName);
    const floorId = floorIdByName.get(fName);
    if (!pkg || !floorId) return;

    let parentRow: any = undefined;
    const childRows: any[] = [];
    for (let i = 0; i < groupItems.length; i++) {
      if (groupItems[i].isParent) parentRow = groupItems[i];
      else childRows.push(groupItems[i]);
    }
    const effectiveChildren = childRows.length > 0 ? childRows : groupItems;

    let actStart = '';
    let actEnd = '';
    let totalCost = 0;
    let sumDuration = 0;

    const macroSlug = slugifySchedule(mName);
    const floorSecItems: any[] = allFloorsData?.[fName]?.[macroSlug]?.items || [];
    const floorProgressById = new Map<string, number>();
    for (let i = 0; i < floorSecItems.length; i++) {
      const fi = floorSecItems[i];
      if (fi?.id && fi.actualPercent !== undefined) {
        floorProgressById.set(fi.id, Number(fi.actualPercent));
      }
    }

    const jobs: LobActivityJob[] = effectiveChildren.map((row, idx) => {
      const rStart = (row.start || calendar.startDate).slice(0, 10);
      const rEnd = (row.end || rStart).slice(0, 10);
      if (!actStart || rStart < actStart) actStart = rStart;
      if (!actEnd || rEnd > actEnd) actEnd = rEnd;
      const costVal = Number(row.cost) || 0;
      totalCost += costVal;
      const durVal = Math.max(1, Number(row.duration) || 1);
      sumDuration += durVal;

      const progressVal =
        row.id && floorProgressById.has(row.id)
          ? floorProgressById.get(row.id)!
          : Number(row.progress) || 0;

      return {
        id: row.id || `lob_job_${slugifySchedule(fName)}_${macroSlug}_${idx + 1}`,
        name: (row.service || mName).toUpperCase(),
        duration: durVal,
        start: rStart,
        end: rEnd,
        cost: costVal,
        responsible: (row.responsible || pkg.defaultResponsible || 'EQUIPE GERAL').toUpperCase(),
        progress: Math.max(0, Math.min(100, progressVal)),
        predecessors: Array.isArray(row.predecessors) ? row.predecessors.map(String) : [],
        successors: Array.isArray(row.successors) ? row.successors.map(String) : [],
        originalId: row.originalId ? String(row.originalId) : undefined,
      };
    });

    const inheritedActId = effectiveChildren.find((r) => r.inheritedDependenciesFrom)?.inheritedDependenciesFrom;
    const actId = parentRow?.id || inheritedActId || `lob_act_${slugifySchedule(fName)}_${macroSlug}`;
    const weightedProgress =
      totalCost > 0
        ? jobs.reduce((acc, j) => acc + j.progress * j.cost, 0) / totalCost
        : jobs.reduce((acc, j) => acc + j.progress, 0) / Math.max(1, jobs.length);

    const activity: LobActivity = {
      id: actId,
      originalId: parentRow?.originalId || effectiveChildren[0]?.originalId,
      serviceId: pkg.id,
      floorId,
      line: pkg.defaultLine || 1,
      start: actStart || calendar.startDate,
      end: actEnd || actStart || calendar.startDate,
      duration: Math.max(1, Number(parentRow?.duration) || sumDuration || 1),
      cost: totalCost,
      responsible: jobs[0]?.responsible || pkg.defaultResponsible || 'EQUIPE GERAL',
      progress: Math.round(weightedProgress * 100) / 100,
      predecessorIds: [],
      successorIds: [],
      dependencyRules: [],
      jobs,
    };

    activities.push(activity);
    actByServiceAndFloor.set(`${pkg.id}||${floorId}`, activity);

    for (let i = 0; i < groupItems.length; i++) {
      const row = groupItems[i];
      if (row.id) itemIdToActivityId.set(String(row.id), actId);
      if (row.originalId) originalIdToActivityId.set(String(row.originalId), actId);
      if (row.inheritedDependenciesFrom) itemIdToActivityId.set(String(row.inheritedDependenciesFrom), actId);
    }
  });

  // Resolve predecessoras/sucessoras em O(1) via Map
  const actById = new Map<string, LobActivity>();
  activities.forEach((a) => actById.set(a.id, a));

  itemsByMacroAndFloor.forEach((groupItems, key) => {
    const [mName, fName] = key.split('||');
    const pkg = serviceByName.get(mName);
    const floorId = floorIdByName.get(fName);
    if (!pkg || !floorId) return;
    const act = actByServiceAndFloor.get(`${pkg.id}||${floorId}`);
    if (!act) return;

    const predSet = new Set<string>(act.predecessorIds);
    const succSet = new Set<string>(act.successorIds);
    for (let i = 0; i < groupItems.length; i++) {
      const preds = groupItems[i].predecessors;
      if (Array.isArray(preds)) {
        for (let j = 0; j < preds.length; j++) {
          const token = String(preds[j]).trim();
          const targetActId = itemIdToActivityId.get(token) || originalIdToActivityId.get(token);
          if (targetActId && targetActId !== act.id) {
            predSet.add(targetActId);
          }
        }
      }
      const succs = groupItems[i].successors;
      if (Array.isArray(succs)) {
        for (let j = 0; j < succs.length; j++) {
          const token = String(succs[j]).trim();
          const targetActId = itemIdToActivityId.get(token) || originalIdToActivityId.get(token);
          if (targetActId && targetActId !== act.id) {
            succSet.add(targetActId);
          }
        }
      }
    }

    act.predecessorIds = Array.from(predSet);
    act.predecessorIds.forEach((pId) => {
      const pAct = actById.get(pId);
      if (pAct && !pAct.successorIds.includes(act.id)) {
        pAct.successorIds.push(act.id);
      }
    });
    succSet.forEach((sId) => {
      const sAct = actById.get(sId);
      if (sAct) {
        if (!act.successorIds.includes(sId)) act.successorIds.push(sId);
        if (!sAct.predecessorIds.includes(act.id)) sAct.predecessorIds.push(act.id);
      }
    });
  });

  return {
    calendar,
    replicationGroups,
    floors,
    services,
    activities,
  };
}
