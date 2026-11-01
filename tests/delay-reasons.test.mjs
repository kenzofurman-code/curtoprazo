import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React } }).outputText;
const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const rules = await import(`data:text/javascript;base64,${Buffer.from(compile(await readFile(new URL('../src/delayReasons.ts', import.meta.url), 'utf8'))).toString('base64')}`);
const { GENERAL_DELAY_REASONS, DELAY_REASON_ALIASES, normalizeDelayReason, normalizeDelayReasonFields, mergeDelayReasons, projectOnlyDelayReasons } = rules;

test('de/para usa os 12 nomes escolhidos e não inventa correspondências', () => {
  assert.equal(GENERAL_DELAY_REASONS.length, 12);
  for (const [before, after] of Object.entries(DELAY_REASON_ALIASES)) {
    assert.equal(normalizeDelayReason(before), after);
    assert.ok(GENERAL_DELAY_REASONS.includes(after));
  }
  assert.equal(normalizeDelayReason('  falta   de equipamento '), 'Problemas com equipamentos');
  assert.equal(normalizeDelayReason('Motivo específico da obra'), 'Motivo específico da obra');
});
test('normaliza motivos históricos sem alterar medições, texto livre ou identidade; repetir é seguro', () => {
  const before = [{ id: 'task-1', weekId: '2026-10-05', progressThisWeek: 37.5, finalized: true,
    delayReason: 'Baixa produção', preFilledDelayReason: 'Falta de equipamento',
    observations: 'Baixa produção', nested: { generalDelayReason: 'Problemas com material', cost: 130.4 } }];
  const after = normalizeDelayReasonFields(before);
  assert.deepEqual(after, [{ ...before[0], delayReason: 'Baixa produtividade', preFilledDelayReason: 'Problemas com equipamentos',
    nested: { ...before[0].nested, generalDelayReason: 'Falta de Material em Obra' } }]);
  assert.deepEqual(normalizeDelayReasonFields(after), after);
  assert.equal(before[0].delayReason, 'Baixa produção');
  const date = new Date('2026-10-08T10:00:00Z');
  assert.equal(normalizeDelayReasonFields({ date }).date, date);
});
test('obras antigas e vazias herdam a mesma base; registros locais não vazam entre obras', () => {
  const legacy = ['Escassez de mão de obra', 'Falta de Mão de Obra / Absenteísmo', 'Motivo local'];
  assert.deepEqual(projectOnlyDelayReasons(legacy, GENERAL_DELAY_REASONS), ['Motivo local']);
  assert.deepEqual(mergeDelayReasons(GENERAL_DELAY_REASONS, []), GENERAL_DELAY_REASONS);
  assert.equal(mergeDelayReasons(GENERAL_DELAY_REASONS, legacy).length, 13);
  assert.ok(!mergeDelayReasons(GENERAL_DELAY_REASONS, []).includes('Motivo local'));
});

