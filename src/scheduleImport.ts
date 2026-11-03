export const SCHEDULE_FIELDS = {
  id: 'Identificador', macro: 'Pacote de trabalho', service: 'Serviço',
  replicationGroup: 'Grupo de replicação', floor: 'Lote / local', duration: 'Duração',
  start: 'Início', end: 'Término', cost: 'Custo atual', responsible: 'Responsáveis',
  predecessors: 'Predecessoras', successors: 'Sucessoras', progress: 'Avanço realizado (%)'
};
export type ScheduleField = keyof typeof SCHEDULE_FIELDS;
export type ScheduleSheet = {
  name: string; rows: unknown[][]; date1904?: boolean;
  formats?: Record<string, string>;
  merges?: { s: { r: number; c: number }; e: { r: number; c: number } }[];
};
export type ImportOptions = {
  headerIndex?: number; mapping?: Partial<Record<ScheduleField, number>>;
  duplicateRows?: Record<string, number>; progressScale?: 'auto' | 'fraction' | 'percent';
};
export type ImportRecord = { rowNumber: number; values: Record<ScheduleField, unknown> };
const fields = Object.keys(SCHEDULE_FIELDS) as ScheduleField[];
const required: ScheduleField[] = ['macro', 'floor', 'start', 'end'];
const aliases: Record<ScheduleField, string[]> = {
  id: ['id', 'identificador', 'id da atividade', 'codigo da atividade'],
  macro: ['pacote de trabalho/tarefas', 'pacote de trabalho', 'macroatividade', 'atividade', 'tarefa'],
  service: ['servico', 'descricao do servico'], replicationGroup: ['grupo de replicacao'],
  floor: ['lote', 'local do servico', 'local', 'pavimento'],
  duration: ['duracao', 'prazo', 'dias'], start: ['data de inicio', 'inicio', 'inicio planejado'],
  end: ['data de termino', 'data de fim', 'termino', 'fim', 'termino planejado'],
  cost: ['custo vinculado atual', 'custo atual', 'custo', 'valor'],
  responsible: ['responsaveis', 'responsavel', 'equipe'],
  predecessors: ['predecessoras', 'predecessores', 'predecessora', 'predecessor'],
  successors: ['sucessoras', 'sucessores', 'sucessora', 'sucessor'],
  progress: ['realizado', 'avanco realizado', 'percentual realizado', 'progresso', '% concluido']
};
export const normalizeScheduleHeader = (v: unknown) => String(v ?? '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const text = (v: unknown) => String(v ?? '').trim();
const absent = (v: unknown) => !text(v) || text(v) === '-';
export function scheduleColumnName(index: number): string {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}

// Dates in schedules are calendar days, never instants in the browser's time zone.
export function parseScheduleDate(value: unknown, date1904 = false): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 2958466) {
    if (!date1904 && Math.floor(value) === 60) return null; // Excel's fictitious 29/02/1900.
    const days = Math.floor(value) + (date1904 ? 0 : value < 60 ? 1 : 0);
    const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30);
    return new Date(epoch + days * 86400000).toISOString().slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = text(value);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  const br = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!iso && !br) return null;
  const [year, month, day] = iso ? [+iso[1], +iso[2], +iso[3]] : [br![3].length === 2 ? 2000 + +br![3] : +br![3], +br![2], +br![1]];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
}

export function parseScheduleNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = text(value).replace(/R\$|%|\s/g, '');
  if (!/^[+-]?[\d.,]+$/.test(s)) return null;
  if (s.includes(',')) s = s.includes('.') && s.lastIndexOf('.') > s.lastIndexOf(',')
    ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function columnScore(field: ScheduleField, leaf: string, path: string) {
  if (['start', 'end', 'duration', 'cost'].includes(field) && /linha de base|baseline|\breal\b|projetado/.test(path)) return 0;
  let score = aliases[field].includes(leaf) ? 100 : 0;
  if (!score && leaf) score = Math.max(0, ...aliases[field].filter(a => a.length > 5 && leaf.includes(a)).map(() => 40));
  if (field === 'progress' && score) {
    if (/unidade de medida|checklist|ultima medicao.*avanco/.test(path)) return 0;
    if (/avanco fisico.*\(%\)/.test(path)) score += 100;
    else if (/ultima medicao do projeto/.test(path)) score += 50;
  }
  return score;
}

