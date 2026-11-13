import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { DB } from './db.ts';
import { budgetRoutes } from './routes/budget.ts';
import { investmentRoutes } from './routes/investments.ts';
import { statementRoutes } from './routes/statements.ts';
import { buildPortfolio } from './snapshots.ts';

export function buildApp(db: DB, opts: { logger?: boolean } = {}) {
  // bodyLimit maior: uma fatura extraída pode ter centenas de lançamentos.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos', issues: err.issues });
    }
    const message = (err as Error).message ?? 'Erro';
    if (message.includes('FOREIGN KEY constraint failed')) {
      return reply.code(409).send({ error: 'Registro está em uso ou referência inexistente' });
    }
    if (message.includes('UNIQUE constraint failed')) {
      return reply.code(409).send({ error: 'Registro duplicado' });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: message });
  });

  app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
      budgetRoutes(api, db);
      investmentRoutes(api, db);
      statementRoutes(api, db);

      // Visão geral: saldo das contas do dia a dia + patrimônio na corretora (último snapshot)
      api.get('/overview', async () => {
        const { cash } = db
          .prepare(
            `SELECT COALESCE(SUM(a.initial_balance_cents
                    + COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = a.id), 0)), 0) AS cash
             FROM accounts a WHERE a.archived = 0 AND a.type <> 'brokerage'`,
          )
          .get() as { cash: number };
        const { totals, snapshots } = buildPortfolio(db);
        return {
          cash_cents: cash,
          investments_cents: totals.total_cents,
          net_worth_cents: cash + totals.total_cents,
          portfolio: totals,
          last_snapshot: snapshots[0]?.taken_at ?? null,
        };
      });
    },
    { prefix: '/api' },
  );

  return app;
}
