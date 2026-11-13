import { describe, expect, it } from 'vitest';
import { computePosition } from '../src/portfolio.ts';

describe('computePosition (custo médio)', () => {
  it('acumula compras com taxas no custo', () => {
    const p = computePosition([
      { side: 'buy', quantity: 100, price_cents: 1000, fees_cents: 500 },
      { side: 'buy', quantity: 100, price_cents: 2000, fees_cents: 500 },
    ]);
    expect(p.quantity).toBe(200);
    expect(p.cost_cents).toBe(301_000);
    expect(p.avg_price_cents).toBe(1505);
    expect(p.realized_cents).toBe(0);
  });

  it('venda baixa custo pelo preço médio e apura lucro', () => {
    const p = computePosition([
      { side: 'buy', quantity: 100, price_cents: 1000, fees_cents: 0 },
      { side: 'buy', quantity: 100, price_cents: 2000, fees_cents: 0 },
      { side: 'sell', quantity: 50, price_cents: 3000, fees_cents: 100 },
    ]);
    expect(p.quantity).toBe(150);
    expect(p.avg_price_cents).toBe(1500); // preço médio não muda na venda
    expect(p.cost_cents).toBe(225_000);
    expect(p.realized_cents).toBe(50 * 3000 - 100 - 50 * 1500);
  });

  it('zera a posição ao vender tudo', () => {
    const p = computePosition([
      { side: 'buy', quantity: 0.3, price_cents: 1000, fees_cents: 0 },
      { side: 'sell', quantity: 0.1, price_cents: 1000, fees_cents: 0 },
      { side: 'sell', quantity: 0.2, price_cents: 1000, fees_cents: 0 },
    ]);
    expect(p.quantity).toBe(0);
    expect(p.cost_cents).toBe(0);
  });

  it('rejeita venda maior que a posição', () => {
    expect(() =>
      computePosition([
        { side: 'buy', quantity: 10, price_cents: 1000, fees_cents: 0 },
        { side: 'sell', quantity: 11, price_cents: 1000, fees_cents: 0 },
      ]),
    ).toThrow();
  });
});
