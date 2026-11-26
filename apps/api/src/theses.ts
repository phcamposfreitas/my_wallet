import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { buildPortfolio } from './snapshots.ts';

/**
 * Teses de investimento. A fonte é o markdown em <pasta de dados>/research/teses: o sistema
 * lê o cabeçalho (id, título, status, bloco, ativos, datas) a cada consulta e junta com os números
 * do banco. Nada das teses é gravado no banco, então a tela nunca fica atrás do arquivo.
 */

export interface ThesisFile {
  id: string;
  title: string;
  status: string;
  /** Bloco por função (campo `bloco`). É só lente de leitura: não tem alvo nem teto. */
  block: string | null;
  owner: string | null;
  tickers: string[];
  created_on: string | null;
  last_review: string | null;
  next_review: string | null;
  origin: string | null;
  /** Referências com que a tese se compara (campo `referencias`): chaves de séries ou de carteiras de composição. */
  references: string[];
  file: string;
  body: string;
}

/** Cabeçalho `--- chave: valor ---` no topo do arquivo. Listas no formato `[a, b]`. */
export function parseFrontMatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
    meta[kv[1]] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map(unquote).filter(Boolean)
      : unquote(raw);
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Lê as teses da pasta. Arquivos que começam com `_` (mapa, modelos) e sem `id` ficam de fora. */
export function readTheses(dir: string | undefined): ThesisFile[] {
  if (!dir || !existsSync(dir)) return [];
  const out: ThesisFile[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort()) {
    const { meta, body } = parseFrontMatter(readFileSync(join(dir, file), 'utf8'));
    const str = (k: string) => (typeof meta[k] === 'string' && meta[k] ? (meta[k] as string) : null);
    const id = str('id');
    if (!id) continue;
    out.push({
      id,
      title: str('titulo') ?? id,
      status: str('status') ?? 'sem_status',
      block: str('bloco'),
      owner: str('responsavel'),
      tickers: Array.isArray(meta.ativos) ? meta.ativos : [],
      created_on: str('criada_em'),
      last_review: str('ultima_revisao'),
      next_review: str('proxima_revisao'),
      origin: str('origem'),
      references: Array.isArray(meta.referencias) ? meta.referencias : typeof meta.referencias === 'string' && meta.referencias ? [meta.referencias] : [],
      file,
      body,
    });
  }
  // T1, T2, ... T10 em ordem numérica; o resto (ex.: L) no fim.
  const rank = (id: string) => (/^T\d+$/.test(id) ? Number(id.slice(1)) : 1e6);
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/**
 * Mapa da carteira: o `_mapa.md` da pasta de teses, um retrato datado escrito pelo CIO. O
 * sistema só o exibe. `stale` avisa quando já existe coleta mais nova que o mapa.
 */
export function readMap(db: DB, dir: string | undefined) {
  const file = dir ? join(dir, '_mapa.md') : null;
  if (!file || !existsSync(file)) return { available: false as const };
  const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  const str = (k: string) => (typeof meta[k] === 'string' && meta[k] ? (meta[k] as string) : null);
  const updated = str('atualizado_em');
  const last = (db.prepare('SELECT MAX(taken_at) AS t FROM snapshots').get() as { t: string | null }).t;
  return {
    available: true as const,
    updated_on: updated,
    base: str('base'),
    author: str('autor'),
    last_snapshot: last,
    stale: !!updated && !!last && last.slice(0, 10) > updated,
    // Para a tela trocar os links entre arquivos por links entre páginas.
    files: Object.fromEntries(readTheses(dir).map((t) => [t.file, t.id])),
    body,
  };
}

const pct = (num: number, den: number) => (den ? (num / den) * 100 : null);

/** Teses com os números da última coleta. Posição sem tese vai para o grupo `unassigned`. */
export function buildTheses(db: DB, dir: string | undefined) {
  const files = readTheses(dir);
  const portfolio = buildPortfolio(db);
  const total = portfolio.totals.positions_value_cents;
  const snapshotDate = portfolio.snapshots[0]?.taken_at ?? null;

  // Proventos dos 12 meses até a última coleta, por ativo (o total histórico já vem na posição).
  const end = snapshotDate?.slice(0, 10) ?? '9999-12-31';
  const start = snapshotDate ? `${Number(end.slice(0, 4)) - 1}${end.slice(4)}` : '0000-01-01';
  const income12 = new Map(
    (
      db
        .prepare('SELECT asset_id, SUM(amount_cents) AS total FROM asset_income WHERE date > ? AND date <= ? GROUP BY asset_id')
        .all(start, end) as { asset_id: number; total: number }[]
    ).map((r) => [r.asset_id, r.total]),
  );
  const lastIncome = (db.prepare('SELECT MAX(date) AS d FROM asset_income').get() as { d: string | null }).d;

  const byTicker = new Map(portfolio.positions.map((p) => [p.ticker, p]));
  const claimed = new Map<string, string[]>(); // ticker -> teses que o citam
  for (const f of files) for (const t of f.tickers) claimed.set(t, [...(claimed.get(t) ?? []), f.id]);

  const group = (tickers: string[]) => {
    const assets = tickers
      .filter((t) => byTicker.has(t))
      .map((t) => {
        const p = byTicker.get(t)!;
        return {
          asset_id: p.asset_id,
          ticker: p.ticker,
          name: p.name,
          asset_class: p.asset_class,
          value_cents: p.value_cents,
          cost_cents: p.cost_cents,
          weight_pct: pct(p.value_cents, total),
          price_return_pct: p.price_return_pct,
          income_12m_cents: income12.get(p.asset_id) ?? 0,
          income_total_cents: p.income_cents,
          pays_cash: p.pays_cash,
        };
      })
      .sort((a, b) => b.value_cents - a.value_cents);
    const value = assets.reduce((s, a) => s + a.value_cents, 0);
    const cost = assets.reduce((s, a) => s + (a.cost_cents ?? 0), 0);
    return {
      assets,
      value_cents: value,
      cost_cents: cost,
      weight_pct: pct(value, total),
      price_return_pct: pct(value - cost, cost),
      income_12m_cents: assets.reduce((s, a) => s + a.income_12m_cents, 0),
      income_total_cents: assets.reduce((s, a) => s + a.income_total_cents, 0),
    };
  };

  const theses = files.map(({ body: _body, tickers, ...f }) => ({
    ...f,
    ...group(tickers),
    // Citados na tese, mas sem posição na última coleta (vendidos, ou código que não casa com o cadastro).
    tickers_without_position: tickers.filter((t) => !byTicker.has(t)),
  }));

  // Blocos: cada tese declara o seu no cabeçalho, então a lista nasce e some com as teses.
  // Tese sem bloco fica numa linha própria (nome null), só quando alguma outra declara bloco.
  const names = [...new Set(theses.map((t) => t.block))];
  const blocks = names.some((n) => n !== null)
    ? names
        .map((name) => {
          const members = theses.filter((t) => t.block === name);
          const value = members.reduce((s, t) => s + t.value_cents, 0);
          const cost = members.reduce((s, t) => s + t.cost_cents, 0);
          return {
            name,
            theses: members.map((t) => t.id),
            assets_count: members.reduce((s, t) => s + t.assets.length, 0),
            in_review: members.filter((t) => t.status === 'em_revisao').length,
            value_cents: value,
            cost_cents: cost,
            weight_pct: pct(value, total),
            price_return_pct: pct(value - cost, cost),
            income_12m_cents: members.reduce((s, t) => s + t.income_12m_cents, 0),
          };
        })
        .sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.value_cents - a.value_cents)
    : [];

  const unassignedTickers = portfolio.positions.filter((p) => !claimed.has(p.ticker)).map((p) => p.ticker);
  return {
    available: files.length > 0,
    as_of: { snapshot: snapshotDate, income_until: lastIncome, income_12m_from: snapshotDate ? start : null },
    total_cents: total,
    theses,
    blocks,
    unassigned: group(unassignedTickers),
    // Um ativo deve estar em uma tese só; se aparecer em duas, o peso é contado duas vezes.
    duplicated: [...claimed.entries()].filter(([, ids]) => ids.length > 1).map(([ticker, ids]) => ({ ticker, theses: ids })),
  };
}

