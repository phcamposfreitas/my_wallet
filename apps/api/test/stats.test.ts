import { describe, expect, it } from 'vitest';
import { riskStats } from '../src/stats.ts';

/** Série em % acumulado a partir de retornos diários (fração). */
const cumulative = (rets: number[]) => {
  let level = 1;
  return [0, ...rets.map((r) => ((level *= 1 + r) - 1) * 100)];
};

describe('métricas de risco', () => {
  // 22 pregões de 28/09 a 27/10: a referência alterna +1% e −1%; a série faz o dobro.
  const dates = Array.from({ length: 23 }, (_, i) => new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10));
  const refRets = dates.slice(1).map((_, i) => (i % 2 ? -0.01 : 0.01));
  const ref = cumulative(refRets);
  const x = cumulative(refRets.map((r) => 2 * r));

  it('mede volatilidade, beta, correlação e tracking error', () => {
    const s = riskStats(x, dates, ref);
    expect(s.days).toBe(22);
    expect(s.beta).toBeCloseTo(2);
    expect(s.correlation).toBeCloseTo(1);
    const refVol = riskStats(ref, dates).vol_pct!;
    expect(s.vol_pct).toBeCloseTo(2 * refVol);
    expect(s.tracking_error_pct).toBeCloseTo(refVol); // a diferença é a própria referência
    expect(s.months).toBe(2); // setembro (parcial) e outubro
  });

  it('compara só a janela em que a série existe, e não mede com poucos pregões', () => {
    const late = x.map((v, i) => (i < 15 ? null : v)); // série que começa em outubro
    const s = riskStats(late, dates, ref);
    expect(s.months).toBe(1);
    expect(s.beta).toBeNull(); // 7 pregões
    expect(s.vol_pct).toBeNull();
  });
});
