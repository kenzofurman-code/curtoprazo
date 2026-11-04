const pad = (value: number) => String(value).padStart(2, '0');

const calendarDate = (value: string) => {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const br = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!iso && !br) return null;
  const year = iso ? Number(iso[1]) : Number(br![3].length === 2 ? `20${br![3]}` : br![3]);
  const month = Number(iso ? iso[2] : br![2]);
  const day = Number(iso ? iso[3] : br![1]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : new Date(NaN);
};

const asDate = (value: string | number | Date) => {
  if (value instanceof Date) return new Date(value);
  return typeof value === 'string' ? calendarDate(value.trim()) ?? new Date(value) : new Date(value);
};

export const toLocalDateString = (value: string | number | Date = new Date()) => {
  const date = asDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const getTodayDateString = () => toLocalDateString(new Date());

export const parseExcelDate = (value: unknown, fallback = getTodayDateString()) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + Math.floor(value));
    if (Number.isNaN(epoch.getTime())) return fallback;
    return `${epoch.getUTCFullYear()}-${pad(epoch.getUTCMonth() + 1)}-${pad(epoch.getUTCDate())}`;
  }
  if (!(value instanceof Date) && typeof value !== 'string') return fallback;
  return toLocalDateString(value) || fallback;
};

export const formatDateBR = (value?: string | number | Date | null) => {
  if (value === undefined || value === null || value === '') return '';
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit'
  });
};

export const formatTimestamp = (value: any) => {
  if (!value) return '';
  const date = typeof value.toDate === 'function' ? value.toDate()
    : value.seconds !== undefined ? new Date(value.seconds * 1000) : asDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatDateBR(date)} ${date.toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  })}`;
};
