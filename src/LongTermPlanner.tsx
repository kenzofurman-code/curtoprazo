import { useScheduleVersionHistory } from './useScheduleVersionHistory';
import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import type {
  LongTermScheduleState,
  ProjectCalendar,
  ReplicationGroup,
  ScheduleFloor,
  ScheduleServicePackage,
  ScheduleJobTemplate,
  LobActivity,
  LobActivityJob,
  DependencyRule,
  FloorDirection,
} from './longTermSchedule';
import {
  PACKAGE_COLORS,
  GROUP_COLORS,
  slugifySchedule,
  getTodayISO,
  getBrazilianHolidays,
  createDefaultCalendar,
  addCalendarDays,
  diffCalendarDays,
  isWorkDay,
  ensureWorkDay,
  countWorkingDays,
  createSequentialFloors,
  getVerticalBuildingPreset,
  syncActivityJobs,
  analyzeScheduleGraph,
  recalculateSchedule,
  applyPaceAndGenerateActivities,
  compileLobToCronograma,
  hydrateLobFromCronograma,
  propagateScheduleCascade,
  optimizeSubLines,
} from './longTermSchedule';
import { BudgetLinkingView } from './BudgetLinkingView';
import { GanttPlannerView } from './GanttPlannerView';
import { applyBudgetWeightsToSchedule, getEffectiveBudgetState } from './budgetLinking';
import { PhysicalFinancialViews } from './PhysicalFinancialViews';
import { CompetenceCashViews } from './CompetenceCashViews';
import { runPhysicalFinancialCalculation } from './physicalFinancialEngine';
import { MacroflowCanvasView } from './MacroflowCanvasView';
import {
  createNewScheduleVersion,
  setVersionAsBaseline,
  activateScheduleVersion,
  deleteScheduleVersion,
  promoteScenarioToOfficial,
  type ScheduleVersion,
  type ScheduleVersionType,
} from './scheduleVersions';

interface LongTermPlannerProps {
  projectName?: string;
  selectedProjectId: string | null;
  cronogramaInicial: any[];
  floors: string[];
  allFloorsData: Record<string, any>;
  weights: Record<string, Record<string, number>>;
  teams: string[];
  matrices: any[];
  previousBudgetImport: any;
  currentBudgetImport: any;
  getBudgetImportTooltip: (version: any) => string;
  handleFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onTriggerClearDB: () => void;
  onApplySchedule: (
    compiled: {
      cronogramaInicial: any[];
      floors: string[];
      allFloorsData: Record<string, any>;
      weights: Record<string, Record<string, number>>;
      teams: string[];
      matrices: any[];
    },
    message?: string
  ) => Promise<void>;
  onUpdateSingleItemProgress: (item: any, newProgress: number) => Promise<void>;
  rawCronoSlot?: React.ReactNode;
  activeSubView?: 'lob' | 'table' | 'budget' | 'physical_financial' | 'competence_cash' | 'raw_crono' | 'import';
  hideSubNav?: boolean;
  onOpenImportModal?: () => void;
}

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_NAMES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

function formatDateBRShort(dateStr?: string): string {
  if (!dateStr) return '-';
  const clean = dateStr.slice(0, 10);
  if (clean.length === 10 && clean.charCodeAt(4) === 45 && clean.charCodeAt(7) === 45) {
    return `${clean.slice(8, 10)}/${clean.slice(5, 7)}/${clean.slice(0, 4)}`;
  }
  return dateStr;
}

function formatLobDateRange(startStr?: string, endStr?: string): string {
  if (!startStr || !endStr) return '';
  const sClean = startStr.slice(0, 10);
  const eClean = endStr.slice(0, 10);
  if (sClean.length !== 10 || eClean.length !== 10) return '';
  const sD = sClean.slice(8, 10);
  const sM = sClean.slice(5, 7);
  const eD = eClean.slice(8, 10);
  const eM = eClean.slice(5, 7);
  if (sM === eM) {
    return `${sD}-${eD}/${sM}`;
  }
  return `${sD}/${sM}-${eD}/${eM}`;
}

