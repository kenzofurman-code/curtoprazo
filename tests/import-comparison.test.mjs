import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto, randomUUID } from 'node:crypto';
import ts from 'typescript';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return `const ${found.getText(ast)};`;
}
function evaluate(code, context, expression = '') {
  return vm.runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }) + `\n${expression}`, context);
}
const module = { exports: {} };
evaluate(await readFile(new URL('../src/importComparison.ts', import.meta.url), 'utf8'), module);
const { snapshotImport, pendingComparisonDiffs } = module.exports;
const helpers = ['slugify', 'clampPercent', 'roundPercentValue', 'getBudgetFamilyKey', 'isParentBudgetItem', 'getFamiliesWithBudgetChildren', 'buildBudgetDiffs'].map(declaration).join('\n');
const item = (id, progress) => ({ id, originalId: id, progress, floor: 'Térreo', macro: 'Estrutura', service: `Serviço ${id}`, isParent: false });
const importCode = source.slice(source.indexOf('          const importVersionId ='), source.indexOf("          setImportStatus('Preparando dados"));
function importVersion(items, snapshot = null, versions = [], oldDiffs = []) {
  return evaluate(helpers + '\n' + importCode, {
    crypto: { randomUUID }, parsedItems: items, file: { name: 'cronograma.xlsx' }, snapshotImport,
    budgetImportSnapshotRef: { current: snapshot }, budgetImportVersionsRef: { current: versions }, budgetDiffsRef: { current: oldDiffs },
    cronogramaInicial: items.map(value => ({ ...value, progress: 0 }))
  }, '({diffs:updatedBudgetDiffs, snapshot:updatedImportSnapshot, versions:updatedBudgetImportVersions})');
}

test('primeira importação cria referência sem herdar pendências antigas', () => {
  const result = importVersion([item('a', 50)], null, [{ id: 'legado' }], [{ itemId: 'antigo', delta: 50 }]);
  assert.equal(result.diffs.length, 0);
  assert.equal(pendingComparisonDiffs(result.diffs, result.versions).length, 0);
  assert.equal(result.snapshot.items[0].progress, 50);
});

test('compara os arquivos originais mesmo após editar o andamento no planejamento', () => {
  const original = [item('a', 50), item('b', 25)];
  const first = importVersion(original);
  original[0].progress = 0;
  const second = importVersion([item('a', 75), item('b', 25)], first.snapshot, first.versions);
  const pending = pendingComparisonDiffs(second.diffs, second.versions);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].previousProgress, 50);
  assert.equal(pending[0].newProgress, 75);
  assert.equal(pending[0].delta, 25);
  assert.equal(pending[0].importId, second.versions.at(-1).id);
  assert.equal(pending[0].previousImportId, first.versions.at(-1).id);
  const repeated = importVersion([item('a', 75), item('b', 25)], second.snapshot, second.versions, second.diffs);
  assert.equal(pendingComparisonDiffs(repeated.diffs, repeated.versions).length, 0);
});

test('contador considera atividades únicas apenas do par atual e não ressuscita duplicatas aplicadas', () => {
  const versions = [{ id: 'anterior' }, { id: 'atual', previousVersionId: 'anterior' }];
  const current = { id: 'd1', itemId: 'a', importId: 'atual', previousImportId: 'anterior', delta: 25, importedAt: '2026-11-04T10:00:00Z' };
  const diffs = [
    ...Array.from({ length: 1041 }, (_, index) => ({ ...current, id: `antigo-${index}`, itemId: `antigo-${index}`, importId: 'antigo' })),
    current, { ...current, id: 'd2', importedAt: '2026-11-04T11:00:00Z' },
    { ...current, itemId: 'redução', delta: -25 }, { ...current, itemId: 'zero', delta: 0 }
  ];
  assert.equal(pendingComparisonDiffs(diffs, versions).length, 1);
  diffs[1042].appliedWeekId = '2026-10-26';
  assert.equal(pendingComparisonDiffs(diffs, versions).length, 0);
  assert.equal(pendingComparisonDiffs(diffs, [{ id: 'legado' }, { id: 'sem-vínculo' }]).length, 0);
});

