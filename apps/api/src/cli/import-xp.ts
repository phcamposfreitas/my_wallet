/**
 * Uso: npm run import:xp -- <pasta-ou-arquivos...>
 * Ex.: npm run import:xp -- ~/Downloads
 * Lê dim_ativo.csv, dim_indicador.csv, carteira_*.csv e fato_provento.csv
 * e grava no banco local. Os arquivos não são copiados para o repositório.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { openDb } from '../db.ts';
import { importXpFiles } from '../importers/xp.ts';

const WANTED = /^(dim_ativo|dim_indicador|carteira.*|fato_provento)\.csv$/i;

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Informe a pasta ou os arquivos CSV. Ex.: npm run import:xp -- ~/Downloads');
  process.exit(1);
}

const paths = args.flatMap((a) => {
  const p = resolve(a);
  return statSync(p).isDirectory()
    ? readdirSync(p).filter((f) => WANTED.test(f)).map((f) => join(p, f))
    : [p];
});

const dbPath = process.env.WALLET_DB ?? resolve(import.meta.dirname, '../../../../data/wallet.db');
const db = openDb(dbPath);
const reports = importXpFiles(
  db,
  paths.map((p) => ({ name: basename(p), text: readFileSync(p, 'utf-8') })),
);

console.log(`Banco: ${dbPath}`);
for (const r of reports) {
  console.log(`\n[${r.status}] ${r.file}`);
  for (const d of r.details) console.log(`  - ${d}`);
}
if (reports.some((r) => r.status === 'erro')) process.exit(1);
