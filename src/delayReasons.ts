export const GENERAL_DELAY_REASONS = [
  'Chuva / Clima Impróprio',
  'Falta de Mão de Obra / Absenteísmo',
  'Atraso de Projeto ou Detalhe',
  'Falta de compatibilização nos projetos',
  'Falta de Material em Obra',
  'Problemas com equipamentos',
  'Serviço Anterior não Concluído',
  'Interferência com outros serviços',
  'Baixa produtividade',
  'Falta de terminalidade',
  'Mudança de prioridade',
  'Falha de planejamento'
];

export const DELAY_REASON_REGISTRY_ID = 'delay_reasons_registry';
export const DELAY_REASON_ALIASES: Record<string, string> = {
  'Dia improdutivo (chuva)': 'Chuva / Clima Impróprio',
  'Escassez de mão de obra': 'Falta de Mão de Obra / Absenteísmo',
  'Alteração / falta de projeto': 'Atraso de Projeto ou Detalhe',
  'Problemas com material': 'Falta de Material em Obra',
  'Atraso no fornecimento e entrega do canteiro de obras': 'Falta de Material em Obra',
  'Quebra de Equipamento / Ferramenta': 'Problemas com equipamentos',
  'Falta de equipamento': 'Problemas com equipamentos',
  'Pendente serviço antecessor': 'Serviço Anterior não Concluído',
  'Baixa produção': 'Baixa produtividade'
};

const reasonKey = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
const canonicalReasons = new Map([
  ...GENERAL_DELAY_REASONS.map(reason => [reasonKey(reason), reason] as const),
  ...Object.entries(DELAY_REASON_ALIASES).map(([alias, reason]) => [reasonKey(alias), reason] as const)
]);

export function normalizeDelayReason(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return canonicalReasons.get(reasonKey(trimmed)) || trimmed;
}

export function mergeDelayReasons(...lists: unknown[]): string[] {
  const unique = new Map<string, string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      if (typeof value !== 'string') continue;
      const reason = normalizeDelayReason(value);
      if (reason && !unique.has(reasonKey(reason))) unique.set(reasonKey(reason), reason);
    }
  }
  return [...unique.values()];
}

export function projectOnlyDelayReasons(reasons: unknown, generalReasons: unknown): string[] {
  const generalKeys = new Set(mergeDelayReasons(generalReasons).map(reasonKey));
  return mergeDelayReasons(reasons).filter(reason => !generalKeys.has(reasonKey(reason)));
}

// Only reason fields are renamed. Measurements, IDs, dates and free text stay intact.
export function normalizeDelayReasonFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeDelayReasonFields) as T;
  if (!value || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(delayReason|preFilledDelayReason|generalDelayReason)$/i.test(key) && typeof item === 'string'
      ? normalizeDelayReason(item)
      : normalizeDelayReasonFields(item)
  ])) as T;
}
