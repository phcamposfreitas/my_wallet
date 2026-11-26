import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.ts';
import { buildTheses, parseFrontMatter } from './theses.ts';

/**
 * Carteiras de referência: contra o que a carteira, as teses e os blocos são comparados.
 *
 * Dois tipos:
 * - `serie`: uma série de preço pronta (CDI ou um ETF negociado na B3). Vira índice diário
 *   no mesmo eixo da carteira (ver performance.ts).
 * - `composicao`: uma lista de ativos com peso e data de vigência, como as carteiras
 *   recomendadas das casas ou a carteira teórica de um índice. É simulada dia a dia pelo motor
 *   de índice (weightsIndex em price-index.ts) e serve também para a sobreposição (active share).
 *
 * As séries embutidas ficam abaixo. As da pasta `research/referencias/` (uma por arquivo
 * markdown, fora do git) somam-se a elas: o conteúdo das casas é do titular e costuma ser pago.
 *
 * Formato do arquivo:
 *
 *   ---
 *   id: casa-dividendos
 *   titulo: Carteira Dividendos (Casa X)
 *   tipo: composicao            # ou serie
 *   ticker: DIVO11              # só em `serie`
 *   fonte: Casa X Research
 *   url: https://...
 *   ---
 *   | vigencia   | ativo | peso |
 *   |------------|-------|------|
 *   | 2026-11-03 | ITUB4 | 10   |
 *
 * A vigência é a data em que a carteira foi publicada, não o 1º dia do mês: senão a
 * referência "sabe" o que aconteceu antes de existir.
 */

export interface SeriesReference {
  key: string;
  label: string;
  /** null = CDI (série do Banco Central); senão, o ticker do ETF na B3. */
  ticker: string | null;
  note: string;
  source: 'embutida' | 'arquivo';
}

/** ETFs da B3 usados como aproximação dos índices. Só preço: o que distribui rendimento fica subestimado. */
export const BUILTIN_REFERENCES: SeriesReference[] = [
  { key: 'CDI', label: 'CDI', ticker: null, note: 'Banco Central, série 12', source: 'embutida' },
  { key: 'IBOV', label: 'Ibovespa', ticker: 'BOVA11', note: 'pelo ETF BOVA11', source: 'embutida' },
  { key: 'IFIX', label: 'IFIX', ticker: 'XFIX11', note: 'pelo ETF XFIX11', source: 'embutida' },
  { key: 'IDIV', label: 'Dividendos (IDIV)', ticker: 'DIVO11', note: 'pelo ETF DIVO11', source: 'embutida' },
  { key: 'SMLL', label: 'Small caps (SMLL)', ticker: 'SMAL11', note: 'pelo ETF SMAL11', source: 'embutida' },
  { key: 'SP500', label: 'S&P 500 em reais', ticker: 'IVVB11', note: 'pelo ETF IVVB11', source: 'embutida' },
];

export interface CompositionReference {
  key: string;
  label: string;
  source_name: string | null;
  url: string | null;
  file: string;
  /** Vigências em ordem, cada uma com os pesos em % (normalizados para somar 100). */
  versions: { from: string; weights: { ticker: string; weight_pct: number }[]; raw_sum: number }[];
  warnings: string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Lê `research/referencias/*.md`. Arquivo que começa com `_` fica de fora (modelos, notas). */
export function readReferenceFiles(dir: string | undefined) {
  const series: SeriesReference[] = [];
  const compositions: CompositionReference[] = [];
  const warnings: string[] = [];
  if (!dir || !existsSync(dir)) return { series, compositions, warnings };
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort()) {
    const { meta, body } = parseFrontMatter(readFileSync(join(dir, file), 'utf8'));
    const str = (k: string) => (typeof meta[k] === 'string' && meta[k] ? (meta[k] as string) : null);
    const id = str('id');
    if (!id) {
      warnings.push(`${file}: sem id no cabeçalho; ignorado`);
      continue;
    }
    const label = str('titulo') ?? id;
    const tipo = str('tipo') ?? 'composicao';
    if (tipo === 'serie') {
      const ticker = str('ticker')?.toUpperCase();
      if (!ticker) warnings.push(`${file}: tipo serie sem ticker; ignorado`);
      else series.push({ key: id, label, ticker, note: str('fonte') ?? `pelo ticker ${ticker}`, source: 'arquivo' });
      continue;
    }
    if (tipo !== 'composicao') {
      warnings.push(`${file}: tipo "${tipo}" desconhecido (use serie ou composicao); ignorado`);
      continue;
    }
    compositions.push({ key: id, label, source_name: str('fonte'), url: str('url'), file, ...parseWeights(file, body) });
  }
  return { series, compositions, warnings };
}

/** Linhas `| vigência | ativo | peso |` do corpo. Peso aceita "10", "10,5" e "10%". */
export function parseWeights(file: string, body: string) {
  const warnings: string[] = [];
  const byDate = new Map<string, Map<string, number>>();
  for (const line of body.split(/\r?\n/)) {
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length < 3 || !DATE.test(cells[0])) continue;
    const ticker = cells[1].toUpperCase();
    const weight = Number(cells[2].replace('%', '').replace(',', '.'));
    if (!ticker || !Number.isFinite(weight) || weight <= 0) {
      warnings.push(`${file}: linha ignorada: ${line.trim()}`);
      continue;
    }
    if (!byDate.has(cells[0])) byDate.set(cells[0], new Map());
    const m = byDate.get(cells[0])!;
    m.set(ticker, (m.get(ticker) ?? 0) + weight);
  }
  const versions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([from, m]) => {
      const sum = [...m.values()].reduce((s, v) => s + v, 0);
      if (Math.abs(sum - 100) > 0.5) warnings.push(`${file}: pesos de ${from} somam ${sum.toFixed(2)}%; normalizados para 100%`);
      return {
        from,
        raw_sum: sum,
        weights: [...m.entries()].map(([ticker, w]) => ({ ticker, weight_pct: (w / sum) * 100 })).sort((a, b) => b.weight_pct - a.weight_pct),
      };
    });
  if (!versions.length) warnings.push(`${file}: nenhuma linha de peso (| vigência | ativo | peso |)`);
  return { versions, warnings };
}

