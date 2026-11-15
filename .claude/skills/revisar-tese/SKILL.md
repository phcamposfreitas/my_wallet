---
name: revisar-tese
description: Revisa uma tese de investimento, ou a tese de um ativo, com o analista da classe e a área de risco, e atualiza o arquivo da tese com o veredito. Use depois de um alerta 🔴, de resultado trimestral ou de fato relevante, ou quando o titular pedir para reavaliar uma tese ou um ativo.
argument-hint: "<T0X | TICKER>"
---

Você conduz este ritual como CIO da casa de investimentos. Regras e o modelo de tese estão em
`docs/investimentos/README.md`.

Alvo da revisão: `$ARGUMENTS`. Pode ser o id de uma tese (ex.: `T04`) ou um ticker.

## 1. Localizar

- Procure em `research/teses/` pelo `id` ou pela lista `ativos` do frontmatter.
- Se for um ticker sem tese, a posição é **legado**. Pergunte ao titular se quer escrever a
  tese (o analista cria o arquivo com `origem: a validar`) ou tratar a posição como legado com
  o `gestor-portfolio`.
- Anote o motivo da revisão: alerta (com a data da nota), resultado, fato relevante ou pedido.

## 2. Quem trabalha

| Classe ou gatilho | Agente |
|---|---|
| Ações e BDRs | `analista-acoes` |
| FIIs, Fiagros e fundos | `analista-fii` |
| Títulos públicos, tese macro, ou gatilho macro (juros, câmbio, commodities) | `estrategista-macro`, junto com o analista da classe |
| Sempre, em paralelo | `risco-compliance`: exposição da tese e efeito fiscal das opções |

Passe a cada agente:
- o caminho do arquivo da tese e os ativos;
- o motivo;
- a data da última revisão;
- os alertas recentes da pasta `research/diario/`.

## 3. Consolidar

No arquivo da tese:
- atualize `status`, `ultima_revisao` e `proxima_revisao` no frontmatter;
- atualize "Situação atual" e "Indicadores e gatilhos";
- acrescente uma linha no "Histórico".

O texto da revisão leva:
- **veredito:** manter, em observação, em revisão ou invalidada;
- **premissas:** cada uma confirmada, em risco ou quebrada, com a evidência;
- **o que mudaria o veredito;**
- **opções para o titular,** cada uma com prós, contras e custo, inclusive imposto. Inclua
  sempre "não fazer nada". Não recomende.

## 4. Fechar

Mostre ao titular o veredito e as opções. Se ele decidir, acrescente uma linha em
`research/decisoes.md` no formato do regimento.
