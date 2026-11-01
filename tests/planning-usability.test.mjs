import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
}}).outputText;
function moduleFrom(source) {
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', compile(source))(require, mod.exports, mod);
  return mod.exports;
}
const { filterDelayReasons, default: DelayReasonSelect } = moduleFrom(await readFile(new URL('../src/DelayReasonSelect.tsx', import.meta.url), 'utf8'));
const { cleanCarriedTask, AUTOMATIC_CARRY_OVER_NOTE } = moduleFrom(await readFile(new URL('../src/planningCarryOver.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('busca por trecho encontra material e ignora maiúsculas e acentos', () => {
  const options = ['Falta de Material em Obra', 'Chuva / Clima Impróprio', 'Escassez de mão de obra'];
  assert.deepEqual(filterDelayReasons(options, 'mate'), [options[0]]);
  assert.deepEqual(filterDelayReasons(options, 'MATE'), [options[0]]);
  assert.deepEqual(filterDelayReasons(options, 'improprio'), [options[1]]);
  assert.deepEqual(filterDelayReasons(options, '   '), options);
  assert.deepEqual(filterDelayReasons(options, 'inexistente'), []);
});
test('seletor mantém o motivo selecionado e o bloqueio da semana finalizada', () => {
  const html = renderToStaticMarkup(React.createElement(DelayReasonSelect, {
    options: ['Falta de Material em Obra'], value: 'Falta de Material em Obra', disabled: true, onChange() {}
  }));
  assert.match(html, /Falta de Material em Obra/); assert.match(html, /disabled/);
  assert.match(html, /aria-haspopup="listbox"/); assert.match(html, /aria-expanded="false"/);
});
test('atividades já transferidas perdem somente a observação automática e a marca fora do planejado', () => {
  const original = { id: 'origem', observations: 'Observação da equipe', isUnplannedDetected: true, progressThisWeek: 37.5 };
  assert.equal(cleanCarriedTask(original), original);
  const carried = { ...original, id: 'seguinte', isCarryOver: true, carriedFromTaskId: 'origem' };
  assert.deepEqual(cleanCarriedTask(carried), { ...carried, isUnplannedDetected: false });
  const oldCarry = { ...original, observations: AUTOMATIC_CARRY_OVER_NOTE };
  const clean = cleanCarriedTask(oldCarry);
  assert.equal(clean.observations, ''); assert.equal(clean.isUnplannedDetected, false); assert.equal(clean.isCarryOver, true);
  assert.equal(clean.progressThisWeek, 37.5); assert.deepEqual(cleanCarriedTask(clean), clean);
});
test('finalizar semana transfere o saldo sem observação ou tag, preserva a origem e não duplica tarefas', async () => {
  const tasks = [
    { id: 'a', weekId: '2026-10-05', itemId: 'a', floor: 'Térreo', executedBefore: 0, progressThisWeek: 37.5,
      plannedThisWeek: 50, observations: 'Comentário original', isUnplannedDetected: true },
    { id: 'b', weekId: '2026-10-05', itemId: 'b', floor: 'Térreo', executedBefore: 100, progressThisWeek: 100, plannedThisWeek: 100 },
    { id: 'c', weekId: '2026-10-05', itemId: 'c', floor: 'Térreo', executedBefore: 25, progressThisWeek: 25 },
    { id: 'c-next', weekId: '2026-10-12', itemId: 'c', floor: 'Térreo' }
  ];
  let saved;
  const noop = () => {};
  const context = { isWeekFinalized: false, currentWeekStart: new Date(2026, 9, 5), currentWeekId: '2026-10-05',
    toLocalDateString: date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,
    weeklyTasks: tasks.filter(t => t.weekId === '2026-10-05'), planning: tasks, ppcHistory: [],
    getTaskAccumulatedProgress: t => Math.max(t.executedBefore || 0, t.progressThisWeek || 0),
    cloneDeep: structuredClone, allFloorsData: {}, cronogramaInicial: [], floors: [], history: [], weights: {}, teams: [], delayReasons: [], matrices: [],
    syncPlanningAndPhysical: plans => ({ recalculatedPlanning: plans, updatedFloorsData: {} }),
    saveToDB: async (...args) => { saved = args; }, setCurrentWeekStart: noop, setFinalizeModal: noop, setNotification: noop };
  const handler = source.slice(source.indexOf('  const handleFinalizeWeek ='), source.indexOf('  const handleUpdateTaskField ='));
  const finalize = new Function('context', `const {${Object.keys(context).join(',')}}=context;${compile(handler)};return handleFinalizeWeek;`)(context);
  await finalize(true);
  const updated = saved[4]; const transferred = updated.find(t => t.carriedFromTaskId === 'a');
  assert.equal(transferred.weekId, '2026-10-12'); assert.equal(transferred.executedBefore, 37.5);
  assert.equal(transferred.plannedThisWeek, 62.5); assert.equal(transferred.observations, ''); assert.equal(transferred.isUnplannedDetected, false);
  assert.equal(transferred.isCarryOver, true); assert.equal(transferred.finalized, false);
  const origin = updated.find(t => t.id === 'a');
  assert.equal(origin.observations, 'Comentário original'); assert.equal(origin.isUnplannedDetected, true); assert.equal(origin.finalized, true);
  assert.equal(updated.filter(t => t.itemId === 'c' && t.weekId === '2026-10-12').length, 1);
  assert.ok(!updated.some(t => t.carriedFromTaskId === 'b'));
});
