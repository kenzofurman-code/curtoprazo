import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, updateDoc, onSnapshot } from 'firebase/firestore';

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
const compressString = (str: string): string => {
  if (!str) return '';
  let dictionary: { [key: string]: number } = {};
  const initDict = () => {
    dictionary = {};
    for (let i = 0; i < 256; i++) {
      dictionary[String.fromCodePoint(i)] = i;
    }
  };
  initDict();
  let word = '';
  const result: string[] = [];
  let dictSize = 256;
  for (let i = 0; i < str.length; i++) {
    const char = str.charAt(i);
    const wc = word + char;
    if (Object.prototype.hasOwnProperty.call(dictionary, wc)) {
      word = wc;
    } else {
      result.push(dictionary[word].toString(36));
      if (dictSize < 65000) {
        dictionary[wc] = dictSize++;
      } else {
        initDict();
        dictSize = 256;
      }
      word = char;
    }
  }
  if (word !== '') {
    result.push(dictionary[word].toString(36));
  }
  return result.join(',');
};

const decompressString = (compressedStr: string): string => {
  if (!compressedStr) return '';
  let dictionary: { [key: number]: string } = {};
  const initDict = () => {
    dictionary = {};
    for (let i = 0; i < 256; i++) {
      dictionary[i] = String.fromCodePoint(i);
    }
  };
  initDict();

  const codes = compressedStr.split(',').map(s => parseInt(s, 36));
  if (codes.length === 0 || isNaN(codes[0])) return '';
  let word = dictionary[codes[0]];
  let result = word;
  let entry;
  let dictSize = 256;
  for (let i = 1; i < codes.length; i++) {
    const code = codes[i];
    if (dictionary[code]) {
      entry = dictionary[code];
    } else {
      if (code === dictSize) {
        entry = word + word.charAt(0);
      } else {
        return '';
      }
    }
    result += entry;
    if (dictSize < 65000) {
      dictionary[dictSize++] = word + entry.charAt(0);
    } else {
      initDict();
      dictSize = 256;
    }
    word = entry;
  }
  return result;
};

const decompressIfNeeded = (val: any): string => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return val;
  }
  if (trimmed.startsWith('unicode:')) {
    try {
      return decompressStringUnicode(trimmed);
    } catch (e) {
      console.error("Unicode decompression error:", e);
      return val;
    }
  }
  try {
    const decompressed = decompressString(trimmed);
    if (decompressed && (decompressed.startsWith('{') || decompressed.startsWith('['))) {
      return decompressed;
    }
    return decompressed || val;
  } catch (e) {
    console.error("Decompression check error:", e);
    return val;
  }
};

const compressStringUnicode = (str: string): string => {
  if (!str) return '';
  const bytes = new TextEncoder().encode(str);
  let binaryStr = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryStr += String.fromCodePoint(bytes[i]);
  }
  str = binaryStr;

  let dictionary: { [key: string]: number } = {};
  const initDict = () => {
    dictionary = {};
    for (let i = 0; i < 256; i++) {
      dictionary[String.fromCodePoint(i)] = i;
    }
  };
  initDict();
  let word = '';
  const result: string[] = [];
  let dictSize = 256;
  for (let i = 0; i < str.length; i++) {
    const char = str.charAt(i);
    const wc = word + char;
    if (Object.prototype.hasOwnProperty.call(dictionary, wc)) {
      word = wc;
    } else {
      result.push(dictionary[word].toString(36));
      if (dictSize < 65000) {
        dictionary[wc] = dictSize++;
      } else {
        initDict();
        dictSize = 256;
      }
      word = char;
    }
  }
  if (word !== '') {
    result.push(dictionary[word].toString(36));
  }
  return 'unicode:' + result.join(',');
};

const decompressStringUnicode = (compressedStr: string): string => {
  if (!compressedStr) return '';
  if (!compressedStr.startsWith('unicode:')) {
    throw new Error('Not compressed with Unicode LZW');
  }
  const dataPart = compressedStr.substring(8);
  let dictionary: { [key: number]: string } = {};
  const initDict = () => {
    dictionary = {};
    for (let i = 0; i < 256; i++) {
      dictionary[i] = String.fromCodePoint(i);
    }
  };
  initDict();

  const r = dataPart.split(',');
  let w = dictionary[parseInt(r[0], 36)];
  let result = w;
  let dictSize = 256;

  for (let i = 1; i < r.length; i++) {
    const k = parseInt(r[i], 36);
  let entry;
    if (Object.prototype.hasOwnProperty.call(dictionary, k)) {
      entry = dictionary[k];
    } else if (k === dictSize) {
      entry = w + w.charAt(0);
    } else {
      throw new Error('Decompress error');
    }
    result += entry;

    if (dictSize < 65000) {
      dictionary[dictSize++] = w + entry.charAt(0);
    } else {
      initDict();
      dictSize = 256;
    }
    w = entry;
  }

  const bytes = new Uint8Array(result.length);
  for (let i = 0; i < result.length; i++) {
    bytes[i] = result.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};

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
  const br = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
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

const normalizeHeaderText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

const findColumnIndex = (headerRow, candidates, fallback = -1) => {
  const normalizedHeaders = headerRow.map(normalizeHeaderText);
  const normalizedCandidates = candidates.map(normalizeHeaderText);
  const exactIndex = normalizedHeaders.findIndex(header => normalizedCandidates.includes(header));
  if (exactIndex !== -1) return exactIndex;
  const partialIndex = normalizedHeaders.findIndex(header =>
    normalizedCandidates.some(candidate => candidate && header.includes(candidate))
  );
  return partialIndex !== -1 ? partialIndex : fallback;
};

const findGroupedColumnIndex = (headerRow, groupRow, groupCandidates, headerCandidates, fallback = -1) => {
  let currentGroup = '';
  const normalizedGroups = groupCandidates.map(normalizeHeaderText);
  const normalizedHeaders = headerCandidates.map(normalizeHeaderText);

  for (let i = 0; i < headerRow.length; i++) {
    const groupText = normalizeHeaderText(groupRow[i]);
    if (groupText) currentGroup = groupText;

    const headerText = normalizeHeaderText(headerRow[i]);
    const groupMatches = normalizedGroups.some(group => group && currentGroup.includes(group));
    const headerMatches = normalizedHeaders.some(header => header && headerText === header);

    if (groupMatches && headerMatches) return i;
  }

  return fallback;
};

const roundPercentValue = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(clampPercent(n) * 1000) / 1000;
};

const buildBudgetDiffs = (previousItems, nextItems, fileName = '') => {
  if (!Array.isArray(previousItems) || previousItems.length === 0 || !Array.isArray(nextItems)) return [];

  const importId = `budget_${Date.now()}`;
  const importedAt = new Date().toISOString();
  const previousById = new Map();
  const nextById = new Map();

  previousItems.forEach(item => {
    if (item?.id) previousById.set(item.id, item);
  });
  nextItems.forEach(item => {
    if (item?.id) nextById.set(item.id, item);
  });

  const diffs = [];

  nextItems.forEach(item => {
    if (!item?.id) return;
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

const toISODate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const parseISODateLocal = (dateStr) => {
  if (!dateStr) return new Date();
  const parts = dateStr.split('-');
  if (parts.length !== 3) return new Date(dateStr);
  const yyyy = parseInt(parts[0], 10);
  const mm = parseInt(parts[1], 10) - 1;
  const dd = parseInt(parts[2], 10);
  return new Date(yyyy, mm, dd, 0, 0, 0, 0);
};


const generateMockWeather = (city, dateStr) => {
  let seed = 0;
  const locationStr = String(city || "Curitiba, PR");
  for (let i = 0; i < dateStr.length; i++) seed += dateStr.charCodeAt(i);
  for (let i = 0; i < locationStr.length; i++) seed += locationStr.charCodeAt(i);
  const rand = (seed % 100) / 100;
  
  let conditions = "Ensolarado";
  let icon = "clear-day";
  let tempMax = 22 + Math.floor(rand * 6) - 3;
  let tempMin = 12 + Math.floor(rand * 6) - 3;
  let precip = 0;
  
  if (rand < 0.2) {
    conditions = "Chuva Forte";
    icon = "rain";
    precip = 15;
  } else if (rand < 0.45) {
    conditions = "Parcialmente Nublado";
    icon = "partly-cloudy-day";
  } else if (rand < 0.7) {
    conditions = "Nublado";
    icon = "cloudy";
  } else if (rand < 0.9) {
    conditions = "Garoa";
    icon = "showers";
    precip = 2;
  }
  
  if (locationStr.toLowerCase().includes("curitiba")) {
    tempMax -= 4;
    tempMin -= 4;
  }
  
  return { tempMax, tempMin, precip, conditions, icon };
};

const getWeatherEmoji = (icon) => {
  switch (icon) {
    case 'snow': return '❄️';
    case 'snow-showers': return '🌨️';
    case 'rain': return '🌧️';
    case 'showers-day':
    case 'showers-night':
    case 'showers': return '🌦️';
    case 'thunder-rain':
    case 'thunder-showers-day':
    case 'thunder-showers-night':
    case 'thunder': return '🌩️';
    case 'wind': return '💨';
    case 'fog': return '🌫️';
    case 'cloudy': return '☁️';
    case 'partly-cloudy-day': return '⛅';
    case 'partly-cloudy-night': return '☁️';
    case 'clear-day': return '☀️';
    case 'clear-night': return '🌙';
    default: return '☀️';
  }
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
          className={`w-6 h-6 rounded-full text-[8px] font-black flex items-center justify-center transition-all cursor-pointer ${
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
      Number(item.progress) || 0,
      Array.isArray(item.predecessors) ? item.predecessors : [],
      Array.isArray(item.successors) ? item.successors : [],
      item.inheritedDependenciesFrom || '',
      item.originalId || '',
      item.replicationGroup || '',
      !!item.isParent
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
      progress: Number(t[9]) || 0,
      predecessors: Array.isArray(t[10]) ? t[10] : [],
      successors: Array.isArray(t[11]) ? t[11] : [],
      inheritedDependenciesFrom: t[12] || '',
      originalId: t[13] || '',
      replicationGroup: t[14] || '',
      isParent: !!t[15]
    };
  });
};

const parseDependencyList = (value) => {
  if (value === undefined || value === null || value === '' || value === '-') return [];
  return String(value)
    .split(/[,;\n\r]+/)
    .map(part => part.trim())
    .filter(part => part && part !== '-');
};

const stripServicePrefix = (value) => {
  return String(value || 'serviço')
    .replace(/^MO\s*[-–—:]?\s*/i, '')
    .trim();
};

const getFirstWord = (value) => {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)[0] || '';
};

const inferPortugueseGender = (value, exceptionMap = {}) => {
  const text = String(value || '').trim().toLocaleLowerCase('pt-BR');
  const firstWord = getFirstWord(text);
  if (!firstWord) return null;
  if (exceptionMap[firstWord]) return exceptionMap[firstWord];

  if (/(cao|gem|dade|ura|aria|eira|icao|ao)$/.test(firstWord)) return 'f';
  if (/(mento|ico|ico|oco|aco|iso|rro|rso|or|eiro|io|o)$/.test(firstWord)) return 'm';
  if (firstWord.endsWith('a')) return 'f';

  return null;
};

const SERVICE_GENDER_EXCEPTIONS = {
  alvenaria: 'f',
  armacao: 'f',
  cobertura: 'f',
  fachada: 'f',
  fiada: 'f',
  forma: 'f',
  impermeabilizacao: 'f',
  instalacao: 'f',
  laje: 'f',
  limpeza: 'f',
  pintura: 'f',
  parede: 'f',
  regularizacao: 'f',
  tubulacao: 'f',
  contrapiso: 'm',
  emboço: 'm',
  emboco: 'm',
  forro: 'm',
  gesso: 'm',
  piso: 'm',
  reboco: 'm',
  revestimento: 'm',
  servico: 'm'
};

const LOCATION_GENDER_EXCEPTIONS = {
  cobertura: 'f',
  fachada: 'f',
  garagem: 'f',
  periferia: 'f',
  torre: 'f',
  area: 'f',
  apto: 'm',
  apartamento: 'm',
  bloco: 'm',
  pavimento: 'm',
  subsolo: 'm',
  terreo: 'm'
};

const getServicePhrase = (service, complement = '') => {
  const cleanService = stripServicePrefix(service).toLocaleLowerCase('pt-BR');
  const gender = inferPortugueseGender(cleanService, SERVICE_GENDER_EXCEPTIONS);
  const suffix = complement ? ` ${complement}` : '';

  if (gender === 'f') return { direct: `a ${cleanService}${suffix}`, partitive: `da ${cleanService}${suffix}` };
  if (gender === 'm') return { direct: `o ${cleanService}${suffix}`, partitive: `do ${cleanService}${suffix}` };

  return { direct: `serviço de ${cleanService}${suffix}`, partitive: `do serviço de ${cleanService}${suffix}` };
};

const getLocationPhrase = (floor) => {
  const cleanFloor = String(floor || 'pavimento').trim();
  const normalizedFloor = cleanFloor
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/^\d/.test(normalizedFloor) || /\bpav(imento)?\b/.test(normalizedFloor)) return `no ${cleanFloor}`;

  const gender = inferPortugueseGender(cleanFloor, LOCATION_GENDER_EXCEPTIONS);

  if (gender === 'f') return `na ${cleanFloor}`;
  if (gender === 'm') return `no ${cleanFloor}`;
  return `em ${cleanFloor}`;
};

const getServiceTextSet = (task) => {
  const planned = Number(task?.plannedThisWeek ?? 100);
  const previous = Number(task?.executedBefore ?? 0);
  const service = String(task?.activityName || 'serviço').trim();
  const complement = task?.serviceComplement ? ` (${task.serviceComplement})` : '';
  const floor = String(task?.floor || 'pavimento').trim();
  const servicePhrase = getServicePhrase(service, complement);
  const locationPhrase = getLocationPhrase(floor);
  const directText = `${servicePhrase.direct} ${locationPhrase}`;
  const partitiveText = `${servicePhrase.partitive} ${locationPhrase}`;

  if (planned >= 100) {
    return {
      whatsapp: `Finalizar ${directText}`,
      done: previous <= 0 ? 'Serviço iniciado e finalizado!' : 'Serviço finalizado!',
      pending: previous <= 0 ? 'Serviço não iniciado' : 'Ainda faltou um pouco'
    };
  }

  if (planned >= 75) {
    if (previous <= 0) {
      return {
        whatsapp: `Iniciar e fazer mais da metade ${partitiveText}`,
        done: 'Serviço iniciado e em andamento!',
        pending: 'Serviço não iniciou'
      };
    }

    return {
      whatsapp: `Fazer mais da metade ${partitiveText}`,
      done: 'Mais da metade concluída',
      pending: 'Não avançou'
    };
  }

  if (planned >= 50) {
    return {
      whatsapp: previous <= 0 ? `Iniciar e fazer metade ${partitiveText}` : `Fazer metade ${partitiveText}`,
      done: 'Terminamos metade',
      pending: previous <= 0 ? 'Serviço não iniciou' : 'Não avançou'
    };
  }

  return {
    whatsapp: `Iniciar ${directText}`,
    done: 'Serviço iniciado!',
    pending: 'Serviço não iniciou'
  };
};

const getSimpleServiceInstruction = (task) => {
  return getServiceTextSet(task).whatsapp;
};

const getFieldProgressStatusText = (planned, progress) => {
  const target = Number(planned ?? 100);
  const done = Number(progress || 0) >= target;

  if (target >= 100) return done ? 'Serviço finalizado' : 'Serviço com pequenas pendências';
  if (target >= 50) return done ? 'Serviço em andamento!' : 'Serviço não continuou.';
  return done ? 'Serviço iniciado!' : 'Serviço não iniciado';
};

const getFieldProgressOptions = (task) => {
  const { done, pending } = getServiceTextSet(task);
  return { done, pending };
};

const TEAM_GENERAL_OBSERVATIONS_ID = '__team_general_observations__';

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
    if (task.isManual) {
      return task;
    }
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

  // Build lookup maps for cronogramaInicial to do O(1) lookups instead of O(N) .find on 5300+ items inside nested loops
  const cronoById: Record<string, any> = {};
  const cronoByKey: Record<string, any> = {};
  
  if (Array.isArray(cronogramaInicial)) {
    cronogramaInicial.forEach(c => {
      if (!c) return;
      if (c.id) {
        cronoById[c.id] = c;
      }
      const fallbackKey = `${c.floor}||${slugify(c.macro)}||${String(c.service || '').toUpperCase()}`;
      cronoByKey[fallbackKey] = c;
    });
  }

  // Garantir que andamento atual seja o maior entre cronograma e realizado
  Object.keys(updatedFloorsData).forEach(floor => {
    if (updatedFloorsData[floor]) {
      Object.keys(updatedFloorsData[floor]).forEach(sectionId => {
        const section = updatedFloorsData[floor][sectionId];
        if (section && Array.isArray(section.items)) {
          section.items.forEach(item => {
            if (!item) return;
            // Use O(1) lookup
            const cronoItem = (item.id && cronoById[item.id]) || cronoByKey[`${floor}||${sectionId}||${String(item.name || '').toUpperCase()}`];
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
  
  // Build a set of existing keys in finalCrono for O(1) checks
  const existingCronoKeys = new Set();
  finalCrono.forEach(c => {
    if (c) {
      const key = `${c.floor}||${slugify(c.macro)}||${String(c.service || '').toUpperCase()}`;
      existingCronoKeys.add(key);
    }
  });
  
  (floorsList || []).forEach(floor => {
    const floorData = floorsData[floor] || {};
    Object.keys(floorData).forEach(macroKey => {
      const section = floorData[macroKey];
      if (!section) return;
      const macroTitle = section.title || macroKey.toUpperCase();
      const items = section.items || [];
      
      items.forEach(item => {
        if (!item) return;
        const key = `${floor}||${macroKey}||${String(item.name || '').toUpperCase()}`;
        if (!existingCronoKeys.has(key)) {
          const todayStr = toLocalDateString(new Date());
          const fiveDaysLaterStr = toLocalDateString(addDays(new Date(), 5));
          const newCronoItem = {
            id: item.id || `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            macro: macroTitle,
            floor: floor,
            service: item.name,
            duration: 5,
            start: todayStr,
            end: fiveDaysLaterStr,
            cost: 0,
            responsible: 'EQUIPE GERAL',
            progress: item.actualPercent || 0,
            predecessors: item.predecessors || [],
            successors: item.successors || [],
            inheritedDependenciesFrom: item.inheritedDependenciesFrom || '',
            originalId: item.originalId || '',
            replicationGroup: item.replicationGroup || ''
          };
          finalCrono.push(newCronoItem);
          existingCronoKeys.add(key); // prevent future duplicates in the loop
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
  let bgClass = 'bg-red-600';
  if (type === 'success') {
    bgClass = 'bg-emerald-600';
  } else if (type === 'warning') {
    bgClass = 'bg-amber-500';
  } else if (type === 'info') {
    bgClass = 'bg-blue-600';
  }
  return (
    <div className={`fixed bottom-4 right-4 p-4 rounded-xl shadow-2xl text-white z-50 flex items-center gap-3 ${bgClass} animate-in slide-in-from-bottom-5 fade-in duration-300`}>
      <span className="font-bold text-xs">{message}</span>
      <button onClick={onClose} className="font-bold text-lg leading-none">&times;</button>
    </div>
  );
};

const playBeep = (freq = 600, duration = 0.15) => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.type = 'sine';
    oscillator.frequency.value = freq;
    gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime); // low volume
    gainNode.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + duration);
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + duration);
  } catch (e) {
    console.warn("Web Audio API not supported or blocked by user gesture:", e);
  }
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
const INITIAL_TEAMS = ['EQUIPE CIVIL', 'EQUIPE ARMADURA', 'EQUIPE HIDRÁULICA', 'EQUIPE ELÉTRICA', 'EQUIPE ACABAMENTO'];
const INITIAL_DELAYS = ['Chuva / Clima Impróprio', 'Falta de Material em Obra', 'Falta de Mão de Obra / Absenteísmo', 'Atraso de Projeto ou Detalhe', 'Quebra de Equipamento / Ferramenta', 'Serviço Anterior não Concluído'];

