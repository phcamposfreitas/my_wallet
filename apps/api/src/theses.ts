import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { buildPortfolio } from './snapshots.ts';

/**
 * Teses de investimento. A fonte é o markdown em <pasta de dados>/research/teses: o sistema
 * lê o cabeçalho (id, título, status, ativos, datas) a cada consulta e junta com os números
 * do banco. Nada das teses é gravado no banco, então a tela nunca fica atrás do arquivo.
 */

export interface ThesisFile {
  id: string;
  title: string;
  status: string;
  owner: string | null;
  tickers: string[];
  created_on: string | null;
  last_review: string | null;
  next_review: string | null;
  origin: string | null;
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
      owner: str('responsavel'),
      tickers: Array.isArray(meta.ativos) ? meta.ativos : [],
      created_on: str('criada_em'),
      last_review: str('ultima_revisao'),
      next_review: str('proxima_revisao'),
      origin: str('origem'),
      file,
      body,
    });
  }
  // T1, T2, ... T10 em ordem numérica; o resto (ex.: L) no fim.
  const rank = (id: string) => (/^T\d+$/.test(id) ? Number(id.slice(1)) : 1e6);
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
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

  const unassignedTickers = portfolio.positions.filter((p) => !claimed.has(p.ticker)).map((p) => p.ticker);
  return {
    available: files.length > 0,
    as_of: { snapshot: snapshotDate, income_until: lastIncome, income_12m_from: snapshotDate ? start : null },
    total_cents: total,
    theses,
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
  return { ...summary, body: file.body, as_of: all.as_of, total_cents: all.total_cents };
}
