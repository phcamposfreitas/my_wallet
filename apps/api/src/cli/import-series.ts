/**
 * Uso: npm run import:series -w apps/api -- --desde AAAA-MM-DD [--ate AAAA-MM-DD] [--series CDI,IPCA]
 * Busca as séries do Banco Central (SGS) e grava na tabela series. Sem --desde, cada
 * série continua da última data gravada. Sem --series, importa todas:
 * CDI (SGS 12), SELIC (11), SELIC_META (432), IPCA (433), IPCA_12M (13522), DOLAR_PTAX (1).
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../db.ts';
import { isIsoDate } from '../dates.ts';
import { findSeries, importSeries, SGS_SERIES } from '../importers/sgs.ts';

const USAGE = 'Uso: npm run import:series -w apps/api -- --desde AAAA-MM-DD [--ate AAAA-MM-DD] [--series CDI,IPCA]';

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

function readArgs() {
  try {
    return parseArgs({ options: { desde: { type: 'string' }, ate: { type: 'string' }, series: { type: 'string' } } }).values;
  } catch (e) {
    return fail((e as Error).message);
  }
}

const args = readArgs();
for (const d of [args.desde, args.ate]) if (d !== undefined && !isIsoDate(d)) fail(`Data inválida: ${d}`);
if (args.desde && args.ate && args.desde > args.ate) fail('--desde deve ser anterior ou igual a --ate');
const codes = args.series?.split(',').filter((c) => c.trim());
for (const c of codes ?? []) if (!findSeries(c)) fail(`Série desconhecida: ${c}. Disponíveis: ${SGS_SERIES.map((s) => s.code).join(', ')}`);

// Argumentos validados antes de abrir o banco: abrir aplica as migrações pendentes.
const dbPath = process.env.WALLET_DB ?? resolve(import.meta.dirname, '../../../../data/wallet.db');
const db = openDb(dbPath);
console.log(`Banco: ${dbPath}`);

const report = await importSeries(db, { from: args.desde, to: args.ate, codes });
for (const r of report.results) {
  const label = `${r.code} (SGS ${r.sgs})`;
  if (r.error) {
    console.log(`[erro] ${label}: ${r.error}`);
    continue;
  }
  const period = r.received ? `${r.first_date} a ${r.last_date}` : 'nenhum valor novo na janela';
  console.log(
    `[ok] ${label}: ${period} · ${r.received} valores (${r.inserted} novos, ${r.updated} alterados, ${r.unchanged} iguais)` +
      ` · ${r.requests} consulta(s)${r.skipped ? ` · ${r.skipped} sem valor` : ''}`,
  );
}
if (!report.ok) process.exit(1);
