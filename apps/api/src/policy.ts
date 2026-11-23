import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { buildPerformance } from './performance.ts';
import { buildPortfolio, compareSnapshots, listSnapshots } from './snapshots.ts';
import { parseFrontMatter, readTheses } from './theses.ts';

/**
 * Política de investimentos. A fonte é <pasta de dados>/research/politica.md: o texto é do
 * titular e o cabeçalho traz os mesmos números em campos que o sistema lê (alvos, tetos,
 * tolerância e a classificação dos ativos por fator). Aqui eles são comparados com a última
 * coleta. Nada da política é gravado no banco.
 */

const CLASS_GROUP: Record<string, string> = {
  acao: 'acoes',
  bdr: 'acoes',
  etf: 'acoes',
  fii: 'fiis',
  fundo: 'fiis',
  tesouro: 'tesouro',
  renda_fixa: 'tesouro',
};
const GROUP_LABEL: Record<string, string> = {
  acoes: 'Ações e BDRs',
  fiis: 'FIIs e fundos',
  tesouro: 'Tesouro',
  internacional: 'Internacional',
  outros: 'Outros',
};
/** Classes sujeitas ao teto por ação e ao teto por fundo. */
const STOCK_CLASSES = new Set(['acao', 'bdr']);
const FUND_CLASSES = new Set(['fii', 'fundo']);
const TOLERANCE_WINDOW_DAYS = 90;
const DAY = 86_400_000;

const pct = (num: number, den: number) => (den ? (num / den) * 100 : 0);
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : []);
/** `[a=1/2, b=3]` → { a: [1, 2], b: [3] } */
function pairs(v: string | string[] | undefined): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const item of list(v)) {
    const [k, raw] = item.split('=');
    const nums = (raw ?? '').split('/').map((x) => Number(x.replace(',', '.')));
    if (k && nums.length && nums.every(Number.isFinite)) out[k.trim()] = nums;
  }
  return out;
}

export function readPolicy(researchDir: string | undefined) {
  const file = researchDir ? join(researchDir, 'politica.md') : null;
  if (!file || !existsSync(file)) return null;
  const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  const str = (k: string) => (typeof meta[k] === 'string' && meta[k] !== 'null' ? (meta[k] as string) : null);
  const status = str('status') ?? 'rascunho';
  return {
    status,
    approved: status.startsWith('aprovada'),
    approved_on: str('aprovada_em'),
    next_review: str('proxima_revisao'),
    targets: pairs(meta.alvos),
    caps: Object.fromEntries(Object.entries(pairs(meta.tetos)).map(([k, v]) => [k, v[0]])),
    tolerance: Object.fromEntries(Object.entries(pairs(meta.tolerancia)).map(([k, v]) => [k, v[0]])),
    /** Aporte mensal assumido, em reais (campo `aporte_mensal`). */
    monthly_contribution_cents: Number.isFinite(Number(str('aporte_mensal'))) && str('aporte_mensal') ? Math.round(Number(str('aporte_mensal')) * 100) : null,
    state_owned: list(meta.estatais),
    credit_theses: list(meta.teses_credito_privado),
    reserve: list(meta.reserva_emergencia),
    factor_commodities: list(meta.fator_commodities_dolar),
    factor_floating: list(meta.fator_pos_fixado),
    body,
  };
}

type Status = 'dentro' | 'acima' | 'abaixo' | 'sem_regra';

/**
 * Queda de mercado desde o pico dos últimos 90 dias. Com cotações importadas usa a série
 * diária (o pico e o vale verdadeiros); sem elas, compara só as coletas e subestima a queda.
 */