function headerColumns(sheet: ScheduleSheet, rowIndex: number) {
  const row = sheet.rows[rowIndex] || [];
  const width = Math.max(row.length, ...sheet.rows.slice(Math.max(0, rowIndex - 4), rowIndex).map(r => r.length));
  return Array.from({ length: width }, (_, col) => {
    const parts: string[] = [];
    for (let r = Math.max(0, rowIndex - 4); r <= rowIndex; r++) {
      const source = sheet.rows[r] || [];
      const merge = sheet.merges?.find(m => m.s.r <= r && m.e.r >= r && m.s.c <= col && m.e.c >= col);
      let value = merge ? sheet.rows[merge.s.r]?.[merge.s.c] : source[col];
      // Exported group labels often have no merge metadata. Stop at the next explicit group.
      if (r < rowIndex && !merge && (source.filter(v => !absent(v)).length >= 2 || source.some(v => /avanco fisico|ultima medicao do projeto|dependencias/.test(normalizeScheduleHeader(v))))) {
        for (let c = col; c >= 0; c--) if (!absent(source[c])) { value = source[c]; break; }
      }
      if (!absent(value) && !parts.includes(text(value))) parts.push(text(value));
    }
    const leafMerge = sheet.merges?.find(m => m.s.r <= rowIndex && m.e.r >= rowIndex && m.s.c === col && m.e.c === col);
    const leaf = text(absent(row[col]) && leafMerge ? sheet.rows[leafMerge.s.r]?.[col] : row[col]);
    return { index: col, leaf, label: parts.join(' / ') || '(sem título)' };
  });
}

function mapColumns(columns: ReturnType<typeof headerColumns>) {
  const mapping = {} as Record<ScheduleField, number>;
  const ambiguous: ScheduleField[] = [];
  for (const field of fields) {
    const scores = columns.map(c => columnScore(field, normalizeScheduleHeader(c.leaf), normalizeScheduleHeader(c.label)));
    const max = Math.max(0, ...scores);
    const matches = scores.flatMap((s, i) => s === max && s > 0 ? [i] : []);
    mapping[field] = matches.length === 1 ? matches[0] : -1;
    if (matches.length > 1) ambiguous.push(field);
  }
  return { mapping, ambiguous };
}

export function detectScheduleHeader(sheet: ScheduleSheet) {
  let index = 0, best = -1;
  for (let r = 0; r < Math.min(sheet.rows.length, 200); r++) {
    const { mapping } = mapColumns(headerColumns(sheet, r));
    const recognized = fields.filter(f => mapping[f] >= 0);
    // Multiple recognized labels together avoid mistaking a report title for its header.
    let score = recognized.length + required.filter(f => mapping[f] >= 0).length * 3;
    if (recognized.length < 3) score = 0;
    const next = sheet.rows.slice(r + 1, r + 6);
    if (mapping.start >= 0 && next.some(row => parseScheduleDate(row[mapping.start], sheet.date1904))) score += 3;
    if (score > best) { best = score; index = r; }
  }
  return { index, score: best };
}