const App = () => {
  const [db, setDb] = useState<any>(null);
  const [userId, setUserId] = useState<any>(null);

  // Intercepção de modo de equipe (WhatsApp/Mobile)
  const queryParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const urlUserId = queryParams.get('u');
  const urlTeamName = queryParams.get('t');
  const urlWeek = queryParams.get('w');
  const isTeamMode = queryParams.get('mode') === 'team' && !!urlUserId && !!urlTeamName;

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



  const [plannerUsername, setPlannerUsername] = useState<string>(() => {
    try {
      return localStorage.getItem('planner_username') || '';
    } catch {
      return '';
    }
  });
  const [dbLastUpdatedBy, setDbLastUpdatedBy] = useState<string>('');

  // Estados Core
  const [floors, setFloors] = useState<any[]>([]);
  const [allFloorsData, setAllFloorsData] = useState<any>({});
  const [history, setHistory] = useState<any[]>([]);
  const [weights, setWeights] = useState<any>({});
  const [planning, setPlanning] = useState<any[]>([]);
  const [cronogramaInicial, setCronogramaInicial] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [delayReasons, setDelayReasons] = useState<any[]>([]);
  const [ppcHistory, setPpcHistory] = useState<any[]>([]);
  const [matrices, setMatrices] = useState<any[]>([]); 
  const [budgetDiffs, setBudgetDiffs] = useState<any[]>([]);
  const [budgetImportVersions, setBudgetImportVersions] = useState<any[]>([]);
  const [teamPhones, setTeamPhones] = useState<Record<string, string>>({});
  const [whatsappModal, setWhatsappModal] = useState<{ isOpen: boolean, teamName: string, text: string }>({ isOpen: false, teamName: '', text: '' });
  const [teamInputs, setTeamInputs] = useState<Record<string, { progress: number, delayReason: string, observations: string }>>({});
  const [teamGeneralDelayReason, setTeamGeneralDelayReason] = useState<string>('');
  const [teamGeneralObservations, setTeamGeneralObservations] = useState<string>('');
  const [teamSubmitSuccess, setTeamSubmitSuccess] = useState<boolean>(false);
  const [projectCity, setProjectCity] = useState<string>("Curitiba, PR");
  const [weatherApiKey, setWeatherApiKey] = useState<string>("");
  const [weatherCache, setWeatherCache] = useState<Record<string, { tempMax: number, tempMin: number, precip: number, conditions: string, icon: string }>>({});
  const [weatherLoading, setWeatherLoading] = useState<boolean>(false);

  const teamsRef = useRef(teams);
  const delayReasonsRef = useRef(delayReasons);
  const budgetDiffsRef = useRef(budgetDiffs);
  const budgetImportVersionsRef = useRef(budgetImportVersions);

  useEffect(() => {
    teamsRef.current = teams;
  }, [teams]);

  useEffect(() => {
    delayReasonsRef.current = delayReasons;
  }, [delayReasons]);

  useEffect(() => {
    budgetDiffsRef.current = budgetDiffs;
  }, [budgetDiffs]);

  useEffect(() => {
    budgetImportVersionsRef.current = budgetImportVersions;
  }, [budgetImportVersions]);

  // Estados UI Globais

  const [activeFloor, setActiveFloor] = useState<any>('');
  const [activeSection, setActiveSection] = useState<any>('estrutura');
  const initialWeekStart = useMemo(() => {
    if (urlWeek) {
      const parsed = new Date(urlWeek + 'T00:00:00');
      if (!Number.isNaN(parsed.getTime())) {
        return getWeekStartDate(parsed);
      }
    }
    return getWeekStartDate(new Date());
  }, [urlWeek]);
  const [currentWeekStart, setCurrentWeekStart] = useState<any>(initialWeekStart);
  const [visibleSections, setVisibleSections] = useState<any[]>([]);
  const [visibleFloors, setVisibleFloors] = useState<any[]>([]);

  // Filtros Histórico
  const [giantSearch, setHistorySearch] = useState<string>('');
  const [giantFloorFilter, setHistoryFloorFilter] = useState<string>('');
  const [giantMacroFilter, setHistoryMacroFilter] = useState<string>('');
  const [giantStatusFilter, setHistoryStatusFilter] = useState<string>('');
  const [giantSortKey, setGiantSortKey] = useState<string>('weekId');
  const [giantSortDir, setGiantSortDir] = useState<'asc'|'desc'>('desc');
  const [macroEvolutionSearch, setMacroEvolutionSearch] = useState<string>('');

  // Filtros Cronograma
  const [cronoSearch, setCronoSearch] = useState<string>('');
  const [cronoFloorFilter, setCronoFloorFilter] = useState<string>('');
  const [cronoMacroFilter, setCronoMacroFilter] = useState<string>('');
  const [cronoProgressFilter, setCronoProgressFilter] = useState<string>('');
  const [cronoSortKey, setCronoSortKey] = useState<string>('');
  const [cronoSortDir, setCronoSortDir] = useState<'asc'|'desc'>('asc');

  // Filtros Planejamento Semanal
  const [planningSearch, setPlanningSearch] = useState<string>('');
  const [planningTeamFilter, setPlanningTeamFilter] = useState<string>('');
  const [planningStatusFilter, setPlanningStatusFilter] = useState<string>('');
  const [planningSortKey, setPlanningSortKey] = useState<string>('');
  const [planningSortDir, setPlanningSortDir] = useState<'asc'|'desc'>('asc');

  // Estados para Atividades Extras (Manuais)
  const [isAddingManual, setIsAddingManual] = useState<boolean>(false);
  const [manualServiceName, setManualServiceName] = useState<string>('');
  const [manualFloor, setManualFloor] = useState<string>('');

  // Estados para Detalhamento PPC
  const [ppcSelectedContractor, setPpcSelectedContractor] = useState<string>('');
  const [ppcStartWeek, setPpcStartWeek] = useState<string>('');
  const [ppcEndWeek, setPpcEndWeek] = useState<string>('');

  // Estados para Múltiplos Projetos
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => {
    return localStorage.getItem('selected_project_id') || '';
  });
  const [projects, setProjects] = useState<any[]>([]);
  const [showAddProjectModal, setShowAddProjectModal] = useState<boolean>(false);
  const [newProjName, setNewProjName] = useState<string>('');
  const [newProjArea, setNewProjArea] = useState<string>('');
  const [newProjAddress, setNewProjAddress] = useState<string>('');
  const [newProjBadges, setNewProjBadges] = useState<string>('');
  const [newProjImageUrl, setNewProjImageUrl] = useState<string>('');
  const [projectSearchQuery, setProjectSearchQuery] = useState<string>('');

  // Estados para Edição de Projetos
  const [editingProject, setEditingProject] = useState<any | null>(null);
  const [editProjName, setEditProjName] = useState<string>('');
  const [editProjArea, setEditProjArea] = useState<string>('');
  const [editProjAddress, setEditProjAddress] = useState<string>('');
  const [editProjBadges, setEditProjBadges] = useState<string>('');
  const [editProjImageUrl, setEditProjImageUrl] = useState<string>('');

  // Controle de Acesso
  const [accessControl, setAccessControl] = useState<{ 
    users: string[]; 
    projectAccess: { [projectId: string]: string[] };
    logs: { username: string; timestamp: string }[];
  }>({ users: [], projectAccess: {}, logs: [] });
  const [showAccessModal, setShowAccessModal] = useState<boolean>(false);
  const [accessUser, setAccessUser] = useState<string>('');
  const [accessPassword, setAccessPassword] = useState<string>('');
  const [isAccessAdmin, setIsAccessAdmin] = useState<boolean>(false);
  const [newAccessUser, setNewAccessUser] = useState<string>('');
  const hasLoggedSession = useRef<boolean>(false);

  // Dashboard Interatividade
  const [dashboardTargetMonth, setDashboardTargetMonth] = useState<string>(getTodayDateString().slice(0, 7));
  const [selectedDashboardFloor, setSelectedDashboardFloor] = useState<any>('');
  const [dashboardShowOnlyScheduled, setDashboardShowOnlyScheduled] = useState<boolean>(true);
  const [selectedDashboardMacros, setSelectedDashboardMacros] = useState<string[]>([]);
  const [lastUpdatedTime, setLastUpdatedTime] = useState<string>('');
  const [activeTower, setActiveTower] = useState<string>('Bloom');

  // Estados para drag-and-drop na matriz geral
  const [draggedColIdx, setDraggedColIdx] = useState<number | null>(null);
  const [draggedColMatrixId, setDraggedColMatrixId] = useState<string | null>(null);
  const [draggedRowIdx, setDraggedRowIdx] = useState<number | null>(null);
  const [draggedRowMatrixId, setDraggedRowMatrixId] = useState<string | null>(null);

  // Análise IA
  const [aiAnalysis, setAiAnalysis] = useState<string>('');
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiAnalyzedWeekId, setAiAnalyzedWeekId] = useState<string>('');
  const [aiAnalysesHistory, setAiAnalysesHistory] = useState<Record<string, string>>({});

  useEffect(() => {
    setSelectedDashboardMacros([]);
  }, [selectedDashboardFloor]);


  // Drawer Menu
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [drawerSourceMode, setDrawerSourceMode] = useState<'cronograma'|'previous-successors'|'unfinished'>('cronograma');
  const [drawerExpandedStep, setDrawerExpandedStep] = useState<number>(1);
  const [drawerMacro, setDrawerMacro] = useState<any>('');
  const [drawerMacroSearch, setDrawerMacroSearch] = useState<string>('');
  const [isDrawerMacroDropdownOpen, setIsDrawerMacroDropdownOpen] = useState<boolean>(false);
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
  const [listeningComplementTaskId, setListeningComplementTaskId] = useState<any>(null);
  const [editingComplementTaskId, setEditingComplementTaskId] = useState<string | null>(null);
  const [editingObservationsTaskId, setEditingObservationsTaskId] = useState<string | null>(null);
  const [micConnectingTaskId, setMicConnectingTaskId] = useState<string | null>(null);
  const [micConnectingComplementTaskId, setMicConnectingComplementTaskId] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedTaskIds([]);
  }, [currentWeekStart]);

  const [dbSavingStatus, setDbSavingStatus] = useState<'saved' | 'saving' | 'pending'>('saved');
  const saveTimeoutRef = useRef<any>(null);
  const pendingSaveArgsRef = useRef<any>(null);

  // Dialogs/Modals
  const [confirmModal, setConfirmModal] = useState<any>({ isOpen: false, title: '', message: '', onConfirm: null });
  const [finalizeModal, setFinalizeModal] = useState<any>({ isOpen: false, carryOverUnfinished: true });
  const [matrixSelection, setMatrixSelection] = useState({ isOpen: false, matrixId: '', type: 'macro' });
  const [matrixGroupModalOpen, setMatrixGroupModalOpen] = useState<boolean>(false);
  const [matrixTooltip, setMatrixTooltip] = useState<{
    text: string;
    x: number;
    y: number;
    visible: boolean;
  }>({ text: '', x: 0, y: 0, visible: false });

  const showMatrixTooltip = (e: React.MouseEvent, text: string) => {
    if (!text) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setMatrixTooltip({
      text,
      x: rect.left + rect.width / 2,
      y: rect.top,
      visible: true
    });
  };

  const hideMatrixTooltip = () => {
    setMatrixTooltip(prev => ({ ...prev, visible: false }));
  };

  // Inicializa inputs de apontamento de campo (WhatsApp/Mobile)
  useEffect(() => {
    if (!isTeamMode) return;
    const weekId = toLocalDateString(currentWeekStart);
    const initialInputs: typeof teamInputs = {};
    let initialGeneralDelayReason = '';
    let initialGeneralObservations = '';
    planning.forEach(t => {
      if (t.weekId === weekId && t.responsible === urlTeamName) {
        initialInputs[t.id] = {
          progress: t.preFilledProgress !== undefined ? t.preFilledProgress : (t.progressThisWeek ?? 0),
          delayReason: t.preFilledDelayReason || t.delayReason || '',
          observations: t.preFilledObservations || t.observations || ''
        };
        if (!initialGeneralDelayReason) initialGeneralDelayReason = t.preFilledDelayReason || t.delayReason || '';
        if (!initialGeneralObservations) initialGeneralObservations = t.preFilledObservations || t.observations || '';
      }
    });
    setTeamInputs(initialInputs);
    setTeamGeneralDelayReason(initialGeneralDelayReason);
    setTeamGeneralObservations(initialGeneralObservations);
  }, [currentWeekStart, planning, isTeamMode, urlTeamName]);

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

  // Aviso de alterações pendentes ao fechar o navegador
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dbSavingStatus !== 'saved') {
        e.preventDefault();
        e.returnValue = 'Existem alterações pendentes que estão sendo salvas no banco de dados. Tem certeza de que deseja sair?';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dbSavingStatus]);

  // Carrega a lista de projetos do Firestore
  useEffect(() => {
    if (!db || !userId) return;
    const projectsDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'all_projects_metadata');
    const unsubscribe = onSnapshot(projectsDocRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const rawList = data.list || [];
        
        // Mapeia qualquer projeto antigo com ID 'qoya' para 'projeto_principal'
        let hasOldQoya = false;
        const mappedList = rawList.map((p: any) => {
          if (p.id === 'qoya') {
            hasOldQoya = true;
            return { ...p, id: 'projeto_principal' };
          }
          return p;
        });

        if (hasOldQoya) {
          setDoc(projectsDocRef, { list: mappedList });
        }
        
        setProjects(mappedList);
      } else {
        const defaultList = [
          {
            id: 'pace',
            name: 'PACE',
            type: 'Obra',
            area: '24170.23',
            badges: ['WB', 'PE', 'PK', 'PE', 'RT', 'AO', 'GP', 'AS', 'LF'],
            address: 'Rua Monsenhor Ivo Zanlorenzi, 1230 - Mossunguê, Curitiba - PR',
            imageUrl: 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=600&auto=format&fit=crop&q=60'
          },
          {
            id: 'glb_partilha',
            name: 'GLB PARTILHA',
            type: 'Obra',
            area: '10984.93',
            badges: ['WB', 'EL', 'LR', 'PE', 'PK', 'PE', 'RT', 'RF', 'MB', 'GP', 'AS', 'dcfi', 'LF'],
            address: 'Rua Bispo Dom José, 2423 - Batel, Curitiba - PR',
            imageUrl: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=600&auto=format&fit=crop&q=60'
          },
          {
            id: 'icaro_casa_terrea',
            name: 'ÍCARO CASA TÉRREA',
            type: 'Obra',
            area: '53681.76',
            badges: ['WB', 'PE', 'PK', 'RT', 'PF', 'AO', 'MB', 'GP', 'AS', 'KF', 'LR', 'OB', 'AH', 'AS', 'dcfi', 'LF'],
            address: 'Rua Catarina Margarida Luvizoto Gobbo, 120 - Curitiba - PR',
            imageUrl: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?w=600&auto=format&fit=crop&q=60'
          },
          {
            id: 'projeto_principal',
            name: 'QOYA',
            type: 'Obra',
            area: '16777.23',
            badges: ['PF', 'PE', 'PK', 'RT', 'PF', 'AO', 'MB', 'JM', 'GP', 'AS', 'dcfi', 'LF'],
            address: 'R. Buenos Aires, 572 - Água Verde, Curitiba - PR',
            imageUrl: 'https://images.unsplash.com/photo-1582407947304-fd86f028f716?w=600&auto=format&fit=crop&q=60'
          },
          {
            id: 'alberi',
            name: 'ALBERI',
            type: 'Obra',
            area: '24801.92',
            badges: ['AV', 'CS', 'PE', 'PK', 'WH', 'PE', 'Jd', 'MB', 'GP', 'dcfi', 'LF'],
            address: 'R. Bom Jesus, 969 - Juvevê, Curitiba - PR',
            imageUrl: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=600&auto=format&fit=crop&q=60'
          }
        ];
        setDoc(projectsDocRef, { list: defaultList });
        setProjects(defaultList);
      }
    });
    return () => unsubscribe();
  }, [db, userId]);

  // Carrega as configurações de acesso do Firestore
  useEffect(() => {
    if (!db || !userId) return;
    const accessDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'access_control');
    const unsubscribe = onSnapshot(accessDocRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setAccessControl({
          users: data.users || [],
          projectAccess: data.projectAccess || {},
          logs: data.logs || []
        });
      } else {
        setAccessControl({ users: [], projectAccess: {}, logs: [] });
      }
    }, (err) => {
      console.error("Error loading access control:", err);
    });
    return () => unsubscribe();
  }, [db, userId]);

  const handleSaveAccessControl = async (updatedData: { 
    users: string[]; 
    projectAccess: { [projectId: string]: string[] };
    logs: { username: string; timestamp: string }[];
  }) => {
    try {
      const accessDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'access_control');
      await setDoc(accessDocRef, updatedData);
      setNotification({ message: 'Controle de acesso atualizado!', type: 'success' });
    } catch (err) {
      console.error('Error saving access control:', err);
      setNotification({ message: 'Erro ao salvar controle de acesso.', type: 'error' });
    }
  };

  const handleAddUser = () => {
    const user = newAccessUser.trim();
    if (!user) return;
    if (accessControl.users.map(u => u.toLowerCase()).includes(user.toLowerCase())) {
      setNotification({ message: 'Usuário já cadastrado.', type: 'error' });
      return;
    }
    
    // Associa o novo usuário a todas as obras existentes por padrão
    const updatedProjectAccess = { ...accessControl.projectAccess };
    projects.forEach(p => {
      const allowed = updatedProjectAccess[p.id] || [];
      if (!allowed.map(u => u.toLowerCase()).includes(user.toLowerCase())) {
        updatedProjectAccess[p.id] = [...allowed, user];
      }
    });

    const updated = {
      users: [...accessControl.users, user],
      projectAccess: updatedProjectAccess,
      logs: accessControl.logs || []
    };
    setAccessControl(updated);
    handleSaveAccessControl(updated);
    setNewAccessUser('');
  };

  const handleRemoveUser = (user: string) => {
    const updatedUsers = accessControl.users.filter(u => u !== user);
    const updatedProjectAccess = { ...accessControl.projectAccess };
    Object.keys(updatedProjectAccess).forEach(projId => {
      updatedProjectAccess[projId] = (updatedProjectAccess[projId] || []).filter(u => u !== user);
    });

    const updated = {
      users: updatedUsers,
      projectAccess: updatedProjectAccess,
      logs: accessControl.logs || []
    };
    setAccessControl(updated);
    handleSaveAccessControl(updated);
  };

  const handleToggleProjectAccess = (projId: string, user: string) => {
    const currentAllowed = accessControl.projectAccess[projId] || [];
    let updatedAllowed: string[];
    if (currentAllowed.includes(user)) {
      updatedAllowed = currentAllowed.filter(u => u !== user);
    } else {
      updatedAllowed = [...currentAllowed, user];
    }

    const updated = {
      ...accessControl,
      projectAccess: {
        ...accessControl.projectAccess,
        [projId]: updatedAllowed
      }
    };
    setAccessControl(updated);
    handleSaveAccessControl(updated);
  };

  const handleOperatorLogin = async (username: string) => {
    const trimmed = username.trim();
    if (!trimmed) return;
    
    localStorage.setItem('planner_username', trimmed);
    setPlannerUsername(trimmed);
    hasLoggedSession.current = true; // Evita registrar login duplo no useEffect

    // Se o usuário for admin, não cadastramos ele, mas registramos o log
    const isUserAdmin = trimmed.toLowerCase() === 'admin';
    const isAlreadyRegistered = accessControl.users.map(u => u.toLowerCase()).includes(trimmed.toLowerCase());

    let updatedUsers = [...accessControl.users];
    let updatedProjectAccess = { ...accessControl.projectAccess };

    // Se for operador comum e não registrado, cadastra e associa a todas as obras
    if (!isUserAdmin && !isAlreadyRegistered) {
      updatedUsers.push(trimmed);
      projects.forEach(p => {
        const allowed = updatedProjectAccess[p.id] || [];
        if (!allowed.map(u => u.toLowerCase()).includes(trimmed.toLowerCase())) {
          updatedProjectAccess[p.id] = [...allowed, trimmed];
        }
      });
    }

    // Adiciona log de acesso
    const newLog = {
      username: trimmed,
      timestamp: new Date().toISOString()
    };
    const updatedLogs = [newLog, ...(accessControl.logs || [])].slice(0, 100);

    const updated = {
      users: updatedUsers,
      projectAccess: updatedProjectAccess,
      logs: updatedLogs
    };

    setAccessControl(updated);
    
    if (db && userId) {
      try {
        const accessDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'access_control');
        await setDoc(accessDocRef, updated);
      } catch (err) {
        console.error('Error saving access control on login:', err);
      }
    }
  };

  // Efeito para registrar o acesso de login automático persistido no localStorage
  useEffect(() => {
    if (!db || !userId || !plannerUsername || projects.length === 0 || accessControl.users.length === 0) return;
    if (hasLoggedSession.current) return;
    
    hasLoggedSession.current = true;
    const trimmed = plannerUsername.trim();
    
    // Se o usuário for admin, não cadastramos ele na lista, mas registramos o log
    const isUserAdmin = trimmed.toLowerCase() === 'admin';
    const isAlreadyRegistered = accessControl.users.map(u => u.toLowerCase()).includes(trimmed.toLowerCase());

    let updatedUsers = [...accessControl.users];
    let updatedProjectAccess = { ...accessControl.projectAccess };

    // Se for operador comum e não registrado, cadastra e associa a todas as obras
    if (!isUserAdmin && !isAlreadyRegistered) {
      updatedUsers.push(trimmed);
      projects.forEach(p => {
        const allowed = updatedProjectAccess[p.id] || [];
        if (!allowed.map(u => u.toLowerCase()).includes(trimmed.toLowerCase())) {
          updatedProjectAccess[p.id] = [...allowed, trimmed];
        }
      });
    }

    // Adiciona log de acesso
    const newLog = {
      username: trimmed,
      timestamp: new Date().toISOString()
    };
    const updatedLogs = [newLog, ...(accessControl.logs || [])].slice(0, 100);

    const updated = {
      users: updatedUsers,
      projectAccess: updatedProjectAccess,
      logs: updatedLogs
    };

    setAccessControl(updated);
    
    const accessDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'access_control');
    setDoc(accessDocRef, updated).catch(err => {
      console.error('Error saving automatic access log:', err);
    });
  }, [db, userId, plannerUsername, projects, accessControl.users]);

  useEffect(() => {
    if (!db || !userId) return;
    const targetId = urlUserId ? urlUserId : selectedProjectId;
    if (!targetId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const docRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, targetId);
    const cronoRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, `${targetId}_crono`);
    const floorsRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, `${targetId}_floors`);
    const planningRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, `${targetId}_planning`);

    let hasLoadedCrono = false;
    let hasLoadedFloors = false;
    let hasLoadedPlanning = false;

    const unsubMeta = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        const loadedFloors = Array.isArray(d.floors) ? d.floors : [];
        setFloors(loadedFloors);
        if (loadedFloors.length > 0) {
          if (!activeFloor || !loadedFloors.includes(activeFloor)) setActiveFloor(loadedFloors[0]);
          if (!selectedDashboardFloor || !loadedFloors.includes(selectedDashboardFloor)) setSelectedDashboardFloor(loadedFloors[0]);
        } else {
          setActiveFloor('');
          setSelectedDashboardFloor('');
        }
        setLastUpdatedTime(formatTimestamp(d.lastUpdated));
        setDbLastUpdatedBy(d.lastUpdatedBy || '');

        let loadedHistory = d.history || [];
        if (typeof loadedHistory === 'string') {
          try { loadedHistory = JSON.parse(decompressIfNeeded(loadedHistory)); } catch { loadedHistory = []; }
        }
        setHistory(loadedHistory);

        let loadedWeights = d.weights || {};
        if (typeof loadedWeights === 'string') {
          try { loadedWeights = JSON.parse(decompressIfNeeded(loadedWeights)); } catch { loadedWeights = {}; }
        }
        setWeights(loadedWeights);

        setTeams(d.teams || []);
        setTeamPhones(d.teamPhones || {});
        setDelayReasons(d.delayReasons || []);
        setProjectCity(d.projectCity || "Curitiba, PR");
        setWeatherApiKey(d.weatherApiKey || "");
        setWeatherCache(d.weatherCache || {});

        let loadedBudgetDiffs = d.budgetDiffs || [];
        if (typeof loadedBudgetDiffs === 'string') {
          try { loadedBudgetDiffs = JSON.parse(decompressIfNeeded(loadedBudgetDiffs)); } catch { loadedBudgetDiffs = []; }
        }
        setBudgetDiffs(Array.isArray(loadedBudgetDiffs) ? loadedBudgetDiffs : []);

        let loadedBudgetImportVersions = d.budgetImportVersions || [];
        if (typeof loadedBudgetImportVersions === 'string') {
          try { loadedBudgetImportVersions = JSON.parse(decompressIfNeeded(loadedBudgetImportVersions)); } catch { loadedBudgetImportVersions = []; }
        }
        setBudgetImportVersions(Array.isArray(loadedBudgetImportVersions) ? loadedBudgetImportVersions : []);

        let loadedPpcHistory = d.ppcHistory || [];
        if (typeof loadedPpcHistory === 'string') {
          try { loadedPpcHistory = JSON.parse(decompressIfNeeded(loadedPpcHistory)); } catch { loadedPpcHistory = []; }
        }
        setPpcHistory(loadedPpcHistory);

        let loadedMatrices: any[] = d.matrices || [];
        if (typeof loadedMatrices === 'string') {
          try { loadedMatrices = JSON.parse(decompressIfNeeded(loadedMatrices as any)); } catch { loadedMatrices = []; }
        }
        setMatrices(loadedMatrices);

        let loadedAiAnalyses = d.aiAnalyses || {};
        if (typeof loadedAiAnalyses === 'string') {
          try {
            if (loadedAiAnalyses.startsWith('unicode:')) {
              loadedAiAnalyses = JSON.parse(decompressStringUnicode(loadedAiAnalyses));
            } else {
              loadedAiAnalyses = JSON.parse(decompressIfNeeded(loadedAiAnalyses));
            }
          } catch {
            loadedAiAnalyses = {};
          }
        }
        setAiAnalysesHistory(loadedAiAnalyses);

        // Fallbacks for backward compatibility
        if (!hasLoadedCrono && d.cronogramaInicial) {
          let loadedCrono = d.cronogramaInicial;
          if (typeof loadedCrono === 'string') {
            try {
              loadedCrono = JSON.parse(decompressIfNeeded(loadedCrono));
            } catch (jsonErr) {
              console.error("Error parsing fallback cronogramaInicial JSON:", jsonErr);
              loadedCrono = [];
            }
          }
          setCronogramaInicial(deserializeCrono(loadedCrono));
        }

        if (!hasLoadedFloors && d.data) {
          let loadedData = d.data;
          if (typeof loadedData === 'string') {
            try {
              loadedData = JSON.parse(decompressIfNeeded(loadedData));
            } catch (jsonErr) {
              console.error("Error parsing fallback floors data JSON:", jsonErr);
              loadedData = {};
            }
          }
          const finalData = loadedData && Object.keys(loadedData).length > 0 ? loadedData : {};
          setAllFloorsData(finalData);
          if (loadedFloors.length > 0 && (!loadedMatrices || loadedMatrices.length === 0)) {
            setMatrices([{ id: 'default_matrix', name: 'Matriz Principal', floors: loadedFloors, macros: Object.keys(finalData?.[loadedFloors[0]] || {}) }]);
          }
        }

        if (!hasLoadedPlanning && d.planning) {
          let loadedPlanning = d.planning;
          if (typeof loadedPlanning === 'string') {
            try {
              loadedPlanning = JSON.parse(decompressIfNeeded(loadedPlanning));
            } catch (jsonErr) {
              console.error("Error parsing fallback planning JSON:", jsonErr);
              loadedPlanning = [];
            }
          }
          setPlanning(loadedPlanning);
        }
      } else {
        saveToDB([], {}, [], {}, [], [], [], [], [], [], {}, targetId);
        setActiveFloor('');
        setSelectedDashboardFloor('');
      }
      setLoading(false);
    }, (err) => {
      console.error("Firestore error:", err);
      setLoading(false);
    });

    const unsubCrono = onSnapshot(cronoRef, (snap) => {
      if (snap.exists()) {
        hasLoadedCrono = true;
        const d = snap.data();
        let loadedCrono = d.cronogramaInicial || [];
        if (typeof loadedCrono === 'string') {
          try {
            loadedCrono = JSON.parse(decompressIfNeeded(loadedCrono));
          } catch (jsonErr) {
            console.error("Error parsing cronogramaInicial JSON:", jsonErr);
            loadedCrono = [];
          }
        }
        setCronogramaInicial(deserializeCrono(loadedCrono));
      }
    });

    const unsubFloors = onSnapshot(floorsRef, (snap) => {
      if (snap.exists()) {
        hasLoadedFloors = true;
        const d = snap.data();
        let loadedData = d.data || {};
        if (typeof loadedData === 'string') {
          try {
            loadedData = JSON.parse(decompressIfNeeded(loadedData));
          } catch (jsonErr) {
            console.error("Error parsing floors data JSON:", jsonErr);
            loadedData = {};
          }
        }
        setAllFloorsData(loadedData && Object.keys(loadedData).length > 0 ? loadedData : {});
      }
    });

    const unsubPlanning = onSnapshot(planningRef, (snap) => {
      if (snap.exists()) {
        hasLoadedPlanning = true;
        const d = snap.data();
        let loadedPlanning = d.planning || [];
        if (typeof loadedPlanning === 'string') {
          try {
            loadedPlanning = JSON.parse(decompressIfNeeded(loadedPlanning));
          } catch (jsonErr) {
            console.error("Error parsing planning JSON:", jsonErr);
            loadedPlanning = [];
          }
        }
        setPlanning(loadedPlanning);
      }
    });

    return () => {
      unsubMeta();
      unsubCrono();
      unsubFloors();
      unsubPlanning();
    };
  }, [db, userId, isTeamMode, urlUserId, selectedProjectId]);

  useEffect(() => {
    const loadWeather = async () => {
      if (isTeamMode) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const startDate = addDays(today, -15);
      const endDate = addDays(today, 15);

      const missingDates = [];
      const newCache = { ...weatherCache };
      let changed = false;

      for (let i = -15; i <= 15; i++) {
        const dayDate = addDays(today, i);
        const dayStr = toISODate(dayDate);
        const cacheKey = `${projectCity.trim().toLowerCase()}_${dayStr}`;
        if (!weatherCache[cacheKey]) {
          missingDates.push(dayStr);
        }
      }

      if (missingDates.length === 0) return;

      if (!weatherApiKey) {
        for (let i = -15; i <= 15; i++) {
          const dayDate = addDays(today, i);
          const dayStr = toISODate(dayDate);
          const cacheKey = `${projectCity.trim().toLowerCase()}_${dayStr}`;
          if (!newCache[cacheKey]) {
            newCache[cacheKey] = generateMockWeather(projectCity, dayStr);
            changed = true;
          }
        }
        if (changed) {
          setWeatherCache(newCache);
          saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices, teamPhones, urlUserId, projectCity, weatherApiKey, newCache);
        }
        return;
      }

      setWeatherLoading(true);
      try {
        const startStr = toISODate(startDate);
        const endStr = toISODate(endDate);
        const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(projectCity)}/${startStr}/${endStr}?unitGroup=metric&key=${weatherApiKey}&contentType=json&lang=pt`;
        
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`API response status: ${res.status}`);
        }
        const data = await res.json();
        
        if (data && data.days) {
          data.days.forEach((dayData) => {
            const dayStr = dayData.datetime;
            const cacheKey = `${projectCity.trim().toLowerCase()}_${dayStr}`;
            newCache[cacheKey] = {
              tempMax: Math.round(dayData.tempmax),
              tempMin: Math.round(dayData.tempmin),
              precip: dayData.precip || 0,
              conditions: dayData.conditions || '',
              icon: dayData.icon || 'clear-day'
            };
            changed = true;
          });
        }
        
        if (changed) {
          setWeatherCache(newCache);
          saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices, teamPhones, urlUserId, projectCity, weatherApiKey, newCache);
        }
      } catch (err) {
        console.error("Error fetching weather:", err);
        setNotification({ message: "Erro ao consultar clima na API. Usando dados locais.", type: "error" });
        for (let i = -15; i <= 15; i++) {
          const dayDate = addDays(today, i);
          const dayStr = toISODate(dayDate);
          const cacheKey = `${projectCity.trim().toLowerCase()}_${dayStr}`;
          if (!newCache[cacheKey]) {
            newCache[cacheKey] = generateMockWeather(projectCity, dayStr);
            changed = true;
          }
        }
        if (changed) {
          setWeatherCache(newCache);
        }
      } finally {
        setWeatherLoading(false);
      }
    };

    loadWeather();
  }, [projectCity, weatherApiKey, isTeamMode]);



  const performActualSave = async (args: any) => {
    const {
      fls,
      data,
      hist,
      wts,
      plans,
      crono,
      tms,
      delays,
      ppcHist,
      mats,
      tPhones,
      targetUserId,
      pCity,
      wApiKey,
      wCache,
      bDiffs,
      bImportVersions
    } = args;

    const resolvedTargetId = targetUserId || urlUserId || selectedProjectId || 'projeto_principal';
    if (!db || !resolvedTargetId) return;

    setDbSavingStatus('saving');

    const docRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, resolvedTargetId);
    const cronoRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, `${resolvedTargetId}_crono`);
    const floorsRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, `${resolvedTargetId}_floors`);
    const planningRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, `${resolvedTargetId}_planning`);

    const trimmedHistory = (hist || []).slice(-100);
    const syncedCrono = syncCronogramaWithFloorsData(crono, fls, data);
    const serializedCrono = serializeCrono(syncedCrono);

    try {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data || {});
      const planningStr = typeof plans === 'string' ? plans : JSON.stringify(plans || []);
      const cronoStr = JSON.stringify(Array.isArray(serializedCrono) ? serializedCrono.slice(0, 6000) : []);
      const weightsStr = typeof wts === 'string' ? wts : JSON.stringify(wts || {});
      const historyStr = JSON.stringify(trimmedHistory);
      const matricesStr = typeof mats === 'string' ? mats : JSON.stringify(Array.isArray(mats) ? mats : []);
      const budgetDiffsStr = typeof bDiffs === 'string' ? bDiffs : JSON.stringify(Array.isArray(bDiffs) ? bDiffs.slice(-1200) : []);
      const budgetImportVersionsStr = typeof bImportVersions === 'string' ? bImportVersions : JSON.stringify(Array.isArray(bImportVersions) ? bImportVersions.slice(-2) : []);

      await Promise.all([
        setDoc(docRef, {
          floors: Array.isArray(fls) ? fls : [],
          history: compressStringUnicode(historyStr),
          weights: compressStringUnicode(weightsStr),
          teams: Array.isArray(tms) ? tms : INITIAL_TEAMS,
          teamPhones: tPhones || {},
          delayReasons: Array.isArray(delays) ? delays : INITIAL_DELAYS,
          ppcHistory: compressStringUnicode(JSON.stringify(Array.isArray(ppcHist) ? ppcHist.slice(-200) : [])),
          matrices: compressStringUnicode(matricesStr),
          projectCity: pCity || "Curitiba, PR",
          weatherApiKey: wApiKey || "",
          weatherCache: wCache || {},
          budgetDiffs: compressStringUnicode(budgetDiffsStr),
          budgetImportVersions: compressStringUnicode(budgetImportVersionsStr),
          lastUpdatedBy: isTeamMode ? (urlTeamName ? `Equipe: ${urlTeamName}` : 'Equipe de Campo') : (plannerUsername || 'Sistema'),
          lastUpdated: new Date()
        }),
        setDoc(cronoRef, {
          cronogramaInicial: compressStringUnicode(cronoStr)
        }),
        setDoc(floorsRef, {
          data: compressStringUnicode(dataStr)
        }),
        setDoc(planningRef, {
          planning: compressStringUnicode(planningStr)
        })
      ]);

      setDbSavingStatus('saved');
    } catch (e: any) {
      console.error("Save error:", e);
      setDbSavingStatus('saved');
      if (e?.message && e.message.includes('exceeds the maximum allowed size')) {
        setNotification({ message: 'Limite de armazenamento excedido. Tente Limpar o BD e reimportar.', type: 'error' });
      }
      throw e;
    }
  };

  const saveToDB = async (
    fls = floors,
    data = allFloorsData,
    hist = history,
    wts = weights,
    plans = planning,
    crono = cronogramaInicial,
    tms = teams,
    delays = delayReasons,
    ppcHist = ppcHistory,
    mats = matrices,
    tPhones = teamPhones,
    targetUserId = (urlUserId ? urlUserId : (selectedProjectId ? selectedProjectId : 'projeto_principal')),
    pCity = projectCity,
    wApiKey = weatherApiKey,
    wCache = weatherCache,
    forceImmediate = false,
    bDiffs = budgetDiffsRef.current,
    bImportVersions = budgetImportVersionsRef.current
  ) => {
    const resolvedTargetId = targetUserId || urlUserId || selectedProjectId || 'projeto_principal';
    if (!db || !resolvedTargetId) return;

    const args = {
      fls,
      data,
      hist,
      wts,
      plans,
      crono,
      tms,
      delays,
      ppcHist,
      mats,
      tPhones,
      targetUserId: resolvedTargetId,
      pCity,
      wApiKey,
      wCache,
      bDiffs,
      bImportVersions
    };

    if (forceImmediate) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      pendingSaveArgsRef.current = null;
      await performActualSave(args);
    } else {
      pendingSaveArgsRef.current = args;
      setDbSavingStatus('pending');
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(async () => {
        const pendingArgs = pendingSaveArgsRef.current;
        if (pendingArgs) {
          pendingSaveArgsRef.current = null;
          saveTimeoutRef.current = null;
          await performActualSave(pendingArgs);
        }
      }, 1500); // 1.5s debounce
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

  const replicationGroups = useMemo(() => (
    Array.from(new Set(
      (cronogramaInicial || [])
        .map(item => String(item?.replicationGroup || '').trim())
        .filter(Boolean)
    )).sort()
  ), [cronogramaInicial]);

  const previousWeekIdForDrawer = toLocalDateString(addDays(currentWeekStart, -7));
  const drawerCandidateActivities = useMemo(() => {
    const isParentCronoItem = (item) => {
      if (!item) return false;
      if (item.isParent !== undefined) return !!item.isParent;
      return slugify(item.service || '') === slugify(item.macro || '');
    };
    const familyKey = (item) => `${item?.floor || ''}||${slugify(item?.macro || '')}`;
    const familiesWithChildren = new Set(
      (cronogramaInicial || [])
        .filter(item => item && !isParentCronoItem(item))
        .map(item => familyKey(item))
    );
    const openCronoItems = cronogramaInicial.filter(item => (
      item &&
      (item.progress ?? 0) < 100 &&
      (!isParentCronoItem(item) || !familiesWithChildren.has(familyKey(item)))
    ));
    if (drawerSourceMode === 'unfinished') {
      return openCronoItems.filter(item => (item.progress ?? 0) > 0 && (item.progress ?? 0) < 100);
    }
    if (drawerSourceMode !== 'previous-successors') return openCronoItems;

    const successorIds = new Set<string>();
    planning
      .filter(task => task && task.weekId === previousWeekIdForDrawer && task.finalized)
      .forEach(task => {
        const cronoItem = cronogramaInicial.find(item => item.id === task.itemId);
        const successors = task.successors || cronoItem?.successors || [];
        successors.forEach(id => {
          const value = String(id || '').trim();
          if (value) successorIds.add(value);
        });
      });

    if (successorIds.size === 0) return [];
    const directSuccessors = openCronoItems.filter(item => {
      const candidates = [item.id, item.originalId].filter(Boolean).map(String);
      return candidates.some(id => successorIds.has(id));
    });
    const successorMacroKeys = new Set(directSuccessors.map(item => `${item.floor}||${slugify(item.macro)}`));
    return openCronoItems.filter(item => {
      const candidates = [item.id, item.originalId].filter(Boolean).map(String);
      return candidates.some(id => successorIds.has(id)) || successorMacroKeys.has(`${item.floor}||${slugify(item.macro)}`);
    });
  }, [cronogramaInicial, drawerSourceMode, planning, previousWeekIdForDrawer]);

  const drawerMacroOptions = useMemo(() => (
    Array.from(new Set(drawerCandidateActivities.map(item => slugify(item.macro)).filter(Boolean)))
  ), [drawerCandidateActivities]);

  const filteredMacros = useMemo(() => {
    if (!drawerMacroSearch.trim()) return drawerMacroOptions;
    const query = drawerMacroSearch.toLowerCase();
    return drawerMacroOptions.filter(macro =>
      getMacroTitle(macro).toLowerCase().includes(query) || macro.toLowerCase().includes(query)
    );
  }, [drawerMacroOptions, drawerMacroSearch]);

  useEffect(() => {
    if (allPossibleMacros.length > 0 && visibleSections.length === 0) setVisibleSections(allPossibleMacros);
    if (floors.length > 0 && visibleFloors.length === 0) setVisibleFloors(floors);
  }, [allPossibleMacros, floors]);

  const getActivityActualProgress = (c: any) => {
    if (!c) return 0;
    const floorData = allFloorsData[c.floor];
    if (floorData) {
      const macroKey = slugify(c.macro);
      const section = floorData[macroKey];
      if (section && Array.isArray(section.items)) {
        const item = section.items.find(i => i.id === c.id || (String(i.name || '').toUpperCase() === String(c.service || '').toUpperCase()));
        if (item) {
          return item.actualPercent ?? 0;
        }
      }
    }
    return c.progress ?? 0;
  };

  const getActivityProgressAtDate = (c: any, maxDate: Date) => {
    if (!c) return 0;
    let progress = getActivityActualProgress(c);
    
    (history || []).forEach(record => {
      if (record && record.itemId === c.id && record.floor === c.floor) {
        const recordDate = new Date(record.timestamp);
        if (!isNaN(recordDate.getTime()) && recordDate > maxDate) {
          progress -= record.progressAchieved;
        }
      }
    });
    
    return Math.max(0, Math.min(100, progress));
  };

  const getProjectActivities = (floorName?: string, macroId?: string) => {
    let items = cronogramaInicial;
    if (!items || items.length === 0) {
      const list = [];
      Object.keys(allFloorsData).forEach(f => {
        const fData = allFloorsData[f];
        if (fData) {
          Object.keys(fData).forEach(m => {
            const sec = fData[m];
            if (sec && Array.isArray(sec.items)) {
              sec.items.forEach(item => {
                list.push({
                  id: item.id,
                  floor: f,
                  macro: sec.title || m,
                  service: item.name,
                  cost: 0,
                  progress: item.actualPercent
                });
              });
            }
          });
        }
      });
      items = list;
    }

    return items.filter(c => {
      if (floorName && c.floor !== floorName) return false;
      if (macroId && slugify(c.macro) !== slugify(macroId)) return false;
      return true;
    });
  };

  const getCumulativeProgressStats = (activities: any[]) => {
    if (!activities || activities.length === 0) return { previsto: 0, realizado: 0 };

    const targetDate = new Date(currentWeekStart.getTime() + 6 * 24 * 60 * 60 * 1000);

    let totalCost = 0;
    let weightedPrevisto = 0;
    let weightedRealizado = 0;

    activities.forEach(c => {
      if (!c) return;
      const cost = typeof c.cost === 'number' ? c.cost : 0;
      const act = getActivityProgressAtDate(c, targetDate);
      
      let expected = 0;
      if (c.start && c.end) {
        const s = new Date(c.start);
        const e = new Date(c.end);
        if (targetDate >= e) expected = 100;
        else if (targetDate <= s) expected = 0;
        else {
          const totalMs = e.getTime() - s.getTime();
          const elapsedMs = targetDate.getTime() - s.getTime();
          expected = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
        }
      }

      totalCost += cost;
      weightedPrevisto += expected * cost;
      weightedRealizado += act * cost;
    });

    if (totalCost > 0) {
      return {
        previsto: weightedPrevisto / totalCost,
        realizado: weightedRealizado / totalCost
      };
    } else {
      let sumPrevisto = 0;
      let sumRealizado = 0;
      activities.forEach(c => {
        sumRealizado += getActivityProgressAtDate(c, targetDate);
        let expected = 0;
        if (c.start && c.end) {
          const s = new Date(c.start);
          const e = new Date(c.end);
          if (targetDate >= e) expected = 100;
          else if (targetDate <= s) expected = 0;
          else {
            const totalMs = e.getTime() - s.getTime();
            const elapsedMs = targetDate.getTime() - s.getTime();
            expected = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
          }
        }
        sumPrevisto += expected;
      });
      return {
        previsto: sumPrevisto / activities.length,
        realizado: sumRealizado / activities.length
      };
    }
  };

  const getAderenciaStats = () => {
    if (!cronogramaInicial || cronogramaInicial.length === 0) return 1.0;
    const targetDate = new Date(currentWeekStart.getTime() + 6 * 24 * 60 * 60 * 1000);

    let totalPV = 0;
    let totalEV = 0;
    let totalCost = 0;

    cronogramaInicial.forEach(c => {
      if (!c) return;
      const cost = typeof c.cost === 'number' ? c.cost : 0;
      const act = getActivityProgressAtDate(c, targetDate);
      
      let expected = 0;
      if (c.start && c.end) {
        const s = new Date(c.start);
        const e = new Date(c.end);
        if (targetDate >= e) expected = 100;
        else if (targetDate <= s) expected = 0;
        else {
          const totalMs = e.getTime() - s.getTime();
          const elapsedMs = targetDate.getTime() - s.getTime();
          expected = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
        }
      }

      totalPV += (expected / 100) * cost;
      totalEV += (act / 100) * cost;
      totalCost += cost;
    });

    if (totalPV > 0) {
      return totalEV / totalPV;
    } else if (totalCost > 0) {
      return totalEV > 0 ? 1.0 : 1.0;
    } else {
      let sumExpected = 0;
      let sumActual = 0;
      cronogramaInicial.forEach(c => {
        sumActual += getActivityProgressAtDate(c, targetDate);
        let expected = 0;
        if (c.start && c.end) {
          const s = new Date(c.start);
          const e = new Date(c.end);
          if (targetDate >= e) expected = 100;
          else if (targetDate <= s) expected = 0;
          else {
            const totalMs = e.getTime() - s.getTime();
            const elapsedMs = targetDate.getTime() - s.getTime();
            expected = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
          }
        }
        sumExpected += expected;
      });
      return sumExpected > 0 ? sumActual / sumExpected : 1.0;
    }
  };



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

  const ppcChartData = useMemo(() => [...ppcHistory].sort((a, b) => {
    const timeA = a && a.weekStart ? new Date(a.weekStart).getTime() : 0;
    const timeB = b && b.weekStart ? new Date(b.weekStart).getTime() : 0;
    return (Number.isNaN(timeA) ? 0 : timeA) - (Number.isNaN(timeB) ? 0 : timeB);
  }), [ppcHistory]);

  const availableFloorsForMacro = useMemo(() => {
    if (drawerSourceMode === 'unfinished') return [];
    if (!drawerMacro) return [];
    return Array.from(new Set(
      drawerCandidateActivities
        .filter(item => slugify(item.macro) === drawerMacro && (item.progress ?? 0) < 100)
        .map(item => item.floor)
    )).filter(Boolean);
  }, [drawerCandidateActivities, drawerMacro, drawerSourceMode]);

  const availableServicesForMacroAndFloors = useMemo(() => {
    if (drawerSourceMode === 'unfinished') return drawerCandidateActivities;
    if (!drawerMacro || drawerFloors.length === 0) return [];
    return drawerCandidateActivities.filter(item =>
      slugify(item.macro) === drawerMacro && 
      drawerFloors.includes(item.floor) &&
      (item.progress ?? 0) < 100
    );
  }, [drawerCandidateActivities, drawerMacro, drawerFloors, drawerSourceMode]);

  useEffect(() => {
    setDrawerFloors([]);
    setDrawerSelectedServices([]);
    setDrawerWarning('');
    if (drawerMacro && !drawerMacroOptions.includes(drawerMacro)) setDrawerMacro('');
  }, [drawerSourceMode, drawerMacroOptions]);


  const currentWeekId = toLocalDateString(currentWeekStart);
  const weeklyTasks = planning.filter(t => t.weekId === currentWeekId);
  const pendingBudgetDiffs = useMemo(() => (
    budgetDiffs.filter(diff => diff && !diff.appliedWeekId && Number(diff.delta) > 0)
  ), [budgetDiffs]);
  const pendingBudgetDiffProgress = useMemo(() => (
    Math.round(pendingBudgetDiffs.reduce((sum, diff) => sum + (Number(diff.delta) || 0), 0) * 100) / 100
  ), [pendingBudgetDiffs]);
  const previousBudgetImport = budgetImportVersions.length > 1 ? budgetImportVersions[budgetImportVersions.length - 2] : null;
  const currentBudgetImport = budgetImportVersions.length > 0 ? budgetImportVersions[budgetImportVersions.length - 1] : null;
  const getBudgetImportTooltip = (version) => {
    if (!version) return 'Nenhuma importacao registrada';
    const lines = [
      `Arquivo: ${version.fileName || 'Sem nome'}`,
      `Importado em: ${formatTimestamp(version.importedAt) || '--'}`
    ];
    if (version.activityCount !== undefined) lines.push(`Atividades: ${version.activityCount}`);
    if (version.diffCount !== undefined) lines.push(`Diferencas: ${version.diffCount}`);
    return lines.join('\n');
  };

  const currentWeekPpcStats = useMemo(() => {
    const plannedTasks = weeklyTasks.filter(t => (t.plannedThisWeek ?? 100) > 0);
    const completedTasks = plannedTasks.filter(t => (t.progressThisWeek ?? 0) >= (t.plannedThisWeek ?? 100));
    const percent = plannedTasks.length > 0 ? (completedTasks.length / plannedTasks.length) * 100 : 0;
    return { percent, completedCount: completedTasks.length, totalPlannedCount: plannedTasks.length };
  }, [weeklyTasks]);

  const configItemsToDisplay = useMemo(() => {
    for (const f of floors) {
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

  const getItemCost = (itemId: string) => {
    const match = cronogramaInicial.find(c => c && c.id === itemId);
    return match && typeof match.cost === 'number' ? match.cost : 0;
  };

  const getPackageProgress = (floor: string, macroId: string, itemsList: any[]) => {
    if (!itemsList || itemsList.length === 0) return 0;
    
    let totalCost = 0;
    let weightedProgressSum = 0;
    
    itemsList.forEach(item => {
      if (!item) return;
      const cost = getItemCost(item.id);
      const actualPct = item.actualPercent || 0;
      totalCost += cost;
      weightedProgressSum += actualPct * cost;
    });
    
    if (totalCost > 0) {
      return weightedProgressSum / totalCost;
    }
    
    // Fallback to simple average if total cost is 0
    const sum = itemsList.reduce((acc, item) => acc + (item?.actualPercent || 0), 0);
    return sum / itemsList.length;
  };

  const macroEvolutionHistory = useMemo(() => {
    const map: Record<string, any> = {};
    
    // Initialize map with all packages that currently have progress > 0
    Object.keys(allFloorsData).forEach(floor => {
      const floorData = allFloorsData[floor];
      if (!floorData) return;
      Object.keys(floorData).forEach(macro => {
        const section = floorData[macro];
        if (!section || !Array.isArray(section.items)) return;
        
        // Calculate cost-weighted progress of the package
        const currentPackageProgress = getPackageProgress(floor, macro, section.items);
        
        if (currentPackageProgress > 0) {
          if (!map[macro]) {
            map[macro] = { 
              sectionId: macro, 
              sectionTitle: getMacroTitle(macro), 
              floors: {} 
            };
          }
          if (!map[macro].floors[floor]) {
            map[macro].floors[floor] = { 
              floor, 
              weeks: {},
              finalProgress: currentPackageProgress,
              totalItems: section.items.length,
              totalHistoryDelta: 0
            };
          }
        }
      });
    });

    const sortedHistory = [...history].sort((a, b) => {
      const dateA = a && a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const dateB = b && b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return (Number.isNaN(dateA) ? 0 : dateA) - (Number.isNaN(dateB) ? 0 : dateB);
    });

    sortedHistory.forEach(record => {
      if (!record) return;
      const floor = record.floor || 'Sem Pavimento';
      const macro = record.sectionId || 'Sem Macro';
      const itemId = record.itemId || 'Sem Item';
      const progressAchieved = Number(record.progressAchieved) || 0;
      
      const recDate = record.timestamp ? new Date(record.timestamp) : new Date();
      const validDate = isNaN(recDate.getTime()) ? new Date() : recDate;
      const weekStr = getWeekStartDate(validDate).toISOString().split('T')[0];

      if (!map[macro]) {
        map[macro] = { 
          sectionId: macro, 
          sectionTitle: getMacroTitle(macro), 
          floors: {} 
        };
      }
      if (!map[macro].floors[floor]) {
        const totalItems = allFloorsData[floor]?.[macro]?.items?.length || 1;
        const currentPackageProgress = getPackageProgress(floor, macro, allFloorsData[floor]?.[macro]?.items || []);
        map[macro].floors[floor] = { 
          floor, 
          weeks: {},
          finalProgress: currentPackageProgress,
          totalItems: totalItems,
          totalHistoryDelta: 0
        };
      }

      // Calculate the package-level delta based on costs
      const section = allFloorsData[floor]?.[macro];
      const itemsList = section?.items || [];
      const totalCost = itemsList.reduce((sum, item) => sum + (getItemCost(item.id) || 0), 0);
      
      const itemCost = getItemCost(itemId);
      const pkgDelta = totalCost > 0 ? (progressAchieved * itemCost) / totalCost : progressAchieved / (itemsList.length || 1);

      map[macro].floors[floor].totalHistoryDelta += pkgDelta;

      if (!map[macro].floors[floor].weeks[weekStr]) {
        map[macro].floors[floor].weeks[weekStr] = { 
          dateStr: formatDateBR(weekStr), 
          services: [], 
          macroDelta: 0, 
          macroPercent: 0 
        };
      }
      
      map[macro].floors[floor].weeks[weekStr].services.push({ 
        name: record.itemName || 'Sem Nome', 
        delta: progressAchieved,
        pkgDelta: pkgDelta
      });
    });

    const result = [];
    Object.keys(map).forEach(mId => {
      const macroData = map[mId];
      const floorsList = [];

      Object.keys(macroData.floors).forEach(fKey => {
        const floorData = macroData.floors[fKey];
        
        // Calculate initial progress (before any recorded history)
        const initialProgress = Math.max(0, floorData.finalProgress - floorData.totalHistoryDelta);
        
        let cumulativeMacroPct = initialProgress;
        const sortedWeeks = Object.keys(floorData.weeks).sort();
        const changes = [];

        // If there was initial progress before history, add an "Importado" start block
        if (initialProgress > 0) {
          changes.push({
            dateStr: 'Importado',
            macroDelta: initialProgress,
            macroPercent: initialProgress,
            isImported: true,
            services: [{ name: 'Avanço inicial/importado', delta: initialProgress }]
          });
        }

        sortedWeeks.forEach(wKey => {
          const weekData = floorData.weeks[wKey];
          const weekMacroDelta = (weekData.services || []).reduce((sum, s) => sum + (s.pkgDelta || 0), 0);
          cumulativeMacroPct += weekMacroDelta;
          weekData.macroDelta = weekMacroDelta;
          weekData.macroPercent = Math.min(100, Math.max(0, cumulativeMacroPct));
          if (weekMacroDelta !== 0) changes.push(weekData);
        });

        if (changes.length > 0) {
          floorsList.push({
            floor: floorData.floor,
            changes
          });
        }
      });

      if (floorsList.length > 0) {
        result.push({
          sectionId: mId,
          sectionTitle: macroData.sectionTitle,
          floors: floorsList
        });
      }
    });

    return result;
  }, [history, allFloorsData]);

  // --- Memória do Detalhamento PPC ---
  const uniqueContractors = useMemo(() => {
    const set = new Set<string>();
    (teams || []).forEach(t => {
      if (t) set.add(t);
    });
    planning.forEach(t => {
      if (t && t.responsible) set.add(t.responsible);
    });
    return Array.from(set).sort();
  }, [teams, planning]);

  const availableWeeks = useMemo(() => {
    const set = new Set<string>();
    planning.forEach(t => {
      if (t && t.weekId) set.add(t.weekId);
    });
    if (set.size === 0) {
      set.add(toLocalDateString(currentWeekStart));
    }
    return Array.from(set).sort();
  }, [planning, currentWeekStart]);

  const contractorsInPeriod = useMemo(() => {
    const set = new Set<string>();
    if (ppcStartWeek && ppcEndWeek) {
      planning.forEach(t => {
        if (t && t.weekId >= ppcStartWeek && t.weekId <= ppcEndWeek && t.responsible) {
          set.add(t.responsible);
        }
      });
    } else {
      planning.forEach(t => {
        if (t && t.responsible) set.add(t.responsible);
      });
    }
    if (set.size === 0) {
      return uniqueContractors;
    }
    return Array.from(set).sort();
  }, [planning, ppcStartWeek, ppcEndWeek, uniqueContractors]);

  // Sync state once lists are computed
  useEffect(() => {
    if (contractorsInPeriod.length > 0) {
      if (!ppcSelectedContractor || !contractorsInPeriod.includes(ppcSelectedContractor)) {
        setPpcSelectedContractor(contractorsInPeriod[0]);
      }
    }
  }, [contractorsInPeriod, ppcSelectedContractor]);

  useEffect(() => {
    if (availableWeeks.length > 0) {
      if (!ppcStartWeek) {
        setPpcStartWeek(availableWeeks[0]);
      }
      if (!ppcEndWeek) {
        setPpcEndWeek(availableWeeks[availableWeeks.length - 1]);
      }
    }
  }, [availableWeeks, ppcStartWeek, ppcEndWeek]);

  // Helper: format weekId "YYYY-MM-DD" to "DD/MM/YYYY"
  const formatWeekId = (wId: string) => {
    if (!wId) return '';
    const parts = wId.split('-');
    if (parts.length !== 3) return wId;
    const [y, m, d] = parts;
    return `${d}/${m}/${y}`;
  };

  // Calculate Weekly PPC for contractor
  const contractorWeeklyPpcData = useMemo(() => {
    if (!ppcSelectedContractor || !ppcStartWeek || !ppcEndWeek) return [];
    
    const selectedWeeks = availableWeeks.filter(w => w >= ppcStartWeek && w <= ppcEndWeek);
    
    return selectedWeeks.map(wId => {
      const weekTasks = planning.filter(t => t.weekId === wId && t.responsible === ppcSelectedContractor);
      const plannedTasks = weekTasks.filter(t => (t.plannedThisWeek ?? 100) > 0);
      const completedTasks = plannedTasks.filter(t => (t.progressThisWeek ?? 0) >= (t.plannedThisWeek ?? 100));
      
      const weekStart = new Date(wId + 'T00:00:00');
      const weekEnd = new Date(weekStart.getTime() + 6 * 86400000); // Sunday
      
      if (plannedTasks.length === 0) {
        return {
          weekId: wId,
          startDateStr: formatWeekId(wId),
          endDateStr: weekEnd.toLocaleDateString('pt-BR'),
          ppc: null,
          plannedCount: 0,
          completedCount: 0
        };
      }
      
      const ppcVal = (completedTasks.length / plannedTasks.length) * 100;
      return {
        weekId: wId,
        startDateStr: formatWeekId(wId),
        endDateStr: weekEnd.toLocaleDateString('pt-BR'),
        ppc: Math.round(ppcVal),
        plannedCount: plannedTasks.length,
        completedCount: completedTasks.length
      };
    });
  }, [ppcSelectedContractor, ppcStartWeek, ppcEndWeek, availableWeeks, planning]);

  // Calculate overall average PPC for the period
  const averagePpc = useMemo(() => {
    const validWeeks = contractorWeeklyPpcData.filter(d => d.ppc !== null);
    if (validWeeks.length === 0) return 0;
    const sum = validWeeks.reduce((acc, d) => acc + d.ppc!, 0);
    return Math.round(sum / validWeeks.length);
  }, [contractorWeeklyPpcData]);

  // Calculate Delay Causes (7 largest) for selected period
  const delayCausesData = useMemo(() => {
    if (!ppcSelectedContractor || !ppcStartWeek || !ppcEndWeek) return [];
    
    const reasonsMap: Record<string, number> = {};
    
    planning.forEach(t => {
      if (t && t.weekId >= ppcStartWeek && t.weekId <= ppcEndWeek && t.responsible === ppcSelectedContractor) {
        const planned = t.plannedThisWeek ?? 100;
        const progress = t.progressThisWeek ?? 0;
        if (progress < planned) {
          const reason = t.delayReason ? t.delayReason.trim() : 'Sem motivo definido';
          reasonsMap[reason] = (reasonsMap[reason] || 0) + 1;
        }
      }
    });
    
    const totalDelays = Object.values(reasonsMap).reduce((a, b) => a + b, 0);
    if (totalDelays === 0) return [];
    
    const list = Object.entries(reasonsMap).map(([reason, count]) => {
      const percent = Math.round((count / totalDelays) * 100);
      return { reason, count, percent };
    }).sort((a, b) => b.count - a.count);
    
    // Limit to 7 categories
    if (list.length > 7) {
      const top6 = list.slice(0, 6);
      const rest = list.slice(6);
      const restCount = rest.reduce((acc, item) => acc + item.count, 0);
      const restPercent = Math.round((restCount / totalDelays) * 100);
      top6.push({ reason: 'Outros motivos', count: restCount, percent: restPercent });
      return top6;
    }
    
    return list;
  }, [ppcSelectedContractor, ppcStartWeek, ppcEndWeek, planning]);

  // SVG Line Chart Generation (PPC Evolution)
  const ppcEvolutionChart = useMemo(() => {
    const width = 600;
    const height = 300;
    const mLeft = 50;
    const mRight = 20;
    const mTop = 35;
    const mBottom = 55;
    
    const chartW = width - mLeft - mRight;
    const chartH = height - mTop - mBottom;
    
    // Filter valid points (weeks with active tasks)
    const validPoints = contractorWeeklyPpcData
      .map((d, index) => ({ ...d, index }))
      .filter(d => d.ppc !== null);
      
    if (contractorWeeklyPpcData.length === 0) return null;
    
    const getX = (index: number) => {
      const total = contractorWeeklyPpcData.length;
      if (total <= 1) return mLeft + chartW / 2;
      return mLeft + (index / (total - 1)) * chartW;
    };
    
    const getY = (val: number) => {
      return mTop + chartH - (val / 120) * chartH;
    };
    
    // Build lines path
    let pathD = '';
    if (validPoints.length > 1) {
      pathD = validPoints.map((pt, i) => {
        const x = getX(pt.index);
        const y = getY(pt.ppc!);
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
      }).join(' ');
    }
    
    // Meta target is constant 80
    const yMeta = getY(80);
    
    // Build vertical grid lines & X-axis labels
    const xLabels = contractorWeeklyPpcData.map((d, index) => {
      const x = getX(index);
      const total = contractorWeeklyPpcData.length;
      const interval = Math.max(1, Math.ceil(total / 8));
      const shouldShow = index % interval === 0 || index === total - 1;
      
      return {
        x,
        text: d.startDateStr.slice(0, 5), // Only "DD/MM"
        fullText: d.startDateStr,
        shouldShow
      };
    });

    // Y-axis ticks
    const yTicks = [0, 20, 40, 60, 80, 100, 120];
    
    return {
      width,
      height,
      mLeft,
      chartW,
      chartH,
      pathD,
      yMeta,
      xLabels,
      yTicks,
      validPoints,
      getX,
      getY
    };
  }, [contractorWeeklyPpcData]);

  // Render coordinates for Pie Chart SVG
  const pieChartSlices = useMemo(() => {
    const radius = 80;
    let currentPercent = 0;
    
    const colors = [
      '#6366f1', // Indigo
      '#ec4899', // Pink
      '#f59e0b', // Amber
      '#10b981', // Emerald
      '#3b82f6', // Blue
      '#a855f7', // Purple
      '#f43f5e', // Rose
    ];
    
    return delayCausesData.map((d, idx) => {
      const startPercent = currentPercent;
      const percentVal = d.percent / 100;
      currentPercent += percentVal;
      const endPercent = currentPercent;
      
      const getCoordinatesForPercent = (p: number) => {
        const angle = (p * 360 - 90) * (Math.PI / 180);
        return {
          x: radius * Math.cos(angle),
          y: radius * Math.sin(angle)
        };
      };
      
      const startCoords = getCoordinatesForPercent(startPercent);
      const endCoords = getCoordinatesForPercent(endPercent);
      
      const largeArcFlag = percentVal > 0.5 ? 1 : 0;
      
      const pathData = `M 0 0 L ${startCoords.x} ${startCoords.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endCoords.x} ${endCoords.y} Z`;
      
      const midPercent = startPercent + percentVal / 2;
      const midAngle = (midPercent * 360 - 90) * (Math.PI / 180);
      const labelRadius = radius * 0.65;
      const labelCoords = {
        x: labelRadius * Math.cos(midAngle),
        y: labelRadius * Math.sin(midAngle)
      };
      
      return {
        ...d,
        pathData,
        color: colors[idx % colors.length],
        labelCoords,
        percentVal
      };
    });
  }, [delayCausesData]);

  const filteredGiantPlanningTasks = useMemo(() => {
    const sorted = planning.filter(t => {
      if (!t) return false;
      const actName = t.activityName ? String(t.activityName) : '';
      const respName = t.responsible ? String(t.responsible) : '';
      const matchesSearch = !giantSearch || 
        actName.toLowerCase().includes(giantSearch.toLowerCase()) || 
        respName.toLowerCase().includes(giantSearch.toLowerCase()) || 
        (t.observations || '').toLowerCase().includes(giantSearch.toLowerCase());
      const matchesFloor = !giantFloorFilter || t.floor === giantFloorFilter;
      const matchesMacro = !giantMacroFilter || slugify(t.sectionId) === slugify(giantMacroFilter);
      const matchesStatus = !giantStatusFilter || (giantStatusFilter === 'finalized' ? t.finalized : !t.finalized);
      return matchesSearch && matchesFloor && matchesMacro && matchesStatus;
    });

    const key = giantSortKey;
    const dir = giantSortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      let aVal: any = '';
      let bVal: any = '';
      if (key === 'weekId') { aVal = a.weekId || ''; bVal = b.weekId || ''; }
      else if (key === 'floor') { aVal = a.floor || ''; bVal = b.floor || ''; }
      else if (key === 'sectionId') { aVal = a.sectionId || ''; bVal = b.sectionId || ''; }
      else if (key === 'activityName') { aVal = a.activityName || ''; bVal = b.activityName || ''; }
      else if (key === 'responsible') { aVal = a.responsible || ''; bVal = b.responsible || ''; }
      else if (key === 'plannedThisWeek') { aVal = a.plannedThisWeek ?? 0; bVal = b.plannedThisWeek ?? 0; }
      else if (key === 'progressThisWeek') { aVal = a.progressThisWeek ?? 0; bVal = b.progressThisWeek ?? 0; }
      else if (key === 'accumulated') {
        aVal = Math.min(100, (Number(a.executedBefore) || 0) + (Number(a.progressThisWeek) || 0));
        bVal = Math.min(100, (Number(b.executedBefore) || 0) + (Number(b.progressThisWeek) || 0));
      }
      else { aVal = a.weekId || ''; bVal = b.weekId || ''; }
      if (typeof aVal === 'number') return (aVal - bVal) * dir;
      return String(aVal).localeCompare(String(bVal)) * dir;
    });
    return sorted;
  }, [planning, giantSearch, giantFloorFilter, giantMacroFilter, giantStatusFilter, giantSortKey, giantSortDir]);

  const filteredCronograma = useMemo(() => {
    let items = (cronogramaInicial || []).filter(item => {
      if (!item) return false;
      const matchesSearch = !cronoSearch ||
        (item.service || '').toLowerCase().includes(cronoSearch.toLowerCase()) ||
        (item.macro || '').toLowerCase().includes(cronoSearch.toLowerCase()) ||
        (item.responsible || '').toLowerCase().includes(cronoSearch.toLowerCase());
      const matchesFloor = !cronoFloorFilter || item.floor === cronoFloorFilter;
      const matchesMacro = !cronoMacroFilter || slugify(item.macro) === slugify(cronoMacroFilter);
      let matchesProgress = true;
      if (cronoProgressFilter === 'notstarted') matchesProgress = (item.progress ?? 0) === 0;
      else if (cronoProgressFilter === 'inprogress') matchesProgress = (item.progress ?? 0) > 0 && (item.progress ?? 0) < 100;
      else if (cronoProgressFilter === 'done') matchesProgress = (item.progress ?? 0) >= 100;
      return matchesSearch && matchesFloor && matchesMacro && matchesProgress;
    });

    if (cronoSortKey) {
      const dir = cronoSortDir === 'asc' ? 1 : -1;
      items = [...items].sort((a, b) => {
        let aVal: any = '';
        let bVal: any = '';
        if (cronoSortKey === 'macro') { aVal = a.macro || ''; bVal = b.macro || ''; }
        else if (cronoSortKey === 'floor') { aVal = a.floor || ''; bVal = b.floor || ''; }
        else if (cronoSortKey === 'service') { aVal = a.service || ''; bVal = b.service || ''; }
        else if (cronoSortKey === 'duration') { aVal = a.duration ?? 0; bVal = b.duration ?? 0; }
        else if (cronoSortKey === 'end') { aVal = a.end || ''; bVal = b.end || ''; }
        else if (cronoSortKey === 'progress') { aVal = a.progress ?? 0; bVal = b.progress ?? 0; }
        else if (cronoSortKey === 'cost') { aVal = a.cost ?? 0; bVal = b.cost ?? 0; }
        if (typeof aVal === 'number') return (aVal - bVal) * dir;
        return String(aVal).localeCompare(String(bVal)) * dir;
      });
    }
    return items;
  }, [cronogramaInicial, cronoSearch, cronoFloorFilter, cronoMacroFilter, cronoProgressFilter, cronoSortKey, cronoSortDir]);

  const cronogramaOrderMap = useMemo(() => {
    const groupOrder = new Map<string, number>();
    const macroOrder = new Map<string, number>();
    const groupMacroOrder = new Map<string, number>();
    const itemOrder = new Map<string, number>();
    const byItemId = new Map<string, any>();
    const byOriginalId = new Map<string, any>();
    const byComposite = new Map<string, any>();
    let nextGroupOrder = 0;
    let nextMacroOrder = 0;
    let nextGroupMacroOrder = 0;

    (cronogramaInicial || []).forEach((item, index) => {
      const group = String(item?.replicationGroup || 'Não agrupado').trim() || 'Não agrupado';
      const macroKey = slugify(item?.macro || item?.sectionId || '');
      const compositeKey = `${item?.floor || ''}||${macroKey}||${item?.service || item?.activityName || ''}`.toLowerCase();

      if (!groupOrder.has(group)) groupOrder.set(group, nextGroupOrder++);
      if (macroKey && !macroOrder.has(macroKey)) macroOrder.set(macroKey, nextMacroOrder++);
      if (macroKey) {
        const groupMacroKey = `${group}||${macroKey}`;
        if (!groupMacroOrder.has(groupMacroKey)) groupMacroOrder.set(groupMacroKey, nextGroupMacroOrder++);
      }

      if (item?.id) {
        itemOrder.set(String(item.id), index);
        byItemId.set(String(item.id), item);
      }
      if (item?.originalId) byOriginalId.set(String(item.originalId), item);
      if (compositeKey !== '||||') byComposite.set(compositeKey, item);
    });

    return { groupOrder, macroOrder, groupMacroOrder, itemOrder, byItemId, byOriginalId, byComposite };
  }, [cronogramaInicial]);

  const getCronogramaOrderInfoForTask = (task) => {
    const macroKey = slugify(task?.sectionId || task?.macro || '');
    const compositeKey = `${task?.floor || ''}||${macroKey}||${task?.activityName || task?.service || ''}`.toLowerCase();
    const cronoItem =
      cronogramaOrderMap.byItemId.get(String(task?.itemId || '')) ||
      cronogramaOrderMap.byOriginalId.get(String(task?.originalId || '')) ||
      cronogramaOrderMap.byComposite.get(compositeKey);
    const group = String(task?.replicationGroup || cronoItem?.replicationGroup || 'Não agrupado').trim() || 'Não agrupado';
    const resolvedMacroKey = slugify(cronoItem?.macro || task?.sectionId || task?.macro || '');
    const groupMacroKey = `${group}||${resolvedMacroKey}`;

    return {
      groupOrder: cronogramaOrderMap.groupOrder.get(group) ?? Number.MAX_SAFE_INTEGER,
      macroOrder: cronogramaOrderMap.groupMacroOrder.get(groupMacroKey) ?? cronogramaOrderMap.macroOrder.get(resolvedMacroKey) ?? Number.MAX_SAFE_INTEGER,
      itemOrder: cronoItem?.id ? (cronogramaOrderMap.itemOrder.get(String(cronoItem.id)) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
    };
  };

  const filteredWeeklyTasks = useMemo(() => {
    const hasActivePlanningFilters = !!planningSearch || !!planningTeamFilter || !!planningStatusFilter;
    let tasks = (weeklyTasks || []).map((task, index) => ({ task, index })).filter(({ task: t }) => {
      if (!t) return false;
      const macroTitle = t.sectionId ? getMacroTitle(t.sectionId) : '';
      const matchesSearch = !planningSearch ||
        (t.activityName || '').toLowerCase().includes(planningSearch.toLowerCase()) ||
        (t.responsible || '').toLowerCase().includes(planningSearch.toLowerCase()) ||
        (t.observations || '').toLowerCase().includes(planningSearch.toLowerCase()) ||
        (t.floor || '').toLowerCase().includes(planningSearch.toLowerCase()) ||
        macroTitle.toLowerCase().includes(planningSearch.toLowerCase());
      const matchesTeam = !planningTeamFilter || t.responsible === planningTeamFilter;
      let matchesStatus = true;
      const progVal = t.progressThisWeek ?? 0;
      const planVal = t.plannedThisWeek ?? 100;
      if (planningStatusFilter === 'ok') matchesStatus = !t.finalized && progVal >= planVal;
      else if (planningStatusFilter === 'delayed') matchesStatus = !t.finalized && progVal < planVal;
      else if (planningStatusFilter === 'finalized') matchesStatus = !!t.finalized;
      return matchesSearch && matchesTeam && matchesStatus;
    });

    if (planningSortKey) {
      const dir = planningSortDir === 'asc' ? 1 : -1;
      tasks = [...tasks].sort((a, b) => {
        const taskA = a.task;
        const taskB = b.task;
        let aVal: any = '';
        let bVal: any = '';
        if (planningSortKey === 'activityName') { aVal = taskA.activityName || ''; bVal = taskB.activityName || ''; }
        else if (planningSortKey === 'floor') { aVal = taskA.floor || ''; bVal = taskB.floor || ''; }
        else if (planningSortKey === 'responsible') { aVal = taskA.responsible || ''; bVal = taskB.responsible || ''; }
        else if (planningSortKey === 'efetivo') { aVal = taskA.efetivo ?? 0; bVal = taskB.efetivo ?? 0; }
        else if (planningSortKey === 'plannedThisWeek') { aVal = taskA.plannedThisWeek ?? 0; bVal = taskB.plannedThisWeek ?? 0; }
        else if (planningSortKey === 'progressThisWeek') { aVal = taskA.progressThisWeek ?? 0; bVal = taskB.progressThisWeek ?? 0; }
        if (typeof aVal === 'number') return (aVal - bVal) * dir;
        return String(aVal).localeCompare(String(bVal)) * dir;
      });
    } else if (!hasActivePlanningFilters) {
      tasks = [...tasks].sort((a, b) => {
        const aOrder = getCronogramaOrderInfoForTask(a.task);
        const bOrder = getCronogramaOrderInfoForTask(b.task);

        return (
          aOrder.groupOrder - bOrder.groupOrder ||
          aOrder.macroOrder - bOrder.macroOrder ||
          aOrder.itemOrder - bOrder.itemOrder ||
          a.index - b.index
        );
      });
    }
    return tasks.map(({ task }) => task);
  }, [weeklyTasks, planningSearch, planningTeamFilter, planningStatusFilter, planningSortKey, planningSortDir, cronogramaOrderMap]);

  // --- Handlers de Ações ---
  const handleGeneratePlanningFromBudgetDiffs = async () => {
    if (pendingBudgetDiffs.length === 0) {
      setNotification({ message: 'Nao ha diferencas de orcamento pendentes para aplicar.', type: 'error' });
      return;
    }

    const diffsByItem = new Map<string, any>();
    pendingBudgetDiffs.forEach(diff => {
      const existing = diffsByItem.get(diff.itemId);
      if (!existing) {
        diffsByItem.set(diff.itemId, { ...diff });
        return;
      }
      existing.delta = Math.round(((Number(existing.delta) || 0) + (Number(diff.delta) || 0)) * 1000) / 1000;
      existing.newProgress = Math.max(Number(existing.newProgress) || 0, Number(diff.newProgress) || 0);
    });

    let mergedCount = 0;
    let createdCount = 0;
    const appliedDiffIds = new Set(pendingBudgetDiffs.map(diff => diff.id));
    let updatedPlanning = [...planning];

    diffsByItem.forEach(diff => {
      const itemDiffIds = pendingBudgetDiffs.filter(d => d.itemId === diff.itemId).map(d => d.id);
      const delta = Math.round((Number(diff.delta) || 0) * 1000) / 1000;
      if (delta <= 0) return;

      const existingIndex = updatedPlanning.findIndex(t => t.weekId === currentWeekId && t.itemId === diff.itemId && !t.finalized);
      if (existingIndex !== -1) {
        const task = updatedPlanning[existingIndex];
        updatedPlanning[existingIndex] = {
          ...task,
          progressThisWeek: Math.min(100, Math.round(((Number(task.progressThisWeek) || 0) + delta) * 1000) / 1000),
          budgetDiffIds: Array.from(new Set([...(task.budgetDiffIds || []), ...itemDiffIds])),
          observations: task.observations || 'Avanço preenchido por diferença entre versões de orçamento',
          lastUpdatedBy: plannerUsername || 'Sistema'
        };
        mergedCount++;
        return;
      }

      const cronoMatch = cronogramaInicial.find(item => item.id === diff.itemId);
      const previousProgress = roundPercentValue(diff.previousProgress ?? Math.max(0, (Number(diff.newProgress) || 0) - delta));
      updatedPlanning.push({
        id: crypto.randomUUID(),
        weekId: currentWeekId,
        floor: diff.floor || cronoMatch?.floor || 'Geral',
        sectionId: diff.sectionId || slugify(diff.macro || cronoMatch?.macro),
        itemId: diff.itemId,
        activityName: diff.service || cronoMatch?.service || 'Atividade importada',
        responsible: diff.responsible || cronoMatch?.responsible || teams[0] || 'Equipe Geral',
        weight: 100,
        executedBefore: previousProgress,
        plannedThisWeek: 0,
        progressThisWeek: delta,
        finishDate: diff.end || cronoMatch?.end || toLocalDateString(new Date()),
        dailyWork: [0, 0, 0, 0, 0],
        observations: 'Fora do planejado: avanco detectado por diferenca entre versoes de orcamento',
        delayReason: '',
        finalized: false,
        isUnplannedDetected: true,
        source: 'budget-diff',
        budgetDiffIds: itemDiffIds,
        predecessors: diff.predecessors || cronoMatch?.predecessors || [],
        successors: diff.successors || cronoMatch?.successors || [],
        inheritedDependenciesFrom: diff.inheritedDependenciesFrom || cronoMatch?.inheritedDependenciesFrom || '',
        originalId: diff.originalId || cronoMatch?.originalId || ''
      });
      createdCount++;
    });

    const updatedBudgetDiffs = budgetDiffs.map(diff => (
      appliedDiffIds.has(diff.id)
        ? { ...diff, appliedWeekId: currentWeekId, appliedAt: new Date().toISOString() }
        : diff
    ));

    const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
    setPlanning(recalculatedPlanning);
    setAllFloorsData(updatedFloorsData);
    setBudgetDiffs(updatedBudgetDiffs);
    await saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices, teamPhones, undefined, projectCity, weatherApiKey, weatherCache, true, updatedBudgetDiffs);
    setNotification({ message: `${createdCount} atividades fora do planejado criadas e ${mergedCount} atividades existentes atualizadas para a semana selecionada.`, type: 'success' });
  };

  const handleClearProjectData = async () => {
    const emptyFloors = [];
    const emptyFloorsData = {};
    const emptyHistory = [];
    const emptyWeights = {};
    const emptyPlanning = [];
    const emptyCrono = [];
    const emptyPpcHistory = [];
    const emptyMatrices = [];
    const emptyBudgetDiffs = [];
    const emptyBudgetImportVersions = [];

    await saveToDB(
      emptyFloors,
      emptyFloorsData,
      emptyHistory,
      emptyWeights,
      emptyPlanning,
      emptyCrono,
      teams,
      delayReasons,
      emptyPpcHistory,
      emptyMatrices,
      teamPhones,
      undefined,
      projectCity,
      weatherApiKey,
      weatherCache,
      true,
      emptyBudgetDiffs,
      emptyBudgetImportVersions
    );

    setFloors(emptyFloors);
    setAllFloorsData(emptyFloorsData);
    setHistory(emptyHistory);
    setWeights(emptyWeights);
    setPlanning(emptyPlanning);
    setCronogramaInicial(emptyCrono);
    setPpcHistory(emptyPpcHistory);
    setMatrices(emptyMatrices);
    setBudgetDiffs(emptyBudgetDiffs);
    setBudgetImportVersions(emptyBudgetImportVersions);
    setActiveFloor('');
    setSelectedDashboardFloor('');
    setNotification({ message: 'Base de dados limpa e sincronizada com o Firebase!', type: 'success' });
  };

  const handleIncludeDrawerActivities = async () => {
    if (drawerSourceMode !== 'unfinished' && (!drawerMacro || drawerFloors.length === 0)) {
      setNotification({ message: 'Selecione a Macroatividade, os Pavimentos e pelo menos um Serviço!', type: 'error' });
      return;
    }
    if (drawerSelectedServices.length === 0) {
      setNotification({ message: 'Selecione pelo menos um Serviço!', type: 'error' });
      return;
    }
    const newTasks = [];
    const duplicates = [];

    drawerSelectedServices.forEach(serviceId => {
      const match = drawerCandidateActivities.find(item => item.id === serviceId);
      if (match) {
        const exists = weeklyTasks.some(t => t.itemId === match.id && t.floor === match.floor && !t.finalized);
        if (exists) {
          duplicates.push(`${match.service} (${match.floor})`);
        } else {
          newTasks.push({
            id: crypto.randomUUID(), weekId: currentWeekId, floor: match.floor,
            sectionId: slugify(match.macro), itemId: match.id,
            activityName: match.service, responsible: drawerResponsible || match.responsible || (teams[0] || 'Equipe Geral'),
            isParent: !!match.isParent,
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

  const handleAddManualActivity = async () => {
    if (!manualServiceName.trim()) {
      setNotification({ message: 'Digite o nome do serviço!', type: 'error' });
      return;
    }
    if (!manualFloor) {
      setNotification({ message: 'Selecione o pavimento!', type: 'error' });
      return;
    }
    
    const currentWeekId = toLocalDateString(currentWeekStart);
    
    const exists = weeklyTasks.some(t => t.floor === manualFloor && t.activityName.trim().toUpperCase() === manualServiceName.trim().toUpperCase());
    if (exists) {
      setNotification({ message: 'Esta atividade já está incluída para este pavimento na semana!', type: 'error' });
      return;
    }

    const newTask = {
      id: crypto.randomUUID(),
      weekId: currentWeekId,
      floor: manualFloor,
      sectionId: 'manual',
      itemId: 'manual_' + crypto.randomUUID().slice(0, 8),
      activityName: manualServiceName.trim(),
      responsible: teams[0] || 'Equipe Geral',
      weight: 100,
      executedBefore: 0,
      plannedThisWeek: 100,
      progressThisWeek: 0,
      finishDate: toLocalDateString(new Date()),
      dailyWork: [0, 0, 0, 0, 0],
      observations: '',
      delayReason: '',
      finalized: false,
      isManual: true
    };

    const updatedPlanning = [...planning, newTask];
    await saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    
    setManualServiceName('');
    setManualFloor('');
    setIsAddingManual(false);
    setNotification({ message: 'Atividade extra adicionada com sucesso!', type: 'success' });
  };

  const handleDailyWorkChange = (taskId, newDW) => {
    const updatedPlanning = planning.map(p => p.id === taskId ? { ...p, dailyWork: newDW } : p);
    setPlanning(updatedPlanning);
    saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
  };

  const handlePlannedChange = (taskId, value) => {
    const currentTask = planning.find(t => t.id === taskId);
    if (!currentTask || currentTask.finalized) return;
    const isCurrentActive = (currentTask.plannedThisWeek ?? 100) === value;
    const numericVal = isCurrentActive ? 0 : value;
    const updatedPlanning = planning.map(t => t.id === taskId ? { ...t, plannedThisWeek: numericVal } : t);
    // Optimistic: update UI immediately
    setPlanning(updatedPlanning);
    // Defer expensive sync to after React paints
    setTimeout(() => {
      if (currentTask.isManual) {
        saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
        return;
      }
      const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
      setPlanning(recalculatedPlanning);
      setAllFloorsData(updatedFloorsData);
      saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    }, 0);
  };

  const handleWeeklyProgressChange = (taskId, value) => {
    const task = planning.find(t => t.id === taskId);
    if (!task || task.finalized) return;
    
    const isCurrentActive = (task.progressThisWeek ?? 0) === value;
    const newWeeklyProgress = isCurrentActive ? 0 : value; 
    
    const updatedPlanning = planning.map(t => t.id === taskId ? { 
      ...t, progressThisWeek: newWeeklyProgress, delayReason: (newWeeklyProgress >= (t.plannedThisWeek ?? 100)) ? '' : t.delayReason,
      lastUpdatedBy: plannerUsername || 'Sistema'
    } : t);
    
    // Optimistic: update planning state immediately so the button changes color now
    setPlanning(updatedPlanning);
    
    // Defer heavy cloneDeep + syncPlanningAndPhysical until AFTER React has painted
    setTimeout(() => {
      if (task.isManual) {
        saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
        return;
      }
      
      const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
      const sectionKey = task.sectionId || 'estrutura';
      const itemBefore = allFloorsData[task.floor]?.[sectionKey]?.items.find(i => i.id === task.itemId);
      const itemAfter = updatedFloorsData[task.floor]?.[sectionKey]?.items.find(i => i.id === task.itemId);
      
      const updatedHistory = [...history];
      if (itemBefore && itemAfter) {
        const oldVal = itemBefore.actualPercent || 0;
        const newVal = itemAfter.actualPercent || 0;
        if (newVal !== oldVal) {
          const now = new Date();
          const weekDate = new Date(task.weekId);
          let timestampVal = now.toISOString();
          if (!isNaN(weekDate.getTime())) {
            weekDate.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
            timestampVal = weekDate.toISOString();
          }
          updatedHistory.push({
            timestamp: timestampVal, floor: task.floor, sectionId: sectionKey, sectionTitle: getMacroTitle(sectionKey),
            itemId: task.itemId, itemName: itemAfter.name, progressAchieved: newVal - oldVal, 
            oldPercent: oldVal, newPercent: newVal, userId
          });
        }
      }
      setPlanning(recalculatedPlanning);
      setAllFloorsData(updatedFloorsData);
      saveToDB(floors, updatedFloorsData, updatedHistory, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    }, 0);
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

  const handleUpdateTaskField = (taskId, field, value) => {
    const updatedPlanning = planning.map(t => t.id === taskId ? { ...t, [field]: value, lastUpdatedBy: plannerUsername || 'Sistema' } : t);
    setPlanning(updatedPlanning);
    saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
  };

  const handleRemoveTask = (taskId) => {
    const targetTask = planning.find(t => t.id === taskId);
    const updatedPlanning = planning.filter(t => t.id !== taskId);
    setPlanning(updatedPlanning);
    if (targetTask && targetTask.isManual) {
      saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
      setNotification({ message: 'Atividade extra removida.', type: 'success' });
      return;
    }
    setTimeout(() => {
      const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
      setPlanning(recalculatedPlanning);
      setAllFloorsData(updatedFloorsData);
      saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
      setNotification({ message: 'Atividade removida do planejamento.', type: 'success' });
    }, 0);
  };

  const handleBulkDelete = () => {
    if (selectedTaskIds.length === 0) return;
    triggerConfirm(
      'Excluir Atividades', 
      `Deseja remover as ${selectedTaskIds.length} atividades selecionadas desta semana?`, 
      async () => {
        const updatedPlanning = planning.filter(t => !selectedTaskIds.includes(t.id));
        setPlanning(updatedPlanning);
        setSelectedTaskIds([]);
        
        // Recalcula o progresso físico e sincroniza os dados
        const { recalculatedPlanning, updatedFloorsData } = syncPlanningAndPhysical(updatedPlanning, allFloorsData, cronogramaInicial);
        setPlanning(recalculatedPlanning);
        setAllFloorsData(updatedFloorsData);
        await saveToDB(floors, updatedFloorsData, history, weights, recalculatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
        setNotification({ message: `${updatedPlanning.length === planning.length ? 0 : planning.length - updatedPlanning.length} atividades removidas do planejamento.`, type: 'success' });
      }
    );
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
    setMicConnectingTaskId(taskId);
    setNotification({ message: '🎙️ Aguardando microfone... Fale APÓS o sinal e o aviso de ativo.', type: 'warning' });
    recognition.start();
    
    recognition.onstart = () => {
      setMicConnectingTaskId(null);
      setListeningTaskId(taskId);
      playBeep(600, 0.15);
      setNotification({ message: '🟢 Microfone ATIVO! Pode falar agora.', type: 'success' });
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const existingText = planning.find(t => t.id === taskId)?.observations || '';
      const combinedText = existingText ? `${existingText} | ${transcript}` : transcript;
      handleUpdateTaskField(taskId, 'observations', combinedText);
      setListeningTaskId(null);
      setMicConnectingTaskId(null);
      playBeep(520, 0.12);
      setNotification({ message: 'Observação ditada com sucesso!', type: 'success' });
    };
    recognition.onerror = () => {
      setListeningTaskId(null);
      setMicConnectingTaskId(null);
      playBeep(320, 0.22);
      setNotification({ message: 'Falha ao gravar.', type: 'error' });
    };
    recognition.onspeechend = () => {
      recognition.stop();
      setListeningTaskId(null);
      setMicConnectingTaskId(null);
    };
  };

  const handleServiceComplementVoiceInput = (taskId) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setNotification({ message: "Reconhecimento de voz não suportado pelo seu navegador.", type: "error" });
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    setMicConnectingComplementTaskId(taskId);
    setNotification({ message: '🎙️ Aguardando microfone... Fale APÓS o sinal e o aviso de ativo.', type: 'warning' });
    recognition.start();
    
    recognition.onstart = () => {
      setMicConnectingComplementTaskId(null);
      setListeningComplementTaskId(taskId);
      playBeep(600, 0.15);
      setNotification({ message: '🟢 Microfone ATIVO! Pode falar agora.', type: 'success' });
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const existingText = planning.find(t => t.id === taskId)?.serviceComplement || '';
      const combinedText = existingText ? `${existingText} ${transcript}` : transcript;
      
      const updatedPlanning = planning.map(p => p.id === taskId ? { ...p, serviceComplement: combinedText, lastUpdatedBy: plannerUsername || 'Sistema' } : p);
      setPlanning(updatedPlanning);
      saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
      
      setListeningComplementTaskId(null);
      setMicConnectingComplementTaskId(null);
      playBeep(520, 0.12);
      setNotification({ message: 'Complemento de serviço ditado com sucesso!', type: 'success' });
    };
    recognition.onerror = () => {
      setListeningComplementTaskId(null);
      setMicConnectingComplementTaskId(null);
      playBeep(320, 0.22);
      setNotification({ message: 'Falha ao gravar.', type: 'error' });
    };
    recognition.onspeechend = () => {
      recognition.stop();
      setListeningComplementTaskId(null);
      setMicConnectingComplementTaskId(null);
    };
  };

  const handleTeamVoiceInput = (taskId) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setNotification({ message: "Reconhecimento de voz não suportado pelo seu navegador.", type: "error" });
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    setMicConnectingTaskId(taskId);
    setNotification({ message: '🎙️ Aguardando microfone... Fale APÓS o sinal e o aviso de ativo.', type: 'warning' });
    recognition.start();
    
    recognition.onstart = () => {
      setMicConnectingTaskId(null);
      setListeningTaskId(taskId);
      playBeep(600, 0.15);
      setNotification({ message: '🟢 Microfone ATIVO! Pode falar agora.', type: 'success' });
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      if (taskId === TEAM_GENERAL_OBSERVATIONS_ID) {
        setTeamGeneralObservations(prev => prev ? `${prev} | ${transcript}` : transcript);
        setListeningTaskId(null);
        setMicConnectingTaskId(null);
        playBeep(520, 0.12);
        setNotification({ message: 'Observação geral ditada com sucesso!', type: 'success' });
        return;
      }
      setTeamInputs(prev => {
        const input = prev[taskId] || { progress: 0, delayReason: '', observations: '' };
        const existingText = input.observations || '';
        const combinedText = existingText ? `${existingText} | ${transcript}` : transcript;
        return {
          ...prev,
          [taskId]: { ...input, observations: combinedText }
        };
      });
      setListeningTaskId(null);
      setMicConnectingTaskId(null);
      playBeep(520, 0.12);
      setNotification({ message: 'Observação ditada com sucesso!', type: 'success' });
    };
    recognition.onerror = () => {
      setListeningTaskId(null);
      setMicConnectingTaskId(null);
      playBeep(320, 0.22);
      setNotification({ message: 'Falha ao gravar.', type: 'error' });
    };
    recognition.onspeechend = () => {
      recognition.stop();
      setListeningTaskId(null);
      setMicConnectingTaskId(null);
    };
  };

  const handleFileUpload = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsImporting(true);
    setImportStatus('Lendo e analisando planilha Excel...');

    const reader = new FileReader();
    reader.onload = (evt: any) => {
      setTimeout(async () => {
        try {
          const XLSX = await import('xlsx');
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

          const headerRow = data[headerIndex].map(h => String(h || '').trim());
          const groupRow = headerIndex > 0 ? data[headerIndex - 1].map(h => String(h || '').trim()) : [];
          const progressColumn = findGroupedColumnIndex(
            headerRow,
            groupRow,
            ['Avanço físico (%)', 'Avanco fisico (%)'],
            ['Realizado']
          );
          
          const colIdx = {
            id: findColumnIndex(headerRow, ['ID', 'Identificador']),
            macro: findColumnIndex(headerRow, ['Pacote de trabalho/tarefas', 'Pacote de trabalho', 'Macroatividade'], 2),
            service: findColumnIndex(headerRow, ['Serviço', 'Servico'], 3),
            replicationGroup: findColumnIndex(headerRow, ['Grupo de replicação', 'Grupo de replicacao', 'Grupo Replicacao']),
            floor: findColumnIndex(headerRow, ['Lote', 'Local do serviço', 'Local do servico'], 5),
            duration: findColumnIndex(headerRow, ['Duração', 'Duracao', 'Prazo', 'Dias'], 12),
            start: findColumnIndex(headerRow, ['Data de Início', 'Data de Inicio'], 10),
            end: findColumnIndex(headerRow, ['Data de Término', 'Data de Termino'], 11),
            cost: findColumnIndex(headerRow, ['Custo Vinculado Atual'], 15),
            responsible: findColumnIndex(headerRow, ['Responsáveis', 'Responsaveis', 'Responsável', 'Responsavel'], 14),
            predecessors: findColumnIndex(headerRow, ['Predecessoras', 'Predecessores', 'Predecessora', 'Predecessor']),
            successors: findColumnIndex(headerRow, ['Sucessoras', 'Sucessores', 'Sucessora', 'Sucessor']),
            progress: progressColumn !== -1
              ? progressColumn
              : findGroupedColumnIndex(headerRow, groupRow, ['Última Medição do Projeto (%)', 'Ultima Medicao do Projeto (%)'], ['Realizado'], 27)
          };

          // Two-pass import: 1st pass collects all detail rows (with explicit service names).
          // 2nd pass collects package-only rows (service = '-') using the macro name as the service name.
          // Deduplication is handled by the unique item ID key.
          const seenItemKeys = new Set<string>();
          let parsedItems = [];
          const rawParsedRows = [];
          const importedTeams = new Set<any>([...teamsRef.current]);
          const importedFloors = new Set<any>([...floors]);

          const processRow = (row: any) => {
            if (!row || row.length === 0) return;

            const rawFloor = colIdx.floor !== -1 && row[colIdx.floor] !== undefined ? String(row[colIdx.floor]).trim() : 'Térreo';
            const rawMacro = colIdx.macro !== -1 && row[colIdx.macro] !== undefined ? String(row[colIdx.macro]).trim() : 'ESTRUTURA';
            const rawReplicationGroup = colIdx.replicationGroup !== -1 && row[colIdx.replicationGroup] !== undefined ? String(row[colIdx.replicationGroup]).trim() : '';
            let rawService = colIdx.service !== -1 && row[colIdx.service] !== undefined ? String(row[colIdx.service]).trim() : '';

            const hasExplicitService = rawService && rawService !== '-';
            const isParent = !hasExplicitService;
            if (isParent) rawService = rawMacro;

            if (!rawService) return;

            const rawId = colIdx.id !== -1 && row[colIdx.id] !== undefined ? String(row[colIdx.id]).trim() : '';
            const floorName = String(rawFloor || 'Térreo').trim();
            const itemKey = `xls_${slugify(floorName)}_${slugify(rawMacro)}_${slugify(rawService)}${rawId ? '_' + rawId : ''}`;

            if (seenItemKeys.has(itemKey)) return; // skip duplicates
            seenItemKeys.add(itemKey);

            const rawDuration = colIdx.duration !== -1 && row[colIdx.duration] !== undefined ? parseInt(row[colIdx.duration], 10) : 10;
            const rawStart = parseExcelDate(colIdx.start !== -1 && row[colIdx.start] !== undefined ? row[colIdx.start] : undefined);
            const rawEnd = parseExcelDate(colIdx.end !== -1 && row[colIdx.end] !== undefined ? row[colIdx.end] : undefined, rawStart);
            const rawCost = colIdx.cost !== -1 && row[colIdx.cost] !== undefined ? parseFloat(String(row[colIdx.cost]).replace(/[^\d.-]/g, '')) : 0;
            const rawResp = colIdx.responsible !== -1 && row[colIdx.responsible] !== undefined && row[colIdx.responsible] !== null ? String(row[colIdx.responsible]).trim().toUpperCase() : 'EQUIPE GERAL';
            const rawPredecessors = colIdx.predecessors !== -1 && row[colIdx.predecessors] !== undefined ? parseDependencyList(row[colIdx.predecessors]) : [];
            const rawSuccessors = colIdx.successors !== -1 && row[colIdx.successors] !== undefined ? parseDependencyList(row[colIdx.successors]) : [];
            let rawProgress = 0;
            if (colIdx.progress !== -1 && row[colIdx.progress] !== undefined) {
              rawProgress = parsePercent(row[colIdx.progress]);
            }

            if (rawResp && rawResp !== 'UNDEFINED' && rawResp !== '' && rawResp !== '-') importedTeams.add(rawResp);
            importedFloors.add(floorName);

            rawParsedRows.push({
              id: itemKey,
              originalId: rawId,
              macro: String(rawMacro || 'ESTRUTURA').trim().toUpperCase(),
              replicationGroup: String(rawReplicationGroup || 'Não agrupado').trim().toUpperCase(),
              floor: floorName,
              service: rawService.toUpperCase(),
              isParent,
              duration: isNaN(rawDuration) ? 5 : rawDuration,
              start: rawStart,
              end: rawEnd,
              cost: isNaN(rawCost) ? 0 : rawCost,
              responsible: rawResp || 'EQUIPE GERAL',
              progress: clampPercent(rawProgress),
              predecessors: rawPredecessors,
              successors: rawSuccessors
            });
          };

          for (let i = headerIndex + 1; i < data.length; i++) processRow(data[i]);

          const parentDependenciesByKey = new Map<string, any>();
          rawParsedRows.forEach(item => {
            if (!item.isParent) return;
            const hasDependencies = (item.predecessors || []).length > 0 || (item.successors || []).length > 0;
            if (!hasDependencies) return;
            parentDependenciesByKey.set(`${item.floor}||${slugify(item.macro)}`, {
              id: item.id,
              predecessors: item.predecessors || [],
              successors: item.successors || []
            });
          });

          parsedItems = rawParsedRows.map((item) => {
            if (item.isParent) return item;
            const parentDependencies = parentDependenciesByKey.get(`${item.floor}||${slugify(item.macro)}`);
            if (!parentDependencies) return item;
            const hasOwnPredecessors = (item.predecessors || []).length > 0;
            const hasOwnSuccessors = (item.successors || []).length > 0;
            if (hasOwnPredecessors && hasOwnSuccessors) return item;
            return {
              ...item,
              predecessors: hasOwnPredecessors ? item.predecessors : parentDependencies.predecessors,
              successors: hasOwnSuccessors ? item.successors : parentDependencies.successors,
              inheritedDependenciesFrom: parentDependencies.id
            };
          });

          if (parsedItems.length === 0) {
            setNotification({ message: "Não foi possível extrair nenhum serviço.", type: "error" });
            setIsImporting(false);
            setImportStatus('');
            return;
          }
          
          if (parsedItems.length > 6000) {
            setNotification({ message: `Limite de segurança: Importados apenas os primeiros 6000 serviços.`, type: "error" });
            parsedItems = parsedItems.slice(0, 6000);
          }

          const importedBudgetDiffs = buildBudgetDiffs(cronogramaInicial, parsedItems, file.name);
          const updatedBudgetDiffs = [...budgetDiffsRef.current, ...importedBudgetDiffs].slice(-1200);
          const importedAt = new Date().toISOString();
          const updatedBudgetImportVersions = [
            ...budgetImportVersionsRef.current,
            {
              id: `budget_import_${Date.now()}`,
              fileName: file.name,
              importedAt,
              activityCount: parsedItems.length,
              diffCount: importedBudgetDiffs.length
            }
          ].slice(-2);

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
            const existingItemIndex = updatedFloorsData[item.floor][macroKey].items.findIndex(it => it && it.id === item.id);

            if (existingItemIndex !== -1) {
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].id = item.id;
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].actualPercent = item.progress;
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].predecessors = item.predecessors || [];
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].successors = item.successors || [];
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].inheritedDependenciesFrom = item.inheritedDependenciesFrom || '';
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].originalId = item.originalId || '';
              updatedFloorsData[item.floor][macroKey].items[existingItemIndex].replicationGroup = item.replicationGroup || '';
            } else {
              updatedFloorsData[item.floor][macroKey].items.push({
                id: item.id,
                name: item.service,
                actualPercent: item.progress,
                predecessors: item.predecessors || [],
                successors: item.successors || [],
                inheritedDependenciesFrom: item.inheritedDependenciesFrom || '',
                originalId: item.originalId || '',
                replicationGroup: item.replicationGroup || ''
              });
            }

          });

          const existingMatrices = matrices.length > 0 ? matrices : [{ id: 'default_matrix', name: 'Matriz Principal', floors: [], macros: [] }];
          const updatedMatrices = existingMatrices.map(m => ({
            ...m,
            floors: Array.from(new Set([...(m.floors || []), ...updatedFloorsList])),
            macros: Array.from(new Set([...(m.macros || []), ...Array.from(importedMacroKeys)]))
          }));

          const { recalculatedPlanning, updatedFloorsData: syncedFloors } = syncPlanningAndPhysical(planning, updatedFloorsData, parsedItems);


          setImportStatus('Gravando dados no Firebase (Aguarde)...');

          saveToDB(
            updatedFloorsList,
            syncedFloors,
            history,
            updatedWeights,
            recalculatedPlanning,
            parsedItems,
            updatedTeams,
            delayReasonsRef.current,
            ppcHistory,
            updatedMatrices,
            teamPhones,
            undefined,
            projectCity,
            weatherApiKey,
            weatherCache,
            true,
            updatedBudgetDiffs,
            updatedBudgetImportVersions
          )
            .then(() => {
              setBudgetDiffs(updatedBudgetDiffs);
              setBudgetImportVersions(updatedBudgetImportVersions);
              setNotification({ message: `${parsedItems.length} atividades importadas. ${importedBudgetDiffs.length} diferenças registradas para o curto prazo.`, type: "success" });
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
    const updatedMats = matrices.map(m => ({
      ...m,
      floors: !(m.floors || []).includes(floor) ? [...(m.floors || []), floor] : m.floors
    }));
    setMatrices(updatedMats);
    await saveToDB(updatedFloors, updatedData, history, updatedWeights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updatedMats);
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
    const updatedMats = matrices.map(m => ({
      ...m,
      macros: !(m.macros || []).includes(id) ? [...(m.macros || []), id] : m.macros
    }));
    setMatrices(updatedMats);
    await saveToDB(floors, updatedData, history, updatedWeights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updatedMats);
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
    if (teams.includes(upper)) { setNotification({ message: 'Equipe já existente.', type: 'error' }); return; }
    const updatedTeams = [...teams, upper];
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, updatedTeams, delayReasons, ppcHistory, matrices);
    setNewTeamName(''); setNotification({ message: 'Equipe adicionada!', type: 'success' });
  };

  const handleDeleteTeam = async (teamToDelete) => {
    const updatedTeams = teams.filter(t => t !== teamToDelete);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, updatedTeams, delayReasons, ppcHistory, matrices);
    setNotification({ message: 'Equipe removida.', type: 'success' });
  };

  const handleAcceptPreFill = async (taskId: string) => {
    const updatedPlanning = planning.map(t => {
      if (t.id === taskId) {
        return {
          ...t,
          progressThisWeek: t.preFilledProgress !== undefined ? t.preFilledProgress : t.progressThisWeek,
          delayReason: t.preFilledDelayReason !== undefined ? t.preFilledDelayReason : t.delayReason,
          observations: t.preFilledObservations !== undefined ? t.preFilledObservations : t.observations,
          lastUpdatedBy: t.responsible ? `Equipe: ${t.responsible}` : 'Equipe',
          preFilledProgress: undefined,
          preFilledDelayReason: undefined,
          preFilledObservations: undefined,
          preFilledAt: undefined
        };
      }
      return t;
    });

    setPlanning(updatedPlanning);
    await saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
    setNotification({ message: 'Apontamento de campo aceito com sucesso!', type: 'success' });
  };

  const handlePrintPlanning = () => {
    const weekEndDate = new Date(currentWeekStart.getTime() + 4 * 86400000);
    const dateRange = `${currentWeekStart.toLocaleDateString('pt-BR')} a ${weekEndDate.toLocaleDateString('pt-BR')}`;
    const tasksToPrint = filteredWeeklyTasks.length > 0 ? filteredWeeklyTasks : weeklyTasks;
    const projectName = projects.find(p => p.id === selectedProjectId)?.name || 'Planejamento Semanal';

    const rows = tasksToPrint.map(t => ({
      activityName: t.activityName || '',
      serviceComplement: t.serviceComplement || '',
      floor: t.floor || '',
      responsible: t.responsible || '',
      efetivo: t.efetivo ?? '',
      executedBefore: t.executedBefore ?? 0,
      plannedThisWeek: t.plannedThisWeek ?? 100,
      progressThisWeek: t.progressThisWeek ?? 0,
      dailyWork: Array.isArray(t.dailyWork) ? t.dailyWork : [0,0,0,0,0],
      delayReason: t.delayReason || '',
      observations: t.observations || '',
      finalized: !!t.finalized,
      isManual: !!t.isManual,
    }));

    const dayLabels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'];
    const dayDates = [0,1,2,3,4].map(i => {
      const d = new Date(currentWeekStart.getTime() + i * 86400000);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    });

    const dayWeathers = [0,1,2,3,4].map(i => {
      const dayDate = new Date(currentWeekStart.getTime() + i * 86400000);
      const dayStr = toISODate(dayDate);
      
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const diffTime = dayDate.getTime() - todayStart.getTime();
      const diffDays = Math.round(diffTime / 86400000);
      const isWithinRange = diffDays >= -15 && diffDays <= 15;

      const cacheKey = `${projectCity.trim().toLowerCase()}_${dayStr}`;
      const weather = isWithinRange ? weatherCache[cacheKey] : null;
      return isWithinRange && weather ? getWeatherEmoji(weather.icon) : '';
    });

    const rowsJson = JSON.stringify(rows);
    const dayLabelsJson = JSON.stringify(dayLabels);
    const dayDatesJson = JSON.stringify(dayDates);
    const totalCount = tasksToPrint.length;
    const genTime = new Date().toLocaleString('pt-BR');

    const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Impressao - Planejamento Semanal</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#1e293b;background:#f8fafc}
  @media print{
    body{background:#fff;font-size:9px}
    .no-print{display:none!important}
    .print-page{padding:8px 10px}
    table{font-size:8.5px}
    thead th{background:#1e293b!important;color:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    tr.finalized td{background:#f1f5f9!important;color:#94a3b8!important}
    tr.delayed td{background:#fff1f2!important}
    tr.ok td{background:#f0fdf4!important}
    .badge{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .day-chip.worked{background:#1e293b!important;color:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
  .print-page{max-width:1400px;margin:0 auto;padding:16px}
  .toolbar{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin-bottom:12px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
  .toolbar-title{font-size:12px;font-weight:900;color:#1e293b;flex:1 0 100%;margin-bottom:4px}
  .col-toggles{display:flex;flex-wrap:wrap;gap:6px;flex:1}
  .col-toggle{display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;font-size:10.5px;font-weight:700;color:#475569;padding:3px 9px;border-radius:6px;border:1.5px solid #e2e8f0;background:#f8fafc;transition:all .15s}
  .col-toggle input{accent-color:#4f46e5}
  .col-toggle:has(input:checked){background:#eef2ff;border-color:#a5b4fc;color:#3730a3}
  .toolbar-actions{display:flex;gap:8px;margin-left:auto;flex-shrink:0}
  .btn-print{padding:8px 20px;background:#1e293b;color:#fff;border:none;border-radius:8px;font-size:11px;font-weight:900;cursor:pointer;transition:background .15s}
  .btn-print:hover{background:#334155}
  .page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #1e293b}
  .page-header .title h1{font-size:14px;font-weight:900;color:#1e293b;text-transform:uppercase;letter-spacing:.05em}
  .page-header .title p{font-size:10px;color:#64748b;margin-top:2px;font-weight:600}
  .page-header .meta{text-align:right;font-size:9px;color:#64748b;font-weight:700}
  table{width:100%;border-collapse:collapse;border:1px solid #cbd5e1;background:#fff}
  thead th{background:#1e293b;color:#fff;padding:6px 8px;text-align:left;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;white-space:normal;vertical-align:bottom;border-right:1px solid #334155;cursor:pointer;user-select:none;transition:background .1s}
  thead th:hover{background:#334155}
  thead th.sorted{background:#312e81}
  thead th .si{margin-left:3px;font-size:9px;opacity:.8}
  thead th:last-child{border-right:none}
  tbody tr{border-bottom:1px solid #e2e8f0}
  tbody tr:last-child{border-bottom:none}
  tbody tr:nth-child(even) td{background:#fafafa}
  tbody tr.finalized td{background:#f8fafc!important;color:#94a3b8}
  tbody tr.delayed td{background:#fff7f7!important}
  tbody tr.ok td{background:#f0fdf4!important}
  td{padding:5px 8px;vertical-align:middle;border-right:1px solid #e2e8f0;font-size:10px}
  td:last-child{border-right:none}
  .act-name{font-weight:800;text-transform:uppercase;font-size:10px;line-height:1.3}
  .act-comp{font-size:8px;color:#64748b;margin-top:1px}
  .floor-cell{font-size:9px;font-weight:800;color:#4f46e5;text-transform:uppercase;white-space:normal;word-break:break-word}
  .badge{display:inline-block;padding:2px 6px;border-radius:999px;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
  .badge-green{background:#dcfce7;color:#15803d}
  .badge-red{background:#fee2e2;color:#b91c1c}
  .badge-blue{background:#dbeafe;color:#1d4ed8}
  .badge-gray{background:#f1f5f9;color:#475569}
  .badge-amber{background:#fef3c7;color:#b45309}
  .days-cell{display:flex;gap:3px;justify-content:center;flex-wrap:nowrap}
  .day-chip{display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:9px;font-weight:900;padding:3px 4px;border-radius:4px;min-width:36px;height:36px}
  .day-chip span:first-child{font-size:9px;font-weight:900}
  .day-chip span:last-child{font-size:7px;font-weight:700;margin-top:1px}
  .day-chip.worked{background:#1e293b;color:#fff}
  .day-chip.off{background:#f1f5f9;color:#94a3b8}
  .empty-row td{text-align:center;color:#94a3b8;font-style:italic;padding:20px}
  
  /* Configuração de Larguras e Quebras de Título para Colunas de Impressão */
  .cn, .cb, .cp, .cpr, .cst, .ce {
    width: 1%;
  }
  tbody td.cn, tbody td.cb, tbody td.cp, tbody td.cpr, tbody td.cst, tbody td.ce {
    white-space: nowrap;
  }
  .cs {
    min-width: 200px;
    white-space: normal !important;
    word-break: break-word !important;
  }
  .cf {
    width: 140px;
    white-space: normal !important;
    word-break: break-word !important;
  }
  .ct {
    width: 100px;
    white-space: normal !important;
    word-break: break-word !important;
  }
  .cd {
    width: 220px;
  }
  .cdr {
    width: 150px;
    white-space: normal !important;
    word-break: break-word !important;
  }
  .co {
    width: 150px;
    white-space: normal !important;
    word-break: break-word !important;
  }
  .days-cell {
    flex-wrap: nowrap !important;
  }
</style>
</head>
<body>
<div class="print-page">
  <div class="toolbar no-print">
    <div class="toolbar-title">Configurar Impressao - Selecione as colunas a exibir:</div>
    <div class="col-toggles">
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cn',this.checked)"> #</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cs',this.checked)"> Servico</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cf',this.checked)"> Pavimento</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('ct',this.checked)"> Equipe</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('ce',this.checked)"> Efetivo</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cb',this.checked)"> % Anterior</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cp',this.checked)"> Meta Planejada</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cd',this.checked)"> Dias Trabalhados</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cpr',this.checked)"> Progresso</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cdr',this.checked)"> Motivo de Atraso</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('co',this.checked)"> Observações</label>
      <label class="col-toggle"><input type="checkbox" checked onchange="toggleCol('cst',this.checked)"> Status</label>
    </div>
    <div style="display:flex;align-items:center;gap:6px;background:#f8fafc;padding:3px 9px;border-radius:6px;border:1.5px solid #e2e8f0;margin-top:4px;">
      <span style="font-size:10px;font-weight:900;color:#475569;text-transform:uppercase;letter-spacing:0.05em">Filtrar Equipe:</span>
      <input type="text" id="teamFilter" placeholder="Buscar equipe..." oninput="onFilterChange()" style="padding:2px 6px;border:1px solid #cbd5e1;border-radius:4px;font-size:10.5px;color:#1e293b;width:180px;font-family:inherit;outline:none;" />
    </div>
    <div class="toolbar-actions">
      <button class="btn-print" onclick="window.print()">Imprimir / Salvar PDF</button>
    </div>
  </div>
  <div class="page-header">
    <div class="title">
      <h1>${projectName}</h1>
      <p>Planejamento Semanal &middot; ${dateRange} &middot; <span id="activity-count">${totalCount}</span> atividade(s)</p>
    </div>
    <div class="meta"><div>Gerado em: ${genTime}</div></div>
  </div>
  <table id="pt">
    <thead>
      <tr>
        <th class="cn" onclick="st('num')">#<span class="si" id="si-num"></span></th>
        <th class="cs" onclick="st('activityName')">Servico<span class="si" id="si-activityName"></span></th>
        <th class="cf" onclick="st('floor')">Pavimento<span class="si" id="si-floor"></span></th>
        <th class="ct" onclick="st('responsible')">Equipe<span class="si" id="si-responsible"></span></th>
        <th class="ce" onclick="st('efetivo')" style="text-align:center">Efetivo<span class="si" id="si-efetivo"></span></th>
        <th class="cb" onclick="st('executedBefore')" style="text-align:center">% Anterior<span class="si" id="si-executedBefore"></span></th>
        <th class="cp" onclick="st('plannedThisWeek')" style="text-align:center">Meta Planejada<span class="si" id="si-plannedThisWeek"></span></th>
        <th class="cd" style="padding: 4px 6px">
          <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
            <span style="font-size:7px;font-weight:900;text-transform:uppercase;color:#94a3b8;letter-spacing:0.05em">Dias Trab.</span>
            <div style="display:flex;gap:3px;justify-content:center">
              ${[0,1,2,3,4].map(i => `
                <div class="day-hdr" style="display:flex;flex-direction:column;align-items:center;min-width:36px;font-size:8px;font-weight:900;line-height:1">
                  <span style="font-size:10px;margin-bottom:1px;height:10px;display:flex;align-items:center;justify-content:center">${dayWeathers[i] || '&nbsp;'}</span>
                  <span style="color:#fff">${dayLabels[i].charAt(0)}</span>
                  <span style="color:#94a3b8;font-size:6.5px;font-weight:700;margin-top:1.5px">${dayDates[i]}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </th>
        <th class="cpr" onclick="st('progressThisWeek')" style="text-align:center">Progresso<span class="si" id="si-progressThisWeek"></span></th>
        <th class="cdr" onclick="st('delayReason')">Motivo de Atraso<span class="si" id="si-delayReason"></span></th>
        <th class="co">Observações</th>
        <th class="cst" onclick="st('status')" style="text-align:center">Status<span class="si" id="si-status"></span></th>
      </tr>
    </thead>
    <tbody id="pb"></tbody>
  </table>
  <div class="no-print" style="margin-top:8px;color:#94a3b8;font-size:10px;font-style:italic">Clique no cabecalho de qualquer coluna para ordenar.</div>
</div>
<script>
var allRows=${rowsJson};
var DL=${dayLabelsJson};
var DD=${dayDatesJson};
var sk=null,sd='asc';
var hiddenCols={};
var filterText='';
function gso(t){if(t.finalized)return 3;var p=t.progressThisWeek,pl=t.plannedThisWeek;if(p>=pl&&pl>0)return 0;if(p<pl&&pl>0&&p>0)return 1;return 2;}
function sv(t,k){if(k==='status')return gso(t);var v=t[k];return typeof v==='number'?v:(v||'').toString().toLowerCase();}
function st(k){if(sk===k){sd=sd==='asc'?'desc':'asc';}else{sk=k;sd='asc';}
  document.querySelectorAll('.si').forEach(function(e){e.textContent='';});
  document.querySelectorAll('thead th').forEach(function(e){e.classList.remove('sorted');});
  var el=document.getElementById('si-'+k);
  if(el){el.textContent=sd==='asc'?' \u25b2':' \u25bc';el.closest('th').classList.add('sorted');}
  rt();}
function onFilterChange(){
  filterText=document.getElementById('teamFilter').value.toLowerCase().trim();
  rt();
}
function rt(){var sorted=allRows.slice();
  if(filterText){
    sorted=sorted.filter(function(t){
      return (t.responsible||'').toLowerCase().indexOf(filterText)!==-1;
    });
  }
  if(sk){sorted.sort(function(a,b){var va=sv(a,sk),vb=sv(b,sk);if(va<vb)return sd==='asc'?-1:1;if(va>vb)return sd==='asc'?1:-1;return 0;});}
  var cntEl=document.getElementById('activity-count');
  if(cntEl){cntEl.textContent=sorted.length;}
  var tb=document.getElementById('pb');
  if(!sorted.length){tb.innerHTML='<tr class="empty-row"><td colspan="12">Nenhuma atividade encontrada com o filtro aplicado.</td></tr>';return;}
  tb.innerHTML=sorted.map(function(t,i){
    var prog=t.progressThisWeek,planned=t.plannedThisWeek;
    var isOk=prog>=planned&&planned>0,isDel=prog<planned&&planned>0;
    var rc=t.finalized?'finalized':isOk?'ok':isDel?'delayed':'';
    var pb2=prog===0?'<span class="badge badge-gray">0%</span>':isOk?'<span class="badge badge-green">'+prog+'%</span>':'<span class="badge badge-red">'+prog+'%</span>';
    var plb='<span class="badge badge-blue">'+planned+'%</span>';
    var bb=t.executedBefore>0?'<span class="badge badge-gray">'+t.executedBefore+'%</span>':'<span style="color:#94a3b8">-</span>';
    var dh='<div class="days-cell">'+t.dailyWork.map(function(w,idx){return'<div class="day-chip '+(w?'worked':'off')+'" title="'+DL[idx]+' '+DD[idx]+'"><span>'+DL[idx].charAt(0)+'</span><span>'+DD[idx]+'</span></div>';}).join('')+'</div>';
    var sb=t.finalized?'<span class="badge badge-gray">Finalizado</span>':isOk?'<span class="badge badge-green">Conforme</span>':isDel?'<span class="badge badge-red">Atrasado</span>':'<span class="badge badge-gray">Pendente</span>';
    var comp=t.serviceComplement?'<div class="act-comp">'+t.serviceComplement+'</div>':'';
    var mb=t.isManual?' <span class="badge badge-amber">Extra</span>':'';
    return '<tr class="'+rc+'">'+
      '<td class="cn" style="color:#94a3b8;font-weight:900;font-size:9px;text-align:center">'+(i+1)+'</td>'+
      '<td class="cs"><div class="act-name">'+t.activityName+mb+'</div>'+comp+'</td>'+
      '<td class="cf"><span class="floor-cell">'+(t.floor||'-')+'</span></td>'+
      '<td class="ct" style="font-weight:700;white-space:nowrap">'+(t.responsible||'-')+'</td>'+
      '<td class="ce" style="text-align:center;font-weight:700">'+(t.efetivo !== undefined && t.efetivo !== null && t.efetivo !== '' ? t.efetivo : '-')+'</td>'+
      '<td class="cb" style="text-align:center">'+bb+'</td>'+
      '<td class="cp" style="text-align:center">'+plb+'</td>'+
      '<td class="cd">'+dh+'</td>'+
      '<td class="cpr" style="text-align:center">'+pb2+'</td>'+
      '<td class="cdr" style="font-size:9px;color:#b91c1c">'+(t.delayReason||'<span style="color:#94a3b8">-</span>')+'</td>'+
      '<td class="co" style="font-size:9px;color:#475569">'+(t.observations||'<span style="color:#94a3b8">-</span>')+'</td>'+
      '<td class="cst" style="text-align:center">'+sb+'</td>'+
    '</tr>';}).join('');
  Object.keys(hiddenCols).forEach(function(c){
    if(hiddenCols[c]){
      document.querySelectorAll('tbody .'+c).forEach(function(e){e.style.display='none';});
    }
  });
}
function toggleCol(c,v){
  hiddenCols[c]=!v;
  document.querySelectorAll('.'+c).forEach(function(e){e.style.display=v?'':'none';});
}
rt();
</script>
</body>
</html>`;

    const newTab = window.open('', '_blank');
    if (newTab) {
      newTab.document.write(htmlContent);
      newTab.document.close();
    }
  };
  const getWhatsappAvailableTeams = () => {
    const weekId = toLocalDateString(currentWeekStart);
    const weekTeamNames = new Set(
      planning
        .filter(t => t.weekId === weekId && t.responsible)
        .map(t => String(t.responsible).trim())
        .filter(Boolean)
    );

    return teams.filter(team => weekTeamNames.has(String(team).trim()));
  };

  const openWhatsappShareModal = () => {
    const availableTeams = getWhatsappAvailableTeams();
    if (availableTeams.length === 0) {
      setNotification({ message: 'Nenhum empreiteiro com atividades planejadas nesta semana.', type: 'warning' });
      return;
    }
    const initialTeam = availableTeams[0];
    const text = generateWhatsappMessage(initialTeam);
    setWhatsappModal({ isOpen: true, teamName: initialTeam, text });
  };

  const generateWhatsappMessage = (teamName: string): string => {
    const weekId = toLocalDateString(currentWeekStart);
    const weekEndDate = new Date(currentWeekStart.getTime() + 4 * 86400000);
    const dateRange = `${currentWeekStart.toLocaleDateString('pt-BR')} a ${weekEndDate.toLocaleDateString('pt-BR')}`;
    
    const teamTasks = planning.filter(t => t.weekId === weekId && t.responsible === teamName && !t.finalized);
    
    const taskLines = teamTasks.length === 0
      ? 'Sem serviços planejados para esta semana.'
      : teamTasks.map(t => {
          return `- ${getSimpleServiceInstruction(t)}.`;
        }).join('\n');

    const appUrl = `${window.location.origin}/?mode=team&u=${selectedProjectId || urlUserId || 'projeto_principal'}&t=${encodeURIComponent(teamName)}&w=${weekId}`;

    return `Oi, equipe ${teamName}!\n\nServiços da semana (${dateRange}):\n${taskLines}\n\nApontamento de campo: ${appUrl}`;
  };

  const handleSendWhatsapp = () => {
    const phone = teamPhones[whatsappModal.teamName] || '';
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    const url = `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(whatsappModal.text)}`;
    window.open(url, '_blank');
    setWhatsappModal(prev => ({ ...prev, isOpen: false }));
  };

  const handleAddDelayReason = async () => {
    if (!newDelayReason.trim()) return;
    const text = newDelayReason.trim();
    if (delayReasons.includes(text)) return;
    const updatedDelays = [...delayReasons, text];
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, updatedDelays, ppcHistory, matrices);
    setNewDelayReason(''); setNotification({ message: 'Motivo registrado!', type: 'success' });
  };

  const handleDeleteDelayReason = async (reasonToDelete) => {
    const updatedDelays = delayReasons.filter(r => r !== reasonToDelete);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, updatedDelays, ppcHistory, matrices);
    setNotification({ message: 'Motivo removido.', type: 'success' });
  };

  const handleCreateMatrix = async (replicationGroup = '') => {
    const groupItems = replicationGroup
      ? cronogramaInicial.filter(item => String(item?.replicationGroup || '').trim() === replicationGroup)
      : cronogramaInicial;
    const groupFloors = Array.from(new Set(groupItems.map(item => item.floor).filter(Boolean)));
    const groupMacros = Array.from(new Set(groupItems.map(item => slugify(item.macro)).filter(Boolean)));

    if (replicationGroup && (groupFloors.length === 0 || groupMacros.length === 0)) {
      setNotification({ message: 'Nenhum pavimento ou macroatividade encontrado para este grupo.', type: 'error' });
      return;
    }

    const newMatrix = {
      id: crypto.randomUUID(),
      name: replicationGroup ? `Matriz ${replicationGroup}` : `Nova Matriz ${matrices.length + 1}`,
      replicationGroup,
      floors: replicationGroup ? groupFloors : [...floors],
      macros: replicationGroup ? groupMacros : [...allPossibleMacros]
    };
    const updated = [...matrices, newMatrix];
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
    setMatrixGroupModalOpen(false);
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
    // Mantém a janela de seleção aberta para permitir adições contínuas
  };

  const handleDragColStart = (e, matrixId, idx) => {
    setDraggedColIdx(idx);
    setDraggedColMatrixId(matrixId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragColOver = (e) => {
    e.preventDefault();
  };

  const handleDropCol = async (e, matrixId, targetIdx) => {
    e.preventDefault();
    if (draggedColIdx === null || draggedColMatrixId !== matrixId || draggedColIdx === targetIdx) return;
    
    const updated = matrices.map(m => {
      if (m.id === matrixId) {
        const newMacros = [...(m.macros || [])];
        const [movedCol] = newMacros.splice(draggedColIdx, 1);
        newMacros.splice(targetIdx, 0, movedCol);
        return { ...m, macros: newMacros };
      }
      return m;
    });
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
    setDraggedColIdx(null);
    setDraggedColMatrixId(null);
  };

  const handleDragRowStart = (e, matrixId, idx) => {
    setDraggedRowIdx(idx);
    setDraggedRowMatrixId(matrixId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragRowOver = (e) => {
    e.preventDefault();
  };

  const handleDropRow = async (e, matrixId, targetIdx) => {
    e.preventDefault();
    if (draggedRowIdx === null || draggedRowMatrixId !== matrixId || draggedRowIdx === targetIdx) return;
    
    const updated = matrices.map(m => {
      if (m.id === matrixId) {
        const newFloors = [...(m.floors || [])];
        const [movedRow] = newFloors.splice(draggedRowIdx, 1);
        newFloors.splice(targetIdx, 0, movedRow);
        return { ...m, floors: newFloors };
      }
      return m;
    });
    setMatrices(updated);
    await saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, updated);
    setDraggedRowIdx(null);
    setDraggedRowMatrixId(null);
  };

  const handleExportCSV = () => {
    const headers = ['Semana ID', 'Pavimento', 'Macroatividade', 'Serviço', 'Responsável', 'Meta Planeada (%)', 'Dias Ativos', 'Progresso Semana (%)', 'Progresso Acumulado (%)', 'Motivo Atraso', 'Observações', 'Status'];
    const rows = filteredGiantPlanningTasks.map(t => [
      t?.weekId || '', t?.floor || '', (t?.sectionId || '').toUpperCase(), t?.activityName || '', t?.responsible || '',
      `${t?.plannedThisWeek ?? 100}%`,
      (t?.dailyWork || [0,0,0,0,0]).map((dw, i) => dw ? ['Seg', 'Ter', 'Qua', 'Qui', 'Sex'][i] : '').filter(Boolean).join('/'),
      `${t?.progressThisWeek ?? 0}%`, `${Math.min(100, Number(t?.executedBefore || 0) + Number(t?.progressThisWeek || 0))}%`,
      t?.delayReason || 'N/A', t?.observations || '', t?.finalized ? 'Finalizado' : 'Ativo'
    ]);
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; 
    csvContent += [headers.join(';'), ...rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(';'))].join('\n');
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `Tabela_Consolidada_Planejamento_Semanal_${getTodayDateString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const triggerConfirm = (title, message, onConfirm) => setConfirmModal({ isOpen: true, title, message, onConfirm });

  // --- Análise por IA ---
  const handleAIAnalysis = async () => {
    const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      setAiAnalysis('⚠️ **Chave de API não configurada.**\n\nPara usar a análise por IA, adicione no arquivo `.env.local`:\n```\nVITE_GEMINI_API_KEY=sua_chave_aqui\n```\nObtenha sua chave gratuita em **aistudio.google.com** → "Get API key".');
      return;
    }

    const weekId = toLocalDateString(currentWeekStart);
    const weekTasks = planning.filter(t => t.weekId === weekId);
    const isFinalized = weekTasks.some(t => t.finalized);
    const ppcRecord = ppcHistory.find(h => h.weekId === weekId);

    if (weekTasks.length === 0) {
      setAiAnalysis('ℹ️ Nenhuma atividade encontrada para a semana selecionada. Navegue para uma semana com atividades registradas.');
      return;
    }

    setAiLoading(true);
    setAiAnalysis('');
    setAiAnalyzedWeekId(weekId);

    // Build context data
    const weekEndDate = new Date(currentWeekStart.getTime() + 4 * 86400000);
    const dateRange = `${currentWeekStart.toLocaleDateString('pt-BR')} a ${weekEndDate.toLocaleDateString('pt-BR')}`;
    const ppcVal = ppcRecord ? ppcRecord.ppc.toFixed(1) : currentWeekPpcStats.percent.toFixed(1);
    const totalPlanned = ppcRecord ? ppcRecord.totalPlanned : currentWeekPpcStats.totalPlannedCount;
    const totalCompleted = ppcRecord ? ppcRecord.completed : currentWeekPpcStats.completedCount;

    const tasksWithDelay = weekTasks.filter(t => (t.plannedThisWeek ?? 100) > (t.progressThisWeek ?? 0) && !t.finalized || t.delayReason);
    const tasksOk = weekTasks.filter(t => (t.progressThisWeek ?? 0) >= (t.plannedThisWeek ?? 100));
    const tasksWithObs = weekTasks.filter(t => t.observations && t.observations.trim());

    const delaySummary = tasksWithDelay
      .map(t => `- ${t.activityName} (${t.floor}): meta ${t.plannedThisWeek ?? 100}%, realizado ${t.progressThisWeek ?? 0}%${t.delayReason ? ` — Motivo: ${t.delayReason}` : ''}`)
      .slice(0, 15).join('\n');

    const okSummary = tasksOk
      .map(t => `- ${t.activityName} (${t.floor}): ${t.progressThisWeek ?? 0}%`)
      .slice(0, 15).join('\n');

    const obsSummary = tasksWithObs
      .map(t => `- ${t.activityName} (${t.floor}): "${t.observations}"`)
      .slice(0, 10).join('\n');

    const delayCounts: Record<string, number> = {};
    weekTasks.forEach(t => { if (t.delayReason) delayCounts[t.delayReason] = (delayCounts[t.delayReason] || 0) + 1; });
    const topDelays = Object.entries(delayCounts).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} (${c}x)`).join(', ');

    const prompt = `Você é um consultor sênior de gestão de obras e projetos de construção civil. Analise os dados da semana de obra abaixo e gere um relatório gerencial completo em português do Brasil.

**DADOS DA SEMANA: ${dateRange}**
- Status: ${isFinalized ? 'SEMANA FINALIZADA' : 'SEMANA EM ANDAMENTO'}
- PPC (Percentual de Planos Concluídos): ${ppcVal}%
- Atividades planejadas: ${totalPlanned}
- Atividades concluídas conforme meta: ${totalCompleted}

**ATIVIDADES COM DESVIO OU ATRASO (${tasksWithDelay.length} itens):**
${delaySummary || 'Nenhum desvio registrado.'}

**ATIVIDADES CONCLUÍDAS NO PRAZO (${tasksOk.length} itens):**
${okSummary || 'Nenhuma atividade concluída.'}

**PRINCIPAIS CAUSAS DE ATRASO:**
${topDelays || 'Nenhuma causa registrada.'}

**OBSERVAÇÕES DE CAMPO:**
${obsSummary || 'Nenhuma observação registrada.'}

Gere um relatório com as seguintes seções:

## Resumo Executivo
(2-3 frases sobre o desempenho geral da semana)

## Pontos Positivos
(lista com o que foi bem executado)

## Problemas e Riscos Identificados
(análise dos desvios, causas prováveis e impactos)

## Observações de Campo
(análise das observações registradas, se houver)

## Recomendações para a Próxima Semana
(ações concretas e priorizadas)

Seja objetivo, técnico e use linguagem adequada para um gestor de obras. Máximo de 500 palavras.`;

    let text = '';
    let lastError: any = null;
    const modelsToTry = [
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash-lite',
      'gemini-3.5-flash',
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-flash-latest'
    ];

    try {
      for (const model of modelsToTry) {
        try {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
              })
            }
          );
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err?.error?.message || `Erro HTTP ${response.status}`);
          }
          const data = await response.json();
          text = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Nenhuma resposta recebida.';
          if (text) {
            lastError = null;
            break;
          }
        } catch (e: any) {
          lastError = e;
          console.warn(`Falha ao chamar o modelo ${model}:`, e.message);
        }
      }

      if (lastError) {
        throw lastError;
      }

      setAiAnalysis(text);
      if (isFinalized && db && (urlUserId || userId)) {
        const targetId = urlUserId ? urlUserId : 'projeto_principal';
        const newCache = { ...aiAnalysesHistory, [weekId]: text };
        setAiAnalysesHistory(newCache);
        const docRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, targetId);
        updateDoc(docRef, { aiAnalyses: compressStringUnicode(JSON.stringify(newCache)) }).catch(console.error);
      }
    } catch (e: any) {
      setAiAnalysis(`❌ **Erro ao chamar a API:** ${e.message}\n\nVerifique sua chave de API em \`VITE_GEMINI_API_KEY\` no arquivo \`.env.local\`.`);
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    const weekId = toLocalDateString(currentWeekStart);
    if (aiAnalyzedWeekId === weekId) return;

    const hasTasks = planning.some(t => t.weekId === weekId);
    
    if (aiAnalysesHistory[weekId]) {
      setAiAnalysis(aiAnalysesHistory[weekId]);
      setAiAnalyzedWeekId(weekId);
      setAiLoading(false);
    } else if (hasTasks && !aiLoading) {
      handleAIAnalysis();
    } else if (!hasTasks) {
      setAiAnalysis('');
      setAiAnalyzedWeekId(weekId);
    }
  }, [currentWeekStart, planning, aiAnalysesHistory, aiLoading, aiAnalyzedWeekId]);

  // --- Secções de Renderização Isoladas (Para evitar falhas do compilador) ---
  
  const renderDashboard = () => {
    const MONTHS_PT = [
      'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
    ];
    const analysisMonth = MONTHS_PT[currentWeekStart.getMonth()];

    const overallActual = (() => {
      const activities = getProjectActivities();
      const stats = getCumulativeProgressStats(activities);
      return stats.realizado;
    })();

    return (
      <div className="space-y-6 animate-in fade-in duration-300">
        {/* Top Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <StatCard title="Avanço Físico Real" value={`${overallActual.toFixed(2)}%`} color="bg-emerald-600" />
          <StatCard title="Meta Semanal Ativa" value={`${weeklyTasks.length} Serviços`} color="bg-indigo-600" />
          <StatCard title="Média de PPC" value={ppcHistory.length > 0 ? `${(ppcHistory.reduce((a, b) => a + b.ppc, 0) / ppcHistory.length).toFixed(1)}%` : '0.0%'} color="bg-cyan-600" />
          <StatCard title="Equipes Registradas" value={`${teams.length} Grupos`} color="bg-slate-800" />
        </div>

        {/* Middle mockup dashboard layout */}
        <div className="bg-white rounded-3xl shadow-xl border border-slate-100 p-6 flex flex-col gap-4 bg-slate-50">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-200 pb-4 gap-4">
            <div>
              <h2 className="text-xl font-black text-slate-800 tracking-tight">
                Situação da obra em <span className="text-blue-600 capitalize">{analysisMonth}</span>
              </h2>
              <p className="text-xs text-slate-500 mt-1 uppercase font-bold tracking-wider">
                Mapeamento Físico Semanal por Pavimento e Pacote
              </p>
            </div>

              {/* Week Navigation */}
              <div className="flex items-center space-x-2 bg-white p-1.5 rounded-xl border border-slate-200 shadow-sm">
                <button onClick={() => setCurrentWeekStart(prev => addDays(prev, -7))} className="p-2 hover:bg-slate-100 rounded-lg transition text-slate-600">◀</button>
                <div className="text-center min-w-[160px]">
                  <div className="text-[8px] uppercase font-black text-slate-400">Semana Ativa</div>
                  <div className="text-xs font-black text-slate-700">
                    {currentWeekStart.toLocaleDateString('pt-BR')} - {new Date(currentWeekStart.getTime() + 4*86400000).toLocaleDateString('pt-BR')}
                  </div>
                </div>
                <button onClick={() => setCurrentWeekStart(prev => addDays(prev, 7))} className="p-2 hover:bg-slate-100 rounded-lg transition text-slate-600">▶</button>
              </div>
            </div>

            {/* AI Analysis Panel (Replaces old grid) */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="p-5 flex justify-between items-center border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center gap-3">
                  <div>
                    <h3 className="text-sm font-black text-slate-800 tracking-tight uppercase">Análise da semana</h3>
                    <p className="text-[10px] text-slate-500 mt-0.5 font-bold">
                      Gerada automaticamente
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  {!aiLoading && (
                    <button
                      onClick={() => handleAIAnalysis()}
                      className="text-[9px] font-black uppercase text-indigo-700 hover:text-white bg-indigo-50 hover:bg-indigo-600 border border-indigo-200 hover:border-indigo-600 px-3 py-1.5 rounded-lg transition duration-200 flex items-center gap-1.5 shadow-sm active:scale-95 cursor-pointer"
                    >
                      🔄 Reavaliar semana
                    </button>
                  )}
                  {(() => {
                    const weekId = toLocalDateString(currentWeekStart);
                    const isFinalized = planning.some(t => t.weekId === weekId && t.finalized);
                    return isFinalized ? (
                      <span className="text-[9px] font-black uppercase text-emerald-700 bg-emerald-100 border border-emerald-200 px-2.5 py-1.5 rounded-lg flex items-center gap-1">
                        <span>🔒</span> Salvo no histórico
                      </span>
                    ) : (
                      <span className="text-[9px] font-black uppercase text-amber-700 bg-amber-100 border border-amber-200 px-2.5 py-1.5 rounded-lg flex items-center gap-1">
                        <span>⚡</span> Análise em tempo real
                      </span>
                    );
                  })()}
                </div>
              </div>

              <div className="p-6">
                {aiLoading && (
                  <div className="flex flex-col items-center justify-center py-8 gap-3">
                    <div className="flex gap-1.5">
                      {[0,1,2].map(i => (
                        <div key={i} className="w-2 h-2 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }}/>
                      ))}
                    </div>
                    <p className="text-slate-400 text-xs font-bold uppercase tracking-wider">A ler atividades e gerar insights...</p>
                  </div>
                )}

                {!aiLoading && !aiAnalysis && (
                  <div className="flex items-center justify-center py-8 text-center">
                    <p className="text-slate-400 text-xs font-bold uppercase tracking-wider italic">
                      Nenhum dado na semana para analisar.
                    </p>
                  </div>
                )}

                {!aiLoading && aiAnalysis && (
                  <div className="space-y-3 text-sm leading-relaxed text-slate-700">
                    {aiAnalysis.split('\n').map((line, i) => {
                      if (!line.trim()) return <div key={i} className="h-1"/>;
                      if (line.startsWith('## ')) {
                        return (
                          <h4 key={i} className="text-slate-900 font-black text-xs uppercase tracking-wider mt-5 mb-2 flex items-center gap-2 border-b border-slate-100 pb-1">
                            {line.replace('## ', '')}
                          </h4>
                        );
                      }
                      if (line.startsWith('# ')) {
                        return <h3 key={i} className="text-slate-900 font-black text-sm mt-4 mb-2">{line.replace('# ', '')}</h3>;
                      }
                      if (line.startsWith('- ') || line.startsWith('* ')) {
                        return (
                          <div key={i} className="flex gap-2 text-slate-600 text-xs items-start">
                            <span className="text-indigo-500 mt-0.5 shrink-0 text-[10px]">■</span>
                            <span dangerouslySetInnerHTML={{ __html: line.replace(/^[-*]\s/, '').replace(/\*\*(.*?)\*\*/g, '<strong class="text-slate-900">$1</strong>') }}/>
                          </div>
                        );
                      }
                      const htmlLine = line.replace(/\*\*(.*?)\*\*/g, '<strong class="text-slate-900">$1</strong>').replace(/`(.*?)`/g, '<code class="bg-slate-100 text-slate-800 px-1 rounded text-[10px]">$1</code>');
                      return (
                        <p key={i} className="text-slate-600 text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: htmlLine }}/>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>


          </div>

        {/* Bottom charts (PPC & Delay analysis) */}
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
                <div className="w-full h-full flex items-center justify-center text-slate-400 text-xs italic">Nenhum dado de PPC registrado.</div>
              ) : (
                ppcChartData.map((d, i) => {
                  const ppcVal = typeof d?.ppc === 'number' ? d.ppc : parseFloat(d?.ppc) || 0;
                  const completedVal = d?.completed ?? 0;
                  const totalPlannedVal = d?.totalPlanned ?? 0;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center justify-end h-full z-10 group relative">
                      <div className="opacity-0 group-hover:opacity-100 absolute -top-8 bg-slate-800 text-white text-[10px] px-2 py-1 rounded pointer-events-none transition-opacity whitespace-nowrap z-20 shadow-lg">
                        {ppcVal.toFixed(1)}% ({completedVal}/{totalPlannedVal})
                      </div>
                      <div className={`w-full max-w-[40px] rounded-t-md transition-all cursor-pointer ${ppcVal > 74.9 ? 'bg-indigo-500 hover:bg-indigo-400' : 'bg-rose-500 hover:bg-rose-400'}`} style={{ height: `${Math.max(ppcVal, 2)}%` }}></div>
                      <span className="text-[8px] text-slate-500 mt-2 font-bold rotate-45 origin-top-left absolute -bottom-6 whitespace-nowrap">{formatDateBR(d?.weekStart).slice(0,5)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200 flex flex-col">
            <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider mb-2">Principais Causas de Atraso (Top 5)</h3>
            <p className="text-[10px] text-slate-500 mb-4">Frequência e percentual acumulado dos motivos de desvio.</p>
            <div className="flex-1 flex flex-col justify-center">
              {delayStats.length === 0 ? (
                <div className="w-full flex items-center justify-center text-slate-400 text-xs italic h-full">Nenhum atraso com motivo registrado.</div>
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
  };

  const renderCronograma = () => (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-4">
          <div>
            <h2 className="text-lg font-black text-indigo-900 uppercase tracking-tight mb-1">Importação Directa de Planilha</h2>
            <p className="text-xs text-slate-500">Envie o arquivo de planejamento gerado pelo seu software (Excel ou CSV).</p>
          </div>
          <button 
            onClick={() => triggerConfirm(
              'Limpar Banco de Dados', 
              'Deseja realmente limpar todo o banco de dados do cronograma, metas e painéis? Esta ação não pode ser desfeita e redefinirá o projeto.', 
              handleClearProjectData
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
          <h3 className="text-sm font-black text-slate-800 uppercase">
            Atividades do Cronograma Ativo
            <span className="ml-2 text-indigo-600">({filteredCronograma.length}/{cronogramaInicial.length})</span>
          </h3>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!previousBudgetImport}
              title={getBudgetImportTooltip(previousBudgetImport)}
              className="px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-wider text-slate-500 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              Orcamento anterior
            </button>
            <button
              type="button"
              disabled={!currentBudgetImport}
              title={getBudgetImportTooltip(currentBudgetImport)}
              className="px-3 py-2 rounded-lg border border-indigo-200 bg-indigo-50 text-[10px] font-black uppercase tracking-wider text-indigo-700 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              Orcamento atual
            </button>
          </div>
        </div>

        {/* Filter Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
          <div>
            <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">🔍 Pesquisa</label>
            <input
              type="text"
              className="w-full p-2 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-400 outline-none"
              placeholder="Serviço, macro, equipe..."
              value={cronoSearch}
              onChange={e => setCronoSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Pavimento</label>
            <select
              className="w-full p-2 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none"
              value={cronoFloorFilter}
              onChange={e => setCronoFloorFilter(e.target.value)}
            >
              <option value="">-- Todos --</option>
              {(floors || []).map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Macroatividade</label>
            <select
              className="w-full p-2 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none"
              value={cronoMacroFilter}
              onChange={e => setCronoMacroFilter(e.target.value)}
            >
              <option value="">-- Todas --</option>
              {(allPossibleMacros || []).map(sId => <option key={sId} value={sId}>{getMacroTitle(sId)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Progresso</label>
            <select
              className="w-full p-2 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none"
              value={cronoProgressFilter}
              onChange={e => setCronoProgressFilter(e.target.value)}
            >
              <option value="">-- Todos --</option>
              <option value="notstarted">⬜ Não iniciado (0%)</option>
              <option value="inprogress">🔵 Em andamento</option>
              <option value="done">✅ Concluído (100%)</option>
            </select>
          </div>
        </div>

        <div className="overflow-auto rounded-xl border border-slate-200 max-h-[520px]">
          <table className="min-w-[1520px] w-full text-xs text-left">
            <thead className="bg-slate-800 text-white uppercase text-[9px] tracking-wider sticky top-0 z-10">
              <tr>
                {[
                  { label: 'Etapa (Macro)', key: 'macro' },
                  { label: 'Pavimento (Lote)', key: 'floor' },
                  { label: 'Serviço', key: 'service' },
                  { label: 'Dias', key: 'duration', center: true },
                  { label: 'Fim Planeado', key: 'end', center: true },
                  { label: 'Realizado', key: 'progress', center: true },
                  { label: 'Equipe', key: null, center: true },
                  { label: 'Custo Estimado', key: 'cost', right: true },
                  { label: 'Grupo Replicacao', key: null },
                  { label: 'Predecessoras', key: null },
                  { label: 'Sucessoras', key: null },
                  { label: 'Depend. herdada de', key: null },
                ].map(({ label, key, center, right }) => (
                  <th
                    key={label}
                    className={`p-3 select-none ${key ? 'cursor-pointer hover:bg-slate-700 transition-colors' : ''} ${center ? 'text-center' : right ? 'text-right' : ''}`}
                    onClick={() => {
                      if (!key) return;
                      if (cronoSortKey === key) {
                        setCronoSortDir(d => d === 'asc' ? 'desc' : 'asc');
                      } else {
                        setCronoSortKey(key);
                        setCronoSortDir('asc');
                      }
                    }}
                  >
                    <span className="flex items-center gap-1 justify-inherit">
                      {label}
                      {key && (
                        <span className={`text-[10px] transition-opacity ${cronoSortKey === key ? 'opacity-100 text-indigo-300' : 'opacity-30'}`}>
                          {cronoSortKey === key ? (cronoSortDir === 'asc' ? '▲' : '▼') : '⇕'}
                        </span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {filteredCronograma.map((item, idx) => (
                <tr key={idx} className="hover:bg-slate-50">
                  <td className="p-3 font-bold text-indigo-900">{item.macro}</td>
                  <td className="p-3 text-slate-600">{item.floor}</td>
                  <td className="p-3 font-bold text-slate-800">{item.service}</td>
                  <td className="p-3 text-center text-slate-500">{item.duration}</td>
                  <td className="p-3 text-center text-slate-500">{formatDateBR(item.end)}</td>
                  <td className="p-3 text-center">
                    <select
                      className="p-1 bg-white border border-slate-200 rounded font-bold text-slate-700 text-xs cursor-pointer focus:border-indigo-500"
                      value={item.progress ?? 0}
                      onChange={async (e) => {
                        const newProgress = parseInt(e.target.value, 10);
                        const updatedCrono = cronogramaInicial.map(c => c.id === item.id ? { ...c, progress: newProgress } : c);
                        const updatedFloorsData = cloneDeep(allFloorsData);
                        const macroKey = slugify(item.macro);
                        if (updatedFloorsData[item.floor] && updatedFloorsData[item.floor][macroKey]) {
                          const itemsList = updatedFloorsData[item.floor][macroKey].items || [];
                          const existingItem = itemsList.find(it => it && it.id === item.id);
                          if (existingItem) {
                            existingItem.actualPercent = newProgress;
                          }
                        }
                        setCronogramaInicial(updatedCrono);
                        setAllFloorsData(updatedFloorsData);
                        await saveToDB(floors, updatedFloorsData, history, weights, planning, updatedCrono, teams, delayReasons, ppcHistory, matrices);
                        setNotification({ message: 'Progresso do cronograma atualizado!', type: 'success' });
                      }}
                    >
                      {[0, 25, 50, 75, 100].map(val => (
                        <option key={val} value={val}>{val}%</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-3 text-center"><span className="px-2 py-0.5 bg-slate-100 rounded text-[9px] font-black text-slate-600">{item.responsible || 'EQUIPE GERAL'}</span></td>
                  <td className="p-3 text-right text-emerald-600 font-mono">R$ {item.cost?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</td>
                  <td className="p-3 text-slate-700 font-bold text-[10px] uppercase">{item.replicationGroup || '-'}</td>
                  <td className="p-3 text-slate-600 font-mono text-[10px] max-w-[180px] whitespace-normal break-words" title={(item.predecessors || []).join(', ')}>
                    {(item.predecessors || []).length > 0 ? item.predecessors.join(', ') : '-'}
                  </td>
                  <td className="p-3 text-slate-600 font-mono text-[10px] max-w-[180px] whitespace-normal break-words" title={(item.successors || []).join(', ')}>
                    {(item.successors || []).length > 0 ? item.successors.join(', ') : '-'}
                  </td>
                  <td className="p-3 text-slate-500 font-mono text-[10px] max-w-[180px] whitespace-normal break-words" title={item.inheritedDependenciesFrom || ''}>
                    {item.inheritedDependenciesFrom || '-'}
                  </td>
                </tr>
              ))}
              {filteredCronograma.length === 0 && (
                <tr>
                  <td colSpan={12} className="p-10 text-center text-slate-400 italic font-medium">
                    Nenhuma atividade encontrada com os filtros aplicados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );


  const renderPlanning = () => (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-300 pb-6">
      <div className="bg-gradient-to-r from-indigo-900 to-slate-900 text-white p-6 rounded-2xl shadow-xl flex flex-col md:flex-row justify-between items-center gap-6">
        <div className="space-y-2">
          <span className="px-3 py-1 bg-indigo-800 text-[10px] font-black tracking-wider uppercase rounded-full border border-indigo-700 text-indigo-300">KPI Produtividade</span>
          <h2 className="text-xl font-black">PPC - Percentual de Planos Concluídos</h2>
          <p className="text-xs text-indigo-200">Percentual de serviços planejados executados integralmente conforme a meta semanal ativa.</p>
        </div>
        <div className="flex items-center space-x-6">
          <div className="text-center bg-indigo-950/50 p-4 rounded-xl border border-indigo-800">
            <div className="text-3xl font-black text-emerald-400">{currentWeekPpcStats.percent.toFixed(1)}%</div>
            <div className="text-[10px] font-bold text-indigo-300 uppercase tracking-tight mt-1">{currentWeekPpcStats.completedCount} de {currentWeekPpcStats.totalPlannedCount} Concluídos</div>
          </div>
        </div>
      </div>

      <div className="bg-white p-4 rounded-2xl shadow-md border border-slate-200">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-4">
          <div className="flex items-center space-x-2 bg-slate-100 p-1.5 rounded-xl">
            <button onClick={() => setCurrentWeekStart(prev => addDays(prev, -7))} className="p-2.5 hover:bg-white rounded-lg shadow-sm transition">◀</button>
            <div className="text-center min-w-[180px]">
              <div className="text-[9px] uppercase font-bold text-slate-500">Semana Selecionada</div>
              <div className="text-xs font-black text-indigo-900">{currentWeekStart.toLocaleDateString()} - {new Date(currentWeekStart.getTime() + 4*86400000).toLocaleDateString()}</div>
            </div>
            <button onClick={() => setCurrentWeekStart(prev => addDays(prev, 7))} className="p-2.5 hover:bg-white rounded-lg shadow-sm transition">▶</button>
          </div>
          <div className="flex gap-2 w-full md:w-auto flex-wrap">
            {weeklyTasks.length > 0 && (
              <button
                onClick={handlePrintPlanning}
                className="flex-1 md:flex-none px-4 py-3 bg-slate-700 hover:bg-slate-800 border border-slate-600 text-white font-black rounded-xl shadow-sm transition active:scale-95 text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer"
                title="Abrir visualização de impressão da tabela atual"
              >
                <span>🖨️</span> Impressão
              </button>
            )}
            {teams.length > 0 && weeklyTasks.length > 0 && (
              <button
                onClick={openWhatsappShareModal}
                className="flex-1 md:flex-none px-4 py-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 hover:border-indigo-300 text-indigo-700 font-black rounded-xl shadow-sm transition active:scale-95 text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer"
              >
                <span>💬</span> WhatsApp
              </button>
            )}
            <button
              onClick={handleGeneratePlanningFromBudgetDiffs}
              disabled={pendingBudgetDiffs.length === 0}
              className="flex-1 md:flex-none px-4 py-3 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-black rounded-xl shadow transition active:scale-95 text-xs uppercase tracking-wider flex items-center justify-center gap-2"
              title={`Aplica ${pendingBudgetDiffProgress}% de avanco pendente do ultimo orcamento na semana selecionada`}
            >
              <span>Delta</span> Gerar por Dif. {pendingBudgetDiffs.length > 0 ? `(${pendingBudgetDiffs.length})` : ''}
            </button>
            <button onClick={() => setFinalizeModal({ isOpen: true, carryOverUnfinished: true })} disabled={weeklyTasks.length === 0} className="flex-1 md:flex-none px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white font-black rounded-xl shadow transition active:scale-95 text-xs uppercase tracking-wider flex items-center justify-center gap-2">
              <span>🏁</span> Finalizar Semana
            </button>
            <button onClick={() => { setDrawerSourceMode('cronograma'); setDrawerExpandedStep(1); setDrawerMacro(allPossibleMacros[0] || ''); setDrawerFloors([]); setDrawerSelectedServices([]); setDrawerWarning(''); setIsDrawerOpen(true); }} className="flex-1 md:flex-none px-4 py-3 bg-indigo-600 text-white font-black rounded-xl shadow hover:bg-indigo-700 transition active:scale-95 text-xs uppercase tracking-wider flex items-center justify-center gap-2">
              <span>➕</span> Adicionar Atividades
            </button>
          </div>
        </div>

        {/* Planning Filter Bar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 p-3 bg-slate-50 rounded-xl border border-slate-200">
          <div>
            <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">🔍 Pesquisa</label>
            <input
              type="text"
              className="w-full p-2 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-400 outline-none"
              placeholder="Atividade, pavimento, observação..."
              value={planningSearch}
              onChange={e => setPlanningSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Equipe</label>
            <select
              className="w-full p-2 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none"
              value={planningTeamFilter}
              onChange={e => setPlanningTeamFilter(e.target.value)}
            >
              <option value="">-- Todas --</option>
              {(teams || []).map(team => <option key={team} value={team}>{team}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Estado</label>
            <select
              className="w-full p-2 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none"
              value={planningStatusFilter}
              onChange={e => setPlanningStatusFilter(e.target.value)}
            >
              <option value="">-- Todos --</option>
              <option value="ok">✅ Conforme</option>
              <option value="delayed">⚠️ Com Atraso</option>
              <option value="finalized">🔒 Finalizado</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto md:overflow-x-visible rounded-xl border border-slate-200">
          <table className="w-full text-xs text-left border-collapse">
            <thead className="sticky top-[118px] z-20 bg-slate-800">
              <tr className="bg-slate-800 text-white uppercase text-[9px] tracking-tight">
                {[
                  { label: 'Serviço / Pavimento', key: 'activityName', cls: 'w-108' },
                  { label: 'Responsável / Equipe', key: 'responsible', cls: 'w-24 text-center' },
                  { label: 'Efetivo', key: 'efetivo', cls: 'w-9 text-center' },
                  { label: 'Meta Planeada', key: 'plannedThisWeek', cls: 'text-center w-32 bg-slate-900' },
                  { label: 'Dias de Trabalho', key: null, cls: 'text-center w-32', isWeather: true },
                  { label: 'Progresso da Semana', key: 'progressThisWeek', cls: 'text-center w-32' },
                  { label: 'Motivo de Atraso', key: null, cls: 'text-center w-18' },
                  { label: 'Observações', key: null, cls: 'w-20' },
                  { label: 'Ação', key: null, cls: 'text-center w-10' },
                ].map((col) => {
                  if (col.label === 'Ação') {
                    return (
                      <th key={col.label} className={`p-2 border-r border-slate-700 text-center sticky top-[118px] z-20 bg-slate-800 ${col.cls}`}>
                        <div className="flex items-center justify-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={filteredWeeklyTasks.length > 0 && filteredWeeklyTasks.every(t => selectedTaskIds.includes(t.id))}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedTaskIds(prev => Array.from(new Set([...prev, ...filteredWeeklyTasks.map(t => t.id)])));
                              } else {
                                setSelectedTaskIds(prev => prev.filter(id => !filteredWeeklyTasks.map(t => t.id).includes(id)));
                              }
                            }}
                            className="w-3.5 h-3.5 text-indigo-600 rounded border-slate-350 focus:ring-indigo-500 cursor-pointer"
                            title="Selecionar todos"
                          />
                          <button 
                            onClick={handleBulkDelete}
                            disabled={selectedTaskIds.length === 0}
                            className="text-red-400 hover:text-red-500 font-bold text-sm disabled:opacity-30 cursor-pointer transition-opacity"
                            title="Excluir selecionados"
                          >
                            🗑️
                          </button>
                        </div>
                      </th>
                    );
                  }
                  if (col.isWeather) {
                    return (
                      <th key={col.label} className={`p-2 border-r border-slate-700 text-center sticky top-[118px] z-20 bg-slate-800 ${col.cls}`}>
                        <div className="flex flex-col items-center justify-center">
                          <span className="text-[8px] text-slate-300 font-bold uppercase mb-1">Dias de Trabalho</span>
                          <div className="flex gap-[3px] justify-center">
                            {['S', 'T', 'Q', 'Q', 'S'].map((dayChar, idx) => {
                              const dayDate = addDays(currentWeekStart, idx);
                              const dayStr = toISODate(dayDate);
                              
                              const todayStart = new Date();
                              todayStart.setHours(0, 0, 0, 0);
                              const diffTime = dayDate.getTime() - todayStart.getTime();
                              const diffDays = Math.round(diffTime / 86400000);
                              const isWithinRange = diffDays >= -15 && diffDays <= 15;

                              const cacheKey = `${projectCity.trim().toLowerCase()}_${dayStr}`;
                              const weather = isWithinRange ? weatherCache[cacheKey] : null;
                              
                              const weatherEmoji = isWithinRange && weather ? getWeatherEmoji(weather.icon) : (isWithinRange && weatherLoading ? '⏳' : '');
                              const tempInfo = weather ? `${weather.conditions} (${weather.tempMin}°C - ${weather.tempMax}°C)` : (isWithinRange && weatherLoading ? 'Carregando...' : 'Sem dados');
                              
                              return (
                                <div key={idx} className="flex flex-col items-center w-6 group relative cursor-help" title={`${dayChar} (${dayDate.toLocaleDateString('pt-BR')})${isWithinRange ? ` - Clima: ${tempInfo}` : ''}`}>
                                  <span className="text-[13px] leading-none mb-0.5 select-none">{weatherEmoji || '\u00a0'}</span>
                                  <span className="text-[8px] font-black text-slate-400 leading-none">{dayChar}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </th>
                    );
                  }
                  return (
                    <th
                      key={col.label}
                      className={`p-3 border-r border-slate-700 select-none sticky top-[118px] z-20 bg-slate-800 ${col.cls} ${col.key ? 'cursor-pointer hover:bg-slate-700 transition-colors' : ''}`}
                      onClick={() => {
                        if (!col.key) return;
                        if (planningSortKey === col.key) setPlanningSortDir(d => d === 'asc' ? 'desc' : 'asc');
                        else { setPlanningSortKey(col.key); setPlanningSortDir('asc'); }
                      }}
                    >
                      <span className="flex items-center gap-1 justify-center">
                        {col.label}
                        {col.key && (
                          <span className={`text-[10px] ${planningSortKey === col.key ? 'opacity-100 text-indigo-300' : 'opacity-30'}`}>
                            {planningSortKey === col.key ? (planningSortDir === 'asc' ? '▲' : '▼') : '⇕'}
                          </span>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {filteredWeeklyTasks.map(t => {
                const currentPlan = t.plannedThisWeek ?? 100;
                const progVal = t.progressThisWeek ?? 0;
                const showDelayAlert = currentPlan > progVal;
                return (
                  <tr key={t.id} className={`hover:bg-slate-50 transition ${t.finalized ? 'bg-slate-100/70 opacity-75' : showDelayAlert && (progVal > 0 || currentPlan > 0) ? 'bg-red-50/40' : ''}`}>
                    <td className="p-3 border-r">
                      <div className="flex items-start space-x-1.5">
                        {t.finalized && <span className="text-[10px] text-slate-500 mt-0.5" title="Semana Finalizada">🔒</span>}
                        {t.isManual && (
                          <span className="px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 text-[8px] font-black rounded-md uppercase tracking-tight select-none shrink-0 mt-0.5">
                            Extra
                          </span>
                        )}
                        {t.isUnplannedDetected && (
                          <span className="px-1.5 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 text-[8px] font-black rounded-md uppercase tracking-tight select-none shrink-0 mt-0.5">
                            Fora do planejado
                          </span>
                        )}
                        <div className="font-black text-slate-800 uppercase tracking-tight text-[11px] leading-tight line-clamp-2 break-words whitespace-normal flex-1" title={t.activityName}>{t.activityName}</div>
                        {!t.finalized && !t.serviceComplement && editingComplementTaskId !== t.id && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingComplementTaskId(t.id);
                            }}
                            className="w-4 h-4 rounded-full border border-slate-350 hover:border-indigo-650 hover:bg-indigo-50 text-slate-500 hover:text-indigo-650 flex items-center justify-center font-bold text-[10px] cursor-pointer shrink-0 mt-0.5"
                            title="Adicionar complemento"
                          >
                            +
                          </button>
                        )}
                      </div>
                      {(t.serviceComplement || editingComplementTaskId === t.id) && (
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wide mt-1.5 flex items-center gap-1">
                          <span className="text-indigo-550 font-black">↳</span>
                          <input
                            type="text"
                            disabled={t.finalized}
                            placeholder="Complemento..."
                            className="p-1 bg-slate-50 border border-slate-200 rounded text-[9px] font-bold text-slate-700 w-32 focus:bg-white focus:border-indigo-500"
                            value={t.serviceComplement || ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setPlanning(planning.map(p => p.id === t.id ? { ...p, serviceComplement: val, lastUpdatedBy: plannerUsername || 'Sistema' } : p));
                            }}
                            onBlur={() => {
                              saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices);
                              if (!t.serviceComplement) setEditingComplementTaskId(null);
                            }}
                            autoFocus={editingComplementTaskId === t.id}
                          />
                          {!t.finalized && (
                            <button
                              disabled={t.finalized}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleServiceComplementVoiceInput(t.id);
                              }}
                              className={`p-1 rounded-full transition active:scale-95 text-[10px] shrink-0 cursor-pointer ${
                                listeningComplementTaskId === t.id 
                                  ? 'bg-red-600 text-white animate-pulse p-1' 
                                  : micConnectingComplementTaskId === t.id
                                  ? 'bg-amber-500 text-white animate-pulse p-1'
                                  : 'bg-indigo-550/10 text-indigo-700 hover:bg-indigo-200'
                              }`}
                              title={
                                listeningComplementTaskId === t.id 
                                  ? "Microfone ativo (Pode falar)" 
                                  : micConnectingComplementTaskId === t.id
                                  ? "Inicializando microfone..."
                                  : "Ditar complemento"
                              }
                            >
                              🎙️
                            </button>
                          )}
                          {!t.finalized && t.serviceComplement && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUpdateTaskField(t.id, 'serviceComplement', '');
                                setEditingComplementTaskId(null);
                              }}
                              className="text-slate-400 hover:text-red-500 font-bold text-xs cursor-pointer ml-0.5"
                              title="Limpar complemento"
                            >
                              &times;
                            </button>
                          )}
                        </div>
                      )}
                      <div className="text-[9px] font-bold text-indigo-600 uppercase mt-0.5">{t.floor}</div>
                    </td>
                    <td className="p-3 border-r text-center align-middle">
                      <div className="relative w-full min-h-[32px] flex items-center justify-center bg-slate-100 border border-slate-200 rounded-lg py-1 px-1.5 hover:bg-slate-200 transition-colors">
                        <div className="text-[10px] font-black uppercase text-slate-800 leading-tight whitespace-normal break-words text-center pr-3">
                          {t.responsible || '-- ESCOLHA --'}
                        </div>
                        <div className="absolute right-1 text-[8px] text-slate-500 pointer-events-none">▼</div>
                        <select
                          disabled={t.finalized}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                          value={t.responsible || ''}
                          onChange={e => handleUpdateTaskField(t.id, 'responsible', e.target.value)}
                        >
                          <option value="">-- Escolha --</option>
                          {teams.map(team => <option key={team} value={team}>{team}</option>)}
                        </select>
                      </div>
                    </td>
                    <td className="p-3 border-r text-center">
                      <input
                        type="number"
                        min="0"
                        disabled={t.finalized}
                        className="w-9 p-1 bg-slate-100 border border-slate-200 rounded text-[10px] font-bold text-center focus:bg-white focus:border-indigo-500 outline-none"
                        value={t.efetivo === undefined || t.efetivo === null ? '' : t.efetivo}
                        onChange={e => {
                          const val = e.target.value === '' ? null : parseInt(e.target.value, 10);
                          handleUpdateTaskField(t.id, 'efetivo', val);
                        }}
                      />
                    </td>
                    <td className="p-3 border-r bg-emerald-50/30">
                      <div className="flex gap-1 justify-center">
                        {[25, 50, 75, 100].map(val => {
                          const execBefore = t.executedBefore ?? 0;
                          const isPlanned = currentPlan === val;
                          const isExecuted = execBefore > 0 && val === execBefore;
                          // Priority: green (planned) > dark-gray (executed) > default
                          let btnClass = 'bg-slate-100 text-slate-500 hover:bg-emerald-100 hover:text-emerald-700';
                          let ring = '';
                          if (isPlanned) {
                            btnClass = 'bg-emerald-600 text-white scale-110 shadow-md';
                            ring = 'ring-2 ring-emerald-300';
                          } else if (isExecuted) {
                            btnClass = 'bg-slate-500 text-white shadow-sm';
                            ring = 'ring-2 ring-slate-400';
                          }
                          return (
                            <button
                              key={val}
                              disabled={t.finalized}
                              onClick={() => handlePlannedChange(t.id, val)}
                              title={isExecuted && !isPlanned ? `${val}% já medido` : `Planejar ${val}%`}
                              className={`w-7 h-7 rounded-full text-[9px] font-black flex items-center justify-center transition-all ${btnClass} ${ring} disabled:opacity-50 disabled:cursor-default`}
                            >{val}%</button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="p-3 border-r align-middle bg-slate-50/50">
                      <DaysSelector dailyWork={t.dailyWork} disabled={t.finalized} onChange={(newDW) => handleDailyWorkChange(t.id, newDW)} />
                    </td>
                    <td className="p-3 border-r">
                      <div className="flex flex-col items-center gap-1">
                        <div className="flex gap-1 justify-center">
                          {[25, 50, 75, 100].map(val => {
                            const isActive = progVal === val;
                            const isPrefilled = t.preFilledProgress === val;
                            const isOk = val > currentPlan || val === currentPlan;
                            const btnColor = isOk ? 'bg-blue-600 ring-blue-300' : 'bg-red-600 ring-red-300';
                            
                            let prefillClass = '';
                            if (isPrefilled && !isActive) {
                              prefillClass = 'ring-2 ring-dashed ring-purple-500 text-purple-700 bg-purple-50';
                            }
                            return (
                              <button
                                key={val}
                                disabled={t.finalized}
                                onClick={() => handleWeeklyProgressChange(t.id, val)}
                                className={`w-7 h-7 rounded-full text-[9px] font-black flex items-center justify-center transition-all ${isActive ? `${btnColor} text-white scale-110 shadow-md ring-2` : prefillClass ? prefillClass : 'bg-slate-100 text-slate-500 hover:bg-slate-200'} disabled:opacity-50 disabled:cursor-default`}
                              >
                                {val}%
                              </button>
                            );
                          })}
                        </div>
                        {t.preFilledProgress !== undefined && (
                          <div className="text-[8px] font-black text-purple-700 uppercase tracking-tight bg-purple-100/70 border border-purple-200 px-1.5 py-0.5 rounded-md flex items-center gap-0.5 mt-0.5" title={`Sugestão da equipe enviada em ${t.preFilledAt || ''}`}>
                            <span>📲 Sugerido: {t.preFilledProgress}%</span>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-3 border-r text-center align-middle">
                      {showDelayAlert ? (
                        <div className="space-y-1">
                          <div className="relative w-full min-h-[32px] flex items-center justify-center bg-red-100/80 border border-red-200 rounded-lg py-1 px-1.5 hover:bg-red-200/80 transition-colors">
                            <div className="text-[9px] font-black uppercase text-red-800 leading-tight whitespace-normal break-words text-center pr-3">
                              {t.delayReason || '⚠️ MOTIVO...'}
                            </div>
                            <div className="absolute right-1 text-[7px] text-red-600 pointer-events-none">▼</div>
                            <select
                              disabled={t.finalized}
                              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                              value={t.delayReason || ''}
                              onChange={e => handleUpdateTaskField(t.id, 'delayReason', e.target.value)}
                            >
                              <option value="">⚠️ Motivo...</option>
                              {delayReasons.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                          </div>
                          {t.preFilledDelayReason && (
                            <div className="text-[8px] text-purple-600 font-bold italic leading-tight text-left pl-1">
                              📲 Sugerido: "{t.preFilledDelayReason}"
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] font-bold text-emerald-600">✓ Conforme</span>
                      )}
                    </td>
                    <td className="p-3 border-r">
                      <div className="space-y-1">
                        <div className="flex items-start space-x-1.5">
                          <textarea
                            disabled={t.finalized}
                            className="flex-1 bg-slate-50 border border-slate-200 py-1 px-1.5 rounded-lg text-[10px] font-medium disabled:opacity-80 focus:bg-white focus:border-indigo-500 resize-y min-h-[32px] h-[32px] leading-tight overflow-y-auto"
                            placeholder="Notas..."
                            value={t.observations || ''}
                            onChange={e => {
                              const val = e.target.value;
                              setPlanning(planning.map(p => p.id === t.id ? { ...p, observations: val, lastUpdatedBy: plannerUsername || 'Sistema' } : p));
                            }}
                            onBlur={() => saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices)}
                          />
                          {!t.finalized && (
                            <button
                              disabled={t.finalized}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => handleVoiceInput(t.id)}
                              className={`p-2 rounded-full transition active:scale-95 text-sm shrink-0 cursor-pointer ${
                                listeningTaskId === t.id 
                                  ? 'bg-red-600 text-white animate-pulse' 
                                  : micConnectingTaskId === t.id
                                  ? 'bg-amber-500 text-white animate-pulse'
                                  : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                              } disabled:opacity-40`}
                              title={
                                listeningTaskId === t.id 
                                  ? "Microfone ativo (Pode falar)" 
                                  : micConnectingTaskId === t.id
                                  ? "Inicializando microfone..."
                                  : "Ditar Observação"
                              }
                            >
                              🎙️
                            </button>
                          )}
                        </div>
                        {t.preFilledObservations && (
                          <div className="text-[8px] text-purple-600 font-bold italic leading-tight pl-2 text-left">
                            📲 Sugerido: "{t.preFilledObservations}"
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-center">
                      <div className="flex items-center justify-center gap-2">
                        {t.preFilledProgress !== undefined && (
                          <button
                            disabled={t.finalized}
                            onClick={() => handleAcceptPreFill(t.id)}
                            className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-lg border border-emerald-200 hover:border-emerald-300 font-bold text-xs disabled:opacity-30 cursor-pointer shadow-xs active:scale-95 flex items-center justify-center animate-bounce"
                            title={`Aceitar apontamento da equipe (sugerido em ${t.preFilledAt || ''})`}
                          >
                            ✅
                          </button>
                        )}
                        <input
                          type="checkbox"
                          disabled={t.finalized}
                          checked={selectedTaskIds.includes(t.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedTaskIds(prev => [...prev, t.id]);
                            } else {
                              setSelectedTaskIds(prev => prev.filter(id => id !== t.id));
                            }
                          }}
                          className="w-4 h-4 text-indigo-600 border-slate-300 rounded focus:ring-indigo-500 cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
                          title="Selecionar para exclusão"
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {weeklyTasks.length === 0 && (
            <div className="p-12 text-center text-slate-400 font-medium italic">Nenhuma atividade agendada para esta semana. Toque no botão acima para adicionar.</div>
          )}
          {weeklyTasks.length > 0 && filteredWeeklyTasks.length === 0 && (
            <div className="p-12 text-center text-slate-400 font-medium italic">Nenhuma atividade encontrada com os filtros aplicados.</div>
          )}
        </div>

        {/* Container para Inclusão de Atividades Manuais (Extras) */}
        <div className="mt-4 pt-4 border-t border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button 
              type="button"
              onClick={() => setIsAddingManual(!isAddingManual)}
              className={`w-8 h-8 rounded-full border flex items-center justify-center font-black text-sm transition shadow-xs active:scale-95 cursor-pointer ${isAddingManual ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700' : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'}`}
              title="Adicionar atividade extra fora de cronograma"
            >
              {isAddingManual ? '×' : '+'}
            </button>
            <div className="flex flex-col">
              <span className="text-[11px] font-black uppercase text-slate-700 tracking-tight">Atividade Extra</span>
              <span className="text-[9px] text-slate-400 font-bold uppercase">Incluir tarefa pontual fora do cronograma principal</span>
            </div>
          </div>

          {isAddingManual && (
            <div className="flex flex-1 flex-col sm:flex-row gap-3 items-stretch sm:items-center max-w-2xl animate-in fade-in slide-in-from-left duration-200">
              <div className="flex-1">
                <input
                  type="text"
                  placeholder="Descrição do serviço extra (ex: Limpeza final, Ajuste de prumo...)"
                  className="w-full p-2 border border-slate-200 rounded-lg text-xs font-medium focus:ring-2 focus:ring-indigo-400 outline-none bg-slate-50 focus:bg-white transition"
                  value={manualServiceName}
                  onChange={(e) => setManualServiceName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddManualActivity(); }}
                />
              </div>
              <div className="w-full sm:w-48">
                <select
                  className="w-full p-2 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none bg-slate-50 focus:bg-white transition cursor-pointer"
                  value={manualFloor}
                  onChange={(e) => setManualFloor(e.target.value)}
                >
                  <option value="">-- Pavimento --</option>
                  {(floors || []).map(f => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={handleAddManualActivity}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-[10px] uppercase tracking-wider rounded-lg shadow-sm transition active:scale-95 cursor-pointer whitespace-nowrap"
              >
                Incluir
              </button>
            </div>
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
          <p className="text-xs text-slate-500">Crie painéis customizados para visualizar o avanço de pavimentos e etapas específicas. Arraste as linhas e colunas para reordenar.</p>
        </div>
        <button onClick={() => setMatrixGroupModalOpen(true)} className="px-5 py-2.5 bg-indigo-600 text-white font-black uppercase tracking-wider rounded-xl text-xs hover:bg-indigo-700 transition shadow-md whitespace-nowrap">+ NOVA MATRIZ</button>
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
            <table className="w-full text-xs border-collapse">
              <thead className="bg-slate-900 text-white uppercase text-[9px] tracking-wider">
                <tr>
                  <th className="p-4 text-left sticky left-0 bg-slate-900 z-10 w-48 border-r border-slate-700">Pavimento</th>
                  {matrix.macros.map((mId, idx) => (
                    <th 
                      key={mId} 
                      draggable
                      onDragStart={(e) => handleDragColStart(e, matrix.id, idx)}
                      onDragOver={handleDragColOver}
                      onDrop={(e) => handleDropCol(e, matrix.id, idx)}
                      className="p-3 text-center group relative min-w-[125px] border-r border-slate-700 cursor-grab active:cursor-grabbing hover:bg-slate-800 transition select-none"
                      title="Arraste para reordenar esta coluna"
                    >
                      <div className="flex items-center justify-center gap-1">
                        <span className="text-slate-500 font-black text-[9px] tracking-tighter">⋮⋮</span>
                        <span className="truncate max-w-[90px]">{getMacroTitle(mId)}</span>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); removeMatrixColumn(matrix.id, mId); }} className="absolute top-1 right-2 opacity-0 group-hover:opacity-100 text-rose-400 hover:text-rose-300 font-black text-xs leading-none" title="Remover Coluna">&times;</button>
                    </th>
                  ))}
                  <th onClick={() => setMatrixSelection({ isOpen: true, matrixId: matrix.id, type: 'macro' })} className="p-3 text-center text-indigo-300 cursor-pointer hover:bg-slate-800 hover:text-white transition whitespace-nowrap min-w-[150px]">+ ADICIONAR ETAPA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {matrix.floors.map((fId, idx) => (
                  <tr 
                    key={fId} 
                    draggable
                    onDragStart={(e) => handleDragRowStart(e, matrix.id, idx)}
                    onDragOver={handleDragRowOver}
                    onDrop={(e) => handleDropRow(e, matrix.id, idx)}
                    className="hover:bg-slate-50/80 transition group"
                  >
                    <td 
                      className="p-3 font-black text-slate-700 bg-slate-50 sticky left-0 z-10 border-r border-slate-200 flex justify-between items-center min-w-[180px] cursor-grab active:cursor-grabbing select-none"
                      title="Arraste para reordenar este pavimento"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-400 font-black text-[9px] tracking-tighter">⋮⋮</span>
                        <span>{fId}</span>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); removeMatrixRow(matrix.id, fId); }} className="opacity-0 group-hover:opacity-100 text-rose-500 font-black hover:bg-rose-100 px-1.5 rounded" title="Remover Linha">&times;</button>
                    </td>
                    {matrix.macros.map(mId => {
                      const sec = allFloorsData[fId]?.[mId];
                      const avg = sec?.items ? getPackageProgress(fId, mId, sec.items) : 0;
                      const isCompleted = avg > 98.9;
                      const isHalf = avg > 50;
                      const isStarted = avg > 0;
                      let colorClass = 'text-slate-400';
                      if(isCompleted) colorClass = 'bg-emerald-100 text-emerald-800';
                      else if(isHalf) colorClass = 'bg-indigo-50 text-indigo-700';
                      else if(isStarted) colorClass = 'bg-orange-50 text-orange-700';
                      const tooltip = sec?.items 
                        ? sec.items.map(it => `${it.name}: ${(it.actualPercent || 0).toFixed(1)}%`).join('\n')
                        : '';
                      return (
                        <td 
                          key={mId} 
                          className={`p-3 text-center font-black transition-colors border-r border-slate-100 cursor-help ${colorClass}`}
                          onMouseEnter={(e) => showMatrixTooltip(e, tooltip)}
                          onMouseLeave={hideMatrixTooltip}
                        >
                          {avg.toFixed(1)}%
                        </td>
                      );
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

  const renderDetalhamentoPpc = () => {
    return (
      <div className="space-y-6 animate-in fade-in duration-300">
        {/* Selector Header Panel */}
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
          <div className="flex items-center space-x-3 mb-4">
            <h2 className="text-sm font-black text-indigo-900 uppercase tracking-tight">Filtros de Detalhamento</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Empreiteiro / Equipe</label>
              <select
                className="w-full p-2.5 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none cursor-pointer focus:bg-white transition"
                value={ppcSelectedContractor}
                onChange={e => setPpcSelectedContractor(e.target.value)}
              >
                {contractorsInPeriod.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
                {contractorsInPeriod.length === 0 && (
                  <option value="">Nenhum empreiteiro no período</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Semana Inicial</label>
              <select
                className="w-full p-2.5 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none cursor-pointer focus:bg-white transition"
                value={ppcStartWeek}
                onChange={e => {
                  const val = e.target.value;
                  setPpcStartWeek(val);
                  if (ppcEndWeek && val > ppcEndWeek) {
                    setPpcEndWeek(val);
                  }
                }}
              >
                {availableWeeks.map(wId => (
                  <option key={wId} value={wId}>{formatWeekId(wId)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Semana Final</label>
              <select
                className="w-full p-2.5 bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-400 outline-none cursor-pointer focus:bg-white transition"
                value={ppcEndWeek}
                onChange={e => {
                  const val = e.target.value;
                  setPpcEndWeek(val);
                  if (ppcStartWeek && val < ppcStartWeek) {
                    setPpcStartWeek(val);
                  }
                }}
              >
                {availableWeeks.map(wId => (
                  <option key={wId} value={wId}>{formatWeekId(wId)}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Info Panel matching the photo */}
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 font-sans text-slate-900">
          <div className="space-y-2 text-sm md:text-base font-bold">
            <div className="flex">
              <span className="w-32 inline-block">EMPRESA:</span>
              <span className="text-slate-800 font-black uppercase">{ppcSelectedContractor || '-'}</span>
            </div>
            <div className="flex">
              <span className="w-32 inline-block">Semana inicial:</span>
              <span className="text-slate-800">{formatWeekId(ppcStartWeek) || '-'}</span>
            </div>
            <div className="flex">
              <span className="w-32 inline-block">Semana final:</span>
              <span className="text-slate-800">{formatWeekId(ppcEndWeek) || '-'}</span>
            </div>
          </div>
        </div>

        {/* Dashboard Content Layout */}
        {ppcSelectedContractor ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            
            {/* Left Column: Variable-height PPC Table */}
            <div className="lg:col-span-5 bg-white p-5 rounded-2xl shadow-md border border-slate-200">
              <div className="border-b border-slate-100 pb-3 mb-4 flex justify-between items-center">
                <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider">Histórico Semanal</h3>
                <span className="text-[10px] font-mono font-bold text-slate-400 uppercase">Período Selecionado</span>
              </div>
              
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-xs text-left border-collapse border border-slate-300">
                  <thead className="bg-yellow-400 text-slate-900 border border-slate-300 uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="p-2 border border-slate-300 text-center font-bold">Início</th>
                      <th className="p-2 border border-slate-300 text-center font-bold">Fim</th>
                      <th className="p-2 border border-slate-300 text-center font-bold">PPC</th>
                      <th className="p-2 border border-slate-300 text-center font-bold">FAROL</th>
                      <th className="p-2 border border-slate-300 text-center font-bold">Meta</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-medium">
                    {contractorWeeklyPpcData.map(row => {
                      let farolLabel = '';
                      if (row.ppc !== null) {
                        if (row.ppc >= 80) {
                          farolLabel = 'ICONE ROSTO FELIZ';
                        } else if (row.ppc >= 50) {
                          farolLabel = 'CONE ROSTO NORMAL';
                        }
                      }

                      return (
                        <tr key={row.weekId} className="hover:bg-slate-50 transition">
                          <td className="p-2 border border-slate-300 text-center font-mono text-[10px] text-slate-800">{row.startDateStr}</td>
                          <td className="p-2 border border-slate-300 text-center font-mono text-[10px] text-slate-800">{row.endDateStr}</td>
                          <td className="p-2 border border-slate-300 text-center font-bold text-slate-800">
                            {row.ppc !== null ? `${row.ppc}%` : ''}
                          </td>
                          <td className="p-2 border border-slate-300 text-center font-black text-[9px] text-slate-800 uppercase tracking-tighter">
                            {farolLabel}
                          </td>
                          <td className="p-2 border border-slate-300 text-center text-slate-800 font-bold">80%</td>
                        </tr>
                      );
                    })}
                    {contractorWeeklyPpcData.length === 0 && (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-slate-400 italic font-medium">
                          Nenhuma semana encontrada no período selecionado.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {/* Footer: Média row */}
                  <tfoot className="border-t-2 border-slate-400 text-slate-950 font-bold">
                    <tr>
                      <td colSpan={2} className="p-2 text-center bg-yellow-400 border border-slate-300 text-xs font-black uppercase text-slate-950">Média</td>
                      <td className="p-2 text-center bg-pink-300 border border-slate-300 text-xs font-black text-slate-950">
                        {averagePpc}%
                      </td>
                      <td className="p-2 text-center bg-yellow-400 border border-slate-300"></td>
                      <td className="p-2 text-center bg-yellow-400 border border-slate-300"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* Right Column: Graphs */}
            <div className="lg:col-span-7 space-y-6">
              
              {/* PPC Evolution Line Chart */}
              <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200 flex flex-col">
                <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider mb-2">Evolução do PPC</h3>
                <p className="text-[10px] text-slate-500 mb-4">Comportamento semanal de cumprimento de metas no período selecionado.</p>
                
                {ppcEvolutionChart && ppcEvolutionChart.validPoints.length > 0 ? (
                  <div className="w-full overflow-hidden flex justify-center py-2">
                    <svg 
                      viewBox={`0 0 ${ppcEvolutionChart.width} ${ppcEvolutionChart.height}`} 
                      className="w-full max-w-2xl font-sans"
                    >
                      {/* PPC Centered Large Title in Chart */}
                      <text 
                        x={ppcEvolutionChart.width / 2} 
                        y={24} 
                        textAnchor="middle" 
                        className="text-base font-black fill-slate-800 tracking-wider"
                      >
                        PPC
                      </text>

                      {/* Grid Lines */}
                      {ppcEvolutionChart.yTicks.map(val => {
                        const y = ppcEvolutionChart.getY(val);
                        return (
                          <g key={val} className="opacity-20">
                            <line 
                              x1={ppcEvolutionChart.mLeft} 
                              y1={y} 
                              x2={ppcEvolutionChart.width - 20} 
                              y2={y} 
                              stroke="#64748b" 
                              strokeWidth="1"
                            />
                            <text 
                              x={ppcEvolutionChart.mLeft - 8} 
                              y={y + 4} 
                              textAnchor="end" 
                              className="text-[9px] font-bold fill-slate-500"
                            >
                              {val}%
                            </text>
                          </g>
                        );
                      })}

                      {/* X-axis labels and vertical ticks */}
                      {ppcEvolutionChart.xLabels.map((lbl, idx) => {
                        if (!lbl.shouldShow) return null;
                        return (
                          <g key={idx}>
                            <line 
                              x1={lbl.x} 
                              y1={ppcEvolutionChart.height - 50} 
                              x2={lbl.x} 
                              y2={ppcEvolutionChart.height - 55} 
                              stroke="#94a3b8" 
                              strokeWidth="1"
                            />
                            <text 
                              x={lbl.x} 
                              y={ppcEvolutionChart.height - 35} 
                              textAnchor="middle" 
                              className="text-[9px] font-black fill-slate-400 uppercase tracking-tighter"
                            >
                              {lbl.text}
                            </text>
                          </g>
                        );
                      })}

                      {/* Meta Target line (Constant 80%) */}
                      <line 
                        x1={ppcEvolutionChart.mLeft} 
                        y1={ppcEvolutionChart.yMeta} 
                        x2={ppcEvolutionChart.width - 20} 
                        y2={ppcEvolutionChart.yMeta} 
                        stroke="#84cc16" 
                        strokeWidth="3" 
                      />

                      {/* Line connecting the points */}
                      {ppcEvolutionChart.pathD && (
                        <path 
                          d={ppcEvolutionChart.pathD} 
                          fill="none" 
                          stroke="#6366f1" 
                          strokeWidth="3" 
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}

                      {/* Points markers and percentage values */}
                      {ppcEvolutionChart.validPoints.map((pt, idx) => {
                        const x = ppcEvolutionChart.getX(pt.index);
                        const y = ppcEvolutionChart.getY(pt.ppc!);
                        return (
                          <g key={idx} className="group cursor-pointer">
                            <circle 
                              cx={x} 
                              cy={y} 
                              r="5" 
                              fill="#6366f1" 
                              stroke="#ffffff" 
                              strokeWidth="1.5"
                              className="transition-transform group-hover:scale-125"
                            />
                            <text 
                              x={x} 
                              y={y - 8} 
                              textAnchor="middle" 
                              stroke="#ffffff"
                              strokeWidth="3"
                              paintOrder="stroke fill"
                              className="text-[9px] font-black fill-slate-800"
                            >
                              {pt.ppc}%
                            </text>
                          </g>
                        );
                      })}

                      {/* Legend at the bottom */}
                      <g transform={`translate(${ppcEvolutionChart.width / 2 - 50}, ${ppcEvolutionChart.height - 12})`} className="text-[10px] font-bold">
                        <line x1="0" y1="-3" x2="15" y2="-3" stroke="#6366f1" strokeWidth="3" />
                        <text x="20" y="1" className="fill-slate-600 font-black">PPC</text>
                        
                        <line x1="60" y1="-3" x2="75" y2="-3" stroke="#84cc16" strokeWidth="3" />
                        <text x="80" y="1" className="fill-slate-600 font-black">META</text>
                      </g>
                    </svg>
                  </div>
                ) : (
                  <div className="py-12 text-center text-slate-400 text-xs font-bold uppercase italic">
                    Nenhum dado disponível para plotagem da curva neste período.
                  </div>
                )}
              </div>

              {/* Delay Causes (Pie Chart) */}
              <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200">
                <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider mb-2">Causas</h3>
                <p className="text-[10px] text-slate-500 mb-4">Proporção dos maiores motivos de desvio nas atividades neste período.</p>
                
                {delayCausesData.length > 0 ? (
                  <div className="flex flex-col sm:flex-row items-center justify-around gap-6 py-2">
                    
                    {/* SVG Pie Chart (Solid) */}
                    <div className="w-48 h-48 relative flex-shrink-0">
                      <svg viewBox="-90 -90 180 180" className="w-full h-full transform -rotate-90">
                        {pieChartSlices.map((slice, idx) => {
                          if (slice.percentVal >= 0.99) {
                            return (
                              <circle 
                                key={idx} 
                                cx="0" 
                                cy="0" 
                                r="80" 
                                fill={slice.color} 
                              />
                            );
                          }
                          return (
                            <path 
                              key={idx} 
                              d={slice.pathData} 
                              fill={slice.color}
                              className="hover:opacity-90 transition-opacity cursor-pointer"
                            >
                              <title>{`${slice.reason}: ${slice.count} (${slice.percent}%)`}</title>
                            </path>
                          );
                        })}
                        
                        {/* Slice percentages inside slices */}
                        {pieChartSlices.map((slice, idx) => {
                          if (slice.percent < 4) return null;
                          const labelCoords = slice.labelCoords;
                          return (
                            <text
                              key={idx}
                              x={labelCoords.x}
                              y={labelCoords.y}
                              transform={`rotate(90, ${labelCoords.x}, ${labelCoords.y})`}
                              textAnchor="middle"
                              dominantBaseline="central"
                              className="text-[9px] font-black fill-white pointer-events-none"
                            >
                              {slice.percent}%
                            </text>
                          );
                        })}
                      </svg>
                    </div>

                    {/* Legend */}
                    <div className="flex-1 space-y-2">
                      <div className="text-[9px] font-black text-slate-400 uppercase tracking-tight border-b pb-1 mb-2">Motivos de Desvio</div>
                      {pieChartSlices.map((slice, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs">
                          <span 
                            className="w-3.5 h-3.5 rounded-sm mt-0.5 flex-shrink-0" 
                            style={{ backgroundColor: slice.color }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-slate-700 truncate text-[11px]" title={slice.reason}>
                              {slice.reason}
                            </p>
                            <p className="text-[9px] text-slate-400 font-bold uppercase">
                              {slice.count} {slice.count === 1 ? 'ocorrência' : 'ocorrências'} ({slice.percent}%)
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>

                  </div>
                ) : (
                  <div className="py-12 text-center text-slate-400 text-xs font-bold uppercase italic">
                    Sem justificativas de atraso registradas para este período.
                  </div>
                )}
              </div>

            </div>

          </div>
        ) : (
          <div className="bg-white p-12 rounded-2xl shadow-md border border-slate-200 text-center text-slate-400 font-medium italic">
            Selecione um empreiteiro para visualizar os detalhamentos de PPC e desvios.
          </div>
        )}
      </div>
    );
  };

  const handleSelectProject = (projId: string) => {
    localStorage.setItem('selected_project_id', projId);
    setSelectedProjectId(projId);
  };

  const handleAddNewProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjName.trim() || !newProjArea.trim() || !newProjAddress.trim()) {
      setNotification({ message: 'Por favor, preencha o nome, a área e o endereço.', type: 'error' });
      return;
    }
    const cleanId = slugify(newProjName);
    if (projects.some(p => p.id === cleanId)) {
      setNotification({ message: 'Um projeto com esse nome já existe.', type: 'error' });
      return;
    }
    const defaultImage = 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=600&auto=format&fit=crop&q=60';
    const newProj = {
      id: cleanId,
      name: newProjName.trim().toUpperCase(),
      type: 'Obra',
      area: parseFloat(newProjArea.trim()).toFixed(2),
      badges: newProjBadges.split(',').map(b => b.trim().toUpperCase()).filter(b => b.length > 0),
      address: newProjAddress.trim(),
      imageUrl: newProjImageUrl.trim() || defaultImage
    };
    
    try {
      const updatedList = [...projects, newProj];
      const projectsDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'all_projects_metadata');
      await setDoc(projectsDocRef, { list: updatedList });
      setProjects(updatedList);
      
      setShowAddProjectModal(false);
      setNewProjName('');
      setNewProjArea('');
      setNewProjAddress('');
      setNewProjBadges('');
      setNewProjImageUrl('');
      setNotification({ message: 'Projeto adicionado com sucesso!', type: 'success' });
    } catch (err) {
      console.error('Error adding project:', err);
      setNotification({ message: 'Erro ao adicionar projeto.', type: 'error' });
    }
  };

  const compressAndSetImage = (file: File, isEdit: boolean) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        const MAX_SIZE = 600;
        if (width > height) {
          if (width > MAX_SIZE) {
            height *= MAX_SIZE / width;
            width = MAX_SIZE;
          }
        } else {
          if (height > MAX_SIZE) {
            width *= MAX_SIZE / height;
            height = MAX_SIZE;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const base64 = canvas.toDataURL('image/jpeg', 0.6);
          if (isEdit) {
            setEditProjImageUrl(base64);
          } else {
            setNewProjImageUrl(base64);
          }
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleAddImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      compressAndSetImage(file, false);
    }
  };

  const handleEditImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      compressAndSetImage(file, true);
    }
  };

  const handleOpenEditProject = (p: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingProject(p);
    setEditProjName(p.name);
    setEditProjArea(p.area || '');
    setEditProjAddress(p.address || '');
    setEditProjBadges((p.badges || []).join(', '));
    setEditProjImageUrl(p.imageUrl || '');
  };

  const handleUpdateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject) return;
    if (!editProjName.trim() || !editProjArea.trim() || !editProjAddress.trim()) {
      setNotification({ message: 'Por favor, preencha o nome, a área e o endereço.', type: 'error' });
      return;
    }
    
    try {
      const updatedList = projects.map(p => {
        if (p.id === editingProject.id) {
          return {
            ...p,
            name: editProjName.trim().toUpperCase(),
            area: parseFloat(editProjArea.trim()).toFixed(2),
            badges: editProjBadges.split(',').map(b => b.trim().toUpperCase()).filter(b => b.length > 0),
            address: editProjAddress.trim(),
            imageUrl: editProjImageUrl.trim()
          };
        }
        return p;
      });
      
      const projectsDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'all_projects_metadata');
      await setDoc(projectsDocRef, { list: updatedList });
      setProjects(updatedList);
      
      setEditingProject(null);
      setNotification({ message: 'Projeto atualizado com sucesso!', type: 'success' });
    } catch (err) {
      console.error('Error updating project:', err);
      setNotification({ message: 'Erro ao atualizar projeto.', type: 'error' });
    }
  };

  const renderProjectsDashboard = () => {
    // 1. Filtragem por busca
    let filtered = projects.filter(p => 
      p.name.toLowerCase().includes(projectSearchQuery.toLowerCase()) ||
      p.address.toLowerCase().includes(projectSearchQuery.toLowerCase())
    );

    // 2. Filtragem por controle de acesso
    const isSystemAdmin = (plannerUsername || '').toLowerCase() === 'admin' || isAccessAdmin;
    const isUserRegistered = accessControl.users.map(u => u.toLowerCase()).includes((plannerUsername || '').toLowerCase());
    
    if (!isSystemAdmin && isUserRegistered) {
      filtered = filtered.filter(p => {
        const allowedUsers = accessControl.projectAccess[p.id] || [];
        return allowedUsers.map(u => u.toLowerCase()).includes((plannerUsername || '').toLowerCase());
      });
    }

    const filteredProjects = filtered;

    return (
      <div className="min-h-screen bg-slate-950 font-sans text-slate-100 p-6 md:p-12 relative overflow-hidden flex flex-col justify-between">
        {/* Background blobs */}
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-900/20 blur-[130px] pointer-events-none"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-emerald-900/10 blur-[130px] pointer-events-none"></div>

        <div className="max-w-[1400px] w-full mx-auto space-y-8 relative z-10">
          
          {/* Header */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-slate-800 pb-6">
            <div>
              <h1 className="text-xl md:text-2xl font-black uppercase tracking-tight text-white leading-none">PLANEJAMENTO DE CURTO PRAZO</h1>
              <p className="text-xs text-indigo-400 font-bold uppercase tracking-widest mt-1">Gestão e controle de obras</p>
            </div>
            
            {/* Operator, Search and Access Control */}
            <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
              <button 
                onClick={() => {
                  setAccessUser('');
                  setAccessPassword('');
                  setShowAccessModal(true);
                }}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-900/60 border border-slate-800 hover:border-indigo-500/50 hover:bg-slate-900 text-xs font-bold text-slate-300 hover:text-white rounded-xl transition cursor-pointer"
                title="Configurações de Controle de Acesso"
              >
                🔐 {isAccessAdmin ? 'Acesso Admin' : 'Controle de Acesso'}
              </button>

              <div className="flex items-center gap-2 px-4 py-2 bg-slate-900/60 border border-slate-800 rounded-xl text-xs font-bold text-slate-300">
                <span>👤 Operador: <b>{plannerUsername}</b></span>
                <button 
                  onClick={() => {
                    localStorage.removeItem('planner_username');
                    setPlannerUsername('');
                  }}
                  className="text-slate-550 hover:text-white font-black ml-1 text-sm leading-none"
                  title="Alterar operador"
                >
                  &times;
                </button>
              </div>

              <input 
                type="text"
                placeholder="Buscar projeto..."
                value={projectSearchQuery}
                onChange={e => setProjectSearchQuery(e.target.value)}
                className="px-4 py-2 bg-slate-900/50 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-500 focus:ring-2 focus:ring-indigo-500 outline-none w-full sm:w-48 transition"
              />
            </div>
          </div>

          {/* Title Area */}
          <div className="space-y-1">
            <h2 className="text-base md:text-lg font-black uppercase tracking-tight text-slate-200">Meus projetos</h2>
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Selecione uma obra abaixo para acessar as medições e planejamento semanal.</p>
          </div>

          {/* Grid of Projects */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            
            {filteredProjects.map((p) => {
              const maxBadges = 8;
              const displayBadges = (p.badges || []).slice(0, maxBadges);
              const extraBadgesCount = (p.badges || []).length - maxBadges;

              return (
                <div key={p.id} className="bg-slate-900/65 backdrop-blur-md border border-slate-800/85 rounded-2xl shadow-xl overflow-hidden flex flex-col justify-between hover:border-indigo-500/50 transition-all duration-300 group">
                  {/* Card Image and Title */}
                  <div>
                    <div className="p-4 border-b border-slate-850 flex justify-between items-center bg-slate-900/30">
                      <div>
                        <h3 className="text-sm font-black uppercase text-white tracking-tight">{p.name}</h3>
                        <p className="text-[10px] text-slate-500 italic font-medium">{p.type || 'Obra'}</p>
                      </div>
                      {isSystemAdmin && (
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={(e) => handleOpenEditProject(p, e)}
                            className="text-slate-600 hover:text-indigo-400 p-1 rounded transition cursor-pointer"
                            title="Editar informações do projeto"
                          >
                            <span className="text-xs">✏️</span>
                          </button>
                          <button 
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (confirm(`Deseja excluir o projeto "${p.name}"? Isso não apagará seus dados históricos do banco.`)) {
                                const newList = projects.filter(x => x.id !== p.id);
                                const projectsDocRef = doc(db, `artifacts/${appId}/public/data/project_measurements`, 'all_projects_metadata');
                                await setDoc(projectsDocRef, { list: newList });
                                setProjects(newList);
                                setNotification({ message: 'Projeto removido da lista!', type: 'success' });
                              }
                            }}
                            className="text-slate-600 hover:text-rose-400 p-1 rounded transition cursor-pointer"
                            title="Remover projeto da lista"
                          >
                            <span className="text-xs">🗑️</span>
                          </button>
                        </div>
                      )}
                    </div>
                    
                    {/* Site Render image */}
                    <div className="h-44 w-full overflow-hidden bg-slate-950 relative">
                      <img 
                        src={p.imageUrl} 
                        alt={p.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-85 group-hover:opacity-100"
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=600&auto=format&fit=crop&q=60';
                        }}
                      />
                    </div>
                    
                    {/* Project Specs */}
                    <div className="p-4 space-y-3.5 text-xs text-slate-300">
                      {/* Area */}
                      <div className="flex items-center gap-2.5">
                        <span className="text-slate-500 text-xs w-4 text-center">📐</span>
                        <span className="font-bold text-[11px] text-slate-400 bg-slate-950/40 px-2 py-0.5 border border-slate-800 rounded font-mono">
                          {p.area ? `${parseFloat(p.area).toLocaleString('pt-BR')} m²` : '0 m²'}
                        </span>
                      </div>
                      
                      {/* Badges / Equipes */}
                      <div className="flex items-start gap-2.5">
                        <span className="text-slate-500 text-xs w-4 text-center mt-0.5">👥</span>
                        <div className="flex flex-wrap gap-1">
                          {displayBadges.map((b: string, i: number) => (
                            <span key={i} className="px-1.5 py-0.5 bg-slate-800 text-slate-400 border border-slate-700 text-[8px] font-black uppercase rounded">
                              {b}
                            </span>
                          ))}
                          {extraBadgesCount > 0 && (
                            <span className="px-1.5 py-0.5 bg-indigo-950/50 text-indigo-400 border border-indigo-900/50 text-[8px] font-black uppercase rounded">
                              +{extraBadgesCount}
                            </span>
                          )}
                          {(p.badges || []).length === 0 && (
                            <span className="text-[10px] text-slate-500 italic">Nenhuma equipe cadastrada</span>
                          )}
                        </div>
                      </div>

                      {/* Address */}
                      <div className="flex items-start gap-2.5 leading-relaxed">
                        <span className="text-slate-500 text-xs w-4 text-center mt-0.5">📍</span>
                        <span className="text-[10px] text-slate-400 line-clamp-2" title={p.address}>
                          {p.address}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Select button */}
                  <div className="p-4 border-t border-slate-850/60 bg-slate-900/10">
                    <button
                      onClick={() => handleSelectProject(p.id)}
                      className="w-full py-2 border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-600 hover:border-indigo-600 text-indigo-400 hover:text-white font-black uppercase text-[10px] tracking-wider rounded-xl transition active:scale-98 cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      Selecionar
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Add New Project Card */}
            {isSystemAdmin && (
              <div 
                onClick={() => setShowAddProjectModal(true)}
                className="border-2 border-dashed border-slate-800 hover:border-indigo-500/50 bg-slate-900/20 hover:bg-slate-900/40 rounded-2xl min-h-[360px] flex flex-col items-center justify-center p-6 text-center cursor-pointer transition-all duration-300 group"
              >
                <div className="w-12 h-12 rounded-full border border-slate-800 group-hover:border-indigo-500/40 flex items-center justify-center bg-slate-900/60 group-hover:bg-indigo-500/10 text-slate-500 group-hover:text-indigo-400 text-xl font-bold transition mb-3">
                  +
                </div>
                <h3 className="text-xs font-black uppercase text-slate-400 group-hover:text-indigo-300 tracking-wider">Adicionar Novo Projeto</h3>
                <p className="text-[9px] text-slate-650 group-hover:text-slate-500 uppercase tracking-tight mt-1 max-w-[200px] font-bold">Cadastrar nova obra no banco de dados.</p>
              </div>
            )}

          </div>

          {filteredProjects.length === 0 && !isSystemAdmin && (
            <div className="bg-slate-900/40 border border-slate-800/80 p-12 rounded-3xl text-center max-w-md mx-auto space-y-4 my-8">
              <span className="text-4xl block">📭</span>
              <h3 className="text-sm font-black uppercase text-slate-300 tracking-wider">Nenhuma Obra Associada</h3>
              <p className="text-[10px] text-slate-550 uppercase tracking-tight font-bold leading-relaxed">
                Você não possui permissão de acesso a nenhum projeto no momento. <br />
                Por favor, solicite a liberação ao administrador do sistema.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="max-w-[1400px] w-full mx-auto text-center border-t border-slate-900 pt-6 mt-8 relative z-10 text-[9px] text-slate-600 uppercase font-black tracking-widest">
          PLANEJAMENTO DE CURTO PRAZO &copy; {new Date().getFullYear()} &middot; Gestão e controle de obras
        </div>

        {/* Add Project Modal */}
        {showAddProjectModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl shadow-2xl max-w-md w-full space-y-6 animate-in zoom-in-95 duration-200 text-left text-slate-200">
              <div className="space-y-1">
                <h3 className="text-sm font-black uppercase tracking-tight text-white">Cadastrar Novo Projeto</h3>
                <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">Insira os dados da nova obra abaixo</p>
              </div>

              <form onSubmit={handleAddNewProject} className="space-y-4">
                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Nome da Obra</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: QOYA, PACE..."
                    value={newProjName}
                    onChange={e => setNewProjName(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Área Privativa / Construída (m²)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="Ex: 16777.23"
                    value={newProjArea}
                    onChange={e => setNewProjArea(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Endereço Completo</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: R. Buenos Aires, 572 - Curitiba..."
                    value={newProjAddress}
                    onChange={e => setNewProjAddress(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Siglas das Equipes (badges, separadas por vírgula)</label>
                  <input
                    type="text"
                    placeholder="Ex: PF, PE, PK, RT, AO..."
                    value={newProjBadges}
                    onChange={e => setNewProjBadges(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                  <span className="block text-[8px] text-slate-500">Deixe em branco para usar as siglas padrão de equipes.</span>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Imagem de Capa (PNG/JPG ou URL)</label>
                  <div className="flex gap-2">
                    <label className="flex-1 flex flex-col items-center justify-center p-3 bg-slate-950 border border-dashed border-slate-800 hover:border-indigo-500/50 rounded-xl cursor-pointer text-slate-450 hover:text-white transition">
                      <span className="text-[10px] uppercase font-black">📁 Selecionar Foto</span>
                      <input 
                        type="file" 
                        accept="image/png, image/jpeg, image/jpg" 
                        onChange={handleAddImageFileChange}
                        className="hidden" 
                      />
                    </label>
                  </div>
                  <input
                    type="url"
                    placeholder="Ou cole o link da imagem (URL)..."
                    value={newProjImageUrl}
                    onChange={e => setNewProjImageUrl(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-650 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                  {newProjImageUrl && (
                    <div className="mt-2 h-16 w-full rounded-lg overflow-hidden border border-slate-800 bg-slate-950 flex items-center justify-center">
                      <img src={newProjImageUrl} alt="Preview" className="h-full w-full object-cover" />
                    </div>
                  )}
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddProjectModal(false)}
                    className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 font-black uppercase text-[10px] tracking-wider rounded-xl transition active:scale-98 cursor-pointer text-center border border-slate-700"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-[10px] tracking-wider rounded-xl shadow-lg transition active:scale-98 cursor-pointer"
                  >
                    Salvar Projeto
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Edit Project Modal */}
        {editingProject && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl shadow-2xl max-w-md w-full space-y-6 animate-in zoom-in-95 duration-200 text-left text-slate-200">
              <div className="space-y-1">
                <h3 className="text-sm font-black uppercase tracking-tight text-white">Editar Informações da Obra</h3>
                <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">Modifique os dados do projeto abaixo</p>
              </div>

              <form onSubmit={handleUpdateProject} className="space-y-4">
                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Nome da Obra</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: QOYA, PACE..."
                    value={editProjName}
                    onChange={e => setEditProjName(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Área Privativa / Construída (m²)</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    placeholder="Ex: 16777.23"
                    value={editProjArea}
                    onChange={e => setEditProjArea(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Endereço Completo</label>
                  <input
                    type="text"
                    required
                    placeholder="Ex: R. Buenos Aires, 572 - Curitiba..."
                    value={editProjAddress}
                    onChange={e => setEditProjAddress(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Siglas das Equipes (badges, separadas por vírgula)</label>
                  <input
                    type="text"
                    placeholder="Ex: PF, PE, PK, RT, AO..."
                    value={editProjBadges}
                    onChange={e => setEditProjBadges(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-650 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Imagem de Capa (PNG/JPG ou URL)</label>
                  <div className="flex gap-2">
                    <label className="flex-1 flex flex-col items-center justify-center p-3 bg-slate-950 border border-dashed border-slate-800 hover:border-indigo-500/50 rounded-xl cursor-pointer text-slate-450 hover:text-white transition">
                      <span className="text-[10px] uppercase font-black">📁 Selecionar Foto</span>
                      <input 
                        type="file" 
                        accept="image/png, image/jpeg, image/jpg" 
                        onChange={handleEditImageFileChange}
                        className="hidden" 
                      />
                    </label>
                  </div>
                  <input
                    type="url"
                    placeholder="Ou cole o link da imagem (URL)..."
                    value={editProjImageUrl}
                    onChange={e => setEditProjImageUrl(e.target.value)}
                    className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-650 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                  />
                  {editProjImageUrl && (
                    <div className="mt-2 h-16 w-full rounded-lg overflow-hidden border border-slate-800 bg-slate-950 flex items-center justify-center">
                      <img src={editProjImageUrl} alt="Preview" className="h-full w-full object-cover" />
                    </div>
                  )}
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingProject(null)}
                    className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 font-black uppercase text-[10px] tracking-wider rounded-xl transition active:scale-98 cursor-pointer text-center border border-slate-700"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-[10px] tracking-wider rounded-xl shadow-lg transition active:scale-98 cursor-pointer"
                  >
                    Salvar Alterações
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Access Control Modal */}
        {showAccessModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-800 p-6 rounded-3xl shadow-2xl max-w-2xl w-full space-y-6 animate-in zoom-in-95 duration-200 text-left text-slate-200 max-h-[90vh] overflow-y-auto relative">
              <button 
                onClick={() => setShowAccessModal(false)}
                className="absolute top-4 right-4 text-slate-500 hover:text-white font-black text-lg leading-none cursor-pointer p-1"
                title="Fechar modal"
              >
                &times;
              </button>
              
              {!isAccessAdmin ? (
                // 1. Tela de Login de Administrador
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (accessUser === 'admin' && accessPassword === 'admin') {
                      setIsAccessAdmin(true);
                      setNotification({ message: 'Autenticado como Administrador!', type: 'success' });
                    } else {
                      setNotification({ message: 'Usuário ou senha incorretos.', type: 'error' });
                    }
                  }} 
                  className="space-y-4 max-w-xs mx-auto text-center"
                >
                  <span className="text-3xl block">🔐</span>
                  <div className="space-y-1 text-left">
                    <h3 className="text-sm font-black uppercase text-white text-center">Acesso Administrativo</h3>
                    <p className="text-[9px] text-slate-500 text-center uppercase tracking-wider font-bold">Autentique-se para gerenciar permissões</p>
                  </div>

                  <div className="space-y-3 pt-2 text-left">
                    <div>
                      <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black mb-1">Usuário</label>
                      <input 
                        type="text" 
                        required 
                        value={accessUser} 
                        onChange={e => setAccessUser(e.target.value)} 
                        className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black mb-1">Senha</label>
                      <input 
                        type="password" 
                        required 
                        value={accessPassword} 
                        onChange={e => setAccessPassword(e.target.value)} 
                        className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <button 
                      type="button" 
                      onClick={() => setShowAccessModal(false)} 
                      className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-400 font-black uppercase text-[10px] tracking-wider rounded-xl border border-slate-700 cursor-pointer"
                    >
                      Voltar
                    </button>
                    <button 
                      type="submit" 
                      className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-[10px] tracking-wider rounded-xl shadow-lg cursor-pointer"
                    >
                      Autenticar
                    </button>
                  </div>
                </form>
              ) : (
                // 2. Tela de Configurações Administrativas
                <div className="space-y-6">
                  <div className="flex justify-between items-center border-b border-slate-800 pb-3">
                    <div>
                      <h3 className="text-sm font-black uppercase tracking-tight text-white">Painel de Controle de Acesso</h3>
                      <p className="text-[9px] text-indigo-400 font-bold uppercase tracking-wider">Gerencie permissões de acesso por obra</p>
                    </div>
                    <button 
                      onClick={() => setIsAccessAdmin(false)} 
                      className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-450 font-black uppercase text-[8px] tracking-wider rounded-lg border border-slate-700 cursor-pointer"
                    >
                      Sair Admin
                    </button>
                  </div>

                  {/* Gerenciamento de Usuários */}
                  <div className="bg-slate-950/40 border border-slate-850 p-4 rounded-2xl space-y-3">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-350">1. Cadastrar Usuários</h4>
                    <div className="flex gap-2 max-w-md">
                      <input 
                        type="text" 
                        placeholder="Nome do usuário/função (ex: Felipe, Engenharia)..." 
                        value={newAccessUser} 
                        onChange={e => setNewAccessUser(e.target.value)} 
                        className="flex-1 p-2 bg-slate-950 border border-slate-800 rounded-xl text-xs font-bold text-white placeholder-slate-650 focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                      <button 
                        onClick={handleAddUser} 
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-[10px] tracking-wider rounded-xl cursor-pointer"
                      >
                        + Cadastrar
                      </button>
                    </div>

                    <div className="space-y-1.5 pt-1">
                      <span className="block text-[8px] text-slate-500 uppercase tracking-widest font-black">Usuários Cadastrados:</span>
                      <div className="flex flex-wrap gap-1.5">
                        {accessControl.users.map(u => (
                          <span key={u} className="bg-slate-900 border border-slate-800 text-slate-300 font-bold text-[10px] px-2.5 py-1 rounded-xl flex items-center gap-1.5 hover:border-slate-700 transition">
                            <span>👤 {u}</span>
                            <button 
                              onClick={() => handleRemoveUser(u)} 
                              className="text-slate-550 hover:text-red-400 font-black text-xs cursor-pointer"
                              title={`Excluir ${u}`}
                            >
                              &times;
                            </button>
                          </span>
                        ))}
                        {accessControl.users.length === 0 && (
                          <span className="text-[10px] text-slate-550 italic uppercase font-bold">Nenhum usuário cadastrado.</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Associação com Obras */}
                  <div className="space-y-3">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-350">2. Permissões de Acesso por Obra</h4>
                    <p className="text-[9px] text-slate-500 uppercase tracking-tight font-bold">Clique no usuário sob o projeto correspondente para alternar a permissão de acesso.</p>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[350px] overflow-y-auto pr-1">
                      {projects.map(p => {
                        const allowed = accessControl.projectAccess[p.id] || [];
                        return (
                          <div key={p.id} className="bg-slate-950/30 border border-slate-850 p-3 rounded-2xl space-y-2.5">
                            <div className="flex justify-between items-start border-b border-slate-850/80 pb-1.5">
                              <div>
                                <span className="block text-[11px] font-black uppercase text-white leading-tight">{p.name}</span>
                                <span className="block text-[8px] text-slate-500 italic mt-0.5">{p.address}</span>
                              </div>
                              <span className="bg-indigo-950 border border-indigo-900 text-indigo-400 font-black text-[8px] px-1.5 py-0.5 rounded-md uppercase">
                                {allowed.length} Permissão(ões)
                              </span>
                            </div>

                            <div className="flex flex-wrap gap-1.5">
                              {accessControl.users.map(u => {
                                const isAllowed = allowed.includes(u);
                                return (
                                  <button
                                    key={u}
                                    onClick={() => handleToggleProjectAccess(p.id, u)}
                                    className={`px-2 py-1 rounded-xl text-[9px] font-black uppercase tracking-wider transition cursor-pointer flex items-center gap-1 active:scale-95 ${
                                      isAllowed 
                                        ? 'bg-emerald-600 border border-emerald-500 text-white shadow-sm' 
                                        : 'bg-slate-900 border border-slate-800 text-slate-400 hover:border-slate-700'
                                    }`}
                                  >
                                    <span>{isAllowed ? '✓' : '+'}</span>
                                    <span>{u}</span>
                                  </button>
                                );
                              })}
                              {accessControl.users.length === 0 && (
                                <span className="text-[9px] text-slate-550 italic uppercase font-bold">Cadastre usuários no painel acima primeiro.</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Histórico de Acessos Recentes */}
                  <div className="bg-slate-950/40 border border-slate-850 p-4 rounded-2xl space-y-2.5">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-slate-350 flex justify-between items-center">
                      <span>3. Histórico de Acessos Recentes</span>
                      <button 
                        onClick={async () => {
                          if (confirm('Deseja limpar todos os logs de acesso?')) {
                            const updated = { ...accessControl, logs: [] };
                            setAccessControl(updated);
                            await handleSaveAccessControl(updated);
                          }
                        }}
                        className="text-[8px] font-black uppercase text-rose-400 hover:text-rose-350 cursor-pointer"
                      >
                        Limpar Histórico
                      </button>
                    </h4>
                    <div className="max-h-[140px] overflow-y-auto pr-1 space-y-1.5 font-mono text-[9px] text-slate-400">
                      {(accessControl.logs || []).map((log, i) => (
                        <div key={i} className="flex justify-between items-center bg-slate-900/60 border border-slate-850 px-2.5 py-1.5 rounded-lg hover:border-slate-800 transition">
                          <span className="font-bold text-slate-300">👤 {log.username}</span>
                          <span className="text-slate-500 font-medium">{new Date(log.timestamp).toLocaleString('pt-BR')}</span>
                        </div>
                      ))}
                      {(accessControl.logs || []).length === 0 && (
                        <span className="text-[9px] text-slate-550 italic uppercase font-bold block py-2 text-center">Nenhum acesso registrado.</span>
                      )}
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-850 flex justify-end">
                    <button 
                      onClick={() => setShowAccessModal(false)} 
                      className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-[10px] tracking-wider rounded-xl shadow-lg transition active:scale-98 cursor-pointer"
                    >
                      Fechar Configurações
                    </button>
                  </div>
                </div>
              )}

            </div>
          </div>
        )}
      </div>
    );
  };

  const renderInfographic = () => (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <h3 className="text-sm font-black text-slate-800 uppercase mb-4">Evolução Semanal de PPC do Projeto</h3>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          {(ppcHistory || []).map((h, i) => {
            const ppcVal = typeof h?.ppc === 'number' ? h.ppc : parseFloat(h?.ppc) || 0;
            return (
              <div key={i} className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col justify-between">
                <div className="text-[10px] font-black text-slate-400 uppercase">Semana de {formatDateBR(h?.weekStart)}</div>
                <div className="text-2xl font-black text-indigo-900 mt-1">{ppcVal.toFixed(1)}%</div>
                <div className="text-[10px] text-slate-500 font-bold uppercase mt-2">{h?.completed ?? 0} / {h?.totalPlanned ?? 0} planos concluídos</div>
              </div>
            );
          })}
          {(ppcHistory || []).length === 0 && <div className="col-span-full py-8 text-center text-xs text-slate-400 font-bold uppercase italic font-mono">Nenhuma semana encerrada no banco de dados.</div>}
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-4">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 border-b pb-4">
          <div>
            <h3 className="text-sm font-black text-slate-800 uppercase">Tabela Consolidada de Planejamento Semanal (Histórico Geral)</h3>
          </div>
          <button onClick={handleExportCSV} className="px-5 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs uppercase tracking-wider rounded-xl shadow-lg flex items-center gap-2 transition"><span>📥</span> Exportar para Excel (.csv)</button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Pesquisa</label><input type="text" className="w-full p-2 border rounded-lg text-xs" placeholder="Pesquise..." value={giantSearch} onChange={e => setHistorySearch(e.target.value)} /></div>
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Pavimento</label><select className="w-full p-2 border rounded-lg text-xs font-bold" value={giantFloorFilter} onChange={e => setHistoryFloorFilter(e.target.value)}><option value="">-- Todos --</option>{(floors || []).map(f => <option key={f} value={f}>{f}</option>)}</select></div>
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Macroatividade</label><select className="w-full p-2 border rounded-lg text-xs font-bold" value={giantMacroFilter} onChange={e => setHistoryMacroFilter(e.target.value)}><option value="">-- Todas --</option>{(allPossibleMacros || []).map(sId => <option key={sId} value={sId}>{getMacroTitle(sId)}</option>)}</select></div>
          <div><label className="block text-[9px] font-black uppercase text-slate-400 mb-1">Estado</label><select className="w-full p-2 border rounded-lg text-xs font-bold" value={giantStatusFilter} onChange={e => setHistoryStatusFilter(e.target.value)}><option value="">-- Todos --</option><option value="finalized">🔒 Somente Finalizadas</option><option value="active">🔓 Somente Ativas</option></select></div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-[500px]">
          <table className="w-full text-[11px] text-left border-collapse">
            <thead className="bg-slate-800 text-white uppercase text-[9px] tracking-tight sticky top-0 z-10">
              <tr>
                {[
                  { label: 'Semana ID', key: 'weekId', cls: '' },
                  { label: 'Pavimento', key: 'floor', cls: '' },
                  { label: 'Macroatividade', key: 'sectionId', cls: '' },
                  { label: 'Serviço', key: 'activityName', cls: '' },
                  { label: 'Equipe', key: 'responsible', cls: '' },
                  { label: 'Meta Plan.', key: 'plannedThisWeek', cls: 'text-center' },
                  { label: 'Dias Ativos', key: null, cls: 'text-center' },
                  { label: 'Avanço Sem.', key: 'progressThisWeek', cls: 'text-center' },
                  { label: 'Acumulado', key: 'accumulated', cls: 'text-center' },
                  { label: 'Desvio/Atraso', key: null, cls: 'text-center' },
                  { label: 'Observações', key: null, cls: '' },
                  { label: 'Estado', key: null, cls: 'text-center' },
                ].map(({ label, key, cls }) => (
                  <th
                    key={label}
                    className={`p-3 border-r border-slate-700 select-none whitespace-nowrap ${cls} ${key ? 'cursor-pointer hover:bg-slate-700 transition-colors' : ''}`}
                    onClick={() => {
                      if (!key) return;
                      if (giantSortKey === key) setGiantSortDir(d => d === 'asc' ? 'desc' : 'asc');
                      else { setGiantSortKey(key); setGiantSortDir('asc'); }
                    }}
                  >
                    <span className="flex items-center gap-1">
                      {label}
                      {key && (
                        <span className={`text-[10px] ${giantSortKey === key ? 'opacity-100 text-indigo-300' : 'opacity-30'}`}>
                          {giantSortKey === key ? (giantSortDir === 'asc' ? '▲' : '▼') : '⇕'}
                        </span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {(filteredGiantPlanningTasks || []).map((t, idx) => {
                const executedB = Number(t?.executedBefore) || 0;
                const progressW = Number(t?.progressThisWeek) || 0;
                const totalAcc = Math.min(100, executedB + progressW);
                const cPlan = t?.plannedThisWeek ?? 100;
                const isDelayed = cPlan > progressW;
                return (
                  <tr key={idx} className={`hover:bg-slate-50/80 transition ${t?.finalized ? 'bg-slate-50/50 text-slate-500' : ''}`}>
                    <td className="p-2.5 border-r font-mono whitespace-nowrap">{t?.weekId}</td>
                    <td className="p-2.5 border-r font-bold whitespace-nowrap">{t?.floor}</td>
                    <td className="p-2.5 border-r uppercase font-medium">{t?.sectionId}</td>
                    <td className="p-2.5 border-r font-black text-slate-800 uppercase">{t?.activityName}</td>
                    <td className="p-2.5 border-r uppercase font-bold text-indigo-900 whitespace-nowrap">{t?.responsible}</td>
                    <td className="p-2.5 border-r text-center font-black">{cPlan}%</td>
                    <td className="p-2.5 border-r text-center">
                      <div className="flex gap-1 justify-center items-end h-9">
                        {(t?.dailyWork || [0,0,0,0,0]).map((dw, i) => {
                          const weekDate = parseISODateLocal(t.weekId);
                          const dayDate = addDays(weekDate, i);
                          const dayStr = toISODate(dayDate);
                          
                          const todayStart = new Date();
                          todayStart.setHours(0, 0, 0, 0);
                          const diffTime = dayDate.getTime() - todayStart.getTime();
                          const diffDays = Math.round(diffTime / 86400000);
                          const isWithinRange = diffDays >= -15 && diffDays <= 15;
                          
                          const cacheKey = `${projectCity.trim().toLowerCase()}_${dayStr}`;
                          const weather = isWithinRange ? weatherCache[cacheKey] : null;
                          const weatherEmoji = isWithinRange && weather ? getWeatherEmoji(weather.icon) : (isWithinRange && weatherLoading ? '⏳' : '');
                          const tempInfo = weather ? `${weather.conditions} (${weather.tempMin}°C - ${weather.tempMax}°C)` : (isWithinRange && weatherLoading ? 'Carregando...' : 'Sem dados');
                          
                          return (
                            <div key={i} className="flex flex-col items-center group relative cursor-help" title={`${['Seg','Ter','Qua','Qui','Sex'][i]} (${dayDate.toLocaleDateString('pt-BR')})${isWithinRange ? ` - Clima: ${tempInfo}` : ''}`}>
                              <span className="text-[10px] leading-none mb-0.5 select-none">{weatherEmoji || '\u00a0'}</span>
                              <span className={`w-6 h-6 rounded-full text-[8px] font-black flex items-center justify-center ${dw ? 'bg-slate-300 text-slate-700 shadow-inner border border-slate-400/20' : 'bg-slate-100 text-slate-300'}`}>
                                {['S','T','Q','Q','S'][i]}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </td>
                    <td className="p-2.5 border-r text-center font-black text-emerald-600">{progressW}%</td>
                    <td className="p-2.5 border-r text-center font-black"><div className="flex items-center justify-center space-x-1.5"><div className="w-10 bg-slate-200 rounded-full h-1.5 hidden sm:block"><div className="bg-slate-700 h-1.5 rounded-full" style={{ width: `${totalAcc}%` }}></div></div><span>{totalAcc.toFixed(0)}%</span></div></td>
                    <td className="p-2.5 border-r text-center font-bold">{isDelayed ? <span className="text-red-600 text-[10px] leading-tight block">⚠️ {t?.delayReason || 'N/A'}</span> : <span className="text-emerald-600">✓ Concluído</span>}</td>
                    <td className="p-2.5 border-r italic text-[10px] max-w-xs truncate" title={t?.observations}>{t?.observations || 'N/A'}</td>
                    <td className="p-2.5 text-center font-black whitespace-nowrap">{t?.finalized ? '🔒 Finalizado' : '🔓 Ativo'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
          <h3 className="text-sm font-black text-slate-800 uppercase">Evolução e Variação Acumulada por Pacote (Histórico Geral)</h3>
          <div className="relative w-full sm:w-64">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">🔍</span>
            <input
              type="text"
              className="w-full pl-7 pr-3 py-2 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-400 outline-none bg-slate-50"
              placeholder="Buscar pacote..."
              value={macroEvolutionSearch}
              onChange={e => setMacroEvolutionSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {(macroEvolutionHistory || []).filter(macro => !macroEvolutionSearch || (macro?.sectionTitle || '').toLowerCase().includes(macroEvolutionSearch.toLowerCase())).map((macro, idx) => (
            <div key={idx} className="p-5 bg-slate-50 rounded-2xl border border-slate-200 space-y-4">
              <div className="flex justify-between items-center border-b pb-2">
                <span className="text-[10px] font-black bg-indigo-100 text-indigo-700 px-2.5 py-1 rounded uppercase tracking-wider">{macro?.sectionTitle}</span>
                <span className="text-[10px] font-black text-slate-400 uppercase">Avanço Histórico do Pacote</span>
              </div>
              <div className="space-y-3 divide-y divide-slate-100">
                {(macro?.floors || []).map((fData, fIdx) => (
                  <div key={fIdx} className={`flex flex-col sm:flex-row sm:items-center gap-3 ${fIdx > 0 ? 'pt-3' : ''}`}>
                    <div className="sm:w-20 shrink-0 flex items-center">
                      <span className="text-xs font-black text-slate-700 uppercase">{fData.floor}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap flex-1">
                      <span className="text-[10px] font-bold text-slate-400">0%</span>
                      <span className="text-slate-300">→</span>
                      {(fData?.changes || []).map((change, cIdx) => {
                        const pctVal = Number(change?.macroPercent) || 0;
                        const isImported = change?.isImported;
                        
                        // Premium card-like styling for each weekly milestone
                        let boxBg = 'bg-slate-800 border-slate-700 hover:bg-slate-700';
                        let textColor = 'text-white';
                        let subTextColor = 'text-slate-400';
                        let labelText = change?.dateStr;
                        
                        if (isImported) {
                          boxBg = 'bg-slate-200 border-slate-300 hover:bg-slate-300';
                          textColor = 'text-slate-800';
                          subTextColor = 'text-slate-500';
                          labelText = 'Medido/Importado';
                        } else if (pctVal >= 99.9) {
                          boxBg = 'bg-emerald-600 border-emerald-500 hover:bg-emerald-700';
                          textColor = 'text-white';
                          subTextColor = 'text-emerald-200';
                        }
                        
                        return (
                          <React.Fragment key={cIdx}>
                            {cIdx > 0 && <span className="text-slate-300">→</span>}
                            <div className={`${boxBg} border px-3 py-2 rounded-lg text-center cursor-help transition-all hover:shadow-md hover:-translate-y-0.5 relative group min-w-[70px]`}>
                              <div className={`text-xs font-black ${textColor}`}>{pctVal.toFixed(1)}%</div>
                              <div className={`text-[8px] font-mono font-bold ${subTextColor}`}>{labelText}</div>
                              
                              {/* Detailed Hover Tooltip */}
                              <div className="opacity-0 group-hover:opacity-100 pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-slate-900 text-white text-[10px] p-3 rounded shadow-xl whitespace-nowrap z-10 transition-opacity border border-slate-700">
                                <p className="font-bold text-indigo-300 border-b border-slate-700 pb-1 mb-1">
                                  {isImported ? 'Medição Inicial/Importação:' : 'Serviços na Semana:'}
                                </p>
                                {(change?.services || []).map((s, sIdx) => {
                                  const sDelta = Number(s?.delta) || 0;
                                  return (
                                    <div key={sIdx} className="flex justify-between gap-4">
                                      <span>{s?.name || 'Sem Nome'}</span>
                                      <span className={sDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                        {sDelta >= 0 ? '+' : ''}{sDelta.toFixed(1)}%
                                      </span>
                                    </div>
                                  );
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
              </div>
            </div>
          ))}
          {(macroEvolutionHistory || []).length === 0 && <div className="text-center py-12 text-slate-400 font-bold uppercase italic text-xs">Nenhum dado de variação acumulada disponível.</div>}
        </div>
      </div>
    </div>
  );

  const renderConfig = () => (
    <div className="space-y-6 animate-in fade-in duration-300 pb-20">
      {/* 2-Column responsive grid for main config cards, aligning items at the start to allow variable heights */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        
        {/* Card 1: Gestão de Pavimentos / Lotes */}
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-4">
          <h2 className="text-sm font-black uppercase border-b pb-2 text-slate-800 tracking-wider">1. Gestão de Pavimentos / Lotes</h2>
          <div className="flex gap-2">
            <input type="text" placeholder="EX: TÉRREO, SUBSOLO..." className="flex-1 p-2.5 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 bg-slate-50 focus:bg-white transition outline-none uppercase font-bold text-slate-800" value={newFloorName} onChange={(e) => setNewFloorName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddFloor()} />
            <button onClick={handleAddFloor} className="bg-slate-800 text-white px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-slate-900 transition shadow-sm">ADICIONAR</button>
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            {floors.map(floor => (
              <div key={floor} className="flex items-center space-x-2 px-3 py-1.5 bg-slate-100 rounded-lg text-xs font-bold text-slate-700 border border-slate-200">
                <span>{floor}</span>
                <button onClick={() => triggerConfirm('Remover Pavimento', `Tem a certeza que deseja excluir "${floor}"?`, () => handleDeleteFloor(floor))} className="text-red-500 hover:text-red-700 font-black ml-1 text-sm">&times;</button>
              </div>
            ))}
          </div>
        </div>

        {/* Card 2: Estrutura de Macroatividades e Serviços */}
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-6">
          <div>
            <h2 className="text-sm font-black uppercase border-b pb-2 text-slate-800 tracking-wider">2. Estrutura de Macroatividades e Serviços</h2>
            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 mt-4">
              <h3 className="text-[10px] font-black uppercase tracking-wider text-indigo-600 mb-2.5">Criar Novo Pacote / Etapa</h3>
              <div className="flex gap-2">
                <input type="text" placeholder="EX: ALVENARIA, ACABAMENTOS..." className="flex-1 p-2.5 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 bg-slate-50 focus:bg-white transition outline-none uppercase font-bold text-slate-800" value={newPackageName} onChange={(e) => setNewPackageName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddNewPackageConfig()} />
                <button onClick={handleAddNewPackageConfig} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-indigo-700 transition shadow-sm">CRIAR</button>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2.5">Adicionar Item ao Pacote Selecionado</h3>
            <div className="flex flex-wrap gap-1 mb-3">
              {allPossibleMacros.map(sId => (
                <button key={sId} onClick={() => setActiveSection(sId)} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition ${activeSection === sId ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{getMacroTitle(sId)}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <input type="text" placeholder="EX: REBOCO, MASSA..." className="flex-1 p-2.5 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 bg-slate-50 focus:bg-white transition outline-none uppercase font-bold text-slate-800" value={newItemName} onChange={(e) => setNewItemName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddNewItemConfig()} />
              <button onClick={handleAddNewItemConfig} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-indigo-700 transition shadow-sm">ADICIONAR</button>
            </div>
            <div className="space-y-1.5 mt-4 border-t pt-3">
              {configItemsToDisplay.map(item => (
                <div key={item.id} className="flex justify-between items-center p-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-xl transition duration-150 text-xs">
                  <span className="font-bold text-slate-700">{item.name}</span>
                  <button onClick={() => handleDeleteItemConfig(item)} className="text-rose-600 hover:text-rose-700 font-black text-[10px] uppercase tracking-wider">Excluir</button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Card 3: Gestão de Equipes / Empreiteiros */}
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-4">
          <h2 className="text-sm font-black uppercase border-b pb-2 text-slate-800 tracking-wider">3. Gestão de Equipes / Empreiteiros</h2>
          <div className="flex gap-2 mb-4">
            <input type="text" placeholder="Nome da Equipe..." className="flex-1 p-2.5 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 bg-slate-50 focus:bg-white transition outline-none uppercase font-bold text-slate-800" value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddTeam()} />
            <button onClick={handleAddTeam} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-indigo-700 transition shadow-sm">REGISTAR</button>
          </div>
          <div className="space-y-2">
            {teams.map(team => (
              <div key={team} className="flex justify-between items-center p-2.5 bg-slate-50 hover:bg-slate-100/70 border border-slate-200 rounded-xl transition duration-200">
                <div className="flex-1 min-w-0 pr-3">
                  <div className="text-xs font-black text-slate-800 truncate uppercase">{team}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">Telefone:</span>
                  <input
                    type="text"
                    placeholder="+55 11 99999-9999"
                    className="w-36 p-1.5 text-[11px] border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 bg-white font-bold text-slate-700 outline-none font-mono"
                    value={teamPhones[team] || ''}
                    onChange={(e) => {
                      const newPhones = { ...teamPhones, [team]: e.target.value };
                      setTeamPhones(newPhones);
                    }}
                    onBlur={() => saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices, teamPhones)}
                  />
                  <button
                    onClick={() => triggerConfirm('Remover Equipe', `Deseja realmente excluir "${team}"?`, () => handleDeleteTeam(team))}
                    className="p-1.5 hover:bg-red-50 text-red-500 hover:text-red-700 rounded-lg transition text-xs"
                    title="Remover equipe"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            ))}
            {teams.length === 0 && (
              <div className="text-center py-6 text-slate-400 italic text-xs font-bold uppercase">Nenhuma equipe registrada.</div>
            )}
          </div>
        </div>

        {/* Card 4: Padronização de Motivos de Atraso */}
        <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-4">
          <h2 className="text-sm font-black uppercase border-b pb-2 text-slate-800 tracking-wider">4. Padronização de Motivos de Atraso</h2>
          <div className="flex gap-2 mb-4">
            <input type="text" placeholder="Descrição do motivo..." className="flex-1 p-2.5 text-xs border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 bg-slate-50 focus:bg-white transition outline-none font-bold text-slate-800" value={newDelayReason} onChange={(e) => setNewDelayReason(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAddDelayReason()} />
            <button onClick={handleAddDelayReason} className="bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-wider hover:bg-indigo-700 transition shadow-sm">REGISTAR</button>
          </div>
          <div className="space-y-2">
            {delayReasons.map(reason => (
              <div key={reason} className="flex justify-between items-center p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700">
                <span>{reason}</span>
                <button onClick={() => triggerConfirm('Remover Motivo', `Deseja remover "${reason}"?`, () => handleDeleteDelayReason(reason))} className="text-red-500 hover:text-red-700 font-black ml-1 text-sm">&times;</button>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* Card 5: Configurações de Clima */}
      <div className="bg-white p-6 rounded-2xl shadow-md border border-slate-200 space-y-4">
        <h2 className="text-sm font-black uppercase border-b pb-2 text-slate-800 tracking-wider">5. Configurações de Clima (Visual Crossing Weather API)</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">Cidade do Projeto (Formato: Cidade, Estado)</label>
            <input
              type="text"
              placeholder="Ex: Curitiba, PR"
              className="w-full p-2.5 border border-slate-200 rounded-xl text-xs font-bold focus:ring-2 focus:ring-indigo-500 bg-slate-50 focus:bg-white transition outline-none text-slate-800"
              value={projectCity}
              onChange={(e) => setProjectCity(e.target.value)}
              onBlur={(e) => saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices, teamPhones, urlUserId, e.target.value, weatherApiKey)}
            />
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase tracking-wider text-slate-400 mb-1.5">Chave de API Visual Crossing</label>
            <input
              type="password"
              placeholder="Digite a chave da API..."
              className="w-full p-2.5 border border-slate-200 rounded-xl text-xs font-bold focus:ring-2 focus:ring-indigo-500 bg-slate-50 focus:bg-white transition outline-none text-slate-800 font-mono"
              value={weatherApiKey}
              onChange={(e) => setWeatherApiKey(e.target.value)}
              onBlur={(e) => saveToDB(floors, allFloorsData, history, weights, planning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices, teamPhones, urlUserId, projectCity, e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed font-medium">
          💡 Nota: Se nenhuma chave for fornecida, o aplicativo usará dados climáticos simulados deterministicamente com base no clima de {projectCity}.
        </p>
      </div>
    </div>
  );

  const renderTeamInputScreen = () => {
    const weekId = toLocalDateString(currentWeekStart);
    const weekEndDate = new Date(currentWeekStart.getTime() + 4 * 86400000);
    const teamTasks = planning.filter(t => t.weekId === weekId && t.responsible === urlTeamName);
    const hasDelayedTeamTask = teamTasks.some(t => {
      const input = teamInputs[t.id] || { progress: 0, delayReason: '', observations: '' };
      return input.progress < (t.plannedThisWeek ?? 100);
    });

    const handleSubmitTeamReport = async () => {
      setLoading(true);
      try {
        const generalDelayReason = teamGeneralDelayReason.trim();
        const generalObservations = teamGeneralObservations.trim();
        const updatedPlanning = planning.map(t => {
          if (t.weekId === weekId && t.responsible === urlTeamName) {
            const input = teamInputs[t.id] || { progress: 0, delayReason: '', observations: '' };
            return {
              ...t,
              preFilledProgress: input.progress,
              preFilledDelayReason: input.progress < (t.plannedThisWeek ?? 100) ? generalDelayReason : '',
              preFilledObservations: generalObservations,
              preFilledAt: new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR')
            };
          }
          return t;
        });

        await saveToDB(floors, allFloorsData, history, weights, updatedPlanning, cronogramaInicial, teams, delayReasons, ppcHistory, matrices, teamPhones, urlUserId);
        
        setTeamSubmitSuccess(true);
        setNotification({ message: 'Avanço enviado com sucesso!', type: 'success' });
      } catch (err: any) {
        console.error(err);
        setNotification({ message: 'Erro ao enviar dados: ' + err.message, type: 'error' });
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className="min-h-screen bg-slate-50 font-sans text-slate-900 flex flex-col pb-10">
        {/* Header */}
        <header className="bg-slate-900 p-4 text-white shadow-md sticky top-0 z-40">
          <div className="max-w-xl mx-auto flex justify-between items-center">
            <div className="flex items-center space-x-2">
              <div>
                <h1 className="text-sm font-black tracking-tight leading-none">PLANEJAMENTO DE CURTO PRAZO</h1>
                <span className="text-[8px] uppercase tracking-wider text-indigo-300 font-bold">Apontamento de Campo</span>
              </div>
            </div>
            <span className="px-2.5 py-1 bg-indigo-800 rounded-lg text-[9px] font-black uppercase border border-indigo-700 text-indigo-100 truncate max-w-[150px]">
              {urlTeamName}
            </span>
          </div>
        </header>

        {/* Content Container */}
        <main className="flex-1 max-w-xl w-full mx-auto p-4 md:p-6 space-y-6 pb-20">
          {teamSubmitSuccess ? (
            <div className="bg-white p-8 rounded-2xl shadow-md border border-slate-200 text-center space-y-4 animate-in zoom-in-95">
              <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center text-3xl mx-auto">✓</div>
              <h2 className="text-lg font-black text-slate-800 uppercase tracking-tight">Relatório Enviado!</h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                As informações de progresso da equipe <strong>{urlTeamName}</strong> para a semana de <strong>{currentWeekStart.toLocaleDateString('pt-BR')}</strong> foram registradas com sucesso.
              </p>
              <p className="text-[10px] text-slate-400">
                O planejador responsável recebeu seus dados e irá validá-los no painel principal.
              </p>
              <button
                onClick={() => setTeamSubmitSuccess(false)}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-xs tracking-wider rounded-xl shadow transition"
              >
                Atualizar / Enviar Novamente
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Date Navigation */}
              <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs flex justify-between items-center">
                <button onClick={() => setCurrentWeekStart(prev => addDays(prev, -7))} className="p-2 hover:bg-slate-100 rounded-lg transition text-slate-600">◀</button>
                <div className="text-center">
                  <div className="text-[8px] uppercase font-black text-slate-400">Semana de Trabalho</div>
                  <div className="text-xs font-black text-indigo-900">
                    {currentWeekStart.toLocaleDateString('pt-BR')} - {weekEndDate.toLocaleDateString('pt-BR')}
                  </div>
                </div>
                <button onClick={() => setCurrentWeekStart(prev => addDays(prev, 7))} className="p-2 hover:bg-slate-100 rounded-lg transition text-slate-600">▶</button>
              </div>

              {/* Tasks List */}
              <div className="space-y-4">
                <h3 className="text-xs font-black text-slate-500 uppercase tracking-wider">Serviços da Semana ({teamTasks.length})</h3>
                
                {teamTasks.map(t => {
                  const input = teamInputs[t.id] || { progress: 0, delayReason: '', observations: '' };
                  const planned = t.plannedThisWeek ?? 100;
                  const simpleInstruction = getSimpleServiceInstruction(t);
                  const fieldOptions = getFieldProgressOptions(t);
                  const isDone = input.progress >= planned;

                  return (
                    <div key={t.id} className="bg-white p-5 rounded-2xl shadow-xs border border-slate-200 space-y-4">
                      {/* Task Title */}
                      <div className="flex justify-between items-start border-b pb-2">
                        <div>
                          <h4 className="text-xs font-black text-slate-800 uppercase tracking-tight leading-tight flex items-center gap-1.5">
                            {t.isManual && (
                              <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 border border-amber-200 text-[8px] font-black rounded uppercase tracking-tight select-none">
                                Extra
                              </span>
                            )}
                            <span>{simpleInstruction}</span>
                          </h4>
                          {t.serviceComplement && (
                            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wide mt-1 flex items-center gap-1">
                              <span className="text-indigo-500 font-black">↳</span>
                              <span className="bg-slate-100 px-1 py-0.5 rounded border border-slate-200/60 max-w-[250px] truncate" title={t.serviceComplement}>
                                {t.serviceComplement}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Progress input */}
                      <div className="space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-slate-50 p-3 rounded-xl border border-slate-200/60">
                          <button
                            type="button"
                            onClick={() => {
                              setTeamInputs({
                                ...teamInputs,
                                [t.id]: { ...input, progress: planned }
                              });
                            }}
                            className={`min-h-[46px] rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-tight transition border ${
                              isDone
                                ? 'bg-blue-600 text-white border-blue-600 shadow-md ring-4 ring-blue-100'
                                : 'bg-white text-slate-700 hover:bg-blue-50 hover:text-blue-700 border-slate-200'
                            }`}
                          >
                            {fieldOptions.done}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setTeamInputs({
                                ...teamInputs,
                                [t.id]: { ...input, progress: 0 }
                              });
                            }}
                            className={`min-h-[46px] rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-tight transition border ${
                              !isDone
                                ? 'bg-red-600 text-white border-red-600 shadow-md ring-4 ring-red-100'
                                : 'bg-white text-slate-700 hover:bg-red-50 hover:text-red-700 border-slate-200'
                            }`}
                          >
                            {fieldOptions.pending}
                          </button>
                        </div>
                      </div>

                    </div>
                  );
                })}

                {teamTasks.length === 0 && (
                  <div className="bg-white p-12 text-center border border-slate-200 rounded-2xl shadow-xs">
                    <p className="text-xs text-slate-400 font-bold uppercase italic">Nenhum serviço planejado para a sua equipe nesta semana.</p>
                  </div>
                )}
              </div>

              {teamTasks.length > 0 && (
                <div className="bg-white p-5 rounded-2xl shadow-xs border border-slate-200 space-y-4 animate-in fade-in">
                  <div className="border-b border-slate-100 pb-2">
                    <h3 className="text-xs font-black text-slate-700 uppercase tracking-wider">Fechamento da semana</h3>
                    <p className="text-[10px] font-bold text-slate-400 mt-1">Essas informações valem para todos os serviços apontados.</p>
                  </div>

                  {hasDelayedTeamTask && (
                    <div className="space-y-1.5">
                      <label className="block text-[9px] font-black uppercase text-amber-600">Motivo de atraso geral</label>
                      <select
                        className="w-full p-2.5 bg-amber-50/50 border border-amber-200 rounded-xl text-xs font-bold text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none"
                        value={teamGeneralDelayReason}
                        onChange={(e) => setTeamGeneralDelayReason(e.target.value)}
                      >
                        <option value="">-- Selecione o Motivo --</option>
                        {delayReasons.map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="block text-[9px] font-black uppercase text-slate-400">Observações / Comentários gerais</label>
                    <div className="flex gap-2 items-center">
                      <textarea
                        placeholder="EX: Aguardando liberação de material, ajuste de equipe, interferências..."
                        className="flex-1 min-h-[84px] p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:ring-2 focus:ring-indigo-500 outline-none font-medium resize-none"
                        value={teamGeneralObservations}
                        onChange={(e) => setTeamGeneralObservations(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => handleTeamVoiceInput(TEAM_GENERAL_OBSERVATIONS_ID)}
                        className={`p-2.5 rounded-xl transition-all active:scale-95 text-sm flex items-center justify-center w-10 h-10 shrink-0 ${
                          listeningTaskId === TEAM_GENERAL_OBSERVATIONS_ID
                            ? 'bg-red-600 text-white animate-pulse ring-4 ring-red-200'
                            : micConnectingTaskId === TEAM_GENERAL_OBSERVATIONS_ID
                            ? 'bg-amber-500 text-white animate-pulse ring-4 ring-amber-200'
                            : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-100'
                        }`}
                        title={
                          listeningTaskId === TEAM_GENERAL_OBSERVATIONS_ID
                            ? "Microfone ativo (Pode falar)"
                            : micConnectingTaskId === TEAM_GENERAL_OBSERVATIONS_ID
                            ? "Inicializando microfone..."
                            : "Ditar observação geral"
                        }
                      >
                        Gravar
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={handleSubmitTeamReport}
                    className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-xs tracking-wider rounded-xl shadow-md transition transform active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span>Enviar Dados de Avanço</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    );
  };

  if (isTeamMode) {
    if (loading) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-slate-900 text-white font-sans">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm font-bold tracking-widest text-indigo-200 uppercase animate-pulse">Carregando painel da equipe...</p>
          </div>
        </div>
      );
    }
    return renderTeamInputScreen();
  }

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

  if (!isTeamMode && !plannerUsername) {
    return (
      <div className="min-h-screen bg-slate-900 font-sans text-slate-100 flex items-center justify-center p-4 relative overflow-hidden">
        {/* Background elements */}
        <div className="absolute top-[-20%] left-[-20%] w-[60%] h-[60%] rounded-full bg-indigo-900/30 blur-[120px]"></div>
        <div className="absolute bottom-[-20%] right-[-20%] w-[60%] h-[60%] rounded-full bg-emerald-900/20 blur-[120px]"></div>
        
        {/* Glass Container */}
        <div className="bg-slate-800/80 backdrop-blur-xl border border-slate-700/50 p-8 rounded-3xl shadow-2xl max-w-sm w-full space-y-6 relative z-10 text-center animate-in zoom-in-95 duration-500">
          <div className="space-y-2">
            <h2 className="text-xl font-black uppercase tracking-tight text-white">PLANEJAMENTO DE CURTO PRAZO</h2>
            <p className="text-[10px] text-indigo-300 uppercase tracking-widest font-bold">Identificação de Operador</p>
          </div>

          <div className="space-y-4">
            <div className="text-left space-y-1">
              <label className="block text-[9px] uppercase tracking-wider text-slate-400 font-black">Seu Nome / Função</label>
              <input
                type="text"
                placeholder="Ex: Kenzo, Engenharia, Planejador..."
                className="w-full p-3 bg-slate-900/50 border border-slate-700 rounded-xl text-xs font-bold text-white placeholder-slate-500 focus:ring-2 focus:ring-indigo-500 outline-none transition"
                id="username-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = (e.target as HTMLInputElement).value.trim();
                    if (val) {
                      handleOperatorLogin(val);
                    }
                  }
                }}
              />
            </div>
            
            <button
              onClick={() => {
                const input = document.getElementById('username-input') as HTMLInputElement;
                const val = input?.value.trim();
                if (val) {
                  handleOperatorLogin(val);
                }
              }}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase text-xs tracking-wider rounded-xl shadow-lg transition active:scale-98 flex items-center justify-center gap-2 cursor-pointer"
            >
              Entrar no Painel
            </button>
          </div>
          
          <div className="text-[9px] text-slate-500 leading-relaxed">
            Esta identificação é salva neste computador e registrará quem realizou cada atualização no banco de dados.
          </div>
        </div>
      </div>
    );
  }

  if (!isTeamMode && !selectedProjectId) {
    return renderProjectsDashboard();
  }

  const activeProjectObj = projects.find(p => p.id === selectedProjectId);

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 relative overflow-x-clip">
      <header className="bg-slate-900 p-4 text-white shadow-xl sticky top-0 z-40">
        <div className="max-w-[1600px] w-full mx-auto flex flex-col sm:flex-row justify-between items-center gap-3">
          <div className="flex items-center space-x-3">
            <div><h1 className="text-lg font-black tracking-tight leading-none">PLANEJAMENTO DE CURTO PRAZO</h1><span className="text-[9px] uppercase tracking-wider text-emerald-400 font-bold">Gestão e controle de obras</span></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1 bg-slate-800 rounded-full text-[9px] font-mono border border-slate-700 text-slate-350">
              ID: {urlUserId ? `${urlUserId} (Compartilhado)` : `${selectedProjectId} (${activeProjectObj?.name || 'Projeto'})`}
            </span>
            {selectedProjectId && !urlUserId && (
              <div className="flex items-center gap-1.5 px-3 py-1 bg-emerald-950/50 border border-emerald-800/40 rounded-full text-[9px] font-bold text-emerald-300">
                <span>🏢 {activeProjectObj?.name || selectedProjectId.toUpperCase()}</span>
                <button
                  onClick={() => {
                    localStorage.removeItem('selected_project_id');
                    setSelectedProjectId('');
                  }}
                  className="hover:text-white font-black ml-1 text-[11px] leading-none"
                  title="Trocar de projeto"
                >
                  🔄
                </button>
              </div>
            )}
            {plannerUsername && (
              <div className="flex items-center gap-1.5 px-3 py-1 bg-indigo-900/60 border border-indigo-700/50 rounded-full text-[9px] font-bold text-indigo-200">
                <span>👤 {plannerUsername}</span>
                <button
                  onClick={() => {
                    localStorage.removeItem('planner_username');
                    setPlannerUsername('');
                  }}
                  className="hover:text-white font-bold ml-1 text-[10px]"
                  title="Mudar de operador"
                >
                  &times;
                </button>
              </div>
            )}
            {dbSavingStatus === 'saving' && (
              <span className="px-3 py-1 bg-blue-900/80 border border-blue-700/50 rounded-full text-[9px] font-bold text-blue-200 animate-pulse flex items-center gap-1">
                💾 Gravando...
              </span>
            )}
            {dbSavingStatus === 'pending' && (
              <span className="px-3 py-1 bg-amber-950 border border-amber-800/40 rounded-full text-[9px] font-bold text-amber-300 animate-pulse flex items-center gap-1">
                ⏳ Alterações pendentes...
              </span>
            )}
            {dbSavingStatus === 'saved' && (
              <span className="px-3 py-1 bg-emerald-950/50 border border-emerald-800/40 rounded-full text-[9px] font-bold text-emerald-300 flex items-center gap-1">
                ✅ Sincronizado
              </span>
            )}
            {dbLastUpdatedBy && (
              <span className="px-3 py-1 bg-slate-800 rounded-full text-[9px] border border-slate-700 text-slate-400 italic">
                Último avanço: {dbLastUpdatedBy}
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] w-full mx-auto p-4 md:p-6 pb-24">
        <nav className="flex gap-1 border-b border-slate-300 mb-6 overflow-x-auto pb-1 no-scrollbar sticky top-[68px] bg-slate-50 z-30 pt-2">
          <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'dashboard' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>Painel</button>
          <button onClick={() => setActiveTab('cronograma-inicial')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'cronograma-inicial' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>Cronograma</button>
          <button onClick={() => setActiveTab('planning')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'planning' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>Planejamento Semanal</button>
          <button onClick={() => setActiveTab('visualization')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'visualization' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>Matriz Geral</button>
          <button onClick={() => setActiveTab('detalhamento-ppc')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'detalhamento-ppc' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>Detalhamento PPC</button>
          <button onClick={() => setActiveTab('historico-andamento')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'historico-andamento' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>Histórico andamento</button>
          <button onClick={() => setActiveTab('config')} className={`px-4 py-3 text-xs font-black uppercase tracking-wider rounded-t-xl transition-all duration-300 whitespace-nowrap ${activeTab === 'config' ? 'bg-indigo-600 text-white shadow-lg -translate-y-1' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'}`}>Configurações</button>
        </nav>

        {activeTab === 'dashboard' && renderDashboard()}
        {activeTab === 'cronograma-inicial' && renderCronograma()}
        {activeTab === 'planning' && renderPlanning()}
        {activeTab === 'visualization' && renderVisualization()}
        {activeTab === 'detalhamento-ppc' && renderDetalhamentoPpc()}
        {activeTab === 'historico-andamento' && renderInfographic()}
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
                <div className="space-y-2 group rounded-xl border border-slate-200 bg-slate-50 p-3 transition hover:border-indigo-200 hover:bg-white focus-within:border-indigo-200 focus-within:bg-white">
                  <div className="flex justify-between items-center gap-3">
                    <label className="block text-[10px] font-black uppercase text-slate-500">Origem das atividades</label>
                    <span className="text-[9px] font-bold text-slate-500 text-right">
                      Selecionado: {drawerSourceMode === 'previous-successors' ? 'Sucessoras' : drawerSourceMode === 'unfinished' ? 'Não concluídas' : 'Cronograma'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 max-h-0 overflow-hidden opacity-0 transition-all duration-300 group-hover:max-h-48 group-hover:opacity-100 group-focus-within:max-h-48 group-focus-within:opacity-100">
                    {[
                      { id: 'cronograma', label: 'Planeje a partir das sucessoras do Cronograma' },
                      { id: 'previous-successors', label: 'Planeje a partir das sucessoras das semana anterior' },
                      { id: 'unfinished', label: 'Planeje a partir das atividades não concluídas' }
                    ].map(option => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setDrawerSourceMode(option.id as any)}
                        className={`w-full text-left p-3 rounded-xl border text-[10px] font-black uppercase tracking-wider transition ${
                          drawerSourceMode === option.id
                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                            : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-indigo-300 hover:bg-indigo-50'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  {drawerSourceMode === 'previous-successors' && (
                    <p className="text-[10px] text-slate-400 font-bold">
                      Semana anterior: {formatDateBR(previousWeekIdForDrawer)}. Exibindo apenas sucessoras das atividades finalizadas.
                    </p>
                  )}
                  {drawerSourceMode === 'unfinished' && (
                    <p className="text-[10px] text-slate-400 font-bold">
                      Exibindo atividades importadas com andamento maior que 0% e menor que 100%.
                    </p>
                  )}
                </div>
                {drawerSourceMode !== 'unfinished' && <div className="space-y-2 group relative rounded-xl border border-slate-200 bg-slate-50 p-3 transition hover:border-indigo-200 hover:bg-white focus-within:border-indigo-200 focus-within:bg-white">
                  <div className="flex justify-between items-center gap-3">
                    <label className="block text-[10px] font-black uppercase text-indigo-600">1. Selecione a Macroatividade</label>
                    {drawerMacro && <span className="text-[9px] font-bold text-slate-500 text-right truncate max-w-[220px]">{getMacroTitle(drawerMacro)}</span>}
                  </div>
                  <div className={`overflow-visible transition-all duration-300 group-hover:max-h-72 group-hover:opacity-100 group-focus-within:max-h-72 group-focus-within:opacity-100 ${drawerMacro ? 'max-h-0 opacity-0' : 'max-h-72 opacity-100'}`}>
                  {isDrawerMacroDropdownOpen && (
                    <div className="fixed inset-0 z-40" onClick={() => setIsDrawerMacroDropdownOpen(false)} />
                  )}
                  <div className="relative z-50">
                    <input
                      type="text"
                      placeholder="🔎 Buscar macroatividade..."
                      className="w-full p-2.5 bg-slate-100 border border-slate-200 rounded-lg font-bold text-xs focus:bg-white outline-none cursor-pointer"
                      value={isDrawerMacroDropdownOpen ? drawerMacroSearch : (drawerMacro ? getMacroTitle(drawerMacro) : '')}
                      onFocus={() => {
                        setDrawerMacroSearch('');
                        setIsDrawerMacroDropdownOpen(true);
                      }}
                      onChange={(e) => setDrawerMacroSearch(e.target.value)}
                    />
                    {isDrawerMacroDropdownOpen && (
                      <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto custom-scrollbar z-50">
                        {filteredMacros.map(macro => (
                          <button
                            key={macro}
                            type="button"
                            onClick={() => {
                              setDrawerMacro(macro);
                              setDrawerFloors([]);
                              setDrawerSelectedServices([]);
                              setDrawerWarning('');
                              setIsDrawerMacroDropdownOpen(false);
                              setDrawerExpandedStep(2);
                            }}
                            className="w-full text-left p-2.5 text-xs font-bold text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 transition uppercase tracking-wider border-b border-slate-100 last:border-b-0"
                          >
                            {getMacroTitle(macro)}
                          </button>
                        ))}
                        {filteredMacros.length === 0 && (
                          <p className="p-3 text-xs text-slate-400 italic text-center font-bold">
                            {drawerSourceMode === 'previous-successors' ? 'Nenhuma sucessora liberada pela semana anterior.' : 'Nenhuma macroatividade encontrada.'}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                </div>}
                {drawerSourceMode !== 'unfinished' && <div className="space-y-2 group rounded-xl border border-indigo-100 bg-white p-3">
                  <div className="flex justify-between items-center">
                    <label className="block text-[10px] font-black uppercase text-indigo-600">2. Marque os Pavimentos</label>
                    {drawerFloors.length > 0 && <span className="text-[9px] font-bold text-slate-500">{drawerFloors.length} selecionado(s)</span>}
                    {availableFloorsForMacro.length > 0 && <button onClick={() => { if(drawerFloors.length === availableFloorsForMacro.length) setDrawerFloors([]); else setDrawerFloors([...availableFloorsForMacro]); }} className="text-[9px] font-bold text-indigo-700 hover:underline uppercase">Todos</button>}
                  </div>
                  <div className={`grid grid-cols-2 gap-2 overflow-hidden transition-all duration-300 group-hover:max-h-72 group-hover:opacity-100 group-focus-within:max-h-72 group-focus-within:opacity-100 ${drawerFloors.length === 0 ? 'max-h-72 opacity-100' : 'max-h-0 opacity-0'} ${!drawerMacro ? 'pointer-events-none' : ''}`}>
                    {availableFloorsForMacro.map(floor => (
                      <label key={floor} className="flex items-center space-x-2 p-2 bg-slate-50 rounded-lg border hover:border-indigo-300 transition cursor-pointer">
                        <input type="checkbox" className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500" checked={drawerFloors.includes(floor)} onChange={(e) => { if (e.target.checked) setDrawerFloors([...drawerFloors, floor]); else setDrawerFloors(drawerFloors.filter(f => f !== floor)); }} />
                        <span className="text-[10px] font-bold text-slate-700 truncate">{floor}</span>
                      </label>
                    ))}
                    {availableFloorsForMacro.length === 0 && drawerMacro && <p className="text-[10px] text-slate-400 italic col-span-2">Nenhum pavimento para esta macro.</p>}
                  </div>
                </div>}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="block text-[10px] font-black uppercase text-indigo-600">3. Selecione os Serviços</label>
                    {availableServicesForMacroAndFloors.length > 0 && <button onClick={() => { if (drawerSelectedServices.length === availableServicesForMacroAndFloors.length) setDrawerSelectedServices([]); else setDrawerSelectedServices(availableServicesForMacroAndFloors.map(s => s.id)); }} className="text-[9px] font-bold text-indigo-700 hover:underline uppercase">Todos</button>}
                  </div>
                  <div className="bg-slate-50 border rounded-xl p-3 h-[46vh] min-h-[320px] overflow-y-auto space-y-2">
                    {availableServicesForMacroAndFloors.map(item => (
                      <label key={item.id} className="flex items-center space-x-3 p-2 bg-white rounded-lg border hover:border-indigo-300 transition cursor-pointer">
                        <input type="checkbox" className="w-4 h-4 text-indigo-600 rounded focus:ring-indigo-500" checked={drawerSelectedServices.includes(item.id)} onChange={(e) => { if (e.target.checked) setDrawerSelectedServices([...drawerSelectedServices, item.id]); else setDrawerSelectedServices(drawerSelectedServices.filter(id => id !== item.id)); }} />
                        <div className="text-xs"><p className="font-bold text-slate-800">{item.service}</p><p className="text-[9px] text-slate-500 font-bold">{item.floor}</p></div>
                      </label>
                    ))}
                    {availableServicesForMacroAndFloors.length === 0 && (
                      <p className="p-3 text-[10px] text-slate-400 italic text-center font-bold">
                        Nenhum servico disponivel para os filtros selecionados.
                      </p>
                    )}
                  </div>
                </div>
                <div className="space-y-2 border-t pt-3">
                  <label className="block text-[10px] font-black uppercase text-slate-400">4. Atribuir Equipe</label>
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

      {matrixGroupModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-in zoom-in-95">
            <h3 className="font-black text-sm text-slate-900 mb-2 uppercase tracking-tight">Grupo da Matriz</h3>
            <p className="text-xs text-slate-500 mb-4">Selecione o grupo de replicacao para criar uma matriz somente com os pavimentos e macroatividades desse grupo.</p>
            <div className="max-h-72 overflow-y-auto space-y-2 custom-scrollbar pr-1">
              {replicationGroups.map(group => {
                const groupItems = cronogramaInicial.filter(item => String(item?.replicationGroup || '').trim() === group);
                const groupFloors = new Set(groupItems.map(item => item.floor).filter(Boolean));
                const groupMacros = new Set(groupItems.map(item => slugify(item.macro)).filter(Boolean));
                return (
                  <button
                    key={group}
                    onClick={() => handleCreateMatrix(group)}
                    className="w-full text-left p-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-indigo-50 hover:border-indigo-300 transition"
                  >
                    <div className="text-xs font-black text-slate-800 uppercase">{group}</div>
                    <div className="text-[10px] font-bold text-slate-500 mt-1">{groupFloors.size} pavimento(s) · {groupMacros.size} macroatividade(s)</div>
                  </button>
                );
              })}
              {replicationGroups.length === 0 && (
                <p className="text-xs text-slate-400 font-bold italic text-center py-4">Nenhum grupo de replicacao importado.</p>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setMatrixGroupModalOpen(false)} className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold rounded-lg transition">FECHAR</button>
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

      {/* WhatsApp Share Modal */}
      {whatsappModal.isOpen && (() => {
        const whatsappAvailableTeams = getWhatsappAvailableTeams();

        return (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-in zoom-in-95 space-y-4">
            <div className="flex items-center space-x-2 text-indigo-600 mb-2">
              <span className="text-xl">💬</span>
              <h3 className="font-black text-sm uppercase tracking-wider">Enviar para WhatsApp</h3>
            </div>
            
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-black uppercase text-slate-400 mb-1">Selecionar Equipe</label>
                <select
                  className="w-full p-2 border border-slate-200 rounded-lg text-xs font-bold focus:ring-2 focus:ring-indigo-500 outline-none uppercase"
                  value={whatsappModal.teamName}
                  onChange={(e) => {
                    const selectedTeam = e.target.value;
                    const text = generateWhatsappMessage(selectedTeam);
                    setWhatsappModal({ ...whatsappModal, teamName: selectedTeam, text });
                  }}
                >
                  {whatsappAvailableTeams.map(team => (
                    <option key={team} value={team}>{team}</option>
                  ))}
                </select>
              </div>

              {whatsappModal.teamName && (
                <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                  <div className="flex justify-between items-center text-[9px] font-black text-slate-400 uppercase tracking-tight mb-1">
                    <span>Telefone Cadastrado</span>
                    <span className="text-indigo-600 font-mono">{teamPhones[whatsappModal.teamName] || 'Não cadastrado'}</span>
                  </div>
                  {!teamPhones[whatsappModal.teamName] && (
                    <div className="text-[10px] text-amber-600 font-bold leading-tight">
                      ⚠️ Nenhum telefone cadastrado para esta equipe. Adicione um nas Configurações ou você terá que digitar o telefone no WhatsApp manualmente.
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-[10px] font-black uppercase text-slate-400 mb-1">Conteúdo da Mensagem</label>
                <textarea
                  rows={8}
                  className="w-full p-2 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 outline-none font-mono text-slate-700 bg-slate-50"
                  value={whatsappModal.text}
                  onChange={(e) => setWhatsappModal({ ...whatsappModal, text: e.target.value })}
                />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => setWhatsappModal(prev => ({ ...prev, isOpen: false }))}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold rounded-lg transition"
              >
                Voltar
              </button>
              <button
                onClick={handleSendWhatsapp}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg transition"
              >
                Enviar via WhatsApp
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Finalize Modal */}
      {finalizeModal.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 animate-in zoom-in-95">
            <div className="flex items-center space-x-2 text-emerald-600 mb-3"><h3 className="font-black text-sm uppercase tracking-wider">Finalizar Semana de Trabalho</h3></div>
            <p className="text-xs text-slate-600 mb-4 leading-relaxed">Você está concluindo as atividades planejadas para a semana de <strong className="text-indigo-900">{formatDateBR(currentWeekStart)}</strong>. Isso salvará o PPC finalizado de <strong className="text-emerald-600">{currentWeekPpcStats.percent.toFixed(1)}%</strong> diretamente no banco de dados.</p>
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

      {matrixTooltip.visible && matrixTooltip.text && (
        <div 
          className="fixed bg-slate-900 text-white text-[10px] font-bold p-2.5 rounded-xl shadow-xl z-[9999] text-left whitespace-pre border border-slate-700 pointer-events-none leading-relaxed w-max max-w-none"
          style={{
            left: `${matrixTooltip.x}px`,
            top: `${matrixTooltip.y}px`,
            transform: 'translate(-50%, -100%) translateY(-8px)',
          }}
        >
          {matrixTooltip.text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-slate-900"></div>
        </div>
      )}

      <Notification {...notification} onClose={() => setNotification({ message: '', type: '' })} />
    </div>
  );
};

export default App;
