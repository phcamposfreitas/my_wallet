/**
 * Métricas de risco de uma série diária (em % acumulado, como sai de toPct) contra uma
 * referência no mesmo eixo. Os retornos diários usam só os pares de pregões consecutivos em que
 * as duas séries têm valor.
 *
 * Cuidado ao ler: o que não tem cotação diária (Tesouro, fundos) anda de uma vez na data da
 * coleta, e esse salto entra como um retorno diário. Com janelas curtas, volatilidade e beta são
 * indicativos, não medidas firmes.
 */

const DAYS_PER_YEAR = 252;
/** Abaixo disto não há o que medir. */
const MIN_DAYS = 10;

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function cov(a: number[], b: number[]) {
  const ma = mean(a);
  const mb = mean(b);
  return a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / (a.length - 1);
}

/** Retornos diários (fração) nos pregões em que a série e, se houver, a referência têm valor no dia e no anterior. */
function dailyPairs(x: (number | null)[], ref?: (number | null)[]) {
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const x0 = x[i - 1];
    const x1 = x[i];
    if (x0 === null || x1 === null) continue;
    if (ref) {
      const r0 = ref[i - 1];
      const r1 = ref[i];
      if (r0 === null || r1 === null) continue;
      b.push((100 + r1) / (100 + r0) - 1);
    }
    a.push((100 + x1) / (100 + x0) - 1);
  }
  return { a, b };
}

/** Retorno de cada mês: último valor do mês contra o último do mês anterior (o primeiro mês, contra o primeiro valor). */
function monthly(x: (number | null)[], dates: string[]) {
  const last = new Map<string, number>(); // mês -> último valor (em ordem de data)
  let first: number | null = null;
  x.forEach((v, i) => {
    if (v === null) return;
    if (first === null) first = v;
    last.set(dates[i].slice(0, 7), v);
  });
  const out = new Map<string, number>();
  let prev: number | null = first;
  for (const [m, v] of last) {
    if (prev !== null) out.set(m, (100 + v) / (100 + prev) - 1);
    prev = v;
  }
  return out;
}

export interface RiskStats {
  days: number;
  /** Volatilidade anualizada, em %. */
  vol_pct: number | null;
  beta: number | null;
  correlation: number | null;
  /** Desvio anualizado da diferença de retorno diário, em %. */
  tracking_error_pct: number | null;
  /** Meses com retorno das duas séries, e em quantos a série ficou acima da referência. */
  months: number;
  months_beat: number;
}

export function riskStats(x: (number | null)[], dates: string[], ref?: (number | null)[]): RiskStats {
  const own = dailyPairs(x);
  const vol = own.a.length >= MIN_DAYS ? Math.sqrt(cov(own.a, own.a) * DAYS_PER_YEAR) * 100 : null;
  const empty = { days: own.a.length, vol_pct: vol, beta: null, correlation: null, tracking_error_pct: null, months: 0, months_beat: 0 };
  if (!ref) return empty;
  const { a, b } = dailyPairs(x, ref);
  let beta: number | null = null;
  let corr: number | null = null;
  let te: number | null = null;
  if (a.length >= MIN_DAYS) {
    const vb = cov(b, b);
    const va = cov(a, a);
    const c = cov(a, b);
    beta = vb ? c / vb : null;
    corr = va && vb ? c / Math.sqrt(va * vb) : null;
    const d = a.map((v, i) => v - b[i]);
    te = Math.sqrt(cov(d, d) * DAYS_PER_YEAR) * 100;
  }
  const mx = monthly(x, dates);
  // A referência entra só nos dias em que a série existe: os meses comparados cobrem a mesma janela.
  const mr = monthly(ref.map((v, i) => (x[i] === null ? null : v)), dates);
  const both = [...mx.keys()].filter((m) => mr.has(m));
  return {
    ...empty,
    days: a.length,
    beta,
    correlation: corr,
    tracking_error_pct: te,
    months: both.length,
    months_beat: both.filter((m) => mx.get(m)! - mr.get(m)! > 1e-9).length, // empate não conta
  };
}
