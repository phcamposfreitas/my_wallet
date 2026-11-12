import { resolve } from 'node:path';
import { openDb } from './db.ts';
import { buildApp } from './app.ts';

// Por padrão o banco fica em <raiz do repo>/data/wallet.db (ignorado pelo git).
const dbPath = process.env.WALLET_DB ?? resolve(import.meta.dirname, '../../../data/wallet.db');
const port = Number(process.env.API_PORT ?? 3333);

const db = openDb(dbPath);
const app = buildApp(db, { logger: true });

// Escuta só em localhost: os dados não ficam expostos na rede.
await app.listen({ host: '127.0.0.1', port });
app.log.info(`Banco de dados: ${dbPath}`);
