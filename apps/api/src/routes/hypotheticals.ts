import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { isIsoDate } from '../dates.ts';
import { buildHypotheticals, registerHypotheticals, REBALANCE, runBacktest } from '../hypotheticals.ts';

/** Carteiras hipotéticas (research/hipoteticas/) e backtest avulso. Ver hypotheticals.ts. */

const date = z.string().refine(isIsoDate, 'Data deve ser YYYY-MM-DD válida');
const weights = z
  .array(z.object({ ticker: z.string().trim().min(1).transform((t) => t.toUpperCase()), weight: z.number().positive() }))
  .min(1)
  .transform((ws) => {
    const sum = ws.reduce((s, w) => s + w.weight, 0);
    return ws.map((w) => ({ ticker: w.ticker, weight_pct: (w.weight / sum) * 100 }));
  });
const backtestSchema = z
  .object({
    label: z.string().max(80).optional(),
    /** Uma carteira só, comprada em `from`... */
    weights: weights.optional(),
    /** ...ou vigências datadas. */
    versions: z.array(z.object({ from: date, weights })).min(1).optional(),
    from: date.optional(),
    rebalance: z.enum(REBALANCE).default('nenhum'),
    thesis: z.string().regex(/^[\w-]+$/).optional(),
    references: z.array(z.string().max(64)).max(10).default([]),
    compare: z.string().max(64).optional(),
  })
  .refine((b) => !!b.versions || (!!b.weights && !!b.from), 'Informe `versions`, ou `weights` com `from`');

export function hypotheticalRoutes(app: FastifyInstance, db: DB, opts: { researchDir?: string }) {
  app.get('/hypotheticals', async (req) => {
    const q = z.object({ compare: z.string().max(64).optional() }).parse(req.query);
    return buildHypotheticals(db, opts.researchDir, { compare: q.compare });
  });

  /** Grava, com a data de hoje, as vigências que o sistema ainda não tinha visto. */
  app.post('/hypotheticals/register', async () => registerHypotheticals(db, opts.researchDir));

  app.post('/backtest', async (req, reply) => {
    const b = backtestSchema.parse(req.body);
    const versions = b.versions ?? [{ from: b.from!, weights: b.weights! }];
    const out = runBacktest(db, opts.researchDir, { ...b, versions });
    return out.ok ? out : reply.code(422).send(out);
  });
}
