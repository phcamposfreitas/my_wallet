/**
 * Uso: npm run import:proventos -w apps/api -- [--desde AAAA-MM-DD] [--tickers PETR4,ITUB4]
 * Busca na B3 os proventos em dinheiro (dividendos e JCP, com data-com) das ações cadastradas
 * e grava em market_income. Sem --tickers, todas as ações (da carteira e das referências).
 */
import { parseArgs } from 'node:util';
import { openDb } from '../db.ts';
import { dbPathOrExit } from '../db-path.ts';
import { isIsoDate } from '../dates.ts';
import { importMarketIncome } from '../importers/b3-proventos.ts';

const { values: args } = parseArgs({ options: { desde: { type: 'string' }, tickers: { type: 'string' } } });
if (args.desde && !isIsoDate(args.desde)) {
  console.error(`Data inválida: ${args.desde}`);
  process.exit(1);
}
const dbPath = dbPathOrExit();
const db = openDb(dbPath);
console.log(`Banco: ${dbPath}`);
const report = await importMarketIncome(db, { since: args.desde, tickers: args.tickers?.split(',').filter(Boolean) });
for (const r of report.results) {
  if (r.status === 'importado') console.log(`[ok] ${r.ticker} (${r.trading_name}): ${r.inserted} novos, ${r.unchanged} já gravados`);
  else if (r.status === 'erro') console.log(`[erro] ${r.ticker}: ${r.error}`);
  else console.log(`[--] ${r.ticker}: ${r.status === 'sem_empresa' ? 'empresa não encontrada na B3' : 'classe ou código sem proventos nessa API'}`);
}
if (!report.ok) process.exit(1);
