import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;

async function post(url: string, payload: unknown) {
  const res = await app.inject({ method: 'POST', url, payload: payload as object });
  return { status: res.statusCode, body: res.json() };
}
async function get(url: string) {
  return (await app.inject({ method: 'GET', url })).json();
}

beforeEach(() => {
  app = buildApp(openDb(':memory:'));
});

describe('gastos', () => {
  it('cria categorias padrão', async () => {
    const cats = await get('/api/categories');
    expect(cats.length).toBeGreaterThan(5);
  });

  it('calcula saldo de conta e resumo do mês', async () => {
    const acc = (await post('/api/accounts', { name: 'Nubank', type: 'checking', initial_balance_cents: 10_000 })).body;
    const cats = await get('/api/categories');
    const food = cats.find((c: { name: string }) => c.name === 'Alimentação');
    const salary = cats.find((c: { name: string }) => c.name === 'Salário');

    await post('/api/transactions', { account_id: acc.id, category_id: salary.id, date: '2026-11-05', description: 'Salário', amount_cents: 500_000 });
    await post('/api/transactions', { account_id: acc.id, category_id: food.id, date: '2026-11-06', description: 'Almoço', amount_cents: -4_500 });
    await post('/api/transactions', { account_id: acc.id, date: '2026-10-30', description: 'Mês anterior', amount_cents: -1_000 });

    const [account] = await get('/api/accounts');
    expect(account.balance_cents).toBe(10_000 + 500_000 - 4_500 - 1_000);

    const summary = await get('/api/summary/month?month=2026-11');
    expect(summary.income_cents).toBe(500_000);
    expect(summary.expense_cents).toBe(4_500);
    expect(summary.by_category[0]).toMatchObject({ name: 'Alimentação', total_cents: 4_500 });

    const txs = await get('/api/transactions?month=2026-11');
    expect(txs).toHaveLength(2);
  });

  it('valida entrada', async () => {
    const res = await post('/api/transactions', { description: '' });
    expect(res.status).toBe(400);
  });
});

describe('operações', () => {
  it('bloqueia venda a descoberto e exclusão que deixaria venda sem lastro', async () => {
    const broker = (await post('/api/accounts', { name: 'XP', type: 'brokerage' })).body;
    const asset = (await post('/api/assets', { ticker: 'petr4', asset_class: 'acao' })).body;
    expect(asset.ticker).toBe('PETR4');
    const base = { account_id: broker.id, asset_id: asset.id, price_cents: 3_000 };
    const buy = (await post('/api/trades', { ...base, side: 'buy', date: '2026-01-01', quantity: 100 })).body;

    expect((await post('/api/trades', { ...base, side: 'sell', date: '2026-02-01', quantity: 101 })).status).toBe(400);
    expect(await get('/api/trades')).toHaveLength(1); // escrita desfeita

    await post('/api/trades', { ...base, side: 'sell', date: '2026-02-01', quantity: 50 });
    const del = await app.inject({ method: 'DELETE', url: `/api/trades/${buy.id}` });
    expect(del.statusCode).toBe(400);
  });
});
