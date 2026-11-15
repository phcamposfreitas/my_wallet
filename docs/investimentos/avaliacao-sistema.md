# Avaliação do sistema para a equipe de agentes

Data: 2026-11-13. Esta avaliação responde a uma pergunta: o que o My Wallet já entrega aos
agentes de `docs/investimentos/README.md` e o que falta para cada um fazer bem o seu papel?
(Este documento é versionado e por isso não traz dados da carteira.)

## Resumo

A base de **posição** é boa:
- as coletas são validadas e append-only;
- o retorno é recalculado;
- os proventos vêm do extrato;
- a comparação entre coletas classifica cada variação.

A controladoria consegue trabalhar hoje.

O que impede o restante da equipe:

1. **O banco morava num lugar frágil.** O caminho padrão é `data/wallet.db` *do checkout em
   uso*, e o banco real estava dentro de uma worktree do Claude. Se ela fosse limpa, o
   histórico sumiria, e não daria para reconstruí-lo: a corretora só mostra a posição do dia.
   Os dados já foram para uma pasta estável. Falta o código recusar banco inexistente.
2. **Não há preço diário nem série de referência.** A tabela `prices` está vazia e não existe
   CDI, Ibovespa ou IFIX no banco. Sem isso, o monitor não monitora e ninguém mede a carteira
   contra o custo de oportunidade.
3. **Teses, alertas e decisões não existem como dados.** Por enquanto vivem em arquivos
   markdown na pasta de dados (`research/`), fora do git, e o sistema não os enxerga.
4. **Não há histórico de operações** (`trades` vazia). Sem ele não há retorno desde o início,
   não há apuração de IR e não se sabe quando cada tese entrou.

## O que já existe e serve à equipe

| Capacidade | Onde | Quem usa |
|---|---|---|
| Snapshots append-only, validados (qtd × preço = valor; qtd × PM = custo), idempotentes por hash | `importers/xp.ts`, `snapshots` | controladoria |
| Retorno de preço e retorno total separados; yield com e sem títulos sem cupom | `snapshots.ts` (`buildPortfolio`) | controladoria, gestor-portfolio |
| Comparação entre coletas: mercado, compra (preço implícito), venda, evento corporativo, nova, encerrada | `compareSnapshots`, `GET /api/snapshots/compare` | controladoria, monitor |
| Proventos do extrato, com quantidade-base, valor por cota e "reembolso de evento" (aluguel) | `asset_income` | controladoria, analistas, gestor |
| Proveniência da quantidade (`lido`, `derivado`, `inferido`) | `snapshot_positions` | controladoria |
| Vocabulário de indicadores (fundamentos, múltiplos, FII) | `indicators` | analistas |
| Gastos conciliados por fatura, resumo anual e planejamento por ano | `statements`, `/summary/year`, `/plan` | gestor-portfolio (lado das despesas) |
| API só em `127.0.0.1` e testes da API | `server.ts`, `apps/api/test` | todos |

## Lacunas, por prioridade

Esforço estimado: **P** = menos de uma sessão, **M** = uma ou duas sessões, **G** = várias.

### P0: sem isto a equipe não funciona

| # | Lacuna | Impacto | Proposta | Esforço |
|---|---|---|---|---|
| 1 | O banco ficava dentro de uma worktree, e o servidor e o importador criam um banco **vazio** em silêncio quando o arquivo não existe | perda irreversível de histórico; importação no banco errado | **Feito em 15/11:** banco, faturas e `research/` numa pasta estável fora do repositório, com o banco original guardado em `backups/`, e `WALLET_DB` no perfil do shell. **Falta:** fazer o servidor e o importador **recusarem** o arquivo inexistente, salvo com uma flag `--criar`; backup diário com `sqlite3 .backup` (cópia consistente com WAL) | P |
| 2 | Não há preço diário (`prices` vazia) | o monitor não detecta movimento e não há série para gatilho de preço | importador do COTAHIST diário da B3 para os ativos cadastrados; preços e taxas do Tesouro Direto (Tesouro Transparente); `POST /api/prices/import`, `GET /api/prices` | M |
| 3 | Não há séries de referência | sem CDI não existe custo de oportunidade; sem Ibovespa e IFIX não há comparação | tabela `series (codigo, data, valor, fonte)` alimentada pelo BCB SGS (12 CDI, 11 Selic, 433 IPCA, 1 dólar) e por BOVA11 e XFIX11 do COTAHIST; `GET /api/series` | P |
| 4 | Teses, gatilhos, alertas e decisões fora do sistema | o monitor lê markdown, nada é consultável, a UI não mostra | **v1 (feita):** arquivos em `research/`, na pasta de dados. **v2:** tabelas `theses`, `thesis_assets`, `watch_rules` (indicador, operador, limite), `alerts`, `decisions`, com endpoints e uma aba "Teses" | M |

### P1: qualidade da análise

