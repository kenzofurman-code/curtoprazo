import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText).toString('base64')}`;
const datesUrl = moduleUrl(await readFile(new URL('../src/dates.ts', import.meta.url), 'utf8'));
const { parseExcelDate, formatDateBR, formatTimestamp, toLocalDateString } = await import(datesUrl);
const ppcSource = await readFile(new URL('../src/ppcDetail.ts', import.meta.url), 'utf8');
const { calculatePpcDetail } = await import(moduleUrl(ppcSource.replace("'./dates'", JSON.stringify(datesUrl))));

for (const timezone of ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo']) {
  test(`preserva datas do Excel, ISO e brasileiras em ${timezone}`, () => {
    const previous = process.env.TZ;
    process.env.TZ = timezone;
    try {
      assert.equal(parseExcelDate(45413), '2024-05-01');
      assert.equal(parseExcelDate(45413.75), '2024-05-01');
      assert.equal(parseExcelDate(45351), '2024-02-29');
      assert.equal(parseExcelDate('2026-11-03'), '2026-11-03');
      assert.equal(parseExcelDate('03/11/26'), '2026-11-03');
      assert.equal(parseExcelDate('03/11/2026'), '2026-11-03');
      assert.equal(parseExcelDate(new Date(2026, 10, 3)), '2026-11-03');
      assert.equal(toLocalDateString('2026-11-03'), '2026-11-03');
      assert.equal(formatDateBR('2026-11-03'), '03/11/26');
      assert.equal(formatDateBR('2024-02-29'), '29/02/24');
      assert.equal(formatDateBR(new Date(2026, 10, 3)), '03/11/26');
      const date = new Date(2026, 10, 3, 10, 5, 9);
      assert.equal(formatTimestamp(date), '03/11/26 10:05:09');
      assert.equal(formatTimestamp({ toDate: () => date }), '03/11/26 10:05:09');
      assert.equal(formatTimestamp({ seconds: date.getTime() / 1000 }), '03/11/26 10:05:09');
      const detail = calculatePpcDetail([], ['2026-11-02'], []);
      assert.equal(detail.rows[0].weekId, '2026-11-02');
      assert.equal(detail.rows[0].startDateStr, '02/11/26');
      assert.equal(detail.rows[0].endDateStr, '08/11/26');
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
}

test('datas vazias ou inválidas não viram outra data válida', () => {
  for (const value of [undefined, null, '', 'inválida', '31/02/26', '2026-02-31', new Date(NaN), NaN]) {
    assert.equal(parseExcelDate(value, '2026-11-03'), '2026-11-03');
    assert.equal(formatDateBR(value), '');
  }
});

test('timestamps preservam a conversão de horário local', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  try {
    assert.equal(formatTimestamp('2026-11-03T02:00:00Z'), '02/11/26 23:00:00');
    assert.equal(formatDateBR('2026-11-03'), '03/11/26');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
