import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline as pipe, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createInflateRaw } from 'node:zlib';
import { inTransaction, type DB } from '../db.ts';
import { isIsoDate } from '../dates.ts';
import type { FetchFn } from './sgs.ts';

/**
 * Cotações históricas da B3 (COTAHIST): texto de largura fixa, registros de 245
 * posições (layout "Séries Históricas" da B3). Tipo 00 = cabeçalho, 01 = cotação de
 * um papel num pregão, 99 = trailer com o total de registros 01. O diário é
 * COTAHIST_D<DDMMAAAA>.ZIP; o mensal (M<MMAAAA>) e o anual (A<AAAA>) têm o mesmo layout
 * e servem para carregar histórico. O ZIP é lido em fluxo, sem descompactar tudo na memória.
 *
 * Regras da importação:
 * - Arquivo sem o trailer está incompleto e é recusado inteiro.
 * - Só o mercado à vista (TPMERC 010). Todos os outros ficam de fora: fracionário (020),
 *   opções (070/080) e seus exercícios (012/013), termo (030), 021 etc.
 * - Só tickers cadastrados em assets, mais os de referência: BOVA11 e XFIX11 (aproximações
 *   de Ibovespa e IFIX) e os que o chamador pedir em `extraTickers` (ETFs de referência e
 *   ativos das carteiras de composição, ver references.ts). Os que ainda não existem são
 *   cadastrados na primeira importação, com a classe pelo código BDI do arquivo.
 * - Grava o fechamento (PREULT) por unidade: preço ÷ fator de cotação (FATCOT,
 *   1 = cotação unitária, 100 ou 1000 = por lote). Se a divisão deixar fração de
 *   centavo (ex.: direito de subscrição a R$ 0,11 por lote de 100), a cotação é
 *   ignorada com aviso em vez de arredondada.
 * - Idempotente: upsert por (ativo, pregão).
 */

export const COTAHIST_URL = 'https://bvmf.bmfbovespa.com.br/InstDados/SerHist/';
export const BENCHMARK_TICKERS = { IBOVESPA: 'BOVA11', IFIX: 'XFIX11' } as const;
export const PRICE_SOURCE = 'b3:cotahist';
const MARKET_SPOT = '010';
/** Classes negociadas em bolsa: se não aparecem no arquivo, entram em `not_found`. */
const LISTED_CLASSES = new Set(['acao', 'fii', 'etf', 'bdr']);

/** Nome do arquivo na B3 para um período: 'AAAA-MM-DD' (diário), 'AAAA-MM' (mensal) ou 'AAAA' (anual). */
export function cotahistFileName(period: string): string {
  let m: RegExpMatchArray | null;
  if ((m = period.match(/^(\d{4})-(\d{2})-(\d{2})$/)) && isIsoDate(period)) return `COTAHIST_D${m[3]}${m[2]}${m[1]}.ZIP`;
  if ((m = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/))) return `COTAHIST_M${m[2]}${m[1]}.ZIP`;
  if ((m = period.match(/^(\d{4})$/))) return `COTAHIST_A${m[1]}.ZIP`;
  throw new Error(`Período inválido: "${period}". Use AAAA-MM-DD (diário), AAAA-MM (mensal) ou AAAA (anual).`);
}

/** Baixa o arquivo do período para `dir` e devolve o caminho. Não importa nada. */
export async function downloadCotahist(period: string, dir: string, fetchFn: FetchFn = fetch): Promise<string> {
  const name = cotahistFileName(period);
  const res = await fetchFn(COTAHIST_URL + name, { signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status === 404) throw new Error(`${name}: não existe na B3 (dia sem pregão ou arquivo ainda não publicado)`);
  if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
  const dest = join(dir, name);
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(part));
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  return dest;
}

export interface CotahistQuote {
  date: string; // pregão
  codbdi: string; // código BDI (ex.: 02 ações, 12 FII, 14 ETF, 96 fracionário)
  ticker: string; // CODNEG
  market: string; // TPMERC (010 à vista, 020 fracionário, 070/080 opções...)
  name: string; // NOMRES
  spec: string; // ESPECI (ON, PN, CI...)
  close: number; // PREULT em centavos, por lote de `quote_factor` unidades
  trades: number; // TOTNEG
  volume_cents: number; // VOLTOT
  quote_factor: number; // FATCOT
  isin: string; // CODISI
}

