import type { DB } from './db.ts';
import { BENCHMARK_TICKERS } from './importers/cotahist.ts';
import { buildTheses } from './theses.ts';

/**
 * Correlação entre as teses, pelo retorno semanal de preço.
 *
 * A série de cada tese (e de cada bloco) é a média dos seus ativos, ponderada pelo valor na
 * última coleta. Só preço: proventos não entram, e os preços não são ajustados por eventos.
 * O que não tem cotação diária (Tesouro, fundos não listados) fica fora da matriz.
 *
 * A mesma matriz é devolvida sem as semanas de maior movimento do mercado, para separar o
 * que é correlação de semana comum do que é queda conjunta em choque.
 */

/** Variação semanal maior que isto é tratada como evento ou erro de cadastro, não como mercado. */
const EVENT_WEEK = 0.4;
/** Uma tese só tem retorno na semana se mais da metade do seu valor cotado tiver preço. */
const MIN_WEIGHT = 0.5;
/** Um par só tem correlação com pelo menos esta parte das semanas da janela. */
const MIN_POINTS = 0.7;
/** Semanas de maior movimento do mercado tiradas na versão "sem choques". */
const SHOCK_WEEKS = 4;
const MARKET = 'BOVA11';
const REF_LABEL: Record<string, string> = { BOVA11: 'Ibovespa', XFIX11: 'IFIX', DOLAR_PTAX: 'Dólar' };

type Series = Map<number, number>; // semana -> retorno

/** Semana com início na segunda-feira, contada desde 1970. */
const weekOf = (date: string) => Math.floor((Date.parse(date) / 86_400_000 + 3) / 7);
const fridayOf = (week: number) => new Date((week * 7 + 1) * 86_400_000).toISOString().slice(0, 10);

function weeklyReturns(rows: { date: string; value: number }[]): Series {
  const close = new Map<number, number>(); // último valor de cada semana (rows em ordem de data)
  for (const r of rows) close.set(weekOf(r.date), r.value);
  const out: Series = new Map();
  for (const [w, v] of close) {
    const prev = close.get(w - 1);
    if (prev && prev > 0 && Math.abs(v / prev - 1) < EVENT_WEEK) out.set(w, v / prev - 1);
  }
  return out;
}

