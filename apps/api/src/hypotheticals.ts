import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { localToday } from './dates.ts';
import { readTheses, parseFrontMatter } from './theses.ts';
import { parseWeights, readReferenceFiles } from './references.ts';
import { referenceLines, walletSnapshots } from './performance.ts';
import { CASH_TICKER, cdiIndex, chainedIndex, lastOf, loadMarketData, maxDrawdown, toPct, weightsIndex, type MarketData, type WeightVersion } from './price-index.ts';
import { riskStats } from './stats.ts';

/**
 * Carteiras hipotéticas: "e se a tese fosse assim?". Uma lista de pesos datada, no mesmo
 * formato das carteiras de composição (references.ts), guardada em `research/hipoteticas/`,
 * na pasta de dados. Cada uma é medida de dois jeitos:
 *
 * - **Acompanhamento** (o que vale): cada vigência só passa a valer no dia em que o sistema a
 *   registrou (tabela hypothetical_versions), mesmo que o arquivo diga uma data anterior.
 *   Editar o arquivo depois não muda o passado: o acompanhamento continua com o que foi
 *   registrado, e a diferença aparece como aviso. Não há viés de seleção.
 * - **Backtest** (apoio): o arquivo como está escrito, desde a primeira vigência. Quem
 *   escolheu os ativos já sabia o que aconteceu com eles: viés de sobrevivência e de seleção.
 *
 * As duas linhas são comparadas, na mesma janela, com a tese real ligada à hipotética
 * (campo `tese`), com as referências dela e da tese e com o CDI.
 *
 * Formato:
 *
 *   ---
 *   id: dividendos-sem-bancos
 *   titulo: Dividendos sem bancos
 *   tese: T3                     # opcional: a tese real com que se compara
 *   referencias: [IDIV]          # opcional
 *   rebalanceamento: trimestral  # nenhum (padrão), mensal, trimestral, semestral ou anual
 *   ---
 *   | vigencia   | ativo | peso |
 *   |------------|-------|------|
 *   | 2026-11-26 | TAEE11 | 30  |
 *   | 2026-11-26 | CDI    | 20  |   ← caixa rendendo CDI
 */

export const REBALANCE = ['nenhum', 'mensal', 'trimestral', 'semestral', 'anual'] as const;
export type Rebalance = (typeof REBALANCE)[number];
const MONTHS: Record<Rebalance, number> = { nenhum: 0, mensal: 1, trimestral: 3, semestral: 6, anual: 12 };

/** Pregões por ano, para anualizar. Abaixo de um ano o retorno anualizado não é mostrado. */
const SESSIONS_PER_YEAR = 252;

export interface HypotheticalFile {
  key: string;
  label: string;
  thesis: string | null;
  references: string[];
  rebalance: Rebalance;
  file: string;
  versions: (WeightVersion & { raw_sum: number })[];
  warnings: string[];
}

export function readHypotheticalFiles(dir: string | undefined) {
  const files: HypotheticalFile[] = [];
  const warnings: string[] = [];
  if (!dir || !existsSync(dir)) return { files, warnings };
  const seen = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort()) {
    const { meta, body } = parseFrontMatter(readFileSync(join(dir, file), 'utf8'));
    const str = (k: string) => (typeof meta[k] === 'string' && meta[k] ? (meta[k] as string) : null);
    const id = str('id');
    if (!id || !/^[\w-]+$/.test(id)) {
      warnings.push(`${file}: sem id válido no cabeçalho (letras, números, - e _); ignorado`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`${file}: id ${id} repetido; ignorado`);
      continue;
    }
    seen.add(id);
    const reb = (str('rebalanceamento') ?? 'nenhum').toLowerCase();
    const parsed = parseWeights(file, body);
    const fileWarnings = [...parsed.warnings];
    if (!(REBALANCE as readonly string[]).includes(reb)) fileWarnings.push(`${file}: rebalanceamento "${reb}" desconhecido; usado "nenhum"`);
    const refs = meta.referencias;
    files.push({
      key: id,
      label: str('titulo') ?? id,
      thesis: str('tese'),
      references: Array.isArray(refs) ? refs : typeof refs === 'string' && refs ? [refs] : [],
      rebalance: (REBALANCE as readonly string[]).includes(reb) ? (reb as Rebalance) : 'nenhum',
      file,
      versions: parsed.versions,
      warnings: fileWarnings,
    });
  }
  return { files, warnings };
}

