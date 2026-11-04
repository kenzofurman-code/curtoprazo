import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function evaluate(code, context, expression = '') {
  return vm.runInNewContext(ts.transpile(code, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React
  }) + `\n${expression}`, context);
}
const closureModule = { exports: {} };
evaluate(await readFile(new URL('../src/weekClosure.ts', import.meta.url), 'utf8'), closureModule);
const { finalizePlanningWeek, reopenPlanningWeek, ClosedNextWeekError } = closureModule.exports;
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
const weekId = '2026-10-26', nextWeekId = '2026-11-02';
const task = (id = 'a', fields = {}) => ({
  id, itemId: `item-${id}`, weekId, floor: 'Térreo', sectionId: 'estrutura', activityName: `Atividade ${id}`,
  responsible: 'Equipe A', executedBefore: 0, executedBeforeRaw: 0, plannedThisWeek: 100, progressThisWeek: 25,
  dailyWork: [0, 0, 0, 0, 0], observations: '', delayReason: '', finalized: false, ...fields
});
const close = (planning, options = {}) => finalizePlanningWeek({
  planning, ppcHistory: [], weekId, nextWeekId, carryOver: true, actor: 'Pedro', now: '2026-11-04T12:00:00Z', makeId: randomUUID, ...options
});
const next = result => result.planning.filter(task => task.weekId === nextWeekId);
const plain = value => JSON.parse(JSON.stringify(value));

test('fecha todas as atividades e cria saldo de 75% para atividade com 25% realizado', () => {
  const result = close([task('a', { budgetDiffIds: ['d1'], preFilledProgress: 25, preFilledAt: 'ontem' })]);
  assert.equal(result.planning[0].finalized, true);
  const carry = next(result)[0];
  assert.equal(carry.executedBeforeRaw, 25);
  assert.equal(carry.plannedThisWeek, 75);
  assert.equal(carry.progressThisWeek, 0);
  assert.equal(carry.carriedFromTaskId, 'a');
  assert.equal(carry.finalized, false);
  assert.equal(carry.budgetDiffIds.length, 0);
  assert.equal(carry.preFilledProgress, undefined);
  assert.equal(result.ppc, 0);
});

test('refinalizar após adicionar atividade cria o saldo faltante sem duplicar o anterior', () => {
  const first = close([task()]);
  const result = close([...first.planning, task('nova', { progressThisWeek: 0 })], { ppcHistory: first.ppcHistory });
  assert.equal(next(result).length, 2);
  assert.equal(next(result).find(task => task.itemId === 'item-a').id, next(first)[0].id);
  assert.equal(next(result).find(task => task.itemId === 'item-nova').plannedThisWeek, 100);
  assert.ok(result.planning.filter(task => task.weekId === weekId).every(task => task.finalized));
  const repeated = close(result.planning, { ppcHistory: result.ppcHistory });
  assert.equal(next(repeated).length, 2);
});

test('recalcula saldo automático mantendo o percentual exato', () => {
  const first = close([task()]);
  const result = close(first.planning.map(task => task.weekId === weekId ? { ...task, progressThisWeek: 62.375 } : task));
  assert.equal(next(result)[0].executedBeforeRaw, 62.375);
  assert.equal(next(result)[0].plannedThisWeek, 37.625);
});

test('preserva equipe, meta alterada, dias, observações e medições da semana seguinte', () => {
  const first = close([task()]);
  const carry = { ...next(first)[0], responsible: 'Equipe B', plannedThisWeek: 100, progressThisWeek: 50, observations: 'Executar ala B', dailyWork: [1, 0, 1, 0, 0], delayReason: 'Chuva' };
  const result = close([task('a', { progressThisWeek: 75, finalized: true }), carry]);
  const updated = next(result)[0];
  assert.equal(updated.executedBeforeRaw, 75);
  for (const field of ['id', 'responsible', 'plannedThisWeek', 'progressThisWeek', 'observations', 'dailyWork', 'delayReason']) {
    assert.deepEqual(plain(updated[field]), plain(carry[field]));
  }
});

