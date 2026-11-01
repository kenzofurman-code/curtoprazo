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

test('Modelo Padrão de Macrofluxo: Carrega as 7 raias completas da obra com pacotes e tarefas do Excel', () => {
  const model = getDefaultMacroflowModel();

  assert.ok(model.swimlanes.length >= 7, 'Deve ter pelo menos 7 macrofluxos principais');

  const names = model.swimlanes.map((s) => s.name);
  assert.ok(names.includes('MARCOS DA OBRA'), 'Deve conter MARCOS DA OBRA');
  assert.ok(names.includes('TORRE - PAVIMENTO TIPO'), 'Deve conter TORRE - PAVIMENTO TIPO');
  assert.ok(names.includes('FACHADA'), 'Deve conter FACHADA');
  assert.ok(names.includes('SUBSOLOS'), 'Deve conter SUBSOLOS');
  assert.ok(names.includes('ÁTICO / COBERTURA'), 'Deve conter ÁTICO / COBERTURA');
  assert.ok(names.includes('ÁREAS EXTERNAS / COMUNS'), 'Deve conter ÁREAS EXTERNAS');
  assert.ok(names.includes('GERAL E CUSTOS'), 'Deve conter GERAL E CUSTOS');

  // Verifica contagem de pacotes na Torre
  const torre = model.swimlanes.find((s) => s.category === 'tower');
  assert.ok(torre, 'Raia da torre deve existir');
  assert.ok(torre.packages.length >= 20, 'Torre deve ter mais de 20 pacotes mapeados');

  // Verifica sub-tarefas da Estrutura
  const estrutura = torre.packages.find((p) => p.name === 'ESTRUTURA');
  assert.ok(estrutura, 'Pacote ESTRUTURA deve existir na Torre');
  assert.ok(estrutura.jobs.length >= 6, 'ESTRUTURA deve conter suas sub-tarefas (fôrmas, armaduras, bandejão, etc.)');

  const jobNames = estrutura.jobs.map((j) => j.name);
  assert.ok(jobNames.some((n) => n.includes('formas')), 'Deve conter tarefa de fôrmas');
  assert.ok(jobNames.some((n) => n.includes('armaduras')), 'Deve conter tarefa de armaduras');
});

test('parseRhythmDays: Extrai número de dias a partir de diferentes formatos descritivos de ritmo', () => {
  assert.equal(parseRhythmDays('10d - por pvto'), 10);
  assert.equal(parseRhythmDays('1d - por pvto'), 1);
  assert.equal(parseRhythmDays('15d - cada 200 m2'), 15);
  assert.equal(parseRhythmDays('30d'), 30);
  assert.equal(parseRhythmDays('5'), 5);
  assert.equal(parseRhythmDays(''), 5, 'Fallback padrão para 5 dias quando vazio');
});

test('Vínculos Inter-Raias: Valida mapeamento de precedência entre raias distintas (Torre -> Fachada, Subsolo -> Torre)', () => {
  const model = getDefaultMacroflowModel();

  assert.ok(model.interLinks.length >= 4, 'Deve conter vínculos inter-raias de exemplo');

  // Verifica vínculo Subsolo -> Torre
  const subToTorre = model.interLinks.find(
    (l) => l.sourceSwimlaneId === 'sw_basement' && l.targetSwimlaneId === 'sw_tower'
  );
  assert.ok(subToTorre, 'Deve existir vínculo conectando Subsolo à Torre');

  // Verifica vínculo Torre -> Fachada com defasagem de pavimentos
  const torreToFachada = model.interLinks.find(
    (l) => l.sourceSwimlaneId === 'sw_tower' && l.targetSwimlaneId === 'sw_facade'
  );
  assert.ok(torreToFachada, 'Deve existir vínculo conectando Torre à Fachada');
  assert.equal(torreToFachada.type, 'floor_lag', 'Vínculo Torre -> Fachada deve ser de defasagem de pavimentos');
  assert.equal(torreToFachada.lagValue, 5, 'Defasagem padrão de 5 pavimentos');
});

test('applyMacroflowToSchedule: Gera atividades com escadinha vertical, predecessoras horizontais e inter-raias', () => {
  const model = getDefaultMacroflowModel();
  const calendar = createDefaultCalendar('2026-04-01');

  const initialEmptyState = {
    calendar,
    replicationGroups: [],
    floors: [],
    services: [],
    activities: [],
  };

  const generated = applyMacroflowToSchedule(model, initialEmptyState, { defaultStartDate: '2026-04-01' });

  assert.ok(generated.replicationGroups.length >= 5, 'Deve criar os agrupamentos de replicação');
  assert.ok(generated.floors.length >= 10, 'Deve gerar os pavimentos correspondentes');
  assert.ok(generated.services.length >= 20, 'Deve criar os pacotes de serviço com seus modelos de tarefas');
  assert.ok(generated.activities.length > 50, 'Deve gerar a malha de atividades da Linha de Balanço');

  // Verifica se as atividades têm predecessoras verticais nos pavimentos superiores
  const torreActs = generated.activities.filter((a) => a.serviceId.includes('estrutura'));
  assert.ok(torreActs.length > 1, 'Deve ter atividades de estrutura');

  const secondFloorAct = torreActs[1];
  assert.ok(secondFloorAct.predecessorIds.length > 0, 'Atividade do pavimento superior deve ter predecessora vertical');
});

test('Matriz de Colunas/Etapas: Valida posicionamento temporal alinhado entre raias (Subsolo C5-C8 -> Torre C9 -> Fachada C21)', () => {
  const model = getDefaultMacroflowModel();

  const subsolo = model.swimlanes.find((s) => s.category === 'basement');
  const torre = model.swimlanes.find((s) => s.category === 'tower');
  const fachada = model.swimlanes.find((s) => s.category === 'facade');
  const marcos = model.swimlanes.find((s) => s.category === 'milestones');

  const supra = subsolo.packages.find((p) => p.name === 'SUPRAESTRUTURA');
  const estruturaTorre = torre.packages.find((p) => p.name === 'ESTRUTURA');
  const balancimFachada = fachada.packages.find((p) => p.name === 'BALANCIM');
  const inicioObra = marcos.packages.find((p) => p.name === 'INÍCIO DA OBRA');

  assert.equal(supra.colIndex, 8, 'Supraestrutura de subsolo deve estar na etapa/coluna 8');
  assert.equal(estruturaTorre.colIndex, 9, 'Estrutura da torre deve iniciar após subsolo na etapa 9');
  assert.equal(balancimFachada.colIndex, 21, 'Fachada deve iniciar apenas na etapa 21');
  assert.equal(inicioObra.colIndex, 4, 'Início da obra no marco 4');
});
