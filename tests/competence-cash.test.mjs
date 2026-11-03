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

const loadedModules = new Map();

function moduleFrom(filePath, source) {
  if (loadedModules.has(filePath)) {
    return loadedModules.get(filePath);
  }
  const mod = { exports: {} };
  loadedModules.set(filePath, mod.exports);

  const customRequire = (id) => {
    if (id.startsWith('./firebaseDocuments')) {
      return {
        getCachedFirebaseDocument: (docId) => inMemDb.get(docId) || null,
        saveFirebaseDocument: async (docId, val) => { inMemDb.set(docId, val); },
      };
    }
    if (id.startsWith('./physicalFinancialEngine')) {
      return {};
    }
    if (id.startsWith('./budgetLinking')) {
      return {};
    }
    if (id === 'xlsx') {
      return require('xlsx');
    }
    return require(id);
  };

  new Function('require', 'exports', 'module', compile(source))(customRequire, mod.exports, mod);
  loadedModules.set(filePath, mod.exports);
  return mod.exports;
}

const inMemDb = new Map();

const engineSource = await readFile(new URL('../src/competenceCashEngine.ts', import.meta.url), 'utf8');
const engine = moduleFrom('../src/competenceCashEngine.ts', engineSource);

test('parsePaymentTerms converte corretamente prazos simples, parcelados e ponderados', () => {
  // Padrão 28 dias
  assert.deepEqual(engine.parsePaymentTerms('28'), [{ days: 28, ratio: 1.0 }]);
  assert.deepEqual(engine.parsePaymentTerms(null), [{ days: 28, ratio: 1.0 }]);
  assert.deepEqual(engine.parsePaymentTerms('   '), [{ days: 28, ratio: 1.0 }]);

  // 2 parcelas (30/60)
  const terms2 = engine.parsePaymentTerms('30/60');
  assert.equal(terms2.length, 2);
  assert.equal(terms2[0].days, 30);
  assert.equal(terms2[0].ratio, 0.5);
  assert.equal(terms2[1].days, 60);
  assert.equal(terms2[1].ratio, 0.5);

  // 3 parcelas (30, 60, 90)
  const terms3 = engine.parsePaymentTerms('30, 60, 90');
  assert.equal(terms3.length, 3);
  assert.equal(terms3[0].days, 30);
  assert.equal(terms3[1].days, 60);
  assert.equal(terms3[2].days, 90);
  const sumRatio = terms3.reduce((s, t) => s + t.ratio, 0);
  assert.ok(Math.abs(sumRatio - 1.0) < 0.001);

  // Ponderado customizado (30:40, 60:60)
  const termsCustom = engine.parsePaymentTerms('30:40,60:60');
  assert.equal(termsCustom.length, 2);
  assert.equal(termsCustom[0].days, 30);
  assert.equal(termsCustom[0].ratio, 0.4);
  assert.equal(termsCustom[1].days, 60);
  assert.equal(termsCustom[1].ratio, 0.6);
});

test('Herança EAP: getDefaultStageConfigs e resolveStageConfig herdam do pai e do padrão', () => {
  const budgetItems = [
    { code: '1', level: 1, description: 'Obra Completa', total_price: 200000 },
    { code: '01.01', level: 2, description: 'Estrutura', parent_code: '1', total_price: 100000 },
    { code: '01.01.01', level: 3, description: 'Concreto', parent_code: '01.01', total_price: 50000 },
    { code: '01.01.01.001', level: 5, description: 'Concreto FCK 30', parent_code: '01.01.01', total_price: 50000 },
  ];

  const configs = engine.getDefaultStageConfigs(budgetItems);
  assert.ok(configs['01.01']);
  assert.equal(configs['01.01'].material_pct, 60.0);
  assert.equal(configs['01.01'].labor_pct, 40.0);

  const budgetMap = {
    '1': budgetItems[0],
    '01.01': budgetItems[1],
    '01.01.01': budgetItems[2],
    '01.01.01.001': budgetItems[3],
  };

  // Customiza apenas o Nível 2 ('01.01') com 70% Material e 30% MO, 20 dias antecedência
  configs['01.01'].is_custom = true;
  configs['01.01'].material_pct = 70.0;
  configs['01.01'].labor_pct = 30.0;
  configs['01.01'].anticipation_days = 20;

  // Resolve para o item N5 ('01.01.01.001') -> deve herdar do Nível 2
  const resolved = engine.resolveStageConfig('01.01.01.001', budgetMap, configs);
  assert.equal(resolved.material_pct, 70.0);
  assert.equal(resolved.labor_pct, 30.0);
  assert.equal(resolved.anticipation_days, 20);
  assert.ok(resolved.source.includes('01.01'));
});

