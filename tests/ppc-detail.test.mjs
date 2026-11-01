import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/ppcDetail.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
const { ppcPeriodWeeks, calculatePpcDetail, calculatePpcByTeam, getPpcSignal, teamsWithPlannedActivities } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('filtro de empresas com atividade respeita período, seleção e atividades de produção planejadas', () => {
  const planning = [
    {weekId: '2026-09-21', responsible: 'Produção A', plannedThisWeek: 50},
    {weekId: '2026-09-28', responsible: 'Produção B', plannedThisWeek: 100, progressThisWeek: 0},
    {weekId: '2026-09-28', responsible: 'Apoio', plannedThisWeek: 0},
    {weekId: '2026-10-05', responsible: 'Outra semana', plannedThisWeek: 100}
  ];
  const teams = ['Produção A', 'Produção B', 'Apoio', 'Outra semana', 'Sem registros'];
  assert.deepEqual(teamsWithPlannedActivities(planning, ['2026-09-28'], teams), ['Produção B']);
  assert.deepEqual(teamsWithPlannedActivities(planning, ['2026-09-21', '2026-09-28'], teams), ['Produção A', 'Produção B']);
  assert.deepEqual(teamsWithPlannedActivities(planning, ['2026-09-28'], ['Apoio']), []);
  assert.deepEqual(teamsWithPlannedActivities(planning, [], teams), []);
});

test('gestão à vista mantém o PPC de cada equipe separado em cada semana, incluindo semanas vazias', () => {
  const planning = [
    { weekId: '2026-09-21', responsible: 'A', plannedThisWeek: 100, progressThisWeek: 100 },
    { weekId: '2026-09-28', responsible: 'A', plannedThisWeek: 100, progressThisWeek: 0 },
    { weekId: '2026-09-28', responsible: 'B', plannedThisWeek: 50, progressThisWeek: 50 },
    { weekId: '2026-09-28', responsible: 'B', plannedThisWeek: 100, progressThisWeek: 0 },
    { weekId: '2026-09-28', responsible: 'C', plannedThisWeek: 100, progressThisWeek: 100 }
  ];
  const rows = calculatePpcByTeam(planning, ['2026-09-21', '2026-09-28'], ['A', 'B', 'A']);
  assert.deepEqual(rows.map(row => row.team), ['A', 'B']);
  assert.deepEqual(rows.map(row => row.weeks.map(week => week.ppc)), [[100, 0], [0, 50]]);
  assert.equal(rows[1].weeks[1].completedCount, 1);
  assert.equal(rows[1].weeks[1].plannedCount, 2);
  assert.equal(calculatePpcByTeam(planning, ['2026-09-28'], ['B'])[0].weeks.length, 1);
  assert.deepEqual(calculatePpcByTeam(planning, ['2026-09-28'], []), []);
});

test('farol compartilhado mantém as faixas solicitadas, inclusive 40% e 80%', () => {
  for (const [ppc, image] of [[0, 'triste'], [39, 'triste'], [40, 'normal'], [80, 'normal'], [81, 'feliz'], [100, 'feliz']]) {
    assert.equal(getPpcSignal(ppc).image, image);
  }
  assert.equal(getPpcSignal(0, 0), null);
  assert.equal(getPpcSignal(0, 1).image, 'triste');
  assert.equal(getPpcSignal(0).image, 'triste');
});
test('última semana usa a semana anterior real, mesmo sem registros, inclusive aos domingos', () => {
  assert.deepEqual(ppcPeriodWeeks('last-week', new Date(2026, 9, 8), ['2026-08-03']), ['2026-09-28']);
  assert.deepEqual(ppcPeriodWeeks('last-week', new Date(2026, 9, 11), []), ['2026-09-28']);
  assert.deepEqual(ppcPeriodWeeks('last-week', new Date(2026, 9, 12), []), ['2026-10-05']);
  assert.deepEqual(ppcPeriodWeeks('last-week', new Date(2026, 0, 1), []), ['2025-12-22']);
});
test('últimas 4 semanas incluem semanas vazias; histórico não inclui semanas atuais ou futuras', () => {
  assert.deepEqual(ppcPeriodWeeks('four-weeks', new Date(2026, 9, 8), []), ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  assert.deepEqual(ppcPeriodWeeks('history', new Date(2026, 9, 8), ['2026-10-12', '2026-10-05', '2026-09-28', '2026-09-14', '2026-09-14']), ['2026-09-14', '2026-09-28']);
  const empty = calculatePpcDetail([], ppcPeriodWeeks('four-weeks', new Date(2026, 9, 8), []), []);
  assert.equal(empty.rows.length, 4); assert.equal(empty.average, 0);
  assert.ok(empty.rows.every(row => row.ppc === 0)); assert.deepEqual(empty.causes, []);
});
const tasks = [
  { weekId: '2026-09-21', responsible: 'Equipe A', plannedThisWeek: 100, progressThisWeek: 100 },
  { weekId: '2026-09-28', responsible: 'Equipe A', plannedThisWeek: 100, progressThisWeek: 100 },
  { weekId: '2026-09-28', responsible: 'Equipe B', plannedThisWeek: 100, progressThisWeek: 0, delayReason: 'Material' },
  { weekId: '2026-09-28', responsible: 'Equipe C', plannedThisWeek: 100, progressThisWeek: 0, delayReason: 'Equipamento' }
];
test('múltiplas equipes agregam tarefas sem misturar as equipes excluídas', () => {
  const result = calculatePpcDetail(tasks, ['2026-09-28'], ['Equipe A', 'Equipe B']);
  assert.equal(result.rows[0].ppc, 50); assert.equal(result.rows[0].plannedCount, 2);
  assert.deepEqual(result.causes, [{ reason: 'Material', count: 1, percent: 100 }]);
  assert.equal(calculatePpcDetail(tasks, ['2026-09-28'], []).rows[0].plannedCount, 3);
});
test('selecionar uma semana restringe gráfico e causas, mantendo o histórico semanal completo', () => {
  const result = calculatePpcDetail(tasks, ['2026-09-21', '2026-09-28'], ['Equipe A', 'Equipe B'], '2026-09-21');
  assert.equal(result.rows.length, 2); assert.equal(result.chartRows.length, 1); assert.equal(result.chartRows[0].ppc, 100);
  assert.deepEqual(result.causes, []);
  const reset = calculatePpcDetail(tasks, ['2026-09-21', '2026-09-28'], ['Equipe A', 'Equipe B']);
  assert.equal(reset.chartRows.length, 2); assert.equal(reset.causes[0].reason, 'Material');
});
