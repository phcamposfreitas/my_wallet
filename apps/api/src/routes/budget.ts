import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { registerCrud } from '../crud.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-\d{2}$/, 'Mês deve ser YYYY-MM');

export const accountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['checking', 'savings', 'credit_card', 'cash', 'brokerage', 'other']),
  institution: z.string().nullish(),
  initial_balance_cents: z.number().int().default(0),
  archived: z.boolean().default(false),
});

export const categorySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['expense', 'income']),
  color: z.string().nullish(),
});

export const transactionSchema = z.object({
  account_id: z.number().int().positive(),
  category_id: z.number().int().positive().nullish(),
  date,
  description: z.string().min(1),
  amount_cents: z.number().int().refine((v) => v !== 0, 'Valor não pode ser zero'),
  notes: z.string().nullish(),
});

/** Primeiro dia do mês seguinte, para filtros `date >= início AND date < fim`. */
function monthRange(m: string): [string, string] {
  const [y, mo] = m.split('-').map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  return [`${m}-01`, `${next}-01`];
}

export function budgetRoutes(app: FastifyInstance, db: DB) {
  // Contas com saldo atual (saldo inicial + soma dos lançamentos)
  app.get('/accounts', async () =>
    db
      .prepare(
        `SELECT a.*, a.initial_balance_cents + COALESCE(SUM(t.amount_cents), 0) AS balance_cents
         FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
         GROUP BY a.id ORDER BY a.archived, a.name`,
      )
      .all(),
  );
  registerCrud(app, db, { path: '/accounts', table: 'accounts', schema: accountSchema, orderBy: 'name', skipList: true });

  registerCrud(app, db, { path: '/categories', table: 'categories', schema: categorySchema, orderBy: 'kind, name' });

  const txQuery = z.object({
    month: month.optional(),
    account_id: z.coerce.number().int().optional(),
    category_id: z.coerce.number().int().optional(),
    q: z.string().optional(),
  });
  app.get('/transactions', async (req) => {
    const f = txQuery.parse(req.query);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.month) {
      const [start, end] = monthRange(f.month);
      where.push('t.date >= ? AND t.date < ?');
      args.push(start, end);
    }
    if (f.account_id) {
      where.push('t.account_id = ?');
      args.push(f.account_id);
    }
    if (f.category_id) {
      where.push('t.category_id = ?');
      args.push(f.category_id);
    }
    if (f.q) {
      where.push('t.description LIKE ?');
      args.push(`%${f.q}%`);
    }
    return db
      .prepare(
        `SELECT t.*, a.name AS account_name, c.name AS category_name, c.color AS category_color
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY t.date DESC, t.id DESC`,
      )
      .all(...args);
  });
  registerCrud(app, db, {
    path: '/transactions',
    table: 'transactions',
    schema: transactionSchema,
    orderBy: 'date DESC',
    skipList: true,
  });

  // Resumo do mês: receitas, despesas e despesas por categoria (transferências, como pagamento de fatura, ficam de fora)
  app.get('/summary/month', async (req) => {
    const { month: m } = z.object({ month }).parse(req.query);
    const [start, end] = monthRange(m);
    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN amount_cents > 0 THEN amount_cents END), 0) AS income_cents,
           COALESCE(-SUM(CASE WHEN amount_cents < 0 THEN amount_cents END), 0) AS expense_cents
         FROM transactions WHERE date >= ? AND date < ? AND kind = 'normal'`,
      )
      .get(start, end) as { income_cents: number; expense_cents: number };
    const byCategory = db
      .prepare(
        `SELECT c.id AS category_id, COALESCE(c.name, 'Sem categoria') AS name, c.color,
                -SUM(t.amount_cents) AS total_cents
         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
         WHERE t.date >= ? AND t.date < ? AND t.amount_cents < 0 AND t.kind = 'normal'
         GROUP BY c.id ORDER BY total_cents DESC`,
      )
      .all(start, end);
    return { month: m, ...totals, balance_cents: totals.income_cents - totals.expense_cents, by_category: byCategory };
  });

  // Agregado do ano: por mês, categoria, conta e estabelecimento, mais proventos recebidos.
  // Gastos por categoria/estabelecimento são líquidos (estornos abatem da própria categoria).
  app.get('/summary/year', async (req) => {
    const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.query);
    return yearSummary(db, year);
  });
}

/** Remove sufixos de parcela ("- Parcela 3/12", "18/21") para agrupar o mesmo estabelecimento. */
export function merchantKey(description: string): string {
  return description
    .replace(/\s*-\s*parcela\s*\d+\s*\/\s*\d+\s*$/i, '')
    .replace(/\s+\d{1,2}\/\d{1,2}\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toUpperCase();
}

export function yearSummary(db: DB, year: number) {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  const base = `FROM transactions t WHERE t.date >= ? AND t.date < ? AND t.kind = 'normal'`;

  const monthRows = db
    .prepare(
      `SELECT CAST(substr(t.date, 6, 2) AS INTEGER) AS m,
              COALESCE(-SUM(CASE WHEN t.amount_cents < 0 THEN t.amount_cents END), 0) AS expense_cents,
              COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS income_cents
       ${base} GROUP BY m`,
    )
    .all(start, end) as { m: number; expense_cents: number; income_cents: number }[];
  const months = Array.from({ length: 12 }, (_, i) => {
    const r = monthRows.find((x) => x.m === i + 1);
    return {
      month: `${year}-${String(i + 1).padStart(2, '0')}`,
      expense_cents: r?.expense_cents ?? 0,
      income_cents: r?.income_cents ?? 0,
    };
  });

  const catRows = db
    .prepare(
      `SELECT c.id AS category_id, COALESCE(c.name, 'Sem categoria') AS name, c.color,
              CAST(substr(t.date, 6, 2) AS INTEGER) AS m, -SUM(t.amount_cents) AS total_cents
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.date >= ? AND t.date < ? AND t.kind = 'normal' AND (c.kind IS NULL OR c.kind = 'expense')
       GROUP BY c.id, m`,
    )
    .all(start, end) as { category_id: number | null; name: string; color: string | null; m: number; total_cents: number }[];
  const catMap = new Map<string, { category_id: number | null; name: string; color: string | null; total_cents: number; monthly: number[] }>();
  for (const r of catRows) {
    const key = String(r.category_id);
    const c = catMap.get(key) ?? { category_id: r.category_id, name: r.name, color: r.color, total_cents: 0, monthly: Array(12).fill(0) };
    c.total_cents += r.total_cents;
    c.monthly[r.m - 1] += r.total_cents;
    catMap.set(key, c);
  }

  const byAccount = db
    .prepare(
      `SELECT a.id AS account_id, a.name, a.type,
              COALESCE(-SUM(CASE WHEN t.amount_cents < 0 THEN t.amount_cents END), 0) AS expense_cents,
              COALESCE(SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents END), 0) AS income_cents,
              COUNT(*) AS count
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       WHERE t.date >= ? AND t.date < ? AND t.kind = 'normal'
       GROUP BY a.id ORDER BY expense_cents DESC`,
    )
    .all(start, end);

  // Estabelecimentos: só gastos (valor líquido por estabelecimento), sem IOF/ajustes.
  const txs = db
    .prepare(`SELECT t.description, t.amount_cents ${base} AND t.description NOT LIKE 'IOF%' AND t.description NOT LIKE 'Ajuste de arredondamento%'`)
    .all(start, end) as { description: string; amount_cents: number }[];
  const merchants = new Map<string, { name: string; total_cents: number; count: number }>();
  for (const t of txs) {
    const k = merchantKey(t.description);
    const m = merchants.get(k) ?? { name: k, total_cents: 0, count: 0 };
    m.total_cents -= t.amount_cents;
    if (t.amount_cents < 0) m.count++;
    merchants.set(k, m);
  }

  const incomeRows = db
    .prepare(
      `SELECT CAST(substr(date, 6, 2) AS INTEGER) AS m, SUM(amount_cents) AS total
       FROM asset_income WHERE date >= ? AND date < ? GROUP BY m`,
    )
    .all(start, end) as { m: number; total: number }[];
  const investmentIncome = Array.from({ length: 12 }, (_, i) => incomeRows.find((r) => r.m === i + 1)?.total ?? 0);

  const expense = months.reduce((s, m) => s + m.expense_cents, 0);
  const income = months.reduce((s, m) => s + m.income_cents, 0);
  const monthsWithData = months.filter((m) => m.expense_cents > 0 || m.income_cents > 0).length;
  const uncategorized = catMap.get('null');

  return {
    year,
    totals: {
      expense_cents: expense,
      income_cents: income,
      net_expense_cents: expense - income,
      months_with_data: monthsWithData,
      monthly_avg_net_expense_cents: monthsWithData ? Math.round((expense - income) / monthsWithData) : 0,
      investment_income_cents: investmentIncome.reduce((s, v) => s + v, 0),
      uncategorized_cents: uncategorized?.total_cents ?? 0,
    },
    months: months.map((m, i) => ({ ...m, investment_income_cents: investmentIncome[i] })),
    by_category: [...catMap.values()].filter((c) => c.total_cents !== 0).sort((a, b) => b.total_cents - a.total_cents),
    by_account: byAccount,
    top_merchants: [...merchants.values()]
      .filter((m) => m.total_cents > 0)
      .sort((a, b) => b.total_cents - a.total_cents)
      .slice(0, 15),
  };
}
