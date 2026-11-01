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

const {
  createDefaultCalendar,
  isWorkDay,
  addWorkingDays,
  countWorkingDays,
  createSequentialFloors,
  getVerticalBuildingPreset,
  applyPaceAndGenerateActivities,
  recalculateSchedule,
  compileLobToCronograma,
  hydrateLobFromCronograma,
  optimizeSubLines,
} = lobModule;

test('calendário respeita dias úteis Seg-Sex e feriados ao somar durações', () => {
  const cal = {
    ...createDefaultCalendar('2026-10-12'),
    holidays: ['2026-10-12'], // Segunda-feira é feriado (Nossa Sra Aparecida)
  };

  assert.equal(isWorkDay('2026-10-11', cal), false); // Domingo
  assert.equal(isWorkDay('2026-10-12', cal), false); // Feriado
  assert.equal(isWorkDay('2026-10-13', cal), true);  // Terça-feira

  // 5 dias úteis iniciando em 2026-10-12 (pula feriado de Seg -> Ter, Qua, Qui, Sex, Seg 19/10)
  const end = addWorkingDays('2026-10-12', 5, cal);
  assert.equal(end, '2026-10-19');
  assert.equal(countWorkingDays('2026-10-13', '2026-10-19', cal), 5);
});

test('criação de locais em lote sequencial gera numeração, prefixo, sufixo e área corretos', () => {
  const floors = createSequentialFloors([], {
    prefix: 'Pavimento ',
    suffix: ' Tipo',
    quantity: 4,
    startsWith: 1,
    area: 450,
    replicationGroupId: 'grp_torre',
    zeroPad: true,
  });

  assert.equal(floors.length, 4);
  assert.equal(floors[0].name, 'Pavimento 01 Tipo');
  assert.equal(floors[3].name, 'Pavimento 04 Tipo');
  assert.equal(floors[0].area, 450);
  assert.equal(floors[0].replicationGroupId, 'grp_torre');
});

test('gerador de ritmo cria escadinha na Linha de Balanço e encadeia predecessoras verticais e horizontais', () => {
  const preset = getVerticalBuildingPreset();
  const cal = {
    ...createDefaultCalendar('2026-10-05'),
    holidays: [],
  };
  const floors = createSequentialFloors([], {
    prefix: '',
    suffix: 'º Pavimento',
    quantity: 3,
    startsWith: 1,
    area: 500,
    replicationGroupId: 'grp_torre',
    zeroPad: false,
  });

  const initialState = {
    calendar: cal,
    replicationGroups: preset.replicationGroups,
    floors,
    services: preset.services.slice(0, 2), // ESTRUTURA (6d) e ALVENARIA (5d)
    activities: [],
  };

  const generated = applyPaceAndGenerateActivities(initialState, {
    floorIds: floors.map((f) => f.id),
    serviceIds: initialState.services.map((s) => s.id),
    startDate: '2026-10-05', // Segunda
    pacedFloors: 1,
    direction: 'up',
    lagBetweenServicesDays: 1,
    chainAcrossServices: true,
    chainAcrossFloors: true,
  });

  assert.equal(generated.activities.length, 6); // 3 pavimentos x 2 pacotes

  const estPav1 = generated.activities.find(
    (a) => a.serviceId === 'pkg_estrutura' && a.floorId === floors[0].id
  );
  const estPav2 = generated.activities.find(
    (a) => a.serviceId === 'pkg_estrutura' && a.floorId === floors[1].id
  );
  const alvPav1 = generated.activities.find(
    (a) => a.serviceId === 'pkg_alvenaria' && a.floorId === floors[0].id
  );

  assert.ok(estPav1 && estPav2 && alvPav1);
  // Escadinha vertical: Estrutura no 2º Pavimento começa após o término da Estrutura no 1º Pavimento
  assert.ok(estPav2.start > estPav1.end);
  assert.ok(estPav2.predecessorIds.includes(estPav1.id));

  // Sequência horizontal: Alvenaria no 1º Pavimento começa após o término da Estrutura no 1º Pavimento
  assert.ok(alvPav1.start > estPav1.end);
  assert.ok(alvPav1.predecessorIds.includes(estPav1.id));
});

