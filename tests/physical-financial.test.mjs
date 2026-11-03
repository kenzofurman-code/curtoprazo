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
    if (id.startsWith('./scheduleVersionStorage')) {
      return {
        versionStorageKey: projectId => 'versions_' + projectId,
        readVersionList: async key => structuredClone(inMemDb.get(key) || []),
        updateVersionList: async (key, update) => {
          const next = update(structuredClone(inMemDb.get(key) || []));
          inMemDb.set(key, structuredClone(next)); return next;
        }
      };
    }
    if (id.startsWith('./localDatabase')) {
      return {
        getLocalDocData: (docId) => inMemDb.get(docId) || null,
        setLocalDocData: (docId, val) => inMemDb.set(docId, val),
      };
    }
    if (id.startsWith('./scheduleVersions')) {
      return versionsModule;
    }
    if (id.startsWith('./physicalFinancialEngine')) {
      return engineModule;
    }
    if (id.startsWith('./budgetLinking')) {
      return {};
    }
    if (id.startsWith('./longTermSchedule')) {
      return {};
    }
    return require(id);
  };

  new Function('require', 'exports', 'module', compile(source))(customRequire, mod.exports, mod);
  loadedModules.set(filePath, mod.exports);
  return mod.exports;
}

const inMemDb = new Map();

const engineSource = await readFile(new URL('../src/physicalFinancialEngine.ts', import.meta.url), 'utf8');
const engineModule = moduleFrom('../src/physicalFinancialEngine.ts', engineSource);

const versionsSource = await readFile(new URL('../src/scheduleVersions.ts', import.meta.url), 'utf8');
const versionsModule = moduleFrom('../src/scheduleVersions.ts', versionsSource);

const {
  generateCycles,
  countWorkdaysBetween,
  getWorkdaysInsideWindow,
  compareWbsCodes,
  runPhysicalFinancialCalculation,
} = engineModule;

test('físico-financeiro sem dados apresenta totais zero e não assume uma obra ou orçamento de exemplo', () => {
  const result = runPhysicalFinancialCalculation({budgetItems:[],scheduleTasks:[],projectName:'Obra cadastrada'});
  assert.equal(result.projectName,'Obra cadastrada');
  for(const field of ['totalBudget','totalMeasured','totalMeasuredPct','totalBalance','totalBalancePct'])assert.equal(result[field],0);
  assert.deepEqual(result.tabDistribuicao,[]);
  assert.deepEqual(result.tabMedicao,[]);
  assert.ok(!JSON.stringify(result).includes('Qoya'));
});

const {
  loadScheduleVersions,
  saveScheduleVersions,
  createNewScheduleVersion,
  setVersionAsBaseline,
  activateScheduleVersion,
  deleteScheduleVersion,
  promoteScenarioToOfficial,
  getBaselineVersion,
} = versionsModule;

test('Ciclos de Medição: Padrão 21 a 20 e Calendário 1 a 30 geram datas e rótulos consistentes', () => {
  // Padrão civil brasileiro (21 a 20)
  const cycles21 = generateCycles('2025-10-01', '2026-02-28', 21, 20, 2);
  assert.ok(cycles21.length >= 4, 'Deve gerar pelo menos 4 ciclos');
  assert.equal(cycles21[0].num, 1);
  assert.equal(cycles21[0].is_past, true, 'Ciclo 1 deve ser passado (corte=2)');
  assert.equal(cycles21[1].is_past, true, 'Ciclo 2 deve ser passado (corte=2)');
  assert.equal(cycles21[2].is_past, false, 'Ciclo 3 deve ser futuro (corte=2)');

  // Verifica que o ciclo 1 começa dia 21 e termina dia 20
  assert.ok(cycles21[0].start.endsWith('-21'), `Início do ciclo 1 deve terminar em -21: ${cycles21[0].start}`);
  assert.ok(cycles21[0].end.endsWith('-20'), `Término do ciclo 1 deve terminar em -20: ${cycles21[0].end}`);

  // Modo Calendário (1 a 31)
  const cyclesCalendar = generateCycles('2025-01-01', '2025-04-30', 1, 31, 1);
  assert.equal(cyclesCalendar[0].start, '2025-01-01');
  assert.equal(cyclesCalendar[0].end, '2025-01-31');
  assert.equal(cyclesCalendar[0].period_label, 'Jan/25');
  assert.equal(cyclesCalendar[1].period_label, 'Fev/25');
});