/**
 * Rebalanceamento periódico: repete os pesos da vigência no 1º dia de cada período do
 * calendário (mês; trimestre em jan/abr/jul/out; semestre em jan/jul; ano em jan) até a vigência
 * seguinte. O motor executa cada uma no primeiro pregão a partir dessa data.
 */
export function expandRebalance(versions: WeightVersion[], freq: Rebalance, until: string): WeightVersion[] {
  const step = MONTHS[freq];
  if (!step) return versions;
  const out: WeightVersion[] = [];
  versions.forEach((v, i) => {
    out.push(v);
    const stop = versions[i + 1]?.from ?? '9999-12-31';
    let y = Number(v.from.slice(0, 4));
    let m = Number(v.from.slice(5, 7)); // 1..12
    for (;;) {
      m += 1;
      if (m > 12) (m = 1), (y += 1);
      if ((m - 1) % step) continue;
      const d = `${y}-${String(m).padStart(2, '0')}-01`;
      if (d >= stop || d > until) break;
      out.push({ from: d, weights: v.weights });
    }
  });
  return out;
}

/** Pesos em forma canônica, para comparar a vigência do arquivo com a registrada. */
const canonical = (weights: WeightVersion['weights']) =>
  JSON.stringify([...weights].sort((a, b) => a.ticker.localeCompare(b.ticker)).map((w) => ({ ticker: w.ticker, weight_pct: Math.round(w.weight_pct * 1e4) / 1e4 })));

interface Recorded {
  effective_on: string;
  recorded_on: string;
  weights: string;
}
const recordedOf = (db: DB, key: string) =>
  db.prepare('SELECT effective_on, recorded_on, weights FROM hypothetical_versions WHERE portfolio = ? ORDER BY effective_on').all(key) as unknown as Recorded[];

/**
 * Registra as vigências novas dos arquivos com a data de hoje. A vigência já registrada não é
 * reescrita, mesmo que o arquivo mude: é isso que impede o acompanhamento de olhar o futuro.
 */
export function registerHypotheticals(db: DB, researchDir: string | undefined, today = localToday()) {
  const { files, warnings } = readHypotheticalFiles(researchDir ? join(researchDir, 'hipoteticas') : undefined);
  const get = db.prepare('SELECT weights FROM hypothetical_versions WHERE portfolio = ? AND effective_on = ?');
  const ins = db.prepare('INSERT INTO hypothetical_versions (portfolio, effective_on, weights, recorded_on) VALUES (?, ?, ?, ?)');
  const recorded: { key: string; from: string; applies_on: string }[] = [];
  const changed: { key: string; from: string }[] = [];
  for (const f of files) {
    for (const v of f.versions) {
      const w = canonical(v.weights);
      const row = get.get(f.key, v.from) as { weights: string } | undefined;
      if (!row) {
        ins.run(f.key, v.from, w, today);
        recorded.push({ key: f.key, from: v.from, applies_on: v.from > today ? v.from : today });
      } else if (row.weights !== w) changed.push({ key: f.key, from: v.from });
    }
  }
  return { ok: true as const, today, files: files.length, recorded, changed, warnings };
}

export type LineKind = 'hipotetica' | 'tese' | 'referencia';

interface Context {
  db: DB;
  md: MarketData;
  snaps: ReturnType<typeof walletSnapshots>;
  theses: ReturnType<typeof readTheses>;
  refFiles: ReturnType<typeof readReferenceFiles>;
}

function context(db: DB, researchDir: string | undefined): Context {
  return {
    db,
    md: loadMarketData(db),
    snaps: walletSnapshots(db),
    theses: readTheses(researchDir ? join(researchDir, 'teses') : undefined),
    refFiles: readReferenceFiles(researchDir ? join(researchDir, 'referencias') : undefined),
  };
}

/**
 * Uma janela de comparação: a hipotética (só preço e com proventos), a tese real, as
 * referências e o CDI no mesmo eixo, a partir do primeiro pregão em `start`. As métricas de
 * risco são contra `compare` (padrão: a primeira referência da hipotética, senão o Ibovespa).
 */