function drawdown(db: DB) {
  const all = listSnapshots(db); // mais recente primeiro
  if (!all.length) return null;
  const last = all[0];
  const since0 = new Date(Date.parse(last.taken_at.slice(0, 10)) - TOLERANCE_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const daily = buildPerformance(db, { from: since0 });
  if (daily.available && daily.dates.length > 1) {
    const prices = daily.series.price as number[];
    let peak = 0;
    prices.forEach((v, i) => (v > prices[peak] ? (peak = i) : 0));
    const now = prices[prices.length - 1];
    return {
      pct: ((100 + now) / (100 + prices[peak]) - 1) * 100,
      peak_at: daily.dates[peak],
      as_of: daily.to,
      source: 'cotacoes' as const,
      points: daily.dates.length,
      window_days: TOLERANCE_WINDOW_DAYS,
    };
  }
  if (all.length < 2) return null;
  const since = new Date(Date.parse(last.taken_at.slice(0, 10)) - TOLERANCE_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  // Coletas da janela, da mais antiga para a mais nova. Com mais de uma conta, compara só a da última coleta.
  const window = all.filter((s) => s.account_id === last.account_id && s.taken_at.slice(0, 10) >= since).reverse();
  if (window.length < 2) return null;
  let index = 1;
  let peak = { index: 1, taken_at: window[0].taken_at };
  for (let i = 1; i < window.length; i++) {
    const { totals } = compareSnapshots(db, window[i - 1].id, window[i].id);
    index *= 1 + (totals.value_from_cents ? totals.market_cents / totals.value_from_cents : 0);
    if (index > peak.index) peak = { index, taken_at: window[i].taken_at };
  }
  return {
    pct: (index / peak.index - 1) * 100,
    peak_at: peak.taken_at,
    as_of: last.taken_at.slice(0, 10),
    source: 'coletas' as const,
    points: window.length,
    window_days: TOLERANCE_WINDOW_DAYS,
  };
}

export function buildPolicy(db: DB, researchDir: string | undefined) {
  const policy = readPolicy(researchDir);
  const portfolio = buildPortfolio(db);
  const total = portfolio.totals.positions_value_cents;
  const positions = portfolio.positions;
  const theses = readTheses(researchDir ? join(researchDir, 'teses') : undefined);
  const thesisOf = new Map<string, string>();
  for (const t of theses) for (const k of t.tickers) if (!thesisOf.has(k)) thesisOf.set(k, t.id);
  const weight = (v: number) => pct(v, total);
  const sum = (ps: typeof positions) => ps.reduce((s, p) => s + p.value_cents, 0);
  const asOf = { snapshot: portfolio.snapshots[0]?.taken_at ?? null };

  if (!policy) return { available: false as const, as_of: asOf, total_cents: total };

  // --- Alocação por classe: atual × alvo, com banda
  const groups = new Map<string, number>();
  for (const p of positions) {
    const g = CLASS_GROUP[p.asset_class] ?? 'outros';
    groups.set(g, (groups.get(g) ?? 0) + p.value_cents);
  }
  const keys = [...new Set([...Object.keys(policy.targets), ...groups.keys()])];
  const allocation = keys.map((key) => {
    const value = groups.get(key) ?? 0;
    const current = weight(value);
    const [target, band = 0] = policy.targets[key] ?? [];
    const has = target !== undefined;
    const status: Status = !has ? 'sem_regra' : current > target + band ? 'acima' : current < target - band ? 'abaixo' : 'dentro';
    return {
      key,
      label: GROUP_LABEL[key] ?? key,
      value_cents: value,
      current_pct: current,
      target_pct: has ? target : null,
      band_pct: has ? band : null,
      deviation_pct: has ? current - target : null,
      // Quanto falta (positivo) ou sobra (negativo) para o alvo, com a carteira do tamanho de hoje.
      to_target_cents: has ? Math.round((target / 100) * total) - value : null,
      status,
    };
  });

  // --- Fatores (classificação do cabeçalho; o resto é Brasil doméstico)
  const commodities = new Set(policy.factor_commodities);
  const floating = new Set(policy.factor_floating);
  const factorOf = (t: string) => (commodities.has(t) ? 'commodities_dolar' : floating.has(t) ? 'pos_fixado' : 'domestico');
  const factorLabel: Record<string, string> = { domestico: 'Brasil doméstico', commodities_dolar: 'Commodities e dólar', pos_fixado: 'Pós-fixado' };
  const factors = Object.keys(factorLabel).map((key) => {
    const ps = positions.filter((p) => factorOf(p.ticker) === key);
    return { key, label: factorLabel[key], value_cents: sum(ps), current_pct: weight(sum(ps)), count: ps.length };
  });

  // --- Limites
  const cap = (k: string) => policy.caps[k] ?? null;
  const item = (p: (typeof positions)[number]) => ({ name: p.ticker, current_pct: weight(p.value_cents), thesis: thesisOf.get(p.ticker) ?? null });
  const over = <T extends { current_pct: number }>(xs: T[], c: number | null) => (c === null ? [] : xs.filter((x) => x.current_pct > c));
  const top = <T extends { current_pct: number }>(xs: T[]) => [...xs].sort((a, b) => b.current_pct - a.current_pct);

  const stocks = top(positions.filter((p) => STOCK_CLASSES.has(p.asset_class)).map(item));
  const funds = top(positions.filter((p) => FUND_CLASSES.has(p.asset_class)).map(item));
  const byThesis = top(
    theses.map((t) => ({ name: t.id, title: t.title, current_pct: weight(sum(positions.filter((p) => thesisOf.get(p.ticker) === t.id))) })),
  );
  const single = (key: string, label: string, ps: typeof positions, c: number | null, note?: string) => {
    const current = weight(sum(ps));
    return {
      key,
      label,
      scope: 'soma' as const,
      cap_pct: c,
      current_pct: current,
      headroom_pct: c === null ? null : c - current,
      status: (c === null ? 'sem_regra' : current > c ? 'acima' : 'dentro') as Status,
      over: [] as { name: string; current_pct: number }[],
      members: ps.map((p) => p.ticker),
      note: note ?? null,
    };
  };
  const each = <T extends { name: string; current_pct: number }>(key: string, label: string, xs: T[], c: number | null) => ({
    key,
    label,
    scope: 'cada' as const,
    cap_pct: c,
    current_pct: xs[0]?.current_pct ?? 0, // o maior
    headroom_pct: c === null || !xs.length ? null : c - xs[0].current_pct,
    status: (c === null ? 'sem_regra' : over(xs, c).length ? 'acima' : 'dentro') as Status,
    over: over(xs, c).map((x) => ({ name: x.name, current_pct: x.current_pct })),
    members: xs.slice(0, 1).map((x) => x.name),
    note: null as string | null,
  });
  const credit = new Set(policy.credit_theses);
  const limits = [
    each('acao', 'Por ação', stocks, cap('acao')),
    each('fundo', 'Por FII ou fundo', funds, cap('fundo')),
    each('tese', 'Por tese', byThesis, cap('tese')),
    single('estatais', 'Estatais somadas', positions.filter((p) => policy.state_owned.includes(p.ticker)), cap('estatais')),
    single('credito_privado', 'Crédito privado', positions.filter((p) => credit.has(thesisOf.get(p.ticker) ?? '')), cap('credito_privado'), policy.credit_theses.join(', ')),
    single('fator_domestico', 'Fator Brasil doméstico', positions.filter((p) => factorOf(p.ticker) === 'domestico'), cap('fator_domestico')),
  ];

  // --- Onde a política veda compra nova: acima de um teto, ou em tese em revisão
  const reviewing = new Set(theses.filter((t) => t.status === 'em_revisao').map((t) => t.id));
  const overThesis = new Set(over(byThesis, cap('tese')).map((t) => t.name));
  const overAsset = new Set([...over(stocks, cap('acao')), ...over(funds, cap('fundo'))].map((x) => x.name));
  const blocked = positions
    .map((p) => {
      const thesis = thesisOf.get(p.ticker) ?? null;
      const reasons: string[] = [];
      if (overAsset.has(p.ticker)) reasons.push(STOCK_CLASSES.has(p.asset_class) ? 'acima do teto por ação' : 'acima do teto por fundo');
      if (thesis && overThesis.has(thesis)) reasons.push(`tese ${thesis} acima do teto`);
      if (thesis && reviewing.has(thesis)) reasons.push(`tese ${thesis} em revisão`);
      return { ticker: p.ticker, thesis, current_pct: weight(p.value_cents), reasons };
    })
    .filter((b) => b.reasons.length)
    .sort((a, b) => b.current_pct - a.current_pct);

  // --- Onde cabe aporte novo: o que não está vedado, até o teto mais apertado que se aplica
  const OWNER_GROUP: Record<string, string> = { 'analista-fii': 'fiis', 'analista-acoes': 'acoes', 'estrategista-macro': 'tesouro' };
  const allocOf = new Map(allocation.map((a) => [a.key, a]));
  const blockedSet = new Set(blocked.map((b) => b.ticker));
  const weightOfThesis = new Map(byThesis.map((t) => [t.name, t.current_pct]));
  /**
   * Um teto, com o peso atual do que ele mede. O espaço em reais é de dinheiro NOVO: o aporte
   * também aumenta a carteira, então cabe (teto × total − valor) ÷ (1 − teto), mais do que a
   * simples diferença de pontos sugere (faz muita diferença nos tetos altos, como o de fator).
   */
  type Limit = { label: string; room_pct: number; room_cents: number };
  const limit = (label: string, capPct: number | null, currentPct: number): Limit | null =>
    capPct === null
      ? null
      : { label, room_pct: capPct - currentPct, room_cents: Math.round((((capPct - currentPct) / 100) * total) / (1 - capPct / 100)) };
  /** O teto mais apertado em reais entre os que se aplicam. */
  const tightest = (ls: (Limit | null)[]) => ls.filter((l): l is Limit => l !== null).sort((x, y) => x.room_cents - y.room_cents)[0] ?? null;
  const currentOf = (key: string) => limits.find((l) => l.key === key)!.current_pct;

  const room = theses
    .filter((t) => !reviewing.has(t.id))
    .map((t) => {
      const mine = positions.filter((p) => thesisOf.get(p.ticker) === t.id);
      const group = mine.length ? (CLASS_GROUP[mine[0].asset_class] ?? 'outros') : (OWNER_GROUP[t.owner ?? ''] ?? 'outros');
      // Tese sem posição ainda não tem fator: conta como doméstico, que é o caso geral.
      const domestic = mine.length ? mine.some((p) => factorOf(p.ticker) === 'domestico') : true;
      const thesisLimits = [
        limit('teto por tese', cap('tese'), weightOfThesis.get(t.id) ?? 0),
        credit.has(t.id) ? limit('teto de crédito privado', cap('credito_privado'), currentOf('credito_privado')) : null,
      ];
      const domesticLimit = limit('teto do fator doméstico', cap('fator_domestico'), currentOf('fator_domestico'));
      const thesisLimit = tightest([...thesisLimits, domestic ? domesticLimit : null]);
      const assets = mine
        .filter((p) => !blockedSet.has(p.ticker))
        .map((p) => {
          const w = weight(p.value_cents);
          const own = STOCK_CLASSES.has(p.asset_class)
            ? limit('teto por ação', cap('acao'), w)
            : FUND_CLASSES.has(p.asset_class)
              ? limit('teto por fundo', cap('fundo'), w)
              : null;
          const lim = tightest([own, ...thesisLimits, factorOf(p.ticker) === 'domestico' ? domesticLimit : null]);
          return { ticker: p.ticker, current_pct: w, room_pct: lim?.room_pct ?? null, room_cents: lim?.room_cents ?? null, limited_by: lim?.label ?? null };
        })
        .filter((a) => a.room_cents === null || a.room_cents > 0)
        .sort((a, b) => (b.room_cents ?? 1e15) - (a.room_cents ?? 1e15));
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        group,
        group_label: GROUP_LABEL[group] ?? group,
        group_status: allocOf.get(group)?.status ?? ('sem_regra' as Status),
        current_pct: weightOfThesis.get(t.id) ?? 0,
        room_pct: thesisLimit?.room_pct ?? null,
        room_cents: thesisLimit?.room_cents ?? null,
        limited_by: thesisLimit?.label ?? null,
        assets,
        // Posições da tese que não podem receber aporte (acima de um teto por ativo).
        blocked_assets: mine.filter((p) => blockedSet.has(p.ticker)).map((p) => p.ticker),
      };
    })
    .filter((t) => t.room_cents === null || t.room_cents > 0);

  // --- Cauda: posições abaixo de 1%
  const small = positions.filter((p) => weight(p.value_cents) < 1);
  const tail = {
    count: small.length,
    current_pct: weight(sum(small)),
    without_thesis: small.filter((p) => !thesisOf.has(p.ticker)).map((p) => p.ticker),
  };

  // --- Reserva de emergência e tolerância
  const reserveValue = sum(positions.filter((p) => policy.reserve.includes(p.ticker)));
  const dd = drawdown(db);
  const { nada, rebalancear } = policy.tolerance;
  const action = !dd || nada === undefined ? null : dd.pct >= nada ? 'nada' : rebalancear !== undefined && dd.pct < rebalancear ? 'reduzir_risco' : 'rebalancear';

  const { body, ...header } = policy;
  return {
    available: true as const,
    as_of: asOf,
    total_cents: total,
    policy: header,
    body,
    allocation,
    limits,
    factors,
    blocked,
    room,
    tail,
    reserve: { value_cents: reserveValue, current_pct: weight(reserveValue), tickers: policy.reserve },
    tolerance: { ...policy.tolerance, drawdown: dd, action },
  };
}
