import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/scheduleImport.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
const { analyzeSchedule, detectScheduleHeader, parseScheduleDate, parseScheduleNumber } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const header = ['ID', 'Pacote de trabalho', 'Serviço', 'Lote', 'Data de Início', 'Data de Término', 'Duração', 'Custo Vinculado Atual', 'Realizado'];
const activity = ['1', 'Estrutura', 'Concretagem', 'Térreo', '2026-10-01', '2026-10-31', 22, 1000, 0.5];
const sheet = rows => ({ name: 'Cronograma', rows });

test('datas numéricas, ISO e brasileiras preservam o dia civil, incluindo calendário 1904', () => {
  assert.equal(parseScheduleDate(45413), '2024-05-01');
  assert.equal(parseScheduleDate('2024-05-01'), '2024-05-01');
  assert.equal(parseScheduleDate('01/05/2024'), '2024-05-01');
  assert.equal(parseScheduleDate(0, true), '1904-01-01');
  assert.equal(parseScheduleDate(43951, true), '2024-05-01');
  for (const value of ['31/02/2024', '-', 'texto', undefined, 60]) assert.equal(parseScheduleDate(value), null);
});

test('encontra cabeçalho na linha 32 e não confunde títulos com nomes de colunas', () => {
  const rows = [['Relatório de serviço por unidade'], ...Array.from({ length: 30 }, () => []), header, activity];
  const result = analyzeSchedule(sheet(rows));
  assert.equal(result.headerIndex, 31);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].rowNumber, 33);
});

test('colunas reordenadas e extras não deslocam os campos nem escolhem linha de base', () => {
  const result = analyzeSchedule(sheet([
    ['Data de início da linha de base', 'Custo Projetado', 'Data de Término', 'Lote', 'Pacote de trabalho', 'Data de Início', 'Duração na Linha de Base Ativa', 'Duração', 'Custo Vinculado Atual', 'Serviço'],
    [45000, 99999, '31/10/2026', 'Térreo', 'Estrutura', '01/10/2026', 99, 22, 'R$ 1.234,56', 'Concretagem']
  ]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].values.start, '2026-10-01');
  assert.equal(result.records[0].values.cost, 1234.56);
  assert.equal(result.records[0].values.duration, 22);
  assert.ok(result.ignoredColumns.some(c => c.index === 0));
});

test('resolve Realizado pelo grupo em três níveis, respeitando merges horizontais e verticais', () => {
  const s = sheet([
    ['', '', '', '', '', '', '', 'Última Medição do Projeto (%)', 'Avanço físico (%)', '', 'Avanço físico (Unidade de medida atribuída)'],
    ['ID', 'Pacote de trabalho', 'Serviço', 'Lote', 'Data de Início', 'Data de Término', 'Duração', '', 'Acumulado'],
    ['', '', '', '', '', '', '', 'Realizado', 'Previsto', 'Realizado', 'Realizado'],
    [...activity.slice(0, 7), 10, 20, 35, 900]
  ]);
  s.merges = [
    ...Array.from({ length: 7 }, (_, c) => ({ s: { r: 1, c }, e: { r: 2, c } })),
    { s: { r: 0, c: 8 }, e: { r: 0, c: 9 } },
    { s: { r: 1, c: 8 }, e: { r: 1, c: 9 } }
  ];
  const result = analyzeSchedule(s);
  assert.equal(result.headerIndex, 2);
  assert.equal(result.mapping.progress, 9);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].values.progress, 35);
});

test('não usa posição fixa para campo ausente e permite associação manual', () => {
  const s = sheet([header.map(h => h === 'Data de Início' ? 'Data interna' : h), activity]);
  assert.match(analyzeSchedule(s).errors.join(' '), /Selecione a coluna de Início/);
  const result = analyzeSchedule(s, { mapping: { start: 4 } });
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].values.start, '2026-10-01');
});

test('colunas ambíguas exigem escolha explícita e impedem reutilização de coluna', () => {
  const s = sheet([[...header, 'Realizado'], [...activity, 25]]);
  assert.match(analyzeSchedule(s).errors.join(' '), /mais de uma coluna/);
  assert.deepEqual(analyzeSchedule(s, { mapping: { progress: 9 } }).errors, []);
  assert.deepEqual(analyzeSchedule(s, { mapping: { progress: -1 } }).errors, []);
  assert.match(analyzeSchedule(s, { mapping: { progress: 7 } }).errors.join(' '), /mais de um campo/);
});

test('percentual cru abaixo de 1 não vira 100 vezes maior; formato Excel e escala explícita são respeitados', () => {
  const s = sheet([header, activity]);
  assert.equal(analyzeSchedule(s).records[0].values.progress, 0.5);
  assert.equal(analyzeSchedule({ ...s, formats: { I2: '0.0%' } }).records[0].values.progress, 50);
  assert.equal(analyzeSchedule(s, { progressScale: 'fraction' }).records[0].values.progress, 50);
  const stringPercent = [...activity]; stringPercent[8] = '0,5%';
  assert.equal(analyzeSchedule(sheet([header, stringPercent])).records[0].values.progress, 0.5);
  assert.equal(analyzeSchedule(sheet([header, stringPercent]), { progressScale: 'fraction' }).records[0].values.progress, 0.5);
});

test('duplicatas idênticas são avisadas; conflito exige escolha e preserva os valores da linha escolhida', () => {
  const identical = analyzeSchedule(sheet([header, activity, [...activity]]));
  assert.equal(identical.records.length, 1);
  assert.equal(identical.identicalDuplicates, 1);
  assert.ok(identical.warnings.some(w => w.includes('mesmos valores')));
  const changed = [...activity]; changed[6] = 5; changed[7] = 14098.75;
  const s = sheet([header, activity, changed]);
  const pending = analyzeSchedule(s);
  assert.equal(pending.conflicts.length, 1);
  assert.equal(pending.records.length, 0);
  assert.ok(pending.errors.length);
  const resolved = analyzeSchedule(s, { duplicateRows: { 'id:1': 3 } });
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.records[0].values.duration, 5);
  assert.equal(resolved.records[0].values.cost, 14098.75);
});

test('dados inválidos apontam linha, sem inventar datas ou truncar duração', () => {
  const invalid = [...activity]; invalid[4] = '31/02/2026'; invalid[6] = 'dez'; invalid[8] = 101;
  const result = analyzeSchedule(sheet([header, invalid]));
  assert.match(result.errors.join(' '), /Linha 2: Início inválido.*Duração inválido.*Avanço realizado/);
  assert.equal(result.records.length, 0);
  assert.equal(parseScheduleNumber('R$ 1.234,56'), 1234.56);
  assert.equal(parseScheduleNumber('1,234.56'), 1234.56);
});

test('ignora linhas vazias, calcula duração ausente e avisa dependências externas', () => {
  const result = analyzeSchedule(sheet([
    ['ID', 'Pacote de trabalho', 'Lote', 'Data de Início', 'Data de Término', 'Predecessoras'],
    ['1', 'Estrutura', 'Térreo', '01/10/2026', '03/10/2026', '999'], [], []
  ]));
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].values.duration, 3);
  assert.equal(result.records[0].values.responsible, 'EQUIPE GERAL');
  assert.ok(result.warnings.some(w => w.includes('999')));
  assert.ok(result.warnings.some(w => w.includes('2 linha(s) vazia')));
});

test('aba de capa tem prioridade inferior à aba de cronograma', () => {
  assert.ok(detectScheduleHeader(sheet([header, activity])).score > detectScheduleHeader(sheet([['Capa'], ['Projeto QOYA']])).score);
});
