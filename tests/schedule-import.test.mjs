import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as XLSX from 'xlsx';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const payloadSource = await readFile(new URL('../src/chunkedPayload.ts', import.meta.url), 'utf8');
const transpile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React }
}).outputText;
const { preparePayload, resolvePayload, PAYLOAD_CHUNK_BYTES } = await import(
  `data:text/javascript;base64,${Buffer.from(transpile(payloadSource)).toString('base64')}`
);
const reasonSource = await readFile(new URL('../src/delayReasons.ts', import.meta.url), 'utf8');
const { normalizeDelayReasonFields, mergeDelayReasons, GENERAL_DELAY_REASONS } = await import(
  `data:text/javascript;base64,${Buffer.from(transpile(reasonSource)).toString('base64')}`
);
const scheduleSource = await readFile(new URL('../src/scheduleImport.ts', import.meta.url), 'utf8');
const { analyzeSchedule, SCHEDULE_FIELDS } = await import(`data:text/javascript;base64,${Buffer.from(transpile(scheduleSource)).toString('base64')}`);
const helpers = transpile(source.slice(source.indexOf('// --- Utilitários'), source.indexOf('// --- Configuração Firebase')));
const { compressStringUnicode, decompressIfNeeded, serializeCrono, deserializeCrono } = new Function(
  `${helpers}; return { compressStringUnicode, decompressIfNeeded, serializeCrono, deserializeCrono };`
)();

function extractHandler(name, nextName, context) {
  const handler = source.slice(source.indexOf(`  const ${name} =`), source.indexOf(`  const ${nextName} =`))
    .replace("const XLSX = await import('xlsx');", 'const XLSX = depsXLSX;');
  return new Function('context', `${helpers}; const { ${Object.keys(context).join(', ')} } = context;
    ${transpile(handler)}; return ${name};`)(context);
}