test('remove saldo obsoleto sem apagar atividade com lançamento posterior', () => {
  const first = close([task()]);
  const finished = task('a', { progressThisWeek: 100, finalized: true });
  assert.equal(next(close([finished, next(first)[0]])).length, 0);
  const worked = { ...next(first)[0], progressThisWeek: 50, observations: 'Medição registrada' };
  const retained = next(close([finished, worked]));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].progressThisWeek, 50);
  assert.equal(retained[0].observations, 'Medição registrada');
  const removedSource = close([task('b', { progressThisWeek: 100 }), next(first)[0]]);
  assert.equal(next(removedSource).length, 0);
});

test('reaproveita atividade já adicionada manualmente na próxima semana', () => {
  const scheduled = task('next-a', { itemId: 'item-a', weekId: nextWeekId, responsible: 'Equipe B', plannedThisWeek: 50, observations: 'Programada pela equipe' });
  const result = close([task(), scheduled]);
  assert.equal(next(result).length, 1);
  assert.equal(next(result)[0].id, 'next-a');
  assert.equal(next(result)[0].plannedThisWeek, 50);
  assert.equal(next(result)[0].observations, scheduled.observations);
  assert.equal(next(result)[0].isCarryOver, undefined);
});

test('bloqueia alterações em semana seguinte finalizada e não modifica os dados recebidos', () => {
  const first = close([task()]);
  const input = [task('a', { progressThisWeek: 75 }), { ...next(first)[0], finalized: true }];
  const before = JSON.stringify(input);
  assert.throws(() => close(input), error => error instanceof ClosedNextWeekError && error.weekId === nextWeekId);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => close([task()], { ppcHistory: [{ weekId: nextWeekId, ppc: 100 }] }), ClosedNextWeekError);
  const unchanged = close([task(), { ...next(first)[0], finalized: true }]);
  assert.equal(next(unchanged)[0].finalized, true);
});

test('opção sem reprogramação não cria atividades novas e atividades manuais carregam corretamente', () => {
  assert.equal(next(close([task()], { carryOver: false })).length, 0);
  const manual = next(close([task('manual', { isManual: true, sectionId: 'manual', progressThisWeek: 25 })]))[0];
  assert.equal(manual.isManual, true);
  assert.equal(manual.executedBeforeRaw, 25);
  assert.equal(manual.plannedThisWeek, 75);
});

test('substitui PPC da semana e mantém autoria e valores do fechamento anterior', () => {
  const first = close([task('a', { progressThisWeek: 100 }), task('extra', { plannedThisWeek: 0, progressThisWeek: 10 })]);
  assert.equal(first.ppc, 100);
  const result = close([...first.planning, task('b')], {
    ppcHistory: [...first.ppcHistory, { weekId: '2026-10-19', ppc: 40 }], actor: 'Ana', now: '2026-11-05T12:00:00Z'
  });
  const records = result.ppcHistory.filter(record => record.weekId === weekId);
  assert.equal(records.length, 1);
  assert.equal(records[0].ppc, 50);
  assert.equal(records[0].totalPlanned, 2);
  assert.equal(records[0].closureHistory[0].ppc, 100);
  assert.equal(records[0].closureHistory[0].correctedBy, 'Ana');
  assert.equal(records[0].firstFinalizedAt, first.ppcHistory[0].timestamp);
  assert.equal(result.ppcHistory.find(record => record.weekId === '2026-10-19').ppc, 40);
});

test('sincronização preserva medições e avanço anterior de semanas finalizadas posteriores', () => {
  const context = {};
  const sync = evaluate(['slugify', 'clampPercent', 'roundDown25', 'cloneDeep', 'syncPlanningAndPhysical'].map(declaration).join('\n'), context, 'syncPlanningAndPhysical');
  const locked = task('locked', { itemId: 'item-a', weekId: '2026-11-09', finalized: true, executedBefore: 25, executedBeforeRaw: 25, progressThisWeek: 90 });
  const planning = [task('a', { finalized: true, progressThisWeek: 75 }), locked, task('open', { itemId: 'item-a', weekId: '2026-11-16', progressThisWeek: 0 })];
  const result = sync(planning, {}, []);
  assert.deepEqual(plain(result.recalculatedPlanning.find(task => task.id === 'locked')), plain(locked));
  assert.equal(result.recalculatedPlanning.find(task => task.id === 'open').executedBeforeRaw, 90);
});

