import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
function evaluate(code, context, result) {
  return vm.runInNewContext(ts.transpile(code.replaceAll('import.meta.env.VITE_GEMINI_API_KEY', '"test-key"'), {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS
  }) + `\n${result}`, context);
}
const datesSource = await readFile(new URL('../src/dates.ts', import.meta.url), 'utf8');
const datesContext = { exports: {} };
evaluate(datesSource, datesContext, '');
const dates = datesContext.exports;
const analysisModule = { exports: {} };
evaluate(await readFile(new URL('../src/weeklyAnalysis.ts', import.meta.url), 'utf8'), analysisModule, '');
const { requestWeeklyAnalysis } = analysisModule.exports;

test('Google recebe uma única requisição quando a cota se esgota', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestWeeklyAnalysis('test', 'prompt', controller.signal, async (_url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    return { ok: false, status: 429, json: async () => ({ error: { message: 'Quota exceeded' } }) };
  }), /limite de uso/);
  assert.equal(calls, 1);
});

test('carregar semana ou histórico não gera análise automaticamente', () => {
  const start = source.indexOf('  useEffect(() => {', source.indexOf('  const handleAIAnalysis'));
  const effect = source.slice(start, source.indexOf('  // --- Secções', start));
  for (const cached of ['', 'Análise salva']) {
    let calls = 0, analysis;
    evaluate(effect, {
      useEffect: callback => callback(), currentWeekStart: new Date(2026, 10, 2), ...dates,
      isProjectHydrated: true, selectedProjectId: 'qoya', aiAnalyzedWeekId: '', aiLoading: false,
      aiAnalysesHistory: { '2026-11-02': cached }, planning: [{ weekId: '2026-11-02' }],
      handleAIAnalysis: () => { calls++; }, setAiAnalysis: value => { analysis = value; },
      setAiAnalyzedWeekId: () => {}, setAiLoading: () => {}
    }, '');
    assert.equal(calls, 0);
    assert.equal(analysis, cached);
  }
});

function analysisContext(request) {
  const writes = [], analyses = [];
  const context = {
    ...dates, AbortController, activeTab: 'dashboard', isTeamMode: false, isProjectHydrated: true,
    aiRequestRef: { current: null }, aiContextKey: 'qoya||2026-11-02', selectedProjectId: 'qoya', urlUserId: '',
    currentWeekStart: new Date(2026, 10, 2), planning: [{ weekId: '2026-11-02', activityName: 'Serviço', floor: 'Térreo', finalized: true }],
    ppcHistory: [], currentWeekPpcStats: { percent: 0, totalPlannedCount: 1, completedCount: 0 },
    setAiLoading: () => {}, setAiAnalyzedWeekId: () => {}, setAiAnalysis: value => analyses.push(value),
    requestWeeklyAnalysis: request, db: {}, appId: 'app', aiAnalysesHistory: {}, setAiAnalysesHistory: () => {},
    compressStringUnicode: value => value, doc: (...args) => args, updateDoc: async (...args) => { writes.push(args); }
  };
  return { context, writes, analyses, handler: evaluate(declaration('handleAIAnalysis'), context, 'handleAIAnalysis') };
}

test('bloqueia cliques duplicados e salva a análise no projeto selecionado', async () => {
  let complete, calls = 0;
  const request = new Promise(resolve => { complete = resolve; });
  const { handler, writes } = analysisContext(() => { calls++; return request; });
  const first = handler();
  await handler();
  assert.equal(calls, 1);
  complete('Análise gerada');
  await first;
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].at(-1), 'qoya');
});

test('não chama Google fora do Painel ou antes de carregar o projeto', async () => {
  let calls = 0;
  const { context, handler } = analysisContext(async () => { calls++; return 'Análise'; });
  context.activeTab = 'cronograma-inicial';
  await handler();
  context.activeTab = 'dashboard'; context.isProjectHydrated = false;
  await handler();
  assert.equal(calls, 0);
});

test('trocar de projeto cancela a requisição e descarta a resposta anterior', async () => {
  let complete;
  const { context, handler, writes, analyses } = analysisContext(() => new Promise(resolve => { complete = resolve; }));
  let cleanup;
  function findEffect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.getText(ast).includes('aiRequestRef.current.controller.abort')) {
      evaluate(node.getText(ast), { ...context, useEffect: callback => { cleanup = callback(); } }, '');
    }
    ts.forEachChild(node, findEffect);
  }
  findEffect(ast);
  const pending = handler();
  const signal = context.aiRequestRef.current.controller.signal;
  cleanup();
  assert.equal(signal.aborted, true);
  complete('Resposta antiga');
  await pending;
  assert.equal(writes.length, 0);
  assert.equal(analyses.includes('Resposta antiga'), false);
});