test('detecta dependência circular entre atividades sem travar o motor de cálculo', () => {
  const cal = createDefaultCalendar('2026-10-05');
  const floor = { id: 'flr_1', name: '1º Pav', position: 1, replicationGroupId: 'grp_1' };
  const s1 = {
    id: 'pkg_a',
    name: 'PACOTE A',
    color: '#000',
    position: 1,
    defaultLine: 1,
    defaultDuration: 3,
    defaultResponsible: 'EQ A',
    defaultTotalCost: 1000,
    autoChainJobs: true,
    jobs: [],
  };
  const s2 = {
    id: 'pkg_b',
    name: 'PACOTE B',
    color: '#111',
    position: 2,
    defaultLine: 2,
    defaultDuration: 3,
    defaultResponsible: 'EQ B',
    defaultTotalCost: 1000,
    autoChainJobs: true,
    jobs: [],
  };

  const stateWithCycle = {
    calendar: cal,
    replicationGroups: [{ id: 'grp_1', name: 'TORRE', position: 1, linesPerFloor: 4, color: '#eee' }],
    floors: [floor],
    services: [s1, s2],
    activities: [
      {
        id: 'act_a',
        serviceId: 'pkg_a',
        floorId: 'flr_1',
        line: 1,
        start: '2026-10-05',
        end: '2026-10-07',
        duration: 3,
        cost: 1000,
        responsible: 'EQ A',
        progress: 0,
        predecessorIds: ['act_b'],
        successorIds: [],
        dependencyRules: [],
        jobs: [],
      },
      {
        id: 'act_b',
        serviceId: 'pkg_b',
        floorId: 'flr_1',
        line: 2,
        start: '2026-10-05',
        end: '2026-10-07',
        duration: 3,
        cost: 1000,
        responsible: 'EQ B',
        progress: 0,
        predecessorIds: ['act_a'],
        successorIds: [],
        dependencyRules: [],
        jobs: [],
      },
    ],
  };

  const result = recalculateSchedule(stateWithCycle);
  assert.equal(result.hasCycle, true);
  assert.equal(result.cycleActivityIds.length, 2);
});

test('compilador bidirecional gera cronogramaInicial e allFloorsData 100% espelhados e re-hidrata com precisão', () => {
  const preset = getVerticalBuildingPreset();
  const cal = createDefaultCalendar('2026-10-05');
  const floors = createSequentialFloors([], {
    prefix: '',
    suffix: 'º Pavimento',
    quantity: 2,
    startsWith: 1,
    area: 400,
    replicationGroupId: 'grp_torre',
  });

  const populated = applyPaceAndGenerateActivities(
    {
      calendar: cal,
      replicationGroups: preset.replicationGroups,
      floors,
      services: preset.services.slice(0, 2),
      activities: [],
    },
    {
      floorIds: floors.map((f) => f.id),
      serviceIds: ['pkg_estrutura', 'pkg_alvenaria'],
      startDate: '2026-10-05',
      pacedFloors: 1,
      direction: 'up',
      lagBetweenServicesDays: 1,
      chainAcrossServices: true,
      chainAcrossFloors: true,
    }
  );

  const compiled = compileLobToCronograma(populated, {}, {}, ['EQUIPE ANTIGA'], []);

  // 2 pavimentos x (3 sub-tarefas de estrutura + 3 sub-tarefas de alvenaria) = 12 serviços no cronogramaInicial
  assert.equal(compiled.cronogramaInicial.length, 12);
  assert.deepEqual(compiled.floors, ['1º Pavimento', '2º Pavimento']);
  assert.ok(compiled.teams.includes('EQUIPE ESTRUTURA'));
  assert.ok(compiled.teams.includes('EQUIPE ALVENARIA'));
  assert.equal(compiled.matrices.length, 1);

  // Garante que todo item em cronogramaInicial existe em allFloorsData[floor][macroKey].items
  for (const item of compiled.cronogramaInicial) {
    const macroKey = lobModule.slugifySchedule(item.macro);
    const floorSection = compiled.allFloorsData[item.floor]?.[macroKey];
    assert.ok(floorSection, `Seção ${macroKey} deve existir no pavimento ${item.floor}`);
    const match = floorSection.items.find((fi) => fi.id === item.id);
    assert.ok(match, `Item ${item.id} deve estar espelhado em allFloorsData`);
  }

  // Re-hidrata a partir de cronogramaInicial e verifica se reconstrói as 4 barras da Linha de Balanço
  const rehydrated = hydrateLobFromCronograma(
    compiled.cronogramaInicial,
    compiled.floors,
    compiled.allFloorsData
  );
  assert.equal(rehydrated.activities.length, 4);
  assert.equal(rehydrated.floors.length, 2);
  assert.equal(rehydrated.services.length, 2);
});

