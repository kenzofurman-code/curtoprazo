/**
 * Motor Inteligente de Importação de Cronogramas (Excel / XLSX / CSV)
 * 
 * Funcionalidades:
 * 1. Detecção automática e configurável da Linha do Cabeçalho e da Linha de Início dos Dados.
 * 2. Mapeamento semântico de colunas através de dicionário de sinônimos e análise de super-headers.
 * 3. Identificação de colunas encontradas vs. colunas não encontradas (trazendo o que faltar para seleção manual).
 * 4. Conversão precisa de formatos de data (seriais do Excel, ISO, DD/MM/AAAA, etc.).
 * 5. Estruturação completa para Linha de Balanço, Cronograma Gantt e Curto Prazo com rastreabilidade.
 */

import * as XLSX from 'xlsx';

export interface ColumnInfo {
  index: number;
  letter: string;
  name: string;
  groupName?: string;
  sampleValues: any[];
}

export interface FieldMappingDef {
  key: string;
  label: string;
  description: string;
  required: boolean;
  synonyms: string[];
}

export const CRONOGRAMA_FIELD_DEFS: FieldMappingDef[] = [
  {
    key: 'id',
    label: 'ID da Atividade / Tarefa',
    description: 'Código identificador único da tarefa ou pacote',
    required: true,
    synonyms: ['id', 'identificador', 'codigo', 'cod', 'item', 'activity id', 'id da tarefa', 'wbs id'],
  },
  {
    key: 'macro',
    label: 'Pacote de Trabalho / Macroatividade',
    description: 'Agrupador de nível superior na Linha de Balanço e EAP',
    required: true,
    synonyms: [
      'pacote de trabalho/tarefas',
      'pacote de trabalho',
      'pacote',
      'macroatividade',
      'macro atividade',
      'macro',
      'fase',
      'wbs',
      'etapa',
      'agrupamento',
    ],
  },
  {
    key: 'service',
    label: 'Serviço / Atividade',
    description: 'Nome da tarefa ou serviço detalhado',
    required: true,
    synonyms: [
      'serviço',
      'servico',
      'atividade',
      'nome',
      'nome da tarefa',
      'descrição',
      'descricao',
      'task name',
      'tarefa',
      'servico/tarefa',
    ],
  },
  {
    key: 'floor',
    label: 'Pavimento / Local / Lote',
    description: 'Local físico onde o serviço é executado (pavimento, trecho ou lote)',
    required: true,
    synonyms: [
      'lote',
      'local do serviço',
      'local do servico',
      'pavimento',
      'local',
      'andar',
      'trecho',
      'área',
      'area',
      'location',
      'setor',
    ],
  },
  {
    key: 'start',
    label: 'Data de Início',
    description: 'Data de início prevista da atividade',
    required: true,
    synonyms: [
      'data de início',
      'data de inicio',
      'início',
      'inicio',
      'start date',
      'start',
      'data inicial',
      'começo',
    ],
  },
  {
    key: 'end',
    label: 'Data de Término',
    description: 'Data de conclusão prevista da atividade',
    required: true,
    synonyms: [
      'data de término',
      'data de termino',
      'término',
      'termino',
      'fim',
      'end date',
      'finish',
      'data final',
      'conclusão',
    ],
  },
  {
    key: 'duration',
    label: 'Duração (Dias)',
    description: 'Duração planejada da atividade em dias',
    required: false,
    synonyms: ['duração', 'duracao', 'prazo', 'dias', 'duration', 'dias úteis', 'dias uteis'],
  },
  {
    key: 'replicationGroup',
    label: 'Grupo de Replicação / Família',
    description: 'Agrupador de repetição de serviços na Linha de Balanço',
    required: false,
    synonyms: [
      'grupo de replicação',
      'grupo de replicacao',
      'grupo replicacao',
      'grupo',
      'família',
      'familia',
      'subetapa',
      'linha de produção',
    ],
  },
  {
    key: 'baselineStart',
    label: 'Início Linha de Base (Baseline)',
    description: 'Data de início contratual da linha de base de referência',
    required: false,
    synonyms: [
      'data de início da linha de base',
      'data de inicio da linha de base',
      'início linha de base',
      'inicio linha de base',
      'baseline start',
      'início base',
    ],
  },
  {
    key: 'baselineEnd',
    label: 'Término Linha de Base (Baseline)',
    description: 'Data de término contratual da linha de base de referência',
    required: false,
    synonyms: [
      'data de término da linha de base',
      'data de termino da linha de base',
      'término linha de base',
      'termino linha de base',
      'baseline finish',
      'término base',
    ],
  },
  {
    key: 'cost',
    label: 'Custo Vinculado / Valor',
    description: 'Custo previsto ou orçado associado à atividade',
    required: false,
    synonyms: [
      'custo vinculado atual',
      'custo vinculado',
      'custo vinculado a linha de base',
      'custo',
      'valor',
      'custo total',
      'cost',
      'orçamento',
    ],
  },
  {
    key: 'responsible',
    label: 'Responsáveis / Equipe / Recursos',
    description: 'Empreiteiro, equipe ou responsável pela execução',
    required: false,
    synonyms: [
      'responsáveis',
      'responsaveis',
      'responsável',
      'responsavel',
      'recursos',
      'equipe',
      'resource names',
      'executor',
      'empreiteiro',
    ],
  },
  {
    key: 'predecessors',
    label: 'Predecessoras (Vínculos)',
    description: 'IDs das atividades predecessoras que amarram o início',
    required: false,
    synonyms: ['predecessoras', 'predecessores', 'predecessora', 'predecessor', 'dependências', 'dependencies'],
  },
  {
    key: 'successors',
    label: 'Sucessoras (Vínculos)',
    description: 'IDs das atividades sucessoras',
    required: false,
    synonyms: ['sucessoras', 'sucessores', 'sucessora', 'sucessor', 'successors'],
  },
  {
    key: 'progress',
    label: 'Avanço Físico Realizado (%)',
    description: 'Percentual físico executado ou medido',
    required: false,
    synonyms: [
      'avanço físico (%)',
      'avanco fisico (%)',
      'avanço físico',
      'avanco fisico',
      'realizado',
      '% realizado',
      '% concluído',
      '% concluido',
      'progresso',
      'avanço',
    ],
  },
  {
    key: 'critical',
    label: 'Caminho Crítico',
    description: 'Indicação se a atividade pertence ao caminho crítico',
    required: false,
    synonyms: ['caminho crítico', 'caminho critico', 'crítico', 'critico', 'critical'],
  },
];