function compareWindow(
  ctx: Context,
  p: { key: string; label: string; versions: WeightVersion[]; start: string; thesis: string | null; references: string[]; compare?: string },
) {
  const { md, db } = ctx;
  const last = md.sessions[md.sessions.length - 1];
  const axis = md.sessions.filter((d) => d >= p.start);
  if (axis.length < 2) return null;
  const cdi = cdiIndex(db, axis);
  const sim = weightsIndex(md, p.versions, axis, { cdi });
  const simTotal = weightsIndex(md, p.versions, axis, { cdi, reinvest: true });
  const thesis = p.thesis ? ctx.theses.find((t) => t.id === p.thesis) : undefined;

  const lines: { key: string; label: string; kind: LineKind; price: (number | null)[]; total: (number | null)[]; note?: string }[] = [
    { key: p.key, label: p.label, kind: 'hipotetica', price: sim.values, total: simTotal.values },
  ];
  if (thesis) {
    const ids = new Set(thesis.tickers.map((t) => md.assetId(t)).filter((x): x is number => x !== undefined));
    const idx = ids.size ? chainedIndex(md, ctx.snaps, axis, ids) : null;
    if (idx) lines.push({ key: thesis.id, label: thesis.title, kind: 'tese', price: idx.price, total: idx.total, note: 'posição real, desde a 1ª coleta' });
  }
  const refKeys = [...new Set(['CDI', p.compare ?? p.references[0] ?? 'IBOV', ...p.references, ...(thesis?.references ?? [])])];
  const refs = referenceLines(md, ctx.refFiles, axis, cdi);
  for (const k of refKeys) {
    const r = refs.find((x) => x.ref.key === k);
    if (r) lines.push({ key: k, label: r.ref.label, kind: 'referencia', price: r.values, total: r.total, note: r.income_missing.length ? 'só preço' : undefined });
  }

  // Todas começam em 0% no primeiro pregão da hipotética (a tese, se começar depois, no dela).
  const cut = Math.max(0, sim.values.findIndex((v) => v !== null));
  const dates = axis.slice(cut);
  const pctLines = lines.map((l) => ({ ...l, price: toPct(l.price, cut), total: toPct(l.total, cut) }));
  const compareKey = p.compare ?? p.references[0] ?? 'IBOV';
  const cmp = pctLines.find((l) => l.kind === 'referencia' && l.key === compareKey) ?? null;
  const rows = pctLines.map((l) => {
    const n = l.total.filter((v) => v !== null).length;
    const tot = lastOf(l.total);
    return {
      key: l.key,
      label: l.label,
      kind: l.kind,
      note: l.note ?? null,
      first_date: dates[l.total.findIndex((v) => v !== null)] ?? null,
      price_pct: lastOf(l.price),
      total_pct: tot,
      annualized_pct: tot !== null && n > SESSIONS_PER_YEAR ? ((1 + tot / 100) ** (SESSIONS_PER_YEAR / (n - 1)) - 1) * 100 : null,
      max_drawdown: maxDrawdown(l.total, dates),
      ...riskStats(l.total, dates, cmp && cmp !== l ? cmp.total : undefined),
    };
  });
  return {
    from: dates[0],
    to: last,
    dates,
    compare: cmp && { key: cmp.key, label: cmp.label },
    lines: pctLines,
    rows,
    rebalances: sim.rebalances,
  };
}

export type ComparisonWindow = NonNullable<ReturnType<typeof compareWindow>>;

/** Tickers sem cadastro (nem cotação): o importador do COTAHIST os inclui na próxima carga. */
function unknownTickers(md: MarketData, versions: WeightVersion[]) {
  return [...new Set(versions.flatMap((v) => v.weights.map((w) => w.ticker)))].filter((t) => t !== CASH_TICKER && md.assetId(t) === undefined);
}

