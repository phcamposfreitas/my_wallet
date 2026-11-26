/**
 * Uso: npm run import:tesouro -w apps/api -- [--desde AAAA-MM-DD]
 * Baixa o CSV de preços do Tesouro Direto (Tesouro Transparente) e grava o PU base dos
 * títulos cadastrados como tesouro, casando pelo tipo (LFT, LTN, NTN-B...) e pelo vencimento.
 */
import { parseArgs } from 'node:util';
import { openDb } from '../db.ts';
import { dbPathOrExit } from '../db-path.ts';
import { isIsoDate } from '../dates.ts';
import { importTesouro } from '../importers/tesouro.ts';

const { values: args } = parseArgs({ options: { desde: { type: 'string' } } });
if (args.desde && !isIsoDate(args.desde)) {
  console.error(`Data inválida: ${args.desde}`);
  process.exit(1);
}
const dbPath = dbPathOrExit();
const db = openDb(dbPath);
console.log(`Banco: ${dbPath}`);
const r = await importTesouro(db, { since: args.desde });
if (!r.ok) {
  console.log(`[erro] ${r.error}`);
  process.exit(1);
}
console.log(`[ok] ${r.rows_read} linhas no arquivo`);
for (const m of r.matched) console.log(`  - ${m.ticker} (${m.type} ${m.maturity}): ${m.first_date} a ${m.last_date} · ${m.inserted} novos, ${m.updated} alterados`);
if (r.not_found.length) console.log(`  - sem preço no arquivo: ${r.not_found.join(', ')}`);