function setup(overrides = {}) {
  const store = new Map([
    [rules.DELAY_REASON_REGISTRY_ID, { reasons: GENERAL_DELAY_REASONS }],
    ['obra-a', { projectDelayReasons: ['Motivo local A'], delayReasons: [...GENERAL_DELAY_REASONS, 'Motivo local A'], payloadRevision: 'original', untouched: 'preservar' }],
    ['obra-b', { projectDelayReasons: [], delayReasons: GENERAL_DELAY_REASONS }]
  ]);
  const notices = [], busy = [], cleared = [], writes = [];
  const context = { ...rules, db: {}, userId: 'test', appId: 'test', urlUserId: '', selectedProjectId: 'obra-a', plannerUsername: 'Admin',
    isProjectHydrated: true, delayRegistryReady: true, isSavingDelayReason: false, newDelayReason: 'Novo motivo',
    doc: (_, collection, id) => ({ id }), setNotification: notice => notices.push(notice), setIsSavingDelayReason: value => busy.push(value),
    setNewDelayReason: value => cleared.push(value), console: { error() {} },
    runTransaction: async (_, operation) => operation({
      get: async ref => ({ exists: () => store.has(ref.id), data: () => store.get(ref.id) }),
      set: (ref, fields, options) => { assert.equal(options.merge, true); writes.push(ref.id); store.set(ref.id, { ...store.get(ref.id), ...fields }); }
    }), ...overrides };
  const handlers = source.slice(source.indexOf('  const handleAddDelayReason ='), source.indexOf('  const handleCreateMatrix ='));
  const fn = new Function('context', `const {${Object.keys(context).join(',')}}=context;${compile(handlers)};return {handleAddDelayReason,handleDeleteDelayReason};`)(context);
  return { ...fn, store, notices, busy, cleared, writes };
}
test('registro geral chega a duas obras sem alterar seus motivos locais', async () => {
  const run = setup(); await run.handleAddDelayReason('general');
  const general = run.store.get(rules.DELAY_REASON_REGISTRY_ID).reasons;
  for (const id of ['obra-a', 'obra-b']) assert.ok(mergeDelayReasons(general, run.store.get(id).projectDelayReasons).includes('Novo motivo'));
  assert.deepEqual(run.writes, [rules.DELAY_REASON_REGISTRY_ID]);
  assert.deepEqual(run.store.get('obra-a').projectDelayReasons, ['Motivo local A']);
  assert.deepEqual(run.busy, [true, false]); assert.equal(run.notices[0].type, 'success');
});
test('registro obra e remoção afetam apenas o catálogo local, preservando outros campos', async () => {
  const run = setup(); await run.handleAddDelayReason('project');
  assert.deepEqual(run.store.get('obra-a').projectDelayReasons, ['Motivo local A', 'Novo motivo']);
  assert.ok(!run.store.get('obra-b').delayReasons.includes('Novo motivo'));
  assert.equal(run.store.get('obra-a').untouched, 'preservar');
  assert.equal(run.store.get('obra-a').payloadRevision, 'original');
  await run.handleDeleteDelayReason('Novo motivo');
  assert.deepEqual(run.store.get('obra-a').projectDelayReasons, ['Motivo local A']);
  assert.equal(run.store.get(rules.DELAY_REASON_REGISTRY_ID).reasons.length, 12);
});
test('duplicatas e falhas de gravação não indicam sucesso nem apagam o texto', async () => {
  const duplicate = setup({ newDelayReason: 'Dia improdutivo (chuva)' }); await duplicate.handleAddDelayReason('general');
  assert.equal(duplicate.writes.length, 0); assert.equal(duplicate.notices[0].type, 'warning'); assert.deepEqual(duplicate.cleared, []);
  const failed = setup({ runTransaction: async () => { throw new Error('offline'); } }); await failed.handleAddDelayReason('project');
  assert.equal(failed.notices[0].type, 'error'); assert.deepEqual(failed.busy, [true, false]); assert.deepEqual(failed.cleared, []);
  const loading = setup({ delayRegistryReady: false }); await loading.handleAddDelayReason('general');
  assert.equal(loading.writes.length, 0); assert.equal(loading.notices[0].type, 'warning');
});
test('configuração mostra os dois registros e identifica a lista geral e a lista da obra', () => {
  const start = source.indexOf('        {/* Card 4:');
  const end = source.lastIndexOf('</div>', source.indexOf('{/* Card 5:', start));
  const block = source.slice(start, end).replace(/\{\/\*[^]*?\*\/\}/, '').trim();
  const context = { React, newDelayReason: '', setNewDelayReason() {}, isSavingDelayReason: false, delayRegistryReady: true,
    isProjectHydrated: true, handleAddDelayReason() {}, handleDeleteDelayReason() {}, triggerConfirm() {},
    generalDelayReasons: GENERAL_DELAY_REASONS, localDelayReasons: ['Motivo local A'] };
  const render = new Function('context', `const {${Object.keys(context).join(',')}}=context;${compile(`const render=()=>(${block});`)};return render;`)(context);
  const html = renderToStaticMarkup(render());
  assert.match(html, /Registro geral/); assert.match(html, /Registro obra/);
  for (const reason of GENERAL_DELAY_REASONS) assert.ok(html.includes(reason));
  assert.match(html, /Motivo local A/);
});
