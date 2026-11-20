import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db.ts';
import { buildApp } from '../src/app.ts';

let app: FastifyInstance;
let account = 0;

async function req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as object });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}
const tx = (date: string, description: string, amount_cents: number) =>
  req('POST', '/api/transactions', { account_id: account, date, description, amount_cents });
const mm = (m: number) => String(m).padStart(2, '0');

beforeEach(async () => {
  app = buildApp(openDb(':memory:'));
  account = (await req('POST', '/api/accounts', { name: 'Cartão', type: 'credit_card' })).body.id;
});

describe('sugestões de planejamento', () => {
  it('separa fixo, variável e parcelamento; ignora consumo, IOF e assinatura cancelada', async () => {
    for (let m = 1; m <= 10; m++) {
      await tx(`2026-${mm(m)}-05`, 'SEGURO VIDA', -50_000); // fixo
      await tx(`2026-${mm(m)}-11`, `Cemig — conta de 2026-${mm(m)}`, -(30_000 + m * 3_000)); // variável (>10%), data no nome
      await tx(`2026-${mm(m)}-12`, 'IOF de "SERVICO X"', -100); // imposto, não sugere
      for (let k = 0; k < 4; k++) await tx(`2026-${mm(m)}-${10 + k}`, 'UBER TRIP', -2_000); // consumo
    }
    for (let m = 1; m <= 5; m++) await tx(`2026-${mm(m)}-20`, 'STREAMING CANCELADO', -3_000); // parou em maio
    // Compra em 12x começando em mar/2026: parcela 10/12 em dez → 2 parcelas em 2027
    for (let n = 1; n <= 10; n++) await tx(`2026-${mm(n + 2)}-15`, `LOJA X - Parcela ${n}/12`, -10_000);

    const s = (await req('GET', '/api/plan/suggestions?base_year=2026&target_year=2027')).body.suggestions;
    const by = (name: string) => s.find((x: { name: string }) => x.name.startsWith(name));

    expect(by('SEGURO VIDA')).toMatchObject({ kind: 'fixo', amount_cents: 50_000 });
    expect(by('CEMIG')).toMatchObject({ kind: 'variavel', amount_cents: 57_000 }); // média de ago–out
    expect(by('LOJA X')).toMatchObject({ kind: 'parcelamento', amount_cents: 10_000, months: [1, 2] });
    expect(by('UBER')).toBeUndefined();
    expect(by('IOF')).toBeUndefined();
    expect(by('STREAMING')).toBeUndefined();
  });

  it('não sugere o que já está no plano do ano-alvo', async () => {
    for (let m = 1; m <= 6; m++) await tx(`2026-${mm(m)}-05`, 'ACADEMIA FIT', -9_900);
    await req('POST', '/api/plan/items', { year: 2027, name: 'Academia', amount_cents: 9_900, match_pattern: 'ACADEMIA FIT' });
    const s = (await req('GET', '/api/plan/suggestions?base_year=2026&target_year=2027')).body.suggestions;
    expect(s.find((x: { name: string }) => x.name.includes('ACADEMIA'))).toBeUndefined();
  });
});

describe('plano do ano', () => {
  it('projeta por mês, soma por tipo e compara com o realizado', async () => {
    const r = await req('POST', '/api/plan/items', [
      { year: 2026, name: 'Seguro', kind: 'fixo', amount_cents: 50_000, match_pattern: 'seguro vida' },
      { year: 2026, name: 'Parcela loja', kind: 'parcelamento', amount_cents: 10_000, months: [11, 12] },
    ]);
    expect(r.status).toBe(201);
    await tx('2026-03-05', 'SEGURO VIDA', -50_000);
    await tx('2026-04-05', 'SEGURO VIDA', -52_000);

    const p = (await req('GET', '/api/plan?year=2026')).body;
    expect(p.totals.annual_cents).toBe(12 * 50_000 + 2 * 10_000);
    expect(p.totals.by_kind).toMatchObject({ fixo: 600_000, parcelamento: 20_000, variavel: 0 });
    expect(p.totals.monthly[10]).toBe(60_000);
    const seguro = p.items.find((i: { name: string }) => i.name === 'Seguro');
    expect(seguro.realized.slice(2, 4)).toEqual([50_000, 52_000]);
    expect(seguro.realized_cents).toBe(102_000);

    // edição: só alguns meses
    await req('PATCH', `/api/plan/items/${seguro.id}`, { months: [6, 1, 1] });
    const p2 = (await req('GET', '/api/plan?year=2026')).body;
    expect(p2.items.find((i: { id: number }) => i.id === seguro.id).months).toEqual([1, 6]);

    expect((await req('DELETE', `/api/plan/items/${seguro.id}`)).status).toBe(204);
    expect((await req('POST', '/api/plan/items', { year: 2026, name: 'X', amount_cents: 0 })).status).toBe(400);
  });
});

