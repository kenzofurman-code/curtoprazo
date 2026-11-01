const fs = require('fs');

// Decompression function
const decompressStringUnicode = (compressedStr) => {
  if (!compressedStr || !compressedStr.startsWith('unicode:')) return '';
  const dataPart = compressedStr.substring(8);
  let dictionary = {};
  for (let i = 0; i < 256; i++) dictionary[i] = String.fromCodePoint(i);
  const r = dataPart.split(',');
  let w = dictionary[parseInt(r[0], 36)];
  let result = w;
  let dictSize = 256;
  for (let i = 1; i < r.length; i++) {
    const k = parseInt(r[i], 36);
    let entry;
    if (Object.prototype.hasOwnProperty.call(dictionary, k)) entry = dictionary[k];
    else if (k === dictSize) entry = w + w.charAt(0);
    else throw new Error('Decompress error');
    result += entry;
    if (dictSize < 65000) dictionary[dictSize++] = w + entry.charAt(0);
    else {
      dictionary = {};
      for (let j = 0; j < 256; j++) dictionary[j] = String.fromCodePoint(j);
      dictSize = 256;
    }
    w = entry;
  }
  const bytes = new Uint8Array(result.length);
  for (let i = 0; i < result.length; i++) bytes[i] = result.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

// Compression function
const compressStringUnicode = (str) => {
  if (!str) return '';
  const bytes = new TextEncoder().encode(str);
  let binaryStr = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryStr += String.fromCodePoint(bytes[i]);
  }
  str = binaryStr;

  let dictionary = {};
  const initDict = () => {
    dictionary = {};
    for (let i = 0; i < 256; i++) {
      dictionary[String.fromCodePoint(i)] = i;
    }
  };
  initDict();
  let word = '';
  const result = [];
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

const c1 = JSON.parse(fs.readFileSync('local_db/documents/projeto_principal_crono.json', 'utf8'));
const crono = JSON.parse(decompressStringUnicode(c1.cronogramaInicial));
console.log('Original crono items count:', crono.length);

const budgetList = JSON.parse(fs.readFileSync('src/data/qoya_orcamento_executivo.json', 'utf8'));
const linksList = JSON.parse(fs.readFileSync('src/data/qoya_vinculos_cronograma.json', 'utf8'));

const normalizeLotName = (lot) => {
  let s = (lot || '').trim();
  const m = s.match(/^Fachada\s+([A-D])\s*--?\s*.*?\s*-\s*(\(\d+º-\d+º\))$/i);
  if (m) return 'Fachada ' + m[1].toUpperCase() + ' - ' + m[2];
  return s;
};

// Map crono activities by pkg:::lot and name:::lot
const cronoMap = new Map();
crono.forEach((a) => {
  const actId = a[0];
  const nome = (a[1] || '').trim().toLowerCase();
  const pav = (a[2] || '').trim().toLowerCase();
  const pkg = (a[3] || '').trim().toLowerCase();
  cronoMap.set(pkg + ':::' + pav, actId);
  cronoMap.set(nome + ':::' + pav, actId);
});

// Build items
const items = budgetList.map((b) => {
  const dots = (b.code.match(/\./g) || []).length;
  return {
    id: 'bgt_projeto_principal_' + b.code.replace(/[^a-zA-Z0-9]/g, '_'),
    eapCode: b.code,
    name: b.desc,
    level: b.level || (dots + 1),
    materialCost: b.mat,
    laborCost: b.mo,
    totalCost: b.total || (b.mat + b.mo),
    isLeaf: true,
    linkedScheduleIds: [],
    weights: {}
  };
});

// Identify hierarchy
items.forEach((item) => {
  const isParent = items.some(
    (other) => other.eapCode.startsWith(item.eapCode + '.') && other.eapCode !== item.eapCode
  );
  item.isLeaf = !isParent;
  if (item.level > 1) {
    const lastDot = item.eapCode.lastIndexOf('.');
    if (lastDot > 0) {
      const parentCode = item.eapCode.slice(0, lastDot);
      const parent = items.find((p) => p.eapCode === parentCode);
      if (parent) item.parentId = parent.id;
    }
  }
});

const itemsByCode = new Map();
items.forEach((it) => itemsByCode.set(it.eapCode, it));

// Map links
let matchedLinks = 0;
for (const link of linksList) {
  const bItem = itemsByCode.get(link.code);
  if (!bItem) continue;

  const pkgKey = link.pkg.trim().toLowerCase();
  const srvKey = (link.srv || '').trim().toLowerCase();
  const lotOrig = link.lot.trim().toLowerCase();
  const lotNorm = normalizeLotName(link.lot).trim().toLowerCase();

  const key1 = pkgKey + ':::' + lotNorm;
  const key2 = pkgKey + ':::' + lotOrig;
  const key3 = srvKey !== '-' ? (srvKey + ':::' + lotNorm) : null;
  const key4 = srvKey !== '-' ? (srvKey + ':::' + lotOrig) : null;

  const actId = cronoMap.get(key1) || cronoMap.get(key2) || (key3 ? cronoMap.get(key3) : null) || (key4 ? cronoMap.get(key4) : null);
  if (actId) {
    matchedLinks++;
    if (!bItem.linkedScheduleIds.includes(actId)) {
      bItem.linkedScheduleIds.push(actId);
    }
    bItem.weights[actId] = parseFloat(((bItem.weights[actId] || 0) + link.weight).toFixed(4));
  }
}

console.log('Matched links count:', matchedLinks);

// Now calculate assigned costs per activity:
const costByActivityId = new Map();
items.forEach((item) => {
  if (!item.isLeaf || !item.weights || item.linkedScheduleIds.length === 0) return;
  item.linkedScheduleIds.forEach((actId) => {
    const pct = item.weights[actId] || 0;
    const allocated = parseFloat(((pct / 100) * item.totalCost).toFixed(2));
    const cur = costByActivityId.get(actId) || 0;
    costByActivityId.set(actId, cur + allocated);
  });
});

console.log('Activities with budget assigned:', costByActivityId.size);

// Update crono activity costs
let totalAllocatedCrono = 0;
crono.forEach((a) => {
  const actId = a[0];
  if (costByActivityId.has(actId)) {
    const newCost = costByActivityId.get(actId);
    a[7] = newCost; // index 7 is custo
    totalAllocatedCrono += newCost;
  }
});

console.log('Total allocated crono cost:', totalAllocatedCrono.toFixed(2));

// Recompress and save crono
const newCompressed = compressStringUnicode(JSON.stringify(crono));
c1.cronogramaInicial = newCompressed;
fs.writeFileSync('local_db/documents/projeto_principal_crono.json', JSON.stringify(c1, null, 2), 'utf8');

// Also update weights in projeto_principal.json
const p1 = JSON.parse(fs.readFileSync('local_db/documents/projeto_principal.json', 'utf8'));
p1.lastUpdated = new Date().toISOString();
fs.writeFileSync('local_db/documents/projeto_principal.json', JSON.stringify(p1, null, 2), 'utf8');

// Save complete QOYA budget state
const qoyaBudgetState = {
  projectId: 'projeto_principal',
  budgetName: 'Orçamento Executivo Oficial - PIEMONTE QOYA',
  totalCost: items[0]?.totalCost || 65573854.11,
  items,
  lastUpdated: new Date().toISOString()
};
fs.writeFileSync('src/data/qoya_preloaded_budget_state.json', JSON.stringify(qoyaBudgetState), 'utf8');
fs.writeFileSync('local_db/documents/curtoprazo_budget_projeto_principal.json', JSON.stringify(qoyaBudgetState, null, 2), 'utf8');
console.log('Saved updated crono and preloaded budget state successfully!');
