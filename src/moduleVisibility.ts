export const APP_MODULES = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊', fullLabel: 'Painel e Indicadores' },
  { id: 'planning', label: 'Semanal', icon: '📅', fullLabel: 'Planejamento Semanal e Metas' },
  { id: 'config', label: 'Configurações', icon: '⚙️', fullLabel: 'Configurações e Acessos' },
  { id: 'calendar', label: 'Calendário', icon: '🗓️', fullLabel: 'Calendário do Projeto e Dias Úteis' },
  { id: 'versions', label: 'Versões Crono', icon: '🏷️', fullLabel: 'Versões de Cronograma e Linha de Base' },
  { id: 'lob', label: 'Linha de Balanço', icon: '📐', fullLabel: 'Linha de Balanço (Longo Prazo)' },
  { id: 'table', label: 'Gantt', icon: '📋', fullLabel: 'Cronograma Gantt & EAP' },
  { id: 'budget', label: 'Orçamento & Vínculos', icon: '💰', fullLabel: 'Orçamento, Contas e Vínculos' },
  { id: 'physical_financial', label: 'Físico-Financ.', icon: '📈', fullLabel: 'Curva S e Replanejamento Físico-Financeiro' },
  { id: 'competence_cash', label: 'Competência & Caixa', icon: '💵', fullLabel: 'Competência Teórica e Fluxo de Caixa' },
  { id: 'import', label: 'Importação de cronograma', icon: '📥', fullLabel: 'Importação de cronograma' }
] as const;
export type ModuleId = typeof APP_MODULES[number]['id'];
export type ModuleVisibility = Record<ModuleId, boolean>;
export const DEFAULT_MODULE_VISIBILITY: ModuleVisibility = Object.fromEntries(APP_MODULES.map(module => [module.id, ['dashboard', 'planning', 'config'].includes(module.id)])) as ModuleVisibility;
const aliases: Record<string, ModuleId> = {
  'cronograma-inicial': 'table', visualization: 'dashboard', 'detalhamento-ppc': 'dashboard', 'historico-andamento': 'dashboard'
};
export function normalizeModuleVisibility(value: unknown): ModuleVisibility {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(APP_MODULES.map(module => [module.id, typeof source[module.id] === 'boolean' ? source[module.id] : DEFAULT_MODULE_VISIBILITY[module.id]])) as ModuleVisibility;
}
export function canAccessModule(id: string, visibility: ModuleVisibility, isAdmin: boolean): boolean {
  const moduleId = aliases[id] || id;
  return APP_MODULES.some(module => module.id === moduleId) && (isAdmin || visibility[moduleId] === true);
}
export function resolveVisibleTab(requested: string, visibility: ModuleVisibility, isAdmin: boolean): string | null {
  if (requested !== 'import' && canAccessModule(requested, visibility, isAdmin)) return requested;
  return APP_MODULES.find(module => module.id !== 'import' && canAccessModule(module.id, visibility, isAdmin))?.id || null;
}

type VisibilityAdapter = {
  watch: (path: string, receive: (data: any) => void, fail: (error: unknown) => void) => () => void;
  write: (path: string, data: any, options: { merge: boolean }) => Promise<void>;
};
export function createModuleVisibilityStore(adapter: VisibilityAdapter, appId: string) {
  const path = `artifacts/${appId}/public/data/project_measurements/module_visibility`;
  return {
    subscribe: (receive: (visibility: ModuleVisibility) => void, fail: (error: unknown) => void) =>
      adapter.watch(path, data => receive(normalizeModuleVisibility(data?.visibleModules)), fail),
    save: async (visibility: ModuleVisibility, isAdmin: boolean, author: string) => {
      if (!isAdmin) throw new Error('Autentique-se no painel de administrador para alterar os módulos.');
      await adapter.write(path, { visibleModules: normalizeModuleVisibility(visibility), updatedBy: author, updatedAt: new Date().toISOString() }, { merge: true });
    }
  };
}
