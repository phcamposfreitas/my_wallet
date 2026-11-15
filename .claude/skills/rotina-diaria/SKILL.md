---
name: rotina-diaria
description: Rotina diária da casa de investimentos. Roda a mesa de monitoramento depois do fechamento, grava a nota do dia e encaminha os alertas 🔴 para revisão de tese. Use em dias úteis depois das 18h, ou quando o titular pedir o diário, ou perguntar o que aconteceu hoje com a carteira.
argument-hint: "[AAAA-MM-DD]"
---

Você conduz este ritual como CIO da casa de investimentos. Regras, pastas e níveis de alerta
estão em `docs/investimentos/README.md`: leia antes de começar.

Data de referência: `$ARGUMENTS`. Se vier vazia, use a data de hoje.

## 1. Pré-checagem (você mesmo, rápido)

- **Pasta de pesquisa:** `$(dirname "$WALLET_DB")/research`. Se `WALLET_DB` estiver vazia,
  leia do perfil como diz o regimento ("Como ler os dados"). Se continuar vazia, pare e avise.
  A pasta precisa ter `teses/_mapa.md`. Se não houver teses, diga ao titular que o primeiro
  passo é montar as teses (`/comite-investimentos`) e pare.
- **Dados:** a API está no ar (`curl -s http://127.0.0.1:3333/api/health`) ou o banco abre em
  modo de leitura? Anote a data do último snapshot. Se o banco não existir, pare e avise. Não
  crie um banco.
- **Dia útil:** se for fim de semana ou feriado da B3, faça só a agenda e as notícias
  materiais.

## 2. Monitoramento

Chame o agente `monitor-mercado` com:
- a data de referência e o caminho da pasta de pesquisa;
- a lista de ativos e a tese de cada um, tirada do mapa;
- o caminho da nota do dia útil anterior, se existir.

Peça a nota no formato do agente, gravada em `research/diario/AAAA-MM-DD.md`. Depois confira
que o arquivo existe.

## 3. Encaminhamento

- Para cada 🔴, acrescente uma linha no "Histórico" da tese afetada:
  `AAAA-MM-DD: 🔴 <fato> (fonte). Revisão aberta.`
- Com o titular presente, ofereça rodar `/revisar-tese <tese>` para o 🔴 mais grave.
- Em execução agendada, sem ninguém para responder, só registre. Não abra revisões em
  sequência.
- Os 🟡 ficam na nota e entram na pauta do próximo comitê.

## 4. Resposta ao titular

- Três linhas de resumo.
- A lista de 🔴 e 🟡, com o encaminhamento de cada um.
- O caminho da nota.

Não recomende compra nem venda.
