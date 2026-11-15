# My Wallet: notas para o Claude

- **O repositório é público.** Nenhum dado pessoal vai para o git: posições, valores, teses,
  atas, faturas, extratos e o banco ficam na **pasta de dados**, fora do repositório.
  - Antes de commitar, confira `git status`.
  - `data/` continua no `.gitignore` por segurança. Nunca use `git add -f` nele.
  - Não escreva caminhos absolutos com o nome do usuário em arquivos versionados.
- **Banco e pasta de dados.** O banco é `$WALLET_DB`, definida no perfil do shell. A pasta de
  dados é a pasta dele, `$(dirname "$WALLET_DB")`, com `research/`, `faturas/` e `backups/`.
  - Sessão aberta antes de a variável existir não a enxerga. Leia do perfil:
    `export WALLET_DB="${WALLET_DB:-$($SHELL -l -c 'printenv WALLET_DB')}"`.
  - Sem `WALLET_DB`, o servidor e os importadores usam `data/wallet.db` do checkout e **recusam**
    abrir se o arquivo não existir. Não contorne com `WALLET_DB_CREATE=1`: pare e avise.
  - Em desenvolvimento (migração nova, servidor de um branch, teste de importador), use uma
    cópia: `sqlite3 -readonly "$WALLET_DB" ".backup <pasta temporária>/wallet.db"` e rode com
    `WALLET_DB=<pasta temporária>/wallet.db`. Migração que ainda não está no `master` nunca roda
    no banco real.
- **Investimentos:**
  - equipe de agentes: `.claude/agents/`;
  - rituais: `.claude/skills/` (`/rotina-diaria`, `/nova-coleta`, `/revisar-tese`,
    `/comite-investimentos`);
  - regimento: `docs/investimentos/README.md`.
  Os agentes analisam e preparam decisões, mas não operam nem recomendam.
- **Faturas de cartão:** o fluxo está em `docs/faturas-cartao.md` e `scripts/README.md`. Os PDFs
  ficam em `faturas/<cartão>/`, na pasta de dados.
