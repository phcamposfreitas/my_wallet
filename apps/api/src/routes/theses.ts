import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { idParam } from '../crud.ts';
import { buildTheses, readMap, thesesIncome, thesisDetail } from '../theses.ts';
import { yearSummary } from './budget.ts';
import { buildPolicy } from '../policy.ts';
import { buildPerformance } from '../performance.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve ser YYYY-MM-DD');

/**
 * Prazos do titular: o que exige ação dele até uma data (`acao`) e eventos só informativos
 * (`info`). Um prazo só sai da lista quando o titular dá baixa; vencido continua aparecendo.
 */
const itemSchema = z.object({
  due_date: date,
  title: z.string().trim().min(1),
  detail: z.string().nullish(),
  kind: z.enum(['acao', 'info']).default('acao'),
  thesis_id: z.string().trim().min(1).nullish(),
  /** Código do ativo no cadastro; a rota resolve para asset_id. */
  ticker: z.string().trim().min(1).nullish(),
  source: z.string().nullish(),
});
const patchSchema = itemSchema.partial().extend({
  status: z.enum(['aberto', 'feito', 'descartado']).optional(),
  resolution_note: z.string().nullish(),
});

export function thesisRoutes(app: FastifyInstance, db: DB, opts: { researchDir?: string }) {
  const dir = opts.researchDir ? `${opts.researchDir}/teses` : undefined;

  app.get('/theses', async () => buildTheses(db, dir));

  // Política de investimentos comparada com a última coleta.
  app.get('/policy', async () => buildPolicy(db, opts.researchDir));

  // Desempenho diário contra CDI, Ibovespa e IFIX, e a variação do último pregão.
  app.get('/performance', async (req) => {
    const q = z.object({ from: date.optional() }).parse(req.query);
    return buildPerformance(db, { from: q.from, researchDir: opts.researchDir });
  });
  // Renda mensal por tese. Registrada antes de /theses/:id para "income" não ser lido como id.
  app.get('/theses/income', async (req) => {
    const q = z.object({ months: z.coerce.number().int().min(3).max(60).default(24) }).parse(req.query);
    // Gasto líquido do mês (gastos − receitas − reembolsos da casa), para a cobertura.
    const years = new Map<number, ReturnType<typeof yearSummary>>();
    const netExpense = (month: string) => {
      const y = Number(month.slice(0, 4));
      if (!years.has(y)) years.set(y, yearSummary(db, y));
      const m = years.get(y)!.months[Number(month.slice(5, 7)) - 1];
      return m.expense_cents ? m.expense_cents - m.income_cents - (m.reimbursement_cents ?? 0) : null;
    };
    return thesesIncome(db, dir, q.months, netExpense);
  });

  // Mapa da carteira (registrada antes de /theses/:id, como /theses/income).
  app.get('/theses/map', async () => readMap(db, dir));

  app.get('/theses/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[\w-]+$/) }).parse(req.params);
    return thesisDetail(db, dir, id) ?? reply.code(404).send({ error: 'Tese não encontrada' });
  });

  const select = `SELECT i.*, a.ticker FROM action_items i LEFT JOIN assets a ON a.id = i.asset_id`;
  const getItem = (id: number) => db.prepare(`${select} WHERE i.id = ?`).get(id) as Record<string, unknown> | undefined;
  const assetId = (ticker: string | null | undefined) => {
    if (!ticker) return null;
    const row = db.prepare('SELECT id FROM assets WHERE ticker = ?').get(ticker) as { id: number } | undefined;
    if (!row) throw Object.assign(new Error(`Ativo não cadastrado: ${ticker}`), { statusCode: 400 });
    return row.id;
  };

  // Abertos primeiro, por data; `status=all` inclui os que já tiveram baixa.
  app.get('/action-items', async (req) => {
    const q = z.object({ status: z.enum(['aberto', 'all']).default('aberto') }).parse(req.query);
    return db
      .prepare(`${select} ${q.status === 'aberto' ? "WHERE i.status = 'aberto'" : ''} ORDER BY i.status = 'aberto' DESC, i.due_date, i.id`)
      .all();
  });

  app.post('/action-items', async (req, reply) => {
    const body = z.union([itemSchema, z.array(itemSchema).min(1)]).parse(req.body);
    const ins = db.prepare(
      `INSERT INTO action_items (due_date, title, detail, kind, thesis_id, asset_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: number[] = [];
    db.exec('BEGIN');
    try {
      for (const i of Array.isArray(body) ? body : [body]) {
        ids.push(Number(ins.run(i.due_date, i.title, i.detail ?? null, i.kind, i.thesis_id ?? null, assetId(i.ticker), i.source ?? null).lastInsertRowid));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return reply.code(201).send({ ids });
  });

  app.patch('/action-items/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    if (!getItem(id)) return reply.code(404).send({ error: 'Não encontrado' });
    const { ticker, ...data } = patchSchema.parse(req.body);
    const cols: [string, string | number | null][] = Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, (v ?? null) as string | null]);
    if (ticker !== undefined) cols.push(['asset_id', assetId(ticker)]);
    // A baixa grava a data; reabrir limpa.
    if (data.status) cols.push(['resolved_at', data.status === 'aberto' ? null : new Date().toISOString().slice(0, 10)]);
    if (cols.length) {
      db.prepare(`UPDATE action_items SET ${cols.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(([, v]) => v), id);
    }
    return getItem(id);
  });

  app.delete('/action-items/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const res = db.prepare('DELETE FROM action_items WHERE id = ?').run(id);
    return res.changes ? reply.code(204).send() : reply.code(404).send({ error: 'Não encontrado' });
  });
}
