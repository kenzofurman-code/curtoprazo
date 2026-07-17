# Tooltip do realizado no curto prazo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exibir o avanço anterior exato como `X% já medido` no tooltip do círculo cinza da Meta Planeada.

**Architecture:** Manter o tooltip nativo do botão e reutilizar `formatPercentBR`, sem estado ou componente visual adicional. Cobrir a cópia e a ligação do tooltip com um teste de regressão focado no código-fonte, pois o projeto não possui infraestrutura de testes de componentes.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Node.js test runner.

## Global Constraints

- O percentual exato deve aparecer somente no tooltip do círculo cinza.
- A cópia deve ser exatamente `X% já medido`.
- A formatação decimal deve permanecer em português brasileiro.
- A prioridade visual do círculo verde e os tooltips `Planejar X%` não mudam.

---

### Task 1: Tooltip do avanço anterior

**Files:**
- Create: `tests/planning-tooltip.test.mjs`
- Modify: `src/App.tsx:5657`

**Interfaces:**
- Consumes: `formatPercentBR(execBeforeReal): string` e as variáveis `isExecuted`, `isPlanned` e `val` existentes.
- Produces: atributo `title` no formato `${formatPercentBR(execBeforeReal)} já medido` para o círculo executado que não está verde.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mostra o percentual exato como já medido no círculo cinza', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /isExecuted && !isPlanned \? `\$\{formatPercentBR\(execBeforeReal\)\} já medido`/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/planning-tooltip.test.mjs`
Expected: FAIL porque o código atual contém `ja medido`, sem acento.

- [ ] **Step 3: Write minimal implementation**

```tsx
title={isExecuted && !isPlanned ? `${formatPercentBR(execBeforeReal)} já medido` : `Planejar ${val}%`}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/planning-tooltip.test.mjs`
Expected: 1 teste aprovado e 0 falhas.

- [ ] **Step 5: Verify the application**

Run: `npm run typecheck && npm run build`
Expected: ambos encerram com código 0.

- [ ] **Step 6: Commit**

```bash
git add tests/planning-tooltip.test.mjs src/App.tsx docs/superpowers/plans/2026-07-17-tooltip-realizado-curto-prazo.md
git commit -m "fix: mostra realizado no tooltip do curto prazo"
```
