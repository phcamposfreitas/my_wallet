import type { DB } from './db.ts';

/**
 * Motor de índice diário. Transforma posições datadas (as coletas) em um índice que anda
 * todo pregão pelo fechamento da B3. Serve à carteira inteira, a cada tese, a cada bloco e,
 * mais adiante, a carteiras de referência e hipotéticas: tudo vira uma série no mesmo eixo
 * de datas e pode ser comparado com qualquer outra.
 *
 * Entre duas coletas vale a carteira da coleta anterior. Na data da coleta seguinte troca-se
 * para a carteira nova: compra ou venda feita no intervalo não entra como ganho nem perda. O
 * que não tem cotação diária (Tesouro, fundos não listados) fica parado no valor da coleta e
 * só anda na data da coleta seguinte.
 */

/** Variação diária maior que isto é tratada como evento (grupamento, desdobramento), não como mercado. */
export const EVENT_RATIO = 3;
/** Cotação mais velha que isto, na data da coleta, não vale: o ativo é tratado como sem cotação. */
export const STALE_DAYS = 10;

export interface Holding {
  asset_id: number;
  ticker: string;
  quantity: number | null;
  value_cents: number;
}

export interface Snapshot {
  id: number;
  date: string;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Cotações, proventos e posições carregados uma vez e usados por todas as séries. */
export interface MarketData {
  /** Pregões com alguma cotação, em ordem. */
  sessions: string[];
  /** Último fechamento até `date` (inclusive), ou null. */
  closeAt(assetId: number, date: string): { date: string; price: number } | null;
  /** Fechamento exatamente em `date`, ou null. */
  exact(assetId: number, date: string): number | null;
  holdingsOf(snapshotId: number): Holding[];
  /** Proventos pagos (sem amortização), por data e por ativo. */
  incomeOn(date: string): Map<number, number> | undefined;
  assetId(ticker: string): number | undefined;
}

export function loadMarketData(db: DB): MarketData {
  const priceRows = db.prepare('SELECT asset_id, date, price_cents FROM prices ORDER BY date').all() as { asset_id: number; date: string; price_cents: number }[];
  const series = new Map<number, { date: string; price: number }[]>();
  for (const r of priceRows) {
    if (!series.has(r.asset_id)) series.set(r.asset_id, []);
    series.get(r.asset_id)!.push({ date: r.date, price: r.price_cents });
  }
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
  const income = new Map<string, Map<number, number>>();
  for (const r of db
    .prepare("SELECT date, asset_id, SUM(amount_cents) AS total FROM asset_income WHERE type <> 'amortizacao' GROUP BY date, asset_id")
    .all() as { date: string; asset_id: number; total: number }[]) {
    if (!income.has(r.date)) income.set(r.date, new Map());
    income.get(r.date)!.set(r.asset_id, r.total);
  }
  const holdingsStmt = db.prepare(
    'SELECT p.asset_id, a.ticker, p.quantity, p.value_cents FROM snapshot_positions p JOIN assets a ON a.id = p.asset_id WHERE p.snapshot_id = ?',
  );
  const holdings = new Map<number, Holding[]>();
  const ids = new Map((db.prepare('SELECT id, ticker FROM assets').all() as { id: number; ticker: string }[]).map((a) => [a.ticker, a.id]));
  return {
    sessions: [...new Set(priceRows.map((r) => r.date))],
    closeAt,
    exact: (id, d) => {
      const c = closeAt(id, d);
      return c && c.date === d ? c.price : null;
    },
    holdingsOf: (id) => {
      if (!holdings.has(id)) holdings.set(id, holdingsStmt.all(id) as unknown as Holding[]);
      return holdings.get(id)!;
    },
    incomeOn: (d) => income.get(d),
    assetId: (t) => ids.get(t),
  };
}

export interface IndexSeries {
  /** Índice só de preço (fator, 1 = base); null onde o grupo não tinha posição. */
  price: (number | null)[];
  /** Preço + proventos recebidos. */
  total: (number | null)[];
  /** Parte do valor sem cotação diária na última coleta em que o grupo tinha posição. */
  unpriced_share: number;
}

/**
 * Índice encadeado entre coletas, no eixo `axis` (datas em ordem; a primeira é a data da
 * primeira coleta). `keep` restringe a um conjunto de ativos (uma tese, um bloco); sem ele,
 * vale a carteira inteira, com todos os proventos.
 */
export function chainedIndex(md: MarketData, snaps: Snapshot[], axis: string[], keep?: Set<number>): IndexSeries {
  const price: (number | null)[] = axis.map(() => null);
  const total: (number | null)[] = axis.map(() => null);
  /** Posição no eixo do último dia até `date`. */
  const at = (date: string) => {
    let i = -1;
    for (let k = 0; k < axis.length && axis[k] <= date; k++) i = k;
    return i;
  };
  const last = axis[axis.length - 1];
  let unpricedShare = 0;
  let prevP = 1;
  let prevT = 1;

  for (let k = 0; k < snaps.length; k++) {
    const start = snaps[k].date;
    const end = snaps[k + 1]?.date ?? last;
    const holdings = md.holdingsOf(snaps[k].id).filter((h) => !keep || keep.has(h.asset_id));
    const priced = holdings.flatMap((h) => {
      const c = h.quantity !== null ? md.closeAt(h.asset_id, start) : null;
      return c && dayDiff(c.date, start) <= STALE_DAYS ? [{ ...h, quantity: h.quantity!, last: c.price, frozen: null as number | null }] : [];
    });
    const pricedIds = new Set(priced.map((p) => p.asset_id));
    const flat = holdings.filter((h) => !pricedIds.has(h.asset_id));
    const flatValue = flat.reduce((s, h) => s + h.value_cents, 0);
    const base = priced.reduce((s, p) => s + p.quantity * p.last, 0) + flatValue;
    if (!base) continue;
    unpricedShare = flatValue / base;

    // O grupo entra (ou volta) nesta coleta: o índice segue de onde parou.
    const i0 = at(start);
    if (i0 >= 0 && price[i0] === null) (price[i0] = prevP), (total[i0] = prevT);
    const p0 = i0 >= 0 ? price[i0]! : prevP;
    const t0 = i0 >= 0 ? total[i0]! : prevT;
    let income = 0;
    let value = base;
    let lastIdx = i0;
    for (let i = i0 + 1; i < axis.length && axis[i] <= end; i++) {
      const day = axis[i];
      value = flatValue;
      for (const p of priced) {
        if (p.frozen === null) {
          const px = md.closeAt(p.asset_id, day)!.price;
          if (px / p.last > EVENT_RATIO || p.last / px > EVENT_RATIO) p.frozen = p.quantity * p.last;
          else p.last = px;
        }
        value += p.frozen ?? p.quantity * p.last;
      }
      const paid = md.incomeOn(day);
      if (paid) for (const [id, cents] of paid) if (!keep || keep.has(id)) income += cents;
      price[i] = p0 * (value / base);
      total[i] = t0 * ((value + income) / base);
      lastIdx = i;
    }

    // Na coleta seguinte, o que não tem cotação diária anda de uma vez (se a quantidade não mudou).
    const next = snaps[k + 1];
    if (next && lastIdx > i0) {
      const after = new Map(md.holdingsOf(next.id).map((h) => [h.asset_id, h]));
      const step = flat.reduce((s, h) => {
        const n = after.get(h.asset_id);
        return n && n.quantity === h.quantity ? s + (n.value_cents - h.value_cents) : s;
      }, 0);
      const bump = 1 + step / value;
      price[lastIdx]! *= bump;
      total[lastIdx]! *= bump;
    }
    if (lastIdx >= 0 && price[lastIdx] !== null) (prevP = price[lastIdx]!), (prevT = total[lastIdx]!);
  }
  return { price, total, unpriced_share: unpricedShare };
}

/** Índice de um ativo cotado (ETF de referência): fechamento ÷ primeiro fechamento até o início do eixo. */
export function assetIndex(md: MarketData, assetId: number | undefined, axis: string[]): (number | null)[] {
  if (assetId === undefined) return axis.map(() => null);
  const closes = axis.map((d) => md.closeAt(assetId, d)?.price ?? null);
  // Sem fechamento até o início, a base é o primeiro fechamento do eixo (referência cadastrada depois).
  const base = closes.find((c) => c !== null);
  return closes.map((c) => (c === null || !base ? null : c / base));
}

/** CDI acumulado no eixo: a taxa de um dia rende até o dia útil seguinte. */
export function cdiIndex(db: DB, axis: string[]): (number | null)[] {
  const rows = db.prepare("SELECT date, value FROM series WHERE code = 'CDI' AND date >= ? ORDER BY date").all(axis[0]) as { date: string; value: number }[];
  if (!rows.length) return axis.map(() => null);
  let ci = 0;
  let factor = 1;
  return axis.map((d) => {
    while (ci < rows.length && rows[ci].date < d) factor *= 1 + rows[ci++].value / 100;
    return factor;
  });
}

/** Rebase a partir da posição `cut`: variação acumulada em %. A base é o primeiro valor não nulo do recorte. */
export function toPct(xs: (number | null)[], cut: number): (number | null)[] {
  const slice = xs.slice(cut);
  const b = slice.find((x) => x !== null);
  return slice.map((x) => (x === null || !b ? null : (x / b - 1) * 100));
}

/** Maior queda de pico a vale numa série em % acumulado. */
export function maxDrawdown(values: (number | null)[], dates: string[]) {
  let peak: number | null = null;
  let peakIdx = 0;
  let worst = { pct: 0, peak_date: dates[0], trough_date: dates[0] };
  values.forEach((v, i) => {
    if (v === null) return;
    if (peak === null || v > peak) (peak = v), (peakIdx = i);
    const dd = ((100 + v) / (100 + peak) - 1) * 100;
    if (dd < worst.pct) worst = { pct: dd, peak_date: dates[peakIdx], trough_date: dates[i] };
  });
  return worst;
}

export const lastOf = (xs: (number | null)[]) => {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] !== null) return xs[i];
  return null;
};

