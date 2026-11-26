import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { isIsoDate, localToday } from '../dates.ts';
import { computeBenchmarks } from '../benchmarks.ts';
import { findSeries, importSeries, SGS_SERIES, type FetchFn } from '../importers/sgs.ts';
import { cotahistFiles, importCotahist, type CotahistReport } from '../importers/cotahist.ts';
import { buildReferences, referenceFunds, referenceTickers } from '../references.ts';
import { importMarketIncome } from '../importers/b3-proventos.ts';
import { importTesouro } from '../importers/tesouro.ts';
import { downloadCvm, ensureFundAssets, importCvmFile, type CvmReport } from '../importers/cvm-fundos.ts';
import { dirname, join } from 'node:path';

/**
 * Dados de mercado: séries do Banco Central (tabela series) e fechamentos da B3
 * (tabela prices). Leitura, importação e o comparativo com CDI, Ibovespa e IFIX.
 */

const date = z.string().refine(isIsoDate, 'Data deve ser YYYY-MM-DD válida');
/** "CDI, ipca" → ['CDI', 'IPCA'] */
const list = z.string().transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
const seriesCode = z
  .string()
  .transform((c) => c.trim().toUpperCase())
  .refine((c) => findSeries(c) !== undefined, (c) => ({ message: `Série desconhecida: ${c}. Disponíveis: ${SGS_SERIES.map((s) => s.code).join(', ')}` }));

