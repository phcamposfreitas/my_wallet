/**
 * Uso: npm run import:cotahist -w apps/api -- <COTAHIST_D12112026.ZIP | .TXT | pasta> [...]
 * Grava em prices o fechamento dos tickers cadastrados em assets, mais BOVA11 e XFIX11
 * (aproximações de Ibovespa e IFIX). Aceita o arquivo diário, mensal ou anual da B3.
 * O arquivo vem de `npm run download:cotahist` ou do site da B3; nada é baixado aqui.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../db.ts';
import { dbPathOrExit } from '../db-path.ts';
import { cotahistFiles, importCotahist, type CotahistReport } from '../importers/cotahist.ts';

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Informe o arquivo ou a pasta. Ex.: npm run import:cotahist -w apps/api -- ~/Downloads/COTAHIST_D12112026.ZIP');
  process.exit(1);
}

// npm -w roda o script dentro de apps/api; caminhos relativos valem a partir de onde o comando foi digitado.
const base = process.env.INIT_CWD ?? process.cwd();
const missing = args.map((a) => resolve(base, a)).filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`Arquivo ou pasta não encontrado: ${missing.join(', ')}`);
  process.exit(1);
}
const files = args.flatMap((a) => cotahistFiles(resolve(base, a)));
if (!files.length) {
  console.error('Nenhum arquivo COTAHIST_*.ZIP ou .TXT encontrado.');
  process.exit(1);
}

const dbPath = dbPathOrExit();
const db = openDb(dbPath);
console.log(`Banco: ${dbPath}`);

const reports: CotahistReport[] = [];
for (const f of files) {
  const r = await importCotahist(db, f);
  reports.push(r);
  if (r.status === 'erro') {
    console.log(`\n[erro] ${r.file}: ${r.error}`);
    continue;
  }
  const period = r.first_date === r.last_date ? r.first_date : `${r.first_date} a ${r.last_date} (${r.sessions} pregões)`;
  console.log(`\n[ok] ${r.file}: pregão ${period}`);
  console.log(
    `  - ${r.matched} fechamentos: ${r.inserted} novos, ${r.updated} alterados, ${r.unchanged} iguais` +
      (r.ignored ? `, ${r.ignored} ignorado(s)` : ''),
  );
  if (r.tickers.length) console.log(`  - tickers: ${r.tickers.join(', ')}`);
  if (r.created_assets.length) console.log(`  - cadastrados como referência: ${r.created_assets.join(', ')}`);
  if (r.not_found.length) console.log(`  - sem cotação à vista no arquivo: ${r.not_found.join(', ')}`);
  for (const w of r.warnings) console.log(`  - aviso: ${w}`);
}
if (reports.some((r) => r.status === 'erro')) process.exit(1);
