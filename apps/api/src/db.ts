import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Convenções do banco:
 * - Valores monetários em centavos (INTEGER) para evitar erros de ponto flutuante.
 * - Datas como texto ISO 'YYYY-MM-DD'.
 * - transactions.amount_cents tem sinal: negativo = saída, positivo = entrada.
 * - Quantidade de ativos é REAL (frações de cotas, cripto etc.).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('checking','savings','credit_card','cash','brokerage','other')),
    institution TEXT,
    initial_balance_cents INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
    color TEXT,
    UNIQUE (name, kind)
  );

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    filename TEXT,
    file_hash TEXT UNIQUE,                -- impede importar o mesmo arquivo duas vezes
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    notes TEXT,
    import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
    external_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, external_id)
  );
  CREATE INDEX idx_transactions_date ON transactions(date);

  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    ticker TEXT NOT NULL UNIQUE,          -- código B3, ou nome do título/fundo quando não há ticker
    name TEXT,
    isin TEXT UNIQUE,                     -- necessário para casar "reembolso de evento" do extrato
    isin_source TEXT,                     -- proveniência do ISIN (ex.: 'extrato')
    asset_class TEXT NOT NULL CHECK (asset_class IN ('acao','fii','etf','bdr','renda_fixa','tesouro','fundo','cripto','outro')),
    kind TEXT,                            -- ON, PN, FII, BDR, FIC...
    sector TEXT,
    issuer TEXT,
    maturity_date TEXT,
    -- Títulos sem cupom (LFT, LTN, NTN-B Principal) não geram caixa até o resgate:
    -- entram no denominador do yield, nunca no numerador.
    pays_cash INTEGER NOT NULL DEFAULT 1
  );

  -- Snapshot de posição: uma "foto" da carteira numa data. Append-only:
  -- coletar de novo gera outro snapshot; o mais recente vence na leitura.
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    taken_at TEXT NOT NULL,               -- 'YYYY-MM-DD HH:MM'
    source TEXT NOT NULL,
    import_id INTEGER REFERENCES imports(id),
    UNIQUE (account_id, taken_at)
  );

  CREATE TABLE snapshot_positions (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    quantity REAL,
    quantity_provenance TEXT NOT NULL DEFAULT 'lido' CHECK (quantity_provenance IN ('lido','derivado','inferido')),
    avg_price_cents INTEGER,
    price_cents INTEGER,
    value_cents INTEGER NOT NULL,
    cost_cents INTEGER,
    broker_return_pct REAL,               -- coluna da corretora: NÃO homogênea entre classes, só referência
    notes TEXT,
    PRIMARY KEY (snapshot_id, asset_id)
  );

  -- Saldos que não são posição em ativo: caixa disponível, proventos a receber.
  CREATE TABLE snapshot_balances (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('caixa','proventos_a_receber')),
    label TEXT NOT NULL,
    value_cents INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, kind, label)
  );

  -- Vocabulário controlado de indicadores (formato longo).
  CREATE TABLE indicators (
    table_name TEXT NOT NULL,
    code TEXT NOT NULL,
    unit TEXT,
    description TEXT,
    PRIMARY KEY (table_name, code)
  );

  CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    date TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy','sell')),
    quantity REAL NOT NULL CHECK (quantity > 0),
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    fees_cents INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_trades_asset ON trades(asset_id, date);

  -- Proventos efetivamente pagos (fonte: extrato da conta corrente, não a tela da carteira).
  CREATE TABLE asset_income (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    asset_id INTEGER NOT NULL REFERENCES assets(id),
    date TEXT NOT NULL,                   -- data de pagamento
    ex_date TEXT,                         -- data com
    type TEXT NOT NULL CHECK (type IN ('dividendo','jcp','rendimento_fii','rendimento_fundo','reembolso_evento','juros','amortizacao','outro')),
    amount_cents INTEGER NOT NULL,
    base_quantity REAL,                   -- pode ser menor que a posição (ações emprestadas)
    value_per_unit REAL,
    source TEXT,
    notes TEXT,
    import_id INTEGER REFERENCES imports(id) ON DELETE SET NULL
  );
  CREATE INDEX idx_income_asset ON asset_income(asset_id, date);

  CREATE TABLE prices (
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    PRIMARY KEY (asset_id, date)
  );
  `,
  // v2: faturas de cartão de crédito
  `
  -- Uma fatura mensal de cartão. Regra de conciliação (exigida na importação):
  -- previous_balance − payments + Σ lançamentos = total.
  CREATE TABLE statements (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    closing_date TEXT,                    -- data de fechamento
    due_date TEXT NOT NULL,               -- vencimento (identifica a fatura)
    total_cents INTEGER NOT NULL,         -- total a pagar
    previous_balance_cents INTEGER NOT NULL DEFAULT 0,
    payments_cents INTEGER NOT NULL DEFAULT 0,
    minimum_payment_cents INTEGER,
    source TEXT,                          -- ex.: 'gmail:<message-id>'
    extracted_by TEXT,                    -- ex.: 'claude' ou 'manual'
    notes TEXT,
    import_id INTEGER REFERENCES imports(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, due_date)
  );

  -- 'transfer' (ex.: pagamento de fatura) entra no saldo da conta, mas não é gasto nem receita.
  ALTER TABLE transactions ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','transfer'));
  ALTER TABLE transactions ADD COLUMN statement_id INTEGER REFERENCES statements(id) ON DELETE CASCADE;
  ALTER TABLE transactions ADD COLUMN installment_number INTEGER;
  ALTER TABLE transactions ADD COLUMN installment_total INTEGER;
  ALTER TABLE transactions ADD COLUMN original_amount REAL;      -- compras internacionais
  ALTER TABLE transactions ADD COLUMN original_currency TEXT;
  ALTER TABLE transactions ADD COLUMN card_last4 TEXT;           -- cartão adicional/virtual
  CREATE INDEX idx_transactions_statement ON transactions(statement_id);
  `,
  // v3: regras de categorização por estabelecimento
  `
  -- "pattern" é comparado (sem acento, maiúsculas) como trecho da descrição.
  -- Em caso de mais de uma regra casar, vence o padrão mais longo (mais específico).
  CREATE TABLE category_rules (
    id INTEGER PRIMARY KEY,
    pattern TEXT NOT NULL UNIQUE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v4: planejamento de gastos (itens previstos por ano)
  `
  CREATE TABLE plan_items (
    id INTEGER PRIMARY KEY,
    year INTEGER NOT NULL,
    name TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'fixo' CHECK (kind IN ('fixo','variavel','parcelamento')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), -- valor previsto por mês em que incide
    months TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7,8,9,10,11,12]', -- JSON: meses em que incide
    match_pattern TEXT,   -- trecho da descrição para comparar com o realizado
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_plan_items_year ON plan_items(year);
  `,
];

const DEFAULT_CATEGORIES: Array<[string, 'expense' | 'income', string]> = [
  ['Moradia', 'expense', '#b45309'],
  ['Alimentação', 'expense', '#f97316'],
  ['Mercado', 'expense', '#eab308'],
  ['Transporte', 'expense', '#0ea5e9'],
  ['Saúde', 'expense', '#ef4444'],
  ['Educação', 'expense', '#14b8a6'],
  ['Lazer', 'expense', '#ec4899'],
  ['Assinaturas', 'expense', '#6366f1'],
  ['Compras', 'expense', '#a855f7'],
  ['Impostos e taxas', 'expense', '#64748b'],
  ['Seguros', 'expense', '#0369a1'],
  ['Consórcio', 'expense', '#0f766e'],
  ['Outros gastos', 'expense', '#94a3b8'],
  ['Salário', 'income', '#22c55e'],
  ['Freelance', 'income', '#10b981'],
  ['Outras receitas', 'income', '#84cc16'],
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      if (v === 0) seed(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function seed(db: DB) {
  const insert = db.prepare('INSERT INTO categories (name, kind, color) VALUES (?, ?, ?)');
  for (const [name, kind, color] of DEFAULT_CATEGORIES) insert.run(name, kind, color);
}
