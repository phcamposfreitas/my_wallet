import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { registerCrud } from '../crud.ts';
import { computePosition, type TradeInput } from '../portfolio.ts';
import { buildPortfolio, compareSnapshots, listSnapshots } from '../snapshots.ts';
import { importXpFiles } from '../importers/xp.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser YYYY-MM-DD');

export const assetSchema = z.object({
  ticker: z.string().min(1).transform((s) => s.trim().toUpperCase()),
  name: z.string().nullish(),
  isin: z.string().nullish(),
  asset_class: z.enum(['acao', 'fii', 'etf', 'bdr', 'renda_fixa', 'tesouro', 'fundo', 'cripto', 'outro']),
  kind: z.string().nullish(),
  sector: z.string().nullish(),
  issuer: z.string().nullish(),
  maturity_date: date.nullish(),
  pays_cash: z.boolean().default(true),
});

/** Operações (notas de corretagem). Registro manual; a importação de notas vem depois. */
export const tradeSchema = z.object({
  account_id: z.number().int().positive(),
  asset_id: z.number().int().positive(),
  date,
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  price_cents: z.number().int().nonnegative(),
  fees_cents: z.number().int().nonnegative().default(0),
  notes: z.string().nullish(),
});

export const incomeSchema = z.object({
  account_id: z.number().int().positive(),
  asset_id: z.number().int().positive(),
  date,
  ex_date: date.nullish(),
  type: z.enum(['dividendo', 'jcp', 'rendimento_fii', 'rendimento_fundo', 'reembolso_evento', 'juros', 'amortizacao', 'outro']),
  amount_cents: z.number().int().positive(),
  base_quantity: z.number().positive().nullish(),
  value_per_unit: z.number().positive().nullish(),
  notes: z.string().nullish(),
});

class BadRequest extends Error {
  statusCode = 400;
}

export function investmentRoutes(app: FastifyInstance, db: DB) {
  registerCrud(app, db, { path: '/assets', table: 'assets', schema: assetSchema, orderBy: 'asset_class, ticker' });

  // --- Operações -----------------------------------------------------------
  // Garante que nenhuma venda deixe a posição negativa após inserir/editar/excluir.
  const tradesOf = db.prepare(
    'SELECT side, quantity, price_cents, fees_cents FROM trades WHERE asset_id = ? ORDER BY date, id',
  );
  const checkTrade = (row: Record<string, unknown>) => {
    try {
      computePosition(tradesOf.all(row.asset_id as number) as unknown as TradeInput[]);
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  };
  app.get('/trades', async () =>
    db
      .prepare(
        `SELECT t.*, s.ticker, a.name AS account_name
         FROM trades t JOIN assets s ON s.id = t.asset_id JOIN accounts a ON a.id = t.account_id
         ORDER BY t.date DESC, t.id DESC`,
      )
      .all(),
  );
  registerCrud(app, db, { path: '/trades', table: 'trades', schema: tradeSchema, orderBy: 'date DESC', skipList: true, check: checkTrade });

  // --- Proventos -----------------------------------------------------------
  app.get('/income', async (req) => {
    const f = z
      .object({ from: date.optional(), to: date.optional(), asset_id: z.coerce.number().int().optional() })
      .parse(req.query);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.from) (where.push('i.date >= ?'), args.push(f.from));
    if (f.to) (where.push('i.date <= ?'), args.push(f.to));
    if (f.asset_id) (where.push('i.asset_id = ?'), args.push(f.asset_id));
    return db
      .prepare(
        `SELECT i.*, s.ticker, s.asset_class FROM asset_income i JOIN assets s ON s.id = i.asset_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY i.date DESC, i.id DESC`,
      )
      .all(...args);
  });
  app.get('/income/monthly', async () =>
    db
      .prepare(
        `SELECT substr(date, 1, 7) AS month, type, SUM(amount_cents) AS amount_cents
         FROM asset_income GROUP BY month, type ORDER BY month`,
      )
      .all(),
  );
  registerCrud(app, db, { path: '/income', table: 'asset_income', schema: incomeSchema, orderBy: 'date DESC', skipList: true });

  // --- Carteira (snapshots) ------------------------------------------------
  app.get('/portfolio', async () => buildPortfolio(db));
  app.get('/snapshots', async () => listSnapshots(db));
  app.get('/snapshots/compare', async (req, reply) => {
    const q = z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() }).parse(req.query);
    const all = listSnapshots(db); // mais recente primeiro
    const to = q.to ?? all[0]?.id;
    const from = q.from ?? all.find((s) => s.id !== to)?.id;
    if (!from || !to) return reply.code(404).send({ error: 'São necessários ao menos dois snapshots' });
    return compareSnapshots(db, from, to);
  });

  app.get('/indicators', async () => db.prepare('SELECT * FROM indicators ORDER BY table_name, code').all());

  // --- Importação (conteúdo dos CSVs enviado pela interface) ----------------
  const importBody = z.object({ files: z.array(z.object({ name: z.string(), text: z.string() })).min(1) });
  app.post('/import/xp', { bodyLimit: 20 * 1024 * 1024 }, async (req) => importXpFiles(db, importBody.parse(req.body).files));
}