export function analyzeSchedule(sheet: ScheduleSheet, options: ImportOptions = {}) {
  const headerIndex = options.headerIndex ?? detectScheduleHeader(sheet).index;
  const columns = headerColumns(sheet, headerIndex);
  const detected = mapColumns(columns);
  const mapping = { ...detected.mapping, ...options.mapping };
  const errors: string[] = [], warnings: string[] = [];
  for (const field of fields) {
    if (!Number.isInteger(mapping[field]) || mapping[field] < -1 || mapping[field] >= columns.length) mapping[field] = -1;
  }
  for (const field of required) if (mapping[field] < 0) errors.push(`Selecione a coluna de ${SCHEDULE_FIELDS[field]}.`);
  for (const field of detected.ambiguous.filter(f => options.mapping?.[f] === undefined)) errors.push(`Há mais de uma coluna possível para ${SCHEDULE_FIELDS[field]}. Escolha uma coluna ou “Não importar”.`);
  const selected = fields.filter(f => mapping[f] >= 0);
  if (new Set(selected.map(f => mapping[f])).size !== selected.length) errors.push('Uma coluna foi associada a mais de um campo. Revise o mapeamento.');
  const missing = fields.filter(f => !required.includes(f) && mapping[f] < 0);
  if (missing.length) warnings.push(`Campos não importados: ${missing.map(f => SCHEDULE_FIELDS[f]).join(', ')}.`);
  if (mapping.service < 0) warnings.push('Sem coluna de serviço: o nome do pacote será usado como atividade.');
  const records: ImportRecord[] = [];
  let blankRows = 0, unassigned = 0;
  if (!errors.length) for (let r = headerIndex + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    if (row.every(absent)) { blankRows++; continue; }
    const values = Object.fromEntries(fields.map(f => [f, mapping[f] >= 0 ? row[mapping[f]] : undefined])) as Record<ScheduleField, unknown>;
    const rowErrors: string[] = [];
    for (const field of ['macro', 'floor'] as const) if (absent(values[field])) rowErrors.push(`${SCHEDULE_FIELDS[field]} vazio`);
    for (const field of ['start', 'end'] as const) {
      const date = parseScheduleDate(values[field], sheet.date1904);
      if (!date) rowErrors.push(`${SCHEDULE_FIELDS[field]} inválido (${text(values[field]) || 'vazio'})`);
      values[field] = date;
    }
    if (values.start && values.end && values.end < values.start) rowErrors.push('Término anterior ao início');
    for (const field of ['cost', 'duration', 'progress'] as const) {
      let n = absent(values[field]) ? field === 'duration' ? null : 0 : parseScheduleNumber(values[field]);
      if (field === 'duration' && mapping.duration < 0) n = Math.round((Date.parse(String(values.end)) - Date.parse(String(values.start))) / 86400000) + 1;
      if (field === 'progress' && n !== null) {
        const format = sheet.formats?.[`${scheduleColumnName(mapping[field])}${r + 1}`] || '';
        const scale = options.progressScale || 'auto';
        const explicitPercent = typeof row[mapping[field]] === 'string' && /%/.test(String(row[mapping[field]]));
        if (!explicitPercent && (scale === 'fraction' || (scale === 'auto' && typeof row[mapping[field]] === 'number' && /%/.test(format)))) n *= 100;
      }
      if (n === null || n < 0 || (field === 'progress' && n > 100)) rowErrors.push(`${SCHEDULE_FIELDS[field]} inválido`);
      values[field] = n;
    }
    values.responsible = absent(values.responsible) ? 'EQUIPE GERAL' : text(values.responsible);
    if (values.responsible === 'EQUIPE GERAL') unassigned++;
    values.service = absent(values.service) ? '-' : text(values.service);
    values.id = absent(values.id) ? '' : text(values.id);
    if (rowErrors.length) errors.push(`Linha ${r + 1}: ${rowErrors.join('; ')}.`);
    else records.push({ rowNumber: r + 1, values });
  }
  const groups = new Map<string, ImportRecord[]>();
  for (const record of records) {
    const v = record.values;
    const key = v.id ? `id:${v.id}` : `name:${['floor', 'macro', 'service'].map(f => normalizeScheduleHeader(v[f as ScheduleField])).join('|')}`;
    const group = groups.get(key) || []; group.push(record); groups.set(key, group);
  }
  const conflicts: { key: string; records: ImportRecord[] }[] = [];
  const accepted: ImportRecord[] = [];
  let identicalDuplicates = 0;
  for (const [key, group] of groups) {
    if (group.length === 1) { accepted.push(group[0]); continue; }
    const signature = (v: ImportRecord) => JSON.stringify(fields.map(f => typeof v.values[f] === 'string' ? text(v.values[f]).toUpperCase() : v.values[f]));
    if (new Set(group.map(signature)).size === 1) { accepted.push(group[0]); identicalDuplicates += group.length - 1; continue; }
    conflicts.push({ key, records: group });
    const chosen = group.find(v => v.rowNumber === options.duplicateRows?.[key]);
    if (chosen) accepted.push(chosen);
  }
  accepted.sort((a, b) => a.rowNumber - b.rowNumber);
  const unresolved = conflicts.filter(c => !c.records.some(r => r.rowNumber === options.duplicateRows?.[c.key])).length;
  if (unresolved) errors.push(`Resolva ${unresolved} identificador(es) ou atividade(s) com registros conflitantes.`);
  if (!records.length && !errors.length) errors.push('Nenhuma atividade encontrada abaixo do cabeçalho.');
  if (identicalDuplicates) warnings.push(`${identicalDuplicates} linha(s) repetida(s) com os mesmos valores serão importadas uma única vez.`);
  if (unassigned) warnings.push(`${unassigned} atividade(s) sem responsável serão atribuídas a EQUIPE GERAL.`);
  if (blankRows) warnings.push(`${blankRows} linha(s) vazia(s) ignorada(s).`);
  if (mapping.duration < 0) warnings.push('Duração ausente: calculada em dias corridos, incluindo início e término.');
  const ids = new Set(records.map(r => String(r.values.id)).filter(Boolean));
  const dangling = new Set<string>();
  for (const r of accepted) for (const f of ['predecessors', 'successors'] as const) {
    for (const id of text(r.values[f]).split(/[,;\n\r]+/).map(s => s.trim()).filter(s => s && s !== '-')) if (!ids.has(id)) dangling.add(id);
  }
  if (dangling.size) warnings.push(`${dangling.size} ID(s) de dependências não aparecem nas atividades importadas: ${[...dangling].slice(0, 8).join(', ')}${dangling.size > 8 ? '…' : ''}.`);
  const used = new Set(selected.map(f => mapping[f]));
  return { sheetName: sheet.name, headerIndex, columns, mapping, records: accepted, sourceCount: records.length,
    conflicts, identicalDuplicates, errors, warnings, ignoredColumns: columns.filter(c => !used.has(c.index) && c.leaf) };
}
export type ScheduleAnalysis = ReturnType<typeof analyzeSchedule>;
