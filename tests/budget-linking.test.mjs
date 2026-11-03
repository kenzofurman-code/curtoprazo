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
  const customRequire = (id) => {
    if (id.startsWith('./data/')) {
      return require('../src/' + id.slice(2));
    }
    return require(id);
  };
  new Function('require', 'exports', 'module', compile(source))(customRequire, mod.exports, mod);
  return mod.exports;
}

const budgetModule = moduleFrom(
  await readFile(new URL('../src/budgetLinking.ts', import.meta.url), 'utf8')
);

test('obra sem dados não carrega orçamento específico e orçamento salvo vazio é preservado', () => {
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null };
  const empty = budgetModule.getEffectiveBudgetState('projeto_principal');
  assert.deepEqual(empty.items, []);
  assert.equal(empty.totalCost, 0);
  const saved = { projectId: 'obra', budgetName: 'Limpo pelo usuário', items: [], totalCost: 0 };
  values.set('curtoprazo_budget_obra', JSON.stringify(saved));
  assert.deepEqual(budgetModule.getEffectiveBudgetState('obra'), saved);
});

const {
  distributeWeightsEqually,
  distributeWeightsByTime,
  distributeWeightsByQuantity,
  distributeWeightsByArea,
  validateWeightsSum,
  generateInitialBudgetFromSchedule,
  applyBudgetWeightsToSchedule,
  parseBudgetRows,
} = budgetModule;

test('Modo 1: Distribuição igualitária divide 100% exatamente sem erro de dízima periódica', () => {
  // Divisão por 3 (dízima 33.3333...): o último absorve o resíduo para somar exatamente 100.00%
  const weights3 = distributeWeightsEqually(3);
  assert.equal(weights3.length, 3);
  assert.equal(weights3[0], 33.3333);
  assert.equal(weights3[1], 33.3333);
  assert.equal(weights3[2], 33.3334);
  const sum3 = weights3.reduce((a, b) => a + b, 0);
  assert.equal(parseFloat(sum3.toFixed(4)), 100);

  // Divisão por 6
  const weights6 = distributeWeightsEqually(6);
  assert.equal(weights6.length, 6);
  const sum6 = weights6.reduce((a, b) => a + b, 0);
  assert.equal(parseFloat(sum6.toFixed(4)), 100);
});

test('Modo 2: Ponderação por tempo atribui peso proporcional à duração das tarefas', () => {
  // 3 tarefas: 10 dias, 20 dias, 10 dias (Total 40 dias -> 25%, 50%, 25%)
  const durations = [10, 20, 10];
  const weights = distributeWeightsByTime(durations);

  assert.equal(weights.length, 3);
  assert.equal(weights[0], 25);
  assert.equal(weights[1], 50);
  assert.equal(weights[2], 25);
  const sum = weights.reduce((a, b) => a + b, 0);
  assert.equal(parseFloat(sum.toFixed(4)), 100);
});

test('Modo 3: Ponderação por quantidade atribui peso proporcional à produção física', () => {
  // 4 pavimentos: 100m², 200m², 100m², 100m² (Total 500m² -> 20%, 40%, 20%, 20%)
  const quantities = [100, 200, 100, 100];
  const weights = distributeWeightsByQuantity(quantities);

  assert.equal(weights.length, 4);
  assert.equal(weights[0], 20);
  assert.equal(weights[1], 40);
  assert.equal(weights[2], 20);
  assert.equal(weights[3], 20);
  const sum = weights.reduce((a, b) => a + b, 0);
  assert.equal(parseFloat(sum.toFixed(4)), 100);
});

test('Modo 4: Ponderação por área atribui peso proporcional à área do pavimento/lote', () => {
  // Pavimentos: Térreo (500m²), 1º Pav (250m²), 2º Pav (250m²) (Total 1000m² -> 50%, 25%, 25%)
  const areas = [500, 250, 250];
  const weights = distributeWeightsByArea(areas);

  assert.equal(weights.length, 3);
  assert.equal(weights[0], 50);
  assert.equal(weights[1], 25);
  assert.equal(weights[2], 25);
  const sum = weights.reduce((a, b) => a + b, 0);
  assert.equal(parseFloat(sum.toFixed(4)), 100);
});

test('Validação de soma de pesos detecta discrepâncias e aceita 100%', () => {
  const valid = validateWeightsSum([33.3333, 33.3333, 33.3334]);
  assert.equal(valid.isValid, true);
  assert.equal(valid.delta, 0);

  const invalid = validateWeightsSum([20, 20, 20]);
  assert.equal(invalid.isValid, false);
  assert.equal(invalid.delta, 40);
});

