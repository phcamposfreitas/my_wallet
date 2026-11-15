---
name: nova-coleta
description: Importa e concilia uma nova coleta da carteira exportada da corretora (CSVs da XP) e produz o boletim da controladoria. Use quando o titular disser que exportou a carteira, os proventos ou o extrato, ou pedir para atualizar a carteira.
argument-hint: "[pasta com os CSVs, padrão ~/Downloads]"
disable-model-invocation: true
---

Você conduz este ritual como CIO da casa de investimentos. Regras e pastas estão em
`docs/investimentos/README.md`. Este é o único ritual que **escreve no banco**, e só pelo
importador da API.

Pasta dos arquivos: `$ARGUMENTS`. Se vier vazia, use `~/Downloads`.

## 1. O que será importado

Na pasta, liste os arquivos que o importador lê (`dim_ativo.csv`, `dim_indicador.csv`,
`carteira*.csv`, `fato_provento.csv`) com a data de modificação de cada um. O importador é
idempotente (um arquivo já importado é ignorado pelo hash) e só acrescenta dados: um snapshot
existente nunca é sobrescrito.

## 2. Qual banco

- O banco é `DB="$WALLET_DB"`, na pasta de dados, fora do repositório. Se a variável estiver
  vazia, leia do perfil como diz o regimento ("Como ler os dados"). Se continuar vazia,
  **pare** e pergunte ao titular onde está o banco.
- **Confira se o arquivo existe e tem snapshots:**
  `sqlite3 -readonly "$DB" "select count(*), max(taken_at) from snapshots"`.
  Se não existir, **pare**. O importador criaria um banco vazio em silêncio e a coleta iria
  para o lugar errado. Pergunte ao titular onde está o banco.
- Antes de importar, faça um backup consistente (o banco usa WAL):
  `mkdir -p "$(dirname "$DB")/backups" && sqlite3 "$DB" ".backup '$(dirname "$DB")/backups/wallet-AAAAMMDD-HHMM.db'"`.

## 3. Importação

Rode `WALLET_DB="$DB" npm run import:xp -w apps/api -- <pasta>` e mostre o relatório: para
cada arquivo, se foi importado, se já tinha sido, ou se foi recusado, e o motivo. Um snapshot
recusado não é erro a contornar: a coleta veio inconsistente e precisa ser refeita.

## 4. Boletim

Chame o agente `controladoria` para fazer o boletim:
- integridade;
- conciliação com a coleta anterior;
- eventos corporativos;
- proventos e anomalias;
- desempenho contra o CDI e os índices.
Grave o boletim em `$(dirname "$DB")/research/coletas/AAAA-MM-DD.md`.

Quando houver evento corporativo, posição nova ou encerrada, ou provento anômalo:
- acrescente uma linha no "Histórico" de cada tese afetada;
- sugira `/revisar-tese` para os casos materiais.

## 5. Resposta ao titular

- O que entrou no banco.
- As variações explicadas.
- As anomalias.
- O próximo passo sugerido: `/comite-investimentos` se for a coleta do mês.
