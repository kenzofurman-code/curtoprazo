// Dry run: node scripts/migrate-delay-reasons.mjs
// Apply:   node scripts/migrate-delay-reasons.mjs --apply
// Backups include original Firestore field types and a rollback write plan.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { configstore } = require(resolve('node_modules/firebase-tools/lib/configstore.js'));
const api = require(resolve('node_modules/firebase-tools/lib/api.js'));
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React
}}).outputText;
const importTs = async path => import(`data:text/javascript;base64,${Buffer.from(compile(await readFile(path, 'utf8'))).toString('base64')}`);
const { GENERAL_DELAY_REASONS, DELAY_REASON_REGISTRY_ID, DELAY_REASON_ALIASES,
  mergeDelayReasons, projectOnlyDelayReasons, normalizeDelayReasonFields } = await importTs('src/delayReasons.ts');
const { resolvePayload, preparePayload } = await importTs('src/chunkedPayload.ts');
const source = await readFile('src/App.tsx', 'utf8');
const helpers = source.slice(source.indexOf('// --- Utilitários'), source.indexOf('// --- Configuração Firebase'));
const { decompressIfNeeded, compressStringUnicode } = new Function(`${compile(helpers)};return {decompressIfNeeded,compressStringUnicode};`)();

function decode(value) {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decode(item)]));
  throw new Error('Unsupported Firestore field type');
}
function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) } };
}

