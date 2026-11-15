import { openDb } from './db.ts';
import { dbPathOrExit } from './db-path.ts';
import { buildApp } from './app.ts';

// Banco em WALLET_DB (padrão <raiz do repo>/data/wallet.db). Recusa arquivo inexistente; ver db-path.ts.
const dbPath = dbPathOrExit();
const port = Number(process.env.API_PORT ?? 3333);

const db = openDb(dbPath);
const app = buildApp(db, { logger: true });

// Escuta só em localhost: os dados não ficam expostos na rede.
await app.listen({ host: '127.0.0.1', port });
app.log.info(`Banco de dados: ${dbPath}`);
