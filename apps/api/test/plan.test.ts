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