/** Todas as hipotéticas, com o estado de cada vigência, o acompanhamento e o backtest. */
export function buildHypotheticals(db: DB, researchDir: string | undefined, opts: { compare?: string } = {}) {
  const ctx = context(db, researchDir);
  const { files, warnings } = readHypotheticalFiles(researchDir ? join(researchDir, 'hipoteticas') : undefined);
  const last = ctx.md.sessions[ctx.md.sessions.length - 1] ?? localToday();
  const list = files.map((f) => {
    const rec = recordedOf(db, f.key);
    const recBy = new Map(rec.map((r) => [r.effective_on, r]));
    const fileBy = new Map(f.versions.map((v) => [v.from, v]));
    const versions = [
      ...f.versions.map((v) => {
        const r = recBy.get(v.from);
        const state = !r ? 'pendente' : r.weights !== canonical(v.weights) ? 'alterada' : r.recorded_on > v.from ? 'tardia' : 'registrada';
        return { from: v.from, assets: v.weights.length, recorded_on: r?.recorded_on ?? null, applies_on: r ? (r.recorded_on > v.from ? r.recorded_on : v.from) : null, state };
      }),
      ...rec
        .filter((r) => !fileBy.has(r.effective_on))
        .map((r) => ({ from: r.effective_on, assets: (JSON.parse(r.weights) as unknown[]).length, recorded_on: r.recorded_on, applies_on: r.recorded_on > r.effective_on ? r.recorded_on : r.effective_on, state: 'removida' })),
    ].sort((a, b) => a.from.localeCompare(b.from));

    // Acompanhamento: o que foi registrado, valendo a partir do registro.
    const forwardVersions = rec
      .map((r) => ({ from: r.recorded_on > r.effective_on ? r.recorded_on : r.effective_on, weights: JSON.parse(r.weights) as WeightVersion['weights'] }))
      .sort((a, b) => a.from.localeCompare(b.from));
    const fStart = forwardVersions[0]?.from ?? null;
    const base = { key: f.key, label: f.label, thesis: f.thesis, references: f.references, compare: opts.compare };
    const forward = fStart ? compareWindow(ctx, { ...base, versions: expandRebalance(forwardVersions, f.rebalance, last), start: fStart }) : null;
    // Backtest: o arquivo como está escrito.
    const bStart = f.versions[0]?.from ?? null;
    const backtest = bStart ? compareWindow(ctx, { ...base, versions: expandRebalance(f.versions, f.rebalance, last), start: bStart }) : null;

    const fileWarnings = [...f.warnings];
    const unknown = unknownTickers(ctx.md, f.versions);
    if (unknown.length) fileWarnings.push(`Sem cadastro nem cotação: ${unknown.join(', ')}. O importador do COTAHIST inclui esses códigos na próxima carga.`);
    if (f.thesis && !ctx.theses.some((t) => t.id === f.thesis)) fileWarnings.push(`Tese ${f.thesis} não encontrada em research/teses/.`);
    if (versions.some((v) => v.state === 'alterada')) fileWarnings.push('Há vigência alterada depois do registro: o acompanhamento segue com a versão registrada; o backtest usa o arquivo.');
    if (versions.some((v) => v.state === 'pendente')) fileWarnings.push('Há vigência ainda não registrada: entra no acompanhamento só a partir do dia do registro.');
    return {
      key: f.key,
      label: f.label,
      thesis: f.thesis,
      references: f.references,
      rebalance: f.rebalance,
      file: f.file,
      registered_on: rec[0]?.recorded_on ?? null,
      versions,
      warnings: fileWarnings,
      forward: forward ?? (fStart ? { pending: true as const, starts_on: fStart } : null),
      backtest,
    };
  });
  return { as_of: last, hypotheticals: list, warnings };
}

/** Backtest avulso, sem arquivo: pesos (e, opcionalmente, vigências) recebidos na chamada. */
export function runBacktest(
  db: DB,
  researchDir: string | undefined,
  p: { versions: WeightVersion[]; from?: string; rebalance?: Rebalance; thesis?: string | null; references?: string[]; compare?: string; label?: string },
) {
  const ctx = context(db, researchDir);
  const last = ctx.md.sessions[ctx.md.sessions.length - 1];
  if (!last) return { ok: false as const, error: 'Nenhuma cotação importada.' };
  const versions = [...p.versions].sort((a, b) => a.from.localeCompare(b.from));
  const start = p.from ?? versions[0]?.from;
  if (!start) return { ok: false as const, error: 'Sem pesos.' };
  const w = compareWindow(ctx, {
    key: '_backtest',
    label: p.label ?? 'Backtest',
    versions: expandRebalance(versions, p.rebalance ?? 'nenhum', last),
    start,
    thesis: p.thesis ?? null,
    references: p.references ?? [],
    compare: p.compare,
  });
  if (!w) return { ok: false as const, error: `Não há pregões com cotação a partir de ${start}.` };
  return { ok: true as const, unknown_tickers: unknownTickers(ctx.md, versions), ...w };
}

/** Tickers das hipotéticas, para o importador do COTAHIST trazer as cotações. */
export function hypotheticalTickers(researchDir: string | undefined): string[] {
  const { files } = readHypotheticalFiles(researchDir ? join(researchDir, 'hipoteticas') : undefined);
  return [...new Set(files.flatMap((f) => f.versions.flatMap((v) => v.weights.map((w) => w.ticker))))].filter((t) => t !== CASH_TICKER);
}