| # | Lacuna | Impacto | Proposta | Esforço |
|---|---|---|---|---|
| 5 | Não há histórico de operações | sem retorno desde o início, sem IR, sem "safra" das teses | importar a movimentação da **Área do Investidor da B3** (exporta em planilha e consolida por CPF), com as notas de corretagem como conferência; preencher `trades` | M |
| 6 | Desempenho só entre coletas | coletas esparsas escondem o caminho, e o drawdown fica subestimado | cota diária: posições do último snapshot × preços diários (item 2), com ajuste pelos fluxos; retorno ponderado no tempo e atribuição por classe e por tese | M |
| 7 | Aluguel de ações (BTC) não registrado | a renda fica subestimada; o provento esperado por quantidade erra quando há ações emprestadas | tipo de renda `aluguel_btc` (taxa e IR retido) a partir do extrato; quantidade emprestada por ativo | P |
| 8 | Não há agenda de eventos | o monitor não antecipa data-com, resultados, assembleias, Copom e vencimentos. Pior: perde **prazos que exigem ação do titular**. Na primeira análise apareceu um fundo em liquidação com prazo para o cotista informar o custo médio; sem a informação, o administrador retém IR sobre o menor preço histórico | tabela `events (ativo, tipo, data, valor, prazo_titular, fonte)` alimentada por avisos de rendimento e fatos relevantes (Fundos.NET), comunicados (CVM IPE) e o calendário do Copom. O monitor alerta os prazos como 🔴 | M |
| 9 | O vocabulário de indicadores existe, mas não há tabela de fatos | analistas recalculam tudo do zero e não há série histórica de múltiplos nem de dados de FII | tabela longa `indicator_facts (ativo, tabela, código, referência, valor, fonte, coletado_em)`, append-only, validada contra `indicators`; importadores da CVM (ITR/DFP e informe mensal de FII) | M |
| 10 | O fator de ajuste de evento corporativo não é persistido | séries de preço corrompidas depois de grupamento ou desdobramento | gravar o fator detectado em `compareSnapshots` e aplicar na leitura de preços | P |
| 11 | Cadastro incompleto: ISIN faltando em parte dos ativos; setor "não verificado" | o reembolso de evento chega só com ISIN; exposição setorial pouco confiável | completar ISIN pela CVM ou B3; adotar a classificação setorial da B3 com proveniência | P |
| 12 | Não há conciliação com o extrato da conta da corretora | aporte e saída estimados pelo custo; resíduo não verificado | importar o extrato e exigir resíduo zero em `compareSnapshots` (TODO já existente no código) | M |
| 12b | A data de marcação de cada linha da coleta não é guardada | títulos públicos já vieram com o preço do dia útil anterior, e a variação entre coletas saiu errada (num caso, −2,9% contra −8,1% reais) | gravar a data efetiva da marcação por linha; conferir o PU do Tesouro com o Tesouro Transparente na importação | P |

### P2: planejamento e operação

| # | Lacuna | Impacto | Proposta | Esforço |
|---|---|---|---|---|
| 13 | Patrimônio só na corretora principal | alocação e risco medidos sobre parte do patrimônio | cadastrar outras contas e ativos fora dela (reserva, previdência, FGTS, consórcio, imóveis) como posições manuais com data | P |
| 14 | Não há renda do titular no sistema (só gastos de cartão) | sem taxa de poupança nem capacidade de aporte | importar o extrato bancário (já previsto no README) | M |
| 15 | A política de investimentos não é dado | risco e gestor não calculam desvio de forma automática | tabela `policy_targets (dimensão, chave, alvo, banda mín., banda máx.)` | P |
| 16 | Não há apuração de IR | risco não estima custo fiscal com precisão | apuração mensal por categoria, prejuízo a compensar, DARF (depende do item 5) | G |
| 17 | Rotina diária manual | depende de alguém lembrar | tarefa agendada **local** no app (rotinas na nuvem não enxergam o banco local), com notificação quando houver 🔴 | P |
| 18 | UI sem teses, risco e agenda | o titular lê markdown | abas "Teses", "Exposição" e "Agenda" na página Carteira | M |

## Ordem sugerida

1. **Fundação (item 1, depois itens 3 e 2):** banco em lugar estável com backup; depois
   séries do BCB e preços diários. Com isso o `/rotina-diaria` passa a medir de verdade.
2. **Medida:** itens 5, 6, 7 e 10. Histórico de operações, cota diária, aluguel e fator de
   ajuste. O desempenho por tese passa a ser confiável.
3. **Inteligência:** itens 8, 9 e 11. Agenda, fatos de indicadores e cadastro completo. Os
   gatilhos das teses passam a ser checados por código, não lidos em texto.
4. **Gestão:** itens 4 (v2), 13, 14, 15 e 18. Teses e política como dados, patrimônio completo
   e UI.
5. **Tributação:** item 16.

## O que só o titular pode fornecer

- **Política de investimentos:** objetivo (renda ou crescimento), horizonte, meta de renda
  passiva, perda máxima tolerável, liquidez necessária, restrições (por exemplo, setores ou
  estatais que não quer) e alocação-alvo com bandas.
- **Patrimônio fora da corretora** e **aporte mensal previsto**.
- **As coletas:** os exports da corretora e da Área do Investidor da B3. Os agentes não fazem
  login.

Fica de fora deliberadamente: a raspagem da sessão autenticada da corretora. A árvore de
acessibilidade da página expõe tokens de acesso, e a coleta deve continuar por exportação feita
pelo titular.
