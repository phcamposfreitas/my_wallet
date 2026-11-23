import { dirname, join } from 'node:path';
import { openDb } from './db.ts';
import { dbPathOrExit } from './db-path.ts';
import { buildApp } from './app.ts';

// Banco em WALLET_DB (padrão <raiz do repo>/data/wallet.db). Recusa arquivo inexistente; ver db-path.ts.
const dbPath = dbPathOrExit();
const port = Number(process.env.API_PORT ?? 3333);

const db = openDb(dbPath);
// As teses ficam em research/, ao lado do banco (pasta de dados, fora do repositório).
const app = buildApp(db, { logger: true, researchDir: join(dirname(dbPath), 'research') });

// Escuta só em localhost: os dados não ficam expostos na rede.
await app.listen({ host: '127.0.0.1', port });
app.log.info(`Banco de dados: ${dbPath}`);
