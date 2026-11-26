/**
 * Uso: npm run import:fundos -w apps/api -- [AAAA-MM ...]
 * Baixa o informe diário de fundos da CVM dos meses pedidos (padrão: o atual e o anterior)
 * para cvm/ na pasta de dados e grava a cota dos ativos com CNPJ e dos fundos de referência.
 */
import { dirname, join } from 'node:path';
import { openDb } from '../db.ts';
import { dbPathOrExit } from '../db-path.ts';
import { localToday } from '../dates.ts';
import { cvmFileName, downloadCvm, ensureFundAssets, importCvmFile } from '../importers/cvm-fundos.ts';
import { referenceFunds } from '../references.ts';

const now = localToday();
const prev = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
const months = process.argv.slice(2).length ? process.argv.slice(2) : [prev, now.slice(0, 7)];
try {
  months.forEach(cvmFileName);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const dbPath = dbPathOrExit();
const db = openDb(dbPath);
console.log(`Banco: ${dbPath}`);
const research = join(dirname(dbPath), 'research');
const created = ensureFundAssets(db, referenceFunds(research));
if (created.length) console.log(`Fundos de referência cadastrados: ${created.join(', ')}`);
let failed = false;
for (const m of months) {
  try {
    const r = await importCvmFile(db, await downloadCvm(m, join(dirname(dbPath), 'cvm')));
    if (!r.ok) throw new Error(r.error);
    console.log(`[ok] ${r.file}: ${r.rows_read} linhas`);
    for (const x of r.matched) console.log(`  - ${x.ticker}: ${x.inserted} novas, ${x.updated} alteradas, ${x.unchanged} iguais, até ${x.last_date}`);
    if (r.not_found.length) console.log(`  - sem cota no mês: ${r.not_found.join(', ')}`);
  } catch (e) {
    failed = true;
    console.log(`[erro] ${m}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
