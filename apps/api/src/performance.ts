import { join } from 'node:path';
import type { DB } from './db.ts';
import { BENCHMARK_TICKERS } from './importers/cotahist.ts';
import { listSnapshots } from './snapshots.ts';
import { readTheses } from './theses.ts';

/**
 * Desempenho diário da carteira, em base 100 na primeira coleta, contra CDI, Ibovespa e IFIX.
 *
 * Entre duas coletas a carteira é a da coleta anterior, marcada todo dia pelo fechamento da
 * B3. Na data da coleta seguinte troca-se para a carteira nova: a compra ou venda feita no
 * intervalo não entra como ganho nem perda. O que não tem cotação diária (Tesouro, fundos não
 * listados) fica parado no valor da coleta e só anda na data da coleta seguinte.
 */

/** Variação diária maior que isto é tratada como evento (grupamento, desdobramento), não como mercado. */
const EVENT_RATIO = 3;
/** Cotação mais velha que isto, na data da coleta, não vale: o ativo é tratado como sem cotação. */
const STALE_DAYS = 10;

interface Holding {
  asset_id: number;
  ticker: string;
  quantity: number | null;
  value_cents: number;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function buildPerformance(db: DB, opts: { from?: string; researchDir?: string } = {}) {
  const all = listSnapshots(db); // mais recente primeiro
  const empty = { available: false as const, reason: '' };
  if (!all.length) return { ...empty, reason: 'Nenhuma coleta importada.' };
  const snaps = all.filter((s) => s.account_id === all[0].account_id).reverse();

  const priceRows = db.prepare('SELECT asset_id, date, price_cents FROM prices ORDER BY date').all() as { asset_id: number; date: string; price_cents: number }[];
  if (!priceRows.length) return { ...empty, reason: 'Nenhuma cotação importada.' };
  const series = new Map<number, { date: string; price: number }[]>();
  for (const r of priceRows) {
    if (!series.has(r.asset_id)) series.set(r.asset_id, []);
    series.get(r.asset_id)!.push({ date: r.date, price: r.price_cents });
  }
  /** Último fechamento até `date` (busca binária). */
  const closeAt = (assetId: number, date: string) => {
    const s = series.get(assetId);
    if (!s) return null;
    let lo = 0;
    let hi = s.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].date <= date) (found = mid), (lo = mid + 1);
      else hi = mid - 1;
    }
    return found < 0 ? null : s[found];
  };

  const d0 = snaps[0].taken_at.slice(0, 10);
  const lastPriceDate = priceRows[priceRows.length - 1].date;
  const sessions = [...new Set(priceRows.map((r) => r.date))].filter((d) => d > d0 && d <= lastPriceDate);
  if (!sessions.length) return { ...empty, reason: 'Não há cotações depois da primeira coleta.' };

  const holdingsOf = (snapshotId: number) =>
    db
      .prepare('SELECT p.asset_id, a.ticker, p.quantity, p.value_cents FROM snapshot_positions p JOIN assets a ON a.id = p.asset_id WHERE p.snapshot_id = ?')
      .all(snapshotId) as unknown as Holding[];
  const incomeRows = db
    .prepare("SELECT date, SUM(amount_cents) AS total FROM asset_income WHERE type <> 'amortizacao' AND date > ? GROUP BY date ORDER BY date")
    .all(d0) as { date: string; total: number }[];

  // --- Carteira dia a dia, encadeando os intervalos entre coletas
  const dates: string[] = [d0];
  const price: number[] = [1]; // índice só de preço
  const total: number[] = [1]; // preço + proventos recebidos
  let unpricedShare = 0;

  for (let k = 0; k < snaps.length; k++) {
    const start = snaps[k].taken_at.slice(0, 10);
    const end = snaps[k + 1]?.taken_at.slice(0, 10) ?? lastPriceDate;
    const holdings = holdingsOf(snaps[k].id);
    const priced = holdings.flatMap((h) => {
      const c = h.quantity !== null ? closeAt(h.asset_id, start) : null;
      return c && dayDiff(c.date, start) <= STALE_DAYS ? [{ ...h, quantity: h.quantity!, last: c.price, frozen: null as number | null }] : [];
    });
    const pricedIds = new Set(priced.map((p) => p.asset_id));
    const flat = holdings.filter((h) => !pricedIds.has(h.asset_id));
    const flatValue = flat.reduce((s, h) => s + h.value_cents, 0);
    const base = priced.reduce((s, p) => s + p.quantity * p.last, 0) + flatValue;
    if (k === snaps.length - 1) unpricedShare = base ? flatValue / base : 0;
    if (!base) continue;

    const i0 = price[price.length - 1];
    const t0 = total[total.length - 1];
    let income = 0;
    let value = base;
    for (const day of sessions.filter((d) => d > start && d <= end)) {
      value = flatValue;
      for (const p of priced) {
        if (p.frozen === null) {
          const px = closeAt(p.asset_id, day)!.price;
          if (px / p.last > EVENT_RATIO || p.last / px > EVENT_RATIO) p.frozen = p.quantity * p.last;
          else p.last = px;
        }
        value += p.frozen ?? p.quantity * p.last;
      }
      income += incomeRows.filter((r) => r.date === day).reduce((s, r) => s + r.total, 0);
      dates.push(day);
      price.push(i0 * (value / base));
      total.push(t0 * ((value + income) / base));
    }

    // Na coleta seguinte, o que não tem cotação diária anda de uma vez (se a quantidade não mudou).
    const next = snaps[k + 1];
    if (next && dates[dates.length - 1] > start) {
      const after = new Map(holdingsOf(next.id).map((h) => [h.asset_id, h]));
      const step = flat.reduce((s, h) => {
        const n = after.get(h.asset_id);
        return n && n.quantity === h.quantity ? s + (n.value_cents - h.value_cents) : s;
      }, 0);
      const bump = 1 + step / value;
      price[price.length - 1] *= bump;
      total[total.length - 1] *= bump;
    }
  }

  // --- Referências nas mesmas datas
  const assetId = (ticker: string) => (db.prepare('SELECT id FROM assets WHERE ticker = ?').get(ticker) as { id: number } | undefined)?.id;
  const indexOf = (ticker: string) => {
    const id = assetId(ticker);
    const start = id ? closeAt(id, d0) : null;
    return dates.map((d) => (id && start ? (closeAt(id, d)?.price ?? start.price) / start.price : null));
  };
  const cdiRows = db.prepare("SELECT date, value FROM series WHERE code = 'CDI' AND date >= ? ORDER BY date").all(d0) as { date: string; value: number }[];
  let ci = 0;
  let factor = 1;
  const cdi = dates.map((d) => {
    // A taxa de um dia rende até o dia útil seguinte: entra no índice a partir do dia depois.
    while (ci < cdiRows.length && cdiRows[ci].date < d) factor *= 1 + cdiRows[ci++].value / 100;
    return cdiRows.length ? factor : null;
  });
  const lines = { price, total, cdi, ibovespa: indexOf(BENCHMARK_TICKERS.IBOVESPA), ifix: indexOf(BENCHMARK_TICKERS.IFIX) };

  // --- Recorte a partir de `from` (rebase) e resumo
  const cut = opts.from ? Math.max(0, dates.findIndex((d) => d >= opts.from!)) : 0;
  const toPct = (xs: (number | null)[]) => {
    const b = xs[cut];
    return xs.slice(cut).map((x) => (x === null || !b ? null : (x / b - 1) * 100));
  };
  const out = { price: toPct(lines.price), total: toPct(lines.total), cdi: toPct(lines.cdi), ibovespa: toPct(lines.ibovespa), ifix: toPct(lines.ifix) };
  const outDates = dates.slice(cut);
  const lastOf = (xs: (number | null)[]) => xs[xs.length - 1] ?? null;

  let peak = 0;
  let worst = { pct: 0, peak_date: outDates[0], trough_date: outDates[0] };
  out.price.forEach((v, i) => {
    if (v === null) return;
    if (v > out.price[peak]!) peak = i;
    const dd = ((100 + v) / (100 + out.price[peak]!) - 1) * 100;
    if (dd < worst.pct) worst = { pct: dd, peak_date: outDates[peak], trough_date: outDates[i] };
  });

  // --- Último pregão: variação por ativo (carteira da última coleta)
  const theses = readTheses(opts.researchDir ? join(opts.researchDir, 'teses') : undefined);
  const thesisOf = new Map<string, string>();
  for (const t of theses) for (const k of t.tickers) if (!thesisOf.has(k)) thesisOf.set(k, t.id);
  const allSessions = [...new Set(priceRows.map((r) => r.date))];
  const T = allSessions[allSessions.length - 1];
  const P = allSessions[allSessions.length - 2] ?? T;
  const W = allSessions[Math.max(0, allSessions.length - 6)];
  const latest = holdingsOf(snaps[snaps.length - 1].id);
  const exact = (id: number, d: string) => series.get(id)?.find((x) => x.date === d)?.price ?? null;
  const rows = latest.flatMap((h) => {
    const now = h.quantity !== null ? exact(h.asset_id, T) : null;
    if (now === null) return [];
    const prev = exact(h.asset_id, P);
    const week = closeAt(h.asset_id, W)?.price ?? null;
    return [{
      ticker: h.ticker,
      thesis: thesisOf.get(h.ticker) ?? null,
      price_cents: now,
      value_cents: Math.round(h.quantity! * now),
      day_pct: prev ? (now / prev - 1) * 100 : null,
      week_pct: week ? (now / week - 1) * 100 : null,
      day_change_cents: prev ? Math.round(h.quantity! * (now - prev)) : 0,
    }];
  });
  const latestValue = latest.reduce((s, h) => s + h.value_cents, 0);
  const dayChange = rows.reduce((s, r) => s + r.day_change_cents, 0);

  return {
    available: true as const,
    from: outDates[0],
    to: outDates[outDates.length - 1],
    snapshots: snaps.map((s) => s.taken_at.slice(0, 10)).filter((d) => d >= outDates[0]),
    dates: outDates,
    series: out,
    summary: {
      price_pct: lastOf(out.price),
      total_pct: lastOf(out.total),
      cdi_pct: lastOf(out.cdi),
      ibovespa_pct: lastOf(out.ibovespa),
      ifix_pct: lastOf(out.ifix),
      max_drawdown: worst,
      // Parte da carteira (última coleta) sem cotação diária: parada entre coletas.
      unpriced_pct: unpricedShare * 100,
    },
    last_session: {
      date: T,
      previous: P,
      week_from: W,
      change_cents: dayChange,
      change_pct: latestValue ? (dayChange / latestValue) * 100 : null,
      assets: rows.sort((a, b) => Math.abs(b.day_change_cents) - Math.abs(a.day_change_cents)),
      without_quote: latest.filter((h) => !rows.some((r) => r.ticker === h.ticker)).map((h) => h.ticker),
    },
  };
}