/** Lê um registro de cotação (tipo 01). Devolve null para cabeçalho, trailer ou linha curta. */
export function parseCotahistLine(line: string): CotahistQuote | null {
  if (line.length < 245 || !line.startsWith('01')) return null;
  const int = (a: number, b: number) => {
    const s = line.slice(a, b);
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };
  const d = line.slice(2, 10);
  return {
    date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
    codbdi: line.slice(10, 12).trim(),
    ticker: line.slice(12, 24).trim(),
    market: line.slice(24, 27),
    name: line.slice(27, 39).trim(),
    spec: line.slice(39, 49).trim(),
    close: int(108, 121),
    trades: int(147, 152),
    volume_cents: int(170, 188),
    quote_factor: int(210, 217),
    isin: line.slice(230, 242).trim(),
  };
}

// --- Leitura do arquivo (ZIP ou TXT) ------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const ZIP64 = 'ZIP64 não suportado: descompacte o arquivo e importe o .TXT';

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  if (readSync(fd, buf, 0, length, position) < length) throw new Error('ZIP truncado');
  return buf;
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  dataOffset: number;
}

/** Acha o .TXT dentro do ZIP pelo diretório central. Devolve null se o arquivo não for ZIP. */
function zipEntry(fd: number): ZipEntry | null {
  const size = fstatSync(fd).size;
  if (size < 4 || readAt(fd, 0, 4).readUInt32LE(0) !== SIG_LOCAL) return null;
  const tailLen = Math.min(size, 22 + 0xffff); // registro final + comentário de até 64 KB
  const tail = readAt(fd, size - tailLen, tailLen);
  let end = -1;
  for (let i = tailLen - 22; i >= 0 && end < 0; i--) if (tail.readUInt32LE(i) === SIG_END) end = i;
  if (end < 0) throw new Error('ZIP inválido: diretório central não encontrado');
  const count = tail.readUInt16LE(end + 10);
  const cdOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error(ZIP64);
  const cd = readAt(fd, cdOffset, tail.readUInt32LE(end + 12));

  const entries: Array<{ name: string; method: number; compressedSize: number; localOffset: number }> = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP inválido: diretório central corrompido');
    const nameLen = cd.readUInt16LE(p + 28);
    entries.push({
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      localOffset: cd.readUInt32LE(p + 42),
      name: cd.toString('latin1', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
  }
  const e = entries.find((x) => /\.txt$/i.test(x.name)) ?? entries.find((x) => !x.name.endsWith('/'));
  if (!e || e.compressedSize === 0) throw new Error('ZIP sem arquivo de cotações');
  if (e.compressedSize === 0xffffffff || e.localOffset === 0xffffffff) throw new Error(ZIP64);
  if (e.method !== 0 && e.method !== 8) throw new Error(`ZIP com compressão não suportada (método ${e.method})`);
  const local = readAt(fd, e.localOffset, 30);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error('ZIP inválido: cabeçalho local não encontrado');
  return {
    method: e.method,
    compressedSize: e.compressedSize,
    dataOffset: e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
  };
}

function openCotahist(path: string): Readable {
  const fd = openSync(path, 'r');
  let entry: ZipEntry | null;
  try {
    entry = zipEntry(fd);
  } finally {
    closeSync(fd);
  }
  if (!entry) return createReadStream(path, { encoding: 'latin1' });
  const raw = createReadStream(path, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  if (entry.method === 0) return raw.setEncoding('latin1');
  const inflate = createInflateRaw();
  inflate.setEncoding('latin1');
  pipe(raw, inflate, () => {}); // um erro destrói `inflate` e chega a quem o itera
  return inflate;
}

/**
 * Linhas do arquivo (ZIP ou texto), em latin1 e sem o fim de linha (CRLF ou LF). Do ZIP lê a
 * primeira entrada .TXT, ou a primeira entrada se não houver (serve também ao CSV da CVM).
 */
export async function* readCotahistLines(path: string): AsyncGenerator<string> {
  let rest = '';
  for await (const chunk of openCotahist(path)) {
    const parts = (rest + (chunk as string)).split('\n');
    rest = parts.pop()!;
    for (const p of parts) yield p.endsWith('\r') ? p.slice(0, -1) : p;
  }
  if (rest) yield rest.endsWith('\r') ? rest.slice(0, -1) : rest;
}

/** Um arquivo, ou os COTAHIST_*.ZIP/TXT de uma pasta. Lança erro se o caminho não existir. */
export function cotahistFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path)
    .filter((f) => /^COTAHIST_.*\.(zip|txt)$/i.test(f))
    .sort()
    .map((f) => join(path, f));
}

// --- Importação -----------------------------------------------------------------

export interface CotahistReport {
  file: string;
  status: 'importado' | 'erro';
  error: string | null;
  /** Pregões presentes no arquivo. */
  first_date: string | null;
  last_date: string | null;
  sessions: number;
  /** Registros de cotação (tipo 01) lidos, de todos os papéis e mercados. */
  quotes_read: number;
  /** Cotações à vista de tickers acompanhados: inserted + updated + unchanged + ignored. */
  matched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Ignoradas porque o preço por unidade teria fração de centavo (ver warnings). */
  ignored: number;
  /** Tickers com fechamento gravado. */
  tickers: string[];
  /** Referências (BOVA11, XFIX11) cadastradas em assets nesta importação. */
  created_assets: string[];
  /** Ações, FIIs, ETFs e BDRs cadastrados sem cotação à vista no arquivo. */
  not_found: string[];
  warnings: string[];
}

function emptyReport(file: string): CotahistReport {
  return {
    file,
    status: 'importado',
    error: null,
    first_date: null,
    last_date: null,
    sessions: 0,
    quotes_read: 0,
    matched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    ignored: 0,
    tickers: [],
    created_assets: [],
    not_found: [],
    warnings: [],
  };
}

const isoFromB3 = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/** Lê o arquivo e separa as cotações à vista dos tickers acompanhados (uma por ticker e pregão). */
async function scan(path: string, wanted: Set<string>, report: CotahistReport): Promise<CotahistQuote[]> {
  const quotes = new Map<string, CotahistQuote>();
  const sessions = new Set<string>();
  let header = false;
  let trailerCount: number | null = null;
  let malformed = 0;
  for await (const line of readCotahistLines(path)) {
    if (!header) {
      if (!line.startsWith('00COTAHIST')) throw new Error('Não é um arquivo COTAHIST da B3 (cabeçalho ausente)');
      header = true;
      continue;
    }
    if (line.startsWith('99')) {
      trailerCount = Number(line.slice(31, 42)); // TOTAL DE REGISTROS (só os do tipo 01)
      continue;
    }
    if (!line.startsWith('01')) continue;
    report.quotes_read++;
    sessions.add(line.slice(2, 10));
    // Filtros baratos antes de decodificar o registro inteiro (o arquivo anual tem milhões de linhas).
    if (line.slice(24, 27) !== MARKET_SPOT || !wanted.has(line.slice(12, 24).trim())) continue;
    const q = parseCotahistLine(line);
    if (!q || !isIsoDate(q.date) || !(q.close > 0) || !(q.quote_factor >= 1)) {
      malformed++;
      continue;
    }
    const key = `${q.ticker} ${q.date}`;
    const prev = quotes.get(key);
    if (prev) report.warnings.push(`${q.ticker} ${q.date}: mais de um registro à vista; mantido o de maior volume`);
    if (!prev || q.volume_cents > prev.volume_cents) quotes.set(key, q);
  }
  if (!header) throw new Error('Arquivo vazio');
  if (trailerCount === null) throw new Error('Arquivo incompleto: falta o registro final (tipo 99). Baixe de novo.');
  if (trailerCount !== report.quotes_read) {
    report.warnings.push(`O registro final indica ${trailerCount} cotações, mas foram lidas ${report.quotes_read}`);
  }
  if (malformed) report.warnings.push(`${malformed} registro(s) de tickers acompanhados com campos inválidos, ignorado(s)`);
  const days = [...sessions].sort();
  report.sessions = days.length;
  report.first_date = days.length ? isoFromB3(days[0]) : null;
  report.last_date = days.length ? isoFromB3(days[days.length - 1]) : null;
  report.matched = quotes.size;
  return [...quotes.values()].sort((a, b) => a.ticker.localeCompare(b.ticker) || a.date.localeCompare(b.date));
}

/** Classe pelo código BDI: 02 lote padrão (ações), 12 FII, 14 ETF/fundos de índice. BOVA11/XFIX11 são sempre ETF. */
const CLASS_BY_BDI: Record<string, [string, string | null]> = { '02': ['acao', null], '12': ['fii', 'FII'], '14': ['etf', 'ETF'] };

/** Referência ainda não cadastrada: entra com nome e ISIN do próprio arquivo. */
function createBenchmarkAsset(db: DB, q: CotahistQuote): number {
  const isinFree = q.isin !== '' && !db.prepare('SELECT 1 FROM assets WHERE isin = ?').get(q.isin);
  const benchmark = (Object.values(BENCHMARK_TICKERS) as string[]).includes(q.ticker);
  const [assetClass, kind] = benchmark ? ['etf', 'ETF'] : (CLASS_BY_BDI[q.codbdi] ?? ['outro', null]);
  return Number(
    db
      .prepare('INSERT INTO assets (ticker, name, isin, isin_source, asset_class, kind) VALUES (?, ?, ?, ?, ?, ?)')
      .run(q.ticker, q.name || null, isinFree ? q.isin : null, isinFree ? PRICE_SOURCE : null, assetClass, kind ?? q.spec ?? null).lastInsertRowid,
  );
}

export async function importCotahist(db: DB, path: string, opts: { extraTickers?: string[] } = {}): Promise<CotahistReport> {
  const report = emptyReport(basename(path));
  try {
    const assets = db.prepare('SELECT id, ticker, asset_class FROM assets').all() as { id: number; ticker: string; asset_class: string }[];
    const idByTicker = new Map(assets.map((a) => [a.ticker.trim().toUpperCase(), a.id]));
    const benchmarks: string[] = [...Object.values(BENCHMARK_TICKERS), ...(opts.extraTickers ?? []).map((t) => t.trim().toUpperCase())];
    const quotes = await scan(path, new Set([...idByTicker.keys(), ...benchmarks]), report);

    if (quotes.length) {
      const dates = quotes.map((q) => q.date).sort();
      inTransaction(db, () => {
        const existing = new Map(
          (
            db.prepare('SELECT asset_id, date, price_cents, source FROM prices WHERE date BETWEEN ? AND ?').all(dates[0], dates[dates.length - 1]) as {
              asset_id: number;
              date: string;
              price_cents: number;
              source: string | null;
            }[]
          ).map((p) => [`${p.asset_id} ${p.date}`, p]),
        );
        const upsert = db.prepare(
          `INSERT INTO prices (asset_id, date, price_cents, source) VALUES (?, ?, ?, ?)
           ON CONFLICT (asset_id, date) DO UPDATE SET price_cents = excluded.price_cents, source = excluded.source`,
        );
        const tickers = new Set<string>();
        for (const q of quotes) {
          if (q.close % q.quote_factor !== 0) {
            report.warnings.push(`${q.ticker} ${q.date}: fator de cotação ${q.quote_factor} deixa fração de centavo; cotação ignorada`);
            report.ignored++;
            continue;
          }
          let assetId = idByTicker.get(q.ticker);
          if (assetId === undefined) {
            assetId = createBenchmarkAsset(db, q);
            idByTicker.set(q.ticker, assetId);
            report.created_assets.push(q.ticker);
          }
          const price = q.close / q.quote_factor;
          const old = existing.get(`${assetId} ${q.date}`);
          tickers.add(q.ticker);
          if (old && old.price_cents === price && old.source === PRICE_SOURCE) {
            report.unchanged++;
            continue;
          }
          upsert.run(assetId, q.date, price, PRICE_SOURCE);
          if (old) report.updated++;
          else report.inserted++;
        }
        report.tickers = [...tickers];
      });
    }
    const found = new Set(quotes.map((q) => q.ticker));
    report.not_found = assets
      .filter((a) => LISTED_CLASSES.has(a.asset_class) && !found.has(a.ticker.trim().toUpperCase()))
      .map((a) => a.ticker)
      .sort();
    return report;
  } catch (e) {
    return { ...emptyReport(report.file), status: 'erro', error: (e as Error).message };
  }
}
