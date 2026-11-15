/**
 * Uso: npm run download:cotahist -w apps/api -- <período> [...] [--destino <pasta>]
 *   período: AAAA-MM-DD (diário), AAAA-MM (mensal) ou AAAA (anual)
 * Passo opcional: baixa o COTAHIST da B3 e imprime o caminho salvo; não importa nada
 * (depois rode import:cotahist). Por padrão salva em b3/, ao lado do banco, fora do git.
 * O diário sai à noite, depois do pregão; dia sem pregão não tem arquivo.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { cotahistFileName, downloadCotahist } from '../importers/cotahist.ts';

const USAGE = 'Uso: npm run download:cotahist -w apps/api -- <AAAA-MM-DD | AAAA-MM | AAAA> [...] [--destino <pasta>]';

function readArgs() {
  try {
    return parseArgs({ allowPositionals: true, options: { destino: { type: 'string' } } });
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(1);
  }
}

const { values, positionals } = readArgs();
if (!positionals.length) {
  console.error(USAGE);
  process.exit(1);
}
for (const period of positionals) {
  try {
    cotahistFileName(period);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const dbPath = process.env.WALLET_DB ?? resolve(import.meta.dirname, '../../../../data/wallet.db');
const dir = values.destino ? resolve(process.env.INIT_CWD ?? process.cwd(), values.destino) : join(dirname(dbPath), 'b3');
mkdirSync(dir, { recursive: true });

let failed = false;
for (const period of positionals) {
  try {
    console.log(await downloadCotahist(period, dir));
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    console.error(err.cause?.code ? `${err.message} (${err.cause.code})` : err.message);
    failed = true;
  }
}
if (failed) process.exit(1);