test('cronograma limita linhas e permite renderizar a última página com seus valores', () => {
  const items = Array.from({ length: 5205 }, (_, i) => ({
    id: `item-${i}`, macro: 'Estrutura', service: `Serviço ${i}`, floor: 'Térreo', progress: i % 100, cost: i, end: '2026-11-04'
  }));
  for (const page of [1, 2, 53]) {
    const start = (page - 1) * 100;
    const visible = items.slice(start, start + 100);
    const context = {
      React, ...dates, filteredCronograma: items, cronogramaInicial: items, pagedCronograma: visible,
      cronoPageStart: start, currentCronoPage: page, cronoPageCount: 53, cronoScrollRef: { current: null },
      previousBudgetImport: null, currentBudgetImport: null, getBudgetImportTooltip: () => '', handleFileUpload: () => {},
      cronoSearch: '', cronoFloorFilter: '', cronoMacroFilter: '', cronoProgressFilter: '', cronoSortKey: '', cronoSortDir: 'asc',
      floors: [], allPossibleMacros: [], selectedProjectId: 'qoya', roundPercentValue: Number
    };
    const render = evaluate(declaration('renderCronograma'), context, 'renderCronograma');
    const html = renderToStaticMarkup(render());
    assert.equal((html.match(/<tr[ >]/g) || []).length - 1, visible.length);
    assert.ok(html.includes(`Serviço ${start}</td>`));
    assert.ok(html.includes(`Serviço ${start + visible.length - 1}</td>`));
    assert.ok(html.includes('04/11/26'));
  }
});

test('abas inativas e drawer fechado não percorrem os históricos do projeto', () => {
  const context = {
    useMemo: callback => callback(), activeTab: 'cronograma-inicial', isProjectHydrated: true,
    isDrawerOpen: false, itemCosts: new Map(), macroTitles: new Map(),
    cronogramaInicial: [], drawerSourceMode: 'cronograma', planning: [], previousWeekIdForDrawer: '2026-10-26'
  };
  for (const key of ['history', 'allFloorsData']) {
    Object.defineProperty(context, key, { get: () => { throw new Error('Percorreu dados de uma aba inativa'); } });
  }
  // Dependencies are evaluated by React; use inert values there and trap work inside the memo body.
  for (const name of ['macroEvolutionHistory', 'drawerCandidateActivities']) {
    const code = declaration(name);
    const callback = code.slice(code.indexOf('() => {'), code.lastIndexOf('}, [') + 1);
    const result = evaluate(`const ${name}Compute = ${callback};`, context, `${name}Compute()`);
    assert.equal(result.length, 0);
  }
});

test('índice de histórico preserva o realizado por atividade, pavimento e data', () => {
  const history = [
    { itemId: 'a', floor: 'Térreo', timestamp: '2026-11-01T12:00:00Z', progressAchieved: 15 },
    { itemId: 'a', floor: 'Térreo', timestamp: '2026-11-04T12:00:00Z', progressAchieved: 20 },
    { itemId: 'a', floor: 'Térreo', timestamp: '2026-11-05T12:00:00Z', progressAchieved: 10 },
    { itemId: 'a', floor: '1º Pav', timestamp: '2026-11-05T12:00:00Z', progressAchieved: 80 },
    { itemId: 'b', floor: 'Térreo', timestamp: '2026-11-05T12:00:00Z', progressAchieved: 70 },
    { itemId: 'a', floor: 'Térreo', timestamp: 'inválido', progressAchieved: 90 }, null
  ];
  const context = { history, useMemo: callback => callback(), getActivityActualProgress: () => 80 };
  const getProgress = evaluate(`${declaration('historyByActivity')}\n${declaration('getActivityProgressAtDate')}`, context, 'getActivityProgressAtDate');
  assert.equal(getProgress({ id: 'a', floor: 'Térreo' }, new Date('2026-11-02T12:00:00Z')), 50);
  assert.equal(getProgress({ id: 'a', floor: 'Térreo' }, new Date('2026-11-04T12:00:00Z')), 70);
  assert.equal(getProgress({ id: 'a', floor: '1º Pav' }, new Date('2026-11-02T12:00:00Z')), 0);
  assert.equal(getProgress({ id: 'b', floor: 'Térreo' }, new Date('2026-11-02T12:00:00Z')), 10);
  assert.equal(getProgress({ id: 'sem-histórico', floor: 'Térreo' }, new Date('2026-11-02T12:00:00Z')), 80);
});