test('Dias Úteis: contagem e fatiamento em janela respeita seg-sex', () => {
  // Segunda a Sexta: 5 dias
  const count1 = countWorkdaysBetween('2025-10-06', '2025-10-10'); // Seg a Sex
  assert.equal(count1, 5);

  // Incluindo fim de semana: 2025-10-10 (Sex) a 2025-10-13 (Seg) -> 2 dias úteis
  const count2 = countWorkdaysBetween('2025-10-10', '2025-10-13');
  assert.equal(count2, 2);

  // Fatiamento dentro da janela do ciclo
  const windowDays = getWorkdaysInsideWindow('2025-10-01', '2025-10-31', '2025-10-06', '2025-10-10');
  assert.equal(windowDays, 5);
});

test('Ordenação canônica da EAP: nível 1 primeiro e números hierárquicos', () => {
  const codes = ['01.02', '01', '01.01.02', '01.01.01', '01.10', '01.01'];
  codes.sort(compareWbsCodes);
  assert.deepEqual(codes, ['01', '01.01', '01.01.01', '01.01.02', '01.02', '01.10']);
});

test('Distribuição Nível 6 e Físico-Financeiro Inicial: Rollup 100% fechado', () => {
  const mockBudget = [
    {
      id: 'b1',
      eapCode: '01',
      name: 'OBRA TESTE',
      level: 1,
      totalCost: 100000,
      isLeaf: false,
      linkedScheduleIds: [],
    },
    {
      id: 'b2',
      eapCode: '01.01',
      name: 'INFRAESTRUTURA',
      level: 2,
      parentId: '01',
      totalCost: 100000,
      isLeaf: false,
      linkedScheduleIds: [],
    },
    {
      id: 'b3',
      eapCode: '01.01.01',
      name: 'FUNDAÇÃO DIRETA',
      level: 5,
      parentId: '01.01',
      totalCost: 100000,
      isLeaf: true,
      linkedScheduleIds: ['task_a', 'task_b'],
      weights: { task_a: 40, task_b: 60 },
    },
  ];

  const mockTasks = [
    {
      id: 'task_a',
      name: 'Escavação Fundações',
      startDate: '2025-10-01',
      endDate: '2025-10-20',
      duration: 15,
    },
    {
      id: 'task_b',
      name: 'Concretagem Sapatas',
      startDate: '2025-10-21',
      endDate: '2025-11-20',
      duration: 22,
    },
  ];

  const res = runPhysicalFinancialCalculation({
    budgetItems: mockBudget,
    scheduleTasks: mockTasks,
    cycleStartDay: 21,
    cycleEndDay: 20,
    cutoffMedNum: 1,
  });

  assert.equal(res.totalBudget, 100000);
  assert.ok(res.tabDistribuicao.length > 0);

  // Linha Nível 5
  const rowL5 = res.tabDistribuicao.find((r) => r.code === '01.01.01');
  assert.ok(rowL5, 'Deve encontrar a linha L5');
  assert.equal(rowL5.allocated_val, 100000);

  // Linhas filhas Nível 6
  const childrenL6 = res.tabDistribuicao.filter((r) => r.parent_code === '01.01.01');
  assert.equal(childrenL6.length, 2, 'Deve ter 2 tarefas filhas N6');
  assert.equal(childrenL6[0].allocated_val, 40000); // 40%
  assert.equal(childrenL6[1].allocated_val, 60000); // 60%

  // Rollup EAP Baseline
  const rootFF = res.tabFisicoFinanceiro.find((r) => r.code === '01');
  assert.ok(rootFF);
  assert.equal(rootFF.budget, 100000);
  assert.equal(Math.round(rootFF.total), 100000, 'Total da Baseline deve fechar em 100.000');
});