/** Tickers que precisam de cotação diária por causa das referências (para o importador do COTAHIST). */
export function referenceTickers(researchDir: string | undefined): string[] {
  const files = readReferenceFiles(researchDir ? join(researchDir, 'referencias') : undefined);
  const out = new Set<string>();
  for (const r of [...BUILTIN_REFERENCES, ...files.series]) if (r.ticker) out.add(r.ticker);
  for (const c of files.compositions) for (const v of c.versions) for (const w of v.weights) out.add(w.ticker);
  return [...out].sort();
}

/** Catálogo de séries: as embutidas mais as dos arquivos (chave repetida: vale a do arquivo). */
export function seriesCatalog(files: { series: SeriesReference[] }) {
  const byKey = new Map(BUILTIN_REFERENCES.map((r) => [r.key, r]));
  for (const r of files.series) byKey.set(r.key, r);
  return [...byKey.values()];
}

/**
 * Active share: metade da soma das diferenças absolutas de peso. 0% = carteira igual à
 * referência; 100% = nenhum ativo em comum. Os dois lados são normalizados para somar 100.
 */
export function activeShare(group: Map<string, number>, ref: Map<string, number>) {
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
  const g = sum(group);
  const r = sum(ref);
  if (!g || !r) return null;
  let diff = 0;
  const common: { ticker: string; group_pct: number; ref_pct: number }[] = [];
  for (const t of new Set([...group.keys(), ...ref.keys()])) {
    const a = ((group.get(t) ?? 0) / g) * 100;
    const b = ((ref.get(t) ?? 0) / r) * 100;
    diff += Math.abs(a - b);
    if (a && b) common.push({ ticker: t, group_pct: a, ref_pct: b });
  }
  return { active_share_pct: diff / 2, common: common.sort((x, y) => y.ref_pct - x.ref_pct) };
}

const LISTED = ['acao', 'fii', 'etf', 'bdr'];

/**
 * Sobreposição de cada tese, de cada bloco e da carteira com cada carteira de composição, na
 * última coleta e na vigência mais recente até ela. A carteira inteira é medida só no recorte
 * comparável: as classes de ativo que a referência tem (ações, FIIs...), não o Tesouro.
 */
export function buildReferences(db: DB, researchDir: string | undefined) {
  const files = readReferenceFiles(researchDir ? join(researchDir, 'referencias') : undefined);
  const t = buildTheses(db, researchDir ? join(researchDir, 'teses') : undefined);
  const asOf = t.as_of.snapshot?.slice(0, 10) ?? null;
  const classOf = new Map((db.prepare('SELECT ticker, asset_class FROM assets').all() as { ticker: string; asset_class: string }[]).map((a) => [a.ticker, a.asset_class]));
  const portfolio = [...t.theses.flatMap((x) => x.assets), ...t.unassigned.assets];
  const unique = new Map(portfolio.map((a) => [a.ticker, a]));

  const compositions = files.compositions.map((c) => {
    const version = [...c.versions].reverse().find((v) => !asOf || v.from <= asOf) ?? null;
    const ref = new Map((version?.weights ?? []).map((w) => [w.ticker, w.weight_pct]));
    const refClasses = [...new Set([...ref.keys()].map((k) => classOf.get(k)).filter((x): x is string => !!x))];
    const slice = refClasses.length ? refClasses : LISTED;
    const walletSlice = new Map([...unique.values()].filter((a) => slice.includes(a.asset_class)).map((a) => [a.ticker, a.value_cents]));
    const row = (key: string, label: string, kind: 'carteira' | 'tese' | 'bloco', m: Map<string, number>, declared = false) => {
      const s = activeShare(m, ref);
      return { key, label, kind, declared, active_share_pct: s?.active_share_pct ?? null, common: s?.common ?? [] };
    };
    const byId = new Map(t.theses.map((x) => [x.id, x]));
    const toMap = (assets: { ticker: string; value_cents: number }[]) => new Map(assets.map((a) => [a.ticker, a.value_cents]));
    return {
      key: c.key,
      label: c.label,
      source_name: c.source_name,
      url: c.url,
      file: c.file,
      version: version && { from: version.from, assets: version.weights.length, weights: version.weights },
      versions: c.versions.map((v) => v.from),
      classes: slice,
      /** Ativos da referência que a carteira não tem, por peso. */
      not_held: (version?.weights ?? []).filter((w) => !unique.has(w.ticker)).slice(0, 10),
      warnings: c.warnings,
      rows: [
        row('_carteira', `Carteira (${slice.join(', ')})`, 'carteira', walletSlice),
        ...t.theses.map((x) => row(x.id, x.title, 'tese', toMap(x.assets), x.references.includes(c.key))),
        ...t.blocks.map((b) => row(`bloco:${b.name ?? '_sem'}`, b.name ?? 'Sem bloco', 'bloco', toMap(b.theses.flatMap((id) => byId.get(id)?.assets ?? [])))),
      ],
    };
  });

  return {
    as_of: asOf,
    series: seriesCatalog(files),
    compositions,
    warnings: files.warnings,
  };
}