function handlerContext(save) {
  const datesModule = { exports: {} };
  const state = {};
  const context = {
    finalizePlanningWeek, ClosedNextWeekError, crypto: { randomUUID }, finalizingWeekRef: { current: false },
    weekClosureContextRef: { current: 'poty||' + weekId }, isProjectHydrated: true, isWeekFinalized: true, isWeekBeingEdited: true,
    currentWeekStart: new Date(2026, 9, 26), currentWeekId: weekId, planning: [task('a', { finalized: true }), task('nova')],
    ppcHistory: [], plannerUsername: 'Pedro', allFloorsData: {}, cronogramaInicial: [],
    saveToDB: save, floors: [], history: [{ timestamp: '2026-11-04T12:00:00Z', isCorrection: true }], weights: {}, teams: [], delayReasons: [], matrices: [], teamPhones: {}, projectCity: '', weatherApiKey: '', weatherCache: {},
    setNotification: value => { state.notification = value; }, console: { error: () => {} }
  };
  for (const name of ['Planning', 'AllFloorsData', 'PpcHistory', 'EditingFinalizedWeekId', 'SelectedTaskIds', 'FinalizeModal', 'CurrentWeekStart', 'IsFinalizingWeek']) {
    context[`set${name}`] = value => { state[name] = value; };
  }
  return { context, state, datesModule };
}

test('refinalização salva imediatamente, bloqueia duplo clique e só encerra edição após sucesso', async () => {
  let finish, args, calls = 0;
  const harness = handlerContext(async (...values) => { args = values; calls++; await new Promise(resolve => { finish = resolve; }); });
  evaluate(await readFile(new URL('../src/dates.ts', import.meta.url), 'utf8'), harness.datesModule);
  Object.assign(harness.context, harness.datesModule.exports);
  const handler = evaluate(['cloneDeep', 'slugify', 'clampPercent', 'roundDown25', 'addDays', 'syncPlanningAndPhysical', 'handleFinalizeWeek'].map(declaration).join('\n'), harness.context, 'handleFinalizeWeek');
  const pending = handler(true);
  await handler(true);
  assert.equal(calls, 1);
  assert.equal(args[15], true);
  assert.ok(args[4].filter(task => task.weekId === weekId).every(task => task.finalized));
  assert.equal(args[4].filter(task => task.weekId === nextWeekId).length, 2);
  assert.equal(args[2][0].isCorrection, true);
  assert.equal(harness.state.CurrentWeekStart, undefined);
  finish();
  await pending;
  assert.equal(harness.state.EditingFinalizedWeekId, null);
  assert.equal(harness.state.PpcHistory.length, 1);
  assert.equal(harness.state.FinalizeModal.isOpen, false);
  assert.equal(harness.context.finalizingWeekRef.current, false);
});

test('falha de gravação mantém a semana em edição e não avança a navegação', async () => {
  const harness = handlerContext(async () => { throw new Error('Falha simulada'); });
  evaluate(await readFile(new URL('../src/dates.ts', import.meta.url), 'utf8'), harness.datesModule);
  Object.assign(harness.context, harness.datesModule.exports);
  const handler = evaluate(['cloneDeep', 'slugify', 'clampPercent', 'roundDown25', 'addDays', 'syncPlanningAndPhysical', 'handleFinalizeWeek'].map(declaration).join('\n'), harness.context, 'handleFinalizeWeek');
  await handler(true);
  assert.equal(harness.state.CurrentWeekStart, undefined);
  assert.equal(harness.state.EditingFinalizedWeekId, undefined);
  assert.equal(harness.state.Planning, undefined);
  assert.equal(harness.state.notification.type, 'error');
  assert.equal(harness.context.finalizingWeekRef.current, false);
});