export function thesisDetail(db: DB, dir: string | undefined, id: string) {
  const file = readTheses(dir).find((f) => f.id.toLowerCase() === id.toLowerCase());
  if (!file) return null;
  const all = buildTheses(db, dir);
  const summary = all.theses.find((t) => t.id === file.id)!;
  const income = thesisIncome(db, file.tickers, summary.assets);
  return { ...summary, body: file.body, as_of: all.as_of, total_cents: all.total_cents, income };
}

// --- Renda (proventos) por tese e por ativo ----------------------------------------------

const ymKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
/** Os `n` meses que terminam em `last` (YYYY-MM), do mais antigo ao mais novo. */
function monthsEndingAt(last: string, n: number): string[] {
  const [y, m] = last.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 - (n - 1 - i), 1);
    return ymKey(d.getFullYear(), d.getMonth() + 1);
  });
}
const avg = (v: number[]) => (v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : 0);

interface IncomeRow {
  asset_id: number;
  ticker: string;
  asset_class: string;
  date: string;
  type: string;
  amount_cents: number;
  base_quantity: number | null;
  value_per_unit: number | null;
}

/** Proventos do período. Amortização é devolução de capital, não renda. */
function incomeRows(db: DB, from: string): IncomeRow[] {
  return db
    .prepare(
      `SELECT i.asset_id, a.ticker, a.asset_class, i.date, i.type, i.amount_cents, i.base_quantity, i.value_per_unit
       FROM asset_income i JOIN assets a ON a.id = i.asset_id
       WHERE i.type <> 'amortizacao' AND i.date >= ? ORDER BY i.date`,
    )
    .all(from) as unknown as IncomeRow[];
}