test('Gera orçamento inicial automático a partir dos pacotes e atividades existentes', () => {
  const activities = [
    { id: 'act_1', serviceId: 'pkg_est', floorId: 'flr_1', cost: 10000, duration: 5 },
    { id: 'act_2', serviceId: 'pkg_est', floorId: 'flr_2', cost: 10000, duration: 5 },
    { id: 'act_3', serviceId: 'pkg_alv', floorId: 'flr_1', cost: 5000, duration: 3 },
  ];
  const services = [
    { id: 'pkg_est', name: 'ESTRUTURA', defaultTotalCost: 20000 },
    { id: 'pkg_alv', name: 'ALVENARIA', defaultTotalCost: 5000 },
  ];

  const budget = generateInitialBudgetFromSchedule('proj_1', activities, services);
  assert.equal(budget.projectId, 'proj_1');
  assert.equal(budget.totalCost, 25000);
  assert.equal(budget.items.length, 3); // 1 raiz + 2 pacotes
  assert.equal(budget.items[0].eapCode, '01');
  assert.equal(budget.items[1].eapCode, '01.01');
  assert.equal(budget.items[1].linkedScheduleIds.length, 2);
});

test('Aplica ponderação do orçamento de volta para os custos das atividades e weights', () => {
  const budgetState = {
    projectId: 'proj_test',
    budgetName: 'Orçamento Teste',
    totalCost: 100000,
    items: [
      {
        id: 'bgt_item_1',
        eapCode: '01.01',
        name: 'ESTRUTURA DE CONCRETO',
        totalCost: 100000,
        level: 2,
        isLeaf: true,
        linkedScheduleIds: ['act_est_1', 'act_est_2'],
        weights: {
          act_est_1: 60, // 60% = R$ 60.000
          act_est_2: 40, // 40% = R$ 40.000
        },
      },
    ],
    lastUpdated: '2026-10-17',
  };

  const activities = [
    {
      id: 'act_est_1',
      serviceId: 'pkg_est',
      floorId: 'flr_1',
      cost: 0,
      jobs: [
        { id: 'j1', name: 'Fôrma', cost: 0 },
        { id: 'j2', name: 'Concreto', cost: 0 },
      ],
    },
    {
      id: 'act_est_2',
      serviceId: 'pkg_est',
      floorId: 'flr_2',
      cost: 0,
      jobs: [{ id: 'j3', name: 'Fôrma e Concreto', cost: 0 }],
    },
  ];

  const floors = [
    { id: 'flr_1', name: '1º Pavimento', area: 400 },
    { id: 'flr_2', name: '2º Pavimento', area: 400 },
  ];

  const services = [{ id: 'pkg_est', name: 'ESTRUTURA' }];

  const { updatedActivities, updatedWeights } = applyBudgetWeightsToSchedule(
    budgetState,
    activities,
    floors,
    services
  );

  assert.equal(updatedActivities[0].cost, 60000);
  assert.equal(updatedActivities[1].cost, 40000);
  assert.equal(updatedActivities[0].jobs[0].cost, 30000);
  assert.equal(updatedActivities[0].jobs[1].cost, 30000);
  assert.equal(updatedActivities[1].jobs[0].cost, 40000);

  // Verifica se atualizou a matriz de weights
  assert.ok(updatedWeights['1º Pavimento']?.estrutura > 0);
  assert.ok(updatedWeights['2º Pavimento']?.estrutura > 0);
});

test('Parser de linhas de orçamento reconhece EAP, Descrição, Unidade e Custo Total', () => {
  const rows = [
    ['Item / EAP', 'Descrição do Serviço', 'Unid', 'Qtd', 'Preço Unitário', 'Total (R$)'],
    ['01', 'SERVIÇOS INICIAIS', 'vb', '1', '50000', '50.000,00'],
    ['01.01', 'CANTEIRO DE OBRAS', 'm²', '150', '200', '30.000,00'],
    ['01.02', 'LIGAÇÕES PROVISÓRIAS', 'un', '2', '10000', '20.000,00'],
  ];

  const items = parseBudgetRows(rows, 'p1');
  assert.equal(items.length, 3);
  assert.equal(items[0].eapCode, '01');
  assert.equal(items[0].isLeaf, false); // Tem filhos 01.01 e 01.02
  assert.equal(items[1].eapCode, '01.01');
  assert.equal(items[1].isLeaf, true);
  assert.equal(items[1].totalCost, 30000);
  assert.equal(items[1].parentId, items[0].id);
  assert.equal(items[2].totalCost, 20000);
});

