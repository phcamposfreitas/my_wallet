import type { DB } from './db.ts';
import { addDays, weekdaysBetween } from './dates.ts';
import { BENCHMARK_TICKERS } from './importers/cotahist.ts';

/**
 * Custo de oportunidade e referências de mercado entre `from` e `to` (datas ISO):
 * - CDI acumulado: produto de (1 + taxa diária / 100) das taxas com data em [from, to).
 *   A taxa de um dia rende até o dia útil seguinte, então isso mede do fechamento de
 *   `from` ao fechamento de `to`, a mesma janela das cotações abaixo.
 * - Variação de BOVA11 e XFIX11 (aproximações de Ibovespa e IFIX): último fechamento
 *   até `from` contra o último fechamento até `to`.
 * A resposta traz as datas e preços usados. Como feriados não são conhecidos, só
 * buracos de 3+ dias úteis viram aviso; no fim do período, qualquer dia útil sem dado
 * vira aviso (normalmente é só o fechamento de hoje que ainda não saiu).
 */

const GAP = 3;

export interface PriceChange {
  ticker: string;
  start: { date: string; price_cents: number };
  end: { date: string; price_cents: number };
  pct: number;
}

export function computeBenchmarks(db: DB, from: string, to: string) {
  const warnings: string[] = [];
  return {
    from,
    to,
    cdi: cdiAccumulated(db, from, to, warnings),
    ibovespa: priceChange(db, BENCHMARK_TICKERS.IBOVESPA, from, to, warnings),
    ifix: priceChange(db, BENCHMARK_TICKERS.IFIX, from, to, warnings),
    warnings,
  };
}

function cdiAccumulated(db: DB, from: string, to: string, warnings: string[]) {
  const rows = db
    .prepare("SELECT date, value FROM series WHERE code = 'CDI' AND date >= ? AND date < ? ORDER BY date")
    .all(from, to) as { date: string; value: number }[];
  const businessDays = weekdaysBetween(addDays(from, -1), to); // seg–sex em [from, to)
  if (!rows.length) {
    if (businessDays === 0) return { factor: 1, pct: 0, days: 0, first_date: null, last_date: null };
    warnings.push(`CDI: nenhuma taxa entre ${from} e ${to}; importe as séries (import:series)`);
    return null;
  }
  // Buracos: antes da primeira taxa, entre taxas e depois da última.
  const gaps: string[] = [];
  const first = rows[0].date;
  if (weekdaysBetween(addDays(from, -1), first) >= GAP) gaps.push(`sem taxas de ${from} a ${addDays(first, -1)}`);
  for (let i = 1; i < rows.length; i++) {
    if (weekdaysBetween(rows[i - 1].date, rows[i].date) >= GAP) {
      gaps.push(`sem taxas de ${addDays(rows[i - 1].date, 1)} a ${addDays(rows[i].date, -1)}`);
    }
  }
  const last = rows[rows.length - 1].date;
  if (weekdaysBetween(last, to) > 0) gaps.push(`última taxa no período é de ${last}`);
  for (const g of gaps) warnings.push(`CDI: ${g}`);

  const factor = rows.reduce((f, r) => f * (1 + r.value / 100), 1);
  return { factor, pct: (factor - 1) * 100, days: rows.length, first_date: first, last_date: last };
}

function priceChange(db: DB, ticker: string, from: string, to: string, warnings: string[]): PriceChange | null {
  const closeUntil = db.prepare(
    `SELECT p.date, p.price_cents FROM prices p JOIN assets a ON a.id = p.asset_id
     WHERE a.ticker = ? AND p.date <= ? ORDER BY p.date DESC LIMIT 1`,
  );
  const start = closeUntil.get(ticker, from) as { date: string; price_cents: number } | undefined;
  const end = closeUntil.get(ticker, to) as { date: string; price_cents: number } | undefined;
  if (!start || !end) {
    warnings.push(`${ticker}: sem fechamento até ${from}; importe o COTAHIST desse pregão (import:cotahist)`);
    return null;
  }
  const staleStart = weekdaysBetween(start.date, addDays(from, 1));
  if (staleStart >= GAP) warnings.push(`${ticker}: fechamento-base é de ${start.date}, ${staleStart} dias úteis antes de ${from}`);
  if (weekdaysBetween(end.date, addDays(to, 1)) > 0) warnings.push(`${ticker}: último fechamento importado até ${to} é de ${end.date}`);
  return {
    ticker,
    start: { date: start.date, price_cents: start.price_cents },
    end: { date: end.date, price_cents: end.price_cents },
    pct: (end.price_cents / start.price_cents - 1) * 100,
  };
}
