import { CLOUD_DOCUMENT_EVENT, mutateFirebaseDocument, readFirebaseDocument } from './firebaseDocuments';
export const VERSION_HISTORY_EVENT = CLOUD_DOCUMENT_EVENT;
export const versionStorageKey = (projectId: string) => 'curtoprazo_schedule_versions_' + (projectId || 'projeto_principal');
function versions(value: any): any[] {
  if (value === null || value === undefined) return [];
  // Accept earlier Firestore exports as well as the packed cloud document format.
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.versions)) return value.versions;
  throw new Error('O histórico de versões do Firebase está inválido. Nenhum dado foi substituído.');
}
export async function readVersionList(key: string): Promise<any[]> {
  return versions(await readFirebaseDocument(key));
}
export async function updateVersionList(key: string, update: (current: any[]) => any[]): Promise<any[]> {
  return mutateFirebaseDocument(key, previous => update(versions(previous)));
}
export async function initializeVersionList(key: string, initial: any): Promise<any[]> {
  // An explicitly emptied history must stay empty after deleting its last version.
  return mutateFirebaseDocument(key, previous => previous == null ? [initial] : versions(previous));
}