test('Base Medição e Replanejado pelo Saldo: Blindagem de medições passadas e 100% de orçamento fechado', () => {
  const mockBudget = [
    {
      id: 'b1',
      eapCode: '01',
      name: 'OBRA TESTE REPLANEJADA',
      level: 1,
      totalCost: 50000,
      isLeaf: false,
      linkedScheduleIds: [],
    },
    {
      id: 'b2',
      eapCode: '01.01',
      name: 'ESTRUTURA',
      level: 5,
      parentId: '01',
      totalCost: 50000,
      isLeaf: true,
      linkedScheduleIds: ['t1', 't2'],
    },
  ];

  const mockTasks = [
    {
      id: 't1',
      name: 'Pilares Lote 1',
      startDate: '2025-01-01',
      endDate: '2025-01-20',
      duration: 14,
    },
    {
      id: 't2',
      name: 'Vigas e Lajes Lote 2',
      startDate: '2025-01-21',
      endDate: '2025-03-20',
      duration: 42,
    },
  ];

  // Medição customizada: no mês 1 mediu exatamente 50%
  const customMeasurementsMonthly = {
    '01.01': { '1': 50 }, // 50% medido no mês 1
  };

  const res = runPhysicalFinancialCalculation({
    budgetItems: mockBudget,
    scheduleTasks: mockTasks,
    cycleStartDay: 21,
    cycleEndDay: 20,
    cutoffMedNum: 1,
    customMeasurementsMonthly,
  });

  // Verifica Medição
  const medRow = res.tabMedicao.find((m) => m.code === '01.01');
  assert.ok(medRow);
  assert.equal(medRow.accum_realizado_pct, 50, 'Deve acumular 50% até o corte');
  assert.equal(medRow.accum_realizado_val, 25000, 'Valor realizado deve ser 25.000');
  assert.equal(medRow.saldo, 25000, 'Saldo a medir deve ser 25.000');

  // Verifica Replanejado pelo Saldo
  const replanRoot = res.tabFfReplanejado.find((r) => r.code === '01');
  assert.ok(replanRoot);
  assert.equal(Math.round(replanRoot.total), 50000, 'Replanejado consolidado deve fechar exatamente em 50.000');

  // Curva S
  assert.ok(res.sCurve.baseline_accum_pcts.length > 0);
  assert.equal(res.sCurve.realized_accum_pcts[0], 50, 'Mês 1 da Curva S realizada deve ser 50%');
  assert.equal(res.sCurve.realized_accum_pcts[1], null, 'Mês 2 da Curva S realizada deve ser null (futuro)');
  assert.equal(res.sCurve.replan_accum_pcts[res.sCurve.replan_accum_pcts.length - 1], 100, 'Curva S Replanejada deve fechar em 100%');
});

test('Gestão de Versões e Linha de Base (Baseline): Snapshot, seleção e ativação', async () => {
  const projectId = 'test_proj_' + Date.now();
  const initialSnapshot = {
    cronogramaInicial: [{ id: 'act1', name: 'Alvenaria' }],
    floors: ['Térreo', '1º Pav'],
    allFloorsData: { Térreo: {} },
    weights: {},
  };

  // Inicializa
  const initialList = await loadScheduleVersions(projectId, initialSnapshot);
  assert.equal(initialList.length, 1);
  assert.equal(initialList[0].isBaseline, true);

  // Cria nova versão de reprogramação
  const { versions, created } = await createNewScheduleVersion(
    projectId,
    'Revisão 01 - Acelerada',
    'Simulação com 2 equipes a mais',
    false,
    {
      cronogramaInicial: [{ id: 'act1', name: 'Alvenaria Acelerada' }],
      floors: ['Térreo', '1º Pav'],
      allFloorsData: {},
    }
  );

  assert.equal(versions.length, 2);
  assert.equal(created.name, 'Revisão 01 - Acelerada');
  assert.equal(created.isActive, true);

  // Baseline original permanece a inicial
  const baseline = await getBaselineVersion(projectId);
  assert.ok(baseline);
  assert.equal(baseline.id, initialList[0].id);

  // Altera a linha de base para a nova versão criada
  const updatedWithNewBaseline = await setVersionAsBaseline(projectId, created.id);
  assert.equal(updatedWithNewBaseline.find((v) => v.id === created.id).isBaseline, true);
  assert.equal(updatedWithNewBaseline.find((v) => v.id === initialList[0].id).isBaseline, false);
});

