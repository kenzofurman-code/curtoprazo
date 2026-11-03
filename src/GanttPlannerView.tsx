import { cloudStorage } from './firebaseDocuments';
import React, { useState, useMemo, useRef, useEffect } from 'react';
import type {
  LobActivity,
  ScheduleFloor,
  ScheduleServicePackage,
  ReplicationGroup,
  ProjectCalendar,
} from './longTermSchedule';
import {
  diffCalendarDays,
  addCalendarDays,
  isWorkDay,
  slugifySchedule,
  getTodayISO,
} from './longTermSchedule';
import type { ScheduleVersion } from './scheduleVersions';

export interface GanttTaskItem {
  id: string;
  code?: string;
  name: string;
  packageName: string;
  packageFamily: string;
  lotMother: string;
  lot: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  duration: number;
  progress: number;
  plannedProgress?: number;
  responsible?: string;
  cost?: number;
  quantity?: number;
  unit?: string;
  color?: string;
  predecessors?: string[];
  successors?: string[];
  services?: string[];
  isCritical?: boolean;
}

export interface GanttPlannerViewProps {
  projectKey: string;
  projectName?: string;
  projectStartDate?: string;
  activities: LobActivity[];
  floors: ScheduleFloor[];
  services: ScheduleServicePackage[];
  replicationGroups?: ReplicationGroup[];
  calendar?: ProjectCalendar;
  cronogramaInicial?: any[];
  scheduleVersions?: ScheduleVersion[];
  currentActiveVersion?: ScheduleVersion | null;
  baselineTaskMap?: Map<string, { start: string; end: string; duration: number }>;
  showGhostBaseline?: boolean;
  onToggleGhostBaseline?: (val: boolean) => void;
  onOpenVersionDrawer?: () => void;
  onCreateNewVersion?: () => void;
  onUpdateActivityDates?: (activityId: string, startDate: string, endDate: string, duration: number) => void;
  onUpdateActivityProgress?: (activityId: string, progress: number) => void;
  onUpdateActivityDetails?: (activityId: string, updates: Partial<LobActivity>) => void;
}

