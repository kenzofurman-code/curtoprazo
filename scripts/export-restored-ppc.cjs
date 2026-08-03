const fs = require('fs');
const path = require('path');

const backupPath = path.resolve(__dirname, '..', 'backups', 'firestore-project_measurements-2026-07-11T22-34-31-177Z.json');
const outputJsonPath = path.resolve(__dirname, '..', 'docs', 'ppc-restaurado.json');
const outputHtmlPath = path.resolve(__dirname, '..', 'docs', 'ppc-restaurado.html');

function decompressStringUnicode(compressedStr) {
  if (!compressedStr) return '';
  if (!compressedStr.startsWith('unicode:')) return compressedStr;

  const dataPart = compressedStr.substring(8);
  let dictionary = {};
  const initDict = () => {
    dictionary = {};
    for (let i = 0; i < 256; i++) dictionary[i] = String.fromCodePoint(i);
  };
  initDict();

  const codes = dataPart.split(',');
  let word = dictionary[parseInt(codes[0], 36)] || '';
  let result = word;
  let dictSize = 256;

  for (let i = 1; i < codes.length; i++) {
    const code = parseInt(codes[i], 36);
    let entry;
    if (Object.prototype.hasOwnProperty.call(dictionary, code)) {
      entry = dictionary[code];
    } else if (code === dictSize) {
      entry = word + word.charAt(0);
    } else {
      throw new Error('Erro ao descompactar campo unicode.');
    }

    result += entry;
    if (dictSize < 65000) {
      dictionary[dictSize++] = word + entry.charAt(0);
    } else {
      initDict();
      dictSize = 256;
    }
    word = entry;
  }

  const bytes = new Uint8Array(result.length);
  for (let i = 0; i < result.length; i++) bytes[i] = result.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseStoredArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    const raw = decompressStringUnicode(value);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

function derivePpcHistoryFromPlanning(planning) {
  const byWeek = new Map();
  planning.forEach(task => {
    if (!task || !task.finalized || !task.weekId) return;
    const weekId = String(task.weekId);
    byWeek.set(weekId, [...(byWeek.get(weekId) || []), task]);
  });

  return Array.from(byWeek.entries()).map(([weekId, tasks]) => {
    const plannedTasks = tasks.filter(t => (t.plannedThisWeek ?? 100) > 0);
    const completedTasks = plannedTasks.filter(t => (t.progressThisWeek ?? 0) >= (t.plannedThisWeek ?? 100));
    const ppc = plannedTasks.length > 0 ? (completedTasks.length / plannedTasks.length) * 100 : 0;
    return {
      weekId,
      weekStart: weekId,
      ppc,
      totalPlanned: plannedTasks.length,
      completed: completedTasks.length,
      recoveredFromPlanning: true
    };
  }).sort((a, b) => String(a.weekId).localeCompare(String(b.weekId)));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const docs = backup.docs || [];
const projectsDoc = docs.find(doc => doc.id === 'all_projects_metadata');
const projects = projectsDoc?.data?.list || [];

const restoredProjects = projects.map(project => {
  const metaDoc = docs.find(doc => doc.id === project.id);
  const planningDoc = docs.find(doc => doc.id === `${project.id}_planning`);
  const savedPpcHistory = parseStoredArray(metaDoc?.data?.ppcHistory);
  const planning = parseStoredArray(planningDoc?.data?.planning);
  const finalizedTasks = planning.filter(task => task?.finalized);
  const recoveredPpcHistory = derivePpcHistoryFromPlanning(planning);

  return {
    id: project.id,
    name: project.name,
    savedPpcCount: savedPpcHistory.length,
    planningTaskCount: planning.length,
    finalizedTaskCount: finalizedTasks.length,
    recoveredPpcCount: recoveredPpcHistory.length,
    savedPpcHistory,
    recoveredPpcHistory
  };
});

const payload = {
  generatedAt: new Date().toISOString(),
  sourceBackup: path.basename(backupPath),
  backupCreatedAt: backup.createdAt,
  firebaseProjectId: backup.firebaseProjectId,
  appId: backup.appId,
  collectionPath: backup.collectionPath,
  projects: restoredProjects
};

fs.mkdirSync(path.dirname(outputJsonPath), { recursive: true });
fs.writeFileSync(outputJsonPath, JSON.stringify(payload, null, 2), 'utf8');

const rows = restoredProjects.map(project => `
  <tr>
    <td>${escapeHtml(project.name)}<small>${escapeHtml(project.id)}</small></td>
    <td>${project.savedPpcCount}</td>
    <td>${project.planningTaskCount}</td>
    <td>${project.finalizedTaskCount}</td>
    <td>${project.recoveredPpcCount}</td>
  </tr>
`).join('');

const cards = restoredProjects.map(project => {
  const records = project.recoveredPpcHistory.length > 0 ? project.recoveredPpcHistory : project.savedPpcHistory;
  const body = records.length > 0
    ? records.map(record => `<li><strong>${escapeHtml(record.weekId || record.weekStart)}</strong>: ${Number(record.ppc || 0).toFixed(1)}% (${record.completed || 0}/${record.totalPlanned || 0})</li>`).join('')
    : '<li class="empty">Nenhum PPC salvo ou recuperavel neste backup.</li>';
  return `
    <section>
      <h2>${escapeHtml(project.name)} <span>${escapeHtml(project.id)}</span></h2>
      <ul>${body}</ul>
    </section>
  `;
}).join('');

fs.writeFileSync(outputHtmlPath, `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PPC restaurado</title>
  <style>
    body{font-family:Arial,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
    main{max-width:1100px;margin:0 auto;padding:32px}
    h1{font-size:24px;margin:0 0 8px}
    p{color:#475569}
    table{width:100%;border-collapse:collapse;background:white;border:1px solid #e2e8f0;margin:24px 0}
    th,td{padding:12px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:13px}
    th{background:#1e293b;color:white;text-transform:uppercase;font-size:11px}
    small{display:block;color:#64748b;margin-top:4px}
    section{background:white;border:1px solid #e2e8f0;margin:16px 0;padding:18px}
    h2{font-size:16px;margin:0 0 10px}
    h2 span{color:#64748b;font-size:12px}
    li{margin:6px 0}
    .empty{color:#b91c1c;font-weight:700}
    code{background:#e2e8f0;padding:2px 5px}
  </style>
</head>
<body>
  <main>
    <h1>Auditoria do PPC restaurado</h1>
    <p>Fonte: <code>${escapeHtml(path.basename(backupPath))}</code>, criado em <code>${escapeHtml(backup.createdAt)}</code>.</p>
    <p>O PPC foi reconstruido apenas quando havia tarefas finalizadas no planejamento do backup.</p>
    <table>
      <thead>
        <tr>
          <th>Projeto</th>
          <th>PPC salvo</th>
          <th>Tarefas planning</th>
          <th>Tarefas finalizadas</th>
          <th>Semanas recuperadas</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${cards}
  </main>
</body>
</html>`, 'utf8');

console.log(`JSON: ${outputJsonPath}`);
console.log(`HTML: ${outputHtmlPath}`);