function filters(column: { key: string; date: string }, q: { key?: string[]; from?: string; to?: string }) {
  const where: string[] = [];
  const args: string[] = [];
  if (q.key?.length) (where.push(`${column.key} IN (${q.key.map(() => '?').join(', ')})`), args.push(...q.key));
  if (q.from) (where.push(`${column.date} >= ?`), args.push(q.from));
  if (q.to) (where.push(`${column.date} <= ?`), args.push(q.to));
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function marketRoutes(app: FastifyInstance, db: DB, opts: { fetch?: FetchFn; researchDir?: string } = {}) {
  // --- Séries do Banco Central ---------------------------------------------------
  app.get('/series', async (req) => {
    const q = z.object({ code: list.optional(), from: date.optional(), to: date.optional() }).parse(req.query);
    const f = filters({ key: 'code', date: 'date' }, { key: q.code, from: q.from, to: q.to });
    return db.prepare(`SELECT code, date, value, source, collected_at FROM series ${f.sql} ORDER BY code, date`).all(...f.args);
  });

  /** Códigos disponíveis, com unidade e cobertura do que já foi importado. */
  app.get('/series/catalog', async () => {
    const stats = new Map(
      (
        db
          .prepare('SELECT code, COUNT(*) AS count, MIN(date) AS first_date, MAX(date) AS last_date, MAX(collected_at) AS collected_at FROM series GROUP BY code')
          .all() as { code: string }[]
      ).map((s) => [s.code, s]),
    );
    return SGS_SERIES.map((s) => ({ ...s, count: 0, first_date: null, last_date: null, collected_at: null, ...stats.get(s.code) }));
  });

  /** Busca no SGS e grava. Sem `from`, cada série continua da última data gravada. */
  app.post('/series/import', async (req, reply) => {
    const body = z
      .object({ from: date.optional(), to: date.optional(), codes: z.array(seriesCode).optional() })
      .refine((b) => !b.from || !b.to || b.from <= b.to, 'from deve ser anterior ou igual a to')
      .parse(req.body ?? {});
    const report = await importSeries(db, { ...body, fetch: opts.fetch });
    return reply.code(report.ok ? 200 : 502).send(report);
  });

  // --- Cotações (B3) -------------------------------------------------------------
  app.get('/prices', async (req) => {
    const q = z.object({ ticker: list.optional(), from: date.optional(), to: date.optional() }).parse(req.query);
    const f = filters({ key: 'a.ticker', date: 'p.date' }, { key: q.ticker, from: q.from, to: q.to });
    return db
      .prepare(
        `SELECT a.ticker, p.date, p.price_cents, p.source FROM prices p JOIN assets a ON a.id = p.asset_id
         ${f.sql} ORDER BY a.ticker, p.date`,
      )
      .all(...f.args);
  });

  /** Importa um COTAHIST já baixado: { "path": arquivo .ZIP/.TXT ou pasta com eles }. */
  app.post('/prices/import', async (req, reply) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(req.body);
    const full = resolve(path.replace(/^~(?=\/|$)/, homedir()));
    if (!existsSync(full)) return reply.code(400).send({ error: `Arquivo ou pasta não encontrado: ${full}` });
    const files = cotahistFiles(full);
    if (!files.length) return reply.code(400).send({ error: 'Nenhum arquivo COTAHIST_*.ZIP ou .TXT na pasta' });
    const results: CotahistReport[] = [];
    const extraTickers = referenceTickers(opts.researchDir);
    for (const file of files) results.push(await importCotahist(db, file, { extraTickers }));
    const ok = results.every((r) => r.status === 'importado');
    return reply.code(ok ? 200 : 422).send({ ok, results });
  });

  // --- Comparativo ---------------------------------------------------------------
  /** CDI acumulado e variação de BOVA11/XFIX11 entre `from` e `to` (padrão: hoje). */
  app.get('/benchmarks', async (req, reply) => {
    const q = z.object({ from: date, to: date.optional() }).parse(req.query);
    const to = q.to ?? localToday();
    if (q.from > to) return reply.code(400).send({ error: 'from deve ser anterior ou igual a to' });
    return computeBenchmarks(db, q.from, to);
  });

  // --- Proventos de mercado (B3), Tesouro Direto e fundos (CVM) --------------------
  app.get('/market-income', async (req) => {
    const q = z.object({ ticker: list.optional(), from: date.optional() }).parse(req.query);
    const f = filters({ key: 'a.ticker', date: 'm.last_date_with' }, { key: q.ticker, from: q.from });
    return db
      .prepare(`SELECT a.ticker, m.last_date_with, m.type, m.value_per_unit, m.approved_on, m.source FROM market_income m JOIN assets a ON a.id = m.asset_id ${f.sql} ORDER BY a.ticker, m.last_date_with`)
      .all(...f.args);
  });

  /** Proventos anunciados na B3 (ações e units). Sem `tickers`, todas as ações cadastradas. */
  app.post('/market-income/import', async (req, reply) => {
    const body = z.object({ tickers: z.array(z.string().min(1)).optional(), since: date.optional() }).parse(req.body ?? {});
    const report = await importMarketIncome(db, { ...body, fetch: opts.fetch });
    return reply.code(report.ok ? 200 : 502).send(report);
  });

  /** PU base do Tesouro Direto (Tesouro Transparente) para os títulos cadastrados. */
  app.post('/tesouro/import', async (req, reply) => {
    const body = z.object({ since: date.optional() }).parse(req.body ?? {});
    const report = await importTesouro(db, { since: body.since, fetch: opts.fetch });
    return reply.code(report.ok ? 200 : 502).send(report);
  });

  /** Cotas de fundos (CVM) dos meses pedidos; padrão: o mês atual e o anterior. Baixa para cvm/ na pasta de dados. */
  app.post('/funds/import', async (req, reply) => {
    const body = z.object({ months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).optional() }).parse(req.body ?? {});
    if (!opts.researchDir) return reply.code(400).send({ error: 'Pasta de dados desconhecida: sem onde guardar os arquivos da CVM' });
    const dir = join(dirname(opts.researchDir), 'cvm');
    const created = ensureFundAssets(db, referenceFunds(opts.researchDir));
    // Sem fundo com CNPJ não há o que buscar: evita baixar ~12 MB por mês à toa.
    if (!db.prepare('SELECT 1 FROM assets WHERE cnpj IS NOT NULL').get()) {
      return { ok: true, created_assets: created, results: [], note: 'nenhum ativo com CNPJ; nada a importar' };
    }
    const now = localToday();
    const prev = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const results: (CvmReport | { file: string; ok: false; error: string })[] = [];
    for (const m of body.months ?? [prev, now.slice(0, 7)]) {
      try {
        results.push(await importCvmFile(db, await downloadCvm(m, dir, opts.fetch)));
      } catch (e) {
        results.push({ file: m, ok: false, error: (e as Error).message });
      }
    }
    const ok = results.every((r) => r.ok);
    return reply.code(ok ? 200 : 502).send({ ok, created_assets: created, results });
  });

  /** Carteiras de referência: séries disponíveis e sobreposição (active share) com as de composição. */
  app.get('/references', async () => buildReferences(db, opts.researchDir));
}
