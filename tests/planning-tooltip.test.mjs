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

  assert.match(reconciliation, /hasReceivedCrono \|\| !hasReceivedFloors \|\| !hasReceivedPlanning/);
  assert.match(reconciliation, /syncPlanningAndPhysical/);
  assert.match(reconciliation, /syncCronogramaWithFloorsData/);
  assert.match(reconciliation, /setCronogramaInicial\(syncedCrono\)/);
});
