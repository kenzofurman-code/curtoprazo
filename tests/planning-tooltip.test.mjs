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
