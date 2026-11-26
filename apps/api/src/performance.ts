import { join } from 'node:path';
import type { DB } from './db.ts';
import { listSnapshots } from './snapshots.ts';
import { readTheses } from './theses.ts';
import { assetIndex, cdiIndex, chainedIndex, lastOf, loadMarketData, maxDrawdown, toPct } from './price-index.ts';
import { readReferenceFiles, seriesCatalog } from './references.ts';

/**
 * Desempenho diário da carteira, das teses e dos blocos, em base 100 na primeira coleta,
 * contra as séries de referência (CDI e ETFs da B3; ver references.ts). O cálculo do índice
 * está em price-index.ts.
 */

export function buildPerformance(db: DB, opts: { from?: string; researchDir?: string } = {}) {
  const all = listSnapshots(db); // mais recente primeiro
  const empty = { available: false as const, reason: '' };
  if (!all.length) return { ...empty, reason: 'Nenhuma coleta importada.' };
  const snaps = all
    .filter((s) => s.account_id === all[0].account_id)
    .reverse()
    .map((s) => ({ id: s.id, date: s.taken_at.slice(0, 10) }));

  const md = loadMarketData(db);
  if (!md.sessions.length) return { ...empty, reason: 'Nenhuma cotação importada.' };
  const d0 = snaps[0].date;
  const lastPriceDate = md.sessions[md.sessions.length - 1];
  const sessions = md.sessions.filter((d) => d > d0 && d <= lastPriceDate);
  if (!sessions.length) return { ...empty, reason: 'Não há cotações depois da primeira coleta.' };
  const dates = [d0, ...sessions];

  const wallet = chainedIndex(md, snaps, dates);

  // --- Referências nas mesmas datas
  const refFiles = readReferenceFiles(opts.researchDir ? join(opts.researchDir, 'referencias') : undefined);
  const catalog = seriesCatalog(refFiles);
  const cdi = cdiIndex(db, dates);
  const refLines = catalog.map((r) => ({ ref: r, values: r.ticker ? assetIndex(md, md.assetId(r.ticker), dates) : cdi }));
  const byKey = (k: string) => refLines.find((l) => l.ref.key === k)?.values ?? dates.map(() => null);

  // --- Teses e blocos: a mesma conta, restrita aos ativos de cada um
  const theses = readTheses(opts.researchDir ? join(opts.researchDir, 'teses') : undefined);
  const idsOf = (tickers: string[]) => new Set(tickers.map((t) => md.assetId(t)).filter((x): x is number => x !== undefined));
  const blockNames = [...new Set(theses.map((t) => t.block).filter((b): b is string => !!b))];
  const groupDefs = [
    ...theses.map((t) => ({ key: t.id, label: t.title, kind: 'tese' as const, block: t.block, references: t.references, ids: idsOf(t.tickers) })),
    ...blockNames.map((b) => ({
      key: `bloco:${b}`,
      label: b,
      kind: 'bloco' as const,
      block: b,
      references: [] as string[],
      ids: idsOf(theses.filter((t) => t.block === b).flatMap((t) => t.tickers)),
    })),
  ];

  // --- Recorte a partir de `from` (rebase) e resumo
  const cut = opts.from ? Math.max(0, dates.findIndex((d) => d >= opts.from!)) : 0;
  const outDates = dates.slice(cut);
  const out = {
    price: toPct(wallet.price, cut),
    total: toPct(wallet.total, cut),
    cdi: toPct(cdi, cut),
    ibovespa: toPct(byKey('IBOV'), cut),
    ifix: toPct(byKey('IFIX'), cut),
  };
  const firstDate = (xs: (number | null)[]) => outDates[xs.findIndex((x) => x !== null)] ?? null;
  const references = refLines.map(({ ref, values }) => {
    const v = toPct(values, cut);
    return { ...ref, values: v, pct: lastOf(v), first_date: firstDate(v) };
  });
  const groups = groupDefs.map(({ ids, ...g }) => {
    const idx = ids.size ? chainedIndex(md, snaps, dates, ids) : { price: dates.map(() => null), total: dates.map(() => null), unpriced_share: 0 };
    const price = toPct(idx.price, cut);
    const total = toPct(idx.total, cut);
    return {
      ...g,
      price,
      total,
      summary: {
        price_pct: lastOf(price),
        total_pct: lastOf(total),
        max_drawdown: maxDrawdown(price, outDates),
        unpriced_pct: idx.unpriced_share * 100,
        first_date: firstDate(price),
      },
    };
  });
  const worst = maxDrawdown(out.price, outDates);

  // --- Último pregão: variação por ativo (carteira da última coleta)
  const thesisOf = new Map<string, string>();
  for (const t of theses) for (const k of t.tickers) if (!thesisOf.has(k)) thesisOf.set(k, t.id);
  const allSessions = md.sessions;
  const T = allSessions[allSessions.length - 1];
  const P = allSessions[allSessions.length - 2] ?? T;
  const W = allSessions[Math.max(0, allSessions.length - 6)];
  const latest = md.holdingsOf(snaps[snaps.length - 1].id);
  const exact = md.exact;
  const rows = latest.flatMap((h) => {
    const now = h.quantity !== null ? exact(h.asset_id, T) : null;
    if (now === null) return [];
    const prev = exact(h.asset_id, P);
    const week = md.closeAt(h.asset_id, W)?.price ?? null;
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
    snapshots: snaps.map((s) => s.date).filter((d) => d >= outDates[0]),
    dates: outDates,
    series: out,
    references,
    groups,
    summary: {
      price_pct: lastOf(out.price),
      total_pct: lastOf(out.total),
      cdi_pct: lastOf(out.cdi),
      ibovespa_pct: lastOf(out.ibovespa),
      ifix_pct: lastOf(out.ifix),
      max_drawdown: worst,
      // Parte da carteira (última coleta) sem cotação diária: parada entre coletas.
      unpriced_pct: wallet.unpriced_share * 100,
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
