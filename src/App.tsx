import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';
import * as XLSX from 'xlsx';

declare global {
  interface Window {
    SpeechRecognition?: any;
    webkitSpeechRecognition?: any;
    __firebase_config?: string;
    __app_id?: string;
    __initial_auth_token?: string;
  }
}

// --- Utilitários de Data e Dados ---
const cloneDeep = (value) => JSON.parse(JSON.stringify(value ?? {}));

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

const toLocalDateString = (date = new Date()) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const getTodayDateString = () => toLocalDateString(new Date());

const parseExcelDate = (value, fallback = getTodayDateString()) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return toLocalDateString(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + Math.floor(value));
    return toLocalDateString(epoch);
  }
  const text = String(value).trim();
  const br = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (br) {
    const [, d, m, y] = br;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? fallback : toLocalDateString(parsed);
};

const parsePercent = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return clampPercent(value <= 1 ? value * 100 : value);
  const normalized = String(value).replace('%', '').replace(',', '.').trim();
  const n = Number(normalized);
  if (!Number.isFinite(n)) return 0;
  return clampPercent(n <= 1 ? n * 100 : n);
};

const getWeekStartDate = (date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
};

const formatDateBR = (isoString) => {
  if (!isoString) return '';
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR');
};

const formatTimestamp = (ts) => {
  if (!ts) return '';
  let date;
  if (typeof ts.toDate === 'function') {
    date = ts.toDate();
  } else if (ts instanceof Date) {
    date = ts;
  } else if (ts && typeof ts === 'object' && ts.seconds !== undefined) {
    date = new Date(ts.seconds * 1000);
  } else {
    date = new Date(ts);
  }
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR');
};


// --- Componente Inteligente: Selecionador de Dias Arrastável ---
const DaysSelector = ({ dailyWork, disabled, onChange }) => {
  const [localDW, setLocalDW] = useState(dailyWork || [0, 0, 0, 0, 0]);
  const localDWRef = useRef(dailyWork || [0, 0, 0, 0, 0]);
  const isDragging = useRef(false);
  const dragValue = useRef(1);

  useEffect(() => {
    localDWRef.current = dailyWork || [0, 0, 0, 0, 0];
    setLocalDW(dailyWork || [0, 0, 0, 0, 0]);
  }, [dailyWork]);

  const startDrag = (i) => {
    if (disabled) return;
    isDragging.current = true;
    const newVal = localDWRef.current[i] === 1 ? 0 : 1;
    dragValue.current = newVal;
    const newDW = [...localDWRef.current];
    newDW[i] = newVal;
    localDWRef.current = newDW;
    setLocalDW(newDW);

    const stopDrag = () => {
      if (isDragging.current) {
        isDragging.current = false;
        onChange(localDWRef.current);
      }
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('touchend', stopDrag);
    };
    
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('touchend', stopDrag);
  };

  const enterDrag = (i) => {
    if (!isDragging.current || disabled) return;
    if (localDWRef.current[i] === dragValue.current) return;
    const newDW = [...localDWRef.current];
    newDW[i] = dragValue.current;
    localDWRef.current = newDW;
    setLocalDW(newDW);
  };

  const handleTouchMove = (e) => {
    if (!isDragging.current || disabled) return;
    const touch = e.touches[0];
    const elem = document.elementFromPoint(touch.clientX, touch.clientY);
    if (elem) {
      const btn = elem.closest('[data-day-index]') as HTMLElement;
      if (btn) {
        const i = parseInt(btn.dataset.dayIndex, 10);
        enterDrag(i);
      }
    }
  };

  return (
    <div className="flex gap-1 justify-center touch-none select-none" onTouchMove={handleTouchMove}>
      {localDW.map((dw, i) => (
        <div
          key={i}
          data-day-index={i}
          onPointerDown={(e) => { e.preventDefault(); startDrag(i); }}
          onPointerEnter={() => enterDrag(i)}
          className={`w-8 h-8 rounded-full text-[9px] font-black flex items-center justify-center transition-all cursor-pointer ${
            dw === 1 ? 'bg-slate-300 text-slate-800 scale-110 shadow-inner' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
          } ${disabled ? 'opacity-60 cursor-not-allowed pointer-events-none' : ''}`}
        >
          {['S','T','Q','Q','S'][i]}
        </div>
      ))}
    </div>
  );
};

// --- Algoritmo de Sincronização e Recálculo ---
const serializeCrono = (cronoArray) => {
  if (!Array.isArray(cronoArray)) return [];
  return cronoArray.map(item => {
    if (Array.isArray(item)) return item;
    return [
      item.id || '',
      item.macro || '',
      item.floor || '',
      item.service || '',
      Number(item.duration) || 0,
      item.start || '',
      item.end || '',
      Number(item.cost) || 0,
      item.responsible || '',
      Number(item.progress) || 0
    ];
  });
};

const deserializeCrono = (tuplesArray) => {
  if (!Array.isArray(tuplesArray)) return [];
  return tuplesArray.map(t => {
    if (t && typeof t === 'object' && !Array.isArray(t)) return t;
    return {
      id: t[0] || '',
      macro: t[1] || '',
      floor: t[2] || '',
      service: t[3] || '',
      duration: Number(t[4]) || 0,
      start: t[5] || '',
      end: t[6] || '',
      cost: Number(t[7]) || 0,
      responsible: t[8] || '',
      progress: Number(t[9]) || 0
    };
  });
};

const roundDown25 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n >= 100) return 100;
  if (n >= 75) return 75;
  if (n >= 50) return 50;
  if (n >= 25) return 25;
  return 0;
};

const syncPlanningAndPhysical = (currentPlanning, floorsData, cronogramaInicial = []) => {
  const sortedPlanning = [...currentPlanning].sort((a, b) => a.weekId.localeCompare(b.weekId));
  const cumulativeProgress = {};
  
  const recalculatedPlanning = sortedPlanning.map(task => {
    const key = `${task.floor}||${task.sectionId}||${task.itemId}`;
    if (cumulativeProgress[key] === undefined) {
      cumulativeProgress[key] = roundDown25(task.executedBefore || 0);
    }
    const updatedTask = { ...task, executedBefore: cumulativeProgress[key] };
    cumulativeProgress[key] = Math.min(100, cumulativeProgress[key] + (task.progressThisWeek || 0));
    return updatedTask;
  });

  const updatedFloorsData = cloneDeep(floorsData);
  
  // Mapear avanços realizados do planejamento
  Object.keys(cumulativeProgress).forEach(key => {
    const [floor, sectionId, itemId] = key.split('||');
    if (updatedFloorsData[floor] && updatedFloorsData[floor][sectionId]) {
      const items = updatedFloorsData[floor][sectionId].items || [];
      const item = items.find(i => i.id === itemId);
      if (item) {
        item._realized = cumulativeProgress[key];
      }
    }
  });

  // Garantir que andamento atual seja o maior entre cronograma e realizado
  Object.keys(updatedFloorsData).forEach(floor => {
    if (updatedFloorsData[floor]) {
      Object.keys(updatedFloorsData[floor]).forEach(sectionId => {
        const section = updatedFloorsData[floor][sectionId];
        if (section && Array.isArray(section.items)) {
          section.items.forEach(item => {
            if (!item) return;
            const cronoItem = cronogramaInicial.find(c => c && c.id === item.id) ||
              cronogramaInicial.find(c => c && c.floor === floor && slugify(c.macro) === sectionId && String(c.service || '').toUpperCase() === String(item.name || '').toUpperCase());
            const cronoProgress = cronoItem ? (cronoItem.progress || 0) : 0;
            const realizedProgress = item._realized !== undefined ? item._realized : 0;
            item.actualPercent = clampPercent(Math.max(cronoProgress, realizedProgress));
            delete item._realized;
          });
        }
      });
    }
  });

  return { recalculatedPlanning, updatedFloorsData };
};

