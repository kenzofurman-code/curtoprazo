import { exportAllLocalData, importLocalBackup, MAX_LOCAL_BACKUP_BYTES, parseLocalBackup } from './localDatabase';
import type { LocalBackup } from './localDatabase';
import { listVersionDocuments, LOCAL_VERSION_PREFIX, replaceVersionDocuments } from './scheduleVersionStorage';

export async function exportCompleteLocalBackup(): Promise<string> {
  const backup = parseLocalBackup(exportAllLocalData());
  for (const [key, value] of Object.entries(await listVersionDocuments())) backup.documents[key.slice('curtoprazo_local_db_'.length)] = value;
  const content = JSON.stringify(backup, null, 2);
  if (new TextEncoder().encode(content).length > MAX_LOCAL_BACKUP_BYTES) throw new Error('A cópia completa excede o limite de 25 MB para restauração de backups. Nenhum dado foi removido.');
  return content;
}
export async function importCompleteLocalBackup(backup: LocalBackup): Promise<void> {
  const valid = parseLocalBackup(JSON.stringify(backup));
  const documents = { ...valid.documents };
  const versions: Record<string, any[]> = Object.create(null);
  for (const [id, value] of Object.entries(documents)) {
    if (!id.startsWith('curtoprazo_schedule_versions_')) continue;
    if (value !== null && !Array.isArray(value)) throw new Error('A cópia contém um histórico de versões inválido.');
    versions['curtoprazo_local_db_' + id] = Array.isArray(value) ? value : [];
    delete documents[id];
  }
  const existing = Object.keys(versions).length ? await listVersionDocuments(LOCAL_VERSION_PREFIX) : {};
  await replaceVersionDocuments(versions);
  try { importLocalBackup({ ...valid, documents }); }
  catch (error) {
    await replaceVersionDocuments(Object.fromEntries(Object.keys(versions).map(key => [key, existing[key]])));
    throw error;
  }
}