test('dados grandes da comparação sobrevivem à gravação em partes, sem corte em 1200 diferenças', async () => {
  const payloadModule = { exports: {}, crypto: webcrypto, TextEncoder };
  evaluate(await readFile(new URL('../src/chunkedPayload.ts', import.meta.url), 'utf8'), payloadModule);
  const { preparePayload, resolvePayload } = payloadModule.exports;
  const records = Array.from({ length: 1500 }, (_, i) => ({ ...item(`item-${i}`, 75), itemId: `item-${i}`, importId: 'atual', previousImportId: 'anterior', delta: 25, padding: 'a'.repeat(600) }));
  const value = JSON.stringify({ snapshot: snapshotImport(records, 'atual'), diffs: records })
    .replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const payload = await preparePayload(value, 'poty_import_comparison');
  assert.ok(payload.chunks.length > 1);
  const parts = new Map(payload.chunks.map(part => [part.id, part.payload]));
  const restored = JSON.parse(await resolvePayload(JSON.parse(JSON.stringify(payload.value)), async id => parts.get(id)));
  assert.equal(restored.snapshot.items.length, 1500);
  assert.equal(pendingComparisonDiffs(restored.diffs, [{ id: 'anterior' }, { id: 'atual', previousVersionId: 'anterior' }]).length, 1500);
});

function generationContext(save) {
  const diffs = [{ id: 'd1', itemId: 'a', floor: 'Térreo', sectionId: 'estrutura', service: 'Serviço a', previousProgress: 50, newProgress: 75, delta: 25 }];
  const changes = [];
  const context = {
    crypto: { randomUUID }, generatingDiffsRef: { current: false }, budgetImportSnapshotRef: { current: { versionId: 'atual' } }, isProjectHydrated: true, setIsGeneratingDiffs: () => {},
    pendingBudgetDiffs: diffs, budgetDiffs: diffs, budgetDiffsRef: { current: diffs },
    planning: [], cronogramaInicial: [item('a', 75)], currentWeekId: '2026-10-26', plannerUsername: 'Teste', teams: [],
    allFloorsData: { 'Térreo': { estrutura: { items: [{ id: 'a', actualPercent: 75 }] } } },
    setPlanning: value => changes.push(value), setAllFloorsData: () => {}, setBudgetDiffs: () => {},
    saveToDB: save, setNotification: () => {}, floors: ['Térreo'], history: [], weights: {}, delayReasons: [], ppcHistory: [], matrices: [],
    teamPhones: {}, projectCity: '', weatherApiKey: '', weatherCache: {}, toLocalDateString: () => '2026-11-04', console: { error: () => {} }
  };
  const code = helpers + '\n' + ['cloneDeep', 'roundDown25', 'syncPlanningAndPhysical', 'handleGeneratePlanningFromBudgetDiffs'].map(declaration).join('\n');
  return { context, changes, generate: evaluate(code, context, 'handleGeneratePlanningFromBudgetDiffs') };
}

test('duplo clique gera uma vez na semana escolhida e falha de gravação preserva pendências', async () => {
  let finish, saves = 0, savedPlanning;
  const result = generationContext(async (...args) => { saves++; savedPlanning = args[4]; await new Promise(resolve => { finish = resolve; }); });
  const first = result.generate();
  await result.generate();
  assert.equal(saves, 1);
  assert.equal(result.changes.length, 0);
  assert.equal(savedPlanning.length, 1);
  assert.equal(savedPlanning[0].weekId, '2026-10-26');
  finish();
  await first;
  assert.equal(result.context.budgetDiffsRef.current[0].appliedWeekId, '2026-10-26');
  const failed = generationContext(async () => { throw new Error('Falha simulada'); });
  await failed.generate();
  assert.equal(failed.changes.length, 0);
  assert.equal(failed.context.budgetDiffsRef.current[0].appliedWeekId, undefined);
  assert.equal(failed.context.generatingDiffsRef.current, false);
});

