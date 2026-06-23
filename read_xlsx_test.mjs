import XLSX from 'xlsx';

try {
  const workbook = XLSX.readFile('C:/Users/HomePC/.gemini/antigravity-ide/scratch/medicao-obras-app/teste.xlsx');
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

  let headerIndex = 3;

  // Let's count how many siblings each floor+package combination has
  const floorPackageCounts = {};
  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    const rawMacro = row[2] !== undefined ? String(row[2]).trim() : '';
    const rawFloor = row[5] !== undefined ? String(row[5]).trim() : '';
    const rawService = row[3] !== undefined ? String(row[3]).trim() : '';

    if (!rawMacro || rawMacro === '-') continue;

    const key = `${rawFloor}||${rawMacro}`;
    if (!floorPackageCounts[key]) {
      floorPackageCounts[key] = { total: 0, withService: 0, withoutService: 0 };
    }
    floorPackageCounts[key].total++;
    if (rawService && rawService !== '-') {
      floorPackageCounts[key].withService++;
    } else {
      floorPackageCounts[key].withoutService++;
    }
  }

  let summaryRowsCount = 0;
  let standaloneRowsCount = 0;
  const samplesOfStandalone = [];

  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;
    const rawMacro = row[2] !== undefined ? String(row[2]).trim() : '';
    const rawFloor = row[5] !== undefined ? String(row[5]).trim() : '';
    const rawService = row[3] !== undefined ? String(row[3]).trim() : '';

    if (!rawMacro || rawMacro === '-') continue;
    if (rawService && rawService !== '-') continue;

    const key = `${rawFloor}||${rawMacro}`;
    const stats = floorPackageCounts[key];

    if (stats.withService > 0) {
      summaryRowsCount++;
    } else {
      standaloneRowsCount++;
      if (samplesOfStandalone.length < 10) {
        samplesOfStandalone.push({
          row: i,
          macro: rawMacro,
          floor: rawFloor,
          duration: row[12],
          cost: row[15],
          progress: row[24]
        });
      }
    }
  }

  console.log("Summary rows (skipped):", summaryRowsCount);
  console.log("Standalone rows with '-' service (should be imported):", standaloneRowsCount);
  console.log("\nSamples of standalone rows:");
  console.log(JSON.stringify(samplesOfStandalone, null, 2));

} catch (err) {
  console.error("Error reading file:", err);
}
