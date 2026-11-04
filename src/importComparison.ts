export type ImportSnapshot = { versionId: string; items: { id: string; progress: number }[] };

export function snapshotImport(items: any[], versionId: string): ImportSnapshot {
  return { versionId, items: items.filter(item => item?.id).map(item => ({ id: item.id, progress: Number(item.progress) || 0 })) };
}

export function pendingComparisonDiffs(diffs: any[], versions: any[]) {
  const previous = versions.at(-2);
  const current = versions.at(-1);
  if (!previous?.id || !current?.previousVersionId || current.previousVersionId !== previous.id) return [];
  const byItem = new Map<string, any>();
  for (const diff of diffs) {
    if (!diff?.itemId || diff.importId !== current.id || diff.previousImportId !== previous.id ||
        Number(diff.delta) <= 0 || !Number.isFinite(Number(diff.delta))) continue;
    const existing = byItem.get(diff.itemId);
    if (!existing || String(diff.importedAt || '') >= String(existing.importedAt || '')) byItem.set(diff.itemId, diff);
  }
  return [...byItem.values()].filter(diff => !diff.appliedWeekId);
}
