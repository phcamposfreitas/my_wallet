import { z } from 'zod';
import { inTransaction, type DB } from '../db.ts';
import { localToday } from '../dates.ts';

/**
 * Séries do Banco Central pelo SGS (Sistema Gerenciador de Séries Temporais):
 *   https://api.bcb.gov.br/dados/serie/bcdata.sgs.<código>/dados?formato=json&dataInicial=dd/mm/aaaa&dataFinal=dd/mm/aaaa
 *
 * Comportamento da API (conferido em nov/2026):
 * - Série diária aceita no máximo 10 anos por consulta (acima disso, HTTP 406).
 *   Pedimos um ano civil por vez, o que serve para qualquer periodicidade.
 * - Janela sem dados (fim de semana, IPCA do mês ainda não divulgado) responde
 *   HTTP 404 "Value(s) not found": é tratada como vazia, não como erro.
 * - Datas vêm como dd/mm/aaaa e valores como texto com ponto decimal.
 *
 * Gravação idempotente: upsert por (código, data). Repetir a importação não muda nada;
 * um valor revisado pela fonte é atualizado. Se uma consulta falhar, nada daquela
 * série é gravado (as outras seguem).
 */

export interface SeriesDef {
  code: string;
  sgs: number;
  unit: string;
  description: string;
}

export const SGS_SERIES: readonly SeriesDef[] = [
  { code: 'CDI', sgs: 12, unit: '% a.d.', description: 'CDI (taxa DI) diário' },
  { code: 'SELIC', sgs: 11, unit: '% a.d.', description: 'Selic diária (taxa efetiva)' },
  { code: 'SELIC_META', sgs: 432, unit: '% a.a.', description: 'Meta da Selic definida pelo Copom' },
  { code: 'IPCA', sgs: 433, unit: '% a.m.', description: 'IPCA, variação mensal (data = 1º dia do mês de referência)' },
  { code: 'IPCA_12M', sgs: 13522, unit: '%', description: 'IPCA acumulado em 12 meses (data = 1º dia do mês de referência)' },
  { code: 'DOLAR_PTAX', sgs: 1, unit: 'R$/US$', description: 'Dólar americano, PTAX venda' },
];

export function findSeries(code: string): SeriesDef | undefined {
  return SGS_SERIES.find((s) => s.code === code.trim().toUpperCase());
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const toBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const fromBr = (br: string) => `${br.slice(6, 10)}-${br.slice(3, 5)}-${br.slice(0, 2)}`;

export function sgsUrl(sgs: number, from: string, to: string): string {
  return `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${sgs}/dados?formato=json&dataInicial=${toBr(from)}&dataFinal=${toBr(to)}`;
}

/** Quebra [from, to] em janelas de um ano civil. */
export function yearWindows(from: string, to: string): Array<[string, string]> {
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  const out: Array<[string, string]> = [];
  for (let y = y0; y <= y1; y++) out.push([y === y0 ? from : `${y}-01-01`, y === y1 ? to : `${y}-12-31`]);
  return out;
}

const responseSchema = z.array(z.object({ data: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/), valor: z.string() }));

interface Window {
  points: Array<{ date: string; value: number }>;
  skipped: number;
}

/** Mensagem legível de uma resposta de erro do SGS (JSON com error/erro.detail, ou HTML). */
function describeBody(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown; erro?: { detail?: unknown } };
    const msg = j.error ?? j.erro?.detail;
    if (typeof msg === 'string') return msg;
  } catch {
    // não é JSON
  }
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function parseWindow(text: string): Window {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`resposta não é JSON: ${describeBody(text)}`);
  }
  const rows = responseSchema.safeParse(json);
  if (!rows.success) throw new Error('resposta em formato inesperado');
  const out: Window = { points: [], skipped: 0 };
  for (const r of rows.data) {
    const value = r.valor.trim() === '' ? NaN : Number(r.valor);
    if (Number.isFinite(value)) out.points.push({ date: fromBr(r.data), value });
    else out.skipped++;
  }
  return out;
}

class PermanentError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Uma janela, com até 3 tentativas para falha de rede, HTTP 429 e 5xx. */
async function fetchWindow(fetchFn: FetchFn, url: string, retryDelayMs: number): Promise<Window> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.status === 404 && /not found/i.test(text)) return { points: [], skipped: 0 };
      if (res.ok) return parseWindow(text);
      const message = `HTTP ${res.status}: ${describeBody(text)}`;
      if (res.status !== 429 && res.status < 500) throw new PermanentError(message);
      last = new Error(message);
    } catch (e) {
      if (e instanceof PermanentError) throw e;
      last = e;
    }
    if (attempt < 3) await sleep(retryDelayMs * attempt);
  }
  const err = last as Error & { cause?: { code?: string } };
  throw new Error(err.cause?.code ? `${err.message} (${err.cause.code})` : err.message);
}