export interface WeightVersion {
  /** Data de vigência (publicação). O rebalanceamento é feito no fechamento do primeiro pregão a partir dela. */
  from: string;
  weights: { ticker: string; weight_pct: number }[];
}

export interface WeightsIndex {
  values: (number | null)[];
  /** Por rebalanceamento: data efetiva, parte do peso com cotação e ativos sem cotação (pesos redistribuídos entre os demais). */
  rebalances: { from: string; on: string; priced_pct: number; missing: string[] }[];
}

/**
 * Carteira de composição simulada no eixo: em cada vigência compra os pesos pelo fechamento do
 * primeiro pregão a partir da data de publicação (nunca antes: sem olhar o futuro) e segura até a
 * vigência seguinte, deixando os pesos andarem com o mercado. Só preço. Ativo sem cotação na
 * data fica de fora e o peso dele é redistribuído entre os demais. Vigência anterior ao eixo vale
 * desde o início do eixo (a mais recente delas).
 */
export function weightsIndex(md: MarketData, versions: WeightVersion[], axis: string[]): WeightsIndex {
  const values: (number | null)[] = axis.map(() => null);
  const rebalances: WeightsIndex['rebalances'] = [];
  const starts = new Map<number, WeightVersion>(); // posição no eixo -> vigência
  for (const v of [...versions].sort((a, b) => a.from.localeCompare(b.from))) {
    const i = axis.findIndex((d) => d >= v.from);
    if (i >= 0) starts.set(i, v); // a mais recente que cai no mesmo pregão vence
  }
  const order = [...starts.keys()].sort((a, b) => a - b);
  let holdings: { id: number; q: number; last: number; frozen: number | null }[] = [];
  let level = 1;

  const mark = (day: string) => {
    let v = 0;
    for (const h of holdings) {
      if (h.frozen === null) {
        const px = md.closeAt(h.id, day)!.price;
        if (px / h.last > EVENT_RATIO || h.last / px > EVENT_RATIO) h.frozen = h.q * h.last;
        else h.last = px;
      }
      v += h.frozen ?? h.q * h.last;
    }
    return v;
  };

  for (let s = 0; s < order.length; s++) {
    const start = order[s];
    const end = order[s + 1] ?? axis.length;
    const day = axis[start];
    if (holdings.length) level = mark(day); // a carteira anterior anda até o fechamento do rebalanceamento
    const v = starts.get(start)!;
    const priced = v.weights.flatMap((w) => {
      const id = md.assetId(w.ticker);
      const c = id !== undefined ? md.closeAt(id, day) : null;
      return id !== undefined && c && dayDiff(c.date, day) <= STALE_DAYS ? [{ id, w: w.weight_pct, price: c.price }] : [];
    });
    const pricedW = priced.reduce((a, p) => a + p.w, 0);
    const total = v.weights.reduce((a, w) => a + w.weight_pct, 0);
    rebalances.push({
      from: v.from,
      on: day,
      priced_pct: total ? (pricedW / total) * 100 : 0,
      missing: v.weights.filter((w) => !priced.some((p) => md.assetId(w.ticker) === p.id)).map((w) => w.ticker),
    });
    if (!pricedW) {
      holdings = [];
      continue;
    }
    holdings = priced.map((p) => ({ id: p.id, q: (level * p.w) / pricedW / p.price, last: p.price, frozen: null }));
    values[start] = level;
    for (let i = start + 1; i < end; i++) values[i] = mark(axis[i]);
    level = values[end - 1] ?? level;
  }
  return { values, rebalances };
}