test('4 Tipos de Versionamento (Cenário, Backup, Meta, Baseline), Promoção e Exclusão Segura', async () => {
  const projectId = 'test_types_' + Date.now();
  const baseSnap = {
    cronogramaInicial: [{ id: 'act1', name: 'Alvenaria Oficial' }],
    floors: ['Térreo'],
    allFloorsData: {},
  };

  await loadScheduleVersions(projectId, baseSnap);

  // 1. Cria Cenário (Simulação)
  const { created: scenario } = await createNewScheduleVersion(
    projectId,
    'Cenário 01 - Teste Turno Noturno',
    'Simulação com turno estendido',
    false,
    baseSnap,
    { type: 'scenario', author: 'Eng. Planejamento' }
  );
  assert.equal(scenario.type, 'scenario');
  assert.equal(scenario.author, 'Eng. Planejamento');
  assert.equal(scenario.isBaseline, false);
  assert.equal(scenario.isActive, true);

  // 2. Cria Backup de Segurança
  const { created: backup } = await createNewScheduleVersion(
    projectId,
    'Backup Pré-Revisão',
    'Segurança antes de alterações',
    false,
    baseSnap,
    { type: 'backup', author: 'Coordenador' }
  );
  assert.equal(backup.type, 'backup');
  assert.equal(backup.author, 'Coordenador');

  // 3. Cria Cronograma Meta
  const { created: meta } = await createNewScheduleVersion(
    projectId,
    'Meta Interna Acelerada',
    'Ritmo agressivo',
    false,
    baseSnap,
    { type: 'meta', author: 'Diretoria' }
  );
  assert.equal(meta.type, 'meta');

  // 4. Promove Cenário a Previsto Oficial
  const { versions: afterPromotion, active: official } = await promoteScenarioToOfficial(projectId, scenario.id);
  assert.ok(official);
  assert.equal(official.type, 'forecast');
  assert.equal(official.isActive, true);
  assert.ok(official.name.includes('Previsto Oficial'));
  assert.ok(afterPromotion.find((v) => v.id === official.id));

  // 5. Exclusão Segura: Não permite excluir a baseline oficial
  const baseVer = await getBaselineVersion(projectId);
  const afterTryDeleteBase = await deleteScheduleVersion(projectId, baseVer.id);
  assert.ok(afterTryDeleteBase.find((v) => v.id === baseVer.id), 'Baseline oficial deve estar protegida contra exclusão');

  // 6. Exclusão de versão não-baseline é permitida
  const afterDeleteBackup = await deleteScheduleVersion(projectId, backup.id);
  assert.equal(afterDeleteBackup.find((v) => v.id === backup.id), undefined, 'Backup excluído não deve estar na lista');
});

test('primeira importação cria uma versão sem duplicar o mesmo cronograma como baseline',async()=>{
  const snapshot={cronogramaInicial:[{id:'1',service:'Concretagem'}],floors:['Térreo'],allFloorsData:{}};
  const result=await createNewScheduleVersion('first_import','Importação','',false,snapshot);
  assert.equal(result.versions.length,1);
  assert.deepEqual(result.created.snapshot.cronogramaInicial,snapshot.cronogramaInicial);
  assert.equal((await loadScheduleVersions('first_import')).length,1);
});
