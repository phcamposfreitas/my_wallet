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
  /** 0 = registra gastos, mas o saldo não entra no patrimônio. */
  in_net_worth: number;
  balance_cents: number;
}

export interface SharedCost {
  id: number;
  name: string;
  match_pattern: string;
  people: number;
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
  /** Despesas da casa rateadas no mês e o reembolso dos outros moradores (já somado em income_cents). */
  shared_expense_cents: number;
  reimbursement_cents: number;
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

export interface ContributionYear {
  year: string;
  in_cents: number;
  out_cents: number;
  abroad_cents: number;
  net_cents: number;
  cumulative_net_cents: number;
  /** Notas de negociação + subscrições e exercícios de opção. */
  bought_cents: number;
  /** Notas de negociação + frações e resgates de renda variável. */
  sold_cents: number;
  /** Tesouro, fundos e CDB. */
  applied_cents: number;
  redeemed_cents: number;
  /** IR, IOF, taxas e derivativos (negativo = custo). */
  costs_cents: number;
  income_cents: number;
  movements: { kind: string; product: string; ticker: string | null; description: string; amount_cents: number; count: number }[];
}

export interface Portfolio {
  /** Entradas e saídas de dinheiro da corretora até a última coleta; null sem fluxos importados. */
  contributions: null | {
    deposits_cents: number;
    withdrawals_cents: number;
    cashback_cents: number;
    /** Enviado ao exterior: continua investido, fora desta conta. */
    abroad_cents: number;
    /** Aportes + cashback − retiradas. */
    net_cents: number;
    net_in_account_cents: number;
    /** Patrimônio da corretora − o que ficou nela (net − exterior). */
    gain_cents: number;
    first_date: string;
    last_date: string;
    /** Por ano: dinheiro que entrou e saiu, compras e vendas, aplicações e resgates sem nota, custos e proventos. */
    by_year: ContributionYear[];
  };
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
    /** Data do primeiro provento registrado (início do histórico, não da janela do yield). */
    income_history_start: string;
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

export interface Trade {
  id: number;
  asset_id: number;
  ticker: string;
  account_name: string;
  date: string;
  side: 'buy' | 'sell';
  quantity: number;
  price_cents: number;
  fees_cents: number;
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
    reimbursement_cents: number;
    net_expense_cents: number;
    months_with_data: number;
    monthly_avg_net_expense_cents: number;
    investment_income_cents: number;
    uncategorized_cents: number;
  };
  months: { month: string; expense_cents: number; income_cents: number; reimbursement_cents: number; investment_income_cents: number }[];
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
  direction: 'expense' | 'income';
  source: 'proventos' | null;
  amount_cents: number;
  months: number[];
  match_pattern: string | null;
  notes: string | null;
  planned: number[];
  realized: number[];
  annual_cents: number;
  realized_cents: number;
  /** Moradores que dividem o gasto (null = só do titular). */
  shared_people: number | null;
}

export interface PlanReimbursement {
  name: string;
  items: { name: string; people: number; annual_cents: number }[];
  shared_expense_annual_cents: number;
  planned: number[];
  realized: number[];
  annual_cents: number;
  realized_cents: number;
}

export interface Plan {
  year: number;
  items: PlanItem[];
  income_items: PlanItem[];
  reimbursement: PlanReimbursement | null;
  totals: {
    income_annual_cents: number;
    income_monthly: number[];
    income_realized_monthly: number[];
    balance_monthly: number[];
    balance_annual_cents: number;
    annual_cents: number;
    monthly_avg_cents: number;
    monthly: number[];
    realized_monthly: number[];
    by_kind: Record<PlanKind, number>;
    by_category: { category: string; color: string | null; annual_cents: number }[];
  };
}

export interface IncomeEstimate {
  amount_cents: number;
  months_used: number;
  evidence: string;
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

export interface ThesisAsset {
  asset_id: number;
  ticker: string;
  name: string | null;
  asset_class: string;
  value_cents: number;
  cost_cents: number | null;
  weight_pct: number | null;
  price_return_pct: number | null;
  income_12m_cents: number;
  income_total_cents: number;
  pays_cash: number;
}

export interface ThesisGroup {
  assets: ThesisAsset[];
  value_cents: number;
  cost_cents: number;
  weight_pct: number | null;
  price_return_pct: number | null;
  income_12m_cents: number;
  income_total_cents: number;
}

export interface Thesis extends ThesisGroup {
  id: string;
  title: string;
  status: string;
  block: string | null;
  owner: string | null;
  created_on: string | null;
  last_review: string | null;
  next_review: string | null;
  origin: string | null;
  file: string;
  tickers_without_position: string[];
}

export interface ThesesAsOf {
  snapshot: string | null;
  income_until: string | null;
  income_12m_from: string | null;
}

export interface ThesisBlock {
  /** null = teses que não declaram bloco. */
  name: string | null;
  theses: string[];
  assets_count: number;
  in_review: number;
  value_cents: number;
  cost_cents: number;
  weight_pct: number | null;
  price_return_pct: number | null;
  income_12m_cents: number;
}

export interface Theses {
  available: boolean;
  as_of: ThesesAsOf;
  total_cents: number;
  theses: Thesis[];
  blocks: ThesisBlock[];
  unassigned: ThesisGroup;
  duplicated: { ticker: string; theses: string[] }[];
}

interface CorrelationTable {
  rows: { key: string; label: string; coverage_pct: number; without_price: string[]; points: number }[];
  columns: { key: string; label: string; ref: boolean }[];
  /** Linha por `rows`, coluna por `columns`. null = semanas insuficientes. */
  matrix: (number | null)[][];
  matrix_calm: (number | null)[][];
  excluded: { key: string; label: string; reason: string }[];
}

export type Correlation =
  | { available: false; reason: string }
  | {
      available: true;
      weeks: number;
      from: string;
      to: string;
      snapshot: string | null;
      coverage_pct: number;
      shock_weeks: { week_ending: string; market_pct: number }[];
      theses: CorrelationTable;
      blocks: CorrelationTable;
    };

export interface ThesisDetail extends Thesis {
  body: string;
  income: ThesisIncome | null;
  as_of: ThesesAsOf;
  total_cents: number;
}

export interface ActionItem {
  id: number;
  due_date: string;
  title: string;
  detail: string | null;
  kind: 'acao' | 'info';
  thesis_id: string | null;
  asset_id: number | null;
  ticker: string | null;
  source: string | null;
  status: 'aberto' | 'feito' | 'descartado';
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface ThesesIncome {
  months: string[];
  income_until: string | null;
  series: { key: string; label: string; monthly: number[]; total_12m_cents: number }[];
  total_monthly: number[];
  avg_3m_cents: number;
  avg_12m_cents: number;
  coverage: { months: string[]; income_avg_cents: number; expense_avg_cents: number; pct: number | null } | null;
}

export interface ThesisIncome {
  months: string[];
  income_until: string;
  assets: {
    ticker: string;
    monthly: number[];
    per_unit: (number | null)[];
    flags: ('corte' | 'sem_pagamento' | null)[];
    total_cents: number;
    yield_on_price_pct: number | null;
    yield_on_cost_pct: number | null;
  }[];
  total_monthly: number[];
  avg_3m_cents: number;
  signals: { ticker: string; month: string; kind: 'corte' | 'sem_pagamento'; per_unit: number | null }[];
}

export type PolicyStatus = 'dentro' | 'acima' | 'abaixo' | 'sem_regra';

export interface PolicyView {
  available: boolean;
  as_of: { snapshot: string | null };
  total_cents: number;
  policy?: { status: string; approved: boolean; approved_on: string | null; next_review: string | null; monthly_contribution_cents: number | null };
  body?: string;
  allocation?: {
    key: string;
    label: string;
    value_cents: number;
    current_pct: number;
    target_pct: number | null;
    band_pct: number | null;
    deviation_pct: number | null;
    to_target_cents: number | null;
    status: PolicyStatus;
  }[];
  limits?: {
    key: string;
    label: string;
    scope: 'cada' | 'soma';
    cap_pct: number | null;
    current_pct: number;
    headroom_pct: number | null;
    status: PolicyStatus;
    over: { name: string; current_pct: number }[];
    members: string[];
    note: string | null;
  }[];
  factors?: { key: string; label: string; value_cents: number; current_pct: number; count: number }[];
  blocked?: { ticker: string; thesis: string | null; current_pct: number; reasons: string[] }[];
  room?: {
    id: string;
    title: string;
    status: string;
    group: string;
    group_label: string;
    group_status: PolicyStatus;
    current_pct: number;
    room_pct: number | null;
    room_cents: number | null;
    limited_by: string | null;
    assets: { ticker: string; current_pct: number; room_pct: number | null; room_cents: number | null; limited_by: string | null }[];
    blocked_assets: string[];
  }[];
  tail?: { count: number; current_pct: number; without_thesis: string[] };
  reserve?: { value_cents: number; current_pct: number; tickers: string[] };
  tolerance?: {
    nada?: number;
    rebalancear?: number;
    drawdown: { pct: number; peak_at: string; as_of: string; source: 'cotacoes' | 'coletas'; points: number; window_days: number } | null;
    action: 'nada' | 'rebalancear' | 'reduzir_risco' | null;
  };
}

export interface Performance {
  available: boolean;
  reason?: string;
  from: string;
  to: string;
  snapshots: string[];
  dates: string[];
  series: Record<'price' | 'total' | 'cdi' | 'ibovespa' | 'ifix', (number | null)[]>;
  references: PerformanceReference[];
  groups: PerformanceGroup[];
  stats: { compare: { key: string; label: string } | null; rows: RiskRow[] };
  summary: {
    price_pct: number | null;
    total_pct: number | null;
    cdi_pct: number | null;
    ibovespa_pct: number | null;
    ifix_pct: number | null;
    max_drawdown: { pct: number; peak_date: string; trough_date: string };
    unpriced_pct: number;
  };
  last_session: {
    date: string;
    previous: string;
    week_from: string;
    change_cents: number;
    change_pct: number | null;
    assets: {
      ticker: string;
      thesis: string | null;
      price_cents: number;
      value_cents: number;
      day_pct: number | null;
      week_pct: number | null;
      day_change_cents: number;
    }[];
    without_quote: string[];
  };
}

export interface PerformanceReference {
  key: string;
  label: string;
  ticker: string | null;
  note: string;
  source: 'embutida' | 'arquivo';
  kind: 'serie' | 'composicao';
  values: (number | null)[];
  pct: number | null;
  first_date: string | null;
  /** Só nas composições: cada rebalanceamento simulado e a parte do peso que tinha cotação. */
  rebalances: { from: string; on: string; priced_pct: number; missing: string[] }[] | null;
}

export interface RiskRow {
  key: string;
  label: string;
  kind: 'carteira' | 'tese' | 'bloco' | 'referencia';
  days: number;
  vol_pct: number | null;
  beta: number | null;
  correlation: number | null;
  tracking_error_pct: number | null;
  months: number;
  months_beat: number;
}

export interface PerformanceGroup {
  key: string;
  label: string;
  kind: 'tese' | 'bloco';
  block: string | null;
  references: string[];
  price: (number | null)[];
  total: (number | null)[];
  summary: {
    price_pct: number | null;
    total_pct: number | null;
    max_drawdown: { pct: number; peak_date: string; trough_date: string };
    unpriced_pct: number;
    first_date: string | null;
  };
}

export interface References {
  as_of: string | null;
  series: { key: string; label: string; ticker: string | null; note: string; source: string }[];
  compositions: {
    key: string;
    label: string;
    source_name: string | null;
    url: string | null;
    file: string;
    version: { from: string; assets: number; weights: { ticker: string; weight_pct: number }[] } | null;
    versions: string[];
    classes: string[];
    not_held: { ticker: string; weight_pct: number }[];
    warnings: string[];
    rows: {
      key: string;
      label: string;
      kind: 'carteira' | 'tese' | 'bloco';
      declared: boolean;
      active_share_pct: number | null;
      common: { ticker: string; group_pct: number; ref_pct: number }[];
    }[];
  }[];
  warnings: string[];
}

export interface ThesesMap {
  available: boolean;
  updated_on?: string | null;
  base?: string | null;
  author?: string | null;
  last_snapshot?: string | null;
  stale?: boolean;
  files?: Record<string, string>;
  body?: string;
}