export function getExcelColumnLetter(colIndex: number): string {
  let letter = '';
  let temp = colIndex;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

export function normalizeStr(str: any): string {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function slugifyText(value: any): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/^_+|_+$/g, '') || 'sem_nome';
}

export function parseFlexibleDate(value: any, fallback?: string): string {
  if (value === undefined || value === null || value === '' || value === '-') {
    return fallback || '';
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().split('T')[0];
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel date epoch: 1899-12-30
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + Math.floor(value));
    return epoch.toISOString().split('T')[0];
  }
  const text = String(value).trim();
  // Formato brasileiro DD/MM/AAAA ou DD-MM-AAAA
  const brMatch = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (brMatch) {
    const [, d, m, y] = brMatch;
    const yyyy = y.length === 2 ? `20${y}` : y;
    return `${yyyy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  // Formato ISO YYYY-MM-DD
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-${String(isoMatch[3]).padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  return fallback || '';
}

export function parseNumberVal(value: any, fallback = 0): number {
  if (value === undefined || value === null || value === '' || value === '-') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  let str = String(value).replace(/[^\d,.-]/g, '').trim();
  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    str = str.replace(new RegExp(`\\${thousandSep}`, 'g'), '').replace(decimalSep, '.');
  } else if (lastComma !== -1) {
    str = str.replace(',', '.');
  }
  const n = parseFloat(str);
  return Number.isFinite(n) ? n : fallback;
}

export function parseDependencyList(value: any): string[] {
  if (value === undefined || value === null || value === '' || value === '-') return [];
  return String(value)
    .split(/[,;\n\r]+/)
    .map((part) => part.trim())
    .filter((part) => part && part !== '-');
}

export interface WorkbookAnalysis {
  sheetNames: string[];
  currentSheet: string;
  totalRows: number;
  rawRows: any[][];
  suggestedHeaderRow: number; // 0-based
  suggestedDataStartRow: number; // 0-based
  detectedDateMetadata?: string;
  detectedProjectTitle?: string;
}

/**
 * Lê o arquivo bruto Excel ou CSV e retorna a análise inicial
 */
export function analyzeWorkbook(fileBuffer: ArrayBuffer | Uint8Array, sheetName?: string): WorkbookAnalysis {
  const wb = XLSX.read(fileBuffer, { type: 'array' });
  const sheetNames = wb.SheetNames;
  const activeSheetName = sheetName && sheetNames.includes(sheetName) ? sheetName : sheetNames[0];
  const ws = wb.Sheets[activeSheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];

  let detectedProjectTitle: string | undefined;
  let detectedDateMetadata: string | undefined;

  // Busca metadados nas primeiras 3 linhas
  for (let i = 0; i < Math.min(4, rawRows.length); i++) {
    const rowStr = (rawRows[i] || []).join(' ').trim();
    if (!rowStr) continue;
    if (!detectedProjectTitle && (rowStr.toLowerCase().includes('projeto') || rowStr.toLowerCase().includes('obra'))) {
      detectedProjectTitle = rowStr;
    }
    const dateMatch = rowStr.match(/(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/);
    if (dateMatch && !detectedDateMetadata) {
      detectedDateMetadata = parseFlexibleDate(dateMatch[1]);
    }
  }

  // Detecta automaticamente a linha do cabeçalho
  let suggestedHeaderRow = 0;
  let maxMatchScore = -1;

  for (let i = 0; i < Math.min(20, rawRows.length); i++) {
    const row = rawRows[i] || [];
    if (row.length === 0) continue;
    const rowNorm = row.map(normalizeStr);
    let score = 0;

    for (const field of CRONOGRAMA_FIELD_DEFS) {
      for (const syn of field.synonyms) {
        if (rowNorm.some((cell) => cell === syn || cell.includes(syn))) {
          score += field.required ? 3 : 1;
          break;
        }
      }
    }

    if (score > maxMatchScore) {
      maxMatchScore = score;
      suggestedHeaderRow = i;
    }
  }

  // Linha onde começam os dados (primeira linha subsequente com conteúdo real)
  let suggestedDataStartRow = suggestedHeaderRow + 1;
  for (let i = suggestedHeaderRow + 1; i < Math.min(suggestedHeaderRow + 6, rawRows.length); i++) {
    const row = rawRows[i] || [];
    const nonEmptyCount = row.filter((c) => c !== undefined && c !== null && String(c).trim() !== '').length;
    if (nonEmptyCount >= 3) {
      suggestedDataStartRow = i;
      break;
    }
  }

  return {
    sheetNames,
    currentSheet: activeSheetName,
    totalRows: rawRows.length,
    rawRows,
    suggestedHeaderRow,
    suggestedDataStartRow,
    detectedDateMetadata,
    detectedProjectTitle,
  };
}

export interface ColumnDetectionResult {
  columns: ColumnInfo[];
  matchedFieldIndices: Record<string, number>; // fieldKey -> colIndex (-1 if not found)
  matchedFieldLabels: Record<string, string>; // fieldKey -> Nome da Coluna no Excel
  foundFields: FieldMappingDef[];
  unmatchedRequiredFields: FieldMappingDef[];
  unmatchedOptionalFields: FieldMappingDef[];
}

/**
 * Detecta as colunas a partir de uma linha de cabeçalho configurada pelo usuário
 */
export function detectColumns(
  rawRows: any[][],
  headerRowIndex: number,
  dataStartRowIndex: number
): ColumnDetectionResult {
  const headerRow = (rawRows[headerRowIndex] || []).map((c) => String(c || '').trim());
  const prevRow = headerRowIndex > 0 ? (rawRows[headerRowIndex - 1] || []).map((c) => String(c || '').trim()) : [];

  // Encontra a maior quantidade de colunas inspecionando o cabeçalho e as primeiras linhas de dados
  let maxCols = headerRow.length;
  for (let r = headerRowIndex; r < Math.min(dataStartRowIndex + 5, rawRows.length); r++) {
    if (rawRows[r] && rawRows[r].length > maxCols) {
      maxCols = rawRows[r].length;
    }
  }

  const columns: ColumnInfo[] = [];
  for (let c = 0; c < maxCols; c++) {
    const colName = headerRow[c] || `(Coluna ${getExcelColumnLetter(c)})`;
    const groupName = prevRow[c] || undefined;
    const sampleValues: any[] = [];
    for (let r = dataStartRowIndex; r < Math.min(dataStartRowIndex + 4, rawRows.length); r++) {
      if (rawRows[r] && rawRows[r][c] !== undefined && rawRows[r][c] !== null && String(rawRows[r][c]).trim() !== '') {
        sampleValues.push(rawRows[r][c]);
      }
    }
    columns.push({
      index: c,
      letter: getExcelColumnLetter(c),
      name: colName,
      groupName: groupName && groupName !== colName ? groupName : undefined,
      sampleValues,
    });
  }

  const matchedFieldIndices: Record<string, number> = {};
  const matchedFieldLabels: Record<string, string> = {};

  const assignedCols = new Set<number>();

  for (const field of CRONOGRAMA_FIELD_DEFS) {
    let bestCol = -1;
    let bestPriority = -1; // 3: exact match, 2: group+child match, 1: partial match

    for (let c = 0; c < columns.length; c++) {
      const colNorm = normalizeStr(columns[c].name);
      const groupNorm = normalizeStr(columns[c].groupName);

      for (const syn of field.synonyms) {
        const synNorm = normalizeStr(syn);
        // Correspondência exata
        if (colNorm === synNorm && bestPriority < 3) {
          bestCol = c;
          bestPriority = 3;
          break;
        }
        // Tratamento especial para "Avanço Físico (%)" / "Última Medição (%)" com subcoluna "Realizado"
        if (
          field.key === 'progress' &&
          (groupNorm.includes('avanco fisico') || groupNorm.includes('ultima medicao')) &&
          colNorm.includes('realizado') &&
          bestPriority < 2
        ) {
          bestCol = c;
          bestPriority = 2;
          break;
        }
        // Correspondência parcial (inclusão de string)
        if (colNorm.includes(synNorm) && synNorm.length >= 4 && bestPriority < 1 && !assignedCols.has(c)) {
          bestCol = c;
          bestPriority = 1;
        }
      }
    }

    matchedFieldIndices[field.key] = bestCol;
    if (bestCol !== -1) {
      assignedCols.add(bestCol);
      matchedFieldLabels[field.key] = columns[bestCol].name;
    } else {
      matchedFieldLabels[field.key] = '';
    }
  }

  const foundFields: FieldMappingDef[] = [];
  const unmatchedRequiredFields: FieldMappingDef[] = [];
  const unmatchedOptionalFields: FieldMappingDef[] = [];

  for (const field of CRONOGRAMA_FIELD_DEFS) {
    if (matchedFieldIndices[field.key] !== -1) {
      foundFields.push(field);
    } else if (field.required) {
      unmatchedRequiredFields.push(field);
    } else {
      unmatchedOptionalFields.push(field);
    }
  }

  return {
    columns,
    matchedFieldIndices,
    matchedFieldLabels,
    foundFields,
    unmatchedRequiredFields,
    unmatchedOptionalFields,
  };
}

export interface ParsedCronogramaResult {
  parsedItems: any[];
  floors: string[];
  allFloorsData: Record<string, any>;
  weights: Record<string, Record<string, number>>;
  teams: string[];
  matrices: any[];
  stats: {
    totalActivities: number;
    totalFloors: number;
    totalMacros: number;
    startDate?: string;
    endDate?: string;
    totalCost: number;
  };
}

/**
 * Processa as linhas da planilha com base no mapeamento confirmado pelo usuário
 */
export function processScheduleData(
  rawRows: any[][],
  dataStartRowIndex: number,
  fieldMapping: Record<string, number>,
  existingState?: {
    teams?: string[];
    floors?: string[];
    matrices?: any[];
    weights?: Record<string, Record<string, number>>;
    allFloorsData?: Record<string, any>;
  }
): ParsedCronogramaResult {
  const seenItemKeys = new Set<string>();
  const rawParsedRows: any[] = [];
  const importedTeams = new Set<string>(existingState?.teams || []);
  const importedFloors = new Set<string>();
  const importedMacros = new Set<string>();

  const idCol = fieldMapping['id'] ?? -1;
  const macroCol = fieldMapping['macro'] ?? -1;
  const serviceCol = fieldMapping['service'] ?? -1;
  const floorCol = fieldMapping['floor'] ?? -1;
  const repGroupCol = fieldMapping['replicationGroup'] ?? -1;
  const startCol = fieldMapping['start'] ?? -1;
  const endCol = fieldMapping['end'] ?? -1;
  const durationCol = fieldMapping['duration'] ?? -1;
  const baselineStartCol = fieldMapping['baselineStart'] ?? -1;
  const baselineEndCol = fieldMapping['baselineEnd'] ?? -1;
  const costCol = fieldMapping['cost'] ?? -1;
  const respCol = fieldMapping['responsible'] ?? -1;
  const predCol = fieldMapping['predecessors'] ?? -1;
  const succCol = fieldMapping['successors'] ?? -1;
  const progressCol = fieldMapping['progress'] ?? -1;

  let overallMinStart: string | undefined;
  let overallMaxEnd: string | undefined;
  let accumulatedCost = 0;

  for (let i = dataStartRowIndex; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.length === 0) continue;

    const rawFloor = floorCol !== -1 && row[floorCol] !== undefined ? String(row[floorCol]).trim() : 'Geral';
    const rawMacro = macroCol !== -1 && row[macroCol] !== undefined ? String(row[macroCol]).trim() : 'ESTRUTURA';
    const rawRepGroup = repGroupCol !== -1 && row[repGroupCol] !== undefined ? String(row[repGroupCol]).trim() : '';
    let rawService = serviceCol !== -1 && row[serviceCol] !== undefined ? String(row[serviceCol]).trim() : '';

    const hasExplicitService = rawService && rawService !== '-';
    const isParent = !hasExplicitService;
    if (isParent) rawService = rawMacro;

    if (!rawService) continue;

    const rawId = idCol !== -1 && row[idCol] !== undefined ? String(row[idCol]).trim() : `item_${i}`;
    const floorName = String(rawFloor || 'Geral').trim();
    const itemKey = `xls_${slugifyText(floorName)}_${slugifyText(rawMacro)}_${slugifyText(rawService)}${rawId ? '_' + rawId : ''}`;

    if (seenItemKeys.has(itemKey)) continue;
    seenItemKeys.add(itemKey);

    const rawStart = parseFlexibleDate(startCol !== -1 ? row[startCol] : undefined);
    const rawEnd = parseFlexibleDate(endCol !== -1 ? row[endCol] : undefined, rawStart);
    const rawBaselineStart = parseFlexibleDate(baselineStartCol !== -1 ? row[baselineStartCol] : undefined);
    const rawBaselineEnd = parseFlexibleDate(baselineEndCol !== -1 ? row[baselineEndCol] : undefined, rawBaselineStart);

    let rawDuration = durationCol !== -1 && row[durationCol] !== undefined ? parseInt(String(row[durationCol]), 10) : 0;
    if (isNaN(rawDuration) || rawDuration <= 0) {
      if (rawStart && rawEnd) {
        const msStart = new Date(rawStart).getTime();
        const msEnd = new Date(rawEnd).getTime();
        rawDuration = Math.max(1, Math.round((msEnd - msStart) / (1000 * 60 * 60 * 24)) + 1);
      } else {
        rawDuration = 5;
      }
    }

    const rawCost = costCol !== -1 ? parseNumberVal(row[costCol], 0) : 0;
    accumulatedCost += rawCost;

    const rawResp =
      respCol !== -1 && row[respCol] !== undefined && row[respCol] !== null
        ? String(row[respCol]).trim().toUpperCase()
        : 'EQUIPE GERAL';
    if (rawResp && rawResp !== 'UNDEFINED' && rawResp !== '-' && rawResp !== '') {
      importedTeams.add(rawResp);
    }

    const rawPred = predCol !== -1 ? parseDependencyList(row[predCol]) : [];
    const rawSucc = succCol !== -1 ? parseDependencyList(row[succCol]) : [];

    let rawProgress = 0;
    if (progressCol !== -1 && row[progressCol] !== undefined) {
      rawProgress = parseNumberVal(row[progressCol], 0);
      if (rawProgress <= 1 && rawProgress > 0) rawProgress = rawProgress * 100;
      rawProgress = Math.max(0, Math.min(100, Math.round(rawProgress * 100) / 100));
    }

    if (rawStart && (!overallMinStart || rawStart < overallMinStart)) overallMinStart = rawStart;
    if (rawEnd && (!overallMaxEnd || rawEnd > overallMaxEnd)) overallMaxEnd = rawEnd;

    importedFloors.add(floorName);
    importedMacros.add(rawMacro.toUpperCase());

    rawParsedRows.push({
      id: itemKey,
      originalId: rawId,
      macro: String(rawMacro || 'ESTRUTURA').trim().toUpperCase(),
      replicationGroup: String(rawRepGroup || 'Não agrupado').trim().toUpperCase(),
      floor: floorName,
      service: rawService.toUpperCase(),
      isParent,
      duration: rawDuration,
      start: rawStart,
      end: rawEnd,
      baselineStart: rawBaselineStart || rawStart,
      baselineEnd: rawBaselineEnd || rawEnd,
      cost: rawCost,
      responsible: rawResp || 'EQUIPE GERAL',
      progress: rawProgress,
      predecessors: rawPred,
      successors: rawSucc,
    });
  }

  // Herança de dependências de pacote para filhos caso os filhos não possuam dependências explícitas
  const parentDependenciesByKey = new Map<string, any>();
  rawParsedRows.forEach((item) => {
    if (!item.isParent) return;
    const hasDependencies = (item.predecessors || []).length > 0 || (item.successors || []).length > 0;
    if (!hasDependencies) return;
    parentDependenciesByKey.set(`${item.floor}||${slugifyText(item.macro)}`, {
      id: item.id,
      predecessors: item.predecessors || [],
      successors: item.successors || [],
    });
  });

  const parsedItems = rawParsedRows.map((item) => {
    if (item.isParent) return item;
    const parentDependencies = parentDependenciesByKey.get(`${item.floor}||${slugifyText(item.macro)}`);
    if (!parentDependencies) return item;
    const hasOwnPredecessors = (item.predecessors || []).length > 0;
    const hasOwnSuccessors = (item.successors || []).length > 0;
    if (hasOwnPredecessors && hasOwnSuccessors) return item;
    return {
      ...item,
      predecessors: hasOwnPredecessors ? item.predecessors : parentDependencies.predecessors,
      successors: hasOwnSuccessors ? item.successors : parentDependencies.successors,
      inheritedDependenciesFrom: parentDependencies.id,
    };
  });

  // Montagem da estrutura allFloorsData e pesos
  const floorsList = Array.from(importedFloors);
  const updatedFloorsData: Record<string, any> = {};
  const updatedWeights: Record<string, Record<string, number>> = {};

  // Inicializa com estrutura limpa
  floorsList.forEach((floor) => {
    updatedFloorsData[floor] = {};
    updatedWeights[floor] = {};
  });

  parsedItems.forEach((item) => {
    const macroKey = slugifyText(item.macro);
    if (!updatedFloorsData[item.floor]) updatedFloorsData[item.floor] = {};
    if (!updatedFloorsData[item.floor][macroKey]) {
      updatedFloorsData[item.floor][macroKey] = {
        title: item.macro,
        items: [],
      };
    }
    if (!updatedWeights[item.floor]) updatedWeights[item.floor] = {};
    if (updatedWeights[item.floor][macroKey] === undefined) {
      updatedWeights[item.floor][macroKey] = 1;
    }

    updatedFloorsData[item.floor][macroKey].items.push({
      id: item.id,
      name: item.service,
      actualPercent: item.progress,
      predecessors: item.predecessors || [],
      successors: item.successors || [],
      inheritedDependenciesFrom: item.inheritedDependenciesFrom || '',
      originalId: item.originalId || '',
      replicationGroup: item.replicationGroup || '',
      cost: item.cost,
      responsible: item.responsible,
    });
  });

  const existingMatrices =
    existingState?.matrices && existingState.matrices.length > 0
      ? existingState.matrices
      : [{ id: 'default_matrix', name: 'Matriz Principal da Obra', floors: [], macros: [] }];

  const updatedMatrices = existingMatrices.map((m) => ({
    ...m,
    floors: Array.from(new Set([...(m.floors || []), ...floorsList])),
    macros: Array.from(new Set([...(m.macros || []), ...Array.from(importedMacros).map(slugifyText)])),
  }));

  return {
    parsedItems,
    floors: floorsList,
    allFloorsData: updatedFloorsData,
    weights: updatedWeights,
    teams: Array.from(importedTeams),
    matrices: updatedMatrices,
    stats: {
      totalActivities: parsedItems.length,
      totalFloors: floorsList.length,
      totalMacros: importedMacros.size,
      startDate: overallMinStart,
      endDate: overallMaxEnd,
      totalCost: Math.round(accumulatedCost * 100) / 100,
    },
  };
}