/**
 * Janela de meses da renda. O último mês é o do último provento registrado e pode estar
 * incompleto: as médias usam só os meses anteriores a ele.
 */
function incomeWindow(db: DB, n: number) {
  const until = (db.prepare("SELECT MAX(date) AS d FROM asset_income WHERE type <> 'amortizacao'").get() as { d: string | null }).d;
  if (!until) return null;
  const months = monthsEndingAt(until.slice(0, 7), n);
  return { until, months, complete: months.slice(0, -1) };
}

/**
 * Renda mensal empilhada por tese. Ativo que saiu da carteira entra em "Ex-posições": a renda
 * dele existiu, mas não se repete. A cobertura compara a média dos três últimos meses
 * completos com o gasto líquido dos mesmos meses.
 */
export function thesesIncome(db: DB, dir: string | undefined, n = 24, netExpenseOf?: (month: string) => number | null) {
  const win = incomeWindow(db, n);
  const files = readTheses(dir);
  if (!win) return { months: [], income_until: null, series: [], total_monthly: [], avg_3m_cents: 0, avg_12m_cents: 0, coverage: null };

  const held = new Set(buildPortfolio(db).positions.map((p) => p.ticker));
  const thesisOf = new Map<string, string>();
  for (const f of files) for (const t of f.tickers) if (!thesisOf.has(t)) thesisOf.set(t, f.id);

  const idx = new Map(win.months.map((m, i) => [m, i]));
  const series = new Map<string, { key: string; label: string; monthly: number[] }>();
  const get = (key: string, label: string) => {
    if (!series.has(key)) series.set(key, { key, label, monthly: Array(n).fill(0) });
    return series.get(key)!;
  };
  for (const f of files) get(f.id, f.title);
  for (const r of incomeRows(db, `${win.months[0]}-01`)) {
    const i = idx.get(r.date.slice(0, 7));
    if (i === undefined) continue;
    const thesis = held.has(r.ticker) ? thesisOf.get(r.ticker) : undefined;
    const s = thesis ? series.get(thesis)! : held.has(r.ticker) ? get('_sem', 'Sem tese') : get('_ex', 'Ex-posições');
    s.monthly[i] += r.amount_cents;
  }

  const list = [...series.values()].filter((s) => s.monthly.some((v) => v !== 0));
  const total = win.months.map((_, i) => list.reduce((s, x) => s + x.monthly[i], 0));
  const completeTotals = total.slice(0, -1);
  const last3 = win.complete.slice(-3);
  const avg3 = avg(completeTotals.slice(-3));

  let coverage = null;
  if (netExpenseOf && last3.length) {
    const expenses = last3.map(netExpenseOf);
    if (expenses.every((e): e is number => e !== null && e > 0)) {
      const expenseAvg = avg(expenses);
      coverage = { months: last3, income_avg_cents: avg3, expense_avg_cents: expenseAvg, pct: pct(avg3, expenseAvg) };
    }
  }

  return {
    months: win.months,
    income_until: win.until,
    series: list.map((s) => ({ ...s, total_12m_cents: s.monthly.slice(-13, -1).reduce((a, b) => a + b, 0) })),
    total_monthly: total,
    avg_3m_cents: avg3,
    avg_12m_cents: avg(completeTotals.slice(-12)),
    coverage,
  };
}