test('botão de finalizar fica disponível durante a edição de semana já finalizada', () => {
  let button;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button' && node.getText(ast).includes("isWeekBeingEdited ? 'Finalizar Semana Novamente'")) button = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const editing of [true, false]) {
    const element = evaluate(`const element = (${button});`, {
      React, isWeekBeingEdited: editing, hasFinalizedTasks: true, weeklyTasks: [task()], isFinalizingWeek: false, isWeekFinalized: true
    }, 'element');
    assert.equal(element.props.hidden, !editing);
    assert.equal(element.props.disabled, !editing);
    if (editing) assert.match(renderToStaticMarkup(element), /Finalizar Semana Novamente/);
  }
});

test('reabertura persiste sem perder o fechamento anterior e continua editável após recarregar', () => {
  const first = close([task()]);
  const reopened = reopenPlanningWeek({ ...first, weekId, actor: 'Ana', now: '2026-11-05T12:00:00Z' });
  const restored = JSON.parse(JSON.stringify(reopened));
  assert.equal(restored.planning.find(task => task.weekId === weekId).finalized, false);
  const record = restored.ppcHistory.find(record => record.weekId === weekId);
  assert.equal(record.isReopened, true);
  assert.equal(record.ppc, first.ppc);
  assert.equal(record.reopenedBy, 'Ana');
  const editable = evaluate(declaration('isCorrectionWeek') + '\n' + declaration('isWeekBeingEdited'), {
    currentWeekId: weekId, editingFinalizedWeekId: null, ppcHistory: restored.ppcHistory
  }, 'isWeekBeingEdited');
  assert.equal(editable, true);
  const reclosed = close(restored.planning, { ppcHistory: restored.ppcHistory });
  const finalRecord = reclosed.ppcHistory.find(record => record.weekId === weekId);
  assert.equal(finalRecord.isReopened, false);
  assert.equal(finalRecord.closureHistory[0].reopenedBy, 'Ana');
});

test('reabrir explicitamente a próxima semana libera ajuste de saldo antes bloqueado', () => {
  const first = close([task()]);
  const planning = [task('a', { finalized: false, progressThisWeek: 75 }), { ...next(first)[0], finalized: true }];
  const ppcHistory = [...first.ppcHistory, { weekId: nextWeekId, ppc: 0, totalPlanned: 1, completed: 0, timestamp: '2026-11-03T12:00:00Z' }];
  assert.throws(() => close(planning, { ppcHistory }), ClosedNextWeekError);
  const reopened = reopenPlanningWeek({ planning, ppcHistory, weekId: nextWeekId, actor: 'Pedro', now: '2026-11-04T12:00:00Z' });
  const result = close(reopened.planning, { ppcHistory: reopened.ppcHistory });
  assert.equal(next(result)[0].executedBeforeRaw, 75);
  assert.equal(next(result)[0].plannedThisWeek, 25);
  assert.equal(next(result)[0].finalized, false);
  assert.equal(result.ppcHistory.find(record => record.weekId === nextWeekId).isReopened, true);
});

test('atalho de edição salva a reabertura imediatamente antes de desbloquear a tela', async () => {
  let confirm, args, finish;
  const harness = handlerContext(async (...values) => { args = values; await new Promise(resolve => { finish = resolve; }); });
  evaluate(await readFile(new URL('../src/dates.ts', import.meta.url), 'utf8'), harness.datesModule);
  Object.assign(harness.context, harness.datesModule.exports, {
    reopenPlanningWeek,
    triggerConfirm: (_title, _message, callback) => { confirm = callback; },
    setActiveTab: value => { harness.state.ActiveTab = value; }
  });
  const open = evaluate(['getWeekStartDate', 'parseISODateLocal', 'handleOpenWeekForEditing'].map(declaration).join('\n'), harness.context, 'handleOpenWeekForEditing');
  open(weekId);
  const pending = confirm();
  assert.equal(args[15], true);
  assert.ok(args[4].filter(task => task.weekId === weekId).every(task => !task.finalized));
  assert.equal(args[8].find(record => record.weekId === weekId).isReopened, true);
  assert.equal(harness.state.EditingFinalizedWeekId, undefined);
  finish();
  await pending;
  assert.equal(harness.state.EditingFinalizedWeekId, weekId);
  assert.equal(harness.state.ActiveTab, 'planning');
});