test('Cálculo Básico de Competência e Caixa: 100% de fechamento contábil e financeiro', () => {
  const budgetItems = [
    { code: '1', level: 1, description: 'Obra Teste', total_price: 100000 },
    { code: '01.01', level: 2, parent_code: '1', description: 'Infraestrutura', total_price: 100000 },
    { code: '01.01.001', level: 5, parent_code: '01.01', description: 'Sapatas e Blocos', total_price: 100000 },
  ];

  const cycles = [
    {
      num: 1,
      name: 'Mês 1',
      period_label: 'Nov/25',
      full_label: 'Mês 1 (Nov/25)',
      start: '2025-10-21',
      end: '2025-11-20',
      is_past: false,
    },
    {
      num: 2,
      name: 'Mês 2',
      period_label: 'Dez/25',
      full_label: 'Mês 2 (Dez/25)',
      start: '2025-11-21',
      end: '2025-12-20',
      is_past: false,
    },
    {
      num: 3,
      name: 'Mês 3',
      period_label: 'Jan/26',
      full_label: 'Mês 3 (Jan/26)',
      start: '2025-12-21',
      end: '2026-01-20',
      is_past: false,
    },
  ];

  // R$ 10.000 executados no Mês 2
  const tabFfRows = [
    {
      level: 1,
      code: '1',
      description: 'Obra Teste',
      budget: 100000,
      budget_pct: 100,
      cycle_vals: { '1': 0, '2': 10000, '3': 0 },
      total: 10000,
      total_pct: 10,
    },
    {
      level: 2,
      code: '01.01',
      parent_code: '1',
      description: 'Infraestrutura',
      budget: 100000,
      budget_pct: 100,
      cycle_vals: { '1': 0, '2': 10000, '3': 0 },
      total: 10000,
      total_pct: 10,
    },
    {
      level: 5,
      code: '01.01.001',
      parent_code: '01.01',
      description: 'Sapatas e Blocos',
      budget: 100000,
      budget_pct: 100,
      cycle_vals: { '1': 0, '2': 10000, '3': 0 },
      total: 10000,
      total_pct: 10,
    },
  ];

  // 60% Material (R$ 6.000) e 40% MO (R$ 4.000)
  // Antecedência de 15 dias: entrega em 21/11 - 15d = 06/11 (cai no Mês 1)
  // Pagamento Material: 28 dias após 06/11 = 04/12 (cai no Mês 2)
  // Pagamento MO: dia 05 do mês seguinte ao Mês 2 -> cai no Mês 3
  const stageConfigs = {
    '01.01': {
      code: '01.01',
      description: 'Infraestrutura',
      level: 2,
      material_pct: 60.0,
      labor_pct: 40.0,
      anticipation_days: 15,
      distribution_type: 'continuo',
      num_batches: null,
      payment_terms: '28',
      labor_payment_day: 5,
    },
  };

  const result = engine.computeCompetenceAndCashflow({
    budgetItems,
    tabFfRows,
    cycles,
    totalProjBudget: 100000,
    stageConfigs,
  });

  assert.ok(result.tabCompetencia.length > 0);
  assert.ok(result.tabFinanceiro.length > 0);

  const rootComp = result.tabCompetencia.find((r) => r.level === 1);
  const rootFin = result.tabFinanceiro.find((r) => r.level === 1);

  assert.ok(rootComp);
  assert.ok(rootFin);

  // Total geral deve fechar em R$ 10.000 em ambas as curvas
  assert.equal(rootComp.total, 10000);
  assert.equal(rootFin.total, 10000);

  // Competência:
  // Material antecipado: R$ 6.000 no Mês 1
  // Mão de Obra: R$ 4.000 no Mês 2
  assert.equal(rootComp.cycle_mat_vals['1'], 6000);
  assert.equal(rootComp.cycle_mo_vals['2'], 4000);

  // Caixa (Desembolso):
  // Material pago 28 dias após entrega: R$ 6.000 no Mês 2
  // Mão de Obra paga no dia 05 do mês seguinte: R$ 4.000 no Mês 3
  assert.equal(rootFin.cycle_mat_vals['2'], 6000);
  assert.equal(rootFin.cycle_mo_vals['3'], 4000);
});

