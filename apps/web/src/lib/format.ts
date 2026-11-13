const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const num = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 });

export const money = (cents: number | null | undefined) => (cents == null ? '—' : brl.format(cents / 100));
export const qty = (n: number | null | undefined) => (n == null ? '—' : num.format(n));
export const pct = (v: number | null | undefined, digits = 2, signed = true) =>
  v == null ? '—' : `${signed && v > 0 ? '+' : ''}${v.toFixed(digits).replace('.', ',')}%`;

export const date = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

export const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** Data local (não UTC: à noite no Brasil o UTC já é o dia seguinte). */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const currentMonth = () => today().slice(0, 7);

export function shiftMonth(ym: string, delta: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** "1.234,56" ou "1234.56" → centavos. */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const signClass = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');

export const ASSET_CLASS_LABEL: Record<string, string> = {
  acao: 'Ações',
  fii: 'FIIs',
  etf: 'ETFs',
  bdr: 'BDRs',
  renda_fixa: 'Renda fixa',
  tesouro: 'Tesouro Direto',
  fundo: 'Fundos',
  cripto: 'Cripto',
  outro: 'Outros',
};

export const INCOME_TYPE_LABEL: Record<string, string> = {
  dividendo: 'Dividendo',
  jcp: 'JCP',
  rendimento_fii: 'Rendimento FII',
  rendimento_fundo: 'Rendimento fundo',
  reembolso_evento: 'Reembolso de evento',
  juros: 'Juros',
  amortizacao: 'Amortização',
  outro: 'Outro',
};

export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  checking: 'Conta corrente',
  savings: 'Poupança',
  credit_card: 'Cartão de crédito',
  cash: 'Dinheiro',
  brokerage: 'Corretora',
  other: 'Outra',
};
