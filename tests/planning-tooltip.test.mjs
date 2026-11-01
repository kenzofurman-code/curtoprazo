import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mostra o percentual exato como já medido no círculo cinza', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(
    source,
    /isExecuted && !isPlanned \? `\$\{formatPercentBR\(execBeforeReal\)\} já medido`/
  );
});

test('preserva o realizado exato ao recalcular o planejamento', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(
    source,
    /cumulativeProgress\[key\] = clampPercent\(task\.executedBeforeRaw \?\? task\.executedBefore \?\? 0\)/
  );
  assert.match(source, /executedBeforeRaw: exactExecutedBefore/);
});

test('trata o realizado semanal como medicao acumulada', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const sync = source.slice(
    source.indexOf('const syncPlanningAndPhysical'),
    source.indexOf('const syncCronogramaWithFloorsData')
  );

  assert.match(sync, /cumulativeProgress\[key\] = Math\.max\(/);
  assert.doesNotMatch(sync, /exactExecutedBefore \+ \(Number\(task\.progressThisWeek\) \|\| 0\)/);
  assert.match(source, /const finalProgress = getTaskAccumulatedProgress\(t\)/);
  assert.match(source, /getTaskAccumulatedProgress\(t\)\}%/);
});

test('inclui atividades zeradas na origem de nao concluidas', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const candidates = source.slice(
    source.indexOf("if (drawerSourceMode === 'unfinished')"),
    source.indexOf("if (drawerSourceMode !== 'previous-successors')")
  );

  assert.match(candidates, /\(item\.progress \?\? 0\) >= 0/);
  assert.match(source, /andamento de 0% até menor que 100%/);
});

test('permite corrigir uma semana finalizada com recalculo integrado', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(source, /const \[editingFinalizedWeekId, setEditingFinalizedWeekId\] = useState/);
  assert.match(source, /const isTaskLocked = \(task\) => Boolean\(task\?\.finalized && !isWeekBeingEdited\)/);
  assert.match(source, /const handleSaveFinalizedWeekEdits = async \(\) =>/);
  assert.match(source, /syncPlanningAndPhysical\(\s*adjustedPlanning/);
  assert.match(source, /updatedPpcHistory/);
  assert.match(source, /handleOpenWeekForEditing\(t\.weekId\)/);
  assert.match(source, /carriedFromWeekId: currentWeekId/);
});

test('evita duplicar saldos carregados depois de uma correção histórica', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const correctionHandler = source.slice(
    source.indexOf('const handleSaveFinalizedWeekEdits'),
    source.indexOf('const reopenBudgetDiffsFromTasks')
  );

  assert.match(correctionHandler, /isCarryOverFromEditedWeek/);
  assert.match(correctionHandler, /getTaskAccumulatedProgress\(sourceTask\) < 100/);
  assert.match(correctionHandler, /plannedThisWeek: Math\.max\(0, 100 - finalProgress\)/);
});

test('propaga o realizado fisico para o cronograma e para a inclusao semanal', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(
    source,
    /progress: clampPercent\(physicalItem\.actualPercent \?\? c\.progress \?\? 0\)/
  );
  assert.match(
    source,
    /map\(item => \(\{ \.\.\.item, progress: getActivityProgressFromFloors\(item, allFloorsData\) \}\)\)/
  );
});

test('aceitar apontamento de campo atualiza fisico e historico', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const handler = source.slice(
    source.indexOf('const handleAcceptPreFill'),
    source.indexOf('const handlePrintPlanning')
  );

  assert.match(handler, /syncPlanningAndPhysical\(updatedPlanning, allFloorsData, cronogramaInicial\)/);
  assert.match(handler, /setAllFloorsData\(updatedFloorsData\)/);
  assert.match(handler, /setHistory\(updatedHistory\)/);
  assert.match(handler, /weatherCache, true\)/);
});

test('reconcilia projetos antigos depois de carregar todos os documentos', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const reconciliation = source.slice(
    source.indexOf('const reconcileLoadedProgress'),
    source.indexOf('const unsubMeta')
  );

  assert.match(reconciliation, /hasReceivedMeta \|\| !hasReceivedCrono \|\| !hasReceivedFloors \|\| !hasReceivedPlanning/);
  assert.match(reconciliation, /syncPlanningAndPhysical/);
  assert.match(reconciliation, /syncCronogramaWithFloorsData/);
  assert.match(reconciliation, /setCronogramaInicial\(syncedCrono\)/);
  assert.match(reconciliation, /setIsProjectHydrated\(true\)/);
});

test('nao salva dados vazios antes de concluir a carga do projeto', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const loadingEffect = source.slice(
    source.indexOf('const targetId = urlUserId ? urlUserId : selectedProjectId'),
    source.indexOf('const loadWeather = async')
  );
  const weatherEffect = source.slice(
    source.indexOf('const loadWeather = async'),
    source.indexOf('const performActualSave')
  );

  assert.doesNotMatch(loadingEffect, /saveToDB\(\[\], \{\}, \[\], \{\}, \[\]/);
  assert.match(weatherEffect, /if \(isTeamMode \|\| !isProjectHydrated\) return/);
  assert.doesNotMatch(weatherEffect, /saveToDB\(/);
  assert.match(weatherEffect, /saveWeatherCacheOnly\(newCache\)/);
  assert.match(source, /if \(!hydratedProjectIdsRef\.current\.has\(resolvedTargetId\)\)/);
  assert.match(source, /setIsProjectHydrated\(false\);\s*localStorage\.setItem\('selected_project_id', projId\)/);
});

test('nao reutiliza valores de progresso entre linhas do cronograma', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const table = source.slice(
    source.indexOf('filteredCronograma.map'),
    source.indexOf('filteredCronograma.length === 0')
  );

  assert.doesNotMatch(table, /<tr key=\{idx\}/);
  assert.match(table, /const activityKey = `\$\{selectedProjectId\}\|\|\$\{item\.floor\}\|\|\$\{item\.id\}`/);
  assert.match(table, /key=\{`\$\{activityKey\}\|\|\$\{progressValue\}`\}/);
  assert.match(table, /defaultValue=\{progressValue\}/);
});

test('usa o mesmo limite de 15000 atividades na importacao e no salvamento', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(source, /const MAX_IMPORTED_CRONOGRAMA_ITEMS = 15000/);
  assert.match(source, /serializedCrono\.slice\(0, MAX_IMPORTED_CRONOGRAMA_ITEMS\)/);
  assert.match(source, /parsedItems\.length > MAX_IMPORTED_CRONOGRAMA_ITEMS/);
  assert.match(source, /nenhum dado foi importado/);
  assert.doesNotMatch(source, /parsedItems = parsedItems\.slice\(0, MAX_IMPORTED_CRONOGRAMA_ITEMS\)/);
  assert.doesNotMatch(source, /slice\(0, 6000\)/);
});
