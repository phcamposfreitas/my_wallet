export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { error?: string })?.error ?? res.statusText, res.status, data);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: (path: string) => request<void>('DELETE', path),
};

// ---- Tipos das respostas -------------------------------------------------

export interface Account {
  id: number;
  name: string;
  type: 'checking' | 'savings' | 'credit_card' | 'cash' | 'brokerage' | 'other';
  institution: string | null;
  initial_balance_cents: number;
  archived: number;
  balance_cents: number;
}

export interface Category {
  id: number;
  name: string;
  kind: 'expense' | 'income';
  color: string | null;
}

export interface Transaction {
  id: number;
  account_id: number;
  category_id: number | null;
  date: string;
  description: string;
  amount_cents: number;
  notes: string | null;
  account_name: string;
  category_name: string | null;
  category_color: string | null;
}

export interface MonthSummary {
  month: string;
  income_cents: number;
  expense_cents: number;
  balance_cents: number;
  by_category: { category_id: number | null; name: string; color: string | null; total_cents: number }[];
}

export interface Overview {
  cash_cents: number;
  investments_cents: number;
  net_worth_cents: number;
  last_snapshot: string | null;
}

export interface Position {
  asset_id: number;
  ticker: string;
  name: string | null;
  asset_class: string;
  sector: string | null;
  pays_cash: number;
  quantity: number | null;
  quantity_provenance: 'lido' | 'derivado' | 'inferido';
  avg_price_cents: number | null;
  price_cents: number | null;
  value_cents: number;
  cost_cents: number | null;
  broker_return_pct: number | null;
  maturity_date: string | null;
  income_cents: number;
  price_return_pct: number | null;
  total_return_pct: number | null;
}

export interface Portfolio {
  snapshots: { id: number; account_name: string; taken_at: string }[];
  positions: Position[];
  by_class: { asset_class: string; value_cents: number; cost_cents: number; income_cents: number; count: number; price_return_pct: number | null }[];
  balances: { kind: string; label: string; value_cents: number }[];
  totals: {
    positions_value_cents: number;
    positions_cost_cents: number;
    cash_cents: number;
    receivable_income_cents: number;
    total_cents: number;
    price_return_pct: number | null;
  };
  yield: null | {
    window_start: string;
    window_end: string;
    window_days: number;
    income_cents: number;
    annualized_pct_total: number | null;
    annualized_pct_cash_payers: number | null;
  };
}

export interface Snapshot {
  id: number;
  account_name: string;
  taken_at: string;
}

export interface SnapshotChange {
  asset_id: number;
  ticker: string;
  asset_class: string;
  kind: 'mercado' | 'compra' | 'venda' | 'evento_corporativo' | 'nova' | 'encerrada' | 'indefinido';
  factor: number | null;
  implied_price_cents: number | null;
  quantity_from: number | null;
  quantity_to: number | null;
  avg_price_from_cents: number | null;
  avg_price_to_cents: number | null;
  value_from_cents: number;
  value_to_cents: number;
  flow_cents: number;
  market_cents: number;
  market_pct: number | null;
}

export interface SnapshotComparison {
  from: Snapshot;
  to: Snapshot;
  totals: { value_from_cents: number; value_to_cents: number; flow_cents: number; market_cents: number };
  changes: SnapshotChange[];
}

export interface Income {
  id: number;
  asset_id: number;
  ticker: string;
  asset_class: string;
  date: string;
  type: string;
  amount_cents: number;
  base_quantity: number | null;
  value_per_unit: number | null;
  notes: string | null;
}

export interface ImportReport {
  file: string;
  status: 'importado' | 'ja_importado' | 'erro';
  details: string[];
}

export interface YearSummary {
  year: number;
  totals: {
    expense_cents: number;
    income_cents: number;
    net_expense_cents: number;
    months_with_data: number;
    monthly_avg_net_expense_cents: number;
    investment_income_cents: number;
    uncategorized_cents: number;
  };
  months: { month: string; expense_cents: number; income_cents: number; investment_income_cents: number }[];
  by_category: { category_id: number | null; name: string; color: string | null; total_cents: number; monthly: number[] }[];
  by_account: { account_id: number; name: string; type: string; expense_cents: number; income_cents: number; count: number }[];
  top_merchants: { name: string; total_cents: number; count: number }[];
}

export type PlanKind = 'fixo' | 'variavel' | 'parcelamento';

export interface PlanItem {
  id: number;
  year: number;
  name: string;
  category_id: number | null;
  category_name: string | null;
  color: string | null;
  kind: PlanKind;
  amount_cents: number;
  months: number[];
  match_pattern: string | null;
  notes: string | null;
  planned: number[];
  realized: number[];
  annual_cents: number;
  realized_cents: number;
}

export interface Plan {
  year: number;
  items: PlanItem[];
  totals: {
    annual_cents: number;
    monthly_avg_cents: number;
    monthly: number[];
    realized_monthly: number[];
    by_kind: Record<PlanKind, number>;
    by_category: { category: string; color: string | null; annual_cents: number }[];
  };
}

export interface PlanSuggestion {
  kind: PlanKind;
  name: string;
  match_pattern: string;
  category_id: number | null;
  category_name: string | null;
  amount_cents: number;
  months: number[];
  evidence: string;
}
