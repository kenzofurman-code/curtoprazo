import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

function moduleFrom(source) {
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', compile(source))(require, mod.exports, mod);
  return mod.exports;
}

const lobModule = moduleFrom(
  await readFile(new URL('../src/longTermSchedule.ts', import.meta.url), 'utf8')
);

function moduleFromWithLob(source) {
  const mod = { exports: {} };
  const customRequire = (id) => {
    if (id === './longTermSchedule') {
      return lobModule;
    }
    return require(id);
  };
  new Function('require', 'exports', 'module', compile(source))(customRequire, mod.exports, mod);
  return mod.exports;
}

const macroflowModule = moduleFromWithLob(
  await readFile(new URL('../src/macroflowModel.ts', import.meta.url), 'utf8')
);

const { createDefaultCalendar } = lobModule;
const {
  getDefaultMacroflowModel,
  parseRhythmDays,
  applyMacroflowToSchedule,
} = macroflowModule;

test('macrofluxo novo inicia vazio, sem pacotes, tarefas ou vínculos de exemplo', () => {
  const model = getDefaultMacroflowModel();
  assert.deepEqual(model.swimlanes, []);
  assert.deepEqual(model.interLinks, []);
});

test('ritmos continuam sendo extraídos de textos importados', () => {
  assert.equal(parseRhythmDays('10d - por pvto'), 10);
  assert.equal(parseRhythmDays('15d - cada 200 m2'), 15);
  assert.equal(parseRhythmDays(''), 5);
});

const empty = () => ({calendar:createDefaultCalendar('2026-04-01'),replicationGroups:[],floors:[],services:[],activities:[]});
const fixture = () => ({
  ...getDefaultMacroflowModel(),
  swimlanes:[{id:'s',name:'Etapa cadastrada',category:'custom',color:'#111111',targetGroupName:'Local cadastrado',packages:[
    {id:'p1',name:'Primeiro pacote',color:'#111111',rhythmDays:2,position:1,colIndex:1,jobs:[{id:'j1',name:'Primeira tarefa',defaultDurationDays:2,costWeight:50}]},
    {id:'p2',name:'Segundo pacote',color:'#111111',rhythmDays:3,position:2,colIndex:2,jobs:[]}
  ]}]
});

test('macrofluxo vazio mantém cronograma vazio; macrofluxo importado não inventa pavimentos', () => {
  const result = applyMacroflowToSchedule(getDefaultMacroflowModel(), empty());
  assert.deepEqual(result.activities, []);
  assert.deepEqual(result.floors, []);
  assert.deepEqual(result.services, []);
  const imported = applyMacroflowToSchedule(fixture(), empty());
  assert.deepEqual(imported.floors, []);
  assert.deepEqual(imported.activities, []);
  assert.equal(imported.services[0].defaultTotalCost, 50);
  assert.equal(imported.services[1].defaultTotalCost, 0);
});

test('gera atividades e precedências somente nos locais e pacotes fornecidos', () => {
  const state = empty();
  state.replicationGroups = [{id:'group',name:'Local cadastrado',position:1,linesPerFloor:2,color:'#111111'}];
  state.floors = [1,2].map(n=>({id:'floor'+n,name:'Local '+n,position:n,replicationGroupId:'group'}));
  const result = applyMacroflowToSchedule(fixture(), state);
  assert.equal(result.floors.length,2);
  assert.equal(result.services.length,2);
  assert.equal(result.activities.length,4);
  assert.ok(result.activities.some(a=>a.predecessorIds.length));
  assert.ok(result.activities.every(a=>state.floors.some(f=>f.id===a.floorId)));
});
