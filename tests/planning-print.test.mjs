import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    declarations.set(node.name.text, node.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);

test('impressão usa os mesmos dias exibidos no planejamento para dados antigos e novos', () => {
  const days = [[0, 0, 0, 0, 0], undefined, [], [1, 1, 1, 1, 1], [1, 0, 1, 0, 1]];
  const tasks = days.map((dailyWork, index) => ({
    activityName: `Atividade ${index}`, dailyWork, floor: '12º Pav', responsible: 'SILFOR'
  }));
  const original = JSON.stringify(tasks);
  let html;
  const context = {
    currentWeekStart: new Date('2026-11-23T12:00:00'),
    filteredWeeklyTasks: tasks, weeklyTasks: tasks, projects: [], selectedProjectId: 'platea',
    getSimpleServiceInstruction: task => task.activityName, formatDateBR: () => '23/11/26',
    toISODate: date => date.toISOString().slice(0, 10), projectCity: '', weatherCache: {},
    getWeatherEmoji: () => '', formatTimestamp: () => 'Teste',
    window: { open: () => ({ document: { write: value => { html = value; }, close() {} } }) }
  };
  const code = ['normalizeDailyWork', 'handlePrintPlanning']
    .map(name => `const ${declarations.get(name)};`).join('\n');
  vm.runInNewContext(code + '\nhandlePrintPlanning();', context);
  const rows = JSON.parse(html.match(/var allRows=(.*);/)[1]);
  assert.deepEqual(rows.map(row => row.dailyWork), [
    [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1], [1, 0, 1, 0, 1]
  ]);
  let body;
  const document = {
    addEventListener() {},
    querySelectorAll: () => [],
    getElementById: id => id === 'pb'
      ? { set innerHTML(value) { body = value; } }
      : { style: {}, classList: { add() {}, remove() {} } }
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document, window: {} });
  const counts = [...body.matchAll(/<div class="days-cell">([\s\S]*?)<\/td>/g)]
    .map(match => (match[1].match(/day-chip worked/g) || []).length);
  assert.deepEqual(counts, [5, 5, 5, 5, 3]);
  assert.equal(JSON.stringify(tasks), original);
});
