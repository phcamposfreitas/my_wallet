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
}
