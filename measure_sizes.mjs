import XLSX from 'xlsx';

const slugify = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'sem_nome';

const workbook = XLSX.readFile('teste.xlsx');
const ws = workbook.Sheets[workbook.SheetNames[0]];
const rawData = XLSX.utils.sheet_to_json(ws, { header: 1 });

const headerIndex = 3;
const colIdx = { macro: 2, service: 3, floor: 5 };

const seenItemKeys = new Set();
let pass1 = 0, pass2 = 0, skippedDups = 0;

const processRow = (row, useServiceFallback) => {
  if (!row || row.length === 0) return;
  const rawFloor = row[colIdx.floor] !== undefined ? String(row[colIdx.floor]).trim() : 'Térreo';
  const rawMacro = row[colIdx.macro] !== undefined ? String(row[colIdx.macro]).trim() : 'ESTRUTURA';
  let rawService = row[colIdx.service] !== undefined ? String(row[colIdx.service]).trim() : '';
  const hasExplicitService = rawService && rawService !== '-';
  if (useServiceFallback) {
    if (hasExplicitService) return;
    rawService = rawMacro;
  } else {
    if (!hasExplicitService) return;
  }
  if (!rawService) return;
  const floorName = String(rawFloor || 'Térreo').trim();
  const itemKey = `xls_${slugify(floorName)}_${slugify(rawMacro)}_${slugify(rawService)}`;
  if (seenItemKeys.has(itemKey)) { skippedDups++; return; }
  seenItemKeys.add(itemKey);
  if (useServiceFallback) pass2++; else pass1++;
};

for (let i = headerIndex + 1; i < rawData.length; i++) processRow(rawData[i], false);
for (let i = headerIndex + 1; i < rawData.length; i++) processRow(rawData[i], true);

console.log(`1st pass (detail rows with service): ${pass1}`);
console.log(`2nd pass (package-only rows, service=macro): ${pass2}`);
console.log(`Skipped duplicates: ${skippedDups}`);
console.log(`Total items: ${pass1 + pass2}`);