const firestoreProject = 'planejamento-semanal-piemonte';
const parent = `projects/${firestoreProject}/databases/(default)/documents/artifacts/obra-app/public/data/project_measurements`;
const previous = configstore.get('tokens');
const authResponse = await fetch(api.authOrigin() + '/o/oauth2/token', { method: 'POST', body: new URLSearchParams({
  client_id: api.clientId(), client_secret: api.clientSecret(), refresh_token: previous.refresh_token, grant_type: 'refresh_token'
}) });
const token = await authResponse.json();
if (!authResponse.ok || !token.access_token) throw new Error('Unable to refresh Firebase access');
configstore.set('tokens', { ...previous, ...token, expires_at: Date.now() + token.expires_in * 1000 });
async function request(path, options = {}) {
  const response = await fetch(`https://firestore.googleapis.com/v1/${path}`, { ...options,
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', ...options.headers }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || `Firestore HTTP ${response.status}`);
  return result;
}
async function readDocuments() {
  const result = new Map();
  let pageToken = '';
  do {
    const query = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await request(`${parent}?${query}`);
    for (const document of page.documents || []) result.set(document.name.split('/').pop(), document);
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return result;
}
const documents = await readDocuments();
const plain = new Map([...documents].map(([id, document]) => [id, decode({ mapValue: { fields: document.fields || {} } })]));
const listedProjects = plain.get('all_projects_metadata')?.list || [];
const projectIds = new Set([...listedProjects.map(project => project.id), ...[...plain].filter(([, data]) => Array.isArray(data.delayReasons)).map(([id]) => id)]);
const registry = plain.get(DELAY_REASON_REGISTRY_ID);
const general = mergeDelayReasons(GENERAL_DELAY_REASONS, registry?.reasons || []);
const writes = [], rollback = [], changes = [], newParts = new Map();
let renamedFields = 0;

function preserveOtherFields(before, after) {
  if (Array.isArray(before)) {
    assert.ok(Array.isArray(after)); assert.equal(after.length, before.length);
    before.forEach((value, index) => preserveOtherFields(value, after[index]));
  } else if (before && typeof before === 'object') {
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const key of Object.keys(before)) {
      if (/^(delayReason|preFilledDelayReason|generalDelayReason)$/i.test(key) && typeof before[key] === 'string') {
        if (before[key] !== after[key]) renamedFields++;
      } else preserveOtherFields(before[key], after[key]);
    }
  } else assert.deepEqual(after, before);
}
function patch(id, fields) {
  const previousDocument = documents.get(id);
  const keys = Object.keys(fields).filter(key => !previousDocument?.fields?.[key] || !isDeepStrictEqual(decode(previousDocument.fields[key]), decode(fields[key])));
  if (!keys.length) return;
  writes.push({ update: { name: `${parent}/${id}`, fields: Object.fromEntries(keys.map(key => [key, fields[key]])) },
    updateMask: { fieldPaths: keys }, currentDocument: previousDocument ? { updateTime: previousDocument.updateTime } : { exists: false }
  });
  rollback.push(previousDocument ? {
    update: { name: previousDocument.name, fields: Object.fromEntries(keys.filter(key => previousDocument.fields?.[key]).map(key => [key, previousDocument.fields[key]])) },
    updateMask: { fieldPaths: keys }
  } : { delete: `${parent}/${id}` });
  changes.push({ id, fields: keys });
}

patch(DELAY_REASON_REGISTRY_ID, { reasons: encode(general), aliases: encode(DELAY_REASON_ALIASES), schemaVersion: encode(1) });
for (const [id, data] of plain) {
  if (id.includes('_part_') || id === DELAY_REASON_REGISTRY_ID) continue;
  const updates = {};
  if (projectIds.has(id)) {
    const local = projectOnlyDelayReasons(data.projectDelayReasons ?? data.delayReasons ?? [], general);
    updates.projectDelayReasons = encode(local);
    updates.delayReasons = encode(mergeDelayReasons(general, local));
  }
  for (const [field, raw] of Object.entries(data)) {
    if (['planning', 'history', 'data'].includes(field)) {
      const resolved = await resolvePayload(raw, async part => plain.get(part)?.payload);
      const original = typeof resolved === 'string' ? JSON.parse(decompressIfNeeded(resolved)) : resolved;
      const normalized = normalizeDelayReasonFields(original);
      if (JSON.stringify(original) === JSON.stringify(normalized)) continue;
      preserveOtherFields(original, normalized);
      if (typeof resolved === 'string') {
        const prepared = await preparePayload(compressStringUnicode(JSON.stringify(normalized)), id);
        for (const part of prepared.chunks) {
          if (plain.has(part.id)) assert.equal(plain.get(part.id).payload, part.payload);
          else newParts.set(part.id, part.payload);
        }
        updates[field] = encode(prepared.value);
      } else updates[field] = encode(normalized);
    } else if (field !== 'delayReasons' && field !== 'projectDelayReasons') {
      const normalized = normalizeDelayReasonFields({ [field]: raw })[field];
      if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
        preserveOtherFields({ [field]: raw }, { [field]: normalized });
        updates[field] = encode(normalized);
      }
    }
  }
  patch(id, updates);
}
for (const [id, payload] of newParts) writes.unshift({ update: { name: `${parent}/${id}`, fields: { payload: encode(payload) } }, currentDocument: { exists: false } });
assert.ok(writes.length <= 500, 'Migration exceeds one atomic batch');
assert.ok(Buffer.byteLength(JSON.stringify({ writes })) < 8_000_000, 'Migration exceeds safe batch size');
const backup = join(process.env.USERPROFILE || process.env.HOME, '.codex', 'backups', `delay-reasons-migration-${Date.now()}`);
await mkdir(backup, { recursive: true });
await writeFile(join(backup, 'firestore-before.json'), JSON.stringify(Object.fromEntries(documents), null, 2));
await writeFile(join(backup, 'forward.json'), JSON.stringify({ writes }, null, 2));
await writeFile(join(backup, 'rollback.json'), JSON.stringify({ writes: rollback }, null, 2));
const report = { mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', backup, projectDocuments: projectIds.size,
  generalReasons: general, renamedFields, changes, writes: writes.length, newChunks: newParts.size };
await writeFile(join(backup, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!process.argv.includes('--apply')) process.exit(0);
if (writes.length) {
  // Preconditions abort the entire migration if any touched document changed after the backup.
  const result = await request(`projects/${firestoreProject}/databases/(default)/documents:commit`, { method: 'POST', body: JSON.stringify({ writes }) });
  await writeFile(join(backup, 'commit-result.json'), JSON.stringify(result, null, 2));
  const writeTimes = new Map(writes.map((write, index) => [write.update.name, result.writeResults[index].updateTime]));
  const rollbackWithPreconditions = rollback.map(write => ({ ...write, currentDocument: { updateTime: writeTimes.get(write.update?.name || write.delete) } }));
  await writeFile(join(backup, 'rollback.json'), JSON.stringify({ writes: rollbackWithPreconditions }, null, 2));
}
const afterDocuments = await readDocuments();
const allowed = new Map(changes.map(change => [change.id, new Set(change.fields)]));
for (const [id, before] of documents) {
  const after = afterDocuments.get(id);
  assert.ok(after, `Existing document removed: ${id}`);
  for (const [field, value] of Object.entries(before.fields || {})) {
    if (!allowed.get(id)?.has(field)) assert.deepEqual(after.fields[field], value, `Unrelated field changed: ${id}.${field}`);
  }
}
for (const write of writes) {
  const after = afterDocuments.get(write.update.name.split('/').pop());
  for (const [field, value] of Object.entries(write.update.fields)) assert.deepEqual(decode(after.fields[field]), decode(value), `Readback mismatch: ${field}`);
}
for (const id of projectIds) {
  const document = afterDocuments.get(id);
  const reasons = decode(document.fields.delayReasons);
  assert.ok(GENERAL_DELAY_REASONS.every(reason => reasons.includes(reason)), `Missing general reason: ${id}`);
}
await writeFile(join(backup, 'verification.json'), JSON.stringify({ verified: true, existingDocumentsPreserved: documents.size,
  projectDocuments: projectIds.size, renamedFields, commitAtomic: true, unrelatedFieldsUnchanged: true }, null, 2));
console.log(JSON.stringify({ stage: 'verified', backup, existingDocumentsPreserved: documents.size, projectDocuments: projectIds.size, renamedFields }));