/** Classes que pagam todo mês: só nelas faz sentido apontar corte e mês sem pagamento. */
const MONTHLY_PAYERS = new Set(['fii', 'fundo']);
const CUT_THRESHOLD = 0.9; // queda de mais de 10% no valor por cota

/**
 * Renda de uma tese, ativo a ativo: valor recebido e valor por cota em cada mês.
 * Valor por cota do mês: em cada data e tipo vale a linha de maior quantidade-base (as outras
 * costumam ser recibos de subscrição, pagos pro rata); datas e tipos diferentes somam.
 */
export function thesisIncome(db: DB, tickers: string[], positions: { ticker: string; value_cents: number; cost_cents: number | null }[], n = 12) {
  const win = incomeWindow(db, n);
  if (!win) return null;
  const idx = new Map(win.months.map((m, i) => [m, i]));
  const wanted = new Set(tickers);
  const rows = incomeRows(db, `${win.months[0]}-01`).filter((r) => wanted.has(r.ticker));
  const lastIdx = n - 1;

  const assets = positions
    .filter((p) => wanted.has(p.ticker))
    .map((p) => {
      const mine = rows.filter((r) => r.ticker === p.ticker);
      const monthly = Array(n).fill(0) as number[];
      const best = new Map<string, { i: number; qty: number; vpu: number }>(); // por data+tipo
      for (const r of mine) {
        const i = idx.get(r.date.slice(0, 7));
        if (i === undefined) continue;
        monthly[i] += r.amount_cents;
        if (r.value_per_unit === null) continue;
        const k = `${r.date}|${r.type}`;
        const cur = best.get(k);
        if (!cur || (r.base_quantity ?? 0) > cur.qty) best.set(k, { i, qty: r.base_quantity ?? 0, vpu: r.value_per_unit });
      }
      const perUnit = Array(n).fill(null) as (number | null)[];
      for (const b of best.values()) perUnit[b.i] = (perUnit[b.i] ?? 0) + b.vpu;

      // Sinais só para quem paga todo mês. O último mês pode estar incompleto: ausência nele não conta.
      const flags = Array(n).fill(null) as ('corte' | 'sem_pagamento' | null)[];
      const assetClass = mine[0]?.asset_class;
      if (assetClass && MONTHLY_PAYERS.has(assetClass)) {
        let prev: number | null = null;
        for (let i = 0; i < n; i++) {
          const v = perUnit[i];
          if (v === null) {
            if (prev !== null && i < lastIdx && monthly[i] === 0) flags[i] = 'sem_pagamento';
            continue;
          }
          if (prev !== null && v < prev * CUT_THRESHOLD) flags[i] = 'corte';
          prev = v;
        }
      }
      const total12 = monthly.reduce((s, v) => s + v, 0);
      return {
        ticker: p.ticker,
        monthly,
        per_unit: perUnit,
        flags,
        total_cents: total12,
        yield_on_price_pct: pct(total12, p.value_cents),
        yield_on_cost_pct: p.cost_cents ? pct(total12, p.cost_cents) : null,
      };
    });

  const total = win.months.map((_, i) => assets.reduce((s, a) => s + a.monthly[i], 0));
  return {
    months: win.months,
    income_until: win.until,
    assets,
    total_monthly: total,
    avg_3m_cents: avg(total.slice(0, -1).slice(-3)),
    signals: assets.flatMap((a) =>
      a.flags.flatMap((f, i) => (f ? [{ ticker: a.ticker, month: win.months[i], kind: f, per_unit: a.per_unit[i] }] : [])),
    ),
  };
}