export const LongTermPlanner: React.FC<LongTermPlannerProps> = ({
  projectName = '',
  selectedProjectId,
  cronogramaInicial,
  floors,
  allFloorsData,
  weights,
  teams,
  matrices,
  previousBudgetImport,
  currentBudgetImport,
  getBudgetImportTooltip,
  handleFileUpload,
  onTriggerClearDB,
  onApplySchedule,
  onUpdateSingleItemProgress,
  rawCronoSlot,
  activeSubView,
  hideSubNav = false,
  onOpenImportModal,
}) => {
  const [internalSubView, setInternalSubView] = useState<'lob' | 'table' | 'budget' | 'physical_financial' | 'competence_cash' | 'raw_crono' | 'import'>('lob');
  const subView = activeSubView || internalSubView;
  const setSubView = setInternalSubView;

  // Gestão de Versões de Cronograma e Linha de Base (Baseline)
  const {versions:scheduleVersions,setVersions:setScheduleVersions,busy:versionsBusy,error:versionsError,run:runVersions} = useScheduleVersionHistory(selectedProjectId || 'global',{cronogramaInicial,floors,allFloorsData,weights,teams,matrices});
  const [showGhostBaseline, setShowGhostBaseline] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`curtoprazo_lob_ghost_${selectedProjectId || 'global'}`) === 'true';
    } catch (_) {}
    return false;
  });
  const [isVersionModalOpen, setIsVersionModalOpen] = useState(false);
  const [verNameInput, setVerNameInput] = useState('');
  const [verDescInput, setVerDescInput] = useState('');
  const [verIsBaselineCheck, setVerIsBaselineCheck] = useState(false);
  const [verTypeInput, setVerTypeInput] = useState<ScheduleVersionType>('forecast');
  const [verAuthorInput, setVerAuthorInput] = useState('Engenharia / Planejamento');
  const [isVersionDrawerOpen, setIsVersionDrawerOpen] = useState(false);
  const [versionSearchQuery, setVersionSearchQuery] = useState('');
  const [isMacroflowModalOpen, setIsMacroflowModalOpen] = useState(false);

  const currentBaseline = useMemo(() => {
    return scheduleVersions.find((v) => v.isBaseline) || scheduleVersions[0] || null;
  }, [scheduleVersions]);

  const currentActiveVersion = useMemo(() => {
    return scheduleVersions.find((v) => v.isActive) || scheduleVersions[0] || null;
  }, [scheduleVersions]);

  // Mapa de tarefas da baseline para renderizar linha de base fantasma na Linha de Balanço
  const baselineTaskMap = useMemo(() => {
    const map = new Map<string, { start: string; end: string; duration: number }>();
    if (!currentBaseline?.snapshot?.cronogramaInicial) return map;
    for (const act of currentBaseline.snapshot.cronogramaInicial) {
      const id = String(act.id || act.tarefaId || '');
      const s = act.startDate || act.start || act.inicio;
      const f = act.endDate || act.finish || act.fim;
      const dur = act.duration || 1;
      if (id && s && f) {
        map.set(id, { start: s.slice(0, 10), end: f.slice(0, 10), duration: dur });
      }
    }
    return map;
  }, [currentBaseline]);

  const handleSwitchScheduleVersion = async (versionId: string) => {
    await runVersions(async () => {
      const { versions: updated, active } = await activateScheduleVersion(selectedProjectId || 'global', versionId);
      setScheduleVersions(updated);
      if (active && active.snapshot) {
        const snap = active.snapshot;
        const compiled = compileLobToCronograma(
          hydrateLobFromCronograma(snap.cronogramaInicial, snap.floors, snap.allFloorsData),
          snap.allFloorsData,
          snap.weights || weights,
          snap.teams || teams,
          snap.matrices || matrices
        );
        await onApplySchedule(compiled, `Versão "${active.name}" ativada no cronograma!`);
      }
    });
  };

  const handleMarkAsBaseline = async (versionId: string) => {
    await runVersions(async () => {
      const updated = await setVersionAsBaseline(selectedProjectId || 'global', versionId);
      setScheduleVersions(updated);
    });
  };

  const handleCreateNewVersion = async (typeOverride?: ScheduleVersionType) => {
    await runVersions(async () => {
      const chosenType = typeOverride || verTypeInput;
      const isBaseline = chosenType === 'baseline' || verIsBaselineCheck;
      const fallbackTitle =
        chosenType === 'baseline'
          ? `Linha de Base 0${scheduleVersions.filter((v) => v.isBaseline).length + 1}`
          : chosenType === 'scenario'
          ? `Cenário Simulação 0${scheduleVersions.filter((v) => v.type === 'scenario').length + 1}`
          : chosenType === 'meta'
          ? `Cronograma Meta 0${scheduleVersions.filter((v) => v.type === 'meta').length + 1}`
          : chosenType === 'backup'
          ? `Backup de Segurança ${new Date().toLocaleDateString('pt-BR')}`
          : `Revisão 0${scheduleVersions.length + 1}`;

      const { versions: updated } = await createNewScheduleVersion(
        selectedProjectId || 'global',
        verNameInput || fallbackTitle,
        verDescInput,
        isBaseline,
        {
          cronogramaInicial,
          floors,
          allFloorsData,
          weights,
          teams,
          matrices,
        },
        {
          type: chosenType,
          author: verAuthorInput || 'Engenharia / Planejamento',
        }
      );
      setScheduleVersions(updated);
      setIsVersionModalOpen(false);
      setVerNameInput('');
      setVerDescInput('');
      setVerIsBaselineCheck(false);
      setVerTypeInput('forecast');
    });
  };

  const handlePromoteScenario = async (scenarioId: string) => {
    await runVersions(async () => {
      const { versions: updated, active } = await promoteScenarioToOfficial(selectedProjectId || 'global', scenarioId);
      setScheduleVersions(updated);
      if (active && active.snapshot) {
        const snap = active.snapshot;
        const compiled = compileLobToCronograma(
          hydrateLobFromCronograma(snap.cronogramaInicial, snap.floors, snap.allFloorsData),
          snap.allFloorsData,
          snap.weights || weights,
          snap.teams || teams,
          snap.matrices || matrices
        );
        await onApplySchedule(compiled, `Cenário promovido a Previsto Oficial com sucesso!`);
      }
    });
  };

  const handleDeleteScheduleVersion = async (versionId: string) => {
    await runVersions(async () => {
      const updated = await deleteScheduleVersion(selectedProjectId || 'global', versionId);
      setScheduleVersions(updated);
    });
  };

  // Estado local da Linha de Balanço hidratado a partir do projeto ativo
  const [lobState, setLobState] = useState<LongTermScheduleState>(() =>
    hydrateLobFromCronograma(cronogramaInicial, floors, allFloorsData)
  );
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Assinatura leve e precisa para detectar qualquer alteração em cronogramaInicial (inclusive progresso vindo do Semanal)
  const cronoSignature = useMemo(() => {
    if (!cronogramaInicial || cronogramaInicial.length === 0) {
      return `${selectedProjectId || ''}||0||${floors?.length || 0}`;
    }
    let progSum = 0;
    for (let i = 0; i < cronogramaInicial.length; i++) {
      progSum += Number(cronogramaInicial[i].progress ?? cronogramaInicial[i].progresso_real ?? 0);
    }
    return `${selectedProjectId || ''}||${cronogramaInicial.length}||${floors?.length || 0}||${cronogramaInicial[0]?.id || ''}||${progSum.toFixed(2)}`;
  }, [selectedProjectId, cronogramaInicial, floors]);

  const lastHydratedSignatureRef = useRef<string>(cronoSignature);

  useEffect(() => {
    if (cronoSignature !== lastHydratedSignatureRef.current) {
      lastHydratedSignatureRef.current = cronoSignature;
      setLobState((prev) =>
        hydrateLobFromCronograma(cronogramaInicial, floors, allFloorsData, prev?.calendar)
      );
      setHasUnsavedChanges(false);
    }
  }, [cronoSignature, selectedProjectId, cronogramaInicial, floors, allFloorsData]);

  // Análise de grafo ultrarrápida O(V+E) (<1ms) sem reprocessar datas em cascata a cada clique
  const graphAnalysis = useMemo(() => analyzeScheduleGraph(lobState), [lobState]);
  const activeState = lobState;

  // Helper para carregar configurações persistidas da Linha de Balanço
  const loadSavedLobConfig = () => {
    try {
      const saved = localStorage.getItem(`curtoprazo_lob_config_${selectedProjectId || 'global'}`);
      if (saved) return JSON.parse(saved);
    } catch (_) {}
    return null;
  };
  const initialLobConfig = loadSavedLobConfig();

  // Controles de visualização do Canvas da Linha de Balanço
  const [zoomMode, setZoomMode] = useState<'day' | 'week' | 'month'>(() => {
    if (initialLobConfig && ['day', 'week', 'month'].includes(initialLobConfig.zoomMode)) {
      return initialLobConfig.zoomMode;
    }
    return 'week';
  });
  const [dayWidth, setDayWidth] = useState<number>(() => {
    if (initialLobConfig && typeof initialLobConfig.dayWidth === 'number' && initialLobConfig.dayWidth >= 3 && initialLobConfig.dayWidth <= 40) {
      return initialLobConfig.dayWidth;
    }
    return 10;
  });
  const [defaultLinesPerFloor, setDefaultLinesPerFloor] = useState<number>(() => {
    if (initialLobConfig && typeof initialLobConfig.defaultLinesPerFloor === 'number' && initialLobConfig.defaultLinesPerFloor >= 1 && initialLobConfig.defaultLinesPerFloor <= 10) {
      return initialLobConfig.defaultLinesPerFloor;
    }
    try {
      const saved = localStorage.getItem(`curtoprazo_lob_lines_per_floor_${selectedProjectId || 'global'}`);
      if (saved) {
        const val = Number(saved);
        if (!isNaN(val) && val >= 1 && val <= 10) return val;
      }
    } catch (_) {}
    return 5;
  });
  const [subLineHeight, setSubLineHeight] = useState<number>(() => {
    if (initialLobConfig && [18, 22, 26, 32].includes(initialLobConfig.subLineHeight)) {
      return initialLobConfig.subLineHeight;
    }
    try {
      const saved = localStorage.getItem(`curtoprazo_lob_subline_height_${selectedProjectId || 'global'}`);
      if (saved) {
        const val = Number(saved);
        if ([18, 22, 26, 32].includes(val)) return val;
      }
    } catch (_) {}
    return 22; // Padrão Normal: 22px
  });
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [packageSearchQuery, setPackageSearchQuery] = useState<string>('');
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<string>('');
  const [selectedServiceFilter, setSelectedServiceFilter] = useState<string>('');
  const [selectedTeamFilter, setSelectedTeamFilter] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [hideEmptyFloors, setHideEmptyFloors] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.hideEmptyFloors === 'boolean') {
      return initialLobConfig.hideEmptyFloors;
    }
    try {
      return localStorage.getItem(`curtoprazo_lob_hide_empty_${selectedProjectId || 'global'}`) === 'true';
    } catch (_) {}
    return false;
  });
  // Por padrão desenha as setas da atividade selecionada (igual ao Prevision), ou todas simultâneas se configurado
  const [showDependencyArrows, setShowDependencyArrows] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.showDependencyArrows === 'boolean') {
      return initialLobConfig.showDependencyArrows;
    }
    try {
      return localStorage.getItem(`curtoprazo_lob_arrows_${selectedProjectId || 'global'}`) === 'true';
    } catch (_) {}
    return false;
  });
  const [showCriticalPath, setShowCriticalPath] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.showCriticalPath === 'boolean') {
      return initialLobConfig.showCriticalPath;
    }
    try {
      return localStorage.getItem(`curtoprazo_lob_critical_path_${selectedProjectId || 'global'}`) === 'true';
    } catch (_) {}
    return false;
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    if (initialLobConfig && initialLobConfig.collapsedGroups && typeof initialLobConfig.collapsedGroups === 'object') {
      return initialLobConfig.collapsedGroups;
    }
    return {};
  });
  const [groupSortOrders, setGroupSortOrders] = useState<Record<string, 'asc' | 'desc'>>(() => {
    if (initialLobConfig && initialLobConfig.groupSortOrders && typeof initialLobConfig.groupSortOrders === 'object') {
      return initialLobConfig.groupSortOrders;
    }
    return {};
  });
  const [globalFloorSortOrder, setGlobalFloorSortOrder] = useState<'asc' | 'desc'>(() => {
    if (initialLobConfig && (initialLobConfig.globalFloorSortOrder === 'asc' || initialLobConfig.globalFloorSortOrder === 'desc')) {
      return initialLobConfig.globalFloorSortOrder;
    }
    return 'asc';
  });
  const [floorSortField, setFloorSortField] = useState<'position' | 'name' | 'startDate'>(() => {
    if (initialLobConfig && ['position', 'name', 'startDate'].includes(initialLobConfig.floorSortField)) {
      return initialLobConfig.floorSortField;
    }
    return 'position';
  });

  // --- Novos Controles: Cabeçalho & Formatação da Escala de Tempo ---
  const [lobMonthFormat, setLobMonthFormat] = useState<'name_year' | 'mm_yy' | 'index'>(() => {
    if (initialLobConfig && ['name_year', 'mm_yy', 'index'].includes(initialLobConfig.lobMonthFormat)) {
      return initialLobConfig.lobMonthFormat;
    }
    return 'name_year';
  });
  const [lobWeekFormat, setLobWeekFormat] = useState<'numeric' | 'short' | 'week_num' | 'day'>(() => {
    if (initialLobConfig && ['numeric', 'short', 'week_num', 'day'].includes(initialLobConfig.lobWeekFormat)) {
      return initialLobConfig.lobWeekFormat;
    }
    return 'numeric';
  });
  const [lobDayFormat, setLobDayFormat] = useState<'both' | 'day_number' | 'day_letter'>(() => {
    if (initialLobConfig && ['both', 'day_number', 'day_letter'].includes(initialLobConfig.lobDayFormat)) {
      return initialLobConfig.lobDayFormat;
    }
    return 'both';
  });

  // --- Novos Controles: Rótulos e Textos das Atividades ---
  const [showLeftDateLabel, setShowLeftDateLabel] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.showLeftDateLabel === 'boolean') {
      return initialLobConfig.showLeftDateLabel;
    }
    return true;
  });
  const [showRightProgressLabel, setShowRightProgressLabel] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.showRightProgressLabel === 'boolean') {
      return initialLobConfig.showRightProgressLabel;
    }
    return true;
  });
  const [showPackageNameInBar, setShowPackageNameInBar] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.showPackageNameInBar === 'boolean') {
      return initialLobConfig.showPackageNameInBar;
    }
    return true;
  });
  const [showDurationLabel, setShowDurationLabel] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.showDurationLabel === 'boolean') {
      return initialLobConfig.showDurationLabel;
    }
    return true;
  });

  // --- Novos Controles: Linhas de Grade (Estilo MS Project) ---
  const [gridHorizontalWidth, setGridHorizontalWidth] = useState<number>(() => {
    if (initialLobConfig && typeof initialLobConfig.gridHorizontalWidth === 'number') {
      return initialLobConfig.gridHorizontalWidth;
    }
    return 2; // Padrão: 2px (mais grossa que 1px)
  });
  const [gridHorizontalColor, setGridHorizontalColor] = useState<string>(() => {
    if (initialLobConfig && typeof initialLobConfig.gridHorizontalColor === 'string') {
      return initialLobConfig.gridHorizontalColor;
    }
    return '#64748b'; // Padrão: mais escura (#64748b / slate-500)
  });
  const [gridHorizontalStyle, setGridHorizontalStyle] = useState<'solid' | 'dashed' | 'dotted'>(() => {
    if (initialLobConfig && ['solid', 'dashed', 'dotted'].includes(initialLobConfig.gridHorizontalStyle)) {
      return initialLobConfig.gridHorizontalStyle;
    }
    return 'solid';
  });
  const [gridVerticalWidth, setGridVerticalWidth] = useState<number>(() => {
    if (initialLobConfig && typeof initialLobConfig.gridVerticalWidth === 'number') {
      return initialLobConfig.gridVerticalWidth;
    }
    return 1;
  });
  const [gridVerticalColor, setGridVerticalColor] = useState<string>(() => {
    if (initialLobConfig && typeof initialLobConfig.gridVerticalColor === 'string') {
      return initialLobConfig.gridVerticalColor;
    }
    return '#cbd5e1';
  });
  const [gridVerticalStyle, setGridVerticalStyle] = useState<'solid' | 'dashed' | 'dotted'>(() => {
    if (initialLobConfig && ['solid', 'dashed', 'dotted'].includes(initialLobConfig.gridVerticalStyle)) {
      return initialLobConfig.gridVerticalStyle;
    }
    return 'solid';
  });
  const [enableZebraBands, setEnableZebraBands] = useState<boolean>(() => {
    if (initialLobConfig && typeof initialLobConfig.enableZebraBands === 'boolean') {
      return initialLobConfig.enableZebraBands;
    }
    return false;
  });

  // Aba ativa do modal de configurações
  const [displaySettingsTab, setDisplaySettingsTab] = useState<
    'structure' | 'timeline' | 'versions' | 'lines' | 'labels' | 'grid' | 'packages' | 'options'
  >('structure');

  // --- Persistência Automática Total no localStorage ---
  useEffect(() => {
    try {
      const configObj = {
        zoomMode,
        dayWidth,
        defaultLinesPerFloor,
        subLineHeight,
        hideEmptyFloors,
        showDependencyArrows,
        showCriticalPath,
        showGhostBaseline,
        globalFloorSortOrder,
        floorSortField,
        lobMonthFormat,
        lobWeekFormat,
        lobDayFormat,
        groupSortOrders,
        collapsedGroups,
        showLeftDateLabel,
        showRightProgressLabel,
        showPackageNameInBar,
        showDurationLabel,
        gridHorizontalWidth,
        gridHorizontalColor,
        gridHorizontalStyle,
        gridVerticalWidth,
        gridVerticalColor,
        gridVerticalStyle,
        enableZebraBands,
      };
      localStorage.setItem(`curtoprazo_lob_config_${selectedProjectId || 'global'}`, JSON.stringify(configObj));
      // Salva chaves legadas para compatibilidade
      localStorage.setItem(`curtoprazo_lob_subline_height_${selectedProjectId || 'global'}`, String(subLineHeight));
      localStorage.setItem(`curtoprazo_lob_lines_per_floor_${selectedProjectId || 'global'}`, String(defaultLinesPerFloor));
      localStorage.setItem(`curtoprazo_lob_hide_empty_${selectedProjectId || 'global'}`, String(hideEmptyFloors));
      localStorage.setItem(`curtoprazo_lob_arrows_${selectedProjectId || 'global'}`, String(showDependencyArrows));
      localStorage.setItem(`curtoprazo_lob_critical_path_${selectedProjectId || 'global'}`, String(showCriticalPath));
      localStorage.setItem(`curtoprazo_lob_ghost_${selectedProjectId || 'global'}`, String(showGhostBaseline));
    } catch (err) {
      console.warn('Erro ao persistir configurações da Linha de Balanço:', err);
    }
  }, [
    selectedProjectId,
    zoomMode,
    dayWidth,
    defaultLinesPerFloor,
    subLineHeight,
    hideEmptyFloors,
    showDependencyArrows,
    showCriticalPath,
    showGhostBaseline,
    globalFloorSortOrder,
    floorSortField,
    lobMonthFormat,
    lobWeekFormat,
    lobDayFormat,
    groupSortOrders,
    collapsedGroups,
    showLeftDateLabel,
    showRightProgressLabel,
    showPackageNameInBar,
    showDurationLabel,
    gridHorizontalWidth,
    gridHorizontalColor,
    gridHorizontalStyle,
    gridVerticalWidth,
    gridVerticalColor,
    gridVerticalStyle,
    enableZebraBands,
  ]);

  // Recarregar configurações se o projeto mudar
  useEffect(() => {
    const cfg = loadSavedLobConfig();
    if (!cfg) return;
    if (['day', 'week', 'month'].includes(cfg.zoomMode)) setZoomMode(cfg.zoomMode);
    if (typeof cfg.dayWidth === 'number' && cfg.dayWidth >= 3 && cfg.dayWidth <= 40) setDayWidth(cfg.dayWidth);
    if (typeof cfg.defaultLinesPerFloor === 'number') setDefaultLinesPerFloor(cfg.defaultLinesPerFloor);
    if ([18, 22, 26, 32].includes(cfg.subLineHeight)) setSubLineHeight(cfg.subLineHeight);
    if (typeof cfg.hideEmptyFloors === 'boolean') setHideEmptyFloors(cfg.hideEmptyFloors);
    if (typeof cfg.showDependencyArrows === 'boolean') setShowDependencyArrows(cfg.showDependencyArrows);
    if (typeof cfg.showCriticalPath === 'boolean') setShowCriticalPath(cfg.showCriticalPath);
    if (typeof cfg.showGhostBaseline === 'boolean') setShowGhostBaseline(cfg.showGhostBaseline);
    if (cfg.globalFloorSortOrder === 'asc' || cfg.globalFloorSortOrder === 'desc') setGlobalFloorSortOrder(cfg.globalFloorSortOrder);
    if (['position', 'name', 'startDate'].includes(cfg.floorSortField)) setFloorSortField(cfg.floorSortField);
    if (['name_year', 'mm_yy', 'index'].includes(cfg.lobMonthFormat)) setLobMonthFormat(cfg.lobMonthFormat);
    if (['numeric', 'short', 'week_num', 'day'].includes(cfg.lobWeekFormat)) setLobWeekFormat(cfg.lobWeekFormat);
    if (['both', 'day_number', 'day_letter'].includes(cfg.lobDayFormat)) setLobDayFormat(cfg.lobDayFormat);
    if (cfg.groupSortOrders) setGroupSortOrders(cfg.groupSortOrders);
    if (cfg.collapsedGroups) setCollapsedGroups(cfg.collapsedGroups);
    if (typeof cfg.showLeftDateLabel === 'boolean') setShowLeftDateLabel(cfg.showLeftDateLabel);
    if (typeof cfg.showRightProgressLabel === 'boolean') setShowRightProgressLabel(cfg.showRightProgressLabel);
    if (typeof cfg.showPackageNameInBar === 'boolean') setShowPackageNameInBar(cfg.showPackageNameInBar);
    if (typeof cfg.showDurationLabel === 'boolean') setShowDurationLabel(cfg.showDurationLabel);
    if (typeof cfg.gridHorizontalWidth === 'number') setGridHorizontalWidth(cfg.gridHorizontalWidth);
    if (cfg.gridHorizontalColor) setGridHorizontalColor(cfg.gridHorizontalColor);
    if (cfg.gridHorizontalStyle) setGridHorizontalStyle(cfg.gridHorizontalStyle);
    if (typeof cfg.gridVerticalWidth === 'number') setGridVerticalWidth(cfg.gridVerticalWidth);
    if (cfg.gridVerticalColor) setGridVerticalColor(cfg.gridVerticalColor);
    if (cfg.gridVerticalStyle) setGridVerticalStyle(cfg.gridVerticalStyle);
    if (typeof cfg.enableZebraBands === 'boolean') setEnableZebraBands(cfg.enableZebraBands);
  }, [selectedProjectId]);

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const toggleGroupSort = (groupId: string) => {
    setGroupSortOrders((prev) => {
      const current = prev[groupId] || globalFloorSortOrder;
      const next = current === 'asc' ? 'desc' : 'asc';
      return { ...prev, [groupId]: next };
    });
  };

  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [isActivityDrawerOpen, setIsActivityDrawerOpen] = useState<boolean>(false);
  const activityDrawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isActivityDrawerOpen) {
        setIsActivityDrawerOpen(false);
        setEditingActivity(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActivityDrawerOpen]);

  // Fecha o drawer de atividades ao clicar em áreas vazias da tela (fora das tarefas e fora do drawer)
  useEffect(() => {
    if (!isActivityDrawerOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      // Se clicou dentro do próprio drawer, não fecha
      if (activityDrawerRef.current && activityDrawerRef.current.contains(e.target as Node)) {
        return;
      }

      // Se clicou em uma barra de tarefa, modal ou controle interativo, a barra lida com sua ação
      const target = e.target as HTMLElement | null;
      if (
        target?.closest('[data-activity-bar="true"]') ||
        target?.closest('[data-prevent-drawer-close="true"]') ||
        target?.closest('button') ||
        target?.closest('input') ||
        target?.closest('select')
      ) {
        return;
      }

      // Clicou em área vazia da tela ou do canvas da linha de balanço: fecha o drawer
      setIsActivityDrawerOpen(false);
      setEditingActivity(null);
      setSelectedActivityId(null);
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('touchstart', handlePointerDown);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('touchstart', handlePointerDown);
    };
  }, [isActivityDrawerOpen]);

  // Modais / Gavetas de Configuração
  const [activeModal, setActiveModal] = useState<
    null | 'calendar' | 'floors' | 'services' | 'pace' | 'activity' | 'display_settings'
  >(null);

  // Estado do Modal de Locais em Lote
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState(GROUP_COLORS[1]);
  const [seqPrefix, setSeqPrefix] = useState('Pavimento ');
  const [seqSuffix, setSeqSuffix] = useState('');
  const [seqQty, setSeqQty] = useState(10);
  const [seqStartNum, setSeqStartNum] = useState(1);
  const [seqArea, setSeqArea] = useState<number>(450);
  const [seqGroupId, setSeqGroupId] = useState<string>('');
  const [seqZeroPad, setSeqZeroPad] = useState<boolean>(true);
  const [singleFloorName, setSingleFloorName] = useState('');
  const [floorSearchModal, setFloorSearchModal] = useState('');

  // Estado do Modal de Pacotes de Trabalho & Sub-tarefas
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [pkgName, setPkgName] = useState('');
  const [pkgColor, setPkgColor] = useState(PACKAGE_COLORS[0]);
  const [pkgDefaultLine, setPkgDefaultLine] = useState(1);
  const [pkgDefaultResp, setPkgDefaultResp] = useState('EQUIPE GERAL');
  const [pkgDefaultCost, setPkgDefaultCost] = useState(15000);
  const [pkgAutoChain, setPkgAutoChain] = useState(true);
  const [pkgJobs, setPkgJobs] = useState<ScheduleJobTemplate[]>([]);
  const [newJobName, setNewJobName] = useState('');
  const [newJobDuration, setNewJobDuration] = useState(2);
  const [newJobCost, setNewJobCost] = useState(5000);

  // Estado do Modal de Ritmo / Escadinha em Massa
  const [paceFloorIds, setPaceFloorIds] = useState<string[]>([]);
  const [paceServiceIds, setPaceServiceIds] = useState<string[]>([]);
  const [paceStartDate, setPaceStartDate] = useState<string>(activeState.calendar.startDate || getTodayISO());
  const [pacedFloorsCount, setPacedFloorsCount] = useState<number>(1);
  const [paceDirection, setPaceDirection] = useState<'up' | 'down'>('up');
  const [paceLagDays, setPaceLagDays] = useState<number>(1);
  const [paceChainServices, setPaceChainServices] = useState<boolean>(true);
  const [paceChainFloors, setPaceChainFloors] = useState<boolean>(true);

  // Estado do Modal de Criação/Edição de Atividade (`ActivityDialog`)
  const [activityModalTab, setActivityModalTab] = useState<'general' | 'jobs' | 'dependencies' | 'replicate'>('general');
  const [editingActivity, setEditingActivity] = useState<LobActivity | null>(null);
  const [createTargetFloorIds, setCreateTargetFloorIds] = useState<string[]>([]);
  const [newRulePredServiceId, setNewRulePredServiceId] = useState<string>('');
  const [newRuleFloorDir, setNewRuleFloorDir] = useState<FloorDirection>('same');
  const [newRuleSpecificFloorId, setNewRuleSpecificFloorId] = useState<string>('');
  const [newRuleDelay, setNewRuleDelay] = useState<number>(1);
  const [newRulePredAttr, setNewRulePredAttr] = useState<'start' | 'end'>('start');
  const [newRuleBaseAttr, setNewRuleBaseAttr] = useState<'end' | 'start'>('end');
  const [newRuleTimeOp, setNewRuleTimeOp] = useState<'after' | 'before'>('after');
  const [replicateRuleAcrossGroup, setReplicateRuleAcrossGroup] = useState<boolean>(false);
  const [directPredFloorId, setDirectPredFloorId] = useState<string>('');
  const [directPredServiceId, setDirectPredServiceId] = useState<string>('');

  // Estado da Visão Tabela EAP / Gantt (Paginada para performance instantânea)
  const [tablePage, setTablePage] = useState<number>(0);
  const TABLE_PAGE_SIZE = 40;
  const [expandedTableNodes, setExpandedTableNodes] = useState<Record<string, boolean>>({});
  const [newHolidayInput, setNewHolidayInput] = useState<string>('');

  // Drag & Resize leve (não recalcula layoutGeometry de todas as barras durante o mousemove)
  const [dragState, setDragState] = useState<{
    activityId: string;
    mode: 'move' | 'resize';
    initialX: number;
    initialStart: string;
    initialDuration: number;
    previewDeltaPx: number;
  } | null>(null);

  const handleZoomModeChange = (mode: 'day' | 'week' | 'month') => {
    setZoomMode(mode);
    if (mode === 'day') setDayWidth(24);
    else if (mode === 'week') setDayWidth(10);
    else setDayWidth(4.5);
  };

  const persistStateToApp = async (nextState: LongTermScheduleState, customMsg?: string) => {
    setIsSaving(true);
    try {
      const compiled = compileLobToCronograma(
        nextState,
        allFloorsData,
        weights,
        teams,
        matrices
      );
      let nextProgSum = 0;
      for (let i = 0; i < compiled.cronogramaInicial.length; i++) {
        nextProgSum += Number(compiled.cronogramaInicial[i].progress ?? 0);
      }
      lastHydratedSignatureRef.current = `${selectedProjectId || ''}||${compiled.cronogramaInicial.length}||${compiled.floors.length}||${compiled.cronogramaInicial?.[0]?.id || ''}||${nextProgSum.toFixed(2)}`;
      await onApplySchedule(
        compiled,
        customMsg || 'Planejamento sincronizado com sucesso!'
      );
      setHasUnsavedChanges(false);
    } finally {
      setIsSaving(false);
    }
  };

  // Atualização rápida para cadastros (Locais, Grupos, Cores) sem rodar cascata pesada de datas
  const updateLobMetadataFast = (updater: (prev: LongTermScheduleState) => LongTermScheduleState) => {
    setLobState((prev) => updater(prev));
    setHasUnsavedChanges(true);
  };

  // Atualização que envolve mudança de datas ou regras de predecessoras
  const updateLobScheduleDates = (
    updater: (prev: LongTermScheduleState) => LongTermScheduleState,
    forceRemoveGaps = false,
    autoPersist = false
  ) => {
    let recalculatedState: LongTermScheduleState | null = null;
    setLobState((prev) => {
      const next = updater(prev);
      recalculatedState = recalculateSchedule(next, { forceRemoveGaps }).state;
      return recalculatedState;
    });
    if (autoPersist && recalculatedState) {
      persistStateToApp(recalculatedState);
    } else {
      setHasUnsavedChanges(true);
    }
  };

  const serviceMap = useMemo(() => {
    const m = new Map<string, ScheduleServicePackage>();
    activeState.services.forEach((s) => m.set(s.id, s));
    return m;
  }, [activeState.services]);

  const groupMap = useMemo(() => {
    const m = new Map<string, ReplicationGroup>();
    activeState.replicationGroups.forEach((g) => m.set(g.id, g));
    return m;
  }, [activeState.replicationGroups]);

  const floorMap = useMemo(() => {
    const m = new Map<string, ScheduleFloor>();
    activeState.floors.forEach((f) => m.set(f.id, f));
    return m;
  }, [activeState.floors]);

  const activityMap = useMemo(() => {
    const m = new Map<string, LobActivity>();
    activeState.activities.forEach((a) => m.set(a.id, a));
    return m;
  }, [activeState.activities]);

  const orderedGroups = useMemo(
    () => [...activeState.replicationGroups].sort((a, b) => a.position - b.position),
    [activeState.replicationGroups]
  );

  const handleMoveGroupOrder = (groupId: string, direction: 'up' | 'down') => {
    const list = [...orderedGroups];
    const idx = list.findIndex((g) => g.id === groupId);
    if (idx < 0) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === list.length - 1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    const currentPos = list[idx].position ?? idx;
    const targetPos = list[targetIdx].position ?? targetIdx;

    updateLobMetadataFast((prev) => {
      const newGroups = prev.replicationGroups.map((g) => {
        if (g.id === list[idx].id) return { ...g, position: targetPos };
        if (g.id === list[targetIdx].id) return { ...g, position: currentPos };
        return g;
      });
      return { ...prev, replicationGroups: newGroups };
    });
  };

  const floorEarliestDateMap = useMemo(() => {
    const m = new Map<string, string>();
    for (let i = 0; i < activeState.activities.length; i++) {
      const act = activeState.activities[i];
      if (!act.start) continue;
      const current = m.get(act.floorId);
      if (!current || act.start < current) {
        m.set(act.floorId, act.start);
      }
    }
    return m;
  }, [activeState.activities]);

  const orderedFloors = useMemo(() => {
    return [...activeState.floors].sort((a, b) => {
      const ga = groupMap.get(a.replicationGroupId)?.position ?? 999;
      const gb = groupMap.get(b.replicationGroupId)?.position ?? 999;
      if (ga !== gb) return ga - gb;

      let cmp = 0;
      if (floorSortField === 'name') {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      } else if (floorSortField === 'startDate') {
        const dateA = floorEarliestDateMap.get(a.id) || '9999-99-99';
        const dateB = floorEarliestDateMap.get(b.id) || '9999-99-99';
        cmp = dateA.localeCompare(dateB);
      } else {
        cmp = (a.position || 0) - (b.position || 0);
      }

      return globalFloorSortOrder === 'desc' ? -cmp : cmp;
    });
  }, [activeState.floors, groupMap, floorSortField, floorEarliestDateMap, globalFloorSortOrder]);

  // Filtra atividades em passagem única O(N)
  const filteredActivities = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const teamUpper = selectedTeamFilter ? selectedTeamFilter.toUpperCase() : '';
    return activeState.activities.filter((act) => {
      if (selectedServiceFilter && act.serviceId !== selectedServiceFilter) return false;
      if (teamUpper && act.responsible.toUpperCase() !== teamUpper) return false;
      const flr = floorMap.get(act.floorId);
      const pkg = serviceMap.get(act.serviceId);
      if (!flr || !pkg) return false;
      if (selectedGroupFilter && flr.replicationGroupId !== selectedGroupFilter) return false;
      if (q) {
        if (
          !pkg.name.toLowerCase().includes(q) &&
          !flr.name.toLowerCase().includes(q) &&
          !act.responsible.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [
    activeState.activities,
    floorMap,
    serviceMap,
    selectedGroupFilter,
    selectedServiceFilter,
    selectedTeamFilter,
    searchQuery,
  ]);

  // Índice O(1) de atividades por floorId (elimina loops O(Floors * Activities) no layoutGeometry!)
  const activitiesByFloorMap = useMemo(() => {
    const m = new Map<string, LobActivity[]>();
    for (let i = 0; i < filteredActivities.length; i++) {
      const act = filteredActivities[i];
      let list = m.get(act.floorId);
      if (!list) {
        list = [];
        m.set(act.floorId, list);
      }
      list.push(act);
    }
    return m;
  }, [filteredActivities]);

  // Horizonte de datas da Linha de Balanço (Eixo X)
  const timelineBounds = useMemo(() => {
    let minDate = activeState.calendar.startDate || getTodayISO();
    let maxDate = addCalendarDays(minDate, 120);

    if (activeState.activities.length > 0) {
      let minAct = '';
      let maxAct = '';
      for (let i = 0; i < activeState.activities.length; i++) {
        const a = activeState.activities[i];
        if (a.start && (!minAct || a.start < minAct)) minAct = a.start;
        if (a.end && (!maxAct || a.end > maxAct)) maxAct = a.end;
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

    // Iniciais dos dias da semana em português (0: Dom, 1: Seg, 2: Ter, 3: Qua, 4: Qui, 5: Sex, 6: Sáb)
    // De Segunda a Domingo: S, T, Q, Q, S, S, D
    const DAY_INITIALS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

    for (let i = 0; i < totalDays; i++) {
      const d = addCalendarDays(minDate, i);
      const nextD = addCalendarDays(minDate, i + 1);
      const isEndOfMonth = d.slice(5, 7) !== nextD.slice(5, 7);
      const dayOfMonth = Number(d.slice(8, 10));
      const dow = new Date(d + 'T12:00:00Z').getUTCDay();
      const letter = DAY_INITIALS[dow] || 'S';
      const isWorking = isWorkDay(d, activeState.calendar);

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
        if (lobMonthFormat === 'mm_yy') {
          mLabel = `${String(m).padStart(2, '0')}/${String(y).slice(2)}`;
        } else if (lobMonthFormat === 'index') {
          mLabel = `Mês ${mIndex}`;
        }
        months.push({ key: ym, label: mLabel, count: 1 });
      }

      // Agrupa semanas (inicia nova semana na Segunda-feira ou no primeiro dia)
      if (i === 0 || dow === 1) {
        const wIndex = weeks.length + 1;
        let wLabel = `${d.slice(8, 10)}/${d.slice(5, 7)}`;
        if (lobWeekFormat === 'short') {
          wLabel = `S${wIndex}`;
        } else if (lobWeekFormat === 'week_num') {
          wLabel = `Semana ${wIndex}`;
        } else if (lobWeekFormat === 'day') {
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

    return { minDate, maxDate: addCalendarDays(minDate, totalDays - 1), totalDays, months, weeks, days };
  }, [activeState.calendar, activeState.activities, lobMonthFormat, lobWeekFormat]);

  // KPIs do Projeto no Cabeçalho
  const projectStats = useMemo(() => {
    const acts = activeState.activities;
    if (acts.length === 0) {
      return {
        minStart: activeState.calendar.startDate,
        maxEnd: '-',
        workingDaysSpan: 0,
        totalCost: 0,
        overallProgress: 0,
        totalJobsCount: 0,
      };
    }
    let minStart = '';
    let maxEnd = '';
    let totalCost = 0;
    let weightedProgressSum = 0;
    let simpleProgressSum = 0;
    let totalJobsCount = 0;

    for (let i = 0; i < acts.length; i++) {
      const act = acts[i];
      if (!minStart || act.start < minStart) minStart = act.start;
      if (!maxEnd || act.end > maxEnd) maxEnd = act.end;
      const c = Number(act.cost) || 0;
      totalCost += c;
      weightedProgressSum += (Number(act.progress) || 0) * c;
      simpleProgressSum += Number(act.progress) || 0;
      totalJobsCount += act.jobs?.length || 1;
    }

    const overallProgress =
      totalCost > 0
        ? weightedProgressSum / totalCost
        : simpleProgressSum / Math.max(1, acts.length);

    return {
      minStart,
      maxEnd,
      workingDaysSpan: countWorkingDays(minStart, maxEnd, activeState.calendar),
      totalCost,
      overallProgress: Math.round(overallProgress * 10) / 10,
      totalJobsCount,
    };
  }, [activeState.activities, activeState.calendar]);

  // Drag & Resize leve (sem recalcular layoutGeometry durante o movimento do mouse)
  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaPx = e.clientX - dragState.initialX;
      setDragState((prev) => (prev ? { ...prev, previewDeltaPx: deltaPx } : null));
    };

    const handleMouseUp = () => {
      const deltaDays = Math.round(dragState.previewDeltaPx / Math.max(2, dayWidth));
      if (deltaDays !== 0) {
        updateLobScheduleDates((prev) => {
          const act = prev.activities.find((a) => a.id === dragState.activityId);
          if (!act) return prev;

          if (dragState.mode === 'move') {
            const rawCandidate = addCalendarDays(dragState.initialStart, deltaDays);
            return propagateScheduleCascade(prev, act.id, rawCandidate, act.duration);
          } else {
            const nextDur = Math.max(1, dragState.initialDuration + Math.round(deltaDays * 0.75));
            return propagateScheduleCascade(prev, act.id, act.start, nextDur);
          }
        }, false, true);
      }
      setDragState(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, dayWidth]);

  const handleQuickStartVerticalBuilding = () => {
    const preset = getVerticalBuildingPreset();
    const cal = createDefaultCalendar(activeState.calendar.startDate);
    const baseFloors: ScheduleFloor[] = [
      { id: 'flr_fundacao', name: 'Fundação / Contenções', position: 1, area: 850, replicationGroupId: 'grp_fundacao' },
      { id: 'flr_subsolo', name: 'Subsolo', position: 2, area: 850, replicationGroupId: 'grp_fundacao' },
      { id: 'flr_terreo', name: 'Térreo / Lazer', position: 3, area: 720, replicationGroupId: 'grp_embasamento' },
    ];
    const towerFloors = createSequentialFloors(baseFloors, {
      prefix: '',
      suffix: 'º Pavimento',
      quantity: 8,
      startsWith: 1,
      area: 480,
      replicationGroupId: 'grp_torre',
      zeroPad: false,
    });
    const allPresetFloors: ScheduleFloor[] = [
      ...towerFloors,
      {
        id: 'flr_atico',
        name: 'Ático / Casa de Máquinas',
        position: towerFloors.length + 1,
        area: 280,
        replicationGroupId: 'grp_cobertura',
      },
    ];

    const initialState: LongTermScheduleState = {
      calendar: cal,
      replicationGroups: preset.replicationGroups,
      floors: allPresetFloors,
      services: preset.services,
      activities: [],
    };

    const populatedState = applyPaceAndGenerateActivities(initialState, {
      floorIds: allPresetFloors.map((f) => f.id),
      serviceIds: preset.services.map((s) => s.id),
      startDate: cal.startDate,
      pacedFloors: 1,
      direction: 'up',
      lagBetweenServicesDays: 2,
      chainAcrossServices: true,
      chainAcrossFloors: true,
    });

    setLobState(optimizeSubLines(populatedState, { defaultLinesPerFloor }));
    setHasUnsavedChanges(true);
  };

  const openServiceModal = (pkg?: ScheduleServicePackage) => {
    if (pkg) {
      setEditingServiceId(pkg.id);
      setPkgName(pkg.name);
      setPkgColor(pkg.color);
      setPkgDefaultLine(pkg.defaultLine || 1);
      setPkgDefaultResp(pkg.defaultResponsible || 'EQUIPE GERAL');
      setPkgDefaultCost(pkg.defaultTotalCost || 0);
      setPkgAutoChain(pkg.autoChainJobs !== false);
      setPkgJobs(pkg.jobs ? [...pkg.jobs] : []);
    } else {
      const nextIdx = activeState.services.length;
      setEditingServiceId(null);
      setPkgName('');
      setPkgColor(PACKAGE_COLORS[nextIdx % PACKAGE_COLORS.length]);
      setPkgDefaultLine((nextIdx % 5) + 1);
      setPkgDefaultResp('EQUIPE GERAL');
      setPkgDefaultCost(15000);
      setPkgAutoChain(true);
      setPkgJobs([]);
    }
    setActiveModal('services');
  };

  const handleSaveServicePackage = () => {
    const cleanName = pkgName.trim().toUpperCase();
    if (!cleanName) return;

    const effectiveJobs: ScheduleJobTemplate[] =
      pkgJobs.length > 0
        ? pkgJobs.map((j, idx) => ({ ...j, position: idx + 1, name: j.name.toUpperCase() }))
        : [
            {
              id: `job_${slugifySchedule(cleanName)}_1`,
              name: cleanName,
              position: 1,
              defaultDuration: 5,
              defaultResponsible: pkgDefaultResp.trim().toUpperCase() || 'EQUIPE GERAL',
              costWeight: Number(pkgDefaultCost) || 0,
            },
          ];

    const sumDuration = effectiveJobs.reduce((acc, j) => acc + (Number(j.defaultDuration) || 1), 0);
    const sumCost =
      effectiveJobs.reduce((acc, j) => acc + (Number(j.costWeight) || 0), 0) || Number(pkgDefaultCost) || 0;

    updateLobMetadataFast((prev) => {
      if (editingServiceId) {
        const updatedServices = prev.services.map((s) =>
          s.id === editingServiceId
            ? {
                ...s,
                name: cleanName,
                color: pkgColor,
                defaultLine: pkgDefaultLine,
                defaultDuration: sumDuration,
                defaultResponsible: pkgDefaultResp.trim().toUpperCase() || 'EQUIPE GERAL',
                defaultTotalCost: sumCost,
                autoChainJobs: pkgAutoChain,
                jobs: effectiveJobs,
              }
            : s
        );
        return { ...prev, services: updatedServices };
      } else {
        const newPkg: ScheduleServicePackage = {
          id: `pkg_${slugifySchedule(cleanName)}_${Date.now().toString(36)}`,
          name: cleanName,
          color: pkgColor,
          position: prev.services.length + 1,
          defaultLine: pkgDefaultLine,
          defaultDuration: sumDuration,
          defaultResponsible: pkgDefaultResp.trim().toUpperCase() || 'EQUIPE GERAL',
          defaultTotalCost: sumCost,
          autoChainJobs: pkgAutoChain,
          jobs: effectiveJobs,
        };
        return { ...prev, services: [...prev.services, newPkg] };
      }
    });

    setEditingServiceId(null);
    setPkgName('');
    setPkgJobs([]);
  };

  const openActivityDialog = (options: {
    activity?: LobActivity;
    defaultFloorId?: string;
    defaultStartDate?: string;
    defaultLine?: number;
  }) => {
    if (options.activity) {
      setSelectedActivityId(options.activity.id);
      setEditingActivity(JSON.parse(JSON.stringify({
        ...options.activity,
        predecessorIds: options.activity.predecessorIds || [],
        successorIds: options.activity.successorIds || [],
        dependencyRules: options.activity.dependencyRules || [],
      })));
      setCreateTargetFloorIds([options.activity.floorId]);
      setDirectPredFloorId(options.activity.floorId);
    } else {
      const firstPkg = activeState.services[0];
      const firstFloor = options.defaultFloorId || orderedFloors[0]?.id || '';
      const start = ensureWorkDay(options.defaultStartDate || activeState.calendar.startDate, activeState.calendar, 1);
      const draft: LobActivity = syncActivityJobs(
        {
          id: `draft_${Date.now().toString(36)}`,
          serviceId: firstPkg?.id || '',
          floorId: firstFloor,
          line: options.defaultLine || firstPkg?.defaultLine || 1,
          start,
          end: start,
          duration: firstPkg?.defaultDuration || 5,
          cost: firstPkg?.defaultTotalCost || 0,
          responsible: firstPkg?.defaultResponsible || 'EQUIPE GERAL',
          progress: 0,
          predecessorIds: [],
          successorIds: [],
          dependencyRules: [],
          jobs: [],
        },
        firstPkg,
        activeState.calendar,
        'from-jobs'
      );
      setSelectedActivityId(draft.id);
      setEditingActivity(draft);
      setCreateTargetFloorIds(firstFloor ? [firstFloor] : []);
    }
    setNewRulePredServiceId(activeState.services[0]?.id || '');
    setActivityModalTab('general');
    setIsActivityDrawerOpen(true);
  };

  const handleSaveActivityModal = (closeAfterSave = false) => {
    if (!editingActivity || !editingActivity.serviceId) return;
    const pkg = serviceMap.get(editingActivity.serviceId);
    if (!pkg) return;

    const targetFloors =
      createTargetFloorIds.length > 0 ? createTargetFloorIds : [editingActivity.floorId].filter(Boolean);
    if (targetFloors.length === 0) return;

    updateLobScheduleDates((prev) => {
      const nextActivities = [...prev.activities];
      const existingByKey = new Map<string, number>();
      nextActivities.forEach((a, idx) => {
        existingByKey.set(a.id, idx);
        existingByKey.set(`${a.serviceId}||${a.floorId}`, idx);
      });

      targetFloors.forEach((fId) => {
        const flr = prev.floors.find((f) => f.id === fId);
        if (!flr) return;

        const existingIdx =
          existingByKey.get(editingActivity.id) ??
          existingByKey.get(`${editingActivity.serviceId}||${fId}`) ??
          -1;

        const customJobsForFloor: LobActivityJob[] = (editingActivity.jobs || []).map((j, idx) => ({
          ...j,
          id:
            fId === editingActivity.floorId && !j.id.startsWith('draft_')
              ? j.id
              : `lob_job_${slugifySchedule(flr.name)}_${slugifySchedule(pkg.name)}_${slugifySchedule(j.name)}_${idx + 1}`,
        }));

        const synced = syncActivityJobs(
          {
            ...editingActivity,
            id:
              existingIdx >= 0
                ? nextActivities[existingIdx].id
                : `lob_act_${slugifySchedule(flr.name)}_${slugifySchedule(pkg.name)}`,
            floorId: fId,
            jobs: customJobsForFloor,
          },
          pkg,
          prev.calendar,
          'from-jobs'
        );

        if (existingIdx >= 0) {
          nextActivities[existingIdx] = synced;
        } else {
          nextActivities.push(synced);
        }
      });

      if (replicateRuleAcrossGroup && editingActivity.dependencyRules.length > 0) {
        const refFloor = prev.floors.find((f) => f.id === targetFloors[0]);
        if (refFloor) {
          const groupFloorIds = new Set(
            prev.floors.filter((f) => f.replicationGroupId === refFloor.replicationGroupId).map((f) => f.id)
          );
          for (let i = 0; i < nextActivities.length; i++) {
            const act = nextActivities[i];
            if (act.serviceId === editingActivity.serviceId && groupFloorIds.has(act.floorId)) {
              nextActivities[i] = {
                ...act,
                dependencyRules: JSON.parse(JSON.stringify(editingActivity.dependencyRules)),
              };
            }
          }
        }
      }

      let nextState = { ...prev, activities: nextActivities };
      // Propaga alterações de datas e duração para sucessoras e valida regras de predecessoras
      nextState = propagateScheduleCascade(
        nextState,
        editingActivity.id,
        editingActivity.start,
        editingActivity.duration
      );
      return nextState;
    }, false, true);

    if (closeAfterSave) {
      setIsActivityDrawerOpen(false);
      setEditingActivity(null);
    }
  };

  const handleExportToExcel = () => {
    const compiled = compileLobToCronograma(activeState, allFloorsData, weights, teams, matrices);
    const rows: any[][] = [
      ['EXPORTAÇÃO DE PLANEJAMENTO DE LONGO PRAZO - CURTOPRAZO / PREVISION'],
      [`Gerado em: ${new Date().toLocaleString('pt-BR')}`],
      ['', '', '', '', '', '', '', '', '', '', '', '', 'Avanço físico (%)'],
      [
        'ID',
        'Pacote de trabalho/tarefas',
        'Serviço',
        'Grupo de replicação',
        'Local do serviço',
        'Duração',
        'Data de Início',
        'Data de Término',
        'Responsáveis',
        'Custo Vinculado Atual',
        'Predecessoras',
        'Sucessoras',
        'Realizado',
      ],
    ];

    compiled.cronogramaInicial.forEach((item, idx) => {
      rows.push([
        item.originalId || String(idx + 1),
        item.macro,
        item.service,
        item.replicationGroup || 'TORRE PRINCIPAL',
        item.floor,
        item.duration,
        item.start,
        item.end,
        item.responsible,
        item.cost,
        (item.predecessors || []).join(', '),
        (item.successors || []).join(', '),
        item.progress,
      ]);
    });

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cronograma');
    XLSX.writeFile(wb, `Cronograma_Longo_Prazo_${selectedProjectId || 'Obra'}.xlsx`);
  };

  // Cálculo O(Floors + Activities) usando `activitiesByFloorMap` (sem loops aninhados e sem depender de `dragState`)
  const layoutGeometry = useMemo(() => {
    const SUB_LINE_HEIGHT = subLineHeight;
    const FLOOR_PADDING_Y = 10;
    const GROUP_HEADER_HEIGHT = 32;

    const floorGeometryMap = new Map<
      string,
      { top: number; height: number; linesCount: number; floor: ScheduleFloor; hasGroup: boolean }
    >();
    const groupHeaderGeometries: {
      group: ReplicationGroup;
      top: number;
      height: number;
      floorCount: number;
      isCollapsed: boolean;
      sortOrder: 'asc' | 'desc';
    }[] = [];

    let currentTop = 0;

    for (let gIdx = 0; gIdx < orderedGroups.length; gIdx++) {
      const grp = orderedGroups[gIdx];
      if (selectedGroupFilter && grp.id !== selectedGroupFilter) continue;

      const grpFloors: ScheduleFloor[] = [];
      for (let fIdx = 0; fIdx < orderedFloors.length; fIdx++) {
        const f = orderedFloors[fIdx];
        if (f.replicationGroupId !== grp.id) continue;
        if (hideEmptyFloors && !activitiesByFloorMap.has(f.id)) continue;
        grpFloors.push(f);
      }

      if (grpFloors.length === 0 && hideEmptyFloors) continue;

      const isCollapsed = Boolean(collapsedGroups[grp.id]);
      const sortOrder = groupSortOrders[grp.id] || globalFloorSortOrder;

      // orderedFloors já vem ordenado por floorSortField e globalFloorSortOrder.
      // Se este grupo tiver um override individual específico, aplicamos a inversão:
      const sortedGrpFloors = [...grpFloors];
      if (groupSortOrders[grp.id] && groupSortOrders[grp.id] !== globalFloorSortOrder) {
        sortedGrpFloors.reverse();
      }

      if (isCollapsed) {
        groupHeaderGeometries.push({
          group: grp,
          top: currentTop,
          height: GROUP_HEADER_HEIGHT,
          floorCount: grpFloors.length,
          isCollapsed: true,
          sortOrder,
        });
        currentTop += GROUP_HEADER_HEIGHT;
      } else {
        const groupStartTop = currentTop;
        let groupTotalHeight = 0;

        for (let fIdx = 0; fIdx < sortedGrpFloors.length; fIdx++) {
          const flr = sortedGrpFloors[fIdx];
          const floorActs = activitiesByFloorMap.get(flr.id) || [];
          let maxUsedLine = 1;
          for (let aIdx = 0; aIdx < floorActs.length; aIdx++) {
            const ln = floorActs[aIdx].line || 1;
            if (ln > maxUsedLine) maxUsedLine = ln;
          }
          const configuredLines = grp.linesPerFloor || defaultLinesPerFloor || 5;
          const linesCount = Math.max(1, Math.min(12, Math.max(configuredLines, maxUsedLine)));
          const rowHeight = linesCount * SUB_LINE_HEIGHT + FLOOR_PADDING_Y;

          floorGeometryMap.set(flr.id, {
            top: currentTop,
            height: rowHeight,
            linesCount,
            floor: flr,
            hasGroup: true,
          });
          currentTop += rowHeight;
          groupTotalHeight += rowHeight;
        }

        groupHeaderGeometries.push({
          group: grp,
          top: groupStartTop,
          height: groupTotalHeight,
          floorCount: grpFloors.length,
          isCollapsed: false,
          sortOrder,
        });
      }
    }

    // Pavimentos avulsos sem grupo (se existirem)
    const ungroupedFloors = orderedFloors.filter(
      (f) => !f.replicationGroupId || !groupMap.has(f.replicationGroupId)
    );
    for (let fIdx = 0; fIdx < ungroupedFloors.length; fIdx++) {
      const flr = ungroupedFloors[fIdx];
      if (hideEmptyFloors && !activitiesByFloorMap.has(flr.id)) continue;
      const floorActs = activitiesByFloorMap.get(flr.id) || [];
      let maxUsedLine = 1;
      for (let aIdx = 0; aIdx < floorActs.length; aIdx++) {
        const ln = floorActs[aIdx].line || 1;
        if (ln > maxUsedLine) maxUsedLine = ln;
      }
      const linesCount = Math.max(1, Math.min(12, Math.max(defaultLinesPerFloor || 5, maxUsedLine)));
      const rowHeight = linesCount * SUB_LINE_HEIGHT + FLOOR_PADDING_Y;
      floorGeometryMap.set(flr.id, {
        top: currentTop,
        height: rowHeight,
        linesCount,
        floor: flr,
        hasGroup: false,
      });
      currentTop += rowHeight;
    }

    const barRects = new Map<
      string,
      {
        activity: LobActivity;
        left: number;
        width: number;
        top: number;
        height: number;
        color: string;
        pkgName: string;
        gapWithPrev: number;
      }
    >();

    for (let i = 0; i < filteredActivities.length; i++) {
      const act = filteredActivities[i];
      const fGeo = floorGeometryMap.get(act.floorId);
      if (!fGeo) continue;
      const pkg = serviceMap.get(act.serviceId);

      const startOffsetDays = diffCalendarDays(timelineBounds.minDate, act.start);
      const spanCalendarDays = Math.max(1, diffCalendarDays(act.start, act.end) + 1);

      const left = Math.max(0, startOffsetDays * dayWidth);
      const width = Math.max(dayWidth, spanCalendarDays * dayWidth);
      const lineIdx = Math.max(0, Math.min(fGeo.linesCount - 1, (act.line || 1) - 1));
      const top = fGeo.top + 5 + lineIdx * SUB_LINE_HEIGHT;

      barRects.set(act.id, {
        activity: act,
        left,
        width,
        top,
        height: SUB_LINE_HEIGHT - 4,
        color: pkg?.color || '#1A665B',
        pkgName: pkg?.name || 'SERVIÇO',
        gapWithPrev: 9999,
      });
    }

    // Calcula a distância horizontal para a atividade anterior na mesma linha para evitar colisão visual
    const lineBuckets = new Map<string, { id: string; left: number; width: number }[]>();
    for (const [id, bar] of barRects.entries()) {
      const key = `${bar.activity.floorId}||${bar.activity.line || 1}`;
      const bucket = lineBuckets.get(key) || [];
      bucket.push({ id, left: bar.left, width: bar.width });
      lineBuckets.set(key, bucket);
    }

    for (const bucket of lineBuckets.values()) {
      bucket.sort((a, b) => a.left - b.left);
      for (let bIdx = 1; bIdx < bucket.length; bIdx++) {
        const prev = bucket[bIdx - 1];
        const curr = bucket[bIdx];
        const gap = curr.left - (prev.left + prev.width);
        const bar = barRects.get(curr.id);
        if (bar) bar.gapWithPrev = gap;
      }
    }

    return {
      totalHeight: Math.max(320, currentTop),
      floorGeometryMap,
      groupHeaderGeometries,
      barRects,
    };
  }, [
    orderedGroups,
    orderedFloors,
    selectedGroupFilter,
    hideEmptyFloors,
    collapsedGroups,
    groupSortOrders,
    globalFloorSortOrder,
    filteredActivities,
    activitiesByFloorMap,
    serviceMap,
    timelineBounds.minDate,
    dayWidth,
    subLineHeight,
    defaultLinesPerFloor,
  ]);

  const todayOffsetPx = useMemo(() => {
    const today = getTodayISO();
    const diff = diffCalendarDays(timelineBounds.minDate, today);
    if (diff < 0 || diff > timelineBounds.totalDays) return null;
    return diff * dayWidth;
  }, [timelineBounds.minDate, timelineBounds.totalDays, dayWidth]);

  // Setas SVG limitadas de forma inteligente para rolagem 60fps
  const dependencyPaths = useMemo(() => {
    if (!showDependencyArrows && !showCriticalPath && !selectedActivityId) return [];
    const criticalSet = new Set(graphAnalysis.criticalPathIds);
    const MAX_SVG_PATHS = 250;
    const paths: {
      key: string;
      d: string;
      isCritical: boolean;
      isHighlighted: boolean;
    }[] = [];

    for (let i = 0; i < filteredActivities.length; i++) {
      if (paths.length >= MAX_SVG_PATHS) break;
      const act = filteredActivities[i];
      const preds = act.predecessorIds;
      if (!preds || preds.length === 0) continue;

      const isActSelected = selectedActivityId === act.id;
      const isActCritical = criticalSet.has(act.id);

      // Filtra rápido antes de calcular geometria SVG
      if (!showDependencyArrows && !isActSelected && !(showCriticalPath && isActCritical)) {
        // Verifica se alguma predecessora é a selecionada
        if (!selectedActivityId || !preds.includes(selectedActivityId)) continue;
      }

      const targetRect = layoutGeometry.barRects.get(act.id);
      if (!targetRect) continue;

      for (let j = 0; j < preds.length; j++) {
        if (paths.length >= MAX_SVG_PATHS) break;
        const predId = preds[j];
        const isPairSelected = isActSelected || selectedActivityId === predId;
        const isPairCritical = isActCritical && criticalSet.has(predId);

        if (!showDependencyArrows && !isPairSelected && !(showCriticalPath && isPairCritical)) {
          continue;
        }

        const predRect = layoutGeometry.barRects.get(predId);
        if (!predRect) continue;

        const startX = predRect.left + predRect.width;
        const startY = predRect.top + predRect.height / 2;
        const endX = targetRect.left;
        const endY = targetRect.top + targetRect.height / 2;

        const midX = startX + (endX - startX) / 2;
        const d =
          endX >= startX - 4
            ? `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
            : `M ${startX} ${startY} L ${startX + 10} ${startY} L ${startX + 10} ${(startY + endY) / 2} L ${endX - 10} ${(startY + endY) / 2} L ${endX - 10} ${endY} L ${endX} ${endY}`;

        paths.push({
          key: `${predId}->${act.id}`,
          d,
          isCritical: isPairCritical,
          isHighlighted: isPairSelected,
        });
      }
    }

    return paths;
  }, [
    showDependencyArrows,
    showCriticalPath,
    selectedActivityId,
    graphAnalysis.criticalPathIds,
    filteredActivities,
    layoutGeometry.barRects,
  ]);

  // Paginação da Tabela EAP / Gantt
  const totalTablePages = Math.max(1, Math.ceil(filteredActivities.length / TABLE_PAGE_SIZE));
  const paginatedTableActivities = useMemo(() => {
    const safePage = Math.min(tablePage, totalTablePages - 1);
    const startIdx = safePage * TABLE_PAGE_SIZE;
    return filteredActivities.slice(startIdx, startIdx + TABLE_PAGE_SIZE);
  }, [filteredActivities, tablePage, totalTablePages]);

  // Filtro de locais no modal de Locais
  const filteredModalFloors = useMemo(() => {
    const q = floorSearchModal.trim().toLowerCase();
    if (!q) return orderedFloors;
    return orderedFloors.filter((f) => f.name.toLowerCase().includes(q));
  }, [orderedFloors, floorSearchModal]);

  return (
    <div className="space-y-4">
      {versionsBusy && <p role="status" className="text-sm text-slate-600">Processando histórico de versões…</p>}
      {versionsError && !isVersionModalOpen && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{versionsError}</p>}
      {/* BARRA SUPERIOR: Seletor de Visão + KPIs do Longo Prazo + Sincronização */}
      <div className="bg-white p-4 sm:p-5 rounded-2xl shadow-md border border-slate-200 flex flex-col gap-4">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          {!hideSubNav && (
            <div className="flex flex-wrap items-center gap-1.5 bg-slate-100 p-1.5 rounded-xl border border-slate-200">
              <button
                type="button"
                onClick={() => setSubView('lob')}
                className={`px-3.5 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 ${
                  subView === 'lob'
                    ? 'bg-emerald-800 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                <span>📐</span> Linha de Balanço (Longo Prazo)
              </button>
              <button
                type="button"
                onClick={() => {
                  setTablePage(0);
                  setSubView('table');
                }}
                className={`px-3.5 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 ${
                  subView === 'table'
                    ? 'bg-emerald-800 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                <span>📋</span> Gantt
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-black/15">
                  {projectStats.totalJobsCount}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setSubView('budget')}
                className={`px-3.5 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 ${
                  subView === 'budget'
                    ? 'bg-emerald-800 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                <span>💰</span> Orçamento & Vínculos
              </button>
              <button
                type="button"
                onClick={() => setSubView('physical_financial')}
                className={`px-3.5 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 ${
                  subView === 'physical_financial'
                    ? 'bg-emerald-800 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                <span>📊</span> Físico-Financeiro & Replanejamento
              </button>
              <button
                type="button"
                onClick={() => setSubView('competence_cash')}
                className={`px-3.5 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 ${
                  subView === 'competence_cash'
                    ? 'bg-emerald-800 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                <span>💵</span> Competência & Caixa
              </button>
              <button
                type="button"
                onClick={() => setSubView('import')}
                className={`px-3.5 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 ${
                  subView === 'import'
                    ? 'bg-emerald-800 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white hover:text-slate-900'
                }`}
              >
                <span>📥</span> Importar / Exportar Planilha
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto justify-between lg:justify-end">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-[9px] font-black uppercase text-slate-400 block">Horizonte da Obra</span>
                <span className="font-mono font-bold text-slate-800">
                  {formatDateBRShort(projectStats.minStart)} → {formatDateBRShort(projectStats.maxEnd)}
                </span>
                {projectStats.workingDaysSpan > 0 && (
                  <span className="ml-1.5 text-[10px] font-bold text-emerald-700">
                    ({projectStats.workingDaysSpan}d úteis)
                  </span>
                )}
              </div>

              <div className="px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-[9px] font-black uppercase text-slate-400 block">Orçamento / Peso</span>
                <span className="font-mono font-bold text-emerald-700">
                  R$ {projectStats.totalCost.toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
                </span>
              </div>

              <div className="px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200">
                <span className="text-[9px] font-black uppercase text-slate-400 block">Avanço Físico</span>
                <span className="font-mono font-black text-indigo-700">{projectStats.overallProgress}%</span>
              </div>

              {graphAnalysis.hasCycle && (
                <div className="px-3 py-1.5 rounded-xl bg-rose-50 border border-rose-300 text-rose-700 font-black text-[11px] flex items-center gap-1">
                  ⚠️ Dependência Circular ({graphAnalysis.cycleActivityIds.length})
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {onOpenImportModal && (
                <button
                  type="button"
                  onClick={onOpenImportModal}
                  className="px-3 py-2 rounded-xl bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 cursor-pointer shadow-xs"
                  title="Abrir o assistente inteligente de importação de cronograma (.xlsx / .csv)"
                >
                  <span>📥</span> Importar .XLSX
                </button>
              )}

              <button
                type="button"
                onClick={handleExportToExcel}
                disabled={activeState.activities.length === 0}
                className="px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-black uppercase tracking-wider transition disabled:opacity-40"
              >
                📤 Exportar .XLSX
              </button>

              <button
                type="button"
                onClick={handleQuickStartVerticalBuilding}
                className="px-3 py-2 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-800 text-xs font-black uppercase tracking-wider transition flex items-center gap-1.5 cursor-pointer shadow-xs active:scale-95"
                title="⚡ Gerar Obra Vertical Padrão (Modelo 1 Clique)"
              >
                <span>⚡</span> Gerar Obra
              </button>

              <button
                type="button"
                disabled={isSaving}
                onClick={() => persistStateToApp(activeState)}
                className={`px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider transition shadow-sm flex items-center gap-2 ${
                  hasUnsavedChanges
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white ring-2 ring-emerald-300'
                    : 'bg-slate-900 hover:bg-slate-800 text-white'
                }`}
              >
                <span>💾</span>
                {isSaving
                  ? 'Sincronizando...'
                  : hasUnsavedChanges
                  ? 'Salvar e Aplicar no Curto Prazo *'
                  : 'Sincronizado com Curto Prazo'}
              </button>
            </div>
          </div>
        </div>

        {/* BARRA DE FERRAMENTAS DE ENGENHARIA */}
        {(subView === 'lob' || subView === 'table') && (
          <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveModal('calendar')}
                className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold flex items-center gap-1.5 transition"
              >
                <span>📅</span> 1. Calendário
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!seqGroupId && activeState.replicationGroups[0]) {
                    setSeqGroupId(activeState.replicationGroups[0].id);
                  }
                  setActiveModal('floors');
                }}
                className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold flex items-center gap-1.5 transition"
              >
                <span>🏢</span> 2. Locais / Pavimentos ({activeState.floors.length})
              </button>
              <button
                type="button"
                onClick={() => setIsMacroflowModalOpen(true)}
                className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-indigo-50 to-emerald-50 hover:from-indigo-100 hover:to-emerald-100 text-slate-900 border border-indigo-200 text-xs font-black flex items-center gap-1.5 transition shadow-xs active:scale-95"
                title="Mapeamento de Processos: definir pacotes da esquerda para a direita, conexões inter-raias e ritmos"
              >
                <span>🔀</span> 3. Criar Macrofluxo
              </button>
              <button
                type="button"
                onClick={() => {
                  setPaceFloorIds(orderedFloors.map((f) => f.id));
                  setPaceServiceIds(activeState.services.map((s) => s.id));
                  setPaceStartDate(activeState.calendar.startDate || getTodayISO());
                  setActiveModal('pace');
                }}
                className="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 text-xs font-black flex items-center gap-1.5 transition"
              >
                <span>⚡</span> 4. Lançar Escadinha / Ritmo
              </button>
              <button
                type="button"
                onClick={() => openServiceModal()}
                className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold flex items-center gap-1.5 transition"
              >
                <span>📦</span> Pacotes ({activeState.services.length})
              </button>
              <button
                type="button"
                onClick={() => openActivityDialog({})}
                disabled={activeState.floors.length === 0 || activeState.services.length === 0}
                className="px-3.5 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-black flex items-center gap-1.5 transition disabled:opacity-40"
              >
                <span>➕</span> Nova Atividade
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  updateLobScheduleDates((prev) => prev, true);
                }}
                className="px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold flex items-center gap-1 transition"
                title="Puxar atividades dependentes para o mais cedo permitido pelas predecessoras"
              >
                🧲 Retirar Folgas
              </button>

              <button
                type="button"
                onClick={() => setShowCriticalPath((v) => !v)}
                className={`px-3 py-1.5 rounded-xl border text-xs font-black flex items-center gap-1 transition ${
                  showCriticalPath
                    ? 'bg-rose-600 text-white border-rose-700'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                🔥 Caminho Crítico ({graphAnalysis.criticalPathIds.length})
              </button>

              <button
                type="button"
                onClick={() => setShowDependencyArrows((v) => !v)}
                className={`px-3 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1 transition ${
                  showDependencyArrows
                    ? 'bg-indigo-50 text-indigo-800 border-indigo-200'
                    : 'bg-white text-slate-600 border-slate-200'
                }`}
              >
                🔗 {showDependencyArrows ? 'Ocultar Todas as Setas' : 'Mostrar Todas as Setas'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* =====================================================================
          SUB-VISÃO 1: LINHA DE BALANÇO INTERATIVA (LOB CANVAS)
         ===================================================================== */}
      {subView === 'lob' && (
        <div className="bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="🔍 Buscar pacote, pavimento, equipe..."
                  className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs w-56 focus:ring-2 focus:ring-emerald-500 outline-none"
                />

                <select
                  value={selectedGroupFilter}
                  onChange={(e) => setSelectedGroupFilter(e.target.value)}
                  className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                >
                  <option value="">Todos os Agrupamentos</option>
                  {orderedGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>

                <select
                  value={selectedTeamFilter}
                  onChange={(e) => setSelectedTeamFilter(e.target.value)}
                  className="px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700"
                >
                  <option value="">Todas as Equipes</option>
                  {Array.from(
                    new Set([
                      ...(teams || []),
                      ...activeState.activities.map((a) => a.responsible),
                    ])
                  )
                    .filter(Boolean)
                    .map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                </select>

                <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600 cursor-pointer ml-1">
                  <input
                    type="checkbox"
                    checked={hideEmptyFloors}
                    onChange={(e) => setHideEmptyFloors(e.target.checked)}
                    className="rounded text-emerald-600"
                  />
                  Ocultar locais vazios
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* SELETOR EM FORMATO PILL: VERSÃO ATIVA, TIPO, DROPDOWN E BOTÃO + */}
                <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl p-1 text-xs shadow-2xs">
                  <span className="text-[10px] font-black uppercase text-slate-400 pl-1.5">Versão:</span>
                  <button
                    type="button"
                    onClick={() => setIsVersionDrawerOpen(true)}
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

                  <button
                    type="button"
                    onClick={() => {
                      setVerNameInput(`Revisão 0${scheduleVersions.length + 1}`);
                      setVerDescInput('');
                      setVerIsBaselineCheck(false);
                      setVerTypeInput('forecast');
                      setIsVersionModalOpen(true);
                    }}
                    className="w-7 h-7 flex items-center justify-center rounded-lg bg-slate-100 hover:bg-emerald-600 hover:text-white text-slate-700 font-black text-sm transition cursor-pointer shadow-2xs"
                    title="Criar nova versão, cenário ou baseline"
                  >
                    +
                  </button>
                </div>

                {/* TOGGLE LINHA DE BASE FANTASMA */}
                <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600 cursor-pointer bg-white border border-slate-200 px-2.5 py-1.5 rounded-xl select-none">
                  <input
                    type="checkbox"
                    checked={showGhostBaseline}
                    onChange={(e) => {
                      setShowGhostBaseline(e.target.checked);
                      try {
                        localStorage.setItem(`curtoprazo_lob_ghost_${selectedProjectId || 'global'}`, String(e.target.checked));
                      } catch (_) {}
                    }}
                    className="rounded text-amber-600 focus:ring-0 cursor-pointer"
                  />
                  <span>Linha de Base Fantasma</span>
                </label>

                <div className="flex items-center bg-white border border-slate-200 rounded-xl p-0.5 text-[11px] font-black">
                  {(['day', 'week', 'month'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => handleZoomModeChange(m)}
                      className={`px-2.5 py-1 rounded-lg uppercase transition ${
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
                    max={32}
                    step={1}
                    value={dayWidth}
                    onChange={(e) => setDayWidth(Number(e.target.value))}
                    className="w-20 accent-emerald-700 cursor-pointer"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setActiveModal('display_settings')}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl text-xs font-black text-slate-700 shadow-sm transition active:scale-95"
                  title="Configurar Linhas por Pavimento, Pacotes de Trabalho e Alturas"
                >
                  <span className="text-sm">⚙️</span>
                  <span className="hidden sm:inline">Configurações</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsMaximized((prev) => !prev)}
                  className={`flex items-center gap-1 px-2.5 py-1.5 border rounded-xl text-xs font-black transition active:scale-95 ${
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

            {/* Barra Enxuta de Pacotes: Ocupa apenas 1 linha e mantém a tela 100% aproveitada */}
            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200/60 text-xs">
              {selectedServiceFilter ? (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black uppercase text-slate-400">Filtro de Pacote Ativo:</span>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 text-white text-xs font-bold shadow-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{
                        backgroundColor: serviceMap.get(selectedServiceFilter)?.color || '#10B981',
                      }}
                    />
                    <span>{serviceMap.get(selectedServiceFilter)?.name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedServiceFilter('')}
                      className="ml-1 text-slate-400 hover:text-white font-black text-xs leading-none"
                      title="Remover filtro de pacote"
                    >
                      &times;
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveModal('display_settings')}
                    className="text-[11px] text-emerald-700 hover:underline font-bold"
                  >
                    Trocar pacotes (⚙️)
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between w-full text-[11px] text-slate-500">
                  <span className="text-[10px] text-slate-400 font-bold uppercase">
                    Exibindo todos os {activeState.services.length} pacotes de trabalho
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveModal('display_settings')}
                    className="text-emerald-700 hover:underline font-bold flex items-center gap-1"
                  >
                    <span>⚙️ Configurar linhas por pavimento & pacotes</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* SPLIT CANVAS DA LINHA DE BALANÇO: Altura total e cabeçalho congelado */}
          <div
            className={`relative overflow-auto select-none will-change-scroll border border-slate-300 rounded-xl shadow-inner bg-slate-100/50 ${
              isMaximized
                ? 'h-[calc(100vh-190px)] min-h-[600px]'
                : 'h-[calc(100vh-270px)] min-h-[580px]'
            }`}
          >
            <div
              className="flex min-w-max"
              style={{
                width: 240 + timelineBounds.totalDays * dayWidth,
              }}
            >
              {/* COLUNA ESQUERDA FIXA (EIXO Y: AGRUPAMENTOS & LOCAIS) */}
              <div className="w-[240px] shrink-0 sticky left-0 z-20 bg-white border-r border-slate-300 shadow-sm">
                <div className="h-[74px] sticky top-0 left-0 z-40 bg-slate-900 text-white px-3 flex items-center justify-between border-b border-slate-700 shadow-md">
                  <div>
                    <div className="text-[10px] font-black uppercase tracking-wider text-emerald-400">
                      Eixo Y — Locais
                    </div>
                    <div className="text-xs font-bold text-slate-200">
                      {orderedFloors.length} Pavimentos
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const newOrder = globalFloorSortOrder === 'asc' ? 'desc' : 'asc';
                        setGlobalFloorSortOrder(newOrder);
                        const newOrders: Record<string, 'asc' | 'desc'> = {};
                        orderedGroups.forEach((g) => {
                          newOrders[g.id] = newOrder;
                        });
                        setGroupSortOrders(newOrders);
                      }}
                      title={
                        globalFloorSortOrder === 'asc'
                          ? 'Inverter todos os pavimentos: Decrescente (⬇️)'
                          : 'Inverter todos os pavimentos: Crescente (⬆️)'
                      }
                      className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-[10px] font-bold flex items-center gap-1 text-slate-200 cursor-pointer"
                    >
                      {globalFloorSortOrder === 'asc' ? '⬆️ Cima' : '⬇️ Baixo'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveModal('floors')}
                      className="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-[10px] font-black uppercase cursor-pointer"
                    >
                      + Local
                    </button>
                  </div>
                </div>

                <div className="relative" style={{ height: layoutGeometry.totalHeight }}>
                  {/* Grupos / Macro Lotes: Se aberto, coluna vertical à esquerda com texto girado 90° para cima; se fechado, linha horizontal */}
                  {layoutGeometry.groupHeaderGeometries.map((item) => {
                    const { group, top, height, floorCount, isCollapsed, sortOrder } = item;
                    if (isCollapsed) {
                      return (
                        <div
                          key={`grp_col_${group.id}`}
                          style={{ top, height, backgroundColor: group.color || '#E2E8F0' }}
                          onClick={() => toggleGroupCollapse(group.id)}
                          className="absolute left-0 right-0 px-3 flex items-center justify-between border-b border-slate-300 cursor-pointer hover:brightness-95 transition z-10"
                        >
                          <span className="text-[10px] font-black uppercase tracking-wider text-slate-800 truncate">
                            ▶ {group.name}
                          </span>
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/10 text-slate-700">
                            {floorCount} loc.
                          </span>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={`grp_vert_${group.id}`}
                        style={{
                          top,
                          height,
                          width: 36,
                          backgroundColor: group.color || '#E2E8F0',
                        }}
                        className="absolute left-0 border-r border-b border-slate-300 flex flex-col items-center justify-between py-1.5 select-none z-10 shadow-xs hover:brightness-95 transition"
                      >
                        {/* Botão de Fechar / Recolher */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleGroupCollapse(group.id);
                          }}
                          title="Recolher macro lote"
                          className="w-5 h-5 rounded hover:bg-black/15 flex items-center justify-center text-slate-800 font-black text-[10px] cursor-pointer"
                        >
                          ▼
                        </button>

                        {/* Nome do Grupo Girado 90 graus (para cima) */}
                        <div
                          className="flex items-center justify-center font-black uppercase tracking-wider text-[10px] text-slate-800 select-none truncate cursor-pointer"
                          style={{
                            writingMode: 'vertical-rl',
                            transform: 'rotate(180deg)',
                            maxHeight: Math.max(20, height - 56),
                          }}
                          onClick={() => toggleGroupCollapse(group.id)}
                          title={`${group.name} (${floorCount} pavimentos) - Clique para recolher`}
                        >
                          {group.name}
                        </div>

                        {/* Botão de Ordenar: Classificar para Cima (⬆️) / Classificar para Baixo (⬇️) */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleGroupSort(group.id);
                          }}
                          title={
                            sortOrder === 'asc'
                              ? 'Classificar para Baixo (Inverter ordem dos pavimentos)'
                              : 'Classificar para Cima (Inverter ordem dos pavimentos)'
                          }
                          className="w-5 h-5 rounded hover:bg-black/15 flex items-center justify-center text-slate-800 font-black text-[11px] cursor-pointer"
                        >
                          {sortOrder === 'asc' ? '⬆️' : '⬇️'}
                        </button>
                      </div>
                    );
                  })}

                  {/* Lista de Pavimentos */}
                  {Array.from(layoutGeometry.floorGeometryMap.values()).map(({ floor, top, height, hasGroup }, floorIdx) => {
                    const isZebra = enableZebraBands && floorIdx % 2 === 1;
                    return (
                      <div
                        key={floor.id}
                        style={{
                          top,
                          height,
                          left: hasGroup ? 36 : 0,
                          right: 0,
                          borderBottomWidth: `${gridHorizontalWidth}px`,
                          borderBottomColor: gridHorizontalColor,
                          borderBottomStyle: gridHorizontalStyle,
                        }}
                        className={`absolute px-3 flex items-center justify-between group transition-colors ${
                          isZebra ? 'bg-slate-50/90' : 'bg-white'
                        } hover:bg-slate-100`}
                      >
                        <div className="truncate pr-1">
                          <div className="text-xs font-bold text-slate-800 truncate" title={floor.name}>
                            {floor.name}
                          </div>
                          {floor.area && (
                            <div className="text-[9px] font-mono text-slate-400">{floor.area} m²</div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => openActivityDialog({ defaultFloorId: floor.id })}
                          title={`Adicionar atividade em ${floor.name}`}
                          className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-[10px] font-black cursor-pointer"
                        >
                          + Ativ.
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ÁREA DIREITA (EIXO X: TIMELINE + CANVAS 2D) */}
              <div
                className="relative"
                style={{ width: timelineBounds.totalDays * dayWidth }}
              >
                {/* CABEÇALHO COM 3 LINHAS: MÊS, SEMANA E DIA (STQQSD) */}
                <div className="h-[74px] sticky top-0 z-30 bg-slate-800 text-white border-b border-slate-700 flex flex-col shadow-md select-none">
                  {/* Linha 1: Mês e Ano */}
                  <div className="flex h-[26px] border-b border-slate-700 bg-slate-900/90">
                    {timelineBounds.months.map((m) => (
                      <div
                        key={m.key}
                        style={{ width: m.count * dayWidth }}
                        className="shrink-0 border-r-2 border-slate-600 px-2 flex items-center text-[10px] font-black uppercase tracking-wider text-slate-200 truncate"
                      >
                        {m.label}
                      </div>
                    ))}
                  </div>

                  {/* Linha 2: Semanas */}
                  <div className="flex h-[24px] border-b border-slate-700/80 bg-slate-850">
                    {timelineBounds.weeks.map((w) => (
                      <div
                        key={w.key}
                        style={{ width: w.count * dayWidth }}
                        className="shrink-0 border-r border-slate-700/80 px-1 flex items-center justify-center text-[9px] font-mono font-semibold text-slate-300 truncate"
                      >
                        {w.count * dayWidth >= 28 ? w.label : ''}
                      </div>
                    ))}
                  </div>

                  {/* Linha 3: Dias (Configurável: Ambos, Número ou Inicial) */}
                  <div className="flex h-[24px] bg-slate-800">
                    {timelineBounds.days.map((d) => (
                      <div
                        key={d.date}
                        style={{ width: dayWidth }}
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
                        {lobDayFormat === 'day_number' ? (
                          dayWidth >= 10 ? (
                            <span className="leading-none text-[8px] font-mono font-bold text-slate-200">{d.dayOfMonth}</span>
                          ) : null
                        ) : lobDayFormat === 'day_letter' ? (
                          dayWidth >= 6 ? (
                            <span className="leading-none font-bold">{d.letter}</span>
                          ) : null
                        ) : (
                          <>
                            {dayWidth >= 20 && (
                              <span className="text-[7px] text-slate-400 leading-none mb-0.5">{d.dayOfMonth}</span>
                            )}
                            {dayWidth >= 6 ? (
                              <span className="leading-none">{d.letter}</span>
                            ) : null}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div
                  className="relative bg-white"
                  style={{
                    height: layoutGeometry.totalHeight,
                    width: timelineBounds.totalDays * dayWidth,
                  }}
                  onClick={() => {
                    setSelectedActivityId(null);
                    if (isActivityDrawerOpen) {
                      setIsActivityDrawerOpen(false);
                      setEditingActivity(null);
                    }
                  }}
                >
                  {/* GRID DE COLUNAS DE DIAS (Fundo com dias úteis/não úteis e divisores de mês) */}
                  <div className="absolute inset-0 flex pointer-events-none z-0">
                    {timelineBounds.days.map((d) => (
                      <div
                        key={`grid_day_${d.date}`}
                        style={{
                          width: dayWidth,
                          borderRightWidth: d.isEndOfMonth
                            ? `${Math.max(2, gridVerticalWidth + 1)}px`
                            : `${gridVerticalWidth}px`,
                          borderRightColor: d.isEndOfMonth ? '#475569' : gridVerticalColor,
                          borderRightStyle: d.isEndOfMonth ? 'solid' : gridVerticalStyle,
                        }}
                        className={`shrink-0 h-full ${
                          !d.isWorking ? 'bg-slate-100/90' : 'bg-transparent'
                        }`}
                      />
                    ))}
                  </div>

                  {/* Grupos fechados: renderiza linha cinza de 32px apenas se estiver recolhido */}
                  {layoutGeometry.groupHeaderGeometries.map((item) => {
                    if (!item.isCollapsed) return null;
                    return (
                      <div
                        key={`canvas_grp_${item.group.id}`}
                        style={{ top: item.top, height: item.height }}
                        className="absolute left-0 right-0 bg-slate-100/90 border-b border-slate-300 pointer-events-none"
                      />
                    );
                  })}

                  {Array.from(layoutGeometry.floorGeometryMap.values()).map(({ floor, top, height }, floorIdx) => {
                    const isZebra = enableZebraBands && floorIdx % 2 === 1;
                    return (
                      <div
                        key={floor.id}
                        style={{
                          top,
                          height,
                          borderBottomWidth: `${gridHorizontalWidth}px`,
                          borderBottomColor: gridHorizontalColor,
                          borderBottomStyle: gridHorizontalStyle,
                        }}
                        onClick={() => {
                          if (isActivityDrawerOpen) {
                            setIsActivityDrawerOpen(false);
                            setEditingActivity(null);
                            setSelectedActivityId(null);
                          }
                        }}
                        onDoubleClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const clickX = e.clientX - rect.left;
                          const dayOffset = Math.max(0, Math.floor(clickX / dayWidth));
                          const clickedDate = addCalendarDays(timelineBounds.minDate, dayOffset);
                          openActivityDialog({
                            defaultFloorId: floor.id,
                            defaultStartDate: clickedDate,
                          });
                        }}
                        className={`absolute left-0 right-0 ${
                          isZebra ? 'bg-slate-50/50' : 'bg-transparent'
                        }`}
                      />
                    );
                  })}

                  {todayOffsetPx !== null && (
                    <div
                      style={{ left: todayOffsetPx }}
                      className="absolute top-0 bottom-0 w-[2px] bg-rose-500/80 z-10 pointer-events-none"
                    >
                      <span className="px-1.5 py-0.5 bg-rose-600 text-white text-[8px] font-black uppercase rounded-r">
                        Hoje
                      </span>
                    </div>
                  )}

                  {dependencyPaths.length > 0 && (
                    <svg
                      className="absolute inset-0 pointer-events-none z-10"
                      width={timelineBounds.totalDays * dayWidth}
                      height={layoutGeometry.totalHeight}
                    >
                      <defs>
                        <marker
                          id="lob-arrow-normal"
                          viewBox="0 0 10 10"
                          refX="8"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748B" />
                        </marker>
                        <marker
                          id="lob-arrow-critical"
                          viewBox="0 0 10 10"
                          refX="8"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#E11D48" />
                        </marker>
                        <marker
                          id="lob-arrow-highlight"
                          viewBox="0 0 10 10"
                          refX="8"
                          refY="5"
                          markerWidth="6"
                          markerHeight="6"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 1 L 10 5 L 0 9 z" fill="#0F766E" />
                        </marker>
                      </defs>

                      {dependencyPaths.map((p) => {
                        const stroke =
                          showCriticalPath && p.isCritical
                            ? '#E11D48'
                            : p.isHighlighted
                            ? '#0F766E'
                            : '#94A3B8';
                        const marker =
                          showCriticalPath && p.isCritical
                            ? 'url(#lob-arrow-critical)'
                            : p.isHighlighted
                            ? 'url(#lob-arrow-highlight)'
                            : 'url(#lob-arrow-normal)';
                        return (
                          <path
                            key={p.key}
                            d={p.d}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={p.isHighlighted || (showCriticalPath && p.isCritical) ? 2.2 : 1.3}
                            markerEnd={marker}
                            opacity={p.isHighlighted || (showCriticalPath && p.isCritical) ? 0.95 : 0.6}
                          />
                        );
                      })}
                    </svg>
                  )}

                  {/* BARRAS FANTASMAS DA LINHA DE BASE (BASELINE) */}
                  {showGhostBaseline && Array.from(layoutGeometry.barRects.values()).map(
                    ({ activity, top, height }) => {
                      const baseAct = baselineTaskMap.get(activity.id);
                      if (!baseAct || !baseAct.start || !baseAct.end) return null;

                      const baseStartOffset = diffCalendarDays(timelineBounds.minDate, baseAct.start);
                      const baseSpanDays = Math.max(1, diffCalendarDays(baseAct.start, baseAct.end) + 1);
                      const bLeft = Math.max(0, baseStartOffset * dayWidth);
                      const bWidth = Math.max(dayWidth, baseSpanDays * dayWidth);

                      return (
                        <div
                          key={`ghost_base_${activity.id}`}
                          style={{
                            left: bLeft,
                            width: bWidth,
                            top: top - 2,
                            height: height + 4,
                          }}
                          title={`[Linha de Base]: ${formatDateBRShort(baseAct.start)} → ${formatDateBRShort(baseAct.end)} (${baseAct.duration}d úteis)`}
                          className="absolute pointer-events-none rounded border-2 border-dashed border-amber-500/70 bg-amber-400/10 z-5 select-none"
                        >
                          <span className="absolute -top-3.5 left-0.5 text-[8px] font-mono font-bold text-amber-800 bg-white/95 px-1 rounded shadow-2xs border border-amber-300">
                            Base: {formatDateBRShort(baseAct.start).slice(0, 5)}
                          </span>
                        </div>
                      );
                    }
                  )}

                  {/* BARRAS DE ATIVIDADES */}
                  {Array.from(layoutGeometry.barRects.values()).map(
                    ({ activity, left, width, top, height, color, pkgName, gapWithPrev }) => {
                      const isSelected = selectedActivityId === activity.id;
                      const isDraggingThis = dragState?.activityId === activity.id;
                      const dragOffsetLeft =
                        isDraggingThis && dragState.mode === 'move' ? dragState.previewDeltaPx : 0;
                      const dragOffsetWidth =
                        isDraggingThis && dragState.mode === 'resize'
                          ? Math.max(dayWidth - width, dragState.previewDeltaPx)
                          : 0;

                      const progressPct = Math.max(0, Math.min(100, Number(activity.progress) || 0));
                      const dateRangeLabel = formatLobDateRange(activity.start, activity.end);

                      return (
                        <div
                          key={activity.id}
                          data-activity-bar="true"
                          style={{
                            left: Math.max(0, left + dragOffsetLeft),
                            width: Math.max(dayWidth, width + dragOffsetWidth),
                            top,
                            height,
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            openActivityDialog({ activity });
                          }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            openActivityDialog({ activity });
                          }}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            setSelectedActivityId(activity.id);
                            setDragState({
                              activityId: activity.id,
                              mode: 'move',
                              initialX: e.clientX,
                              initialStart: activity.start,
                              initialDuration: activity.duration,
                              previewDeltaPx: 0,
                            });
                          }}
                          title={`${pkgName} — ${floorMap.get(activity.floorId)?.name || ''}\nInício: ${formatDateBRShort(activity.start)} | Fim: ${formatDateBRShort(activity.end)} (${activity.duration}d úteis)\nEquipe: ${activity.responsible} | Realizado: ${progressPct}%\n(1 clique para abrir painel lateral | Arraste para mover datas)`}
                          className="absolute cursor-grab active:cursor-grabbing flex items-center z-10 select-none"
                        >
                          {/* LADO ESQUERDO (FORA DO BOX): Data Início-Término no formato DD-DD/MM e Duração (Xd) */}
                          {/* Se houver atividade imediatamente anterior na mesma linha com espaço apertado, prioriza a visualização da tarefa anterior */}
                          {showLeftDateLabel && gapWithPrev >= 25 && (
                            <div
                              className="absolute right-full mr-1.5 top-1/2 -translate-y-1/2 whitespace-nowrap text-[9px] font-mono font-bold text-slate-700 bg-white/95 backdrop-blur-xs px-1.5 py-0.5 rounded border border-slate-200/80 shadow-xs pointer-events-none select-none flex items-center gap-1 z-0"
                            >
                              {gapWithPrev >= 85 ? (
                                <>
                                  <span>{dateRangeLabel}</span>
                                  {showDurationLabel && (
                                    <span className="text-slate-500 font-semibold">({activity.duration}d)</span>
                                  )}
                                </>
                              ) : showDurationLabel ? (
                                <span className="text-slate-600 font-semibold">({activity.duration}d)</span>
                              ) : (
                                <span>{dateRangeLabel}</span>
                              )}
                            </div>
                          )}

                          {/* RETÂNGULO DO PACOTE (CORPO COLORIDO DA ATIVIDADE) */}
                          <div
                            style={{ backgroundColor: color }}
                            className={`relative w-full h-full rounded-md overflow-hidden flex items-center px-1.5 text-white shadow-xs ${
                              isSelected ? 'ring-2 ring-amber-400 z-20' : ''
                            }`}
                          >
                            {/* Preenchimento do avanço físico já medido */}
                            {progressPct > 0 && (
                              <div
                                style={{ width: `${progressPct}%` }}
                                className="absolute left-0 top-0 bottom-0 bg-black/30 pointer-events-none border-r border-white/40"
                              />
                            )}

                            {/* Nome do pacote dentro do box */}
                            {showPackageNameInBar && (
                              <div className="relative z-10 truncate text-[10px] font-black leading-none">
                                <span className="truncate">{pkgName}</span>
                              </div>
                            )}

                            {/* Alça de redimensionamento na borda direita do box */}
                            <div
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setSelectedActivityId(activity.id);
                                setDragState({
                                  activityId: activity.id,
                                  mode: 'resize',
                                  initialX: e.clientX,
                                  initialStart: activity.start,
                                  initialDuration: activity.duration,
                                  previewDeltaPx: 0,
                                });
                              }}
                              title="Arraste a borda para alterar a duração (dias úteis)"
                              className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-white/40 z-20"
                            />
                          </div>

                          {/* LADO DIREITO (FORA DO BOX): Percentual Realizado */}
                          {showRightProgressLabel && (
                            <div
                              className={`absolute left-full ml-1.5 top-1/2 -translate-y-1/2 whitespace-nowrap text-[9px] font-mono font-black px-1.5 py-0.5 rounded border shadow-xs pointer-events-none select-none z-0 ${
                                progressPct === 100
                                  ? 'text-emerald-800 bg-emerald-50/95 border-emerald-300/80'
                                  : progressPct > 0
                                  ? 'text-indigo-800 bg-indigo-50/95 border-indigo-200/80'
                                  : 'text-slate-600 bg-white/95 border-slate-200/80'
                              }`}
                            >
                              {progressPct}%
                            </div>
                          )}
                        </div>
                      );
                    }
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="px-4 py-2.5 bg-slate-900 text-slate-300 text-xs flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3 text-[11px]">
              <span>💡 <strong>Clique numa barra</strong> para ver suas conexões</span>
              <span>•</span>
              <span><strong>Arraste</strong> para mover a data</span>
              <span>•</span>
              <span><strong>Duplo clique</strong> para editar sub-tarefas e predecessoras</span>
            </div>

            {selectedActivityId && layoutGeometry.barRects.get(selectedActivityId) && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-emerald-400">
                  Selecionada: {layoutGeometry.barRects.get(selectedActivityId)?.pkgName} (
                  {
                    floorMap.get(
                      layoutGeometry.barRects.get(selectedActivityId)!.activity.floorId
                    )?.name
                  }
                  )
                </span>
                <button
                  type="button"
                  onClick={() =>
                    openActivityDialog({
                      activity: layoutGeometry.barRects.get(selectedActivityId)!.activity,
                    })
                  }
                  className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-black uppercase"
                >
                  ✏️ Editar / Predecessoras
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          SUB-VISÃO 2: TABELA EAP / GANTT HÍBRIDA (PAGINADA PARA ZERO TRAVAMENTO)
         ===================================================================== */}
      {/* =====================================================================
          SUB-VISÃO 2: CRONOGRAMA GANTT & EAP (MODELO GANTTPLANO / NIZZA)
         ===================================================================== */}
      {subView === 'table' && (
        <div className="space-y-4 animate-in fade-in duration-200">
          <GanttPlannerView
            projectKey={selectedProjectId || 'global'}
            projectName={selectedProjectId ? `Projeto ${selectedProjectId}` : 'Obra Principal'}
            projectStartDate={activeState.calendar.startDate}
            activities={activeState.activities}
            floors={activeState.floors}
            services={activeState.services}
            replicationGroups={activeState.replicationGroups}
            calendar={activeState.calendar}
            cronogramaInicial={cronogramaInicial}
            scheduleVersions={scheduleVersions}
            currentActiveVersion={currentActiveVersion}
            baselineTaskMap={baselineTaskMap}
            showGhostBaseline={showGhostBaseline}
            onToggleGhostBaseline={(val) => {
              setShowGhostBaseline(val);
              try {
                localStorage.setItem(`curtoprazo_lob_ghost_${selectedProjectId || 'global'}`, String(val));
              } catch (_) {}
            }}
            onOpenVersionDrawer={() => setIsVersionDrawerOpen(true)}
            onCreateNewVersion={() => {
              setVerNameInput(`Revisão 0${scheduleVersions.length + 1}`);
              setVerDescInput('');
              setVerIsBaselineCheck(false);
              setVerTypeInput('forecast');
              setIsVersionModalOpen(true);
            }}
            onUpdateActivityDates={(activityId, newStart, newEnd, newDuration) => {
              updateLobScheduleDates((prev) => {
                const act = prev.activities.find((a) => a.id === activityId);
                if (!act) return prev;
                const pkg = serviceMap.get(act.serviceId);
                const updated = {
                  ...act,
                  start: newStart,
                  end: newEnd,
                  duration: newDuration,
                };
                const scaled = pkg ? syncActivityJobs(updated, pkg, prev.calendar, 'scale-to-activity') : updated;
                const nextActivities = prev.activities.map((a) => (a.id === activityId ? scaled : a));
                const nextState = { ...prev, activities: nextActivities };
                return propagateScheduleCascade(nextState, activityId, newStart, newDuration);
              }, false, true);
            }}
            onUpdateActivityProgress={async (activityId, newProgress) => {
              const updatedActivities = activeState.activities.map((a) =>
                a.id === activityId ? { ...a, progress: newProgress } : a
              );
              const nextState = { ...activeState, activities: updatedActivities };
              setLobState(nextState);
              await persistStateToApp(nextState);

              const act = activeState.activities.find((a) => a.id === activityId);
              if (act) {
                const flr = floorMap.get(act.floorId);
                const pkg = serviceMap.get(act.serviceId);
                const match = cronogramaInicial.find(
                  (c) =>
                    c.floor === flr?.name &&
                    (c.id === act.id || slugifySchedule(c.macro) === slugifySchedule(pkg?.name || ''))
                ) || { id: act.id, floor: flr?.name, macro: pkg?.name };
                onUpdateSingleItemProgress(match, newProgress);
              }
            }}
          />
        </div>
      )}

      {/* =====================================================================
          SUB-VISÃO: ORÇAMENTO & VÍNCULOS COM O CRONOGRAMA (PONDERAÇÃO)
         ===================================================================== */}
      {subView === 'budget' && (
        <div className="bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden min-h-[750px] animate-in fade-in duration-200">
          <BudgetLinkingView
            projectId={selectedProjectId || 'global'}
            projectName={selectedProjectId ? `Projeto ${selectedProjectId}` : 'Obra Principal'}
            activities={activeState.activities}
            floors={activeState.floors}
            services={activeState.services}
            replicationGroups={activeState.replicationGroups}
            existingWeights={weights}
            onBack={() => setSubView('lob')}
            onSaveWeightsAndCosts={(budgetState, updatedFloors) => {
              const { updatedActivities, updatedWeights } = applyBudgetWeightsToSchedule(
                budgetState,
                activeState.activities,
                updatedFloors || activeState.floors,
                activeState.services,
                weights
              );
              const nextState = {
                ...activeState,
                floors: updatedFloors || activeState.floors,
                activities: updatedActivities,
              };
              setLobState(nextState);
              setHasUnsavedChanges(true);

              const compiled = compileLobToCronograma(
                nextState,
                allFloorsData,
                updatedWeights,
                teams,
                matrices
              );
              onApplySchedule(
                compiled,
                'Ponderação de pesos e custos do orçamento aplicada com sucesso!'
              );
              setSubView('lob');
            }}
          />
        </div>
      )}

      {/* =====================================================================
          SUB-VISÃO: FÍSICO-FINANCEIRO & REPLANEJAMENTO (DISTRIBUIÇÃO N6, BASELINE EAP, MEDIÇÃO, CURVA S)
         ===================================================================== */}
      {subView === 'physical_financial' && (
        <PhysicalFinancialViews
          projectName={projectName}
          projectId={selectedProjectId || 'global'}
          budgetItems={
            getEffectiveBudgetState(
              selectedProjectId || 'global',
              activeState.activities,
              activeState.floors,
              activeState.services
            ).items
          }
          scheduleTasks={activeState.activities}
          currentSnapshot={{
            cronogramaInicial,
            floors,
            allFloorsData,
            weights,
          }}
          onApplyScheduleVersion={async (snapshot) => {
            const compiled = compileLobToCronograma(
              hydrateLobFromCronograma(snapshot.cronogramaInicial, snapshot.floors, snapshot.allFloorsData),
              snapshot.allFloorsData,
              snapshot.weights || weights,
              snapshot.teams || teams,
              snapshot.matrices || matrices
            );
            await onApplySchedule(compiled, 'Versão do cronograma ativada com sucesso!');
          }}
        />
      )}

      {/* =====================================================================
          SUB-VISÃO: COMPETÊNCIA E CAIXA TEÓRICOS (CONTÁBIL / NF vs FLUXO DE CAIXA)
         ===================================================================== */}
      {subView === 'competence_cash' && (
        <CompetenceCashViews
          projectId={selectedProjectId || 'global'}
          budgetItems={
            getEffectiveBudgetState(
              selectedProjectId || 'global',
              activeState.activities,
              activeState.floors,
              activeState.services
            ).items
          }
          calcResult={runPhysicalFinancialCalculation({
            budgetItems: getEffectiveBudgetState(
              selectedProjectId || 'global',
              activeState.activities,
              activeState.floors,
              activeState.services
            ).items,
            scheduleTasks: activeState.activities,
            cycleStartDay: 21,
            cycleEndDay: 20,
            cutoffMedNum: 1,
          })}
        />
      )}

      {/* =====================================================================
          SUB-VISÃO: ATIVIDADES DO CRONOGRAMA ATIVO (AUDITORIA / LISTA INTEGRADA)
         ===================================================================== */}
      {subView === 'raw_crono' && rawCronoSlot && (
        <div className="animate-in fade-in duration-200">
          {rawCronoSlot}
        </div>
      )}

      {/* =====================================================================
          SUB-VISÃO 3: IMPORTAR / EXPORTAR PLANILHA (.XLSX / .CSV)
         ===================================================================== */}
      {subView === 'import' && (
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h2 className="text-lg font-black text-indigo-900 uppercase tracking-tight mb-1">
                Importação e Exportação de Planilha (Prevision / Excel)
              </h2>
              <p className="text-xs text-slate-500">
                Importe uma planilha externa (.xlsx, .xls, .csv) ou exporte o planejamento criado na Linha de Balanço.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!previousBudgetImport}
                title={getBudgetImportTooltip(previousBudgetImport)}
                className="px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500 disabled:opacity-45"
              >
                Orçamento anterior
              </button>
              <button
                type="button"
                disabled={!currentBudgetImport}
                title={getBudgetImportTooltip(currentBudgetImport)}
                className="px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-[10px] font-black uppercase tracking-wider text-indigo-700 disabled:opacity-45"
              >
                Orçamento atual
              </button>
              <button
                type="button"
                onClick={onTriggerClearDB}
                className="px-4 py-2 bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 font-black rounded-xl text-xs uppercase tracking-wider transition"
              >
                🗑️ Limpar BD
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {onOpenImportModal ? (
              <div
                onClick={onOpenImportModal}
                className="border-2 border-dashed border-indigo-300 hover:border-indigo-600 rounded-2xl p-8 bg-indigo-50/40 hover:bg-indigo-50/70 flex flex-col items-center justify-center text-center cursor-pointer transition shadow-xs group"
              >
                <span className="text-4xl mb-2 group-hover:scale-110 transition-transform">📥</span>
                <p className="text-xs font-black text-indigo-950 uppercase tracking-tight">
                  Motor Inteligente de Importação (.XLSX / .CSV)
                </p>
                <p className="text-[11px] text-slate-500 mt-1 max-w-sm">
                  Detecção semântica de colunas, configuração de linhas de cabeçalho/dados e rastreabilidade com metadados.
                </p>
                <span className="mt-3 px-4 py-2 bg-indigo-600 group-hover:bg-indigo-700 text-white rounded-xl text-xs font-black uppercase tracking-wider transition">
                  Abrir Assistente de Importação
                </span>
              </div>
            ) : (
              <div className="border-2 border-dashed border-slate-300 rounded-2xl p-8 bg-slate-50 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500 transition relative">
                <input
                  type="file"
                  accept=".xlsx, .xls, .csv"
                  onChange={handleFileUpload}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <span className="text-4xl mb-2">📊</span>
                <p className="text-xs font-black text-slate-700 uppercase">
                  Clique ou Arraste sua Planilha Excel (.XLSX / .CSV)
                </p>
                <p className="text-[11px] text-slate-400 mt-1">
                  O cronograma importado será carregado automaticamente na Linha de Balanço e no Curto Prazo.
                </p>
              </div>
            )}

            <div className="border border-emerald-200 rounded-2xl p-8 bg-emerald-50/40 flex flex-col items-center justify-center text-center">
              <span className="text-4xl mb-2">📤</span>
              <p className="text-xs font-black text-emerald-950 uppercase">
                Exportar Planejamento da Linha de Balanço
              </p>
              <p className="text-[11px] text-slate-600 mt-1 mb-4">
                Gera uma planilha `.xlsx` estruturada com todos os pacotes, locais, serviços, datas, custos e predecessoras.
              </p>
              <button
                type="button"
                onClick={handleExportToExcel}
                disabled={activeState.activities.length === 0}
                className="px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs uppercase tracking-wider transition disabled:opacity-40"
              >
                Baixar Planilha .XLSX ({projectStats.totalJobsCount} serviços)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: CONFIGURAÇÕES DE EXIBIÇÃO, LINHAS E PACOTES (`display_settings`)
         ===================================================================== */}
      {activeModal === 'display_settings' && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden flex flex-col max-h-[92vh]">
            {/* CABEÇALHO DO MODAL */}
            <div className="p-4 bg-slate-900 text-white flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2.5">
                <span className="text-xl">⚙️</span>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-wider">
                    Configurações da Linha de Balanço
                  </h3>
                  <p className="text-[10px] text-slate-400">
                    Personalize linhas por pavimento, rótulos nas barras, linhas de grade (MS Project) e pacotes
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white font-bold text-lg px-2 rounded-lg hover:bg-slate-800 transition"
              >
                ✕
              </button>
            </div>

            {/* BARRA DE NAVEGAÇÃO DE ABAS */}
            <div className="flex border-b border-slate-200 bg-slate-50 px-3 pt-2 gap-1 shrink-0 overflow-x-auto select-none">
              {[
                { id: 'structure', label: '🏢 Estrutura & Ordem' },
                { id: 'timeline', label: '📅 Cabeçalho & Zoom' },
                { id: 'versions', label: '🏷️ Versões & Baseline' },
                { id: 'lines', label: '📏 Linhas & Alturas' },
                { id: 'labels', label: '🏷️ Textos & Rótulos' },
                { id: 'grid', label: '📐 Linhas de Grade' },
                { id: 'packages', label: '📦 Pacotes de Trabalho' },
                { id: 'options', label: '⚙️ Opções Avançadas' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDisplaySettingsTab(tab.id as any)}
                  className={`px-3 py-2 text-xs font-black uppercase tracking-wider rounded-t-xl transition border-t border-x whitespace-nowrap ${
                    displaySettingsTab === tab.id
                      ? 'bg-white border-slate-200 text-emerald-800 -mb-px shadow-xs'
                      : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="p-5 space-y-6 overflow-y-auto text-xs flex-1">
              {/* =========================================================
                  ABA: ESTRUTURA & ORDEM (REORDENAR LOTES-MÃE & CLASSIFICAÇÃO)
                 ========================================================= */}
              {displaySettingsTab === 'structure' && (
                <div className="space-y-5">
                  {/* Reordenar Lotes-Mãe (Macro Lotes) */}
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-black text-slate-800 uppercase text-xs">
                          🏢 Reordenar Lotes-Mãe (Macro Lotes / Agrupamentos)
                        </h4>
                        <p className="text-[11px] text-slate-500">
                          Altere a ordem dos Lotes-Mãe para reorganizar o empilhamento vertical na Linha de Balanço:
                        </p>
                      </div>
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200 text-slate-700">
                        {orderedGroups.length} macros
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      {orderedGroups.map((grp, mIdx) => {
                        const grpFloorCount = orderedFloors.filter((f) => f.replicationGroupId === grp.id).length;
                        return (
                          <div
                            key={grp.id}
                            className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200 shadow-2xs"
                          >
                            <div className="flex items-center gap-2.5 min-w-0 pr-2">
                              <span
                                className="w-3.5 h-3.5 rounded-full shrink-0 border border-black/10"
                                style={{ backgroundColor: grp.color || '#CBD5E1' }}
                              />
                              <div className="truncate">
                                <span className="font-bold text-slate-800 text-xs">
                                  {mIdx + 1}. {grp.name}
                                </span>
                                <span className="text-[10px] text-slate-400 ml-2">
                                  ({grpFloorCount} pavimentos)
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => handleMoveGroupOrder(grp.id, 'up')}
                                disabled={mIdx === 0}
                                className="p-1.5 px-2 hover:bg-slate-100 disabled:opacity-30 rounded-lg text-slate-700 font-bold border border-slate-200 cursor-pointer transition text-xs"
                                title="Mover para cima"
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveGroupOrder(grp.id, 'down')}
                                disabled={mIdx === orderedGroups.length - 1}
                                className="p-1.5 px-2 hover:bg-slate-100 disabled:opacity-30 rounded-lg text-slate-700 font-bold border border-slate-200 cursor-pointer transition text-xs"
                                title="Mover para baixo"
                              >
                                ▼
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Classificação dos Lotes (Pavimentos / Nível 2) */}
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                    <div className="flex justify-between items-center">
                      <div>
                        <h4 className="font-black text-slate-800 uppercase text-xs">
                          📊 Classificação dos Lotes (Pavimentos / Nível 2)
                        </h4>
                        <p className="text-[11px] text-slate-500">
                          Escolha o critério de ordenação e se os pavimentos sobem ou descem no eixo vertical:
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = globalFloorSortOrder === 'asc' ? 'desc' : 'asc';
                          setGlobalFloorSortOrder(next);
                          const newOrders: Record<string, 'asc' | 'desc'> = {};
                          orderedGroups.forEach((g) => {
                            newOrders[g.id] = next;
                          });
                          setGroupSortOrders(newOrders);
                        }}
                        className="px-2.5 py-1 bg-white hover:bg-slate-100 text-xs font-black text-slate-800 rounded-lg border border-slate-200 transition cursor-pointer shadow-2xs"
                      >
                        {globalFloorSortOrder === 'asc' ? '▲ Ordem Crescente' : '▼ Ordem Decrescente'}
                      </button>
                    </div>

                    <div className="bg-white p-3 rounded-xl border border-slate-200 space-y-2 shadow-2xs">
                      <label className="text-[10px] font-black uppercase text-slate-500 block">
                        Critério de Ordenação dos Pavimentos:
                      </label>
                      <select
                        value={floorSortField}
                        onChange={(e) => setFloorSortField(e.target.value as any)}
                        className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-800 outline-none focus:border-emerald-600 cursor-pointer"
                      >
                        <option value="position">📑 Ordem Planejada Original (Posição na Estrutura)</option>
                        <option value="name">🔤 Nome do Lote / Pavimento (A-Z)</option>
                        <option value="startDate">📅 Data de Início Mais Cedo (Cronológica)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* =========================================================
                  ABA: CABEÇALHO & ZOOM (3 NÍVEIS DA ESCALA DE TEMPO)
                 ========================================================= */}
              {displaySettingsTab === 'timeline' && (
                <div className="space-y-5">
                  {/* Zoom da Escala */}
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                    <div className="flex justify-between items-center">
                      <h4 className="font-black text-slate-800 uppercase text-xs">
                        🔍 Zoom da Escala de Tempo
                      </h4>
                      <span className="font-mono font-black text-emerald-700 bg-white px-2 py-0.5 rounded border border-slate-200">
                        {dayWidth}px / dia
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-bold text-slate-400">3px</span>
                      <input
                        type="range"
                        min={3}
                        max={32}
                        value={dayWidth}
                        onChange={(e) => setDayWidth(Number(e.target.value))}
                        className="flex-1 cursor-pointer accent-emerald-600"
                      />
                      <span className="text-[10px] font-bold text-slate-400">32px</span>
                    </div>
                    <div className="flex gap-2">
                      {[
                        { label: 'Visão Geral (5px)', val: 5 },
                        { label: 'Normal (10px)', val: 10 },
                        { label: 'Confortável (18px)', val: 18 },
                        { label: 'Detalhado (26px)', val: 26 },
                      ].map((opt) => (
                        <button
                          key={opt.val}
                          type="button"
                          onClick={() => setDayWidth(opt.val)}
                          className={`flex-1 py-1 rounded-lg border text-[10px] font-bold transition cursor-pointer ${
                            dayWidth === opt.val
                              ? 'bg-slate-800 text-white border-slate-800'
                              : 'bg-white hover:bg-slate-100 text-slate-700 border-slate-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Nível Superior: Meses */}
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                    <h4 className="font-black text-slate-800 uppercase text-xs">
                      1. Nível Superior (Meses)
                    </h4>
                    <p className="text-[11px] text-slate-500">
                      Escolha como os meses serão identificados no primeiro nível do cabeçalho:
                    </p>
                    <select
                      value={lobMonthFormat}
                      onChange={(e) => setLobMonthFormat(e.target.value as any)}
                      className="w-full bg-white border border-slate-200 rounded-xl p-2 font-bold text-slate-800 focus:outline-none cursor-pointer"
                    >
                      <option value="name_year">Mês e Ano por extenso (Ex: Maio 2026)</option>
                      <option value="mm_yy">MM/AA (Calendário Real - Ex: 05/26)</option>
                      <option value="index">Mês 1, Mês 2… desde o início da obra</option>
                    </select>
                  </div>

                  {/* Segundo Nível: Semanas */}
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                    <h4 className="font-black text-slate-800 uppercase text-xs">
                      2. Segundo Nível (Semanas)
                    </h4>
                    <p className="text-[11px] text-slate-500">
                      Formato de exibição das divisões semanais no segundo nível:
                    </p>
                    <select
                      value={lobWeekFormat}
                      onChange={(e) => setLobWeekFormat(e.target.value as any)}
                      className="w-full bg-white border border-slate-200 rounded-xl p-2 font-bold text-slate-800 focus:outline-none cursor-pointer"
                    >
                      <option value="numeric">DD/MM (Data de Início - Ex: 01/03)</option>
                      <option value="week_num">Semana 1, Semana 2… desde o início</option>
                      <option value="short">S1, S2, S3… (Abreviado)</option>
                      <option value="day">Somente DD (Dia numérico - Ex: 01)</option>
                    </select>
                  </div>

                  {/* Terceiro Nível: Dias */}
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                    <h4 className="font-black text-slate-800 uppercase text-xs">
                      3. Terceiro Nível (Dias)
                    </h4>
                    <p className="text-[11px] text-slate-500">
                      Escolha se deseja visualizar o número do dia, a inicial do dia da semana (STQQSD) ou ambos:
                    </p>
                    <select
                      value={lobDayFormat}
                      onChange={(e) => setLobDayFormat(e.target.value as any)}
                      className="w-full bg-white border border-slate-200 rounded-xl p-2 font-bold text-slate-800 focus:outline-none cursor-pointer"
                    >
                      <option value="both">Ambos (Número do Dia + Inicial da Semana - Ex: 15 S)</option>
                      <option value="day_number">Somente Número do Dia (Ex: 15)</option>
                      <option value="day_letter">Somente Inicial da Semana (Ex: S, T, Q, Q, S, S, D)</option>
                    </select>
                  </div>
                </div>
              )}

              {/* =========================================================
                  ABA: VERSÕES & BASELINE (RESUMO E ATALHO DRAWER)
                 ========================================================= */}
              {displaySettingsTab === 'versions' && (
                <div className="space-y-5">
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                    <div className="flex justify-between items-start">
                      <div>
                        <h4 className="font-black text-slate-800 uppercase text-xs">
                          Versão Atual em Visualização
                        </h4>
                        <p className="text-[11px] text-slate-500">
                          Esta é a versão congelada ou prevista que está sendo exibida e editada no momento:
                        </p>
                      </div>
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase ${
                          currentActiveVersion?.isBaseline
                            ? 'bg-amber-100 text-amber-800 border border-amber-300'
                            : currentActiveVersion?.type === 'scenario'
                            ? 'bg-purple-100 text-purple-800 border border-purple-300'
                            : 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                        }`}
                      >
                        {currentActiveVersion?.isBaseline
                          ? '📌 Linha de Base Oficial'
                          : currentActiveVersion?.type === 'scenario'
                          ? '🧪 Cenário'
                          : currentActiveVersion?.type === 'meta'
                          ? '🎯 Cronograma Meta'
                          : currentActiveVersion?.type === 'backup'
                          ? '💾 Backup'
                          : '📋 Previsto'}
                      </span>
                    </div>

                    <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-1.5 shadow-2xs">
                      <div className="flex items-center justify-between">
                        <span className="font-black text-sm text-slate-900">
                          {currentActiveVersion?.name || 'Versão Inicial'}
                        </span>
                        <span className="text-[10px] font-mono text-slate-400">
                          {currentActiveVersion?.createdAt
                            ? new Date(currentActiveVersion.createdAt).toLocaleString('pt-BR')
                            : ''}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600">
                        {currentActiveVersion?.description || 'Cronograma principal sem observações registradas.'}
                      </div>
                      <div className="text-[10px] text-slate-400 font-medium">
                        Salvo por: <strong className="text-slate-600">{currentActiveVersion?.author || 'Engenharia / Planejamento'}</strong>
                      </div>
                    </div>

                    <div className="pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveModal(null);
                          setIsVersionDrawerOpen(true);
                        }}
                        className="w-full py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-black text-xs uppercase flex items-center justify-center gap-2 shadow-sm transition cursor-pointer"
                      >
                        <span>🏷️ Abrir Central Completa de Versões & Cenários</span>
                        <span>→</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* =========================================================
                  ABA 1: LINHAS POR PAVIMENTO & ALTURAS
                 ========================================================= */}
              {displaySettingsTab === 'lines' && (
                <div className="space-y-5">
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <h4 className="font-black text-slate-800 uppercase text-xs">
                          Quantidade de Linhas por Pavimento (Altura & Simultaneidade)
                        </h4>
                        <p className="text-[11px] text-slate-500">
                          Define quantas sub-linhas cabem em cada pavimento para acomodar serviços simultâneos sem sobreposição.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-lg border border-slate-200 self-start sm:self-auto shrink-0 shadow-xs">
                        <span className="text-[10px] font-black uppercase text-slate-400">Padrão Geral:</span>
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.max(1, defaultLinesPerFloor - 1);
                            setDefaultLinesPerFloor(next);
                          }}
                          className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 font-black text-xs transition"
                        >
                          -
                        </button>
                        <span className="font-mono font-bold w-4 text-center">{defaultLinesPerFloor}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const next = Math.min(8, defaultLinesPerFloor + 1);
                            setDefaultLinesPerFloor(next);
                          }}
                          className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 font-black text-xs transition"
                        >
                          +
                        </button>
                      </div>
                    </div>

                    {/* CONFIGURAÇÃO ESPECÍFICA POR MACRO LOTE */}
                    <div className="space-y-2 pt-2 border-t border-slate-200">
                      <span className="text-[10px] font-black uppercase text-indigo-700 tracking-wider">
                        Configuração Específica por Macro Lote / Agrupamento:
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {orderedGroups.map((grp) => {
                          const currentLines = grp.linesPerFloor || defaultLinesPerFloor;
                          const grpFloorCount = orderedFloors.filter((f) => f.replicationGroupId === grp.id).length;
                          return (
                            <div
                              key={grp.id}
                              className="p-3 bg-white rounded-xl border border-slate-200 flex items-center justify-between shadow-xs"
                            >
                              <div className="flex items-center gap-2 min-w-0 pr-2">
                                <span
                                  className="w-3 h-3 rounded-full shrink-0"
                                  style={{ backgroundColor: grp.color || '#CBD5E1' }}
                                />
                                <div className="truncate">
                                  <div className="font-bold text-slate-800 truncate">{grp.name}</div>
                                  <div className="text-[9px] text-slate-400">{grpFloorCount} pavimentos</div>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0 bg-slate-50 p-1 rounded-lg border border-slate-200">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const nextVal = Math.max(1, currentLines - 1);
                                    updateLobMetadataFast((prev) => ({
                                      ...prev,
                                      replicationGroups: prev.replicationGroups.map((g) =>
                                        g.id === grp.id ? { ...g, linesPerFloor: nextVal } : g
                                      ),
                                    }));
                                  }}
                                  className="w-6 h-6 rounded bg-white hover:bg-slate-200 font-black text-xs shadow-xs"
                                >
                                  -
                                </button>
                                <span className="font-mono font-black text-indigo-700 px-1 text-xs">
                                  {currentLines} lin.
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const nextVal = Math.min(10, currentLines + 1);
                                    updateLobMetadataFast((prev) => ({
                                      ...prev,
                                      replicationGroups: prev.replicationGroups.map((g) =>
                                        g.id === grp.id ? { ...g, linesPerFloor: nextVal } : g
                                      ),
                                    }));
                                  }}
                                  className="w-6 h-6 rounded bg-white hover:bg-slate-200 font-black text-xs shadow-xs"
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* ALTURA DA SUB-LINHA */}
                    <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-[10px] font-black uppercase text-slate-700 block">
                          Espaçamento Vertical das Barras (Altura da Linha):
                        </span>
                        <span className="text-[10px] text-slate-400">
                          Compacto (18px), Normal (22px) ou Confortável (26px)
                        </span>
                      </div>
                      <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200">
                        {[
                          { label: 'Compacto (18px)', val: 18 },
                          { label: 'Normal (22px)', val: 22 },
                          { label: 'Confortável (26px)', val: 26 },
                        ].map((opt) => (
                          <button
                            key={opt.val}
                            type="button"
                            onClick={() => setSubLineHeight(opt.val)}
                            className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition ${
                              subLineHeight === opt.val
                                ? 'bg-slate-800 text-white'
                                : 'text-slate-600 hover:bg-slate-100'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* OTIMIZAÇÃO AUTOMÁTICA DE SUB-LINHAS */}
                    <div className="pt-3 border-t border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-emerald-50/70 p-3 rounded-xl border border-emerald-200">
                      <div>
                        <h5 className="font-black text-emerald-950 text-xs uppercase flex items-center gap-1.5">
                          <span>✨</span>
                          <span>Organização Inteligente de Sub-linhas</span>
                        </h5>
                        <p className="text-[11px] text-emerald-800">
                          Distribui automaticamente atividades paralelas em linhas diferentes no mesmo pavimento, eliminando sobreposição.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          updateLobScheduleDates((prev) => optimizeSubLines(prev, { defaultLinesPerFloor }));
                        }}
                        className="px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs uppercase rounded-xl transition shadow-xs whitespace-nowrap active:scale-95"
                      >
                        ✨ Otimizar Sub-linhas Agora
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* =========================================================
                  ABA 2: TEXTOS & RÓTULOS DAS BARRAS
                 ========================================================= */}
              {displaySettingsTab === 'labels' && (
                <div className="space-y-5">
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-4">
                    <div>
                      <h4 className="font-black text-slate-800 uppercase text-xs">
                        Configuração de Rótulos e Textos nas Atividades
                      </h4>
                      <p className="text-[11px] text-slate-500">
                        Escolha exatamente quais textos devem aparecer ao lado esquerdo, no corpo da barra e ao lado direito de cada pacote na Linha de Balanço.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* TOGGLE 1: DATA À ESQUERDA */}
                      <label className="flex items-start gap-3 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition cursor-pointer shadow-xs select-none">
                        <input
                          type="checkbox"
                          checked={showLeftDateLabel}
                          onChange={(e) => setShowLeftDateLabel(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                        />
                        <div className="min-w-0">
                          <span className="font-bold text-slate-800 text-xs block">
                            📅 Data de Início (Lado Esquerdo)
                          </span>
                          <span className="text-[10px] text-slate-500 block leading-tight mt-0.5">
                            Exibe a data formatada (ex: 15/04) logo antes do início da barra.
                          </span>
                        </div>
                      </label>

                      {/* TOGGLE 2: DURAÇÃO EM DIAS */}
                      <label className="flex items-start gap-3 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition cursor-pointer shadow-xs select-none">
                        <input
                          type="checkbox"
                          checked={showDurationLabel}
                          onChange={(e) => setShowDurationLabel(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                        />
                        <div className="min-w-0">
                          <span className="font-bold text-slate-800 text-xs block">
                            ⏱️ Duração em Dias (Lado Esquerdo)
                          </span>
                          <span className="text-[10px] text-slate-500 block leading-tight mt-0.5">
                            Inclui a duração em dias de obra (ex: 6d) ao lado da data.
                          </span>
                        </div>
                      </label>

                      {/* TOGGLE 3: NOME DO PACOTE DENTRO DA BARRA */}
                      <label className="flex items-start gap-3 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition cursor-pointer shadow-xs select-none">
                        <input
                          type="checkbox"
                          checked={showPackageNameInBar}
                          onChange={(e) => setShowPackageNameInBar(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                        />
                        <div className="min-w-0">
                          <span className="font-bold text-slate-800 text-xs block">
                            🏷️ Nome do Pacote (Dentro da Barra)
                          </span>
                          <span className="text-[10px] text-slate-500 block leading-tight mt-0.5">
                            Renderiza o nome da atividade/pacote impresso sobre a barra colorida.
                          </span>
                        </div>
                      </label>

                      {/* TOGGLE 4: PERCENTUAL DE ANDAMENTO À DIREITA */}
                      <label className="flex items-start gap-3 p-3 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition cursor-pointer shadow-xs select-none">
                        <input
                          type="checkbox"
                          checked={showRightProgressLabel}
                          onChange={(e) => setShowRightProgressLabel(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                        />
                        <div className="min-w-0">
                          <span className="font-bold text-slate-800 text-xs block">
                            📊 Andamento / % Físico (Lado Direito)
                          </span>
                          <span className="text-[10px] text-slate-500 block leading-tight mt-0.5">
                            Exibe o percentual de avanço executado (ex: 80% ou 100%) após o término da barra.
                          </span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* PRÉ-VISUALIZAÇÃO INTERATIVA EM TEMPO REAL */}
                  <div className="p-4 rounded-xl bg-slate-900 text-white space-y-3 shadow-md">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase text-emerald-400 tracking-wider flex items-center gap-1.5">
                        <span>👁️</span>
                        <span>Pré-visualização Interativa da Atividade</span>
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        Pavimento 05 • Alvenaria Estrutural
                      </span>
                    </div>

                    <div className="bg-slate-950/80 rounded-lg p-5 border border-slate-800 relative flex items-center justify-center min-h-[96px] overflow-x-auto">
                      <div className="relative flex items-center">
                        {/* LADO ESQUERDO: DATA E DURAÇÃO */}
                        {(showLeftDateLabel || showDurationLabel) && (
                          <span className="mr-2.5 text-[11px] font-mono font-bold text-slate-300 whitespace-nowrap bg-slate-800/90 px-2 py-0.5 rounded border border-slate-700 select-none shadow-xs">
                            {showLeftDateLabel ? '15/04' : ''}
                            {showLeftDateLabel && showDurationLabel ? ' • ' : ''}
                            {showDurationLabel ? '6d' : ''}
                          </span>
                        )}

                        {/* CORPO DA BARRA */}
                        <div
                          className="relative rounded-md shadow-md flex items-center justify-center overflow-hidden border border-emerald-400/40 transition-all duration-200"
                          style={{
                            backgroundColor: '#0284c7',
                            width: 180,
                            height: Math.max(18, subLineHeight - 4),
                          }}
                        >
                          {/* Faixa interna de avanço medido */}
                          <div
                            className="absolute left-0 top-0 bottom-0 bg-white/20 pointer-events-none"
                            style={{ width: '80%' }}
                          />
                          {showPackageNameInBar && (
                            <span className="relative z-10 text-[10px] font-black text-white px-2 truncate">
                              Alvenaria Estrutural
                            </span>
                          )}
                        </div>

                        {/* LADO DIREITO: ANDAMENTO / % */}
                        {showRightProgressLabel && (
                          <span className="ml-2.5 text-[10px] font-black text-emerald-300 bg-emerald-950/90 border border-emerald-600/70 px-2 py-0.5 rounded-full whitespace-nowrap select-none shadow-xs">
                            80%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* =========================================================
                  ABA 3: LINHAS DE GRADE (ESTILO MS PROJECT)
                 ========================================================= */}
              {displaySettingsTab === 'grid' && (
                <div className="space-y-5">
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-4">
                    <div>
                      <h4 className="font-black text-slate-800 uppercase text-xs">
                        Controle de Linhas de Grade (MS Project Style)
                      </h4>
                      <p className="text-[11px] text-slate-500">
                        Ajuste espessura, contraste e estilo das linhas divisórias dos pavimentos (horizontais) e do calendário (verticais).
                      </p>
                    </div>

                    {/* SEÇÃO 1: LINHAS HORIZONTAIS DOS PAVIMENTOS */}
                    <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-3 shadow-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black uppercase text-slate-800 tracking-wider">
                          1. Linhas Horizontais (Divisores de Pavimentos)
                        </span>
                        <span className="text-[10px] text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                          Recomendado: 2px escuro
                        </span>
                      </div>

                      {/* Espessura horizontal */}
                      <div>
                        <span className="text-[10px] font-black uppercase text-slate-500 block mb-1">
                          Espessura do Traço:
                        </span>
                        <div className="grid grid-cols-4 gap-2">
                          {[
                            { label: '1px (Fina)', val: 1 },
                            { label: '2px (Média)', val: 2 },
                            { label: '3px (Grossa)', val: 3 },
                            { label: '4px (Marcada)', val: 4 },
                          ].map((opt) => (
                            <button
                              key={opt.val}
                              type="button"
                              onClick={() => setGridHorizontalWidth(opt.val)}
                              className={`p-2 rounded-lg border text-center transition ${
                                gridHorizontalWidth === opt.val
                                  ? 'bg-slate-900 text-white border-slate-900 font-black'
                                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200 font-bold'
                              }`}
                            >
                              <div className="text-[11px]">{opt.label}</div>
                              <div
                                className="mt-1.5 mx-auto rounded-full"
                                style={{
                                  height: opt.val,
                                  backgroundColor: gridHorizontalWidth === opt.val ? '#ffffff' : '#94a3b8',
                                  width: '80%',
                                }}
                              />
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Cor horizontal */}
                      <div>
                        <span className="text-[10px] font-black uppercase text-slate-500 block mb-1">
                          Cor / Contraste do Divisor:
                        </span>
                        <div className="flex flex-wrap items-center gap-2">
                          {[
                            { name: 'Suave', color: '#cbd5e1' },
                            { name: 'Médio', color: '#94a3b8' },
                            { name: 'Escuro (Padrão)', color: '#64748b' },
                            { name: 'Carvão', color: '#334155' },
                            { name: 'Preto', color: '#0f172a' },
                            { name: 'Azul Técnico', color: '#2563eb' },
                          ].map((preset) => (
                            <button
                              key={preset.color}
                              type="button"
                              onClick={() => setGridHorizontalColor(preset.color)}
                              className={`px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 text-[10px] font-bold transition ${
                                gridHorizontalColor === preset.color
                                  ? 'ring-2 ring-emerald-500 border-transparent bg-slate-100 text-slate-900 font-black'
                                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                              }`}
                            >
                              <span
                                className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0"
                                style={{ backgroundColor: preset.color }}
                              />
                              <span>{preset.name}</span>
                            </button>
                          ))}
                          <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200">
                            <span className="text-[10px] font-bold text-slate-500">Personalizado:</span>
                            <input
                              type="color"
                              value={gridHorizontalColor}
                              onChange={(e) => setGridHorizontalColor(e.target.value)}
                              className="w-6 h-6 rounded cursor-pointer border-0 bg-transparent"
                            />
                          </div>
                        </div>
                      </div>

                      {/* Estilo horizontal */}
                      <div>
                        <span className="text-[10px] font-black uppercase text-slate-500 block mb-1">
                          Estilo da Linha Horizontal:
                        </span>
                        <div className="flex items-center gap-2">
                          {[
                            { label: 'Sólida (Contínua)', val: 'solid' },
                            { label: 'Tracejada (Dashed)', val: 'dashed' },
                            { label: 'Pontilhada (Dotted)', val: 'dotted' },
                          ].map((st) => (
                            <button
                              key={st.val}
                              type="button"
                              onClick={() => setGridHorizontalStyle(st.val as any)}
                              className={`px-3 py-1.5 rounded-lg border text-[11px] transition ${
                                gridHorizontalStyle === st.val
                                  ? 'bg-slate-900 text-white border-slate-900 font-black'
                                  : 'bg-white hover:bg-slate-100 text-slate-700 border-slate-200 font-bold'
                              }`}
                            >
                              {st.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* SEÇÃO 2: LINHAS VERTICAIS DO CALENDÁRIO */}
                    <div className="p-3.5 bg-white rounded-xl border border-slate-200 space-y-3 shadow-xs">
                      <span className="text-xs font-black uppercase text-slate-800 tracking-wider block">
                        2. Linhas Verticais (Grade do Calendário / Dias)
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <span className="text-[10px] font-black uppercase text-slate-500 block mb-1">
                            Espessura:
                          </span>
                          <div className="flex items-center gap-2">
                            {[1, 2].map((w) => (
                              <button
                                key={w}
                                type="button"
                                onClick={() => setGridVerticalWidth(w)}
                                className={`flex-1 py-1 rounded-lg border text-xs font-bold transition ${
                                  gridVerticalWidth === w
                                    ? 'bg-slate-900 text-white border-slate-900 font-black'
                                    : 'bg-slate-50 text-slate-600 border-slate-200'
                                }`}
                              >
                                {w}px
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <span className="text-[10px] font-black uppercase text-slate-500 block mb-1">
                            Contraste:
                          </span>
                          <div className="flex items-center gap-1.5">
                            {[
                              { label: 'Leve', color: '#f1f5f9' },
                              { label: 'Normal', color: '#cbd5e1' },
                              { label: 'Forte', color: '#94a3b8' },
                            ].map((c) => (
                              <button
                                key={c.color}
                                type="button"
                                onClick={() => setGridVerticalColor(c.color)}
                                className={`flex-1 py-1 rounded-lg border text-[10px] font-bold transition ${
                                  gridVerticalColor === c.color
                                    ? 'ring-2 ring-emerald-500 bg-slate-100 font-black'
                                    : 'bg-white border-slate-200 text-slate-600'
                                }`}
                              >
                                {c.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div>
                          <span className="text-[10px] font-black uppercase text-slate-500 block mb-1">
                            Estilo:
                          </span>
                          <div className="flex items-center gap-1.5">
                            {(['solid', 'dashed', 'dotted'] as const).map((st) => (
                              <button
                                key={st}
                                type="button"
                                onClick={() => setGridVerticalStyle(st)}
                                className={`flex-1 py-1 rounded-lg border text-[10px] uppercase font-bold transition ${
                                  gridVerticalStyle === st
                                    ? 'bg-slate-900 text-white font-black'
                                    : 'bg-white border-slate-200 text-slate-600'
                                }`}
                              >
                                {st === 'solid' ? 'Sólida' : st === 'dashed' ? 'Tracej.' : 'Pontilh.'}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* SEÇÃO 3: FAIXAS ZEBRADAS */}
                    <div className="p-3.5 bg-white rounded-xl border border-slate-200 shadow-xs">
                      <label className="flex items-start gap-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={enableZebraBands}
                          onChange={(e) => setEnableZebraBands(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                        />
                        <div>
                          <span className="text-xs font-black text-slate-800 uppercase tracking-wide block">
                            🦓 Faixas Zebradas Alternadas nos Pavimentos
                          </span>
                          <span className="text-[10px] text-slate-500 block mt-0.5">
                            Alterna tons de fundo suaves entre pavimentos pares e ímpares para facilitar o acompanhamento visual dos eixos em obras de grande porte.
                          </span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* PRÉ-VISUALIZAÇÃO DA GRADE (MS PROJECT) */}
                  <div className="p-4 rounded-xl bg-slate-900 text-white space-y-3 shadow-md">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase text-emerald-400 tracking-wider flex items-center gap-1.5">
                        <span>📐</span>
                        <span>Simulação das Linhas de Grade em 3 Pavimentos</span>
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        Divisor: {gridHorizontalWidth}px • {gridHorizontalStyle} • {gridHorizontalColor}
                      </span>
                    </div>

                    <div className="bg-slate-950/80 rounded-xl p-4 border border-slate-800 overflow-hidden">
                      <div className="space-y-0 text-[10px] font-bold text-slate-400">
                        {['Pavimento 03', 'Pavimento 02', 'Pavimento 01'].map((floorName, idx) => {
                          const isZebra = enableZebraBands && idx % 2 === 1;
                          return (
                            <div
                              key={floorName}
                              className="relative flex items-center h-10 px-3 transition-colors"
                              style={{
                                backgroundColor: isZebra ? '#1e293b' : 'transparent',
                                borderBottomWidth: `${gridHorizontalWidth}px`,
                                borderBottomColor: gridHorizontalColor,
                                borderBottomStyle: gridHorizontalStyle,
                              }}
                            >
                              <span className="w-24 shrink-0 text-slate-300 font-mono">{floorName}</span>

                              {/* Colunas verticais simuladas */}
                              <div className="flex-1 flex h-full">
                                {[...Array(8)].map((_, i) => (
                                  <div
                                    key={i}
                                    className="flex-1 h-full"
                                    style={{
                                      borderRightWidth: `${gridVerticalWidth}px`,
                                      borderRightColor: gridVerticalColor,
                                      borderRightStyle: gridVerticalStyle,
                                    }}
                                  />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* =========================================================
                  ABA 4: PACOTES DE TRABALHO
                 ========================================================= */}
              {displaySettingsTab === 'packages' && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                    <div>
                      <h4 className="font-black text-slate-800 uppercase text-xs">
                        Seleção e Filtro de Pacotes de Trabalho
                      </h4>
                      <p className="text-[11px] text-slate-500">
                        Isole um pacote específico ou navegue por todos os {activeState.services.length} pacotes da obra.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedServiceFilter('')}
                        className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase border transition ${
                          !selectedServiceFilter
                            ? 'bg-emerald-700 text-white border-emerald-800'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        Mostrar Todos
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveModal('services')}
                        className="px-3 py-1 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] font-black uppercase hover:bg-indigo-100"
                      >
                        + Novo Pacote
                      </button>
                    </div>
                  </div>

                  <input
                    type="text"
                    placeholder="🔍 Filtrar lista de pacotes..."
                    value={packageSearchQuery}
                    onChange={(e) => setPackageSearchQuery(e.target.value)}
                    className="w-full p-2 bg-white border border-slate-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-emerald-500"
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
                    {activeState.services
                      .filter((pkg) =>
                        !packageSearchQuery.trim()
                          ? true
                          : pkg.name.toLowerCase().includes(packageSearchQuery.toLowerCase())
                      )
                      .map((pkg) => {
                        const isSelected = selectedServiceFilter === pkg.id;
                        const actCount = activeState.activities.filter((a) => a.serviceId === pkg.id).length;
                        return (
                          <div
                            key={pkg.id}
                            className={`p-2.5 rounded-xl border flex items-center justify-between transition cursor-pointer ${
                              isSelected
                                ? 'bg-emerald-50 border-emerald-500 ring-2 ring-emerald-200'
                                : 'bg-white border-slate-200 hover:border-slate-300'
                            }`}
                            onClick={() => setSelectedServiceFilter(isSelected ? '' : pkg.id)}
                          >
                            <div className="flex items-center gap-2 truncate pr-2">
                              <span
                                className="w-3.5 h-3.5 rounded-full shrink-0 shadow-xs"
                                style={{ backgroundColor: pkg.color }}
                              />
                              <div className="truncate">
                                <div className="font-bold text-slate-800 truncate">{pkg.name}</div>
                                <div className="text-[9px] text-slate-400">
                                  {actCount} atividades • {pkg.jobs?.length || 1} sub-tarefas
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openServiceModal(pkg);
                                }}
                                className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold"
                                title="Editar sub-tarefas e cores do pacote"
                              >
                                ✏️
                              </button>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${
                                  isSelected ? 'bg-emerald-700 text-white' : 'bg-slate-100 text-slate-500'
                                }`}
                              >
                                {isSelected ? 'Filtrado' : 'Selecionar'}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* =========================================================
                  ABA 5: OPÇÕES AVANÇADAS & RESTAURAÇÃO
                 ========================================================= */}
              {displaySettingsTab === 'options' && (
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-4">
                  <div>
                    <h4 className="font-black text-slate-800 uppercase text-xs">
                      Opções Avançadas e Visualização Geral
                    </h4>
                    <p className="text-[11px] text-slate-500">
                      Recursos de engenharia analítica e visualização de conexões entre frentes de trabalho.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <label className="flex items-center gap-2.5 text-xs font-bold text-slate-700 cursor-pointer p-2.5 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition">
                      <input
                        type="checkbox"
                        checked={hideEmptyFloors}
                        onChange={(e) => setHideEmptyFloors(e.target.checked)}
                        className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                      />
                      <div>
                        <span>Ocultar locais vazios (sem atividades lançadas)</span>
                        <p className="text-[10px] text-slate-400 font-normal">
                          Remove do eixo vertical pavimentos que ainda não possuem tarefas planejadas.
                        </p>
                      </div>
                    </label>

                    <label className="flex items-center gap-2.5 text-xs font-bold text-slate-700 cursor-pointer p-2.5 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition">
                      <input
                        type="checkbox"
                        checked={showCriticalPath}
                        onChange={(e) => setShowCriticalPath(e.target.checked)}
                        className="w-4 h-4 rounded text-rose-600 focus:ring-rose-500"
                      />
                      <div>
                        <span>Destacar Caminho Crítico da obra em vermelho</span>
                        <p className="text-[10px] text-slate-400 font-normal">
                          Evidencia o caminho com folga zero cuja variação impacta a data final da obra.
                        </p>
                      </div>
                    </label>

                    <label className="flex items-center gap-2.5 text-xs font-bold text-slate-700 cursor-pointer p-2.5 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition">
                      <input
                        type="checkbox"
                        checked={showDependencyArrows}
                        onChange={(e) => setShowDependencyArrows(e.target.checked)}
                        className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <div>
                        <span>Exibir todas as setas simultâneas de conexão (Gantt/Rede)</span>
                        <p className="text-[10px] text-slate-400 font-normal">
                          Traça setas completas entre todas as atividades predecessoras e sucessoras na tela.
                        </p>
                      </div>
                    </label>

                    <label className="flex items-center gap-2.5 text-xs font-bold text-slate-700 cursor-pointer p-2.5 bg-white rounded-xl border border-slate-200 hover:border-slate-300 transition">
                      <input
                        type="checkbox"
                        checked={showGhostBaseline}
                        onChange={(e) => setShowGhostBaseline(e.target.checked)}
                        className="w-4 h-4 rounded text-amber-600 focus:ring-amber-500"
                      />
                      <div>
                        <span>Exibir Linha de Base Fantasma (Baseline)</span>
                        <p className="text-[10px] text-slate-400 font-normal">
                          Mostra as barras originais da linha de base pontilhadas abaixo das datas replanejadas.
                        </p>
                      </div>
                    </label>
                  </div>

                  {/* RESTAURAR PADRÕES */}
                  <div className="pt-3 border-t border-slate-200 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-bold text-slate-700 block">Restaurar Configurações Padrão</span>
                      <span className="text-[10px] text-slate-400">
                        Volta para linhas 2px #64748b, todos os rótulos ativos e alturas normais.
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setDefaultLinesPerFloor(2);
                        setSubLineHeight(22);
                        setGridHorizontalWidth(2);
                        setGridHorizontalColor('#64748b');
                        setGridHorizontalStyle('solid');
                        setGridVerticalWidth(1);
                        setGridVerticalColor('#cbd5e1');
                        setGridVerticalStyle('solid');
                        setEnableZebraBands(false);
                        setShowLeftDateLabel(true);
                        setShowDurationLabel(true);
                        setShowPackageNameInBar(true);
                        setShowRightProgressLabel(true);
                      }}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-[10px] font-black uppercase transition"
                    >
                      ↺ Restaurar Padrões
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* RODAPÉ DO MODAL: SALVAMENTO E PERSISTÊNCIA TOTAL */}
            <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
              <span className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <span className="text-emerald-600">✓</span>
                <span>Configurações salvas automaticamente no navegador para este projeto</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  try {
                    const configObj = {
                      zoomMode,
                      dayWidth,
                      defaultLinesPerFloor,
                      subLineHeight,
                      hideEmptyFloors,
                      showDependencyArrows,
                      showCriticalPath,
                      showGhostBaseline,
                      globalFloorSortOrder,
                      floorSortField,
                      lobMonthFormat,
                      lobWeekFormat,
                      lobDayFormat,
                      groupSortOrders,
                      collapsedGroups,
                      showLeftDateLabel,
                      showRightProgressLabel,
                      showPackageNameInBar,
                      showDurationLabel,
                      gridHorizontalWidth,
                      gridHorizontalColor,
                      gridHorizontalStyle,
                      gridVerticalWidth,
                      gridVerticalColor,
                      gridVerticalStyle,
                      enableZebraBands,
                    };
                    localStorage.setItem(`curtoprazo_lob_config_${selectedProjectId || 'global'}`, JSON.stringify(configObj));
                    localStorage.setItem(`curtoprazo_lob_subline_height_${selectedProjectId || 'global'}`, String(subLineHeight));
                    localStorage.setItem(`curtoprazo_lob_lines_per_floor_${selectedProjectId || 'global'}`, String(defaultLinesPerFloor));
                    localStorage.setItem(`curtoprazo_lob_hide_empty_${selectedProjectId || 'global'}`, String(hideEmptyFloors));
                    localStorage.setItem(`curtoprazo_lob_critical_path_${selectedProjectId || 'global'}`, String(showCriticalPath));
                    localStorage.setItem(`curtoprazo_lob_arrows_${selectedProjectId || 'global'}`, String(showDependencyArrows));
                    localStorage.setItem(`curtoprazo_lob_ghost_${selectedProjectId || 'global'}`, String(showGhostBaseline));
                  } catch (_) {}
                  updateLobMetadataFast((prev) => ({ ...prev }));
                  setActiveModal(null);
                }}
                className="px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-black uppercase rounded-xl transition shadow-sm active:scale-95"
              >
                Concluir Configurações
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 1: CALENDÁRIO DA OBRA (`calendar`)
         ===================================================================== */}
      {activeModal === 'calendar' && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex justify-between items-center">
              <h3 className="text-sm font-black uppercase tracking-wider">📅 Calendário e Dias Úteis da Obra</h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white font-bold text-lg"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-black uppercase text-slate-500 mb-1">Data de Início da Obra</label>
                  <input
                    type="date"
                    value={activeState.calendar.startDate}
                    onChange={(e) =>
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        calendar: { ...prev.calendar, startDate: e.target.value },
                      }))
                    }
                    className="w-full p-2.5 border border-slate-200 rounded-xl font-mono font-bold"
                  />
                </div>
                <div>
                  <label className="block font-black uppercase text-slate-500 mb-1">Horizonte Final</label>
                  <input
                    type="date"
                    value={activeState.calendar.endDate}
                    onChange={(e) =>
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        calendar: { ...prev.calendar, endDate: e.target.value },
                      }))
                    }
                    className="w-full p-2.5 border border-slate-200 rounded-xl font-mono font-bold"
                  />
                </div>
              </div>

              <div>
                <label className="block font-black uppercase text-slate-500 mb-2">Dias Úteis da Semana</label>
                <div className="grid grid-cols-7 gap-1.5">
                  {WEEKDAY_LABELS.map((label, idx) => {
                    const active = activeState.calendar.workdays[idx];
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() =>
                          updateLobMetadataFast((prev) => {
                            const nextW = [...prev.calendar.workdays] as ProjectCalendar['workdays'];
                            nextW[idx] = !nextW[idx];
                            return {
                              ...prev,
                              calendar: { ...prev.calendar, workdays: nextW },
                            };
                          })
                        }
                        className={`py-2.5 rounded-xl font-black uppercase border transition ${
                          active
                            ? 'bg-emerald-700 text-white border-emerald-800'
                            : 'bg-slate-100 text-slate-400 border-slate-200'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                <div>
                  <div className="font-black text-slate-800 uppercase">Sem folga entre atividades</div>
                  <div className="text-[11px] text-slate-500">
                    Puxa automaticamente as atividades dependentes quando uma predecessora muda de data.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={activeState.calendar.removeGaps}
                  onChange={(e) =>
                    updateLobMetadataFast((prev) => ({
                      ...prev,
                      calendar: { ...prev.calendar, removeGaps: e.target.checked },
                    }))
                  }
                  className="w-5 h-5 accent-emerald-700"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-2">
                  <label className="font-black uppercase text-slate-500">
                    Feriados / Dias Não Úteis ({activeState.calendar.holidays.length})
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const y = Number(activeState.calendar.startDate.slice(0, 4)) || new Date().getFullYear();
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        calendar: {
                          ...prev.calendar,
                          holidays: Array.from(
                            new Set([
                              ...prev.calendar.holidays,
                              ...getBrazilianHolidays(y),
                              ...getBrazilianHolidays(y + 1),
                            ])
                          ).sort(),
                        },
                      }));
                    }}
                    className="text-[10px] font-black text-emerald-700 hover:underline uppercase"
                  >
                    + Carregar Feriados Nacionais
                  </button>
                </div>

                <div className="flex gap-2 mb-3">
                  <input
                    type="date"
                    value={newHolidayInput}
                    onChange={(e) => setNewHolidayInput(e.target.value)}
                    className="flex-1 p-2 border border-slate-200 rounded-xl font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!newHolidayInput) return;
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        calendar: {
                          ...prev.calendar,
                          holidays: Array.from(new Set([...prev.calendar.holidays, newHolidayInput])).sort(),
                        },
                      }));
                      setNewHolidayInput('');
                    }}
                    className="px-4 py-2 rounded-xl bg-slate-800 text-white font-black uppercase"
                  >
                    Adicionar
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 bg-slate-50 rounded-xl border border-slate-200">
                  {activeState.calendar.holidays.map((h) => (
                    <span
                      key={h}
                      className="px-2 py-1 rounded-lg bg-white border border-slate-200 font-mono text-[11px] flex items-center gap-1.5"
                    >
                      {formatDateBRShort(h)}
                      <button
                        type="button"
                        onClick={() =>
                          updateLobMetadataFast((prev) => ({
                            ...prev,
                            calendar: {
                              ...prev.calendar,
                              holidays: prev.calendar.holidays.filter((x) => x !== h),
                            },
                          }))
                        }
                        className="text-rose-500 font-black"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="px-5 py-2 rounded-xl bg-emerald-700 text-white font-black text-xs uppercase"
              >
                Concluir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 2: LOCAIS E AGRUPAMENTOS EM LOTE (`floors`)
         ===================================================================== */}
      {activeModal === 'floors' && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex justify-between items-center">
              <h3 className="text-sm font-black uppercase tracking-wider">
                🏢 Gerenciar Agrupamentos e Locais (Pavimentos)
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white font-bold text-lg"
              >
                ✕
              </button>
            </div>

            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6 max-h-[80vh] overflow-y-auto text-xs">
              <div className="space-y-5">
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="font-black uppercase text-slate-700">1. Agrupamentos de Replicação</div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="Ex: TORRE A, SUBSOLOS, EMBASAMENTO..."
                      className="flex-1 p-2 bg-white border border-slate-200 rounded-lg font-bold uppercase"
                    />
                    <input
                      type="color"
                      value={newGroupColor}
                      onChange={(e) => setNewGroupColor(e.target.value)}
                      className="w-9 h-9 rounded cursor-pointer border border-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const clean = newGroupName.trim().toUpperCase();
                        if (!clean) return;
                        const newGrp: ReplicationGroup = {
                          id: `grp_${slugifySchedule(clean)}_${Date.now().toString(36)}`,
                          name: clean,
                          position: activeState.replicationGroups.length + 1,
                          linesPerFloor: 5,
                          color: newGroupColor,
                        };
                        updateLobMetadataFast((prev) => ({
                          ...prev,
                          replicationGroups: [...prev.replicationGroups, newGrp],
                        }));
                        setSeqGroupId(newGrp.id);
                        setNewGroupName('');
                      }}
                      className="px-3 py-2 rounded-lg bg-slate-800 text-white font-black uppercase"
                    >
                      + Grupo
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {orderedGroups.map((g) => (
                      <span
                        key={g.id}
                        style={{ backgroundColor: g.color }}
                        className="px-2.5 py-1 rounded-lg border border-slate-300 font-black text-[10px] text-slate-800 flex items-center gap-1.5"
                      >
                        {g.name}
                        {orderedGroups.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              updateLobMetadataFast((prev) => ({
                                ...prev,
                                replicationGroups: prev.replicationGroups.filter((x) => x.id !== g.id),
                              }))
                            }
                            className="text-rose-600 hover:text-rose-800"
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-emerald-50/50 border border-emerald-200 space-y-3">
                  <div className="font-black uppercase text-emerald-950">
                    2. Criar Pavimentos em Lote Sequencial
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="col-span-2">
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Agrupamento Destino
                      </label>
                      <select
                        value={seqGroupId || orderedGroups[0]?.id || ''}
                        onChange={(e) => setSeqGroupId(e.target.value)}
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-bold"
                      >
                        {orderedGroups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Prefixo
                      </label>
                      <input
                        type="text"
                        value={seqPrefix}
                        onChange={(e) => setSeqPrefix(e.target.value)}
                        placeholder="Ex: Pavimento "
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Sufixo
                      </label>
                      <input
                        type="text"
                        value={seqSuffix}
                        onChange={(e) => setSeqSuffix(e.target.value)}
                        placeholder="Ex: º Pav"
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Quantidade
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={seqQty}
                        onChange={(e) => setSeqQty(Number(e.target.value))}
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono font-bold"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Início Numeração
                      </label>
                      <input
                        type="number"
                        value={seqStartNum}
                        onChange={(e) => setSeqStartNum(Number(e.target.value))}
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono font-bold"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Área por Pav. (m²)
                      </label>
                      <input
                        type="number"
                        value={seqArea}
                        onChange={(e) => setSeqArea(Number(e.target.value))}
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono"
                      />
                    </div>

                    <div className="flex items-end pb-2">
                      <label className="flex items-center gap-1.5 font-bold text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={seqZeroPad}
                          onChange={(e) => setSeqZeroPad(e.target.checked)}
                          className="accent-emerald-700"
                        />
                        Zero à esq. (01, 02)
                      </label>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      const targetGroup = seqGroupId || orderedGroups[0]?.id;
                      if (!targetGroup) return;
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        floors: createSequentialFloors(prev.floors, {
                          prefix: seqPrefix,
                          suffix: seqSuffix,
                          quantity: seqQty,
                          startsWith: seqStartNum,
                          area: seqArea,
                          replicationGroupId: targetGroup,
                          zeroPad: seqZeroPad,
                        }),
                      }));
                    }}
                    className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black uppercase tracking-wider transition"
                  >
                    + Gerar {seqQty} Locais em Sequência
                  </button>
                </div>

                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="font-black uppercase text-slate-700">3. Adicionar Local Avulso</div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={singleFloorName}
                      onChange={(e) => setSingleFloorName(e.target.value)}
                      placeholder="Ex: Térreo, Subsolo 01, Ático..."
                      className="flex-1 p-2 bg-white border border-slate-200 rounded-lg font-bold"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const clean = singleFloorName.trim();
                        if (!clean) return;
                        const targetGroup = seqGroupId || orderedGroups[0]?.id;
                        updateLobMetadataFast((prev) => ({
                          ...prev,
                          floors: [
                            ...prev.floors,
                            {
                              id: `flr_${slugifySchedule(clean)}_${Date.now().toString(36)}`,
                              name: clean,
                              position: prev.floors.length + 1,
                              area: seqArea || undefined,
                              replicationGroupId: targetGroup,
                            },
                          ],
                        }));
                        setSingleFloorName('');
                      }}
                      className="px-4 py-2 rounded-lg bg-slate-800 text-white font-black uppercase"
                    >
                      Adicionar
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col border border-slate-200 rounded-xl overflow-hidden">
                <div className="p-3 bg-slate-100 border-b border-slate-200 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-black uppercase text-slate-700">
                      Locais Cadastrados ({orderedFloors.length})
                    </span>
                    {orderedFloors.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          updateLobMetadataFast((prev) => ({
                            ...prev,
                            floors: [],
                            activities: [],
                          }))
                        }
                        className="text-[10px] font-black text-rose-600 hover:underline uppercase"
                      >
                        Limpar Todos
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={floorSearchModal}
                    onChange={(e) => setFloorSearchModal(e.target.value)}
                    placeholder="🔍 Buscar local..."
                    className="w-full p-1.5 bg-white border border-slate-200 rounded-lg text-xs"
                  />
                </div>

                <div className="flex-1 overflow-y-auto max-h-[380px] divide-y divide-slate-100">
                  {filteredModalFloors.slice(0, 120).map((flr, idx) => {
                    const grp = groupMap.get(flr.replicationGroupId);
                    return (
                      <div
                        key={flr.id}
                        className="p-2.5 px-3 flex items-center justify-between hover:bg-slate-50"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span className="font-mono text-[10px] text-slate-400 w-5">{idx + 1}.</span>
                          <div>
                            <div className="font-bold text-slate-800">{flr.name}</div>
                            <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">
                              {grp?.name || 'Sem Grupo'}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              updateLobMetadataFast((prev) => ({
                                ...prev,
                                floors: prev.floors.filter((f) => f.id !== flr.id),
                                activities: prev.activities.filter((a) => a.floorId !== flr.id),
                              }))
                            }
                            className="p-1 text-rose-500 hover:bg-rose-50 rounded font-bold ml-1"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {filteredModalFloors.length === 0 && (
                    <div className="p-8 text-center text-slate-400 italic">
                      Nenhum pavimento encontrado.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="px-5 py-2 rounded-xl bg-emerald-700 text-white font-black text-xs uppercase"
              >
                Concluir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 3: PACOTES DE TRABALHO E SUB-TAREFAS (`services`)
         ===================================================================== */}
      {activeModal === 'services' && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl overflow-hidden">
            <div className="p-4 bg-slate-900 text-white flex justify-between items-center">
              <h3 className="text-sm font-black uppercase tracking-wider">
                📦 Pacotes de Trabalho (Macroatividades) & Sub-tarefas (Serviços)
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-400 hover:text-white font-bold text-lg"
              >
                ✕
              </button>
            </div>

            <div className="p-5 grid grid-cols-1 lg:grid-cols-12 gap-6 max-h-[82vh] overflow-y-auto text-xs">
              <div className="lg:col-span-5 flex flex-col border border-slate-200 rounded-xl overflow-hidden">
                <div className="p-3 bg-slate-100 border-b border-slate-200 flex justify-between items-center">
                  <span className="font-black uppercase text-slate-700">
                    Pacotes da Obra ({activeState.services.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const preset = getVerticalBuildingPreset();
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        services: preset.services,
                      }));
                    }}
                    className="text-[10px] font-black text-emerald-700 hover:underline uppercase"
                  >
                    + Carregar Padrão Vertical
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto max-h-[430px] divide-y divide-slate-100">
                  {activeState.services.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => openServiceModal(s)}
                      className={`p-3 flex items-center justify-between cursor-pointer ${
                        editingServiceId === s.id ? 'bg-emerald-50 border-l-4 border-emerald-600' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <span
                          className="w-3.5 h-3.5 rounded-full shrink-0"
                          style={{ backgroundColor: s.color }}
                        />
                        <div className="truncate">
                          <div className="font-black text-slate-800 truncate">{s.name}</div>
                          <div className="text-[10px] text-slate-500">
                            {s.jobs.length} sub-tarefa(s) • {s.defaultDuration}d úteis • Linha {s.defaultLine}
                          </div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateLobMetadataFast((prev) => ({
                            ...prev,
                            services: prev.services.filter((x) => x.id !== s.id),
                            activities: prev.activities.filter((a) => a.serviceId !== s.id),
                          }));
                        }}
                        className="text-rose-500 hover:bg-rose-50 p-1 rounded"
                      >
                        🗑️
                      </button>
                    </div>
                  ))}
                </div>

                <div className="p-2.5 bg-slate-50 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => openServiceModal(undefined)}
                    className="w-full py-2 rounded-lg bg-slate-800 text-white font-black uppercase"
                  >
                    + Novo Pacote em Branco
                  </button>
                </div>
              </div>

              <div className="lg:col-span-7 space-y-4">
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="font-black uppercase text-slate-800">
                    {editingServiceId ? 'Editar Pacote Selecionado' : 'Criar Novo Pacote de Trabalho'}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Nome do Pacote (Macroatividade)
                      </label>
                      <input
                        type="text"
                        value={pkgName}
                        onChange={(e) => setPkgName(e.target.value)}
                        placeholder="Ex: ESTRUTURA, ALVENARIA, INSTALAÇÕES..."
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-bold uppercase"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Sub-linha na LOB (1-5)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={pkgDefaultLine}
                        onChange={(e) => setPkgDefaultLine(Number(e.target.value))}
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono font-bold"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Cor da Barra na Linha de Balanço
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {PACKAGE_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setPkgColor(c)}
                          style={{ backgroundColor: c }}
                          className={`w-6 h-6 rounded-full ${
                            pkgColor === c ? 'ring-2 ring-offset-2 ring-slate-900 scale-110' : 'opacity-80'
                          }`}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Equipe Responsável Padrão
                      </label>
                      <input
                        type="text"
                        value={pkgDefaultResp}
                        onChange={(e) => setPkgDefaultResp(e.target.value)}
                        placeholder="Ex: EQUIPE ESTRUTURA"
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-bold uppercase"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                        Custo / Peso Padrão por Pav. (R$)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={500}
                        value={pkgDefaultCost}
                        onChange={(e) => setPkgDefaultCost(Number(e.target.value))}
                        className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono font-bold"
                      />
                    </div>
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-3">
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-black uppercase text-slate-800">
                        Sub-tarefas / Serviços Internos ({pkgJobs.length})
                      </div>
                      <div className="text-[10px] text-slate-500">
                        Estes serviços serão disponibilizados no Planejamento Semanal (Curto Prazo).
                      </div>
                    </div>
                    <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                      <input
                        type="checkbox"
                        checked={pkgAutoChain}
                        onChange={(e) => setPkgAutoChain(e.target.checked)}
                        className="accent-emerald-700"
                      />
                      Encadear Fim-Início
                    </label>
                  </div>

                  <div className="grid grid-cols-12 gap-2">
                    <input
                      type="text"
                      value={newJobName}
                      onChange={(e) => setNewJobName(e.target.value)}
                      placeholder="Nome do serviço (ex: Fôrma, Armadura, Concretagem)"
                      className="col-span-5 p-2 border border-slate-200 rounded-lg font-bold uppercase"
                    />
                    <input
                      type="number"
                      min={1}
                      value={newJobDuration}
                      onChange={(e) => setNewJobDuration(Number(e.target.value))}
                      placeholder="Dias"
                      className="col-span-2 p-2 border border-slate-200 rounded-lg font-mono text-center"
                    />
                    <input
                      type="number"
                      min={0}
                      step={500}
                      value={newJobCost}
                      onChange={(e) => setNewJobCost(Number(e.target.value))}
                      placeholder="Custo R$"
                      className="col-span-3 p-2 border border-slate-200 rounded-lg font-mono text-right"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const clean = newJobName.trim().toUpperCase();
                        if (!clean) return;
                        setPkgJobs((prev) => [
                          ...prev,
                          {
                            id: `job_${slugifySchedule(clean)}_${Date.now().toString(36)}`,
                            name: clean,
                            position: prev.length + 1,
                            defaultDuration: Math.max(1, Number(newJobDuration) || 1),
                            defaultResponsible: (pkgDefaultResp || 'EQUIPE GERAL').toUpperCase(),
                            costWeight: Number(newJobCost) || 0,
                          },
                        ]);
                        setNewJobName('');
                      }}
                      className="col-span-2 py-2 rounded-lg bg-emerald-700 text-white font-black uppercase"
                    >
                      + Add
                    </button>
                  </div>

                  <div className="divide-y divide-slate-100 max-h-44 overflow-y-auto border border-slate-100 rounded-lg">
                    {pkgJobs.map((j, idx) => (
                      <div key={j.id} className="p-2 flex items-center justify-between text-xs">
                        <div className="font-bold text-slate-800">
                          <span className="font-mono text-slate-400 mr-1.5">{idx + 1}.</span>
                          {j.name}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-slate-600">{j.defaultDuration}d úteis</span>
                          <span className="font-mono text-emerald-700">
                            R$ {Number(j.costWeight).toLocaleString('pt-BR')}
                          </span>
                          <button
                            type="button"
                            onClick={() => setPkgJobs((prev) => prev.filter((x) => x.id !== j.id))}
                            className="text-rose-500 font-black"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveServicePackage}
                    className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black uppercase tracking-wider transition"
                  >
                    💾 Salvar Pacote de Trabalho
                  </button>
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="px-5 py-2 rounded-xl bg-slate-800 text-white font-black text-xs uppercase"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 4: LANÇAR RITMO / ESCADINHA EM MASSA (`pace`)
         ===================================================================== */}
      {activeModal === 'pace' && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-3xl overflow-hidden">
            <div className="p-4 bg-indigo-950 text-white flex justify-between items-center">
              <h3 className="text-sm font-black uppercase tracking-wider">
                ⚡ Lançar Macrofluxo / Escadinha de Ritmo na Linha de Balanço
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-slate-300 hover:text-white font-bold text-lg"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-5 max-h-[80vh] overflow-y-auto text-xs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-slate-200 rounded-xl p-3.5 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-black uppercase text-slate-700">
                      1. Locais / Pavimentos ({paceFloorIds.length})
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setPaceFloorIds(orderedFloors.map((f) => f.id))}
                        className="text-[10px] font-black text-indigo-700 uppercase"
                      >
                        Todos
                      </button>
                      <button
                        type="button"
                        onClick={() => setPaceFloorIds([])}
                        className="text-[10px] font-black text-slate-400 uppercase"
                      >
                        Limpar
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1 pb-1">
                    {orderedGroups.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => {
                          const gIds = orderedFloors
                            .filter((f) => f.replicationGroupId === g.id)
                            .map((f) => f.id);
                          setPaceFloorIds(gIds);
                        }}
                        className="px-2 py-0.5 rounded bg-slate-100 hover:bg-indigo-50 text-[10px] font-bold text-slate-700"
                      >
                        Só {g.name}
                      </button>
                    ))}
                  </div>

                  <div className="max-h-44 overflow-y-auto divide-y divide-slate-100 border border-slate-100 rounded-lg p-1">
                    {orderedFloors.map((f) => {
                      const checked = paceFloorIds.includes(f.id);
                      return (
                        <label
                          key={f.id}
                          className="flex items-center gap-2 p-1.5 hover:bg-slate-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setPaceFloorIds((prev) =>
                                e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)
                              )
                            }
                            className="accent-indigo-700"
                          />
                          <span className="font-bold text-slate-800">{f.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="border border-slate-200 rounded-xl p-3.5 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-black uppercase text-slate-700">
                      2. Pacotes em Sequência ({paceServiceIds.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setPaceServiceIds(activeState.services.map((s) => s.id))}
                      className="text-[10px] font-black text-indigo-700 uppercase"
                    >
                      Todos
                    </button>
                  </div>

                  <div className="max-h-52 overflow-y-auto divide-y divide-slate-100 border border-slate-100 rounded-lg p-1">
                    {activeState.services.map((s) => {
                      const checked = paceServiceIds.includes(s.id);
                      return (
                        <label
                          key={s.id}
                          className="flex items-center gap-2 p-1.5 hover:bg-slate-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setPaceServiceIds((prev) =>
                                e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)
                              )
                            }
                            className="accent-indigo-700"
                          />
                          <span
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: s.color }}
                          />
                          <span className="font-bold text-slate-800">{s.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                    Data de Início do 1º Pacote
                  </label>
                  <input
                    type="date"
                    value={paceStartDate}
                    onChange={(e) => setPaceStartDate(e.target.value)}
                    className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                    Simultaneidade (Pavs por vez)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={pacedFloorsCount}
                    onChange={(e) => setPacedFloorsCount(Math.max(1, Number(e.target.value) || 1))}
                    className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                    Sentido da Escadinha
                  </label>
                  <select
                    value={paceDirection}
                    onChange={(e) => setPaceDirection(e.target.value as 'up' | 'down')}
                    className="w-full p-2 bg-white border border-slate-200 rounded-lg font-bold"
                  >
                    <option value="up">⬆️ Subindo (1º → Último)</option>
                    <option value="down">⬇️ Descendo (Topo → Base)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                    Defasagem entre Pacotes (dias úteis)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    value={paceLagDays}
                    onChange={(e) => setPaceLagDays(Number(e.target.value))}
                    className="w-full p-2 bg-white border border-slate-200 rounded-lg font-mono font-bold"
                  />
                </div>

                <div className="sm:col-span-2 flex flex-col justify-center gap-2 pt-2">
                  <label className="flex items-center gap-2 font-bold text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={paceChainFloors}
                      onChange={(e) => setPaceChainFloors(e.target.checked)}
                      className="accent-indigo-700"
                    />
                    Criar predecessora vertical entre pavimentos (Escadinha)
                  </label>
                  <label className="flex items-center gap-2 font-bold text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={paceChainServices}
                      onChange={(e) => setPaceChainServices(e.target.checked)}
                      className="accent-indigo-700"
                    />
                    Criar predecessora horizontal entre pacotes no mesmo pavimento
                  </label>
                </div>
              </div>
            </div>

            <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 font-bold text-xs uppercase"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={paceFloorIds.length === 0 || paceServiceIds.length === 0}
                onClick={() => {
                  const nextState = applyPaceAndGenerateActivities(activeState, {
                    floorIds: paceFloorIds,
                    serviceIds: paceServiceIds,
                    startDate: paceStartDate,
                    pacedFloors: pacedFloorsCount,
                    direction: paceDirection,
                    lagBetweenServicesDays: paceLagDays,
                    chainAcrossServices: paceChainServices,
                    chainAcrossFloors: paceChainFloors,
                  });
                  setLobState(nextState);
                  persistStateToApp(nextState);
                  setActiveModal(null);
                }}
                className="px-5 py-2 rounded-xl bg-indigo-700 hover:bg-indigo-800 text-white font-black text-xs uppercase tracking-wider disabled:opacity-40"
              >
                ⚡ Gerar Malha e Calcular Datas
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          DRAWER LATERAL DIREITO: DETALHES & EDIÇÃO DO PACOTE DE TRABALHO
          Abertura instantânea com 1 clique, sem backdrop escuro, tela 100% visível
         ===================================================================== */}
      {isActivityDrawerOpen && editingActivity && (
        <aside
          ref={activityDrawerRef}
          role="dialog"
          aria-label="Painel de Detalhes da Atividade"
          onClick={(e) => e.stopPropagation()}
          className="fixed top-0 right-0 bottom-0 w-[480px] max-w-[96vw] sm:w-[520px] z-40 bg-white shadow-2xl border-l border-slate-300 flex flex-col select-auto text-slate-800 animate-in slide-in-from-right duration-200"
          style={{
            boxShadow: '-8px 0 32px -4px rgba(0, 0, 0, 0.22)',
          }}
        >
          {/* Cabeçalho do Drawer */}
          <div className="p-4 bg-slate-900 text-white flex items-start justify-between gap-3 shadow-sm border-b border-slate-800">
            <div className="flex items-center gap-2.5 min-w-0">
              <span
                className="w-4 h-4 rounded-full flex-shrink-0 ring-2 ring-white/30"
                style={{
                  backgroundColor:
                    serviceMap.get(editingActivity.serviceId)?.color || '#10b981',
                }}
              />
              <div className="min-w-0">
                <h3 className="text-sm font-black uppercase tracking-wider truncate">
                  {editingActivity.id.startsWith('draft_')
                    ? '➕ Nova Atividade'
                    : serviceMap.get(editingActivity.serviceId)?.name || 'Pacote de Trabalho'}
                </h3>
                <div className="text-[11px] text-slate-400 font-medium truncate flex items-center gap-1.5 mt-0.5">
                  <span className="font-bold text-slate-300">
                    {floorMap.get(editingActivity.floorId)?.name || 'Local'}
                  </span>
                  <span>•</span>
                  <span>Sub-linha #{editingActivity.line || 1}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => {
                  setIsActivityDrawerOpen(false);
                  setEditingActivity(null);
                }}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition font-bold text-base"
                title="Fechar painel lateral (Esc)"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Faixa Resumo do Pacote */}
          <div className="bg-slate-100/90 border-b border-slate-200 px-4 py-2 flex items-center justify-between text-[11px] font-bold text-slate-700">
            <div className="flex items-center gap-2">
              <span className="text-slate-500 font-normal">Período:</span>
              <span className="font-mono">{formatDateBRShort(editingActivity.start)} → {formatDateBRShort(editingActivity.end)}</span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono text-[10px] font-black">
                {editingActivity.duration}d úteis
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500 font-normal">Avanço:</span>
              <span className="font-black text-indigo-700 font-mono">
                {Math.round(editingActivity.progress || 0)}%
              </span>
            </div>
          </div>

          {/* Navegação por Abas */}
          <div className="flex border-b border-slate-200 bg-slate-50 px-3 pt-2 gap-1 text-[11px] font-black uppercase overflow-x-auto">
            {(
              [
                { id: 'general', label: '1. Geral' },
                { id: 'jobs', label: `2. Tarefas (${editingActivity.jobs?.length || 0})` },
                {
                  id: 'dependencies',
                  label: `3. Predecessoras (${(editingActivity.predecessorIds?.length || 0) + (editingActivity.dependencyRules?.length || 0)})`,
                },
                { id: 'replicate', label: '4. Ações' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActivityModalTab(t.id)}
                className={`px-3 py-2 rounded-t-lg transition whitespace-nowrap ${
                  activityModalTab === t.id
                    ? 'bg-white text-emerald-800 border border-b-0 border-slate-200 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-4 flex-1 overflow-y-auto text-xs space-y-4">
            {activityModalTab === 'general' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Pacote de Trabalho (Macroatividade)
                    </label>
                    <select
                      value={editingActivity.serviceId}
                      onChange={(e) => {
                        const nextPkg = serviceMap.get(e.target.value);
                        if (!nextPkg) return;
                        setEditingActivity((prev) =>
                          prev
                            ? syncActivityJobs(
                                {
                                  ...prev,
                                  serviceId: nextPkg.id,
                                  line: nextPkg.defaultLine || prev.line,
                                  responsible: nextPkg.defaultResponsible || prev.responsible,
                                  cost: nextPkg.defaultTotalCost || prev.cost,
                                  jobs: [],
                                },
                                nextPkg,
                                activeState.calendar,
                                'from-jobs'
                              )
                            : null
                        );
                      }}
                      className="w-full p-2.5 bg-white border border-slate-200 rounded-xl font-bold"
                    >
                      {activeState.services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Sub-linha Visual no Pavimento (1..10)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={editingActivity.line}
                      onChange={(e) =>
                        setEditingActivity((prev) =>
                          prev ? { ...prev, line: Math.max(1, Number(e.target.value) || 1) } : null
                        )
                      }
                      className="w-full p-2.5 bg-white border border-slate-200 rounded-xl font-mono font-bold"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="text-[10px] font-black uppercase text-slate-500">
                      Local(is) / Pavimento(s) Selecionado(s) ({createTargetFloorIds.length})
                    </label>
                    <div className="flex gap-2">
                      {orderedGroups.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() =>
                            setCreateTargetFloorIds(
                              orderedFloors
                                .filter((f) => f.replicationGroupId === g.id)
                                .map((f) => f.id)
                            )
                          }
                          className="text-[10px] font-bold text-emerald-700 hover:underline"
                        >
                          + Todos {g.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-32 overflow-y-auto p-2.5 bg-slate-50 rounded-xl border border-slate-200">
                    {orderedFloors.map((f) => {
                      const checked = createTargetFloorIds.includes(f.id);
                      return (
                        <label key={f.id} className="flex items-center gap-1.5 cursor-pointer truncate">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              setCreateTargetFloorIds((prev) =>
                                e.target.checked
                                  ? [...prev, f.id]
                                  : prev.filter((x) => x !== f.id)
                              )
                            }
                            className="accent-emerald-700"
                          />
                          <span className="font-bold text-slate-700 truncate">{f.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Data de Início
                    </label>
                    <input
                      type="date"
                      value={editingActivity.start}
                      onChange={(e) => {
                        const pkg = serviceMap.get(editingActivity.serviceId);
                        setEditingActivity((prev) =>
                          prev
                            ? syncActivityJobs(
                                { ...prev, start: e.target.value },
                                pkg,
                                activeState.calendar,
                                'from-jobs'
                              )
                            : null
                        );
                      }}
                      className="w-full p-2 border border-slate-200 rounded-xl font-mono font-bold text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Duração (Dias Úteis)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={editingActivity.duration}
                      onChange={(e) => {
                        const pkg = serviceMap.get(editingActivity.serviceId);
                        const dur = Math.max(1, Number(e.target.value) || 1);
                        setEditingActivity((prev) =>
                          prev
                            ? syncActivityJobs(
                                { ...prev, duration: dur },
                                pkg,
                                activeState.calendar,
                                'scale-to-activity'
                              )
                            : null
                        );
                      }}
                      className="w-full p-2 border border-slate-200 rounded-xl font-mono font-bold text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Término Calculado
                    </label>
                    <input
                      type="date"
                      value={editingActivity.end}
                      readOnly
                      className="w-full p-2 border border-slate-200 rounded-xl font-mono bg-slate-100 text-slate-600 text-xs"
                    />
                  </div>
                </div>

                {/* Avanço Físico (% Realizado) */}
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-[10px] font-black uppercase text-slate-500">
                      Avanço Físico (% Realizado)
                    </label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={Math.round(editingActivity.progress || 0)}
                        onChange={(e) => {
                          const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                          setEditingActivity((prev) => {
                            if (!prev) return null;
                            return {
                              ...prev,
                              progress: val,
                              jobs: (prev.jobs || []).map((j) => ({ ...j, progress: val })),
                            };
                          });
                        }}
                        className="w-16 p-1 border border-slate-300 rounded font-mono font-bold text-center text-xs"
                      />
                      <span className="font-bold text-slate-600 text-xs">%</span>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(editingActivity.progress || 0)}
                    onChange={(e) => {
                      const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                      setEditingActivity((prev) => {
                        if (!prev) return null;
                        return {
                          ...prev,
                          progress: val,
                          jobs: (prev.jobs || []).map((j) => ({ ...j, progress: val })),
                        };
                      });
                    }}
                    className="w-full accent-emerald-600 cursor-pointer"
                  />
                  <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-emerald-600 h-full transition-all"
                      style={{ width: `${Math.round(editingActivity.progress || 0)}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Equipe / Empreiteiro Responsável
                    </label>
                    <input
                      type="text"
                      value={editingActivity.responsible}
                      onChange={(e) => {
                        const resp = e.target.value.toUpperCase();
                        setEditingActivity((prev) =>
                          prev
                            ? {
                                ...prev,
                                responsible: resp,
                                jobs: prev.jobs.map((j) => ({ ...j, responsible: resp })),
                              }
                            : null
                        );
                      }}
                      className="w-full p-2 border border-slate-200 rounded-xl font-bold uppercase text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-black uppercase text-slate-500 mb-1">
                      Custo / Peso Total no Pavimento (R$)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={500}
                      value={editingActivity.cost}
                      onChange={(e) => {
                        const c = Math.max(0, Number(e.target.value) || 0);
                        setEditingActivity((prev) => {
                          if (!prev) return null;
                          const count = Math.max(1, prev.jobs.length);
                          const perJob = Math.round((c / count) * 100) / 100;
                          return {
                            ...prev,
                            cost: c,
                            jobs: prev.jobs.map((j) => ({ ...j, cost: perJob })),
                          };
                        });
                      }}
                      className="w-full p-2 border border-slate-200 rounded-xl font-mono font-bold text-xs"
                    />
                  </div>
                </div>
              </div>
            )}

            {activityModalTab === 'jobs' && (
              <div className="space-y-3">
                <div className="text-[11px] text-slate-500">
                  Gerencie os serviços detalhados deste pacote no pavimento.
                </div>

                <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                  {editingActivity.jobs.map((job, idx) => (
                    <div key={job.id} className="p-3 bg-white flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-1 min-w-[180px]">
                        <span className="font-mono text-slate-400">{idx + 1}.</span>
                        <input
                          type="text"
                          value={job.name}
                          onChange={(e) => {
                            const val = e.target.value.toUpperCase();
                            setEditingActivity((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    jobs: prev.jobs.map((j, i) => (i === idx ? { ...j, name: val } : j)),
                                  }
                                : null
                            );
                          }}
                          className="flex-1 p-1.5 border border-slate-200 rounded font-bold uppercase text-xs"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-slate-400">Dias:</label>
                        <input
                          type="number"
                          min={1}
                          value={job.duration}
                          onChange={(e) => {
                            const d = Math.max(1, Number(e.target.value) || 1);
                            const pkg = serviceMap.get(editingActivity.serviceId);
                            setEditingActivity((prev) => {
                              if (!prev) return null;
                              const nextJobs = prev.jobs.map((j, i) =>
                                i === idx ? { ...j, duration: d } : j
                              );
                              return syncActivityJobs(
                                { ...prev, jobs: nextJobs },
                                pkg,
                                activeState.calendar,
                                'from-jobs'
                              );
                            });
                          }}
                          className="w-14 p-1.5 border border-slate-200 rounded font-mono text-center text-xs"
                        />

                        <label className="text-[10px] text-slate-400">R$:</label>
                        <input
                          type="number"
                          min={0}
                          step={100}
                          value={job.cost}
                          onChange={(e) => {
                            const c = Math.max(0, Number(e.target.value) || 0);
                            const pkg = serviceMap.get(editingActivity.serviceId);
                            setEditingActivity((prev) => {
                              if (!prev) return null;
                              const nextJobs = prev.jobs.map((j, i) =>
                                i === idx ? { ...j, cost: c } : j
                              );
                              return syncActivityJobs(
                                { ...prev, jobs: nextJobs },
                                pkg,
                                activeState.calendar,
                                'from-jobs'
                              );
                            });
                          }}
                          className="w-20 p-1.5 border border-slate-200 rounded font-mono text-right text-xs"
                        />

                        {editingActivity.jobs.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              const pkg = serviceMap.get(editingActivity.serviceId);
                              setEditingActivity((prev) => {
                                if (!prev) return null;
                                const nextJobs = prev.jobs.filter((_, i) => i !== idx);
                                return syncActivityJobs(
                                  { ...prev, jobs: nextJobs },
                                  pkg,
                                  activeState.calendar,
                                  'from-jobs'
                                );
                              });
                            }}
                            className="text-rose-500 hover:text-rose-700 font-black px-1 text-sm"
                            title="Remover sub-tarefa"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const pkg = serviceMap.get(editingActivity.serviceId);
                    setEditingActivity((prev) => {
                      if (!prev) return null;
                      const nextJobs: LobActivityJob[] = [
                        ...prev.jobs,
                        {
                          id: `lob_job_extra_${Date.now().toString(36)}`,
                          name: 'NOVO SERVIÇO',
                          duration: 2,
                          start: prev.end,
                          end: prev.end,
                          cost: 1000,
                          responsible: prev.responsible,
                          progress: 0,
                          predecessors: [],
                          successors: [],
                        },
                      ];
                      return syncActivityJobs(
                        { ...prev, jobs: nextJobs },
                        pkg,
                        activeState.calendar,
                        'from-jobs'
                      );
                    });
                  }}
                  className="px-3.5 py-2 rounded-xl bg-slate-800 text-white font-black uppercase text-[11px] hover:bg-slate-700 transition"
                >
                  + Adicionar Sub-tarefa neste Local
                </button>
              </div>
            )}

            {activityModalTab === 'dependencies' && (
              <div className="space-y-5">
                {/* SEÇÃO 1: ATIVIDADES PREDECESSORAS DIRETAS (CRONOGRAMA & LINHA DE BALANÇO) */}
                <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-black text-slate-800 uppercase text-xs">
                        1. Atividades Predecessoras Diretas ({editingActivity.predecessorIds?.length || 0})
                      </h4>
                      <p className="text-[11px] text-slate-500">
                        Atividades específicas que devem ser concluídas para que este pacote possa iniciar.
                      </p>
                    </div>
                    {editingActivity.predecessorIds && editingActivity.predecessorIds.length > 0 && (
                      <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-black">
                        {editingActivity.predecessorIds.length} vinculada(s)
                      </span>
                    )}
                  </div>

                  {/* LISTA DAS PREDECESSORAS ATIVAS */}
                  {editingActivity.predecessorIds && editingActivity.predecessorIds.length > 0 ? (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {editingActivity.predecessorIds.map((predId) => {
                        const predAct = activityMap.get(predId);
                        const predPkg = predAct ? serviceMap.get(predAct.serviceId) : null;
                        const predFloor = predAct ? floorMap.get(predAct.floorId) : null;
                        return (
                          <div
                            key={predId}
                            className="p-3 bg-slate-50 hover:bg-slate-100/90 rounded-xl border border-slate-200 flex items-center justify-between gap-3 transition"
                          >
                            <div className="flex items-center gap-2.5 min-w-0 pr-2">
                              <span
                                className="w-3.5 h-3.5 rounded-full shrink-0 shadow-xs ring-1 ring-white"
                                style={{ backgroundColor: predPkg?.color || '#0284c7' }}
                              />
                              <div className="truncate">
                                <div className="font-bold text-slate-800 text-xs truncate">
                                  {predPkg?.name || predId}
                                </div>
                                <div className="text-[10px] text-slate-500 flex flex-wrap items-center gap-2 mt-0.5">
                                  <span className="font-bold text-slate-700">
                                    📍 {predFloor?.name || 'Local'}
                                  </span>
                                  {predAct && (
                                    <>
                                      <span>•</span>
                                      <span className="font-mono text-slate-600">
                                        📅 {formatDateBRShort(predAct.start)} → {formatDateBRShort(predAct.end)}
                                      </span>
                                      <span>•</span>
                                      <span className="font-mono text-emerald-700 font-bold">
                                        {predAct.duration}d úteis
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => {
                                setEditingActivity((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        predecessorIds: (prev.predecessorIds || []).filter((id) => id !== predId),
                                      }
                                    : null
                                );
                              }}
                              className="px-2.5 py-1 text-rose-600 hover:text-white hover:bg-rose-600 rounded-lg text-xs font-black transition border border-rose-200 hover:border-rose-600 shrink-0"
                              title="Remover vínculo de predecessora"
                            >
                              ✕ Desvincular
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-200 text-center text-slate-500 text-xs">
                      Nenhuma atividade predecessora direta vinculada a este pacote no momento.
                    </div>
                  )}

                  {/* FORMULÁRIO DE VINCULAÇÃO DIRETA */}
                  <div className="pt-3 border-t border-slate-200 space-y-2">
                    <span className="text-[10px] font-black uppercase text-indigo-700 tracking-wider block">
                      + Vincular Nova Atividade Predecessora Direta:
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                      <div className="sm:col-span-5">
                        <select
                          value={directPredFloorId || editingActivity.floorId || ''}
                          onChange={(e) => setDirectPredFloorId(e.target.value)}
                          className="w-full p-2 bg-white border border-slate-200 rounded-lg text-xs font-bold truncate"
                        >
                          <option value="">Selecione o Pavimento / Local...</option>
                          {orderedFloors.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="sm:col-span-5">
                        <select
                          value={directPredServiceId || activeState.services[0]?.id || ''}
                          onChange={(e) => setDirectPredServiceId(e.target.value)}
                          className="w-full p-2 bg-white border border-slate-200 rounded-lg text-xs font-bold truncate"
                        >
                          <option value="">Selecione o Pacote de Trabalho...</option>
                          {activeState.services.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="sm:col-span-2">
                        <button
                          type="button"
                          onClick={() => {
                            const targetFloor = directPredFloorId || editingActivity.floorId;
                            const targetService = directPredServiceId || activeState.services[0]?.id;
                            if (!targetFloor || !targetService) return;

                            const foundAct = activeState.activities.find(
                              (a) => a.floorId === targetFloor && a.serviceId === targetService
                            );

                            if (!foundAct) {
                              alert('Nenhuma atividade encontrada para este pacote no pavimento selecionado. Crie a atividade primeiro ou selecione outro pavimento.');
                              return;
                            }

                            if (foundAct.id === editingActivity.id) {
                              alert('Uma atividade não pode ser predecessora de si mesma.');
                              return;
                            }

                            const currentPreds = editingActivity.predecessorIds || [];
                            if (currentPreds.includes(foundAct.id)) {
                              alert('Esta atividade já está vinculada como predecessora.');
                              return;
                            }

                            setEditingActivity((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    predecessorIds: [...currentPreds, foundAct.id],
                                  }
                                : null
                            );
                          }}
                          className="w-full py-2 bg-indigo-700 hover:bg-indigo-800 text-white font-black text-xs uppercase rounded-lg transition shadow-xs whitespace-nowrap"
                        >
                          + Vincular
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* SEÇÃO 2: REGRAS PARAMÉTRICAS DE PREDECESSÃO (ESTILO PREVISION) */}
                <div className="p-4 rounded-xl bg-indigo-50/70 border border-indigo-200 space-y-3">
                  <div className="font-black uppercase text-indigo-950 text-xs">
                    2. Regras Paramétricas de Predecessora (Estilo Prevision)
                  </div>
                  <p className="text-[11px] text-indigo-800/80">
                    Define regras dinâmicas que recalculam as datas automaticamente sempre que os pavimentos ou o ritmo mudarem.
                  </p>

                  <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-slate-800">
                    <select
                      value={newRulePredAttr}
                      onChange={(e) => setNewRulePredAttr(e.target.value as 'start' | 'end')}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg"
                    >
                      <option value="start">Início</option>
                      <option value="end">Término</option>
                    </select>

                    <input
                      type="number"
                      min={0}
                      max={120}
                      value={newRuleDelay}
                      onChange={(e) => setNewRuleDelay(Math.max(0, Number(e.target.value) || 0))}
                      className="w-16 p-1.5 bg-white border border-slate-200 rounded-lg font-mono text-center"
                    />
                    <span>dia(s) útil(eis)</span>

                    <select
                      value={newRuleTimeOp}
                      onChange={(e) => setNewRuleTimeOp(e.target.value as 'after' | 'before')}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg"
                    >
                      <option value="after">após</option>
                      <option value="before">antes</option>
                    </select>

                    <span>do</span>

                    <select
                      value={newRuleBaseAttr}
                      onChange={(e) => setNewRuleBaseAttr(e.target.value as 'end' | 'start')}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg"
                    >
                      <option value="end">Término</option>
                      <option value="start">Início</option>
                    </select>

                    <span>do pacote</span>

                    <select
                      value={newRulePredServiceId}
                      onChange={(e) => setNewRulePredServiceId(e.target.value)}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg font-black text-indigo-900"
                    >
                      {activeState.services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>

                    <span>no</span>

                    <select
                      value={newRuleFloorDir}
                      onChange={(e) => setNewRuleFloorDir(e.target.value as FloorDirection)}
                      className="p-1.5 bg-white border border-slate-200 rounded-lg font-black text-emerald-800"
                    >
                      <option value="same">Mesmo pavimento</option>
                      <option value="below">Pavimento abaixo (anterior)</option>
                      <option value="above">Pavimento acima (seguinte)</option>
                      <option value="specific">Local específico...</option>
                    </select>

                    {newRuleFloorDir === 'specific' && (
                      <select
                        value={newRuleSpecificFloorId || orderedFloors[0]?.id || ''}
                        onChange={(e) => setNewRuleSpecificFloorId(e.target.value)}
                        className="p-1.5 bg-white border border-slate-200 rounded-lg"
                      >
                        {orderedFloors.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <label className="flex items-center gap-2 font-bold text-indigo-900 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={replicateRuleAcrossGroup}
                        onChange={(e) => setReplicateRuleAcrossGroup(e.target.checked)}
                        className="accent-indigo-700"
                      />
                      Replicar regra para agrupamento
                    </label>

                    <button
                      type="button"
                      onClick={() => {
                        if (!newRulePredServiceId) return;
                        const rule: DependencyRule = {
                          id: `rule_${Date.now().toString(36)}`,
                          precedenceAttribute: newRulePredAttr,
                          delay: newRuleDelay,
                          timeOperation: newRuleTimeOp,
                          baseAttribute: newRuleBaseAttr,
                          predecessorServiceId: newRulePredServiceId,
                          floorDirection: newRuleFloorDir,
                          specificFloorId:
                            newRuleFloorDir === 'specific'
                              ? newRuleSpecificFloorId || orderedFloors[0]?.id
                              : undefined,
                        };
                        setEditingActivity((prev) =>
                          prev
                            ? {
                                ...prev,
                                dependencyRules: [...(prev.dependencyRules || []), rule],
                              }
                            : null
                        );
                      }}
                      className="px-3.5 py-1.5 rounded-xl bg-indigo-700 hover:bg-indigo-800 text-white font-black uppercase text-xs"
                    >
                      + Adicionar Regra
                    </button>
                  </div>

                  {/* LISTA DAS REGRAS PARAMÉTRICAS CONFIGURADAS */}
                  <div className="space-y-2 pt-2 border-t border-indigo-200/60">
                    <div className="font-black uppercase text-indigo-950 text-xs">
                      Regras Paramétricas Configuradas ({editingActivity.dependencyRules?.length || 0})
                    </div>
                    {(editingActivity.dependencyRules || []).map((r) => {
                      const predPkg = serviceMap.get(r.predecessorServiceId);
                      const dirLabel =
                        r.floorDirection === 'same'
                          ? 'no Mesmo pavimento'
                          : r.floorDirection === 'below'
                          ? 'no Pavimento abaixo'
                          : r.floorDirection === 'above'
                          ? 'no Pavimento acima'
                          : `em ${floorMap.get(r.specificFloorId || '')?.name || 'Local específico'}`;

                      return (
                        <div
                          key={r.id}
                          className="p-3 rounded-xl bg-white border border-indigo-200 flex items-center justify-between shadow-xs"
                        >
                          <div className="font-medium text-slate-800">
                            <strong>{r.precedenceAttribute === 'start' ? 'Início' : 'Término'}</strong>{' '}
                            <span className="font-mono font-bold text-indigo-700">{r.delay}d</span>{' '}
                            {r.timeOperation === 'after' ? 'após' : 'antes'} do{' '}
                            <strong>{r.baseAttribute === 'end' ? 'Término' : 'Início'}</strong> de{' '}
                            <span className="px-2 py-0.5 rounded bg-slate-200 font-black">
                              {predPkg?.name || r.predecessorServiceId}
                            </span>{' '}
                            <span className="text-emerald-800 font-bold">{dirLabel}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              setEditingActivity((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      dependencyRules: prev.dependencyRules.filter((x) => x.id !== r.id),
                                    }
                                  : null
                              )
                            }
                            className="text-rose-600 font-black px-2 hover:underline text-xs"
                          >
                            Remover
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {activityModalTab === 'replicate' && (
              <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 space-y-3">
                <div className="font-black uppercase text-rose-900">Excluir Atividade</div>
                <p className="text-rose-700">
                  Você pode remover apenas esta barra neste pavimento ou remover todas as barras deste pacote em todos os pavimentos.
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        activities: prev.activities.filter((a) => a.id !== editingActivity.id),
                      }));
                      setIsActivityDrawerOpen(false);
                      setEditingActivity(null);
                    }}
                    className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-black uppercase text-xs"
                  >
                    🗑️ Excluir Desta Linha
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      updateLobMetadataFast((prev) => ({
                        ...prev,
                        activities: prev.activities.filter(
                          (a) => a.serviceId !== editingActivity.serviceId
                        ),
                      }));
                      setIsActivityDrawerOpen(false);
                      setEditingActivity(null);
                    }}
                    className="px-4 py-2 rounded-xl bg-white border border-rose-300 text-rose-700 hover:bg-rose-100 font-black uppercase text-xs"
                  >
                    🗑️ Excluir Este Pacote de Todos os Pavimentos
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Rodapé com Ações Rápidas */}
          <div className="p-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setIsActivityDrawerOpen(false);
                setEditingActivity(null);
              }}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 font-bold text-xs uppercase"
            >
              Fechar
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleSaveActivityModal(false)}
                className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 border border-slate-300 text-slate-800 font-black text-xs uppercase tracking-wide transition"
                title="Salva alterações na tela mantendo o painel aberto"
              >
                💾 Salvar
              </button>
              <button
                type="button"
                onClick={() => handleSaveActivityModal(true)}
                className="px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs uppercase tracking-wide shadow-sm transition"
                title="Salva alterações e fecha o painel"
              >
                Salvar e Fechar
              </button>
            </div>
          </div>
        </aside>
      )}

      {/* =====================================================================
          MODAL: SALVAR VERSÃO DO CRONOGRAMA & DEFINIR LINHA DE BASE
         ===================================================================== */}
      {isVersionModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200 space-y-4">
            {versionsError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{versionsError}</p>}
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-black text-slate-900 text-sm uppercase tracking-wider flex items-center gap-1.5">
                <span>💾</span> Salvar Versão / Cenário do Cronograma
              </h3>
              <button
                type="button"
                onClick={() => setIsVersionModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              {/* Seleção do Tipo de Versão */}
              <div>
                <label className="font-bold text-slate-700 block mb-1">Tipo de Snapshot:</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {[
                    { id: 'scenario', label: '🧪 Cenário (Simulação)', badge: 'Simulação' },
                    { id: 'backup', label: '💾 Backup de Segurança', badge: 'Segurança' },
                    { id: 'meta', label: '🎯 Cronograma Meta', badge: 'Desafio' },
                    { id: 'baseline', label: '📌 Linha de Base', badge: 'Contratual' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setVerTypeInput(t.id as any);
                        if (t.id === 'baseline') {
                          setVerIsBaselineCheck(true);
                        }
                      }}
                      className={`p-2 rounded-xl border text-left transition cursor-pointer font-bold text-[11px] ${
                        verTypeInput === t.id
                          ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                          : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="font-bold text-slate-700 block mb-1">Nome da Versão / Cenário:</label>
                <input
                  type="text"
                  value={verNameInput}
                  onChange={(e) => setVerNameInput(e.target.value)}
                  placeholder="Ex: Revisão 02 - Aceleração Alvenarias"
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 font-medium outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="font-bold text-slate-700 block mb-1">Responsável / Autor:</label>
                <input
                  type="text"
                  value={verAuthorInput}
                  onChange={(e) => setVerAuthorInput(e.target.value)}
                  placeholder="Ex: Engenharia / Planejamento"
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 font-medium outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="font-bold text-slate-700 block mb-1">Descrição / Justificativa:</label>
                <textarea
                  value={verDescInput}
                  onChange={(e) => setVerDescInput(e.target.value)}
                  rows={2}
                  placeholder="Ex: Reprogramação com antecipação de 15 dias nas instalações..."
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 font-medium outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
                />
              </div>

              <label className="flex items-center gap-2 p-3 bg-amber-50 rounded-xl border border-amber-200 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={verIsBaselineCheck || verTypeInput === 'baseline'}
                  onChange={(e) => setVerIsBaselineCheck(e.target.checked)}
                  disabled={verTypeInput === 'baseline'}
                  className="w-4 h-4 rounded text-amber-600 focus:ring-0 cursor-pointer"
                />
                <div>
                  <span className="font-bold text-amber-900 block">Definir como Nova Linha de Base Oficial</span>
                  <span className="text-[11px] text-amber-700">
                    Esta versão servirá como referência oficial (Curva S baseline e barras fantasma na Linha de Balanço).
                  </span>
                </div>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={() => setIsVersionModalOpen(false)}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-bold text-xs"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={versionsBusy}
                onClick={() => handleCreateNewVersion()}
                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs shadow-md transition"
              >
                Salvar Snapshot
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          DRAWER LATERAL: CENTRAL DE VERSÕES, CENÁRIOS E BASELINES (SLIDE-OVER)
         ===================================================================== */}
      {isVersionDrawerOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden animate-in fade-in duration-200">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-xs transition-opacity"
            onClick={() => setIsVersionDrawerOpen(false)}
          />

          <aside className="absolute inset-y-0 right-0 max-w-full flex pl-10">
            <div className="w-screen max-w-xl bg-white shadow-2xl border-l border-slate-200 flex flex-col">
              {/* Cabeçalho do Drawer */}
              <div className="p-5 bg-slate-900 text-white flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-xl">
                    🏷️
                  </div>
                  <div>
                    <h3 className="font-black text-sm uppercase tracking-wider text-white">
                      Versões & Linhas de Base
                    </h3>
                    <p className="text-[10px] text-slate-400">
                      Cenários de simulação, pontos de restauração e baselines contratuais
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsVersionDrawerOpen(false)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer font-bold text-lg"
                >
                  ✕
                </button>
              </div>

              {/* Corpo do Drawer */}
              <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs">
                {/* 1. CARD DA VERSÃO ATUAL EM VISUALIZAÇÃO */}
                <div className="p-4 rounded-2xl bg-slate-50 border-2 border-indigo-200 space-y-3 shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-wider text-indigo-900 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span>Versão Ativa no Momento (Visualização)</span>
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                        currentActiveVersion?.isBaseline
                          ? 'bg-amber-100 text-amber-800 border border-amber-300'
                          : currentActiveVersion?.type === 'scenario'
                          ? 'bg-purple-100 text-purple-800 border border-purple-300'
                          : currentActiveVersion?.type === 'meta'
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                          : currentActiveVersion?.type === 'backup'
                          ? 'bg-blue-100 text-blue-800 border border-blue-300'
                          : 'bg-slate-200 text-slate-800'
                      }`}
                    >
                      {currentActiveVersion?.isBaseline
                        ? '📌 Linha de Base Oficial'
                        : currentActiveVersion?.type === 'scenario'
                        ? '🧪 Cenário'
                        : currentActiveVersion?.type === 'meta'
                        ? '🎯 Meta'
                        : currentActiveVersion?.type === 'backup'
                        ? '💾 Backup'
                        : '📋 Previsto'}
                    </span>
                  </div>

                  <div>
                    <h4 className="font-black text-base text-slate-900 leading-tight">
                      {currentActiveVersion?.name || 'Versão Inicial'}
                    </h4>
                    <p className="text-slate-600 text-xs mt-1">
                      {currentActiveVersion?.description || 'Cronograma principal sem observações registradas.'}
                    </p>
                  </div>

                  <div className="pt-2 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
                    <div>
                      Salva em:{' '}
                      <strong className="text-slate-700 font-mono">
                        {currentActiveVersion?.createdAt
                          ? new Date(currentActiveVersion.createdAt).toLocaleString('pt-BR')
                          : '-'}
                      </strong>
                    </div>
                    <div>
                      Por:{' '}
                      <strong className="text-slate-700">
                        {currentActiveVersion?.author || 'Engenharia / Planejamento'}
                      </strong>
                    </div>
                  </div>

                  {/* Ações Específicas da Versão Ativa */}
                  <div className="pt-2 flex flex-wrap gap-2">
                    {currentActiveVersion?.type === 'scenario' && (
                      <button
                        type="button"
                        onClick={() => handlePromoteScenario(currentActiveVersion.id)}
                        className="px-3 py-1.5 rounded-xl bg-purple-700 hover:bg-purple-800 text-white font-black text-xs uppercase flex items-center gap-1.5 shadow-sm transition cursor-pointer"
                        title="Aplica este cenário de simulação como o Previsto Oficial da Obra"
                      >
                        <span>⚡ Levar para o Previsto Oficial</span>
                      </button>
                    )}

                    {currentActiveVersion && !currentActiveVersion.isBaseline && (
                      <button
                        type="button"
                        onClick={() => handleMarkAsBaseline(currentActiveVersion.id)}
                        className="px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-slate-950 font-black text-xs uppercase flex items-center gap-1.5 shadow-sm transition cursor-pointer"
                        title="Fixa esta versão como a nova Linha de Base contratual"
                      >
                        <span>📌 Fixar como Linha de Base Oficial</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* 2. TIPOS DE VERSIONAMENTO (CRIAÇÃO RÁPIDA) */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-black text-[11px] uppercase tracking-wider text-slate-700">
                      ⚡ Criar Nova Versão por Tipo
                    </h4>
                    <span className="text-[10px] text-slate-400">Escolha o objetivo do snapshot</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    {/* Cenário */}
                    <button
                      type="button"
                      onClick={() => {
                        setVerTypeInput('scenario');
                        setVerNameInput(`Cenário Simulação 0${scheduleVersions.filter((v) => v.type === 'scenario').length + 1}`);
                        setVerDescInput('Simulação de novo ritmo/sequência para teste de produtividade.');
                        setVerIsBaselineCheck(false);
                        setIsVersionModalOpen(true);
                      }}
                      className="p-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-xl text-left transition cursor-pointer group shadow-2xs"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-base">🧪</span>
                        <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-purple-200/80 text-purple-900">
                          Simulação
                        </span>
                      </div>
                      <div className="font-black text-xs text-purple-950 group-hover:text-purple-700">
                        Cenário Alternativo
                      </div>
                      <p className="text-[10px] text-purple-800/80 leading-tight mt-0.5">
                        Ramifique para testar alterações sem afetar o cronograma oficial.
                      </p>
                    </button>

                    {/* Backup */}
                    <button
                      type="button"
                      onClick={() => {
                        setVerTypeInput('backup');
                        setVerNameInput(`Backup de Segurança ${new Date().toLocaleDateString('pt-BR')}`);
                        setVerDescInput('Snapshot de segurança pré-reprogramação.');
                        setVerIsBaselineCheck(false);
                        setIsVersionModalOpen(true);
                      }}
                      className="p-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-xl text-left transition cursor-pointer group shadow-2xs"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-base">💾</span>
                        <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-blue-200/80 text-blue-900">
                          Segurança
                        </span>
                      </div>
                      <div className="font-black text-xs text-blue-950 group-hover:text-blue-700">
                        Ponto de Backup
                      </div>
                      <p className="text-[10px] text-blue-800/80 leading-tight mt-0.5">
                        Instantâneo para restaurar caso precise desfazer alterações.
                      </p>
                    </button>

                    {/* Meta */}
                    <button
                      type="button"
                      onClick={() => {
                        setVerTypeInput('meta');
                        setVerNameInput(`Cronograma Meta 0${scheduleVersions.filter((v) => v.type === 'meta').length + 1}`);
                        setVerDescInput('Meta interna antecipada com ritmo desafiador.');
                        setVerIsBaselineCheck(false);
                        setIsVersionModalOpen(true);
                      }}
                      className="p-3 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-xl text-left transition cursor-pointer group shadow-2xs"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-base">🎯</span>
                        <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-emerald-200/80 text-emerald-900">
                          Desafio
                        </span>
                      </div>
                      <div className="font-black text-xs text-emerald-950 group-hover:text-emerald-700">
                        Cronograma Meta
                      </div>
                      <p className="text-[10px] text-emerald-800/80 leading-tight mt-0.5">
                        Objetivo de aceleração com folgas reduzidas para antecipar a entrega.
                      </p>
                    </button>

                    {/* Linha de Base */}
                    <button
                      type="button"
                      onClick={() => {
                        setVerTypeInput('baseline');
                        setVerNameInput(`Linha de Base 0${scheduleVersions.filter((v) => v.isBaseline).length + 1}`);
                        setVerDescInput('Marco contratual congelado de aprovação da obra.');
                        setVerIsBaselineCheck(true);
                        setIsVersionModalOpen(true);
                      }}
                      className="p-3 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-xl text-left transition cursor-pointer group shadow-2xs"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-base">📌</span>
                        <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-amber-200/80 text-amber-900">
                          Contratual
                        </span>
                      </div>
                      <div className="font-black text-xs text-amber-950 group-hover:text-amber-700">
                        Linha de Base
                      </div>
                      <p className="text-[10px] text-amber-800/80 leading-tight mt-0.5">
                        Referência oficial para Curva S e barras fantasma na Linha de Balanço.
                      </p>
                    </button>
                  </div>
                </div>

                {/* 3. LISTA DE VERSÕES SALVAS COM BUSCA */}
                <div className="space-y-3 pt-2 border-t border-slate-200">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                    <h4 className="font-black text-[11px] uppercase tracking-wider text-slate-700">
                      📚 Todas as Versões Salvas ({scheduleVersions.length})
                    </h4>
                    <span className="text-[10px] text-slate-400">Clique para ativar ou comparar</span>
                  </div>

                  {/* Campo de Busca */}
                  <div className="relative">
                    <input
                      type="text"
                      value={versionSearchQuery}
                      onChange={(e) => setVersionSearchQuery(e.target.value)}
                      placeholder="🔍 Buscar versões por nome, descrição, tipo ou autor..."
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs font-medium outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white transition"
                    />
                    {versionSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setVersionSearchQuery('')}
                        className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 text-xs font-black"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Lista de cards das versões */}
                  <div className="space-y-2">
                    {scheduleVersions
                      .filter((v) => {
                        if (!versionSearchQuery.trim()) return true;
                        const q = versionSearchQuery.toLowerCase();
                        return (
                          v.name.toLowerCase().includes(q) ||
                          (v.description || '').toLowerCase().includes(q) ||
                          (v.author || '').toLowerCase().includes(q) ||
                          (v.type || '').toLowerCase().includes(q)
                        );
                      })
                      .map((ver) => {
                        const isActive = ver.isActive;
                        return (
                          <div
                            key={ver.id}
                            className={`p-3.5 rounded-xl border transition ${
                              isActive
                                ? 'bg-indigo-50/60 border-indigo-300 shadow-xs ring-1 ring-indigo-200'
                                : 'bg-white hover:bg-slate-50 border-slate-200'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-1">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-sm shrink-0">
                                  {ver.isBaseline
                                    ? '📌'
                                    : ver.type === 'scenario'
                                    ? '🧪'
                                    : ver.type === 'meta'
                                    ? '🎯'
                                    : ver.type === 'backup'
                                    ? '💾'
                                    : '📋'}
                                </span>
                                <h5 className="font-bold text-slate-900 text-xs truncate">
                                  {ver.name}
                                </h5>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {ver.isBaseline && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[9px] font-black uppercase">
                                    Baseline
                                  </span>
                                )}
                                {isActive && (
                                  <span className="px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800 text-[9px] font-black uppercase">
                                    Ativa
                                  </span>
                                )}
                              </div>
                            </div>

                            {ver.description && (
                              <p className="text-[11px] text-slate-500 line-clamp-2 mb-2">
                                {ver.description}
                              </p>
                            )}

                            <div className="flex items-center justify-between text-[10px] text-slate-400 pt-2 border-t border-slate-100">
                              <div className="flex items-center gap-2">
                                <span>{new Date(ver.createdAt).toLocaleDateString('pt-BR')}</span>
                                {ver.author && <span>• {ver.author}</span>}
                              </div>

                              <div className="flex items-center gap-1.5">
                                {!isActive && (
                                  <button
                                    type="button"
                                    onClick={() => handleSwitchScheduleVersion(ver.id)}
                                    className="px-2 py-0.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-[10px] transition cursor-pointer"
                                  >
                                    Visualizar / Ativar
                                  </button>
                                )}

                                {!ver.isBaseline && (
                                  <button
                                    type="button"
                                    onClick={() => handleMarkAsBaseline(ver.id)}
                                    title="Tornar esta versão a Linha de Base Oficial"
                                    className="px-2 py-0.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 font-bold text-[10px] border border-amber-200 transition cursor-pointer"
                                  >
                                    ⭐ Fixar Base
                                  </button>
                                )}

                                {ver.type === 'scenario' && (
                                  <button
                                    type="button"
                                    onClick={() => handlePromoteScenario(ver.id)}
                                    title="Levar este cenário para o previsto oficial"
                                    className="px-2 py-0.5 rounded-lg bg-purple-50 hover:bg-purple-100 text-purple-800 font-bold text-[10px] border border-purple-200 transition cursor-pointer"
                                  >
                                    ⚡ Promover
                                  </button>
                                )}

                                {!ver.isBaseline && scheduleVersions.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (confirm(`Deseja realmente excluir a versão "${ver.name}"?`)) {
                                        handleDeleteScheduleVersion(ver.id);
                                      }
                                    }}
                                    title="Excluir versão"
                                    className="p-1 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded transition cursor-pointer"
                                  >
                                    🗑️
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </div>

              {/* Rodapé do Drawer */}
              <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
                <span className="text-[11px] text-slate-500">
                  {scheduleVersions.length} versões salvas no banco local
                </span>
                <button
                  type="button"
                  onClick={() => setIsVersionDrawerOpen(false)}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-black text-xs uppercase rounded-xl transition cursor-pointer"
                >
                  Fechar
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* =====================================================================
          CRIADOR DE MACROFLUXO DE OBRA (CANVAS MIRO / VISIO)
         ===================================================================== */}
      {isMacroflowModalOpen && (
        <MacroflowCanvasView
          isOpen={isMacroflowModalOpen}
          onClose={() => setIsMacroflowModalOpen(false)}
          currentState={activeState}
          onApplyToSchedule={(nextState, msg) => {
            setLobState(nextState);
            persistStateToApp(nextState, msg);
          }}
          projectName="Obra"
          selectedProjectId={selectedProjectId || undefined}
        />
      )}
    </div>
  );
};