const ROW_HEIGHT = 36;
const MONTH_NAMES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];
const DAY_LETTERS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function formatDateBR(dateStr?: string): string {
  if (!dateStr) return '-';
  const parts = dateStr.slice(0, 10).split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0].slice(2)}`;
  }
  return dateStr;
}

function calcPlannedProgress(startDate: string, endDate: string, todayISO: string): number {
  if (!startDate || !endDate) return 0;
  if (todayISO < startDate) return 0;
  if (todayISO >= endDate) return 100;
  const total = Math.max(1, diffCalendarDays(startDate, endDate) + 1);
  const elapsed = Math.max(0, diffCalendarDays(startDate, todayISO) + 1);
  return Math.round(Math.min(100, Math.max(0, (elapsed / total) * 100)));
}

function naturalCompare(a: string, b: string): number {
  const matchA = a.match(/\d+/);
  const matchB = b.match(/\d+/);
  if (matchA && matchB) {
    const numA = parseInt(matchA[0], 10);
    const numB = parseInt(matchB[0], 10);
    if (numA !== numB) return numA - numB;
  }
  return a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
}

interface EapRow {
  id: string;
  code: string;
  name: string;
  level: number;
  startDate: string;
  endDate: string;
  duration: number;
  progress: number;
  plannedProgress: number;
  cost?: number;
  location?: string;
  group?: string;
  responsible?: string;
  predecessors?: string[];
  successors?: string[];
  isGroup: boolean;
  isCritical?: boolean;
  children?: EapRow[];
  task?: GanttTaskItem;
  serviceName?: string;
}

export const GanttPlannerView: React.FC<GanttPlannerViewProps> = ({
  projectKey,
  projectStartDate,
  activities,
  floors,
  services,
  replicationGroups = [],
  calendar,
  cronogramaInicial,
  scheduleVersions = [],
  currentActiveVersion,
  baselineTaskMap,
  showGhostBaseline = false,
  onToggleGhostBaseline,
  onOpenVersionDrawer,
  onCreateNewVersion,
  onUpdateActivityDates,
  onUpdateActivityProgress,
}) => {
  const todayISO = useMemo(() => getTodayISO(), []);

  // Mapas auxiliares
  const floorMap = useMemo(() => new Map(floors.map((f) => [f.id, f])), [floors]);
  const serviceMap = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const groupMap = useMemo(() => new Map(replicationGroups.map((g) => [g.id, g])), [replicationGroups]);

  // Converter activities para GanttTaskItem
  const tasks: GanttTaskItem[] = useMemo(() => {
    if (activities && activities.length > 0) {
      return activities.map((act) => {
        const flr = floorMap.get(act.floorId);
        const pkg = serviceMap.get(act.serviceId);
        const grp = flr?.replicationGroupId ? groupMap.get(flr.replicationGroupId) : null;

        let lotMother = grp?.name || '';
        if (!lotMother) {
          const fn = flr?.name || '';
          if (fn.toLowerCase().includes('subsolo')) lotMother = 'Subsolos';
          else if (fn.toLowerCase().includes('térreo') || fn.toLowerCase().includes('terreo')) lotMother = 'Áreas Comuns';
          else if (fn.toLowerCase().includes('ático') || fn.toLowerCase().includes('cobertura')) lotMother = 'Cobertura';
          else lotMother = 'Torre';
        }

        const microServices = act.jobs?.map((j) => j.name) || [];

        return {
          id: act.id,
          name: pkg?.name || 'Atividade',
          packageName: pkg?.name || 'Pacote de Trabalho',
          packageFamily: grp?.name || pkg?.name || 'Geral',
          lotMother,
          lot: flr?.name || 'Pavimento Geral',
          startDate: act.start,
          endDate: act.end,
          duration: act.duration,
          progress: act.progress ?? 0,
          responsible: act.responsible || '',
          cost: act.cost || 0,
          color: pkg?.color || '#059669',
          predecessors: act.predecessorIds || [],
          successors: act.successorIds || [],
          services: microServices,
        };
      });
    }

    if (cronogramaInicial && cronogramaInicial.length > 0) {
      return cronogramaInicial.map((c) => ({
        id: String(c.id || Math.random()),
        name: c.sub || c.macro || 'Tarefa',
        packageName: c.macro || 'Pacote',
        packageFamily: c.macro || 'Geral',
        lotMother: c.macro || 'Obra',
        lot: c.floor || 'Geral',
        startDate: c.data_inicio || c.data_inicio_real || todayISO,
        endDate: c.data_fim || c.data_fim_real || todayISO,
        duration: Number(c.duracao) || 1,
        progress: Number(c.progresso_real ?? c.progress ?? 0),
        responsible: c.responsavel || '',
        cost: Number(c.custo) || 0,
        color: '#059669',
        predecessors: Array.isArray(c.predecessoras) ? c.predecessoras : [],
        successors: [],
        services: [],
      }));
    }

    return [];
  }, [activities, cronogramaInicial, floorMap, serviceMap, groupMap, todayISO]);

  // Preencher sucessores
  const tasksWithSuccessors = useMemo(() => {
    const successorMap = new Map<string, string[]>();
    tasks.forEach((t) => {
      (t.predecessors || []).forEach((predId) => {
        if (!successorMap.has(predId)) successorMap.set(predId, []);
        successorMap.get(predId)!.push(t.id);
      });
    });
    return tasks.map((t) => ({
      ...t,
      successors: t.successors && t.successors.length > 0 ? t.successors : successorMap.get(t.id) || [],
    }));
  }, [tasks]);

  // Controles de Visualização
  const [zoomMode, setZoomMode] = useState<'day' | 'week' | 'month'>('week');
  const [pxPerDay, setPxPerDay] = useState<number>(11);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [monthFormat, setMonthFormat] = useState<'numeric' | 'index' | 'name_year'>('name_year');
  const [weekFormat, setWeekFormat] = useState<'short' | 'numeric' | 'day'>('numeric');
  const [eapLevelFilter, setEapLevelFilter] = useState<number>(3);
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<string>('');
  const [selectedTeamFilter, setSelectedTeamFilter] = useState<string>('');
  const [showCriticalPath, setShowCriticalPath] = useState<boolean>(false);
  const [showDependencies, setShowDependencies] = useState<boolean>(true);
  const [showRollupBars, setShowRollupBars] = useState<boolean>(false);
  const [dependencyMaxLevel, setDependencyMaxLevel] = useState<number>(3);
  const [isConfigOpen, setIsConfigOpen] = useState<boolean>(false);
  const [configTab, setConfigTab] = useState<'structure' | 'timeline' | 'versions'>('structure');
  const [isLevelFilterOpen, setIsLevelFilterOpen] = useState<boolean>(false);
  const [isColsFilterOpen, setIsColsFilterOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<GanttTaskItem | null>(null);
  const [customMacroOrder, setCustomMacroOrder] = useState<string[]>([]);
  const [levelSort, setLevelSort] = useState({
    level2: { field: 'original', direction: 'asc' },
    level3: { field: 'startDate', direction: 'asc' },
    level4: { field: 'original', direction: 'asc' },
  });
  const [eapPanelWidth, setEapPanelWidth] = useState<number>(540);

  // Colunas Visíveis
  const [visibleCols, setVisibleCols] = useState<Record<string, boolean>>({
    code: true,
    name: true,
    startDate: true,
    endDate: true,
    duration: true,
    progress: true,
    plannedProgress: true,
    predecessors: false,
    successors: false,
    criticalPath: false,
    location: true,
    group: true,
    baselineStart: true,
    cost: false,
  });

  // Undo / Redo stacks
  const [undoStack, setUndoStack] = useState<GanttTaskItem[][]>([]);
  const [redoStack, setRedoStack] = useState<GanttTaskItem[][]>([]);

  // Carregar e persistir configurações
  const [configLoadedProject, setConfigLoadedProject] = useState<string | null>(null);
  useEffect(() => {
    try {
      const storageKey = `curtoprazo_gantt_config_${projectKey || 'global'}`;
      const saved = cloudStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.pxPerDay === 'number') setPxPerDay(parsed.pxPerDay);
        if (parsed.zoomMode) setZoomMode(parsed.zoomMode);
        if (parsed.monthFormat) setMonthFormat(parsed.monthFormat);
        if (parsed.weekFormat) setWeekFormat(parsed.weekFormat);
        if (typeof parsed.eapLevelFilter === 'number') setEapLevelFilter(parsed.eapLevelFilter);
        if (typeof parsed.showCriticalPath === 'boolean') setShowCriticalPath(parsed.showCriticalPath);
        if (typeof parsed.showDependencies === 'boolean') setShowDependencies(parsed.showDependencies);
        if (typeof parsed.showRollupBars === 'boolean') setShowRollupBars(parsed.showRollupBars);
        if (typeof parsed.dependencyMaxLevel === 'number') setDependencyMaxLevel(parsed.dependencyMaxLevel);
        if (typeof parsed.eapPanelWidth === 'number') setEapPanelWidth(parsed.eapPanelWidth);
        if (parsed.visibleCols) setVisibleCols((prev) => ({ ...prev, ...parsed.visibleCols }));
        if (Array.isArray(parsed.customMacroOrder)) setCustomMacroOrder(parsed.customMacroOrder);
        if (parsed.levelSort) setLevelSort((prev) => ({ ...prev, ...parsed.levelSort }));
      }
    } catch (_) {}
    setConfigLoadedProject(projectKey || 'global');
  }, [projectKey]);

  useEffect(() => {
    if (configLoadedProject !== (projectKey || 'global')) return;
    try {
      const storageKey = `curtoprazo_gantt_config_${projectKey || 'global'}`;
      const config = {
        pxPerDay,
        zoomMode,
        monthFormat,
        weekFormat,
        eapLevelFilter,
        showCriticalPath,
        showDependencies,
        showRollupBars,
        dependencyMaxLevel,
        eapPanelWidth,
        visibleCols,
        customMacroOrder,
        levelSort,
      };
      cloudStorage.setItem(storageKey, JSON.stringify(config));
    } catch (_) {}
  }, [
    configLoadedProject,
    projectKey,
    pxPerDay,
    zoomMode,
    monthFormat,
    weekFormat,
    eapLevelFilter,
    showCriticalPath,
    showDependencies,
    showRollupBars,
    dependencyMaxLevel,
    eapPanelWidth,
    visibleCols,
    customMacroOrder,
    levelSort,
  ]);

  const handleZoomModeChange = (mode: 'day' | 'week' | 'month') => {
    setZoomMode(mode);
    if (mode === 'day') setPxPerDay(24);
    else if (mode === 'week') setPxPerDay(11);
    else setPxPerDay(4.8);
  };

  // Splitter de Redimensionamento do Painel Esquerdo
  const isDraggingSplitter = useRef(false);
  const startSplitterX = useRef(0);
  const initialPanelWidth = useRef(540);

  const handleSplitterPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    isDraggingSplitter.current = true;
    startSplitterX.current = e.clientX;
    initialPanelWidth.current = eapPanelWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleSplitterPointerMove = (e: React.PointerEvent) => {
    if (!isDraggingSplitter.current) return;
    e.preventDefault();
    const delta = e.clientX - startSplitterX.current;
    const maxWidth = Math.max(800, window.innerWidth - 200);
    const newWidth = Math.max(260, Math.min(maxWidth, initialPanelWidth.current + delta));
    setEapPanelWidth(newWidth);
  };

  const handleSplitterPointerUp = (e: React.PointerEvent) => {
    if (isDraggingSplitter.current) {
      isDraggingSplitter.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
    }
  };

  // Sincronização de Rolagem Vertical e Horizontal
  const leftTableRef = useRef<HTMLDivElement>(null);
  const rightGanttRef = useRef<HTMLDivElement>(null);
  const rightHeaderSvgRef = useRef<HTMLDivElement>(null);
  const isScrollingLeft = useRef(false);
  const isScrollingRight = useRef(false);

  const handleLeftScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (isScrollingRight.current) return;
    isScrollingLeft.current = true;
    if (rightGanttRef.current) {
      rightGanttRef.current.scrollTop = e.currentTarget.scrollTop;
    }
    setTimeout(() => {
      isScrollingLeft.current = false;
    }, 50);
  };

  const handleRightScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (isScrollingLeft.current) return;
    isScrollingRight.current = true;
    if (leftTableRef.current) {
      leftTableRef.current.scrollTop = e.currentTarget.scrollTop;
    }
    if (rightHeaderSvgRef.current) {
      rightHeaderSvgRef.current.style.transform = `translateX(-${e.currentTarget.scrollLeft}px)`;
    }
    setTimeout(() => {
      isScrollingRight.current = false;
    }, 50);
  };

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const handleExpandAll = () => {
    setCollapsedGroupIds(new Set());
  };

  const handleCollapseAll = () => {
    const allGroupIds = new Set<string>();
    eapTree.forEach((m) => {
      allGroupIds.add(m.id);
      m.children?.forEach((l) => allGroupIds.add(l.id));
    });
    setCollapsedGroupIds(allGroupIds);
  };

  // Macros (Lotes-Mãe)
  const macrosList = useMemo(() => {
    const unique = Array.from(new Set(tasksWithSuccessors.map((t) => t.lotMother || 'Geral')));
    if (customMacroOrder.length) {
      return [
        ...customMacroOrder.filter((m) => unique.includes(m)),
        ...unique.filter((m) => !customMacroOrder.includes(m)),
      ];
    }
    return unique;
  }, [tasksWithSuccessors, customMacroOrder]);

  const moveMacroOrder = (macro: string, direction: 'up' | 'down') => {
    const list = [...macrosList];
    const idx = list.indexOf(macro);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= list.length) return;
    const [item] = list.splice(idx, 1);
    list.splice(targetIdx, 0, item);
    setCustomMacroOrder(list);
  };

  // Construção da Árvore Hierárquica EAP (4 Níveis)
  const eapTree = useMemo(() => {
    const macroMap = new Map<string, GanttTaskItem[]>();
    tasksWithSuccessors.forEach((t) => {
      if (selectedGroupFilter && t.lotMother !== selectedGroupFilter) return;
      if (selectedTeamFilter && t.responsible?.toUpperCase() !== selectedTeamFilter.toUpperCase()) return;
      const m = t.lotMother || 'Geral';
      if (!macroMap.has(m)) macroMap.set(m, []);
      macroMap.get(m)!.push(t);
    });

    let macroIndex = 1;
    const tree: EapRow[] = [];

    macrosList.forEach((macroName) => {
      const macroTasks = macroMap.get(macroName);
      if (!macroTasks || !macroTasks.length) return;

      const macroCode = `1.${macroIndex}`;
      macroIndex++;

      const lotMap = new Map<string, GanttTaskItem[]>();
      macroTasks.forEach((t) => {
        const l = t.lot || 'Principal';
        if (!lotMap.has(l)) lotMap.set(l, []);
        lotMap.get(l)!.push(t);
      });

      let lotEntries = Array.from(lotMap.entries());
      if (levelSort.level2.field === 'name') {
        lotEntries.sort(([a], [b]) => naturalCompare(a, b));
      } else if (levelSort.level2.field === 'startDate') {
        lotEntries.sort(([, tasksA], [, tasksB]) => {
          const minA = tasksA.reduce((acc, t) => (t.startDate < acc ? t.startDate : acc), tasksA[0]?.startDate || '');
          const minB = tasksB.reduce((acc, t) => (t.startDate < acc ? t.startDate : acc), tasksB[0]?.startDate || '');
          return minA.localeCompare(minB);
        });
      }
      if (levelSort.level2.direction === 'desc') lotEntries.reverse();

      let lotIndex = 1;
      const lotRows: EapRow[] = [];

      lotEntries.forEach(([lotName, lotTasksList]) => {
        const lotCode = `${macroCode}.${lotIndex}`;
        lotIndex++;

        let sortedTasks = [...lotTasksList];
        if (levelSort.level3.field === 'startDate') {
          sortedTasks.sort((a, b) => a.startDate.localeCompare(b.startDate));
        } else if (levelSort.level3.field === 'name') {
          sortedTasks.sort((a, b) => a.name.localeCompare(b.name));
        } else if (levelSort.level3.field === 'cost') {
          sortedTasks.sort((a, b) => (a.cost || 0) - (b.cost || 0));
        } else if (levelSort.level3.field === 'progress') {
          sortedTasks.sort((a, b) => a.progress - b.progress);
        }
        if (levelSort.level3.direction === 'desc') sortedTasks.reverse();

        let taskIndex = 1;
        const packageRows: EapRow[] = sortedTasks.map((t) => {
          const taskCode = `${lotCode}.${taskIndex}`;
          taskIndex++;

          const dur = Math.max(1, diffCalendarDays(t.startDate, t.endDate) + 1);

          let serviceNames = t.services && t.services.length > 0 ? [...t.services] : [];
          if (levelSort.level4.field === 'name') {
            serviceNames.sort((a, b) => a.localeCompare(b));
          }
          if (levelSort.level4.direction === 'desc') serviceNames.reverse();

          let srvIndex = 1;
          const serviceRows: EapRow[] = serviceNames.map((sName) => {
            const srvCode = `${taskCode}.${srvIndex}`;
            srvIndex++;
            return {
              id: `srv_${t.id}_${srvIndex}`,
              code: srvCode,
              name: sName,
              level: 4,
              startDate: t.startDate,
              endDate: t.endDate,
              duration: dur,
              progress: t.progress,
              plannedProgress: calcPlannedProgress(t.startDate, t.endDate, todayISO),
              location: t.lot,
              group: t.lotMother,
              responsible: t.responsible,
              isGroup: false,
              task: t,
              serviceName: sName,
            };
          });

          return {
            id: t.id,
            code: taskCode,
            name: t.name,
            level: 3,
            startDate: t.startDate,
            endDate: t.endDate,
            duration: t.duration || dur,
            progress: t.progress,
            plannedProgress: calcPlannedProgress(t.startDate, t.endDate, todayISO),
            cost: t.cost,
            location: t.lot,
            group: t.packageFamily || t.lotMother,
            responsible: t.responsible,
            predecessors: t.predecessors,
            successors: t.successors,
            isCritical: false,
            isGroup: serviceRows.length > 0,
            children: serviceRows.length > 0 ? serviceRows : undefined,
            task: t,
          };
        });

        const minLotDate = packageRows.reduce(
          (acc, r) => (r.startDate < acc ? r.startDate : acc),
          packageRows[0]?.startDate || todayISO
        );
        const maxLotDate = packageRows.reduce(
          (acc, r) => (r.endDate > acc ? r.endDate : acc),
          packageRows[0]?.endDate || todayISO
        );
        const lotDur = Math.max(1, diffCalendarDays(minLotDate, maxLotDate) + 1);
        const lotProg = Math.round(
          packageRows.reduce((acc, r) => acc + r.progress, 0) / (packageRows.length || 1)
        );
        const lotCost = packageRows.reduce((acc, r) => acc + (r.cost || 0), 0);
        const lotPlanned = Math.round(
          packageRows.reduce((acc, r) => acc + r.plannedProgress * Math.max(1, r.duration), 0) /
            (packageRows.reduce((acc, r) => acc + Math.max(1, r.duration), 0) || 1)
        );

        lotRows.push({
          id: `lot_${macroName}_${lotName}`,
          code: lotCode,
          name: lotName,
          level: 2,
          startDate: minLotDate,
          endDate: maxLotDate,
          duration: lotDur,
          progress: lotProg,
          plannedProgress: lotPlanned,
          cost: lotCost,
          location: lotName,
          group: macroName,
          isGroup: true,
          children: packageRows,
        });
      });

      const minMacroDate = lotRows.reduce(
        (acc, r) => (r.startDate < acc ? r.startDate : acc),
        lotRows[0]?.startDate || todayISO
      );
      const maxMacroDate = lotRows.reduce(
        (acc, r) => (r.endDate > acc ? r.endDate : acc),
        lotRows[0]?.endDate || todayISO
      );
      const macroDur = Math.max(1, diffCalendarDays(minMacroDate, maxMacroDate) + 1);
      const macroProg = Math.round(lotRows.reduce((acc, r) => acc + r.progress, 0) / (lotRows.length || 1));
      const macroCost = lotRows.reduce((acc, r) => acc + (r.cost || 0), 0);
      const macroPlanned = Math.round(
        lotRows.reduce((acc, r) => acc + r.plannedProgress * Math.max(1, r.duration), 0) /
          (lotRows.reduce((acc, r) => acc + Math.max(1, r.duration), 0) || 1)
      );

      tree.push({
        id: `macro_${macroName}`,
        code: macroCode,
        name: macroName,
        level: 1,
        startDate: minMacroDate,
        endDate: maxMacroDate,
        duration: macroDur,
        progress: macroProg,
        plannedProgress: macroPlanned,
        cost: macroCost,
        group: macroName,
        isGroup: true,
        children: lotRows,
      });
    });

    return tree;
  }, [tasksWithSuccessors, macrosList, levelSort, selectedGroupFilter, selectedTeamFilter, todayISO]);

  // Linhas Visíveis achatadas
  const visibleRows = useMemo(() => {
    const rows: EapRow[] = [];
    const query = searchQuery.trim().toLowerCase();

    const matchesQuery = (row: EapRow): boolean => {
      if (!query) return true;
      return (
        row.name.toLowerCase().includes(query) ||
        row.code.toLowerCase().includes(query) ||
        (row.responsible && row.responsible.toLowerCase().includes(query)) ||
        Boolean(row.children && row.children.some(matchesQuery))
      );
    };

    const traverse = (items: EapRow[]) => {
      items.forEach((item) => {
        if (eapLevelFilter > 0 && item.level > eapLevelFilter) return;
        if (query && !matchesQuery(item)) return;

        rows.push(item);

        if (item.isGroup && item.children) {
          const isCollapsed = collapsedGroupIds.has(item.id);
          if (query || !isCollapsed) {
            traverse(item.children);
          }
        }
      });
    };

    traverse(eapTree);
    return rows;
  }, [eapTree, collapsedGroupIds, eapLevelFilter, searchQuery]);

  // Cálculo da Escala Temporal (Timeline) com 3 níveis (Meses, Semanas, Dias) idêntico à Linha de Balanço
  const timelineBounds = useMemo(() => {
    let minDate = calendar?.startDate || projectStartDate || todayISO;
    let maxDate = addCalendarDays(minDate, 120);

    if (tasksWithSuccessors.length > 0) {
      let minAct = '';
      let maxAct = '';
      for (let i = 0; i < tasksWithSuccessors.length; i++) {
        const a = tasksWithSuccessors[i];
        if (a.startDate && (!minAct || a.startDate < minAct)) minAct = a.startDate;
        if (a.endDate && (!maxAct || a.endDate > maxAct)) maxAct = a.endDate;
      }
      if (minAct) minDate = addCalendarDays(minAct, -7);
      if (maxAct) maxDate = addCalendarDays(maxAct, 21);
    }

    const totalDays = Math.max(45, Math.min(1825, diffCalendarDays(minDate, maxDate) + 1));
    const months: { key: string; label: string; count: number }[] = [];
    const weeks: { key: string; label: string; start: string; count: number }[] = [];
    const days: {
      index: number;
      date: string;
      dayOfMonth: number;
      dayOfWeek: number;
      letter: string;
      isWorking: boolean;
      isEndOfMonth: boolean;
    }[] = [];

    const defaultCal: ProjectCalendar = calendar || {
      startDate: minDate,
      endDate: maxDate,
      workdays: [false, true, true, true, true, true, false],
      holidays: [],
      customWorkdays: [],
      removeGaps: true,
    };

    for (let i = 0; i < totalDays; i++) {
      const d = addCalendarDays(minDate, i);
      const nextD = addCalendarDays(minDate, i + 1);
      const isEndOfMonth = d.slice(5, 7) !== nextD.slice(5, 7);
      const dayOfMonth = Number(d.slice(8, 10));
      const dow = new Date(d + 'T12:00:00Z').getUTCDay();
      const letter = DAY_LETTERS[dow] || 'S';
      const isWorking = isWorkDay(d, defaultCal);

      days.push({
        index: i,
        date: d,
        dayOfMonth,
        dayOfWeek: dow,
        letter,
        isWorking,
        isEndOfMonth,
      });

      const ym = d.slice(0, 7);
      const lastMonth = months[months.length - 1];
      if (lastMonth && lastMonth.key === ym) {
        lastMonth.count++;
      } else {
        const y = Number(ym.slice(0, 4));
        const m = Number(ym.slice(5, 7));
        const mIndex = months.length + 1;
        let mLabel = `${MONTH_NAMES_PT[(m || 1) - 1]} ${y}`;
        if (monthFormat === 'numeric') {
          mLabel = `${String(m).padStart(2, '0')}/${String(y).slice(2)}`;
        } else if (monthFormat === 'index') {
          mLabel = `Mês ${mIndex}`;
        }
        months.push({ key: ym, label: mLabel, count: 1 });
      }

      if (i === 0 || dow === 1) {
        const wIndex = weeks.length + 1;
        let wLabel = `${d.slice(8, 10)}/${d.slice(5, 7)}`;
        if (weekFormat === 'short') {
          wLabel = `S${wIndex}`;
        } else if (weekFormat === 'day') {
          wLabel = `${d.slice(8, 10)}`;
        }
        weeks.push({
          key: `wk_${d}`,
          label: wLabel,
          start: d,
          count: 1,
        });
      } else if (weeks.length > 0) {
        weeks[weeks.length - 1].count++;
      }
    }

    const todayX = diffCalendarDays(minDate, todayISO) * pxPerDay;

    return {
      minDate,
      maxDate: addCalendarDays(minDate, totalDays - 1),
      totalDays,
      months,
      weeks,
      days,
      todayXCoord: todayX,
    };
  }, [calendar, projectStartDate, todayISO, tasksWithSuccessors, pxPerDay, monthFormat, weekFormat]);

  // Centralizar timeline no dia de "Hoje"
  const hasAutoCentered = useRef(false);
  useEffect(() => {
    if (hasAutoCentered.current) return;
    const ganttEl = rightGanttRef.current;
    if (!ganttEl || timelineBounds.todayXCoord < 0 || timelineBounds.todayXCoord > timelineBounds.totalDays * pxPerDay) return;
    const scrollPos = Math.max(0, Math.min(timelineBounds.todayXCoord - ganttEl.clientWidth / 2, ganttEl.scrollWidth - ganttEl.clientWidth));
    ganttEl.scrollLeft = scrollPos;
    if (rightHeaderSvgRef.current) {
      rightHeaderSvgRef.current.style.transform = `translateX(-${scrollPos}px)`;
    }
    hasAutoCentered.current = true;
  }, [timelineBounds, pxPerDay]);

  // Caminho Crítico
  const criticalPathTaskIds = useMemo(() => {
    if (!showCriticalPath) return new Set<string>();
    const terminalTasks = tasksWithSuccessors.filter((t) => !t.successors || t.successors.length === 0);
    const critical = new Set<string>();
    let latestEnd = '';

    terminalTasks.forEach((t) => {
      if (t.endDate > latestEnd) latestEnd = t.endDate;
    });

    const queue = terminalTasks.filter((t) => t.endDate === latestEnd).map((t) => t.id);
    while (queue.length > 0) {
      const id = queue.pop()!;
      critical.add(id);
      const current = tasksWithSuccessors.find((t) => t.id === id);
      if (current && current.predecessors) {
        current.predecessors.forEach((predId) => {
          if (!critical.has(predId)) queue.push(predId);
        });
      }
    }
    return critical;
  }, [tasksWithSuccessors, showCriticalPath]);

  // Dependências SVG
  const dependencyLinks = useMemo(() => {
    const list: Array<{ from: string; to: string }> = [];
    tasksWithSuccessors.forEach((t) => {
      (t.predecessors || []).forEach((pred) => {
        list.push({ from: pred, to: t.id });
      });
    });
    return list;
  }, [tasksWithSuccessors]);

  // Coordenadas das barras para desenhar setas
  const taskCoordsMap = useMemo(() => {
    const coords = new Map<string, { leftX: number; rightX: number; centerY: number }>();
    visibleRows.forEach((row, rowIndex) => {
      if (row.level === dependencyMaxLevel || (!row.isGroup && row.level <= dependencyMaxLevel)) {
        const leftDays = diffCalendarDays(timelineBounds.minDate, row.startDate);
        const durDays = Math.max(1, diffCalendarDays(row.startDate, row.endDate) + 1);
        const leftX = Math.max(0, leftDays * pxPerDay);
        const width = Math.max(16, durDays * pxPerDay);
        const centerY = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
        coords.set(row.id, { leftX, rightX: leftX + width, centerY });
      }
    });
    return coords;
  }, [visibleRows, timelineBounds, pxPerDay, dependencyMaxLevel]);

  // Arrastar e Redimensionar Barras
  const [dragState, setDragState] = useState<{
    type: 'move' | 'resize';
    taskId: string;
    initialPointerX: number;
    initialStartDate: string;
    initialEndDate: string;
    initialDuration: number;
    currentDeltaDays: number;
  } | null>(null);

  const handleBarPointerDown = (e: React.PointerEvent, type: 'move' | 'resize', row: EapRow) => {
    if (!row.task || row.isGroup) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const dur = Math.max(1, diffCalendarDays(row.startDate, row.endDate) + 1);

    setDragState({
      type,
      taskId: row.id,
      initialPointerX: e.clientX,
      initialStartDate: row.startDate,
      initialEndDate: row.endDate,
      initialDuration: dur,
      currentDeltaDays: 0,
    });
  };

  const handleBarPointerMove = (e: React.PointerEvent) => {
    if (!dragState) return;
    e.preventDefault();
    const deltaX = e.clientX - dragState.initialPointerX;
    const deltaDays = Math.round(deltaX / pxPerDay);
    if (deltaDays !== dragState.currentDeltaDays) {
      setDragState((prev) => (prev ? { ...prev, currentDeltaDays: deltaDays } : null));
    }
  };

  const handleBarPointerUp = (e: React.PointerEvent) => {
    if (!dragState) return;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    const delta = dragState.currentDeltaDays;
    if (delta !== 0) {
      let newStart = dragState.initialStartDate;
      let newEnd = dragState.initialEndDate;
      let newDuration = dragState.initialDuration;

      if (dragState.type === 'move') {
        newStart = addCalendarDays(dragState.initialStartDate, delta);
        newEnd = addCalendarDays(dragState.initialEndDate, delta);
      } else if (dragState.type === 'resize') {
        newDuration = Math.max(1, dragState.initialDuration + delta);
        newEnd = addCalendarDays(dragState.initialStartDate, newDuration - 1);
      }

      setUndoStack((prev) => [...prev.slice(-20), tasks]);
      setRedoStack([]);

      if (onUpdateActivityDates) {
        onUpdateActivityDates(dragState.taskId, newStart, newEnd, newDuration);
      }
    }

    setDragState(null);
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((r) => [...r, tasks]);
    setUndoStack((u) => u.slice(0, u.length - 1));
    prev.forEach((t) => {
      if (onUpdateActivityDates) {
        onUpdateActivityDates(t.id, t.startDate, t.endDate, t.duration);
      }
    });
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((u) => [...u, tasks]);
    setRedoStack((r) => r.slice(0, r.length - 1));
    next.forEach((t) => {
      if (onUpdateActivityDates) {
        onUpdateActivityDates(t.id, t.startDate, t.endDate, t.duration);
      }
    });
  };

  const scrollToTaskDate = (startDateStr: string) => {
    const dayOffset = diffCalendarDays(timelineBounds.minDate, startDateStr);
    const targetX = Math.max(0, dayOffset * pxPerDay - 80);
    if (rightGanttRef.current) {
      rightGanttRef.current.scrollTo({ left: targetX, behavior: 'smooth' });
    }
  };

  // Subtarefas para Rollup
  const getSubTasksForRollup = (row: EapRow): EapRow[] => {
    const res: EapRow[] = [];
    const collect = (children?: EapRow[]) => {
      if (!children) return;
      children.forEach((c) => {
        if (!c.isGroup && c.task) res.push(c);
        collect(c.children);
      });
    };
    collect(row.children);
    return res;
  };

  const columnLabels: Record<string, string> = {
    code: 'Código',
    name: 'Nome da Tarefa',
    startDate: 'Início',
    endDate: 'Término',
    duration: 'Duração',
    progress: '% Exec.',
    plannedProgress: '% Prev.',
    predecessors: 'Predec.',
    successors: 'Sucess.',
    criticalPath: 'Crítico',
    cost: 'Custo',
    location: 'Local',
    group: 'Grupo',
    baselineStart: 'Baseline',
  };

  return (
    <div className="bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden flex flex-col text-slate-800">
      {/* =========================================================================
          BARRA DE FERRAMENTAS SUPERIOR (ESTILO LINHA DE BALANÇO)
         ========================================================================= */}
      <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col gap-3 shrink-0 select-none">
        {/* Linha 1: Filtros de Busca, Agrupamento, Equipe, Versão Pill, Baseline Fantasma, Zoom e Configurações */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="🔍 Buscar na EAP / Gantt..."
              className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs w-56 focus:ring-2 focus:ring-emerald-500 outline-none font-medium text-slate-800"
            />

            <select
              value={selectedGroupFilter}
              onChange={(e) => setSelectedGroupFilter(e.target.value)}
              className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 cursor-pointer"
            >
              <option value="">Todos os Agrupamentos</option>
              {macrosList.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            <select
              value={selectedTeamFilter}
              onChange={(e) => setSelectedTeamFilter(e.target.value)}
              className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 cursor-pointer"
            >
              <option value="">Todas as Equipes</option>
              {Array.from(new Set(tasksWithSuccessors.map((t) => t.responsible).filter(Boolean))).map((resp) => (
                <option key={resp} value={resp}>
                  {resp}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* SELETOR EM FORMATO PILL: VERSÃO ATIVA, TIPO, DROPDOWN E BOTÃO + */}
            {onOpenVersionDrawer && (
              <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl p-1 text-xs shadow-2xs">
                <span className="text-[10px] font-black uppercase text-slate-400 pl-1.5">Versão:</span>
                <button
                  type="button"
                  onClick={onOpenVersionDrawer}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200/80 transition cursor-pointer max-w-[220px]"
                  title="Abrir Central de Versões, Baselines e Cenários"
                >
                  <span className="text-xs shrink-0">
                    {currentActiveVersion?.isBaseline
                      ? '📌'
                      : currentActiveVersion?.type === 'scenario'
                      ? '🧪'
                      : currentActiveVersion?.type === 'meta'
                      ? '🎯'
                      : currentActiveVersion?.type === 'backup'
                      ? '💾'
                      : '📋'}
                  </span>
                  <span className="font-bold text-slate-800 truncate text-xs">
                    {currentActiveVersion?.name || 'Versão Inicial'}
                  </span>
                  {currentActiveVersion?.isBaseline && (
                    <span className="shrink-0 px-1.5 py-0.2 rounded-full bg-amber-100 text-amber-800 text-[9px] font-black">
                      Base
                    </span>
                  )}
                  {currentActiveVersion?.type === 'scenario' && (
                    <span className="shrink-0 px-1.5 py-0.2 rounded-full bg-purple-100 text-purple-800 text-[9px] font-black">
                      Cenário
                    </span>
                  )}
                  <span className="text-[10px] text-slate-400 shrink-0">▼</span>
                </button>

                {onCreateNewVersion && (
                  <button
                    type="button"
                    onClick={onCreateNewVersion}
                    className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-100 hover:bg-emerald-600 hover:text-white text-slate-700 font-black text-sm transition cursor-pointer shadow-2xs"
                    title="Criar nova versão, cenário ou baseline"
                  >
                    +
                  </button>
                )}
              </div>
            )}

            {/* TOGGLE LINHA DE BASE FANTASMA */}
            {onToggleGhostBaseline && (
              <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600 cursor-pointer bg-white border border-slate-200 px-2.5 py-1.5 rounded-xl select-none">
                <input
                  type="checkbox"
                  checked={showGhostBaseline}
                  onChange={(e) => onToggleGhostBaseline(e.target.checked)}
                  className="rounded text-amber-600 focus:ring-0 cursor-pointer"
                />
                <span>Linha de Base Fantasma</span>
              </label>
            )}

            {/* CONTROLES DE ZOOM: DIA / SEMANA / MÊS */}
            <div className="flex items-center bg-white border border-slate-200 rounded-xl p-0.5 text-[11px] font-black">
              {(['day', 'week', 'month'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleZoomModeChange(m)}
                  className={`px-2.5 py-1 rounded-lg uppercase transition cursor-pointer ${
                    zoomMode === m ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {m === 'day' ? 'Dia' : m === 'week' ? 'Semana' : 'Mês'}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1">
              <span className="text-[10px] font-black uppercase text-slate-400">Zoom</span>
              <input
                type="range"
                min={3}
                max={28}
                step={1}
                value={pxPerDay}
                onChange={(e) => setPxPerDay(Number(e.target.value))}
                className="w-20 accent-emerald-700 cursor-pointer"
              />
            </div>

            <button
              type="button"
              onClick={() => setIsConfigOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-black text-slate-700 shadow-sm transition active:scale-95 cursor-pointer"
              title="Configurações da EAP e Linha do Tempo"
            >
              <span className="text-sm">⚙️</span>
              <span className="hidden sm:inline">Configurações</span>
            </button>

            <button
              type="button"
              onClick={() => setIsMaximized((prev) => !prev)}
              className={`flex items-center gap-1 px-2.5 py-1.5 border rounded-xl text-xs font-black transition active:scale-95 cursor-pointer ${
                isMaximized
                  ? 'bg-indigo-600 text-white border-indigo-700'
                  : 'bg-white hover:bg-slate-100 text-slate-700 border-slate-200'
              }`}
              title={isMaximized ? 'Restaurar tamanho padrão' : 'Maximizar visualização (Tela Cheia)'}
            >
              <span>{isMaximized ? '🗗' : '⛶'}</span>
              <span className="hidden md:inline">{isMaximized ? 'Restaurar' : 'Tela Cheia'}</span>
            </button>
          </div>
        </div>

        {/* Linha 2: Ferramentas Adicionais (Undo/Redo, Níveis EAP, Colunas, Caminho Crítico, Dependências, Acumular Barras) */}
        <div className="pt-2 border-t border-slate-200/60 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Undo / Redo */}
            <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-0.5 shadow-2xs">
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                title="Desfazer (Undo)"
                className="p-1 hover:bg-slate-100 text-slate-600 disabled:opacity-30 disabled:hover:bg-transparent rounded-lg transition cursor-pointer"
              >
                ↩
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                title="Refazer (Redo)"
                className="p-1 hover:bg-slate-100 text-slate-600 disabled:opacity-30 disabled:hover:bg-transparent rounded-lg transition cursor-pointer"
              >
                ↪
              </button>
            </div>

            {/* Dropdown Níveis EAP */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsLevelFilterOpen(!isLevelFilterOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 hover:border-slate-300 text-xs font-bold text-slate-700 rounded-xl transition shadow-2xs cursor-pointer"
              >
                <span className="text-emerald-600 font-black">☰</span>
                <span>Níveis EAP {eapLevelFilter > 0 ? `(Nível ${eapLevelFilter})` : '(Todos)'}</span>
                <span className="text-[10px] text-slate-400">▾</span>
              </button>

              {isLevelFilterOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setIsLevelFilterOpen(false)} />
                  <div className="absolute left-0 mt-1.5 w-52 bg-white border border-slate-200 rounded-xl shadow-xl z-40 py-1 text-xs text-slate-800 font-bold">
                    {[
                      { level: 0, label: 'Expandir Todos' },
                      { level: 1, label: 'Nível 1 (Macros)' },
                      { level: 2, label: 'Nível 2 (Lotes / Pavimentos)' },
                      { level: 3, label: 'Nível 3 (Pacotes de Trabalho)' },
                      { level: 4, label: 'Nível 4 (Sub-serviços)' },
                    ].map((item) => (
                      <button
                        key={item.level}
                        type="button"
                        onClick={() => {
                          setEapLevelFilter(item.level);
                          setIsLevelFilterOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between cursor-pointer"
                      >
                        <span>{item.label}</span>
                        {eapLevelFilter === item.level && <span className="text-emerald-600 font-black">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Dropdown Colunas */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsColsFilterOpen(!isColsFilterOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 hover:border-slate-300 text-xs font-bold text-slate-700 rounded-xl transition shadow-2xs cursor-pointer"
              >
                <span className="text-emerald-600">📊</span>
                <span>Colunas</span>
                <span className="text-[10px] text-slate-400">▾</span>
              </button>

              {isColsFilterOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setIsColsFilterOpen(false)} />
                  <div className="absolute left-0 mt-1.5 w-56 bg-white border border-slate-200 rounded-xl shadow-xl z-40 p-2 text-xs text-slate-800 space-y-1 max-h-80 overflow-y-auto">
                    <div className="text-[9px] font-black uppercase text-slate-400 px-2 py-1">
                      Colunas da Tabela EAP
                    </div>
                    {Object.entries(visibleCols).map(([colKey, isVisible]) => (
                      <label
                        key={colKey}
                        className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded-lg cursor-pointer font-bold text-slate-700 select-none"
                      >
                        <input
                          type="checkbox"
                          checked={isVisible}
                          onChange={(e) =>
                            setVisibleCols((prev) => ({
                              ...prev,
                              [colKey]: e.target.checked,
                            }))
                          }
                          className="rounded text-emerald-600 border-slate-300"
                        />
                        <span>{columnLabels[colKey] || colKey}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Caminho Crítico */}
            <button
              type="button"
              onClick={() => setShowCriticalPath(!showCriticalPath)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl border transition cursor-pointer select-none ${
                showCriticalPath
                  ? 'bg-rose-50 border-rose-300 text-rose-800 shadow-2xs animate-pulse'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300'
              }`}
            >
              <span className={showCriticalPath ? 'text-rose-600' : 'text-slate-400'}>🔥</span>
              <span>Caminho Crítico</span>
            </button>

            {/* Dependências */}
            <button
              type="button"
              onClick={() => setShowDependencies(!showDependencies)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl border transition cursor-pointer select-none ${
                showDependencies
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300'
              }`}
            >
              <span className={showDependencies ? 'text-emerald-600' : 'text-slate-400'}>🔗</span>
              <span>Dependências</span>
            </button>

            {/* Acumular Barras */}
            <button
              type="button"
              onClick={() => setShowRollupBars(!showRollupBars)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-xl border transition cursor-pointer select-none ${
                showRollupBars
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800 shadow-2xs'
                  : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300'
              }`}
              title="Exibir todas as sub-atividades acumuladas na mesma linha do grupo pai recolhido"
            >
              <span className={showRollupBars ? 'text-emerald-600' : 'text-slate-400'}>🥞</span>
              <span>Acumular Barras</span>
            </button>
          </div>

          <div className="text-[11px] font-bold text-slate-400 uppercase">
            Exibindo {visibleRows.length} itens na EAP
          </div>
        </div>
      </div>

      {/* =========================================================================
          SPLIT CANVAS GANTT: TABELA EAP (ESQUERDA) + TIMELINE GANTT (DIREITA)
         ========================================================================= */}
      <div
        className={`relative overflow-hidden select-none border border-slate-300 rounded-xl shadow-inner bg-slate-100/50 flex ${
          isMaximized
            ? 'h-[calc(100vh-190px)] min-h-[600px]'
            : 'h-[calc(100vh-270px)] min-h-[580px]'
        }`}
      >
        {/* =====================================================================
            COLUNA ESQUERDA FIXA: TABELA EAP (CABEÇALHO h-[74px] IGUAL AO EIXO Y)
           ===================================================================== */}
        <div
          className="shrink-0 border-r border-slate-300 bg-white flex flex-col transition-none overflow-x-auto shadow-sm"
          style={{ width: `${eapPanelWidth}px` }}
        >
          {/* Cabeçalho da Tabela EAP: Exatamente h-[74px] matching Eixo Y Linha de Balanço */}
          <div className="h-[74px] sticky top-0 left-0 z-40 bg-slate-900 text-white px-3 flex flex-col justify-between py-2 border-b border-slate-700 shadow-md min-w-full select-none">
            {/* Top row */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] font-black uppercase tracking-wider text-emerald-400">
                  EAP — Estrutura Analítica
                </div>
                <div className="text-xs font-bold text-slate-200">
                  {visibleRows.length} Itens / Tarefas
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleExpandAll}
                  className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-[10px] font-bold text-slate-200 cursor-pointer"
                  title="Expandir todas as pastas"
                >
                  [+] Expandir
                </button>
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-[10px] font-bold text-slate-200 cursor-pointer"
                  title="Recolher todas as pastas"
                >
                  [-] Recolher
                </button>
              </div>
            </div>

            {/* Bottom row: Títulos das colunas */}
            <div className="flex items-center text-[9px] font-black uppercase tracking-wider text-slate-400 border-t border-slate-800 pt-1">
              {visibleCols.code && <div className="w-16 px-1 text-center shrink-0">Código</div>}
              {visibleCols.name && <div className="flex-1 min-w-[170px] px-2 truncate">Nome da Tarefa / Pacote</div>}
              {visibleCols.startDate && <div className="w-20 px-1 text-center shrink-0">Início</div>}
              {visibleCols.endDate && <div className="w-20 px-1 text-center shrink-0">Término</div>}
              {visibleCols.duration && <div className="w-14 px-1 text-center shrink-0">Duração</div>}
              {visibleCols.progress && <div className="w-14 px-1 text-center shrink-0">% Exec.</div>}
              {visibleCols.plannedProgress && <div className="w-16 px-1 text-center shrink-0">% Prev.</div>}
              {visibleCols.predecessors && <div className="w-20 px-1 text-center shrink-0">Predec.</div>}
              {visibleCols.successors && <div className="w-20 px-1 text-center shrink-0">Sucess.</div>}
              {visibleCols.criticalPath && <div className="w-16 px-1 text-center shrink-0">Crítico</div>}
              {visibleCols.location && <div className="w-24 px-1 text-left shrink-0">Local</div>}
              {visibleCols.group && <div className="w-24 px-1 text-left shrink-0">Grupo</div>}
              {visibleCols.cost && <div className="w-20 px-1 text-right shrink-0 pr-2">Custo</div>}
            </div>
          </div>

          {/* Linhas da Tabela EAP */}
          <div
            ref={leftTableRef}
            onScroll={handleLeftScroll}
            className="flex-1 overflow-y-auto overflow-x-auto divide-y divide-slate-100 font-mono text-[11px]"
          >
            {visibleRows.map((row) => {
              const isCollapsed = collapsedGroupIds.has(row.id);
              const indent = (row.level - 1) * 12;

              let rowBg = 'bg-white text-slate-800';
              if (row.level === 1) rowBg = 'bg-slate-200/90 font-black text-slate-900';
              else if (row.level === 2) rowBg = 'bg-slate-100/90 font-bold text-slate-800';
              else if (row.level === 3) rowBg = 'bg-white font-semibold text-slate-800';
              else if (row.level === 4) rowBg = 'bg-slate-50/70 text-slate-600 italic';

              return (
                <div
                  key={row.id}
                  onClick={() => scrollToTaskDate(row.startDate)}
                  className={`flex items-center h-[36px] transition hover:bg-emerald-50/40 min-w-full cursor-pointer select-none ${rowBg}`}
                >
                  {/* Código EAP */}
                  {visibleCols.code && (
                    <div className="w-16 px-1 text-center shrink-0 flex items-center justify-center">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-black ${
                          row.level === 1
                            ? 'bg-slate-800 text-white'
                            : row.level === 2
                            ? 'bg-slate-300 text-slate-800'
                            : row.level === 3
                            ? 'bg-slate-100 text-slate-700 border border-slate-200'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {row.code}
                      </span>
                    </div>
                  )}

                  {/* Nome da Tarefa / Serviço */}
                  {visibleCols.name && (
                    <div
                      className="flex-1 min-w-[170px] px-2 truncate flex items-center gap-1.5"
                      style={{ paddingLeft: `${8 + indent}px` }}
                    >
                      {row.isGroup ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleGroupCollapse(row.id);
                          }}
                          className="p-0.5 hover:bg-black/10 rounded text-slate-500 cursor-pointer"
                        >
                          {isCollapsed ? '▶' : '▼'}
                        </button>
                      ) : (
                        <span className="w-3.5" />
                      )}
                      <span
                        className={`truncate ${
                          row.level === 4
                            ? 'font-medium text-slate-500 text-[10px]'
                            : 'font-bold uppercase text-slate-800'
                        }`}
                      >
                        {row.level === 4 ? `🔧 ${row.name}` : row.name}
                      </span>
                    </div>
                  )}

                  {/* Data Início */}
                  {visibleCols.startDate && (
                    <div className="w-20 px-1 text-center shrink-0 font-bold text-[10px] text-slate-600">
                      {formatDateBR(row.startDate)}
                    </div>
                  )}

                  {/* Data Término */}
                  {visibleCols.endDate && (
                    <div className="w-20 px-1 text-center shrink-0 font-bold text-[10px] text-slate-600">
                      {formatDateBR(row.endDate)}
                    </div>
                  )}

                  {/* Duração */}
                  {visibleCols.duration && (
                    <div className="w-14 px-1 text-center shrink-0 font-bold text-[10px] text-slate-600">
                      {row.duration}d
                    </div>
                  )}

                  {/* % Executado */}
                  {visibleCols.progress && (
                    <div className="w-14 px-1 text-center shrink-0 font-black text-[10px] text-emerald-700">
                      {row.progress}%
                    </div>
                  )}

                  {/* % Previsto */}
                  {visibleCols.plannedProgress && (
                    <div className="w-16 px-1 text-center shrink-0 font-bold text-[10px] text-indigo-700">
                      {row.plannedProgress}%
                    </div>
                  )}

                  {/* Predecessoras */}
                  {visibleCols.predecessors && (
                    <div className="w-20 px-1 text-center shrink-0 font-mono text-[9px] text-slate-500 truncate">
                      {row.predecessors?.length ? row.predecessors.join(', ') : '-'}
                    </div>
                  )}

                  {/* Sucessoras */}
                  {visibleCols.successors && (
                    <div className="w-20 px-1 text-center shrink-0 font-mono text-[9px] text-slate-500 truncate">
                      {row.successors?.length ? row.successors.join(', ') : '-'}
                    </div>
                  )}

                  {/* Crítico */}
                  {visibleCols.criticalPath && (
                    <div className="w-16 px-1 text-center shrink-0 font-black text-[9px]">
                      {criticalPathTaskIds.has(row.id) ? (
                        <span className="text-rose-700 bg-rose-100 px-1 py-0.5 rounded border border-rose-200">
                          SIM
                        </span>
                      ) : (
                        <span className="text-slate-400">NÃO</span>
                      )}
                    </div>
                  )}

                  {/* Local */}
                  {visibleCols.location && (
                    <div className="w-24 px-1 text-left shrink-0 font-bold text-[10px] text-slate-600 truncate">
                      {row.location || '-'}
                    </div>
                  )}

                  {/* Grupo */}
                  {visibleCols.group && (
                    <div className="w-24 px-1 text-left shrink-0 font-bold text-[10px] text-slate-600 truncate">
                      {row.group || '-'}
                    </div>
                  )}

                  {/* Custo */}
                  {visibleCols.cost && (
                    <div className="w-20 px-1 text-right shrink-0 font-bold text-[10px] text-emerald-800 pr-2">
                      {row.cost ? `R$ ${row.cost.toLocaleString('pt-BR')}` : '-'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* SPLITTER RESIZER */}
        <div
          className="w-2 hover:w-3 bg-slate-200 hover:bg-emerald-600 cursor-col-resize select-none relative z-30 flex items-center justify-center transition-all group shrink-0 active:bg-emerald-700 active:w-3"
          title="Arrastar para redimensionar a largura da tabela EAP"
          onPointerDown={handleSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={handleSplitterPointerUp}
        >
          <div className="w-1 h-8 bg-slate-400 group-hover:bg-white rounded-full transition-colors" />
        </div>

        {/* =====================================================================
            PAINEL DIREITO: LINHA DO TEMPO (CABEÇALHO 3 NÍVEIS IDÊNTICO À LOB)
           ===================================================================== */}
        <div className="flex-1 flex flex-col bg-white relative min-w-0">
          {/* CABEÇALHO COM 3 LINHAS: MÊS, SEMANA E DIA (STQQSD) — Exact h-[74px] */}
          <div className="h-[74px] sticky top-0 z-30 bg-slate-800 text-white border-b border-slate-700 flex flex-col shadow-md select-none shrink-0 overflow-hidden">
            <div ref={rightHeaderSvgRef} className="flex flex-col will-change-transform">
              {/* Linha 1: Mês e Ano (26px) */}
              <div className="flex h-[26px] border-b border-slate-700 bg-slate-900/90">
                {timelineBounds.months.map((m) => (
                  <div
                    key={m.key}
                    style={{ width: m.count * pxPerDay }}
                    className="shrink-0 border-r-2 border-slate-600 px-2 flex items-center text-[10px] font-black uppercase tracking-wider text-slate-200 truncate"
                  >
                    {m.label}
                  </div>
                ))}
              </div>

              {/* Linha 2: Semanas (24px) */}
              <div className="flex h-[24px] border-b border-slate-700/80 bg-slate-850">
                {timelineBounds.weeks.map((w) => (
                  <div
                    key={w.key}
                    style={{ width: w.count * pxPerDay }}
                    className="shrink-0 border-r border-slate-700/80 px-1 flex items-center justify-center text-[9px] font-mono font-semibold text-slate-300 truncate"
                  >
                    {w.count * pxPerDay >= 28 ? w.label : ''}
                  </div>
                ))}
              </div>

              {/* Linha 3: Dias (24px) */}
              <div className="flex h-[24px] bg-slate-800">
                {timelineBounds.days.map((d) => (
                  <div
                    key={d.date}
                    style={{ width: pxPerDay }}
                    title={`${d.date} (${d.letter}) - ${d.isWorking ? 'Dia útil' : 'Dia não útil'}${d.isEndOfMonth ? ' (Fim do mês)' : ''}`}
                    className={`shrink-0 h-full flex flex-col items-center justify-center text-[9px] ${
                      d.isEndOfMonth
                        ? 'border-r-2 border-slate-400'
                        : 'border-r border-slate-700/60'
                    } ${
                      !d.isWorking
                        ? 'bg-slate-900/60 text-slate-400 font-normal'
                        : 'text-slate-100 font-bold'
                    }`}
                  >
                    {pxPerDay >= 18 && (
                      <span className="text-[7px] text-slate-400 leading-none mb-0.5">{d.dayOfMonth}</span>
                    )}
                    {pxPerDay >= 6 ? (
                      <span className="leading-none">{d.letter}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Área de Barras do Gantt com Rolagem Sincronizada */}
          <div
            ref={rightGanttRef}
            onScroll={handleRightScroll}
            className="flex-1 overflow-y-auto overflow-x-auto relative min-w-full"
          >
            <div
              className="relative min-w-full"
              style={{
                width: `${timelineBounds.totalDays * pxPerDay}px`,
                height: `${visibleRows.length * ROW_HEIGHT}px`,
              }}
            >
              {/* Linhas de fundo para dias não úteis e divisores de mês */}
              <div className="absolute inset-0 flex pointer-events-none z-0">
                {timelineBounds.days.map((d) => (
                  <div
                    key={`grid_day_${d.date}`}
                    style={{
                      width: pxPerDay,
                      borderRightWidth: d.isEndOfMonth ? '2px' : '1px',
                      borderRightColor: d.isEndOfMonth ? '#94a3b8' : '#f1f5f9',
                    }}
                    className={`shrink-0 h-full ${
                      !d.isWorking ? 'bg-slate-100/90' : 'bg-transparent'
                    }`}
                  />
                ))}
              </div>

              {/* Linhas horizontais de grade para cada linha */}
              {visibleRows.map((_, rIdx) => (
                <div
                  key={`row_grid_${rIdx}`}
                  style={{
                    top: rIdx * ROW_HEIGHT,
                    height: ROW_HEIGHT,
                  }}
                  className="absolute left-0 right-0 border-b border-slate-100 pointer-events-none"
                />
              ))}

              {/* Marcador Vermelho de HOJE */}
              {timelineBounds.todayXCoord >= 0 && timelineBounds.todayXCoord <= timelineBounds.totalDays * pxPerDay && (
                <div
                  className="absolute top-0 bottom-0 w-[2px] border-r-2 border-dashed border-rose-500 z-10 pointer-events-none"
                  style={{ left: `${timelineBounds.todayXCoord}px` }}
                >
                  <span className="bg-rose-600 text-white font-black text-[8px] px-1 py-0.5 rounded uppercase absolute top-0 -left-4 shadow-sm">
                    HOJE
                  </span>
                </div>
              )}

              {/* SVG para Setas de Dependência */}
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none z-10"
                style={{ width: `${timelineBounds.totalDays * pxPerDay}px` }}
              >
                <defs>
                  <marker
                    id="gantt-arrow-normal"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#0F766E" />
                  </marker>
                  <marker
                    id="gantt-arrow-critical"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#E11D48" />
                  </marker>
                </defs>

                {showDependencies &&
                  dependencyLinks.map((dep, depIdx) => {
                    const fromCoord = taskCoordsMap.get(dep.from);
                    const toCoord = taskCoordsMap.get(dep.to);
                    if (!fromCoord || !toCoord) return null;

                    const isCritical = criticalPathTaskIds.has(dep.from) && criticalPathTaskIds.has(dep.to);

                    const fromX = fromCoord.rightX;
                    const fromY = fromCoord.centerY;
                    const toX = toCoord.leftX;
                    const toY = toCoord.centerY;

                    let pathD = '';
                    if (toX >= fromX + 12) {
                      const midX = fromX + (toX - fromX) / 2;
                      pathD = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
                    } else {
                      const midX = fromX + 12;
                      const midY = fromY + (toY - fromY) / 2;
                      pathD = `M ${fromX} ${fromY} H ${midX} V ${midY} H ${toX - 12} V ${toY} H ${toX}`;
                    }

                    return (
                      <path
                        key={`dep-${dep.from}-${dep.to}-${depIdx}`}
                        d={pathD}
                        fill="none"
                        stroke={isCritical ? '#E11D48' : '#0F766E'}
                        strokeWidth={isCritical ? 2.2 : 1.4}
                        markerEnd={isCritical ? 'url(#gantt-arrow-critical)' : 'url(#gantt-arrow-normal)'}
                        opacity={isCritical ? 0.95 : 0.65}
                        className="pointer-events-none"
                      />
                    );
                  })}
              </svg>

              {/* Renderização das Barras de Tarefas */}
              {visibleRows.map((row, rowIndex) => {
                const isDragging = dragState?.taskId === row.id;
                const deltaDays = isDragging ? dragState.currentDeltaDays : 0;

                let sDate = row.startDate;
                let eDate = row.endDate;

                if (isDragging && dragState) {
                  if (dragState.type === 'move') {
                    sDate = addCalendarDays(dragState.initialStartDate, deltaDays);
                    eDate = addCalendarDays(dragState.initialEndDate, deltaDays);
                  } else if (dragState.type === 'resize') {
                    const nextDur = Math.max(1, dragState.initialDuration + deltaDays);
                    eDate = addCalendarDays(dragState.initialStartDate, nextDur - 1);
                  }
                }

                const dayOffset = diffCalendarDays(timelineBounds.minDate, sDate);
                const spanDays = Math.max(1, diffCalendarDays(sDate, eDate) + 1);
                const barLeft = Math.max(0, dayOffset * pxPerDay);
                const barWidth = Math.max(16, spanDays * pxPerDay);
                const barTop = rowIndex * ROW_HEIGHT + 6;

                const isCritical = criticalPathTaskIds.has(row.id) || row.isCritical;
                const isGroup = row.isGroup;
                const isCollapsed = collapsedGroupIds.has(row.id);

                // Acumular Barras ativado e grupo recolhido
                const isRollupActive = showRollupBars && isGroup && isCollapsed;
                const rollupSubTasks = isRollupActive ? getSubTasksForRollup(row) : [];

                if (isRollupActive && rollupSubTasks.length > 0) {
                  return (
                    <div
                      key={row.id}
                      className="absolute z-20 flex items-center"
                      style={{
                        left: 0,
                        right: 0,
                        top: `${barTop}px`,
                        height: '24px',
                      }}
                    >
                      <div
                        className="absolute h-1 bg-slate-300 rounded-full opacity-60"
                        style={{ left: `${barLeft}px`, width: `${barWidth}px` }}
                      />

                      {rollupSubTasks.map((sub) => {
                        const subOffset = diffCalendarDays(timelineBounds.minDate, sub.startDate);
                        const subSpan = Math.max(1, diffCalendarDays(sub.startDate, sub.endDate) + 1);
                        const subLeft = Math.max(0, subOffset * pxPerDay);
                        const subWidth = Math.max(14, subSpan * pxPerDay);
                        const subColor = sub.task?.color || '#059669';

                        return (
                          <div
                            key={sub.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (sub.task) setSelectedTask(sub.task);
                            }}
                            className="absolute h-4 rounded shadow-2xs flex items-center justify-center cursor-pointer transition hover:scale-105 hover:z-20 overflow-hidden ring-1 ring-white/50"
                            style={{
                              left: `${subLeft}px`,
                              width: `${subWidth}px`,
                              backgroundColor: subColor,
                            }}
                            title={`${sub.name} (${formatDateBR(sub.startDate)} - ${formatDateBR(sub.endDate)}) • ${sub.progress}%`}
                          >
                            {sub.progress > 0 && (
                              <div
                                className="h-full bg-black/25 transition-all"
                                style={{ width: `${sub.progress}%` }}
                              />
                            )}
                            <span className="absolute text-[8px] font-black text-white truncate px-0.5 pointer-events-none drop-shadow-xs">
                              {subWidth > 32 ? sub.name : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                let barColor = row.task?.color || '#059669';
                if (isCritical) barColor = '#E11D48';
                else if (isGroup && row.level === 1) barColor = '#1e293b';
                else if (isGroup && row.level === 2) barColor = '#475569';
                else if (row.level === 4) barColor = '#64748b';

                return (
                  <div
                    key={row.id}
                    className={`absolute z-20 flex flex-col justify-center select-none ${
                      row.task ? 'cursor-pointer' : ''
                    } ${isGroup || row.level === 4 ? '' : 'cursor-grab active:cursor-grabbing'}`}
                    style={{
                      left: `${barLeft}px`,
                      width: `${barWidth}px`,
                      top: `${barTop}px`,
                      height: '24px',
                    }}
                    onClick={(e) => {
                      if (row.task && (!dragState || dragState.currentDeltaDays === 0)) {
                        e.stopPropagation();
                        setSelectedTask(row.task);
                      }
                    }}
                    onPointerDown={(e) => handleBarPointerDown(e, 'move', row)}
                    onPointerMove={handleBarPointerMove}
                    onPointerUp={handleBarPointerUp}
                    title={`${row.name}\nInício: ${formatDateBR(sDate)} | Fim: ${formatDateBR(eDate)} (${row.duration}d úteis)\nProgresso: ${row.progress}% | Equipe: ${row.responsible || 'Sem atribuição'}`}
                  >
                    {/* BARRAS FANTASMAS DA LINHA DE BASE (GHOST BASELINE) */}
                    {showGhostBaseline && baselineTaskMap && (() => {
                      const baseAct = baselineTaskMap.get(row.id);
                      if (!baseAct || !baseAct.start || !baseAct.end) return null;
                      const baseStartOffset = diffCalendarDays(timelineBounds.minDate, baseAct.start);
                      const baseSpanDays = Math.max(1, diffCalendarDays(baseAct.start, baseAct.end) + 1);
                      const bLeftRel = (baseStartOffset * pxPerDay) - barLeft;
                      const bWidth = Math.max(pxPerDay, baseSpanDays * pxPerDay);

                      return (
                        <div
                          style={{
                            left: `${bLeftRel}px`,
                            width: `${bWidth}px`,
                            top: -2,
                            height: 28,
                          }}
                          title={`[Linha de Base]: ${formatDateBR(baseAct.start)} → ${formatDateBR(baseAct.end)} (${baseAct.duration}d úteis)`}
                          className="absolute pointer-events-none rounded border-2 border-dashed border-amber-500/70 bg-amber-400/10 z-0 select-none"
                        >
                          <span className="absolute -top-3.5 left-0.5 text-[8px] font-mono font-bold text-amber-800 bg-white/95 px-1 rounded shadow-2xs border border-amber-300">
                            Base: {formatDateBR(baseAct.start).slice(0, 5)}
                          </span>
                        </div>
                      );
                    })()}

                    {/* Barra de Tarefa com Preenchimento de Progresso */}
                    <div
                      className={`w-full h-5 rounded-md shadow-xs flex items-center relative overflow-hidden transition-all ${
                        isDragging ? 'ring-2 ring-emerald-400 opacity-90 scale-[1.02]' : ''
                      }`}
                      style={{ backgroundColor: barColor }}
                    >
                      {row.progress > 0 && (
                        <div
                          className="h-full bg-black/25 transition-all"
                          style={{ width: `${row.progress}%` }}
                        />
                      )}
                      <span className="absolute inset-0 flex items-center justify-between px-2 text-[9px] font-black text-white drop-shadow-xs truncate select-none pointer-events-none">
                        <span className="truncate">{row.level === 4 ? `🔧 ${row.name}` : row.name}</span>
                        {barWidth >= 45 && <span className="ml-1 opacity-90 text-[8px]">{row.progress}%</span>}
                      </span>
                    </div>

                    {/* Alça de redimensionamento no canto direito */}
                    {!isGroup && row.level === 3 && (
                      <div
                        className="absolute right-0 top-0 bottom-0 w-2.5 hover:bg-black/20 cursor-ew-resize rounded-r-md z-10"
                        onPointerDown={(e) => handleBarPointerDown(e, 'resize', row)}
                        title="Arrastar para alterar duração"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* =========================================================================
          DRAWER LATERAL: CONFIGURAÇÕES & VERSÕES (Slide-over da Direita)
         ========================================================================= */}
      {isConfigOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setIsConfigOpen(false)} />
          <div className="absolute inset-y-0 right-0 w-full max-w-md bg-white border-l border-slate-200 shadow-2xl flex flex-col p-6 space-y-5">
            <div className="flex justify-between items-center border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-emerald-700 text-lg">⚙️</span>
                <h3 className="font-black text-sm uppercase tracking-wider text-slate-800">
                  Configurações da EAP & Gantt
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsConfigOpen(false)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-800 cursor-pointer text-xl"
              >
                ×
              </button>
            </div>

            <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs font-bold">
              <button
                type="button"
                onClick={() => setConfigTab('structure')}
                className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  configTab === 'structure'
                    ? 'bg-white text-emerald-800 shadow-xs font-black'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>🏢</span>
                <span>Estrutura & Ordem</span>
              </button>
              <button
                type="button"
                onClick={() => setConfigTab('timeline')}
                className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  configTab === 'timeline'
                    ? 'bg-white text-emerald-800 shadow-xs font-black'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>📅</span>
                <span>Cabeçalho & Zoom</span>
              </button>
              <button
                type="button"
                onClick={() => setConfigTab('versions')}
                className={`flex-1 py-1.5 rounded-lg flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  configTab === 'versions'
                    ? 'bg-white text-emerald-800 shadow-xs font-black'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>🏷️</span>
                <span>Versões & Baseline</span>
              </button>
            </div>

            {/* Conteúdo Aba: Estrutura & Ordem */}
            {configTab === 'structure' && (
              <div className="flex-1 overflow-y-auto space-y-5 pr-1 text-xs">
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3">
                  <div className="flex justify-between items-center">
                    <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                      Reordenar Lotes-Mãe (Macros)
                    </h4>
                    <span className="text-[9px] font-bold text-slate-400">
                      {macrosList.length} macros
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-medium">
                    Altere a ordem dos Lotes-Mãe para reorganizar a EAP do Gantt:
                  </p>
                  <div className="space-y-1.5">
                    {macrosList.map((macro, mIdx) => (
                      <div
                        key={macro}
                        className="flex items-center justify-between p-2 bg-white rounded-xl border border-slate-200 shadow-2xs"
                      >
                        <span className="font-bold text-slate-800 text-xs truncate max-w-[200px]">
                          {mIdx + 1}. {macro}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveMacroOrder(macro, 'up')}
                            disabled={mIdx === 0}
                            className="p-1 hover:bg-slate-100 disabled:opacity-30 rounded-lg text-slate-600 border border-slate-200 cursor-pointer"
                            title="Mover para cima"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            onClick={() => moveMacroOrder(macro, 'down')}
                            disabled={mIdx === macrosList.length - 1}
                            className="p-1 hover:bg-slate-100 disabled:opacity-30 rounded-lg text-slate-600 border border-slate-200 cursor-pointer"
                            title="Mover para baixo"
                          >
                            ▼
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3.5">
                  <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                    Classificação da EAP por Nível
                  </h4>

                  {/* Nível 2 */}
                  <div className="bg-white p-3 rounded-xl border border-slate-200 space-y-2 shadow-2xs">
                    <div className="flex justify-between items-center">
                      <span className="font-black text-[10px] uppercase text-slate-800">
                        🏢 Nível 2 (Lotes / Pavimentos)
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setLevelSort((prev) => ({
                            ...prev,
                            level2: {
                              ...prev.level2,
                              direction: prev.level2.direction === 'asc' ? 'desc' : 'asc',
                            },
                          }))
                        }
                        className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-[10px] font-black text-slate-800 rounded border border-slate-200 transition cursor-pointer"
                      >
                        {levelSort.level2.direction === 'asc' ? '▲ Crescente' : '▼ Decrescente'}
                      </button>
                    </div>
                    <select
                      value={levelSort.level2.field}
                      onChange={(e) =>
                        setLevelSort((prev) => ({
                          ...prev,
                          level2: { ...prev.level2, field: e.target.value },
                        }))
                      }
                      className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-800 outline-none focus:border-emerald-500 cursor-pointer"
                    >
                      <option value="original">📑 Ordem Planejada Original</option>
                      <option value="name">🔤 Nome do Lote (A-Z)</option>
                      <option value="startDate">📅 Data de Início Mais Cedo</option>
                    </select>
                  </div>

                  {/* Nível 3 */}
                  <div className="bg-white p-3 rounded-xl border border-slate-200 space-y-2 shadow-2xs">
                    <div className="flex justify-between items-center">
                      <span className="font-black text-[10px] uppercase text-slate-800">
                        📑 Nível 3 (Pacotes / Atividades)
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setLevelSort((prev) => ({
                            ...prev,
                            level3: {
                              ...prev.level3,
                              direction: prev.level3.direction === 'asc' ? 'desc' : 'asc',
                            },
                          }))
                        }
                        className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 text-[10px] font-black text-slate-800 rounded border border-slate-200 transition cursor-pointer"
                      >
                        {levelSort.level3.direction === 'asc' ? '▲ Crescente' : '▼ Decrescente'}
                      </button>
                    </div>
                    <select
                      value={levelSort.level3.field}
                      onChange={(e) =>
                        setLevelSort((prev) => ({
                          ...prev,
                          level3: { ...prev.level3, field: e.target.value },
                        }))
                      }
                      className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-800 outline-none focus:border-emerald-500 cursor-pointer"
                    >
                      <option value="startDate">📅 Data de Início</option>
                      <option value="name">🔤 Nome da Tarefa (A-Z)</option>
                      <option value="cost">💰 Custo Orçado</option>
                      <option value="progress">📊 % Executado</option>
                      <option value="original">📑 Ordem Original</option>
                    </select>
                  </div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-2.5">
                  <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                    🔗 Nível Limite das Setas de Dependência
                  </h4>
                  <select
                    value={dependencyMaxLevel}
                    onChange={(e) => setDependencyMaxLevel(Number(e.target.value))}
                    className="w-full p-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-800 outline-none focus:border-emerald-500 shadow-2xs cursor-pointer"
                  >
                    <option value={2}>🏢 Nível 2 (Lotes / Pavimentos)</option>
                    <option value={3}>📑 Nível 3 (Pacotes / Atividades) — Padrão</option>
                    <option value={4}>🔧 Nível 4 (Sub-serviços)</option>
                  </select>
                </div>
              </div>
            )}

            {/* Conteúdo Aba: Cabeçalho & Zoom */}
            {configTab === 'timeline' && (
              <div className="flex-1 overflow-y-auto space-y-5 pr-1 text-xs">
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3">
                  <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                    Zoom da Escala (Largura por Dia)
                  </h4>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={3}
                      max={28}
                      value={pxPerDay}
                      onChange={(e) => setPxPerDay(Number(e.target.value))}
                      className="flex-1 cursor-pointer accent-emerald-600"
                    />
                    <span className="font-black text-emerald-700 text-xs shrink-0">
                      {pxPerDay} px/dia
                    </span>
                  </div>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3">
                  <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                    Nível Superior (Meses)
                  </h4>
                  <select
                    value={monthFormat}
                    onChange={(e) => setMonthFormat(e.target.value as any)}
                    className="w-full bg-white border border-slate-200 rounded-xl p-2 font-bold text-slate-800 focus:outline-none cursor-pointer"
                  >
                    <option value="name_year">Mês por Extenso e Ano (Ex: Outubro 2026)</option>
                    <option value="numeric">MM/AA (Ex: 10/26)</option>
                    <option value="index">Mês 1, Mês 2… desde o início</option>
                  </select>
                </div>

                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3">
                  <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                    Segundo Nível (Semanas)
                  </h4>
                  <select
                    value={weekFormat}
                    onChange={(e) => setWeekFormat(e.target.value as any)}
                    className="w-full bg-white border border-slate-200 rounded-xl p-2 font-bold text-slate-800 focus:outline-none cursor-pointer"
                  >
                    <option value="numeric">DD/MM (Ex: 01/03)</option>
                    <option value="short">S1, S2, S3...</option>
                    <option value="day">Somente DD (Ex: 01)</option>
                  </select>
                </div>
              </div>
            )}

            {/* Conteúdo Aba: Versões & Baseline */}
            {configTab === 'versions' && (
              <div className="flex-1 overflow-y-auto space-y-5 pr-1 text-xs">
                <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3">
                  <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                    Central de Versões e Linha de Base
                  </h4>
                  <p className="text-[10px] text-slate-500 font-medium leading-relaxed">
                    A Linha de Base (Baseline) é exibida como uma barra fantasma tracejada em âmbar logo acima/ao lado de cada barra do cronograma, permitindo comparação visual instantânea entre o previsto oficial e o replanejado.
                  </p>
                  {onOpenVersionDrawer && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsConfigOpen(false);
                        onOpenVersionDrawer();
                      }}
                      className="w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-black text-xs uppercase tracking-wider transition shadow-sm"
                    >
                      🏷️ Abrir Painel Completo de Versões ({scheduleVersions.length})
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          DRAWER LATERAL: DETALHES DA TAREFA SELECIONADA
         ========================================================================= */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 overflow-hidden animate-in fade-in duration-200">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs" onClick={() => setSelectedTask(null)} />
          <div className="absolute inset-y-0 right-0 w-full max-w-md bg-white border-l border-slate-200 shadow-2xl flex flex-col p-6 space-y-5">
            <div className="flex justify-between items-start border-b border-slate-200 pb-4">
              <div>
                <span className="text-[10px] font-black uppercase text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                  {selectedTask.packageFamily || 'Serviço'}
                </span>
                <h3 className="font-black text-lg text-slate-900 uppercase mt-1 leading-tight">
                  {selectedTask.name}
                </h3>
                <span className="text-xs font-bold text-slate-500">
                  📍 {selectedTask.lotMother} • {selectedTask.lot}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTask(null)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-800 cursor-pointer text-xl transition"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-5 pr-1 text-xs">
              {/* Avanço Físico Executado */}
              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-2.5">
                <div className="flex justify-between items-center font-bold">
                  <span className="text-slate-800 uppercase font-black text-[10px] tracking-wider">
                    Avanço Físico Executado
                  </span>
                  <span className="text-sm font-black text-emerald-600">
                    {selectedTask.progress || 0}%
                  </span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-3 overflow-hidden p-0.5 border border-slate-300">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${selectedTask.progress || 0}%`,
                      backgroundColor: selectedTask.color || '#059669',
                    }}
                  />
                </div>
                <div className="flex justify-between gap-1 pt-1">
                  {[0, 25, 50, 75, 100].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        if (onUpdateActivityProgress) {
                          onUpdateActivityProgress(selectedTask.id, pct);
                        }
                        setSelectedTask((prev) => (prev ? { ...prev, progress: pct } : null));
                      }}
                      className={`flex-1 py-1.5 rounded-lg text-[10px] font-black border transition cursor-pointer ${
                        selectedTask.progress === pct
                          ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Dados do Cronograma */}
              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200">
                <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider mb-3">
                  Datas & Duração
                </h4>
                <div className="grid grid-cols-2 gap-3 text-slate-800">
                  <div>
                    <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Data Início</label>
                    <input
                      type="date"
                      value={selectedTask.startDate}
                      onChange={(e) => {
                        const newStart = e.target.value;
                        if (!newStart) return;
                        const newEnd = addCalendarDays(newStart, selectedTask.duration - 1);
                        setSelectedTask((prev) => prev ? { ...prev, startDate: newStart, endDate: newEnd } : null);
                        if (onUpdateActivityDates) {
                          onUpdateActivityDates(selectedTask.id, newStart, newEnd, selectedTask.duration);
                        }
                      }}
                      className="w-full bg-white border border-slate-200 rounded-lg p-1.5 font-bold text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Data Término</label>
                    <input
                      type="date"
                      value={selectedTask.endDate}
                      onChange={(e) => {
                        const newEnd = e.target.value;
                        if (!newEnd) return;
                        const newDur = Math.max(1, diffCalendarDays(selectedTask.startDate, newEnd) + 1);
                        setSelectedTask((prev) => prev ? { ...prev, endDate: newEnd, duration: newDur } : null);
                        if (onUpdateActivityDates) {
                          onUpdateActivityDates(selectedTask.id, selectedTask.startDate, newEnd, newDur);
                        }
                      }}
                      className="w-full bg-white border border-slate-200 rounded-lg p-1.5 font-bold text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Duração (dias)</label>
                    <input
                      type="number"
                      min={1}
                      value={selectedTask.duration}
                      onChange={(e) => {
                        const newDur = Math.max(1, Number(e.target.value) || 1);
                        const newEnd = addCalendarDays(selectedTask.startDate, newDur - 1);
                        setSelectedTask((prev) => prev ? { ...prev, duration: newDur, endDate: newEnd } : null);
                        if (onUpdateActivityDates) {
                          onUpdateActivityDates(selectedTask.id, selectedTask.startDate, newEnd, newDur);
                        }
                      }}
                      className="w-full bg-white border border-slate-200 rounded-lg p-1.5 font-bold text-xs"
                    />
                  </div>
                  <div>
                    <span className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Equipe</span>
                    <div className="font-bold text-slate-900 p-1.5 bg-white border border-slate-200 rounded-lg truncate">
                      {selectedTask.responsible || 'Sem atribuição'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Sub-tarefas / Micro-serviços (Nível 4) */}
              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-2">
                <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                  Micro-atividades / Sub-serviços
                </h4>
                {selectedTask.services && selectedTask.services.length > 0 ? (
                  <ul className="space-y-1 pl-1">
                    {selectedTask.services.map((srv, idx) => (
                      <li key={idx} className="flex items-center gap-1.5 text-slate-800 font-bold">
                        <span className="text-emerald-600">✓</span>
                        <span>{srv}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-400 italic">Nenhum micro-serviço específico cadastrado.</p>
                )}
              </div>

              {/* Predecessoras & Sucessoras */}
              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-2">
                <h4 className="font-black text-[10px] uppercase text-emerald-950 tracking-wider">
                  Predecessoras & Sucessoras
                </h4>
                <div className="text-xs space-y-1">
                  <div>
                    <span className="text-slate-400 font-bold">Predecessoras: </span>
                    <span className="font-mono text-slate-700">
                      {selectedTask.predecessors?.length ? selectedTask.predecessors.join(', ') : 'Nenhuma'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 font-bold">Sucessoras: </span>
                    <span className="font-mono text-slate-700">
                      {selectedTask.successors?.length ? selectedTask.successors.join(', ') : 'Nenhuma'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