describe('receitas previstas', () => {
  it('ficam separadas dos gastos, entram no saldo e não mexem nos totais de gasto', async () => {
    await req('POST', '/api/plan/items', [
      { year: 2027, name: 'Aluguel', amount_cents: 200_000 },
      { year: 2027, name: 'Projeto', direction: 'income', amount_cents: 300_000 },
      { year: 2027, name: 'Bônus', direction: 'income', amount_cents: 100_000, months: [12] },
    ]);
    const p = (await req('GET', '/api/plan?year=2027')).body;
    expect(p.items.map((i: { name: string }) => i.name)).toEqual(['Aluguel']);
    expect(p.income_items).toHaveLength(2);
    expect(p.totals.annual_cents).toBe(2_400_000);
    expect(p.totals.income_annual_cents).toBe(3_700_000);
    expect(p.totals.balance_monthly[0]).toBe(100_000);
    expect(p.totals.balance_monthly[11]).toBe(200_000);
    expect(p.totals.balance_annual_cents).toBe(1_300_000);
  });

  it('estima a renda da carteira pelos meses completos e mostra os proventos como realizado', async () => {
    const { estimatePortfolioIncome } = await import('../src/routes/plan.ts');
    const db = openDb(':memory:');
    app = buildApp(db);
    const acc = (await req('POST', '/api/accounts', { name: 'XP', type: 'brokerage' })).body.id;
    const asset = (await req('POST', '/api/assets', { ticker: 'ABCD11', asset_class: 'fii' })).body.id;
    const ins = db.prepare('INSERT INTO asset_income (account_id, asset_id, date, type, amount_cents) VALUES (?, ?, ?, ?, ?)');
    ins.run(acc, asset, '2026-05-28', 'rendimento_fii', 1_000); // primeiro mês: pode estar incompleto
    ins.run(acc, asset, '2026-06-10', 'rendimento_fii', 30_000);
    ins.run(acc, asset, '2026-07-10', 'rendimento_fii', 50_000);
    ins.run(acc, asset, '2026-07-11', 'amortizacao', 900_000); // devolução de capital não é renda
    ins.run(acc, asset, '2026-08-05', 'rendimento_fii', 2_000); // mês corrente: incompleto

    const est = estimatePortfolioIncome(db, '2026-08-17');
    expect(est).toMatchObject({ amount_cents: 40_000, months_used: 2, from: '06/2026', to: '07/2026' });

    await req('POST', '/api/plan/items', { year: 2026, name: 'Carteira', direction: 'income', source: 'proventos', amount_cents: est.amount_cents });
    const p = (await req('GET', '/api/plan?year=2026')).body;
    expect(p.income_items[0].realized.slice(4, 8)).toEqual([1_000, 30_000, 50_000, 2_000]);
  });
});

describe('rateio da casa', () => {
  it('divide por 3: reembolso de 2/3 no plano, no mês e no ano', async () => {
    expect((await req('POST', '/api/shared-costs', { name: 'Aluguel', match_pattern: 'aluguel casa' })).body.people).toBe(3);
    await req('POST', '/api/shared-costs', { name: 'Luz', match_pattern: 'CEMIG' });
    expect((await req('POST', '/api/shared-costs', { name: 'X', match_pattern: 'XYZ', people: 1 })).status).toBe(400);

    await req('POST', '/api/plan/items', [
      { year: 2026, name: 'Aluguel', amount_cents: 300_000, match_pattern: 'ALUGUEL CASA' },
      { year: 2026, name: 'Luz', kind: 'variavel', amount_cents: 30_000, match_pattern: 'Cemig' },
      { year: 2026, name: 'Academia', amount_cents: 10_000, match_pattern: 'ACADEMIA' },
      { year: 2026, direction: 'income', name: 'Salário', amount_cents: 1_000_000 },
    ]);
    await tx('2026-03-05', 'Aluguel Casa — 03/2026', -300_000);
    await tx('2026-03-10', 'Cemig — conta de 2026-02', -30_001);
    await tx('2026-03-12', 'ACADEMIA', -10_000);

    const p = (await req('GET', '/api/plan?year=2026')).body;
    expect(p.items.find((i: { name: string }) => i.name === 'Aluguel').shared_people).toBe(3);
    expect(p.items.find((i: { name: string }) => i.name === 'Academia').shared_people).toBeNull();
    expect(p.reimbursement.planned[0]).toBe(220_000); // 2/3 de 330.000
    expect(p.reimbursement.annual_cents).toBe(12 * 220_000);
    expect(p.totals.income_monthly[0]).toBe(1_220_000);
    expect(p.totals.balance_monthly[0]).toBe(1_220_000 - 340_000);
    expect(p.reimbursement.realized[2]).toBe(200_000 + 20_001);
    expect(p.totals.income_realized_monthly[2]).toBe(220_001);

    const m = (await req('GET', '/api/summary/month?month=2026-03')).body;
    expect(m).toMatchObject({ expense_cents: 340_001, shared_expense_cents: 330_001, reimbursement_cents: 220_001, income_cents: 220_001 });
    expect(m.balance_cents).toBe(-120_000); // 1/3 da casa + academia

    const y = (await req('GET', '/api/summary/year?year=2026')).body;
    expect(y.totals.reimbursement_cents).toBe(220_001);
    expect(y.totals.net_expense_cents).toBe(120_000);
    expect(y.months[2].reimbursement_cents).toBe(220_001);
  });
});
