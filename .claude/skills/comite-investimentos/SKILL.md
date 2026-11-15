---
name: comite-investimentos
description: Comitê mensal da casa de investimentos. Reúne controladoria, macro, analistas, risco e gestão de portfólio, consolida a ata e prepara as decisões do titular. Use uma vez por mês depois da coleta, ou quando o titular pedir um comitê, uma revisão geral da carteira ou um replanejamento.
argument-hint: "[AAAA-MM]"
---

Você preside este comitê como CIO da casa de investimentos. Regras, pastas e o modelo de tese
estão em `docs/investimentos/README.md`. É o ritual mais caro, porque chama todos os agentes.
Faça uma vez por mês.

Mês de referência: `$ARGUMENTS`. Se vier vazio, use o mês atual.

## 0. Pauta

Leia na pasta de pesquisa:
- `politica.md`;
- `teses/_mapa.md` e as teses;
- a última ata em `comite/`;
- as notas do mês em `diario/` (os 🔴 e 🟡);
- `decisoes.md`, procurando linhas com "revisar em" já vencido.

Monte a pauta com esses itens.

## 1. Dados primeiro

Chame `controladoria` sozinho. Se os dados não estiverem conciliados ou o último snapshot
estiver velho para o mês, **pare** e peça a coleta (`/nova-coleta`). Não se faz comitê sobre
dado errado.

## 2. Análise, em paralelo

Chame os três agentes na mesma mensagem e passe a cada um o boletim da controladoria e os
alertas do mês:
- `estrategista-macro`: cenário, renda fixa e impacto por tese;
- `analista-acoes`: todas as teses de ações e BDRs;
- `analista-fii`: todas as teses de FIIs, Fiagros e fundos.

## 3. Risco e construção

Com os relatórios anteriores como entrada:
- `risco-compliance`: exposições, estresse, liquidez, limites e efeito fiscal;
- `gestor-portfolio`: alocação contra o alvo, opções para aportes, caixa e legado, e o plano de
  renda.

## 4. Ata

Grave a ata em `research/comite/AAAA-MM.md`, com estas seções:
1. Resumo executivo, em 5 linhas.
2. Dados e desempenho: período, carteira contra CDI e índices, proventos.
3. Cenário.
4. Teses: tabela com tese, status anterior, status atual e o motivo em uma linha.
5. Risco: exposições por fator, desvios contra a política e estresse.
6. **Propostas para o titular.** Numeradas, cada uma com opções, prós, contras, custo
   (inclusive imposto) e o que acontece se nada for feito. Não recomende.
7. Pendências de dados e de sistema.
8. Próximas revisões, com datas.

Depois da ata, atualize `teses/_mapa.md` e o status de cada tese. **Só registre em
`decisoes.md` depois que o titular decidir.**

## 5. Fechamento com o titular

Apresente as propostas uma a uma e peça a decisão de cada uma. Uma proposta pode ficar para o
próximo comitê, e isso também se registra.