test('Distribuição em Lotes: divide material em N entregas e estende ciclos se necessário', () => {
  const budgetItems = [
    { code: '1', level: 1, description: 'Obra Lotes', total_price: 50000 },
    { code: '01.07', level: 2, parent_code: '1', description: 'Revestimentos', total_price: 50000 },
    { code: '01.07.001', level: 5, parent_code: '01.07', description: 'Porcelanato', total_price: 50000 },
  ];

  const cycles = [
    { num: 1, name: 'Mês 1', period_label: 'Out/25', full_label: 'Mês 1 (Out/25)', start: '2025-09-21', end: '2025-10-20', is_past: false },
    { num: 2, name: 'Mês 2', period_label: 'Nov/25', full_label: 'Mês 2 (Nov/25)', start: '2025-10-21', end: '2025-11-20', is_past: false },
    { num: 3, name: 'Mês 3', period_label: 'Dez/25', full_label: 'Mês 3 (Dez/25)', start: '2025-11-21', end: '2025-12-20', is_past: false },
  ];

  const tabFfRows = [
    {
      level: 1,
      code: '1',
      description: 'Obra Lotes',
      budget: 50000,
      budget_pct: 100,
      cycle_vals: { '1': 10000, '2': 10000, '3': 10000 },
      total: 30000,
      total_pct: 60,
    },
    {
      level: 2,
      code: '01.07',
      parent_code: '1',
      description: 'Revestimentos',
      budget: 50000,
      budget_pct: 100,
      cycle_vals: { '1': 10000, '2': 10000, '3': 10000 },
      total: 30000,
      total_pct: 60,
    },
    {
      level: 5,
      code: '01.07.001',
      parent_code: '01.07',
      description: 'Porcelanato',
      budget: 50000,
      budget_pct: 100,
      cycle_vals: { '1': 10000, '2': 10000, '3': 10000 },
      total: 30000,
      total_pct: 60,
    },
  ];

  // 3 Lotes de material, 100% material para testar batches
  const stageConfigs = {
    '01.07': {
      code: '01.07',
      description: 'Revestimentos',
      level: 2,
      material_pct: 100.0,
      labor_pct: 0.0,
      anticipation_days: 10,
      distribution_type: 'lotes',
      num_batches: 3,
      payment_terms: '30/60', // Parcelado 30 e 60 dias
      labor_payment_day: 5,
    },
  };

  const result = engine.computeCompetenceAndCashflow({
    budgetItems,
    tabFfRows,
    cycles,
    totalProjBudget: 50000,
    stageConfigs,
  });

  const rootFin = result.tabFinanceiro.find((r) => r.level === 1);
  assert.equal(rootFin.total, 30000);

  // Pagamento parcelado no Mês 3 com 60 dias se estende para ciclos posteriores
  assert.ok(result.extendedCycles.length >= cycles.length);
});

test('Persistência e Cascata de Herança em loadCurvasConfig e saveCurvasConfig', async () => {
  const projectId = 'obra_teste_persist';
  const budgetItems = [
    { code: '1', level: 1, description: 'Obra Teste', total_price: 150000 },
    { code: '02.01', level: 2, parent_code: '1', description: 'Alvenaria', total_price: 150000 },
    { code: '02.01.01', level: 3, parent_code: '02.01', description: 'Blocos Cerâmicos', total_price: 150000 },
  ];

  // Salva configuração personalizada no Nível 2
  const customConfig = {
    '02.01': {
      code: '02.01',
      description: 'Alvenaria',
      level: 2,
      material_pct: 75.0,
      labor_pct: 25.0,
      anticipation_days: 12,
      distribution_type: 'continuo',
      payment_terms: '30/60',
      labor_payment_day: 5,
      is_custom: true,
      source: 'Personalizado',
    },
  };

  await engine.saveCurvasConfig(projectId, customConfig);

  // Carrega e verifica se o filho '02.01.01' herdou 75% material e 25% MO
  const loaded = engine.loadCurvasConfig(projectId, budgetItems);
  assert.equal(loaded['02.01'].material_pct, 75.0);
  assert.equal(loaded['02.01.01'].material_pct, 75.0);
  assert.equal(loaded['02.01.01'].labor_pct, 25.0);
  assert.equal(loaded['02.01.01'].anticipation_days, 12);
  assert.equal(loaded['02.01.01'].payment_terms, '30/60');
  assert.ok(loaded['02.01.01'].source.includes('02.01'));
});