async function importWorkbook(count, review = preview => analyzeSchedule(preview.sheets[0])) {
  const rows = [
    ['', '', '', '', '', '', '', '', 'Avanço físico (%)'],
    ['ID', 'Pacote de trabalho', 'Serviço', 'Lote', 'Responsáveis', 'Predecessoras', 'Data de Início', 'Data de Término', 'Realizado']
  ];
  for (let i = 1; i <= count; i++) rows.push([
    String(i), 'Estrutura', `Serviço ${i} – concretagem`, 'Térreo', 'Equipe Civil', i > 1 ? String(i - 1) : '', '2026-10-01', '2026-10-31', '37,5%'
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Cronograma');
  const binary = XLSX.write(workbook, { type: 'binary', bookType: 'xlsx' });
  let saved;
  let notification;
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const statuses = [];
  const noop = () => {};
  const context = {
    depsXLSX: XLSX,
    SCHEDULE_FIELDS,
    setScheduleImportPreview: preview => { if (preview) preview.resolve(review(preview)); },
    FileReader: class { readAsBinaryString() { this.onload({ target: { result: binary } }); } },
    setIsImporting: value => { if (!value) finish(); },
    setImportStatus: value => statuses.push(value),
    setNotification: value => { notification = value; },
    teamsRef: { current: [] }, floors: [], cronogramaInicial: [],
    budgetDiffsRef: { current: [] }, budgetImportVersionsRef: { current: [] },
    allFloorsData: {}, weights: {}, matrices: [], planning: [], history: [],
    delayReasonsRef: { current: [] }, ppcHistory: [], teamPhones: {},
    projectCity: '', weatherApiKey: '', weatherCache: {}, MAX_IMPORTED_CRONOGRAMA_ITEMS: 15000,
    saveToDB: async (...args) => { saved = args; },
    setBudgetDiffs: noop, setBudgetImportVersions: noop, setActiveTab: noop
  };
  const upload = extractHandler('handleFileUpload', 'handleAddFloor', context);
  upload({ target: { files: [{ name: 'cronograma.xlsx' }] } });
  await complete;
  return { saved, notification, statuses };
}

test('importa um único XLSX com 9000 atividades, progresso e dependências', async () => {
  const { saved, notification, statuses } = await importWorkbook(9000);
  assert.equal(notification.type, 'success', notification.message);
  assert.equal(saved[5].length, 9000);
  assert.equal(saved[1]['Térreo'].estrutura.items.length, 9000);
  assert.equal(saved[5][8999].originalId, '9000');
  assert.deepEqual(saved[5][8999].predecessors, ['8999']);
  assert.equal(saved[5][8999].progress, 37.5);
  assert.equal(saved[5][8999].start, '2026-10-01');
  assert.equal(saved[5][8999].end, '2026-10-31');
  assert.ok(statuses.some(status => status.includes('9000 de 9000')));
});

test('recusa arquivo acima do limite sem gravar um cronograma cortado', async () => {
  const { saved, notification } = await importWorkbook(15001);
  assert.equal(saved, undefined);
  assert.equal(notification.type, 'error');
  assert.match(notification.message, /nenhum dado foi importado/);
});

test('recupera 9000 atividades após dividir uma carga maior que 1 MiB', async () => {
  const items = Array.from({ length: 9000 }, (_, i) => ({
    id: `xls_${i}`, macro: 'ESTRUTURA', floor: 'Térreo',
    service: `CONCRETAGEM ${i} ` + Array.from({ length: 24 }, (_, j) => `${(i * 7919 + j * 104729).toString(36)}`).join(' '),
    originalId: String(i), progress: 37.5, predecessors: [String(i - 1)], successors: [String(i + 1)],
    duration: 10, start: '2026-10-01', end: '2026-10-31', responsible: 'EQUIPE CIVIL', cost: i * 137.91
  }));
  const serialized = serializeCrono(items);
  const payload = compressStringUnicode(JSON.stringify(serialized));
  assert.ok(payload.length > 1_048_576, `Carga: ${payload.length} bytes`);
  const prepared = await preparePayload(payload, 'obra_crono');
  assert.ok(prepared.chunks.length >= 2);
  assert.ok(prepared.chunks.every(part => part.payload.length <= PAYLOAD_CHUNK_BYTES));
  const store = new Map(prepared.chunks.map(part => [part.id, part.payload]));
  const reloaded = await resolvePayload(prepared.value, async id => store.get(id));
  assert.deepEqual(JSON.parse(decompressIfNeeded(reloaded)), serialized);
  assert.equal(deserializeCrono(JSON.parse(decompressIfNeeded(reloaded)))[8999].service, items[8999].service);
  assert.deepEqual(await preparePayload(payload, 'obra_crono'), prepared);
});

test('mantém formato antigo e carga pequena; rejeita partes ausentes ou corrompidas', async () => {
  const small = compressStringUnicode('[{"service":"Concretagem – Térreo"}]');
  const inline = await preparePayload(small, 'obra_crono');
  assert.equal(inline.value, small);
  assert.equal(inline.chunks.length, 0);
  assert.equal(await resolvePayload(small, async () => assert.fail()), small);
  const legacy = [{ id: '1', progress: 75 }];
  assert.equal(await resolvePayload(legacy, async () => assert.fail()), legacy);
  const large = await preparePayload('a'.repeat(PAYLOAD_CHUNK_BYTES + 1), 'obra_crono');
  await assert.rejects(resolvePayload(large.value, async () => undefined), /ausente/);
  await assert.rejects(resolvePayload(large.value, async id => 'b'.repeat(large.chunks.find(part => part.id === id).payload.length)), /corrompida/);
});

test('salva cronograma, físico e planejamento juntos; falha não deixa gravação parcial', async () => {
  const store = new Map([['obra', { projectDelayReasons: ['Motivo cadastrado depois do início do salvamento'] }]]);
  let failCommit = false;
  let commits = 0;
  const noop = () => {};
  const context = {
    db: {}, selectedProjectId: 'obra', urlUserId: '',
    hydratedProjectIdsRef: { current: new Set(['obra']) },
    appId: 'test', isTeamMode: false, urlTeamName: '', plannerUsername: 'Teste',
    MAX_IMPORTED_CRONOGRAMA_ITEMS: 15000, INITIAL_TEAMS: [], INITIAL_DELAYS: [],
    MAX_SAVE_BYTES: 8000000, preparePayload,
    normalizeDelayReasonFields, mergeDelayReasons,
    generalDelayReasonsRef: { current: GENERAL_DELAY_REASONS },
    setDbSavingStatus: noop, setCronogramaInicial: noop, setNotification: noop,
    console: { error: noop, warn: noop },
    doc: (parent, path, id) => id
      ? { parent: { path }, id }
      : { parent, id: path },
    writeBatch: () => {
      const pending = new Map();
      return {
        set: (ref, value, options) => {
          assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1_048_576);
          pending.set(ref.id, options?.merge ? { ...store.get(ref.id), ...value } : value);
        },
        commit: async () => {
          if (failCommit) throw new Error('Falha simulada');
          commits++;
          for (const [id, value] of pending) store.set(id, value);
        }
      };
    }
  };
  const save = extractHandler('performActualSave', 'saveToDB', context);
  const args = {
    fls: ['Térreo'], data: { 'Térreo': { estrutura: { title: 'ESTRUTURA', items: [] } } },
    crono: [], plans: [], hist: [], wts: {}, mats: [], tms: [], delays: [], ppcHist: []
  };
  for (let i = 0; i < 9000; i++) {
    const name = `CONCRETAGEM ${i} ` + Array.from({ length: 24 }, (_, j) => (i * 7919 + j * 104729).toString(36)).join(' ');
    args.crono.push({ id: `xls_${i}`, macro: 'ESTRUTURA', floor: 'Térreo', service: name, progress: 37.5 });
    args.data['Térreo'].estrutura.items.push({ id: `xls_${i}`, name, actualPercent: 37.5 });
    args.plans.push({ id: `plan_${i}`, description: name });
  }
  await save(args);
  assert.equal(commits, 1);
  assert.deepEqual(store.get('obra').projectDelayReasons, ['Motivo cadastrado depois do início do salvamento']);
  const revision = store.get('obra').payloadRevision;
  for (const [suffix, field] of [['_crono', 'cronogramaInicial'], ['_floors', 'data'], ['_planning', 'planning']]) {
    const document = store.get(`obra${suffix}`);
    assert.equal(document.payloadRevision, revision);
    assert.equal(document[field].format, 'chunks-v1');
    const payload = await resolvePayload(document[field], async id => store.get(id)?.payload);
    const restored = JSON.parse(decompressIfNeeded(payload));
    if (field === 'data') assert.equal(restored['Térreo'].estrutura.items.length, 9000);
    else assert.equal(restored.length, 9000);
  }
  const previous = new Map(store);
  failCommit = true;
  await assert.rejects(save({ ...args, crono: [] }), /Falha simulada/);
  assert.deepEqual(store, previous);
});

test('cancelar a prévia não grava nem substitui dados do projeto', async () => {
  const { saved, notification } = await importWorkbook(2, () => null);
  assert.equal(saved, undefined);
  assert.equal(notification, undefined);
});