test('grava snapshot, diferenças e revisão no mesmo lote do projeto', async () => {
  const writes = new Map();
  const payloadModule = { exports: {}, crypto: webcrypto, TextEncoder };
  evaluate(await readFile(new URL('../src/chunkedPayload.ts', import.meta.url), 'utf8'), payloadModule);
  const snapshot = snapshotImport([item('a', 75)], 'atual');
  const context = {
    db: {}, urlUserId: '', selectedProjectId: 'poty', appId: 'app', hydratedProjectIdsRef: { current: new Set(['poty']) },
    setDbSavingStatus: () => {}, setCronogramaInicial: () => {}, setNotification: () => {},
    doc: (...args) => ({ id: args.at(-1), parent: {} }),
    writeBatch: () => ({ set: (ref, data) => writes.set(ref.id, data), commit: async () => {} }),
    syncCronogramaWithFloorsData: value => value, serializeCrono: value => value, normalizeDelayReasonFields: value => value,
    generalDelayReasonsRef: { current: [] }, mergeDelayReasons: (_general, specific) => specific,
    INITIAL_TEAMS: [], INITIAL_DELAYS: [], isTeamMode: false, plannerUsername: 'Teste',
    ...payloadModule.exports, MAX_IMPORTED_CRONOGRAMA_ITEMS: 15000, crypto: { randomUUID }, TextEncoder, TextDecoder
  };
  const save = evaluate(['compressString', 'compressStringUnicode', 'decompressString', 'decompressStringUnicode', 'decompressIfNeeded', 'performActualSave'].map(declaration).join('\n'), context, 'performActualSave');
  await save({ targetUserId: 'poty', fls: [], data: {}, hist: [], plans: [], crono: [], bDiffs: [{ itemId: 'a', delta: 25 }], bImportVersions: [{ id: 'atual' }], bImportSnapshot: snapshot });
  const metadata = writes.get('poty');
  const stored = writes.get('poty_import_comparison');
  assert.equal(metadata.importComparisonFormat, 1);
  assert.equal(metadata.importComparisonRevision, stored.payloadRevision);
  assert.equal(stored.payloadRevision, metadata.payloadRevision);
  const decode = evaluate('', context, 'decompressIfNeeded');
  const restored = JSON.parse(decode(stored.importComparison));
  assert.equal(restored.snapshot.versionId, 'atual');
  assert.equal(restored.snapshot.items[0].progress, 75);
  assert.equal(restored.diffs[0].delta, 25);
});

test('carregamento mantém projetos antigos e aguarda revisão consistente da comparação nova', async () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.getText(ast).includes('const comparisonRef = doc')) effect = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const format of [undefined, 1]) {
    const callbacks = new Map();
    let hydrated = false;
    const snapshotRef = { current: null };
    const context = Object.fromEntries([...new Set(effect.match(/\bset[A-Z]\w+/g))].map(name => [name, () => {}]));
    Object.assign(context, {
      db: {}, userId: 'user', urlUserId: '', selectedProjectId: 'poty', appId: 'app', isTeamMode: false,
      useEffect: callback => callback(),
      hydratedProjectIdsRef: { current: new Set() }, budgetImportSnapshotRef: snapshotRef, budgetDiffsRef: { current: [] },
      setIsProjectHydrated: value => { hydrated = value; },
      doc: (...args) => ({ id: args.at(-1), parent: {} }),
      onSnapshot: (ref, callback) => { callbacks.set(ref.id, callback); return () => {}; },
      resolvePayload: async value => value, getDoc: async () => ({ exists: () => false }),
      syncPlanningAndPhysical: (plans, data) => ({ recalculatedPlanning: plans, updatedFloorsData: data }),
      syncCronogramaWithFloorsData: crono => crono, deserializeCrono: value => value,
      normalizeDelayReasonFields: value => value, cleanCarriedTask: value => value, mergeDelayReasons: () => [], formatTimestamp: () => ''
    });
    evaluate(declaration('decompressIfNeeded') + '\n' + effect, context);
    const snap = (data = {}) => ({ exists: () => true, data: () => data });
    callbacks.get('poty')(snap({ payloadRevision: 'r2', importComparisonRevision: 'r1', importComparisonFormat: format }));
    await callbacks.get('poty_crono')(snap({ payloadRevision: 'r2', cronogramaInicial: [] }));
    await callbacks.get('poty_floors')(snap({ payloadRevision: 'r2', data: {} }));
    await callbacks.get('poty_planning')(snap({ payloadRevision: 'r2', planning: [] }));
    if (format === undefined) {
      assert.equal(hydrated, true);
      assert.equal(snapshotRef.current, null);
    } else {
      assert.equal(hydrated, false);
      const data = { snapshot: snapshotImport([item('a', 75)], 'atual'), diffs: [] };
      await callbacks.get('poty_import_comparison')(snap({ payloadRevision: 'r0', importComparison: JSON.stringify(data) }));
      assert.equal(hydrated, false);
      await callbacks.get('poty_import_comparison')(snap({ payloadRevision: 'r1', importComparison: JSON.stringify(data) }));
      assert.equal(hydrated, true);
      assert.equal(snapshotRef.current.versionId, 'atual');
    }
  }
});