const syncCronogramaWithFloorsData = (currentCrono, floorsList, floorsData) => {
  const baseCrono = Array.isArray(currentCrono) ? currentCrono : [];
  
  // 1. Build a map of valid items currently in floorsData
  const validKeys = new Set();
  (floorsList || []).forEach(floor => {
    const floorData = floorsData[floor] || {};
    Object.keys(floorData).forEach(macroKey => {
      const section = floorData[macroKey];
      if (!section) return;
      const items = section.items || [];
      items.forEach(item => {
        if (item) {
          const key = `${floor}||${macroKey}||${String(item.name || '').toUpperCase()}`;
          validKeys.add(key);
        }
      });
    });
  });
  
  // 2. Filter out any crono items that are no longer valid (deleted in config)
  const filteredCrono = baseCrono.filter(c => {
    if (!c) return false;
    const key = `${c.floor}||${slugify(c.macro)}||${String(c.service || '').toUpperCase()}`;
    return validKeys.has(key);
  });
  
  // 3. Add any items from floorsData that are missing in crono
  const finalCrono = [...filteredCrono];
  
  (floorsList || []).forEach(floor => {
    const floorData = floorsData[floor] || {};
    Object.keys(floorData).forEach(macroKey => {
      const section = floorData[macroKey];
      if (!section) return;
      const macroTitle = section.title || macroKey.toUpperCase();
      const items = section.items || [];
      
      items.forEach(item => {
        if (!item) return;
        const exists = finalCrono.some(c => 
          c && 
          c.floor === floor && 
          slugify(c.macro) === macroKey && 
          String(c.service || '').toUpperCase() === String(item.name || '').toUpperCase()
        );
        
        if (!exists) {
          const todayStr = toLocalDateString(new Date());
          const fiveDaysLaterStr = toLocalDateString(addDays(new Date(), 5));
          finalCrono.push({
            id: item.id || `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            macro: macroTitle,
            floor: floor,
            service: item.name,
            duration: 5,
            start: todayStr,
            end: fiveDaysLaterStr,
            cost: 0,
            responsible: 'EQUIPA GERAL',
            progress: item.actualPercent || 0
          });
        }
      });
    });
  });
  
  return finalCrono;
};


// --- Componentes Visuais Simples ---
const StatCard = ({ title, value, color }) => (
  <div className={`p-4 rounded-xl shadow-md ${color} text-white transform hover:scale-[1.01] transition-transform duration-300`}>
    <p className="text-[10px] font-bold uppercase tracking-wider opacity-80">{title}</p>
    <p className="text-2xl font-black mt-1">{value}</p>
  </div>
);

const Notification = ({ message, type, onClose }) => {
  if (!message) return null;
  return (
    <div className={`fixed bottom-4 right-4 p-4 rounded-xl shadow-2xl text-white z-50 flex items-center gap-3 ${type === 'success' ? 'bg-emerald-600' : 'bg-red-600'} animate-in slide-in-from-bottom-5 fade-in duration-300`}>
      <span className="font-bold text-xs">{message}</span>
      <button onClick={onClose} className="font-bold text-lg leading-none">&times;</button>
    </div>
  );
};

// --- Configuração Firebase & Constantes ---
const firebaseConfig = (import.meta.env.VITE_FIREBASE_CONFIG ? JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG) : (typeof window.__firebase_config !== 'undefined' ? JSON.parse(window.__firebase_config) : {}));
const appId = import.meta.env.VITE_APP_ID || (typeof window.__app_id !== 'undefined' ? window.__app_id : 'obra-app');
const initialAuthToken = import.meta.env.VITE_INITIAL_AUTH_TOKEN || (typeof window.__initial_auth_token !== 'undefined' ? window.__initial_auth_token : null);

const INITIAL_PAVIMENTOS = ['Térreo', 'Pav. Tipo 1', 'Pav. Tipo 2', 'Pav. Cobertura'];
const INITIAL_STRUCTURE = {
  'estrutura': { title: 'ESTRUTURA', items: [{ id: 'forma', name: 'FORMA', actualPercent: 0 }, { id: 'armadura', name: 'ARMADURA', actualPercent: 0 }] },
  'instalacoes': { title: 'INSTALAÇÕES', items: [{ id: 'hidraulica', name: 'HIDRÁULICA', actualPercent: 0 }, { id: 'eletrica', name: 'ELÉTRICA', actualPercent: 0 }] }
};
const INITIAL_CRONOGRAMA = [];
const INITIAL_TEAMS = ['EQUIPA CIVIL', 'EQUIPA ARMADURA', 'EQUIPA HIDRÁULICA', 'EQUIPA ELÉTRICA', 'EQUIPA ACABAMENTO'];
const INITIAL_DELAYS = ['Chuva / Clima Impróprio', 'Falta de Material em Obra', 'Falta de Mão de Obra / Absenteísmo', 'Atraso de Projeto ou Detalhe', 'Quebra de Equipamento / Ferramenta', 'Serviço Anterior não Concluído'];

// --- App Principal ---
const App = () => {
  const [db, setDb] = useState<any>(null);
  const [userId, setUserId] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [importStatus, setImportStatus] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [notification, setNotification] = useState<any>({ message: '', type: '' });

  useEffect(() => {
    if (notification.message) {
      const timer = setTimeout(() => setNotification({ message: '', type: '' }), 4000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Estados Core
  const [floors, setFloors] = useState<any[]>(INITIAL_PAVIMENTOS);
  const [allFloorsData, setAllFloorsData] = useState<any>({});
  const [history, setHistory] = useState<any[]>([]);
  const [weights, setWeights] = useState<any>({});
  const [planning, setPlanning] = useState<any[]>([]);
  const [cronogramaInicial, setCronogramaInicial] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>(INITIAL_TEAMS);
  const [delayReasons, setDelayReasons] = useState<any[]>(INITIAL_DELAYS);
  const [ppcHistory, setPpcHistory] = useState<any[]>([]);
  const [matrices, setMatrices] = useState<any[]>([]); 

  // Estados UI Globais
  const [activeFloor, setActiveFloor] = useState<any>('');
  const [activeSection, setActiveSection] = useState<any>('estrutura');
  const [currentWeekStart, setCurrentWeekStart] = useState<any>(getWeekStartDate(new Date()));
  const [visibleSections, setVisibleSections] = useState<any[]>([]);
  const [visibleFloors, setVisibleFloors] = useState<any[]>([]);

  // Filtros Histórico
  const [giantSearch, setHistorySearch] = useState<string>('');
  const [giantFloorFilter, setHistoryFloorFilter] = useState<string>('');
  const [giantMacroFilter, setHistoryMacroFilter] = useState<string>('');
  const [giantStatusFilter, setHistoryStatusFilter] = useState<string>('');

  // Dashboard Interatividade
  const [dashboardTargetMonth, setDashboardTargetMonth] = useState<string>(getTodayDateString().slice(0, 7));
  const [selectedDashboardFloor, setSelectedDashboardFloor] = useState<any>('');
  const [dashboardShowOnlyScheduled, setDashboardShowOnlyScheduled] = useState<boolean>(true);
  const [selectedDashboardMacros, setSelectedDashboardMacros] = useState<string[]>([]);
  const [lastUpdatedTime, setLastUpdatedTime] = useState<string>('');

  useEffect(() => {
    setSelectedDashboardMacros([]);
  }, [selectedDashboardFloor]);


  // Drawer Menu
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [drawerMacro, setDrawerMacro] = useState<any>('');
  const [drawerFloors, setDrawerFloors] = useState<any[]>([]); 
  const [drawerSelectedServices, setDrawerSelectedServices] = useState<any[]>([]);
  const [drawerResponsible, setDrawerResponsible] = useState<any>('');
  const [drawerWarning, setDrawerWarning] = useState<any>('');

  // Config Modals
  const [newFloorName, setNewFloorName] = useState<string>('');
  const [newItemName, setNewItemName] = useState<string>('');
  const [newPackageName, setNewPackageName] = useState<string>('');
  const [newTeamName, setNewTeamName] = useState<string>('');
  const [newDelayReason, setNewDelayReason] = useState<string>('');
  const [listeningTaskId, setListeningTaskId] = useState<any>(null);

  // Dialogs/Modals
  const [confirmModal, setConfirmModal] = useState<any>({ isOpen: false, title: '', message: '', onConfirm: null });
  const [finalizeModal, setFinalizeModal] = useState<any>({ isOpen: false, carryOverUnfinished: true });
  const [matrixSelection, setMatrixSelection] = useState({ isOpen: false, matrixId: '', type: 'macro' });

  // XLSX carregado via dependência do npm

  useEffect(() => {
    let unsubscribe = () => {};
    try {
      if (!firebaseConfig || Object.keys(firebaseConfig).length === 0) {
        throw new Error('Configuração do Firebase não encontrada.');
      }
      const app = initializeApp(firebaseConfig);
      const auth = getAuth(app);
      const dbInst = getFirestore(app);
      setDb(dbInst);

      unsubscribe = onAuthStateChanged(auth, async (user) => {
        try {
          if (user) {
            setUserId(user.uid);
          } else if (initialAuthToken) {
            await signInWithCustomToken(auth, initialAuthToken);
          } else {
            await signInAnonymously(auth);
          }
        } catch (authErr) {
          console.error('Auth error:', authErr);
          setNotification({ message: 'Falha na autenticação do Firebase.', type: 'error' });
          setLoading(false);
        }
      });
    } catch (err) {
      console.error('Firebase init error:', err);
      setNotification({ message: 'Configure o Firebase antes de usar o salvamento em nuvem.', type: 'error' });
      setLoading(false);
    }
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!db || !userId) return;
    const docRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, userId);
    const unsubscribe = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        const loadedFloors = Array.isArray(d.floors) && d.floors.length > 0 ? d.floors : INITIAL_PAVIMENTOS;
        setFloors(loadedFloors);
        if (!activeFloor || !loadedFloors.includes(activeFloor)) setActiveFloor(loadedFloors[0]);
        if (!selectedDashboardFloor || !loadedFloors.includes(selectedDashboardFloor)) setSelectedDashboardFloor(loadedFloors[0]);
        setLastUpdatedTime(formatTimestamp(d.lastUpdated));

        
        setAllFloorsData(d.data && Object.keys(d.data).length > 0 ? d.data : INITIAL_PAVIMENTOS.reduce((acc, f) => ({ ...acc, [f]: cloneDeep(INITIAL_STRUCTURE) }), {}));
        setHistory(d.history || []);
        setWeights(d.weights || {});
        setPlanning(d.planning || []);
        let loadedCrono = d.cronogramaInicial || INITIAL_CRONOGRAMA;
        if (typeof loadedCrono === 'string') {
          try {
            loadedCrono = JSON.parse(loadedCrono);
          } catch (jsonErr) {
            console.error("Error parsing cronogramaInicial JSON:", jsonErr);
            loadedCrono = [];
          }
        }
        setCronogramaInicial(deserializeCrono(loadedCrono));
        setTeams(d.teams || INITIAL_TEAMS);
        setDelayReasons(d.delayReasons || INITIAL_DELAYS);
        setPpcHistory(d.ppcHistory || []);

        const loadedMatrices = d.matrices && d.matrices.length > 0 ? d.matrices : [{
          id: 'default_matrix', name: 'Matriz Principal', floors: loadedFloors, macros: Object.keys(d.data?.[loadedFloors[0]] || {})
        }];
        setMatrices(loadedMatrices);
      } else {
        const initialData = INITIAL_PAVIMENTOS.reduce((acc, f) => ({ ...acc, [f]: cloneDeep(INITIAL_STRUCTURE) }), {});
        const initialWeights = INITIAL_PAVIMENTOS.reduce((acc, f) => ({ ...acc, [f]: { estrutura: 50, instalacoes: 50 } }), {});
        const initialMatrices = [{ id: 'default_matrix', name: 'Matriz Principal', floors: INITIAL_PAVIMENTOS, macros: Object.keys(INITIAL_STRUCTURE) }];
        saveToDB(INITIAL_PAVIMENTOS, initialData, [], initialWeights, [], INITIAL_CRONOGRAMA, INITIAL_TEAMS, INITIAL_DELAYS, [], initialMatrices);
        setActiveFloor(INITIAL_PAVIMENTOS[0]);
        setSelectedDashboardFloor(INITIAL_PAVIMENTOS[0]);
      }
      setLoading(false);
    }, (err) => {
      console.error("Firestore error:", err);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [db, userId]);

  const saveToDB = async (fls = floors, data = allFloorsData, hist = history, wts = weights, plans = planning, crono = cronogramaInicial, tms = teams, delays = delayReasons, ppcHist = ppcHistory, mats = matrices) => {
    if (!db || !userId) return;
    const docRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, userId);
    const trimmedHistory = (hist || []).slice(-150); 
    const syncedCrono = syncCronogramaWithFloorsData(crono, fls, data);
    const serializedCrono = serializeCrono(syncedCrono);
    try {
      await setDoc(docRef, { 
        floors: Array.isArray(fls) ? fls : [],
        data: data || {},
        history: trimmedHistory,
        weights: wts || {},
        planning: Array.isArray(plans) ? plans : [],
        cronogramaInicial: JSON.stringify(Array.isArray(serializedCrono) ? serializedCrono.slice(0, 5500) : []),
        teams: Array.isArray(tms) ? tms : INITIAL_TEAMS,
        delayReasons: Array.isArray(delays) ? delays : INITIAL_DELAYS,
        ppcHistory: Array.isArray(ppcHist) ? ppcHist.slice(-260) : [],
        matrices: Array.isArray(mats) ? mats : [],
        lastUpdated: new Date() 
      });
    } catch (e) {
      console.error("Save error:", e);
      if (e?.message && e.message.includes('exceeds the maximum allowed size')) {
        setNotification({ message: 'Limite de armazenamento excedido. O histórico foi truncado por segurança.', type: 'error' });
      }
      throw e;
    }
  };

  const getMacroTitle = (sId) => {
    for (const floor of Object.keys(allFloorsData)) {
      if (allFloorsData[floor]?.[sId]?.title) return allFloorsData[floor][sId].title;
    }
    const match = cronogramaInicial.find(item => slugify(item.macro) === sId);
    if (match) return match.macro.toUpperCase();
    return sId;
  };

  const allPossibleMacros = useMemo(() => {
    const macros = new Set<string>();
    Object.values(allFloorsData).forEach(floorData => {
      if (floorData) Object.keys(floorData).forEach(sId => macros.add(sId));
    });
    cronogramaInicial.forEach(item => {
      if (item.macro) macros.add(slugify(item.macro));
    });
    return Array.from(macros);
  }, [allFloorsData, cronogramaInicial]);

  useEffect(() => {
    if (allPossibleMacros.length > 0 && visibleSections.length === 0) setVisibleSections(allPossibleMacros);
    if (floors.length > 0 && visibleFloors.length === 0) setVisibleFloors(floors);
  }, [allPossibleMacros, floors]);

  const dashboardStats = useMemo(() => {
    if (!dashboardTargetMonth) return { totalActual: 0, totalExpected: 0, floorsData: [] };
    const [yyyy, mm] = dashboardTargetMonth.split('-');
    const year = parseInt(yyyy);
    const month = parseInt(mm) - 1;
    const startOfMonth = new Date(year, month, 1, 0, 0, 0, 0);
    const targetDate = new Date(year, month + 1, 0, 23, 59, 59, 999);

    const floorsArr = [];
    let totalProjActual = 0;
    let totalProjExpected = 0;

    floors.forEach(fKey => {
      const fData = allFloorsData[fKey] || {};
      const fWeights = weights[fKey] || {};
      let floorActualSum = 0;
      let floorExpectedSum = 0;
      let weightSum = 0;
      const macrosArr = [];

      Object.keys(fData).forEach(sKey => {
        const sec = fData[sKey];
        const weight = (fWeights[sKey] || 0);
        weightSum += weight;

        let macroActualSum = 0;
        let macroExpectedSum = 0;
        let numItems = sec.items?.length || 0;
        let hasAnyScheduledItem = false;

        if (numItems > 0) {
          sec.items.forEach(item => {
            macroActualSum += (item.actualPercent || 0);
            const cronoItem = cronogramaInicial.find(c => c.id === item.id) ||
              cronogramaInicial.find(c => c.floor === fKey && slugify(c.macro) === sKey && c.service.toUpperCase() === item.name.toUpperCase());
            
            let expected = 0;
            if (cronoItem && cronoItem.start && cronoItem.end) {
              const s = new Date(cronoItem.start);
              const e = new Date(cronoItem.end);
              if (targetDate >= e) expected = 100;
              else if (targetDate <= s) expected = 0;
              else {
                const totalMs = e.getTime() - s.getTime();
                const elapsedMs = targetDate.getTime() - s.getTime();
                expected = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
              }

              const itemStart = new Date(cronoItem.start);
              const itemEnd = new Date(cronoItem.end);
              if (itemStart <= targetDate && itemEnd >= startOfMonth) {
                hasAnyScheduledItem = true;
              }
            }
            macroExpectedSum += expected;
          });
        }

        const macroActual = numItems > 0 ? macroActualSum / numItems : 0;
        const macroExpected = numItems > 0 ? macroExpectedSum / numItems : 0;
        floorActualSum += (macroActual * weight) / 100;
        floorExpectedSum += (macroExpected * weight) / 100;

        macrosArr.push({ 
          id: sKey, 
          title: sec.title || getMacroTitle(sKey), 
          actual: macroActual, 
          expected: macroExpected,
          isScheduledInMonth: hasAnyScheduledItem
        });
      });

      const floorActual = weightSum > 0 ? (floorActualSum / weightSum) * 100 : 0;
      const floorExpected = weightSum > 0 ? (floorExpectedSum / weightSum) * 100 : 0;
      floorsArr.push({ floor: fKey, actual: floorActual, expected: floorExpected, macros: macrosArr });
      totalProjActual += floorActual;
      totalProjExpected += floorExpected;
    });

    return {
      totalActual: floors.length > 0 ? totalProjActual / floors.length : 0,
      totalExpected: floors.length > 0 ? totalProjExpected / floors.length : 0,
      floorsData: floorsArr
    };
  }, [allFloorsData, weights, floors, cronogramaInicial, dashboardTargetMonth]);

  const allMacrosForSelectedFloor = useMemo(() => {
    if (!selectedDashboardFloor) return [];
    const floorStats = dashboardStats.floorsData.find(f => f.floor === selectedDashboardFloor);
    return floorStats ? floorStats.macros : [];
  }, [dashboardStats, selectedDashboardFloor]);

  const macrosToDisplay = useMemo(() => {
    let list = allMacrosForSelectedFloor;
    if (dashboardShowOnlyScheduled) {
      list = list.filter(m => m.isScheduledInMonth);
    }
    if (selectedDashboardMacros.length > 0) {
      list = list.filter(m => selectedDashboardMacros.includes(m.id));
    }
    return list;
  }, [allMacrosForSelectedFloor, dashboardShowOnlyScheduled, selectedDashboardMacros]);



  const delayStats = useMemo(() => {
    const counts: Record<string, number> = {};
    let total = 0;
    planning.forEach(t => {
      if (t.delayReason) { counts[t.delayReason] = (counts[t.delayReason] || 0) + 1; total++; }
    });
    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 5);
    let cumulative = 0;
    return sorted.map(([reason, count]) => {
      cumulative += count;
      return { reason, count, total, percent: total > 0 ? (count / total) * 100 : 0, cumulativePercent: total > 0 ? (cumulative / total) * 100 : 0 };
    });
  }, [planning]);

  const ppcChartData = useMemo(() => [...ppcHistory].sort((a, b) => new Date(a.weekStart).getTime() - new Date(b.weekStart).getTime()), [ppcHistory]);

  const availableFloorsForMacro = useMemo(() => {
    if (!drawerMacro) return [];
    return Array.from(new Set(
      cronogramaInicial
        .filter(item => slugify(item.macro) === drawerMacro && (item.progress ?? 0) < 100)
        .map(item => item.floor)
    )).filter(Boolean);
  }, [cronogramaInicial, drawerMacro]);

  const availableServicesForMacroAndFloors = useMemo(() => {
    if (!drawerMacro || drawerFloors.length === 0) return [];
    return cronogramaInicial.filter(item => 
      slugify(item.macro) === drawerMacro && 
      drawerFloors.includes(item.floor) &&
      (item.progress ?? 0) < 100
    );
  }, [cronogramaInicial, drawerMacro, drawerFloors]);


  const currentWeekId = toLocalDateString(currentWeekStart);
  const weeklyTasks = planning.filter(t => t.weekId === currentWeekId);

  const currentWeekPpcStats = useMemo(() => {
    const plannedTasks = weeklyTasks.filter(t => (t.plannedThisWeek ?? 100) > 0);
    const completedTasks = plannedTasks.filter(t => (t.progressThisWeek ?? 0) >= (t.plannedThisWeek ?? 100));
    const percent = plannedTasks.length > 0 ? (completedTasks.length / plannedTasks.length) * 100 : 0;
    return { percent, completedCount: completedTasks.length, totalPlannedCount: plannedTasks.length };
  }, [weeklyTasks]);

  const configItemsToDisplay = useMemo(() => {
    for (let f of floors) {
      if (allFloorsData[f]?.[activeSection]?.items?.length > 0) return allFloorsData[f][activeSection].items;
    }
    return [];
  }, [floors, allFloorsData, activeSection]);

  const matrixSelectionOptions = useMemo(() => {
    if (!matrixSelection.isOpen) return [];
    const targetMatrix = matrices.find(m => m.id === matrixSelection.matrixId);
    if (!targetMatrix) return [];
    const list = matrixSelection.type === 'macro' ? allPossibleMacros : floors;
    return list.filter(item => {
      return matrixSelection.type === 'macro' ? !(targetMatrix.macros || []).includes(item) : !(targetMatrix.floors || []).includes(item);
    }).map(item => ({ id: item, title: matrixSelection.type === 'macro' ? getMacroTitle(item) : item }));
  }, [matrixSelection, matrices, allPossibleMacros, floors]);

  const macroEvolutionHistory = useMemo(() => {
    const map: Record<string, any> = {};
    const sortedHistory = [...history].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const stateTracker: Record<string, any> = {}; 

    sortedHistory.forEach(record => {
      const floor = record.floor;
      const macro = record.sectionId;
      const itemId = record.itemId;
      const newPct = record.newPercent;
      const weekStr = getWeekStartDate(new Date(record.timestamp)).toISOString().split('T')[0];

      if (!stateTracker[floor]) stateTracker[floor] = {};
      if (!stateTracker[floor][macro]) stateTracker[floor][macro] = {};
      stateTracker[floor][macro][itemId] = newPct;

      const macroKey = `${floor} - ${macro}`;
      if (!map[macroKey]) {
        map[macroKey] = { floor, sectionTitle: getMacroTitle(macro), sectionId: macro, weeks: {}, lastPct: 0 };
      }
      if (!map[macroKey].weeks[weekStr]) {
        map[macroKey].weeks[weekStr] = { dateStr: formatDateBR(weekStr), services: [], macroDelta: 0, macroPercent: 0 };
      }
      map[macroKey].weeks[weekStr].services.push({ name: record.itemName, delta: record.progressAchieved });
    });

    Object.keys(map).forEach(mKey => {
      const macroData = map[mKey];
      const totalItems = allFloorsData[macroData.floor]?.[macroData.sectionId]?.items?.length || 1;
      let cumulativeMacroPct = 0;
      const sortedWeeks = Object.keys(macroData.weeks).sort();
      const changes = [];

      sortedWeeks.forEach(wKey => {
        const weekData = macroData.weeks[wKey];
        const totalItemDelta = weekData.services.reduce((sum, s) => sum + s.delta, 0);
        const weekMacroDelta = totalItemDelta / totalItems;
        cumulativeMacroPct += weekMacroDelta;
        weekData.macroDelta = weekMacroDelta;
        weekData.macroPercent = cumulativeMacroPct;
        if (weekMacroDelta !== 0) changes.push(weekData);
      });
      macroData.changes = changes;
    });

    return (Object.values(map) as any[]).filter(m => m.changes.length > 0);
  }, [history, allFloorsData]);

  const filteredGiantPlanningTasks = useMemo(() => {
    return planning.filter(t => {
      const matchesSearch = !giantSearch || t.activityName.toLowerCase().includes(giantSearch.toLowerCase()) || t.responsible.toLowerCase().includes(giantSearch.toLowerCase()) || (t.observations || '').toLowerCase().includes(giantSearch.toLowerCase());
      const matchesFloor = !giantFloorFilter || t.floor === giantFloorFilter;
      const matchesMacro = !giantMacroFilter || slugify(t.sectionId) === slugify(giantMacroFilter);
      const matchesStatus = !giantStatusFilter || (giantStatusFilter === 'finalized' ? t.finalized : !t.finalized);
      return matchesSearch && matchesFloor && matchesMacro && matchesStatus;
    }).sort((a, b) => b.weekId.localeCompare(a.weekId));
  }, [planning, giantSearch, giantFloorFilter, giantMacroFilter, giantStatusFilter]);

  // --- Handlers de Ações ---
  const handleIncludeDrawerActivities = async () => {
    if (!drawerMacro || drawerFloors.length === 0 || drawerSelectedServices.length === 0) {
      setNotification({ message: 'Selecione a Macroatividade, os Pavimentos e pelo menos um Serviço!', type: 'error' });
      return;
    }
    const newTasks = [];
    const duplicates = [];

    drawerSelectedServices.forEach(serviceId => {
      const match = cronogramaInicial.find(item => item.id === serviceId);
      if (match) {
        const exists = weeklyTasks.some(t => t.itemId === match.id && t.floor === match.floor && !t.finalized);
        if (exists) {
          duplicates.push(`${match.service} (${match.floor})`);
        } else {
          newTasks.push({
            id: crypto.randomUUID(), weekId: currentWeekId, floor: match.floor,
            sectionId: slugify(match.macro), itemId: match.id,
            activityName: match.service, responsible: drawerResponsible || match.responsible || (teams[0] || 'Equipa Geral'),
            weight: 100, executedBefore: roundDown25(match.progress || 0), plannedThisWeek: 100, progressThisWeek: 0,
            finishDate: match.end, dailyWork: [0, 0, 0, 0, 0], observations: '', delayReason: '', finalized: false
          });
        }
      }
    });

    if (duplicates.length > 0) setDrawerWarning(`⚠️ Atenção, já incluídas nesta semana: ${duplicates.join('; ')}`);
    else setDrawerWarning('');

    if (newTasks.length > 0) {
      const updatedPlanning = [...planning, ...newTasks];
      const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
      await saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
      if (duplicates.length === 0) { setDrawerSelectedServices([]); setIsDrawerOpen(false); }
      setNotification({ message: `${newTasks.length} Novas atividades adicionadas à semana!`, type: 'success' });
    }
  };

  const handleDailyWorkChange = async (taskId, newDW) => {
    const updatedPlanning = planning.map(p => p.id === taskId ? { ...p, dailyWork: newDW } : p);
    await saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
  };

  const handlePlannedChange = async (taskId, value) => {
    const currentTask = planning.find(t => t.id === taskId);
    if (!currentTask || currentTask.finalized) return;
    const isCurrentActive = (currentTask.plannedThisWeek ?? 100) === value;
    const numericVal = isCurrentActive ? 0 : value;
    const updatedPlanning = planning.map(t => t.id === taskId ? { ...t, plannedThisWeek: numericVal } : t);
    const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
    await saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
  };

  const handleWeeklyProgressChange = async (taskId, value) => {
    const task = planning.find(t => t.id === taskId);
    if (!task || task.finalized) return;
    
    const isCurrentActive = (task.progressThisWeek ?? 0) === value;
    const newWeeklyProgress = isCurrentActive ? 0 : value; 
    
    const updatedPlanning = planning.map(t => t.id === taskId ? { 
      ...t, progressThisWeek: newWeeklyProgress, delayReason: (newWeeklyProgress >= (t.plannedThisWeek ?? 100)) ? '' : t.delayReason
    } : t);
    
    const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
    const sectionKey = task.sectionId || 'estrutura';
    const itemBefore = allFloorsData[task.floor]?.[sectionKey]?.items.find(i => i.id === task.itemId);
    const itemAfter = updatedFloorsData[task.floor]?.[sectionKey]?.items.find(i => i.id === task.itemId);
    
    let updatedHistory = [...history];
    if (itemBefore && itemAfter) {
      const oldVal = itemBefore.actualPercent || 0;
      const newVal = itemAfter.actualPercent || 0;
      if (newVal !== oldVal) {
        updatedHistory.push({
          timestamp: new Date().toISOString(), floor: task.floor, sectionId: sectionKey, sectionTitle: getMacroTitle(sectionKey),
          itemId: task.itemId, itemName: itemAfter.name, progressAchieved: newVal - oldVal, 
          oldPercent: oldVal, newPercent: newVal, userId
        });
      }
    }
    await saveToDB(floors, updatedFloorsData, updatedHistory, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
  };

  const handleFinalizeWeek = async (carryOver) => {
    const nextWeekDate = new Date(currentWeekStart);
    nextWeekDate.setDate(nextWeekDate.getDate() + 7);
    const nextWeekId = toLocalDateString(nextWeekDate);

    const activePlanned = weeklyTasks.filter(t => (t.plannedThisWeek ?? 100) > 0);
    const activeCompleted = activePlanned.filter(t => (t.progressThisWeek ?? 0) >= (t.plannedThisWeek ?? 100));
    const finalPpcVal = activePlanned.length > 0 ? (activeCompleted.length / activePlanned.length) * 100 : 0;

    const updatedPpcHistory = [...ppcHistory.filter(h => h.weekId !== currentWeekId), {
      weekId: currentWeekId, weekStart: toLocalDateString(currentWeekStart),
      ppc: finalPpcVal, totalPlanned: activePlanned.length, completed: activeCompleted.length,
      timestamp: new Date().toISOString()
    }];

    const carryOverTasks = [];
    const updatedPlanning = planning.map(t => {
      if (t.weekId === currentWeekId) {
        const finalProgress = Math.min(100, (t.executedBefore || 0) + (t.progressThisWeek || 0));
        if (carryOver && finalProgress < 100) {
          const existsNextWeek = planning.some(p => p.weekId === nextWeekId && p.itemId === t.itemId && p.floor === t.floor);
          if (!existsNextWeek) {
            carryOverTasks.push({
              ...t, id: crypto.randomUUID(), weekId: nextWeekId, executedBefore: finalProgress,
              plannedThisWeek: Math.max(0, 100 - finalProgress), progressThisWeek: 0,
              observations: 'Saldo de avanço físico reprogramado', delayReason: '', finalized: false
            });
          }
        }
        return { ...t, finalized: true };
      }
      return t;
    });

    const finalPlanning = [...updatedPlanning, ...carryOverTasks];
    const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(finalPlanning, cloneDeep(allFloorsData), cronogramaInicial);

    await saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, updatedPpcHistory, matrices);
    setCurrentWeekStart(nextWeekDate);
    setFinalizeModal({ isOpen: false, carryOverUnfinished: true });
    setNotification({ message: `Semana finalizada! PPC de ${finalPpcVal.toFixed(1)}% gravado.`, type: 'success' });
  };

  const handleUpdateTaskField = async (taskId, field, value) => {
    const updatedPlanning = planning.map(t => t.id === taskId ? { ...t, [field]: value } : t);
    await saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
  };

  const handleRemoveTask = async (taskId) => {
    const updatedPlanning = planning.filter(t => t.id !== taskId);
    const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
    await saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    setNotification({ message: 'Atividade removida do planeamento.', type: 'success' });
  };

  const handleVoiceInput = (taskId) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setNotification({ message: "Reconhecimento de voz não suportado pelo seu navegador.", type: "error" });
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    setListeningTaskId(taskId);
    recognition.start();
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const existingText = planning.find(t => t.id === taskId)?.observations || '';
      const combinedText = existingText ? `${existingText} | ${transcript}` : transcript;
      handleUpdateTaskField(taskId, 'observations', combinedText);
      setListeningTaskId(null);
      setNotification({ message: 'Observação ditada com sucesso!', type: 'success' });
    };
    recognition.onerror = () => { setListeningTaskId(null); setNotification({ message: 'Falha ao gravar.', type: 'error' }); };
    recognition.onspeechend = () => { recognition.stop(); setListeningTaskId(null); };
  };

  const handleFileUpload = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!XLSX) { setNotification({ message: "Aguarde o carregador de planilhas.", type: "error" }); return; }

    setIsImporting(true);
    setImportStatus('Lendo e analisando planilha Excel...');

    const reader = new FileReader();
    reader.onload = (evt: any) => {
      setTimeout(async () => {
        try {
          const bstr = evt.target.result as string;
          const workbook = XLSX.read(bstr, { type: 'binary' });
          const wsname = workbook.SheetNames[0];
          const ws = workbook.Sheets[wsname];
          const data = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
          
          if (data.length < 2) {
            setNotification({ message: "Planilha sem linhas suficientes.", type: "error" });
            setIsImporting(false);
            setImportStatus('');
            return;
          }

          let headerIndex = 3; 
          for (let i = 0; i < Math.min(10, data.length); i++) {
            const rowStr = (data[i] || []).join('').toLowerCase();
            // Exclude 'id' to prevent matching rows above header containing 'unidade' (which contains 'id')
            if (rowStr.includes('pacote de trabalho') || rowStr.includes('serviço') || rowStr.includes('macroatividade')) {
              headerIndex = i; 
              break;
            }
          }

          if (data.length <= headerIndex + 1) {
            setNotification({ message: "Não há dados abaixo da linha de cabeçalho.", type: "error" });
            setIsImporting(false);
            setImportStatus('');
            return;
          }

          const headerRow = data[headerIndex].map(h => String(h || '').trim().toLowerCase());
          
          const colIdx = {
            macro: 2,         // Coluna 3 - Pacote de serviço
            service: 3,       // Coluna 4 - Serviço
            floor: 5,         // Coluna 6 - Lote ou local do serviço
            duration: headerRow.findIndex(h => h === 'duração' || h === 'duracao' || h.includes('prazo') || h.includes('dias')),
            start: 10,        // Coluna 11 - Data de início
            end: 11,          // Coluna 12 - Data de término
            cost: 15,         // Coluna 16 - Custo vinculado atual
            responsible: 14,  // Coluna 15 - Responsável
            progress: 24      // Coluna 25 - Último Realizado
          };

          let parsedItems = [];
          const importedTeams = new Set<any>([...teams]);
          const importedFloors = new Set<any>([...floors]);

          for (let i = headerIndex + 1; i < data.length; i++) {
            const row = data[i];
            if (!row || row.length === 0) continue;

            const rawService = colIdx.service !== -1 && row[colIdx.service] !== undefined ? String(row[colIdx.service]).trim() : '';
            // Skip rows without a valid service name or if it's '-'
            if (!rawService || rawService === '-') continue;

            const rawMacro = colIdx.macro !== -1 && row[colIdx.macro] !== undefined ? row[colIdx.macro] : 'ESTRUTURA';
            const rawFloor = colIdx.floor !== -1 && row[colIdx.floor] !== undefined ? row[colIdx.floor] : 'Térreo';
            const rawDuration = colIdx.duration !== -1 && row[colIdx.duration] !== undefined ? parseInt(row[colIdx.duration], 10) : 10;
            const rawStart = parseExcelDate(colIdx.start !== -1 && row[colIdx.start] !== undefined ? row[colIdx.start] : undefined);
            const rawEnd = parseExcelDate(colIdx.end !== -1 && row[colIdx.end] !== undefined ? row[colIdx.end] : undefined, rawStart);
            const rawCost = colIdx.cost !== -1 && row[colIdx.cost] !== undefined ? parseFloat(String(row[colIdx.cost]).replace(/[^\d.-]/g, '')) : 0;
            const rawResp = colIdx.responsible !== -1 && row[colIdx.responsible] !== undefined && row[colIdx.responsible] !== null ? String(row[colIdx.responsible]).trim().toUpperCase() : 'EQUIPA GERAL';

            let rawProgress = 0;
            if (colIdx.progress !== -1 && row[colIdx.progress] !== undefined) {
              rawProgress = parsePercent(row[colIdx.progress]);
            }

            if (rawResp && rawResp !== 'UNDEFINED' && rawResp !== '' && rawResp !== '-') importedTeams.add(rawResp);
            const floorName = String(rawFloor || 'Térreo').trim();
            importedFloors.add(floorName);

            const itemKey = `xls_${slugify(floorName)}_${slugify(rawMacro)}_${slugify(rawService)}`;
            parsedItems.push({
              id: itemKey, 
              macro: String(rawMacro || 'ESTRUTURA').trim().toUpperCase(),
              floor: floorName, 
              service: rawService.toUpperCase(),
              duration: isNaN(rawDuration) ? 5 : rawDuration, 
              start: rawStart, 
              end: rawEnd,
              cost: isNaN(rawCost) ? 0 : rawCost, 
              responsible: rawResp || 'EQUIPA GERAL', 
              progress: clampPercent(rawProgress)
            });
          }


          if (parsedItems.length === 0) {
            setNotification({ message: "Não foi possível extrair nenhum serviço.", type: "error" });
            setIsImporting(false);
            setImportStatus('');
            return;
          }
          
          if (parsedItems.length > 5500) {
            setNotification({ message: `Limite de segurança: Importados apenas os primeiros 5500 serviços.`, type: "error" });
            parsedItems = parsedItems.slice(0, 5500);
          }

          setImportStatus('Preparando dados e limpando registros antigos...');

          // Clear old Excel-imported items from allFloorsData to keep it incremental and clean
          const clearOldExcelItems = (floorsData) => {
            const cleaned = cloneDeep(floorsData);
            Object.keys(cleaned).forEach(floor => {
              Object.keys(cleaned[floor]).forEach(macroKey => {
                if (cleaned[floor][macroKey] && Array.isArray(cleaned[floor][macroKey].items)) {
                  cleaned[floor][macroKey].items = cleaned[floor][macroKey].items.filter(
                    item => !String(item.id).startsWith('xls_')
                  );
                }
              });
            });
            return cleaned;
          };

          const baseFloorsData = clearOldExcelItems(allFloorsData);
          const updatedTeams = Array.from(importedTeams);
          const updatedFloorsList = Array.from(importedFloors);
          const updatedFloorsData = cloneDeep(baseFloorsData);
          const updatedWeights = cloneDeep(weights);
          const importedMacroKeys = new Set<string>();

          parsedItems.forEach(item => {
            const macroKey = slugify(item.macro);
            importedMacroKeys.add(macroKey);
            if (!updatedFloorsData[item.floor]) updatedFloorsData[item.floor] = {};
            if (!updatedFloorsData[item.floor][macroKey]) updatedFloorsData[item.floor][macroKey] = { title: item.macro, items: [] };
            if (!updatedWeights[item.floor]) updatedWeights[item.floor] = {};
            if (updatedWeights[item.floor][macroKey] === undefined) updatedWeights[item.floor][macroKey] = 1;
            const existingItemIndex = updatedFloorsData[item.floor][macroKey].items.findIndex(it => it && String(it.name || '').toUpperCase() === String(item.service || '').toUpperCase());

            if (existingItemIndex !== -1) {
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].id = item.id;
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].actualPercent = item.progress;
            } else {
              updatedFloorsData[item.floor][macroKey].items.push({ id: item.id, name: item.service, actualPercent: item.progress });
            }

          });

          const autoTasks = [];
          parsedItems.forEach(item => {
            if (item.progress > 0 && item.progress < 100) {
              autoTasks.push({
                id: crypto.randomUUID(), weekId: currentWeekId, floor: item.floor,
                sectionId: slugify(item.macro), itemId: item.id,
                activityName: item.service, responsible: item.responsible, weight: 100,
                executedBefore: roundDown25(item.progress),
                plannedThisWeek: 100, progressThisWeek: 0,
                finishDate: item.end, dailyWork: [0, 0, 0, 0, 0], observations: '',
                delayReason: '', finalized: false
              });
            }
          });

          const existingMatrices = matrices.length > 0 ? matrices : [{ id: 'default_matrix', name: 'Matriz Principal', floors: [], macros: [] }];
          const updatedMatrices = existingMatrices.map((m, idx) => idx === 0 ? {
            ...m,
            floors: Array.from(new Set([...(m.floors || []), ...updatedFloorsList])),
            macros: Array.from(new Set([...(m.macros || []), ...Array.from(importedMacroKeys)]))
          } : m);

          // Maintain historical planning tasks for finalized/past weeks, overwrite active week tasks
          const pastPlanning = planning.filter(t => t.weekId < currentWeekId);
          const batchPlanning = [...pastPlanning, ...autoTasks];
          const { recalculatedPlanning, updatedFloorsData: syncedFloors } = syncPlanningAndPhysical(batchPlanning, updatedFloorsData, parsedItems);


          setImportStatus('Gravando dados no Firebase (Aguarde)...');

          saveToDB(
            updatedFloorsList,
            syncedFloors,
            history,
            updatedWeights,
            recalculatedPlanning,
            parsedItems,
            updatedTeams,
            delayReasons,
            ppcHistory,
            updatedMatrices
          )
            .then(() => {
              setNotification({ message: `${parsedItems.length} atividades importadas e organizadas!`, type: "success" });
              setActiveTab('planning');
            })
            .catch((err) => {
              console.error(err);
              setNotification({ message: "Erro ao salvar os dados no Firebase.", type: "error" });
            })
            .finally(() => {
              setIsImporting(false);
              setImportStatus('');
            });

        } catch (err) {
          console.error(err);
          setNotification({ message: "Falha ao analisar a planilha Excel.", type: "error" });
          setIsImporting(false);
        }
      }, 100);
    };
    reader.onerror = () => {
      setNotification({ message: "Erro ao ler o arquivo.", type: "error" });
      setIsImporting(false);
    };
    reader.readAsBinaryString(file);
  };

  const handleAddFloor = async () => {
    if (!newFloorName.trim()) return;
    const floor = newFloorName.trim();
    if (floors.includes(floor)) return;
    const updatedFloors = [...floors, floor];
    const updatedData = cloneDeep(allFloorsData);
    const updatedWeights = cloneDeep(weights);
    updatedData[floor] = cloneDeep(INITIAL_STRUCTURE);
    updatedWeights[floor] = { estrutura: 50, instalacoes: 50 };
    await saveToDB(updatedFloors, updatedData, history, updatedWeights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    setNewFloorName('');
    setNotification({ message: 'Pavimento adicionado!', type: 'success' });
  };

  const handleDeleteFloor = async (floor) => {
    const updatedFloors = floors.filter(f => f !== floor);
    const updatedData = cloneDeep(allFloorsData);
    delete updatedData[floor];
    const updatedWeights = cloneDeep(weights);
    delete updatedWeights[floor];
    const updatedMats = matrices.map(m => ({ ...m, floors: (m.floors || []).filter(f => f !== floor) }));
    const updatedPlanning = planning.filter(t => t.floor !== floor);
    const updatedHistory = history.filter(h => h.floor !== floor);
    const updatedCrono = cronogramaInicial.filter(c => c.floor !== floor);
    await saveToDB(updatedFloors, updatedData, updatedHistory, updatedWeights, updatedPlanning, updatedCrono, teams, delayReasons, ppcHistory, updatedMats);
    setNotification({ message: 'Pavimento removido.', type: 'success' });
  };

  const handleAddNewPackageConfig = async () => {
    if (!newPackageName.trim()) return;
    const title = newPackageName.trim().toUpperCase();
    const id = `${slugify(title)}_${Date.now()}`;
    const updatedData = cloneDeep(allFloorsData);
    const updatedWeights = cloneDeep(weights);
    floors.forEach(f => {
      if (!updatedData[f]) updatedData[f] = {};
      updatedData[f][id] = { title, items: [] };
      if (!updatedWeights[f]) updatedWeights[f] = {};
      updatedWeights[f][id] = 0;
    });
    await saveToDB(floors, updatedData, history, updatedWeights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    setNewPackageName('');
    setActiveSection(id);
    setNotification({ message: `Pacote "${title}" criado!`, type: 'success' });
  };

  const handleAddNewItemConfig = async () => {
    if (!newItemName.trim()) return;
    const name = newItemName.trim().toUpperCase();
    const id = `${slugify(name)}_${Date.now()}`;
    const updated = cloneDeep(allFloorsData);
    floors.forEach(f => {
      if (updated[f] && updated[f][activeSection] && !updated[f][activeSection].items.find(i => i.id === id)) {
        updated[f][activeSection].items.push({ id, name, actualPercent: 0 });
      }
    });
    await saveToDB(floors, updated, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    setNewItemName('');
    setNotification({ message: 'Item adicionado com sucesso.', type: 'success' });
  };

  const handleDeleteItemConfig = (item) => {
    triggerConfirm('Excluir Item', `Deseja excluir "${item.name}" de todos os pavimentos?`, async () => {
      const updated = cloneDeep(allFloorsData);
      floors.forEach(f => {
        if (updated[f] && updated[f][activeSection]) {
          updated[f][activeSection].items = updated[f][activeSection].items.filter(i => i.id !== item.id);
        }
      });
      const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(planning, updated, cronogramaInicial);
      await saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);

    });
  };

  const handleAddTeam = async () => {
    if (!newTeamName.trim()) return;
    const upper = newTeamName.trim().toUpperCase();
    if (teams.includes(upper)) { setNotification({ message: 'Equipa já existente.', type: 'error' }); return; }
    const updatedTeams = [...teams, upper];
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, updatedTeams, delayReasons, ppcHistory, matrices);
    setNewTeamName(''); setNotification({ message: 'Equipa adicionada!', type: 'success' });
  };

  const handleDeleteTeam = async (teamToDelete) => {
    const updatedTeams = teams.filter(t => t !== teamToDelete);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, updatedTeams, delayReasons, ppcHistory, matrices);
    setNotification({ message: 'Equipa removida.', type: 'success' });
  };

  const handleAddDelayReason = async () => {
    if (!newDelayReason.trim()) return;
    const text = newDelayReason.trim();
    if (delayReasons.includes(text)) return;
    const updatedDelays = [...delayReasons, text];
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, updatedDelays, ppcHistory, matrices);
    setNewDelayReason(''); setNotification({ message: 'Motivo registado!', type: 'success' });
  };

  const handleDeleteDelayReason = async (reasonToDelete) => {
    const updatedDelays = delayReasons.filter(r => r !== reasonToDelete);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, updatedDelays, ppcHistory, matrices);
    setNotification({ message: 'Motivo removido.', type: 'success' });
  };

  const handleCreateMatrix = async () => {
    const newMatrix = { id: crypto.randomUUID(), name: `Nova Matriz ${matrices.length + 1}`, floors: [], macros: [] };
    const updated = [...matrices, newMatrix];
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
  };

  const handleDeleteMatrix = async (matrixId) => {
    const updated = matrices.filter(m => m.id !== matrixId);
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
  };

  const handleMatrixNameChange = (matrixId, newName) => {
    const updated = matrices.map(m => m.id === matrixId ? { ...m, name: newName } : m);
    setMatrices(updated);
  };

  const saveMatrixName = async () => {
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
  };

  const removeMatrixColumn = async (matrixId, macroId) => {
    const updated = matrices.map(m => m.id === matrixId ? { ...m, macros: (m.macros || []).filter(x => x !== macroId) } : m);
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
  };

  const removeMatrixRow = async (matrixId, floorId) => {
    const updated = matrices.map(m => m.id === matrixId ? { ...m, floors: (m.floors || []).filter(x => x !== floorId) } : m);
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
  };

  const addSelectionToMatrix = async (selectedId) => {
    const { matrixId, type } = matrixSelection;
    const updated = matrices.map(m => {
      if (m.id === matrixId) {
        if (type === 'macro' && !(m.macros || []).includes(selectedId)) return { ...m, macros: [...(m.macros || []), selectedId] };
        if (type === 'floor' && !(m.floors || []).includes(selectedId)) return { ...m, floors: [...(m.floors || []), selectedId] };
      }
      return m;
    });
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
    setMatrixSelection({ isOpen: false, matrixId: '', type: 'macro' });
  };

  const handleExportCSV = () => {
    const headers = ['Semana ID', 'Pavimento', 'Macroatividade', 'Serviço', 'Responsável', 'Meta Planeada (%)', 'Dias Ativos', 'Progresso Semana (%)', 'Progresso Acumulado (%)', 'Motivo Atraso', 'Observações', 'Status'];
    const rows = filteredGiantPlanningTasks.map(t => [
      t.weekId, t.floor, t.sectionId.toUpperCase(), t.activityName, t.responsible,
      `${t.plannedThisWeek ?? 100}%`,
      (t.dailyWork || [0,0,0,0,0]).map((dw, i) => dw ? ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'][i] : '').filter(Boolean).join('/'),
      `${t.progressThisWeek ?? 0}%`, `${Math.min(100, (t.executedBefore || 0) + (t.progressThisWeek || 0))}%`,
      t.delayReason || 'N/A', t.observations || '', t.finalized ? 'Finalizado' : 'Ativo'
    ]);
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; 
    csvContent += [headers.join(';'), ...rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(';'))].join('\n');
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `Tabela_Consolidada_Planeamento_Semanal_${getTodayDateString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const triggerConfirm = (title, message, onConfirm) => setConfirmModal({ isOpen: true, title, message, onConfirm });

  // --- Secções de Renderização Isoladas (Para evitar falhas do compilador) ---
  
  const renderDashboard = () => (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard title="Avanço Físico Real" value={`${(dashboardStats.totalActual || 0).toFixed(2)}%`} color="bg-emerald-600" />
        <StatCard title="Meta Semanal Ativa" value={`${weeklyTasks.length} Serviços`} color="bg-indigo-600" />
        <StatCard title="Média de PPC" value={ppcHistory.length > 0 ? `${(ppcHistory.reduce((a, b) => a + b.ppc, 0) / ppcHistory.length).toFixed(1)}%` : '0.0%'} color="bg-cyan-600" />
        <StatCard title="Equipas Registadas" value={`${teams.length} Grupos`} color="bg-slate-800" />
      </div>

      <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end mb-4 gap-2">
          <div>
            <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider">Progresso Consolidado por Pavimento</h3>
            <p className="text-[10px] text-slate-500">Clique num pavimento para detalhar as etapas ao lado.</p>
          </div>
          <div>
            <label className="text-[9px] font-bold text-slate-500 uppercase mb-1 block">Mês de Referência (Previsão)</label>
            <input type="month" className="p-2 border rounded-lg text-xs font-bold text-slate-700 outline-none focus:border-indigo-500" value={dashboardTargetMonth} onChange={e => setDashboardTargetMonth(e.target.value)} />
          </div>
        </div>
        
        <div className="flex flex-col lg:flex-row gap-8">
          <div className="flex-1 space-y-4 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
            {dashboardStats.floorsData.map((f, i) => (
              <div key={i} onClick={() => setSelectedDashboardFloor(f.floor)} className={`p-3 rounded-xl border-2 transition-all cursor-pointer ${selectedDashboardFloor === f.floor ? 'border-indigo-400 bg-indigo-50/30 shadow-sm' : 'border-transparent hover:bg-slate-50'}`}>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] font-black uppercase text-slate-700">{f.floor}</span>
                  <span className="text-[10px] font-bold text-slate-500">{f.actual.toFixed(1)}% / {f.expected.toFixed(1)}% (Esp)</span>
                </div>
                <div className="relative w-full bg-slate-100 h-4 rounded-full overflow-hidden">
                  <div className="absolute top-0 left-0 h-full bg-indigo-100 border-r-2 border-indigo-400" style={{ width: `${f.expected}%` }} title={`Esperado: ${f.expected.toFixed(1)}%`}></div>
                  <div className="absolute top-0 left-0 h-full bg-emerald-500 opacity-90 shadow-[inset_-2px_0_4px_rgba(0,0,0,0.1)]" style={{ width: `${f.actual}%` }} title={`Realizado: ${f.actual.toFixed(1)}%`}></div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex-1 border-t lg:border-t-0 lg:border-l border-slate-200 pt-6 lg:pt-0 lg:pl-8 flex flex-col justify-end">
            {!selectedDashboardFloor ? (
              <div className="h-full flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase italic">Selecione um pavimento ao lado</div>
            ) : (
              <>
                <h4 className="text-[10px] font-black uppercase text-slate-700 mb-2 text-center">Detalhamento: {selectedDashboardFloor}</h4>
                
                {/* Filtros de Pacotes */}
                <div className="space-y-2 mb-4 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                  <div className="flex items-center">
                    <label className="flex items-center space-x-1.5 cursor-pointer select-none text-[9px] font-black text-slate-600 uppercase">
                      <input 
                        type="checkbox" 
                        checked={dashboardShowOnlyScheduled} 
                        onChange={e => setDashboardShowOnlyScheduled(e.target.checked)} 
                        className="w-3.5 h-3.5 text-indigo-600 rounded focus:ring-indigo-500 cursor-pointer"
                      />
                      <span>Apenas Previstos no Mês</span>
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto pr-1 custom-scrollbar">
                    {allMacrosForSelectedFloor.map(m => {
                      const isSelected = selectedDashboardMacros.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          onClick={() => {
                            if (isSelected) {
                              setSelectedDashboardMacros(selectedDashboardMacros.filter(id => id !== m.id));
                            } else {
                              setSelectedDashboardMacros([...selectedDashboardMacros, m.id]);
                            }
                          }}
                          className={`px-2 py-0.5 rounded text-[8px] font-black uppercase transition border ${
                            isSelected 
                              ? 'bg-indigo-600 border-indigo-600 text-white' 
                              : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-100'
                          }`}
                        >
                          {m.title}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-end justify-start h-48 gap-4 overflow-x-auto pb-2 custom-scrollbar">
                  {macrosToDisplay.map((m, i) => (
                    <div key={i} className="flex-shrink-0 w-14 flex flex-col items-center gap-2 group relative">
                      <div className="opacity-0 group-hover:opacity-100 absolute -top-10 bg-slate-800 text-white text-[9px] px-2 py-1 rounded transition-opacity whitespace-nowrap z-20 shadow-lg pointer-events-none">
                        {m.actual.toFixed(1)}% / {m.expected.toFixed(1)}%
                      </div>
                      <div className="w-full max-w-[40px] flex justify-center items-end h-full bg-slate-50 rounded-t relative">
                        <div className="absolute bottom-0 w-full bg-indigo-100 border-t-2 border-indigo-400" style={{ height: `${m.expected}%` }}></div>
                        <div className="absolute bottom-0 w-full bg-emerald-500 opacity-90" style={{ height: `${m.actual}%` }}></div>
                      </div>
                      <span className="text-[8px] font-bold text-slate-500 truncate w-full text-center" title={m.title}>{m.title}</span>
                    </div>
                  ))}
                  {macrosToDisplay.length === 0 && (
                    <div className="w-full h-full flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase italic">
                      Nenhuma macro correspondente
                    </div>
                  )}
                </div>
                <div className="flex justify-center gap-4 mt-6">
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-emerald-500 rounded-sm"></div><span className="text-[9px] font-bold text-slate-500">Realizado</span></div>
                  <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-indigo-100 border-2 border-indigo-400 rounded-sm"></div><span className="text-[9px] font-bold text-slate-500">Previsão Acumulada</span></div>
                </div>

              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200 flex flex-col">
          <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider mb-2">Evolução do PPC</h3>
          <p className="text-[10px] text-slate-500 mb-4">Percentual de Planos Concluídos ao longo das semanas.</p>
          <div className="relative flex-1 flex items-end gap-2 pb-6 px-2 min-h-[200px]">
            <div className="absolute left-0 right-0 bottom-6 top-0 pointer-events-none">
              <div className="absolute w-full border-t-2 border-dashed border-emerald-400 z-0" style={{ bottom: '75%' }}>
                <span className="absolute -top-4 left-0 text-[9px] font-black text-emerald-600 bg-white px-1 rounded">META 75%</span>
              </div>
            </div>
            {ppcChartData.length === 0 ? (
              <div className="w-full h-full flex items-center justify-center text-slate-400 text-xs italic">Nenhum dado de PPC registado.</div>
            ) : (
              ppcChartData.map((d, i) => (
                <div key={i} className="flex-1 flex flex-col items-center justify-end h-full z-10 group relative">
                  <div className="opacity-0 group-hover:opacity-100 absolute -top-8 bg-slate-800 text-white text-[10px] px-2 py-1 rounded pointer-events-none transition-opacity whitespace-nowrap z-20 shadow-lg">
                    {d.ppc.toFixed(1)}% ({d.completed}/{d.totalPlanned})
                  </div>
                  <div className={`w-full max-w-[40px] rounded-t-md transition-all cursor-pointer ${d.ppc > 74.9 ? 'bg-indigo-500 hover:bg-indigo-400' : 'bg-rose-500 hover:bg-rose-400'}`} style={{ height: `${Math.max(d.ppc, 2)}%` }}></div>
                  <span className="text-[8px] text-slate-500 mt-2 font-bold rotate-45 origin-top-left absolute -bottom-6 whitespace-nowrap">{formatDateBR(d.weekStart).slice(0,5)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200 flex flex-col">
          <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider mb-2">Principais Causas de Atraso (Top 5)</h3>
          <p className="text-[10px] text-slate-500 mb-4">Frequência e percentual acumulado dos motivos de desvio.</p>
          <div className="flex-1 flex flex-col justify-center">
            {delayStats.length === 0 ? (
              <div className="w-full flex items-center justify-center text-slate-400 text-xs italic h-full">Nenhum atraso com motivo registado.</div>
            ) : (
              <div className="space-y-4">
                {delayStats.map((d, i) => (
                  <div key={i} className="relative">
                    <div className="flex justify-between text-[10px] font-bold mb-1">
                      <span className="text-slate-700 truncate pr-2" title={d.reason}>{d.reason}</span>
                      <span className="text-rose-600 whitespace-nowrap">{d.count} ocorrência(s) ({d.cumulativePercent.toFixed(1)}% acum.)</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden relative">
                      <div className="bg-rose-500 h-full rounded-full transition-all" style={{ width: `${d.percent}%` }}></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const renderCronograma = () => (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-4">
          <div>
            <h2 className="text-lg font-black text-indigo-900 uppercase tracking-tight mb-1">Importação Directa de Planilha</h2>
            <p className="text-xs text-slate-500">Carregue o seu ficheiro de planeamento gerado pelo seu software (Excel ou CSV).</p>
          </div>
          <button 
            onClick={() => triggerConfirm(
              'Limpar Banco de Dados', 
              'Deseja realmente limpar toda a base de dados do cronograma, metas e painéis? Esta ação não pode ser desfeita e redefinirá o projeto.', 
              async () => {
                const initialData = INITIAL_PAVIMENTOS.reduce((acc, f) => ({ ...acc, [f]: cloneDeep(INITIAL_STRUCTURE) }), {});
                const initialWeights = INITIAL_PAVIMENTOS.reduce((acc, f) => ({ ...acc, [f]: { estrutura: 50, instalacoes: 50 } }), {});
                const initialMatrices = [{ id: 'default_matrix', name: 'Matriz Principal', floors: INITIAL_PAVIMENTOS, macros: Object.keys(INITIAL_STRUCTURE) }];
                await saveToDB(INITIAL_PAVIMENTOS, initialData, [], initialWeights, [], [], INITIAL_TEAMS, INITIAL_DELAYS, [], initialMatrices);
                setNotification({ message: 'Base de dados limpa com sucesso!', type: 'success' });
              }
            )}
            className="px-4 py-2 bg-rose-50 border border-rose-200 text-rose-700 hover:bg-rose-100 font-black rounded-xl text-xs uppercase tracking-wider transition active:scale-95 whitespace-nowrap"
          >
            🗑️ Limpar BD
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-6">O sistema localiza automaticamente os cabeçalhos (ex: Linha 4) e mapeia colunas como "Pacote de trabalho", "Lote" e "Serviço".</p>
        <div className="border-2 border-dashed border-slate-300 rounded-2xl p-8 bg-slate-50 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500 transition relative">
          <input type="file" accept=".xlsx, .xls, .csv" onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
          <span className="text-4xl mb-2">📊</span>
          <p className="text-xs font-black text-slate-700">CLIQUE OU ARRASTE O SEU EXCEL AQUI</p>
          <p className="text-[10px] text-slate-400 mt-1 uppercase">Aceita formatos .xlsx, .xls ou .csv</p>
        </div>
      </div>
      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-2">
          <h3 className="text-sm font-black text-slate-800 uppercase">Atividades do Cronograma Ativo ({cronogramaInicial.length})</h3>
          {lastUpdatedTime && (
            <span className="text-[10px] font-bold text-slate-500 uppercase">
              Última Importação: <strong className="text-indigo-600">{lastUpdatedTime}</strong>
            </span>
          )}
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-800 text-white uppercase text-[9px] tracking-wider">
              <tr>
                <th className="p-3">Etapa (Macro)</th>
                <th className="p-3">Pavimento (Lote)</th>
                <th className="p-3">Serviço</th>
                <th className="p-3 text-center">Dias</th>
                <th className="p-3 text-center">Fim Planeado</th>
                <th className="p-3 text-center">Último Realizado</th>
                <th className="p-3 text-center">Equipa Associada</th>
                <th className="p-3 text-right">Custo Estimado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {cronogramaInicial.map((item, idx) => (
                <tr key={idx} className="hover:bg-slate-50">
                  <td className="p-3 font-bold text-indigo-900">{item.macro}</td>
                  <td className="p-3 text-slate-600">{item.floor}</td>
                  <td className="p-3 font-bold text-slate-800">{item.service}</td>
                  <td className="p-3 text-center text-slate-500">{item.duration}</td>
                  <td className="p-3 text-center text-slate-500">{formatDateBR(item.end)}</td>
                  <td className="p-3 text-center font-bold text-slate-700">{item.progress ?? 0}%</td>
                  <td className="p-3 text-center"><span className="px-2 py-0.5 bg-slate-100 rounded text-[9px] font-black text-slate-600">{item.responsible || 'EQUIPA GERAL'}</span></td>
                  <td className="p-3 text-right text-emerald-600 font-mono">R$ {item.cost?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );


  const renderPlanning = () => (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-300">
      <div className="bg-gradient-to-r from-indigo-900 to-slate-900 text-white p-6 rounded-2xl shadow-xl flex flex-col md:flex-row justify-between items-center gap-6">
        <div className="space-y-2">
          <span className="px-3 py-1 bg-indigo-800 text-[10px] font-black tracking-wider uppercase rounded-full border border-indigo-700 text-indigo-300">KPI Produtividade</span>
          <h2 className="text-xl font-black">PPC - Percentual de Planos Concluídos</h2>
          <p className="text-xs text-indigo-200">Percentual de serviços planeados executados integralmente conforme a meta semanal ativa.</p>
        </div>
        <div className="flex items-center space-x-6">
          <div className="text-center bg-indigo-950/50 p-4 rounded-xl border border-indigo-800">
            <div className="text-3xl font-black text-emerald-400">{currentWeekPpcStats.percent.toFixed(1)}%</div>
            <div className="text-[10px] font-bold text-indigo-300 uppercase tracking-tight mt-1">{currentWeekPpcStats.completedCount} de {currentWeekPpcStats.totalPlannedCount} Concluídos</div>
          </div>
        </div>
      </div>

      <div className="bg-white p-4 rounded-2xl shadow-md border border-slate-200">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-6">
          <div className="flex items-center space-x-2 bg-slate-100 p-1.5 rounded-xl">
            <button onClick={() => setCurrentWeekStart(prev => addDays(prev, -7))} className="p-2.5 hover:bg-white rounded-lg shadow-sm transition">◀</button>
            <div className="text-center min-w-[180px]">
              <div className="text-[9px] uppercase font-bold text-slate-500">Semana Selecionada</div>
              <div className="text-xs font-black text-indigo-900">{currentWeekStart.toLocaleDateString()} - {new Date(currentWeekStart.getTime() + 4*86400000).toLocaleDateString()}</div>
            </div>
            <button onClick={() => setCurrentWeekStart(prev => addDays(prev, 7))} className="p-2.5 hover:bg-white rounded-lg shadow-sm transition">▶</button>
          </div>
          <div className="flex gap-2 w-full md:w-auto">
            <button onClick={() => setFinalizeModal({ isOpen: true, carryOverUnfinished: true })} disabled={weeklyTasks.length === 0} className="flex-1 md:flex-none px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-black rounded-xl shadow transition active:scale-95 text-xs uppercase tracking-wider flex items-center justify-center gap-2">
              <span>🏁</span> Finalizar Semana
            </button>
            <button onClick={() => { setDrawerMacro(allPossibleMacros[0] || ''); setDrawerWarning(''); setIsDrawerOpen(true); }} className="flex-1 md:flex-none px-4 py-3 bg-indigo-600 text-white font-black rounded-xl shadow hover:bg-indigo-700 transition active:scale-95 text-xs uppercase tracking-wider flex items-center justify-center gap-2">
              <span>➕</span> Adicionar Atividades
            </button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="bg-slate-800 text-white uppercase text-[9px] tracking-tight">
                <th className="p-3 border-r border-slate-700 w-44">Serviço / Pavimento</th>
                <th className="p-3 border-r border-slate-700 w-40 text-center">Responsável / Equipa</th>
                <th className="p-3 border-r border-slate-700 text-center w-48 bg-slate-900">Meta Planeada</th>
                <th className="p-3 border-r border-slate-700 text-center w-56">Dias de Trabalho (S-S)</th>
                <th className="p-3 border-r border-slate-700 text-center w-48">Progresso da Semana</th>
                <th className="p-3 border-r border-slate-700 text-center w-40">Motivo de Atraso</th>
                <th className="p-3 w-56">Observações (Toque no 🎙️ para falar)</th>
                <th className="p-3 text-center w-12">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {weeklyTasks.map(t => {
                const currentPlan = t.plannedThisWeek ?? 100;
                const progVal = t.progressThisWeek ?? 0;
                const showDelayAlert = currentPlan > progVal;
                return (
                  <tr key={t.id} className={`hover:bg-slate-50 transition ${t.finalized ? 'bg-slate-100/70 opacity-75' : showDelayAlert && (progVal > 0 || currentPlan > 0) ? 'bg-red-50/40' : ''}`}>
                    <td className="p-3 border-r">
                      <div className="flex items-center space-x-1.5">
                        {t.finalized && <span className="text-[10px] text-slate-500" title="Semana Finalizada">🔒</span>}
                        <div className="font-black text-slate-800 uppercase tracking-tight text-[11px] leading-tight truncate">{t.activityName}</div>
                      </div>
                      <div className="text-[9px] font-bold text-indigo-600 uppercase mt-0.5">{t.floor}</div>
                    </td>
                    <td className="p-3 border-r text-center">
                      <select disabled={t.finalized} className="w-full p-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold uppercase cursor-pointer focus:bg-white disabled:opacity-80 disabled:cursor-not-allowed" value={t.responsible || ''} onChange={e => handleUpdateTaskField(t.id, 'responsible', e.target.value)}>
                        <option value="">-- Escolha --</option>
                        {teams.map(team => <option key={team} value={team}>{team}</option>)}
                      </select>
                    </td>
                    <td className="p-3 border-r bg-emerald-50/30">
                      <div className="flex gap-1 justify-center">
                        {[25, 50, 75, 100].map(val => (
                          <button key={val} disabled={t.finalized} onClick={() => handlePlannedChange(t.id, val)} className={`w-8 h-8 rounded-full text-[9px] font-black flex items-center justify-center transition-all ${currentPlan === val ? 'bg-emerald-600 text-white scale-110 shadow-md ring-2 ring-emerald-300' : 'bg-slate-100 text-slate-500 hover:bg-emerald-100 hover:text-emerald-700'} disabled:opacity-50 disabled:cursor-default`}>{val}%</button>
                        ))}
                      </div>
                    </td>
                    <td className="p-3 border-r align-middle bg-slate-50/50">
                      <DaysSelector dailyWork={t.dailyWork} disabled={t.finalized} onChange={(newDW) => handleDailyWorkChange(t.id, newDW)} />
                    </td>
                    <td className="p-3 border-r">
                      <div className="flex gap-1 justify-center">
                        {[25, 50, 75, 100].map(val => {
                          const isActive = progVal === val;
                          const isOk = val > currentPlan || val === currentPlan;
                          const btnColor = isOk ? 'bg-blue-600 ring-blue-300' : 'bg-red-600 ring-red-300';
                          return (
                            <button key={val} disabled={t.finalized} onClick={() => handleWeeklyProgressChange(t.id, val)} className={`w-8 h-8 rounded-full text-[9px] font-black flex items-center justify-center transition-all ${isActive ? `${btnColor} text-white scale-110 shadow-md ring-2` : 'bg-slate-100 text-slate-500 hover:bg-slate-200'} disabled:opacity-50 disabled:cursor-default`}>{val}%</button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="p-3 border-r text-center">
                      {showDelayAlert ? (
                        <select disabled={t.finalized} className="w-full p-2 bg-red-100/80 border border-red-200 rounded-lg text-[10px] font-bold text-red-800 cursor-pointer disabled:opacity-80" value={t.delayReason || ''} onChange={e => handleUpdateTaskField(t.id, 'delayReason', e.target.value)}>
                          <option value="">⚠️ Motivo...</option>
                          {delayReasons.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      ) : (
                        <span className="text-[10px] font-bold text-emerald-600">✓ Conforme</span>
                      )}
                    </td>
                    <td className="p-3 border-r">
                      <div className="flex items-center space-x-1.5">
                        <button disabled={t.finalized} onClick={() => handleVoiceInput(t.id)} className={`p-2 rounded-full transition active:scale-95 text-sm ${listeningTaskId === t.id ? 'bg-red-600 text-white animate-ping' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'} disabled:opacity-40`} title="Ditar Observação">🎙️</button>
                        <input type="text" disabled={t.finalized} className="flex-1 bg-slate-50 border border-slate-200 p-2 rounded-lg text-[10px] font-medium disabled:opacity-80" placeholder="Notas..." value={t.observations || ''} onChange={e => { const val = e.target.value; setPlanning(planning.map(p => p.id === t.id ? { ...p, observations: val } : p)); }} onBlur={() => saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices)} />
                      </div>
                    </td>
                    <td className="p-3 text-center">
                      <button disabled={t.finalized} onClick={() => triggerConfirm('Excluir Atividade', `Deseja remover "${t.activityName}" desta semana?`, () => handleRemoveTask(t.id))} className="text-red-500 hover:text-red-700 font-bold text-sm disabled:opacity-30">🗑️</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {weeklyTasks.length === 0 && (
            <div className="p-12 text-center text-slate-400 font-medium italic">Nenhuma atividade agendada para esta semana. Toque no botão acima para adicionar.</div>
          )}
        </div>
      </div>
    </div>
  );

  const renderVisualization = () => (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-5 rounded-2xl shadow-md border border-slate-200 gap-4">
        <div>
          <h2 className="text-lg font-black text-slate-800 uppercase tracking-tight">Matrizes de Visualização</h2>
          <p className="text-xs text-slate-500">Crie painéis customizados para visualizar o avanço de pavimentos e etapas específicas.</p>
        </div>
        <button onClick={handleCreateMatrix} className="px-5 py-2.5 bg-indigo-600 text-white font-black uppercase tracking-wider rounded-xl text-xs hover:bg-indigo-700 transition shadow-md whitespace-nowrap">+ NOVA MATRIZ</button>
      </div>

      {matrices.map(matrix => (
        <div key={matrix.id} className="bg-white rounded-2xl shadow-md overflow-hidden border border-slate-200">
          <div className="bg-slate-100 p-4 flex justify-between items-center border-b border-slate-200">
            <input type="text" value={matrix.name} onChange={(e) => handleMatrixNameChange(matrix.id, e.target.value)} onBlur={saveMatrixName} className="font-black text-sm uppercase text-slate-800 bg-transparent focus:bg-white focus:ring-2 focus:ring-indigo-500 rounded px-2 py-1 outline-none w-1/2 md:w-1/3" placeholder="NOME DA MATRIZ" />
            {matrices.length > 1 && (
              <button onClick={() => triggerConfirm('Excluir Matriz', `Remover a matriz "${matrix.name}"?`, () => handleDeleteMatrix(matrix.id))} className="text-red-500 font-bold text-[10px] hover:underline px-2 uppercase tracking-wider">Remover Painel</button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-900 text-white uppercase text-[9px] tracking-wider">
                <tr>
                  <th className="p-4 text-left sticky left-0 bg-slate-900 z-10 w-48 border-r border-slate-700">Pavimento</th>
                  {matrix.macros.map(mId => (
                    <th key={mId} className="p-3 text-center group relative min-w-[120px] border-r border-slate-700">
                      {getMacroTitle(mId)}
                      <button onClick={() => removeMatrixColumn(matrix.id, mId)} className="absolute top-1 right-2 opacity-0 group-hover:opacity-100 text-rose-400 hover:text-rose-300 font-black text-xs leading-none" title="Remover Coluna">&times;</button>
                    </th>
                  ))}
                  <th onClick={() => setMatrixSelection({ isOpen: true, matrixId: matrix.id, type: 'macro' })} className="p-3 text-center text-indigo-300 cursor-pointer hover:bg-slate-800 hover:text-white transition whitespace-nowrap min-w-[150px]">+ ADICIONAR ETAPA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {matrix.floors.map(fId => (
                  <tr key={fId} className="hover:bg-slate-50 transition group">
                    <td className="p-3 font-black text-slate-700 bg-slate-50 sticky left-0 z-10 border-r border-slate-200 flex justify-between items-center min-w-[180px]">
                      <span>{fId}</span>
                      <button onClick={() => removeMatrixRow(matrix.id, fId)} className="opacity-0 group-hover:opacity-100 text-rose-500 font-black hover:bg-rose-100 px-1.5 rounded" title="Remover Linha">&times;</button>
                    </td>
                    {matrix.macros.map(mId => {
                      const sec = allFloorsData[fId]?.[mId];
                      const avg = sec?.items && sec.items.length > 0 ? (sec.items.reduce((a, i) => a + (i.actualPercent || 0), 0) / sec.items.length) : 0;
                      const isCompleted = avg > 98.9;
                      const isHalf = avg > 50;
                      const isStarted = avg > 0;
                      let colorClass = 'text-slate-400';
                      if(isCompleted) colorClass = 'bg-emerald-100 text-emerald-800';
                      else if(isHalf) colorClass = 'bg-indigo-50 text-indigo-700';
                      else if(isStarted) colorClass = 'bg-orange-50 text-orange-700';
                      return <td key={mId} className={`p-3 text-center font-black transition-colors border-r border-slate-100 ${colorClass}`}>{avg.toFixed(1)}%</td>;
                    })}
                    <td className="bg-slate-50/30"></td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={matrix.macros.length + 2} onClick={() => setMatrixSelection({ isOpen: true, matrixId: matrix.id, type: 'floor' })} className="p-4 text-center text-[10px] font-black uppercase text-indigo-600 bg-slate-50 hover:bg-indigo-50 cursor-pointer transition border-t border-dashed border-slate-300">
                    + ADICIONAR PAVIMENTO / LOTE NA LINHA
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );

  const renderInfographic = () => (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <h3 className="text-sm font-black text-slate-800 uppercase mb-4 flex items-center gap-2"><span>📈</span> Evolução Semanal de PPC do Projeto</h3>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {ppcHistory.map((h, i) => (
            <div key={i} className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col justify-between">
              <div className="text-[10px] font-black text-slate-400 uppercase">Semana de {formatDateBR(h.weekStart)}</div>
              <div className="text-2xl font-black text-indigo-900 mt-1">{h.ppc.toFixed(1)}%</div>
              <div className="text-[10px] text-slate-500 font-bold uppercase mt-2">{h.completed} / {h.totalPlanned} planos concluídos</div>
            </div>
          ))}
          {ppcHistory.length === 0 && <div className="col-span-full py-8 text-center text-xs text-slate-400 font-bold uppercase italic font-mono">Nenhuma semana encerrada na base de dados.</div>}
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-4">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 border-b pb-4">
          <div>
            <h3 className="text-sm font-black text-slate-800 uppercase flex items-center gap-2"><span>📊</span> Tabela Consolidada de Planeamento Semanal (Histórico Geral)</h3>
          </div>
          <button onClick={handleExportCSV} className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs uppercase tracking-wider rounded-xl shadow-lg flex items-center gap-2 transition"><span>📥</span> Exportar para Excel (.csv)</button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Pesquisa</label><input type="text" className="w-full p-2 border rounded-lg text-xs" placeholder="Pesquise..." value={giantSearch} onChange={e => setHistorySearch(e.target.value)} /></div>
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Pavimento</label><select className="w-full p-2 border rounded-lg text-xs font-bold" value={giantFloorFilter} onChange={e => setHistoryFloorFilter(e.target.value)}><option value="">-- Todos --</option>{floors.map(f => <option key={f} value={f}>{f}</option>)}</select></div>
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Macroatividade</label><select className="w-full p-2 border rounded-lg text-xs font-bold" value={giantMacroFilter} onChange={e => setHistoryMacroFilter(e.target.value)}><option value="">-- Todas --</option>{allPossibleMacros.map(sId => <option key={sId} value={sId}>{getMacroTitle(sId)}</option>)}</select></div>
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Estado</label><select className="w-full p-2 border rounded-lg text-xs font-bold" value={giantStatusFilter} onChange={e => setHistoryStatusFilter(e.target.value)}><option value="">-- Todos --</option><option value="finalized">🔒 Somente Finalizadas</option><option value="active">🔓 Somente Ativas</option></select></div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-[500px]">
          <table className="w-full text-[11px] text-left border-collapse">
            <thead className="bg-slate-800 text-white uppercase text-[9px] tracking-tight sticky top-0 z-10">
              <tr>
                <th className="p-3 border-r border-slate-700">Semana ID</th><th className="p-3 border-r border-slate-700">Pavimento</th><th className="p-3 border-r border-slate-700">Macroatividade</th><th className="p-3 border-r border-slate-700">Serviço</th><th className="p-3 border-r border-slate-700">Equipa</th><th className="p-3 border-r border-slate-700 text-center">Meta Plan.</th><th className="p-3 border-r border-slate-700 text-center">Dias Ativos</th><th className="p-3 border-r border-slate-700 text-center">Avanço Sem.</th><th className="p-3 border-r border-slate-700 text-center">Acumulado</th><th className="p-3 border-r border-slate-700 text-center">Desvio/Atraso</th><th className="p-3 border-r border-slate-700">Observações</th><th className="p-3 text-center">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filteredGiantPlanningTasks.map((t, idx) => {
                const totalAcc = Math.min(100, (t.executedBefore || 0) + (t.progressThisWeek || 0));
                const cPlan = t.plannedThisWeek ?? 100;
                const isDelayed = cPlan > (t.progressThisWeek ?? 0);
                return (
                  <tr key={idx} className={`hover:bg-slate-50/80 transition ${t.finalized ? 'bg-slate-50/50 text-slate-500' : ''}`}>
                    <td className="p-2.5 border-r font-mono whitespace-nowrap">{t.weekId}</td>
                    <td className="p-2.5 border-r font-bold whitespace-nowrap">{t.floor}</td>
                    <td className="p-2.5 border-r uppercase font-medium">{t.sectionId}</td>
                    <td className="p-2.5 border-r font-black text-slate-800 uppercase">{t.activityName}</td>
                    <td className="p-2.5 border-r uppercase font-bold text-indigo-900 whitespace-nowrap">{t.responsible}</td>
                    <td className="p-2.5 border-r text-center font-black">{cPlan}%</td>
                    <td className="p-2.5 border-r text-center"><div className="flex gap-1 justify-center">{(t.dailyWork || [0,0,0,0,0]).map((dw, i) => <span key={i} className={`w-6 h-6 rounded-full text-[8px] font-black flex items-center justify-center ${dw ? 'bg-slate-300 text-slate-700 shadow-inner' : 'bg-slate-100 text-slate-300'}`}>{['S','T','Q','Q','S'][i]}</span>)}</div></td>
                    <td className="p-2.5 border-r text-center font-black text-emerald-600">{t.progressThisWeek ?? 0}%</td>
                    <td className="p-2.5 border-r text-center font-black"><div className="flex items-center justify-center space-x-1.5"><div className="w-10 bg-slate-200 rounded-full h-1.5 hidden sm:block"><div className="bg-slate-700 h-1.5 rounded-full" style={{ width: `${totalAcc}%` }}></div></div><span>{totalAcc.toFixed(0)}%</span></div></td>
                    <td className="p-2.5 border-r text-center font-bold">{isDelayed ? <span className="text-red-600 text-[10px] leading-tight block">⚠️ {t.delayReason || 'N/A'}</span> : <span className="text-emerald-600">✓ Concluído</span>}</td>
                    <td className="p-2.5 border-r italic text-[10px] max-w-xs truncate" title={t.observations}>{t.observations || 'N/A'}</td>
                    <td className="p-2.5 text-center font-black whitespace-nowrap">{t.finalized ? '🔒 Finalizado' : '🔓 Ativo'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <h3 className="text-sm font-black text-slate-800 uppercase mb-4 flex items-center gap-2"><span>🔄</span> Evolução e Variação Acumulada por Pacote (Histórico Geral)</h3>
        <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
          {macroEvolutionHistory.map((macro, idx) => (
            <div key={idx} className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
              <div className="flex justify-between items-start">
                <div><span className="text-[9px] font-black bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded uppercase tracking-wider">{macro.sectionTitle}</span><h4 className="text-xs font-black text-slate-800 uppercase mt-1">{macro.floor}</h4></div>
                <div className="text-right"><span className="text-xs font-black text-emerald-600">Avanço Histórico do Pacote</span></div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap pt-2">
                <span className="text-[10px] font-bold text-slate-400">0%</span>
                {macro.changes.map((change, cIdx) => {
                  const isDeltaNegative = 0 > change.delta;
                  return (
                    <React.Fragment key={cIdx}>
                      <span className="text-slate-300">→</span>
                      <div className="bg-slate-800 px-2 py-1 rounded text-center cursor-help transition-shadow hover:shadow-md relative group">
                        <div className={`text-[9px] font-black ${isDeltaNegative ? 'text-rose-400' : 'text-emerald-400'}`}>{isDeltaNegative ? '' : '+'}{change.delta.toFixed(1)}%</div>
                        <div className="text-[8px] text-slate-400">{change.dateStr}</div>
                        <div className="opacity-0 group-hover:opacity-100 pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-slate-900 text-white text-[10px] p-3 rounded shadow-xl whitespace-nowrap z-10 transition-opacity border border-slate-700">
                          <p className="font-bold text-indigo-300 border-b border-slate-700 pb-1 mb-1">Serviços na Semana:</p>
                          {change.services.map((s, sIdx) => {
                            const sIsNeg = 0 > s.delta;
                            return <div key={sIdx} className="flex justify-between gap-4"><span>{s.name}</span><span className={sIsNeg ? 'text-rose-400' : 'text-emerald-400'}>{!sIsNeg ? '+' : ''}{s.delta.toFixed(1)}%</span></div>;
                          })}
                          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-900"></div>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ))}
          {macroEvolutionHistory.length === 0 && <div className="text-center py-12 text-slate-400 font-bold uppercase italic text-xs">Nenhum dado de variação acumulada disponível.</div>}
        </div>
      </div>
    </div>
  );

  const renderConfig = () => (
    <div className="space-y-6 animate-in fade-in duration-300 pb-20">
      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-4">
        <h2 className="text-md font-black uppercase border-b pb-2 text-slate-800">1. Gestão de Pavimentos / Lotes</h2>
        <div className="flex gap-2 max-w-md">
          <input type="text" placeholder="EX: TÉRREO, SUBSOLO..." className="flex-1 p-2 text-xs border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none uppercase font-bold" value={newFloorName} onChange={(e) => setNewFloorName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddFloor()} />
          <button onClick={handleAddFloor} className="bg-slate-800 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-slate-900 transition">ADICIONAR</button>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          {floors.map(floor => (
            <div key={floor} className="flex items-center space-x-2 px-3 py-1.5 bg-slate-100 rounded-lg text-xs font-bold text-slate-700 border">
              <span>{floor}</span>
              <button onClick={() => triggerConfirm('Remover Pavimento', `Tem a certeza que deseja excluir "${floor}"?`, () => handleDeleteFloor(floor))} className="text-red-500 hover:text-red-700 font-black ml-1">&times;</button>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-6">
        <h2 className="text-md font-black uppercase border-b pb-2 text-slate-800">2. Estrutura de Macroatividades e Serviços</h2>
        <div className="bg-slate-50 p-4 rounded-xl border">
          <h3 className="text-xs font-black uppercase text-indigo-600 mb-3">Criar Novo Pacote / Etapa</h3>
          <div className="flex gap-2">
            <input type="text" placeholder="EX: ALVENARIA, ACABAMENTOS..." className="flex-1 p-2 text-xs border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none uppercase font-bold" value={newPackageName} onChange={(e) => setNewPackageName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddNewPackageConfig()} />
            <button onClick={handleAddNewPackageConfig} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-indigo-700 transition">CRIAR</button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs font-black uppercase text-slate-600 mb-3">Adicionar Item ao Pacote Selecionado</h3>
            <div className="flex flex-wrap gap-1 mb-3">
              {allPossibleMacros.map(sId => (
                <button key={sId} onClick={() => setActiveSection(sId)} className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase transition ${activeSection === sId ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{getMacroTitle(sId)}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <input type="text" placeholder="EX: REBOCO, MASSA..." className="flex-1 p-2 text-xs border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none uppercase font-bold" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddNewItemConfig()} />
              <button onClick={handleAddNewItemConfig} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-indigo-700 transition">ADICIONAR</button>
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto mt-4 border-t pt-2">
              {configItemsToDisplay.map(item => (
                <div key={item.id} className="flex justify-between items-center p-2 bg-slate-50 rounded-lg text-xs">
                  <span className="font-bold text-slate-700">{item.name}</span>
                  <button onClick={() => handleDeleteItemConfig(item)} className="text-red-500 text-[10px] font-bold hover:underline">Excluir</button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-black uppercase text-slate-600 mb-3">Ponderação / Pesos das Etapas (%)</h3>
            <div className="bg-slate-50 p-3 rounded-xl border text-[10px] overflow-x-auto">
              <table className="w-full">
                <thead><tr className="text-slate-400 font-bold uppercase"><th className="p-1 text-left">Pavimento</th>{allPossibleMacros.map(sId => <th key={sId} className="p-1 text-center">{getMacroTitle(sId)}</th>)}</tr></thead>
                <tbody>
                  {floors.map(f => (
                    <tr key={f} className="border-t">
                      <td className="p-1 font-bold text-slate-600">{f}</td>
                      {allPossibleMacros.map(sId => (
                        <td key={sId} className="p-1"><input type="number" className="w-12 p-0.5 text-center font-bold border rounded" value={weights[f]?.[sId] ?? 0} onChange={e => { const val = parseFloat(e.target.value) || 0; setWeights({ ...weights, [f]: { ...weights[f], [sId]: val } }); }} onBlur={() => saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices)} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <h2 className="text-md font-black uppercase border-b pb-2 text-slate-800">3. Gestão de Equipas / Empreiteiros</h2>
        <div className="flex gap-2 max-w-md mb-4">
          <input type="text" placeholder="Nome da Equipa..." className="flex-1 p-2 text-xs border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none uppercase font-bold" value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddTeam()} />
          <button onClick={handleAddTeam} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-indigo-700 transition">REGISTAR</button>
        </div>
        <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-2">
          {teams.map(team => (
            <div key={team} className="flex items-center space-x-2 px-3 py-1.5 bg-slate-100 rounded-full text-xs font-bold text-slate-700 border">
              <span>{team}</span>
              <button onClick={() => triggerConfirm('Remover Equipa', `Deseja realmente excluir "${team}"?`, () => handleDeleteTeam(team))} className="text-red-500 hover:text-red-700 font-bold ml-1">&times;</button>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <h2 className="text-md font-black uppercase border-b pb-2 text-slate-800">4. Padronização de Motivos de Atraso</h2>
        <div className="flex gap-2 max-w-lg mb-4">
          <input type="text" placeholder="Descrição do motivo..." className="flex-1 p-2 text-xs border rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none font-bold" value={newDelayReason} onChange={(e) => setNewDelayReason(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddDelayReason()} />
          <button onClick={handleAddDelayReason} className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-bold hover:bg-indigo-700 transition">REGISTAR</button>
        </div>
        <div className="space-y-2 max-h-48 overflow-y-auto pr-2">
          {delayReasons.map(reason => (
            <div key={reason} className="flex justify-between items-center p-2.5 bg-slate-50 rounded-lg text-xs font-bold text-slate-700 border">
              <span>{reason}</span>
              <button onClick={() => triggerConfirm('Remover Motivo', `Deseja remover "${reason}"?`, () => handleDeleteDelayReason(reason))} className="text-red-500 hover:text-red-700 font-bold ml-1">&times;</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-900 text-white font-sans">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-sm font-bold tracking-widest text-indigo-200 uppercase animate-pulse">Carregando dados do Firebase...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 relative overflow-x-hidden">
      <header className="bg-slate-900 p-4 text-white shadow-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-3">
          <div className="flex items-center space-x-3">
            <span className="text-3xl">🏗️</span>
            <div><h1 className="text-lg font-black tracking-tight leading-none">CONSTRUGEST PRO</h1><span className="text-[9px] uppercase tracking-wider text-emerald-400 font-bold">Modo Touch Total & Controlo de Obra</span></div>
          </div>
          <div className="flex items-center space-x-2"><span className="px-3 py-1 bg-slate-800 rounded-full text-[9px] font-mono border border-slate-700 text-slate-300">ID: {userId}</span></div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 pb-24">
        <nav className="flex gap-1 border-b border-slate-300 mb-6 overflow-x-auto pb-1 no-scrollbar sticky top-[68px] bg-slate-50 z-30 pt-2">
          <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'dashboard' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>🏠 Painel</button>
          <button onClick={() => setActiveTab('cronograma-inicial')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'cronograma-inicial' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>📅 Cronograma</button>
          <button onClick={() => setActiveTab('planning')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'planning' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>🗓️ Planeamento Semanal</button>
          <button onClick={() => setActiveTab('visualization')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'visualization' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>📊 Matriz Geral</button>
          <button onClick={() => setActiveTab('infographic')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'infographic' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>📋 Histórico & PPC</button>
          <button onClick={() => setActiveTab('config')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'config' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>⚙️ Configurações</button>
        </nav>

        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'cronograma-inicial' && renderCronograma()}
        {activeTab === 'planning' && renderPlanning()}
        {activeTab === 'visualization' && renderVisualization()}
        {activeTab === 'infographic' && renderInfographic()}
        {activeTab === 'config' && renderConfig()}
      </main>

      {/* Drawer */}
      {isDrawerOpen && (
        <div className="fixed inset-0 z-50 overflow-hidden">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity" onClick={() => setIsDrawerOpen(false)} />
          <div className="absolute inset-y-0 right-0 max-w-full flex pl-10">
            <div className="w-screen max-w-md bg-white shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
              <div className="p-5 bg-indigo-950 text-white flex justify-between items-center">
                <div><h3 className="font-black text-sm uppercase tracking-wider">Adicionar Atividades</h3><p className="text-[10px] text-indigo-300">Selecione e planeie a partir do cronograma</p></div>
                <button onClick={() => setIsDrawerOpen(false)} className="text-2xl font-bold hover:text-indigo-200">&times;</button>
              </div>
              <div className="flex-1 p-5 space-y-5 overflow-y-auto">
                {drawerWarning && <div className="bg-red-50 border border-red-200 text-red-700 text-[10px] font-bold p-3 rounded-lg">{drawerWarning}</div>}
                <div className="space-y-2">
                  <label className="block text-[10px] font-black uppercase text-indigo-600">1. Selecione a Macroatividade</label>
                  <select className="w-full p-2.5 bg-slate-100 border rounded-lg font-bold text-xs cursor-pointer focus:bg-white" value={drawerMacro} onChange={(e) => { setDrawerMacro(e.target.value); setDrawerFloors([]); setDrawerSelectedServices([]); setDrawerWarning(''); }}>
                    <option value="">-- Escolha --</option>
                    {allPossibleMacros.map(macro => <option key={macro} value={macro}>{getMacroTitle(macro)}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="block text-[10px] font-black uppercase text-indigo-600">2. Marque os Pavimentos</label>
                    {availableFloorsForMacro.length > 0 && <button onClick={() => { if(drawerFloors.length === availableFloorsForMacro.length) setDrawerFloors([]); else setDrawerFloors([...availableFloorsForMacro]); }} className="text-[9px] font-bold text-indigo-700 hover:underline uppercase">Todos</button>}
                  </div>
                  <div className={`grid grid-cols-2 gap-2 ${!drawerMacro ? 'opacity-50 pointer-events-none' : ''}`}>
                    {availableFloorsForMacro.map(floor => (
                      <label key={floor} className="flex items-center space-x-2 p-2 bg-slate-50 rounded-lg border hover:border-indigo-300 transition cursor-pointer">
                        <input type="checkbox" className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500" checked={drawerFloors.includes(floor)} onChange={(e) => { if (e.target.checked) setDrawerFloors([...drawerFloors, floor]); else setDrawerFloors(drawerFloors.filter(f => f !== floor)); }} />
                        <span className="text-[10px] font-bold text-slate-700 truncate">{floor}</span>
                      </label>
                    ))}
                    {availableFloorsForMacro.length === 0 && drawerMacro && <p className="text-[10px] text-slate-400 italic col-span-2">Nenhum pavimento para esta macro.</p>}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="block text-[10px] font-black uppercase text-indigo-600">3. Selecione os Serviços</label>
                    {availableServicesForMacroAndFloors.length > 0 && <button onClick={() => { if (drawerSelectedServices.length === availableServicesForMacroAndFloors.length) setDrawerSelectedServices([]); else setDrawerSelectedServices(availableServicesForMacroAndFloors.map(s => s.id)); }} className="text-[9px] font-bold text-indigo-700 hover:underline uppercase">Todos</button>}
                  </div>
                  <div className="bg-slate-50 border rounded-xl p-3 max-h-56 overflow-y-auto space-y-2">
                    {availableServicesForMacroAndFloors.map(item => (
                      <label key={item.id} className="flex items-center space-x-3 p-2 bg-white rounded-lg border hover:border-indigo-300 transition cursor-pointer">
                        <input type="checkbox" className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500" checked={drawerSelectedServices.includes(item.id)} onChange={(e) => { if (e.target.checked) setDrawerSelectedServices([...drawerSelectedServices, item.id]); else setDrawerSelectedServices(drawerSelectedServices.filter(id => id !== item.id)); }} />
                        <div className="text-xs"><p className="font-bold text-slate-800">{item.service}</p><p className="text-[9px] text-slate-500 font-bold">{item.floor}</p></div>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-2 border-t pt-3">
                  <label className="block text-[10px] font-black uppercase text-slate-400">4. Atribuir Equipa</label>
                  <select className="w-full p-2.5 bg-slate-100 border rounded-lg text-xs font-bold uppercase cursor-pointer" value={drawerResponsible} onChange={e => setDrawerResponsible(e.target.value)}>
                    <option value="">-- Padrão --</option>
                    {teams.map(team => <option key={team} value={team}>{team}</option>)}
                  </select>
                </div>
              </div>
              <div className="p-5 bg-slate-50 border-t sticky bottom-0">
                <button onClick={handleIncludeDrawerActivities} disabled={drawerSelectedServices.length === 0} className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-black uppercase tracking-wider rounded-xl shadow-md transition transform active:scale-95">Confirmar Atividades</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Matrix Selection Modal */}
      {matrixSelection.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 animate-in zoom-in-95">
            <h3 className="font-black text-sm text-slate-900 mb-4 uppercase tracking-tight border-b pb-2">Adicionar {matrixSelection.type === 'macro' ? 'Etapa' : 'Pavimento'}</h3>
            <div className="max-h-60 overflow-y-auto space-y-2 custom-scrollbar pr-2">
              {matrixSelectionOptions.map(option => (
                <button key={option.id} onClick={() => addSelectionToMatrix(option.id)} className="w-full text-left p-3 text-xs font-bold text-slate-700 bg-slate-50 hover:bg-indigo-50 hover:text-indigo-700 rounded-lg border border-slate-200 transition uppercase tracking-wider">+ {option.title}</button>
              ))}
              {matrixSelectionOptions.length === 0 && <p className="text-xs text-slate-400 font-bold italic text-center py-4">Todos adicionados.</p>}
            </div>
            <div className="mt-6 flex justify-end">
              <button onClick={() => setMatrixSelection({ isOpen: false, matrixId: '', type: 'macro' })} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold rounded-lg transition">FECHAR</button>
            </div>
          </div>
        </div>
      )}

      {/* Importing Loader Spinner Modal */}
      {isImporting && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-[100] animate-in fade-in duration-300">
          <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center space-y-6 max-w-sm text-center">
            <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
            <div>
              <h3 className="text-white font-black text-sm uppercase tracking-wider">Processando Planilha</h3>
              {importStatus && (
                <div className="bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 text-indigo-400 font-bold text-xs mt-3 animate-pulse">
                  {importStatus}
                </div>
              )}
              <p className="text-[10px] text-slate-400 mt-2">Extraindo atividades e salvando no Firebase. Por favor, não feche o navegador.</p>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6 animate-in zoom-in-95">
            <h3 className="font-black text-sm text-slate-900 mb-2 uppercase tracking-tight">{confirmModal.title}</h3>
            <p className="text-xs text-slate-600 mb-6">{confirmModal.message}</p>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setConfirmModal({ ...confirmModal, isOpen: false })} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold rounded-lg transition">Cancelar</button>
              <button onClick={() => { confirmModal.onConfirm(); setConfirmModal({ ...confirmModal, isOpen: false }); }} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-lg transition">Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {/* Finalize Modal */}
      {finalizeModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-in zoom-in-95">
            <div className="flex items-center space-x-2 text-emerald-600 mb-3"><span className="text-2xl">🏁</span><h3 className="font-black text-sm uppercase tracking-wider">Finalizar Semana de Trabalho</h3></div>
            <p className="text-xs text-slate-600 mb-4 leading-relaxed">Você está a concluir as atividades planeadas para a semana de <strong className="text-indigo-900">{formatDateBR(currentWeekStart)}</strong>. Isso guardará o PPC finalizado de <strong className="text-emerald-600">{currentWeekPpcStats.percent.toFixed(1)}%</strong> diretamente na base de dados.</p>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3 mb-6">
              <label className="flex items-start space-x-3 cursor-pointer">
                <input type="checkbox" className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 mt-0.5" checked={finalizeModal.carryOverUnfinished} onChange={(e) => setFinalizeModal({ ...finalizeModal, carryOverUnfinished: e.target.checked })} />
                <div className="text-xs"><p className="font-bold text-slate-800">Reprogramar saldos não concluídos</p><p className="text-slate-500 mt-0.5 leading-tight">Atividades com avanço parcial serão automaticamente duplicadas para a próxima semana.</p></div>
              </label>
            </div>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setFinalizeModal({ ...finalizeModal, isOpen: false })} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold rounded-lg transition">Voltar</button>
              <button onClick={() => handleFinalizeWeek(finalizeModal.carryOverUnfinished)} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition">Confirmar e Encerrar</button>
            </div>
          </div>
        </div>
      )}

      <Notification {...notification} onClose={() => setNotification({ message: '', type: '' })} />
    </div>
  );
};

export default App;