test('otimizador de sub-linhas distribui 5 linhas, evita colisões de tarefas seguidas ou próximas e separa predecessoras', () => {
  const cal = createDefaultCalendar('2026-10-05');
  const floor = { id: 'flr_torre_1', name: '1º Pavimento', position: 1, replicationGroupId: 'grp_torre' };
  const groups = [{ id: 'grp_torre', name: 'TORRE', position: 1, linesPerFloor: 5, color: '#DCFCE7' }];

  // 6 atividades sequenciais no mesmo pavimento
  const activities = [
    {
      id: 'act_1',
      serviceId: 'pkg_1',
      floorId: 'flr_torre_1',
      line: 1,
      start: '2026-10-05',
      end: '2026-10-09',
      duration: 5,
      cost: 100,
      responsible: 'EQ 1',
      progress: 0,
      predecessorIds: [],
      successorIds: ['act_2'],
      dependencyRules: [],
      jobs: [],
    },
    {
      id: 'act_2',
      serviceId: 'pkg_2',
      floorId: 'flr_torre_1',
      line: 1, // Inicialmente colidindo na linha 1
      start: '2026-10-12',
      end: '2026-10-16',
      duration: 5,
      cost: 100,
      responsible: 'EQ 2',
      progress: 0,
      predecessorIds: ['act_1'],
      successorIds: ['act_3'],
      dependencyRules: [],
      jobs: [],
    },
    {
      id: 'act_3',
      serviceId: 'pkg_3',
      floorId: 'flr_torre_1',
      line: 1, // Inicialmente colidindo na linha 1
      start: '2026-10-19',
      end: '2026-10-23',
      duration: 5,
      cost: 100,
      responsible: 'EQ 3',
      progress: 0,
      predecessorIds: ['act_2'],
      successorIds: ['act_4'],
      dependencyRules: [],
      jobs: [],
    },
    {
      id: 'act_4',
      serviceId: 'pkg_4',
      floorId: 'flr_torre_1',
      line: 1, // Inicialmente colidindo na linha 1
      start: '2026-10-26',
      end: '2026-10-30',
      duration: 5,
      cost: 100,
      responsible: 'EQ 4',
      progress: 0,
      predecessorIds: ['act_3'],
      successorIds: ['act_5'],
      dependencyRules: [],
      jobs: [],
    },
    {
      id: 'act_5',
      serviceId: 'pkg_5',
      floorId: 'flr_torre_1',
      line: 1, // Inicialmente colidindo na linha 1
      start: '2026-11-02',
      end: '2026-11-06',
      duration: 5,
      cost: 100,
      responsible: 'EQ 5',
      progress: 0,
      predecessorIds: ['act_4'],
      successorIds: ['act_6'],
      dependencyRules: [],
      jobs: [],
    },
    {
      id: 'act_6',
      serviceId: 'pkg_6',
      floorId: 'flr_torre_1',
      line: 1, // 6ª atividade (deve reutilizar a linha 1 com buffer seguro de ~20 dias)
      start: '2026-11-09',
      end: '2026-11-13',
      duration: 5,
      cost: 100,
      responsible: 'EQ 6',
      progress: 0,
      predecessorIds: ['act_5'],
      successorIds: [],
      dependencyRules: [],
      jobs: [],
    },
  ];

  const state = {
    calendar: cal,
    replicationGroups: groups,
    floors: [floor],
    services: [],
    activities,
  };

  const optimized = optimizeSubLines(state, { defaultLinesPerFloor: 5 });

  const act1 = optimized.activities.find((a) => a.id === 'act_1');
  const act2 = optimized.activities.find((a) => a.id === 'act_2');
  const act3 = optimized.activities.find((a) => a.id === 'act_3');
  const act4 = optimized.activities.find((a) => a.id === 'act_4');
  const act5 = optimized.activities.find((a) => a.id === 'act_5');
  const act6 = optimized.activities.find((a) => a.id === 'act_6');

  // 1. As 5 primeiras atividades devem ocupar 5 sub-linhas distintas
  const firstFiveLines = [act1.line, act2.line, act3.line, act4.line, act5.line];
  const uniqueLines = new Set(firstFiveLines);
  assert.equal(uniqueLines.size, 5, 'As 5 atividades sequenciais devem se espalhar pelas 5 sub-linhas');

  // 2. Nenhuma atividade consecutiva ou com vínculo de predecessora deve estar na mesma linha
  assert.notEqual(act1.line, act2.line, 'Atividade 1 e 2 não podem estar na mesma sub-linha');
  assert.notEqual(act2.line, act3.line, 'Atividade 2 e 3 não podem estar na mesma sub-linha');
  assert.notEqual(act3.line, act4.line, 'Atividade 3 e 4 não podem estar na mesma sub-linha');
  assert.notEqual(act4.line, act5.line, 'Atividade 4 e 5 não podem estar na mesma sub-linha');
  assert.notEqual(act5.line, act6.line, 'Atividade 5 e 6 não podem estar na mesma sub-linha');

  // 3. A 6ª atividade reutiliza a linha 1 pois a atividade 1 terminou há um mês
  assert.equal(act6.line, act1.line, 'A 6ª atividade deve reutilizar a linha 1 com folga temporal');
});