test('Parser de orçamento reconhece colunas de Material (R$) e Mão de Obra (R$)', () => {
  const rows = [
    ['Nível', 'Código', 'Descrição', 'Material (R$)', 'Mão de Obra (R$)', 'Total (R$)'],
    ['1', '01', 'OBRA PRINCIPAL', '60.000,00', '40.000,00', '100.000,00'],
    ['2', '01.01', 'ESTRUTURA', '30.000,00', '20.000,00', '50.000,00'],
  ];

  const items = budgetModule.parseBudgetRows(rows, 'proj_mat_mo');
  assert.equal(items.length, 2);
  assert.equal(items[0].materialCost, 60000);
  assert.equal(items[0].laborCost, 40000);
  assert.equal(items[0].totalCost, 100000);
  assert.equal(items[1].materialCost, 30000);
  assert.equal(items[1].laborCost, 20000);
  assert.equal(items[1].totalCost, 50000);
});

test('Normalização de nomes de lote converte fachadas descritivas para o padrão da Linha de Balanço', () => {
  assert.equal(budgetModule.normalizeLotName('Fachada D -- Sete - (07º-03º)'), 'Fachada D - (07º-03º)');
  assert.equal(budgetModule.normalizeLotName('Fachada C -- Buenos Aires - (07º-03º)'), 'Fachada C - (07º-03º)');
  assert.equal(budgetModule.normalizeLotName('Fachada B -- Hotel - (27º-18º)'), 'Fachada B - (27º-18º)');
  assert.equal(budgetModule.normalizeLotName('Fachada A -- Vizinha - (18º-11º)'), 'Fachada A - (18º-11º)');
  assert.equal(budgetModule.normalizeLotName('2º Pav'), '2º Pav');
  assert.equal(budgetModule.normalizeLotName('Térreo'), 'Térreo');
});

test('parseBudgetLinkingRows e applyImportedLinksToBudget vinculam itens de orçamento ao cronograma', () => {
  const rawRows = [
    ['Nível', 'Código', 'Descrição', 'Custo', 'Pacote de trabalho/tarefas', 'Serviço', 'Lote', 'Parte', 'Peso (% Item)'],
    ['5', '01.01.01.01', 'FÔRMA E ARMAÇÃO', '10000', 'EST - ESTRUTURA', 'Formas', '2º Pav', '-', '50'],
    ['5', '01.01.01.01', 'FÔRMA E ARMAÇÃO', '10000', 'EST - ESTRUTURA', 'Formas', '3º Pav', '-', '50'],
  ];

  const parsedLinks = budgetModule.parseBudgetLinkingRows(rawRows);
  assert.equal(parsedLinks.length, 2);
  assert.equal(parsedLinks[0].eapCode, '01.01.01.01');
  assert.equal(parsedLinks[0].packageName, 'EST - ESTRUTURA');
  assert.equal(parsedLinks[0].lotName, '2º Pav');
  assert.equal(parsedLinks[0].weightPercent, 50);

  const initialBudget = {
    projectId: 'p_test',
    budgetName: 'Teste',
    totalCost: 20000,
    items: [
      {
        id: 'bgt_01_01_01_01',
        eapCode: '01.01.01.01',
        name: 'FÔRMA E ARMAÇÃO',
        totalCost: 20000,
        level: 4,
        isLeaf: true,
        linkedScheduleIds: [],
        weights: {},
      },
    ],
    lastUpdated: '2026-10-17',
  };

  const activities = [
    { id: 'act_est_2', serviceId: 'svc_est', floorId: 'flr_2', cost: 0, jobs: [] },
    { id: 'act_est_3', serviceId: 'svc_est', floorId: 'flr_3', cost: 0, jobs: [] },
  ];
  const floors = [
    { id: 'flr_2', name: '2º Pav', position: 1, replicationGroupId: 'g1' },
    { id: 'flr_3', name: '3º Pav', position: 2, replicationGroupId: 'g1' },
  ];
  const services = [
    { id: 'svc_est', name: 'EST - ESTRUTURA', position: 1, color: '#1A665B', defaultDuration: 5, defaultResponsible: 'CIVIL', defaultTotalCost: 0, defaultLine: 1, autoChainJobs: false, jobs: [] },
  ];

  const result = budgetModule.applyImportedLinksToBudget(
    initialBudget,
    parsedLinks,
    activities,
    floors,
    services
  );

  assert.equal(result.matchedCount, 2);
  assert.equal(result.unmatchedCount, 0);

  const linkedItem = result.updatedBudget.items[0];
  assert.equal(linkedItem.linkedScheduleIds.length, 2);
  assert.ok(linkedItem.linkedScheduleIds.includes('act_est_2'));
  assert.ok(linkedItem.linkedScheduleIds.includes('act_est_3'));
  assert.equal(linkedItem.weights['act_est_2'], 50);
  assert.equal(linkedItem.weights['act_est_3'], 50);
});