export interface SeriesImportOptions {
  /** Data inicial (ISO). Sem ela, cada série continua da última data gravada. */
  from?: string;
  /** Data final (ISO). Padrão: hoje. */
  to?: string;
  /** Códigos de SGS_SERIES (ex.: ['CDI', 'IPCA']). Padrão: todos. */
  codes?: string[];
  fetch?: FetchFn;
  /** Espera entre tentativas, multiplicada pelo número da tentativa. Padrão: 1 s. */
  retryDelayMs?: number;
}

export interface SeriesImportResult {
  code: string;
  sgs: number;
  from: string | null;
  to: string;
  requests: number;
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  first_date: string | null;
  last_date: string | null;
  error: string | null;
}

export async function importSeries(db: DB, opts: SeriesImportOptions = {}): Promise<{ ok: boolean; results: SeriesImportResult[] }> {
  const defs = opts.codes?.length
    ? [...new Set(opts.codes.map((c) => c.trim().toUpperCase()))].map((c) => {
        const def = findSeries(c);
        if (!def) throw new Error(`Série desconhecida: ${c}. Disponíveis: ${SGS_SERIES.map((s) => s.code).join(', ')}`);
        return def;
      })
    : SGS_SERIES;
  const to = opts.to ?? localToday();
  const results: SeriesImportResult[] = [];
  for (const def of defs) results.push(await importOne(db, def, opts.from, to, opts.fetch ?? fetch, opts.retryDelayMs ?? 1000));
  return { ok: results.every((r) => !r.error), results };
}

async function importOne(
  db: DB,
  def: SeriesDef,
  fromOpt: string | undefined,
  to: string,
  fetchFn: FetchFn,
  retryDelayMs: number,
): Promise<SeriesImportResult> {
  const r: SeriesImportResult = {
    code: def.code,
    sgs: def.sgs,
    from: null,
    to,
    requests: 0,
    received: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    first_date: null,
    last_date: null,
    error: null,
  };
  // Sem data inicial, recomeça na última data gravada (inclusive): o ponto é reconferido.
  const last = (db.prepare('SELECT MAX(date) AS d FROM series WHERE code = ?').get(def.code) as { d: string | null }).d;
  const from = fromOpt ?? last;
  if (!from) return { ...r, error: 'Série ainda sem dados: informe a data inicial (--desde / from)' };
  r.from = from;
  if (from > to) return { ...r, error: `Data inicial ${from} posterior à final ${to}` };

  const points = new Map<string, number>();
  try {
    for (const [a, b] of yearWindows(from, to)) {
      r.requests++;
      const w = await fetchWindow(fetchFn, sgsUrl(def.sgs, a, b), retryDelayMs);
      r.skipped += w.skipped;
      for (const p of w.points) if (p.date >= from && p.date <= to) points.set(p.date, p.value);
    }
  } catch (e) {
    return { ...r, error: `SGS ${def.sgs}: ${(e as Error).message}` };
  }

  const source = `bcb-sgs:${def.sgs}`;
  const existing = new Map(
    (
      db.prepare('SELECT date, value, source FROM series WHERE code = ? AND date BETWEEN ? AND ?').all(def.code, from, to) as {
        date: string;
        value: number;
        source: string;
      }[]
    ).map((x) => [x.date, x]),
  );
  const upsert = db.prepare(
    `INSERT INTO series (code, date, value, source, collected_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (code, date) DO UPDATE SET value = excluded.value, source = excluded.source, collected_at = excluded.collected_at`,
  );
  inTransaction(db, () => {
    // Vocabulário: unidade e descrição do código ficam no próprio banco.
    db.prepare(
      `INSERT INTO indicators (table_name, code, unit, description) VALUES ('series', ?, ?, ?)
       ON CONFLICT (table_name, code) DO UPDATE SET unit = excluded.unit, description = excluded.description`,
    ).run(def.code, def.unit, `${def.description} (BCB SGS ${def.sgs})`);
    for (const [date, value] of points) {
      const old = existing.get(date);
      if (old && old.value === value && old.source === source) {
        r.unchanged++;
        continue;
      }
      upsert.run(def.code, date, value, source);
      if (old) r.updated++;
      else r.inserted++;
    }
  });
  const dates = [...points.keys()].sort();
  return { ...r, received: points.size, first_date: dates[0] ?? null, last_date: dates.at(-1) ?? null };
}