function pearson(a: Series, b: Series, weeks: number[]): number | null {
  const ws = weeks.filter((w) => a.has(w) && b.has(w));
  if (ws.length < 3 || ws.length < weeks.length * MIN_POINTS) return null;
  const x = ws.map((w) => a.get(w)!);
  const y = ws.map((w) => b.get(w)!);
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export function buildCorrelation(db: DB, thesesDir: string | undefined, opts: { weeks?: number } = {}) {
  const n = opts.weeks ?? 52;
  const t = buildTheses(db, thesesDir);
  const empty = { available: false as const, reason: '' };
  if (!t.theses.length) return { ...empty, reason: 'Nenhuma tese encontrada.' };

  const byAsset = new Map<number, { date: string; value: number }[]>();
  const tickerOf = new Map<number, string>();
  for (const r of db
    .prepare('SELECT p.asset_id, a.ticker, p.date, p.price_cents FROM prices p JOIN assets a ON a.id = p.asset_id ORDER BY p.date')
    .all() as { asset_id: number; ticker: string; date: string; price_cents: number }[]) {
    if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, []);
    byAsset.get(r.asset_id)!.push({ date: r.date, value: r.price_cents });
    tickerOf.set(r.asset_id, r.ticker);
  }
  if (!byAsset.size) return { ...empty, reason: 'Nenhuma cotação importada.' };
  const returns = new Map([...byAsset].map(([id, rows]) => [id, weeklyReturns(rows)]));

  // Janela: as últimas n semanas com retorno de algum ativo.
  const allWeeks = [...new Set([...returns.values()].flatMap((s) => [...s.keys()]))].sort((a, b) => a - b);
  const weeks = allWeeks.slice(-n);
  if (weeks.length < 8) return { ...empty, reason: 'Menos de 8 semanas de cotação.' };

  /** Retorno semanal de um grupo de ativos, ponderado pelo valor da última coleta. */
  const groupSeries = (assets: { asset_id: number; ticker: string; value_cents: number }[]) => {
    const priced = assets.filter((a) => returns.has(a.asset_id));
    const total = assets.reduce((s, a) => s + a.value_cents, 0);
    const pricedTotal = priced.reduce((s, a) => s + a.value_cents, 0);
    const series: Series = new Map();
    for (const w of weeks) {
      let num = 0;
      let den = 0;
      for (const a of priced) {
        const r = returns.get(a.asset_id)!.get(w);
        if (r !== undefined) (num += a.value_cents * r), (den += a.value_cents);
      }
      if (den > pricedTotal * MIN_WEIGHT) series.set(w, num / den);
    }
    return {
      series,
      coverage_pct: total ? (pricedTotal / total) * 100 : 0,
      without_price: assets.filter((a) => !returns.has(a.asset_id)).map((a) => a.ticker),
    };
  };

  // Referências: Ibovespa e IFIX pelos ETFs, e o dólar pela PTAX.
  const refs: { key: string; label: string; series: Series }[] = [];
  for (const ticker of Object.values(BENCHMARK_TICKERS)) {
    const id = [...tickerOf].find(([, k]) => k === ticker)?.[0];
    if (id !== undefined) refs.push({ key: ticker, label: REF_LABEL[ticker] ?? ticker, series: returns.get(id)! });
  }
  const usd = db.prepare("SELECT date, value FROM series WHERE code = 'DOLAR_PTAX' ORDER BY date").all() as { date: string; value: number }[];
  if (usd.length) refs.push({ key: 'DOLAR_PTAX', label: REF_LABEL.DOLAR_PTAX, series: weeklyReturns(usd) });

  // Semanas de choque: as de maior movimento do mercado (ou, sem o índice, da carteira cotada).
  const market = refs.find((r) => r.key === MARKET)?.series ?? groupSeries(t.theses.flatMap((x) => x.assets)).series;
  const shocks = weeks
    .filter((w) => market.has(w))
    .sort((a, b) => Math.abs(market.get(b)!) - Math.abs(market.get(a)!))
    .slice(0, SHOCK_WEEKS);
  const calm = weeks.filter((w) => !shocks.includes(w));

  const table = (rows: { key: string; label: string; series: Series }[]) => {
    const cols = [...rows, ...refs];
    const make = (ws: number[]) => rows.map((r) => cols.map((c) => (r.key === c.key ? 1 : pearson(r.series, c.series, ws))));
    return { columns: cols.map((c) => ({ key: c.key, label: c.label, ref: refs.includes(c) })), matrix: make(weeks), matrix_calm: make(calm) };
  };

  const excluded: { key: string; label: string; reason: string }[] = [];
  const pick = <T extends { key: string; label: string; assets: { asset_id: number; ticker: string; value_cents: number }[] }>(items: T[]) => {
    const rows: { key: string; label: string; series: Series; coverage_pct: number; without_price: string[] }[] = [];
    for (const it of items) {
      const g = groupSeries(it.assets);
      if (!it.assets.length) excluded.push({ key: it.key, label: it.label, reason: 'sem posição' });
      else if (g.series.size < weeks.length * MIN_POINTS) excluded.push({ key: it.key, label: it.label, reason: `sem cotação diária (${g.without_price.join(', ') || 'histórico curto'})` });
      else rows.push({ key: it.key, label: it.label, ...g });
    }
    return rows;
  };

  const thesisRows = pick(t.theses.map((x) => ({ key: x.id, label: x.title, assets: x.assets })));
  const byId = new Map(t.theses.map((x) => [x.id, x]));
  const excludedTheses = excluded.splice(0);
  const blockRows = pick(
    t.blocks.map((b) => ({ key: b.name ?? '_sem', label: b.name ?? 'Sem bloco', assets: b.theses.flatMap((id) => byId.get(id)?.assets ?? []) })),
  );
  const strip = (rows: typeof thesisRows) => rows.map(({ series: _s, ...r }) => ({ ...r, points: weeks.filter((w) => _s.has(w)).length }));
  const coveredValue = thesisRows.reduce((s, r) => s + (byId.get(r.key)!.assets.filter((a) => returns.has(a.asset_id)).reduce((v, a) => v + a.value_cents, 0)), 0);

  return {
    available: true as const,
    weeks: weeks.length,
    from: fridayOf(weeks[0]),
    to: (db.prepare('SELECT MAX(date) AS d FROM prices').get() as { d: string }).d,
    snapshot: t.as_of.snapshot,
    /** Parte da carteira (em valor) que entra na matriz. */
    coverage_pct: t.total_cents ? (coveredValue / t.total_cents) * 100 : 0,
    shock_weeks: shocks.sort((a, b) => a - b).map((w) => ({ week_ending: fridayOf(w), market_pct: market.get(w)! * 100 })),
    theses: { rows: strip(thesisRows), ...table(thesisRows), excluded: excludedTheses },
    blocks: { rows: strip(blockRows), ...table(blockRows), excluded },
  };
}
