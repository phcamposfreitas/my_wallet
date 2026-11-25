#!/usr/bin/env python3
"""Lê o extrato da conta XP (TSV) e gera os arquivos de importação da carteira.

Uso:
    python3 scripts/xp/extrato.py [--mapa mapa.json] <pasta de saída> <extrato.tsv> [<extrato.tsv> ...]

O mapa (JSON, na pasta de dados) traz os BDRs com sufixo diferente de 34 ("bdr") e o código dos
fundos fechados que pagam rendimento ("fundos_fechados"). Sem --mapa, usa $XP_MAPA ou
<pasta do WALLET_DB>/coletas-xp/mapa.json.

Entrada: TSV com cabeçalho e as colunas Mov, Liq, Lançamentos, Valor (R$), Saldo (R$), como na
tabela do extrato "Simplificado" do portal (ver scripts/README.md). Vários arquivos podem ser
passados; a ordem não importa.

Saída (na pasta indicada), no formato que `npm run import:xp` lê:
    fato_provento.csv   dividendos, JCP, rendimentos e reembolsos de ações emprestadas
    fato_fluxo.csv      dinheiro que entrou ou saiu da conta (aporte, retirada, exterior, cashback)
    fato_movimento.csv  movimentos sem nota: Tesouro, fundos, CDB, subscrições, opções, custos

Ficam de fora, de propósito: as compras e vendas em bolsa (vêm das notas, scripts/xp/notas.py),
o aluguel de ações (BTC) e pares que se anulam (estorno e regularização de compra, prêmio de opção).

Conferências (saída com erro se falharem):
    - o saldo encadeia linha a linha (nenhum lançamento faltando);
    - todo lançamento cai em uma categoria conhecida.
Nenhum dado pessoal fica no script: tudo vem dos arquivos passados.
"""
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

FONTE = 'extrato conta corrente XP'


def num(s):
    return round(float(s.replace('.', '').replace(',', '.')), 2)


def iso(d):
    return '-'.join(reversed(d.split('/')))


# ---------------------------------------------------------------- proventos

# Sufixo do ticker pela espécie no ISIN (BRxxxxACNOR1 → ON → 3).
ISIN_ESPECIE = {'ACNOR': '3', 'ACNPR': '4', 'ACNPA': '5', 'ACNPB': '6'}
# Vêm do mapa (pasta de dados): BDRs com sufixo diferente de 34 e fundos fechados por nome.
ISIN_BDR = {}
FUNDOS_FECHADOS = {}


def ticker_do_isin(isin):
    m = re.match(r'BR([A-Z0-9]{4})(ACNOR|ACNPR|ACNPA|ACNPB|BDR)', isin)
    if not m:
        return None
    base, esp = m.groups()
    if esp == 'BDR':
        return ISIN_BDR.get(base, base + '34')
    return base + ISIN_ESPECIE[esp]


PROVENTO = re.compile(r'^(RENDIMENTOS|DIVIDENDOS|JUROS S/ CAPITAL) DE CLIENTES ([A-Z][A-Z0-9]{3}\d{1,2}) S/ ([\d.,]+)')


def provento(desc, valor, data):
    m = PROVENTO.match(desc)
    if m:
        tipo_ext, ticker, qtd = m.groups()
        qtd = float(qtd.replace(',', '').replace('.', ''))
        obs = ''
        if re.match(r'[A-Z0-9]{4}1[2-9]$', ticker):  # recibo de subscrição de FII (XPML13 → XPML11)
            obs = f'rendimento de recibo de subscricao {ticker}'
            ticker = ticker[:4] + '11'
        if tipo_ext == 'JUROS S/ CAPITAL':
            tipo = 'jcp'
        elif tipo_ext == 'DIVIDENDOS':
            tipo = 'dividendo'
        elif ticker.endswith('11'):
            tipo = 'rendimento_fii'
        else:
            tipo = 'dividendo'
            obs = 'lancado como RENDIMENTOS no extrato (complemento/atualizacao de provento)'
        return dict(ticker=ticker, data_pagamento=data, data_com='', tipo=tipo, valor_total=valor, qtd_base=qtd,
                    valor_por_cota=round(valor / qtd, 6) if qtd else '', obs=obs)
    m = re.match(r'CREDITO DE REEMBOLSO DE EVENTO (BR[A-Z0-9]{10})', desc)
    if m:
        ticker = ticker_do_isin(m.group(1))
        if not ticker:
            raise ValueError(f'ISIN sem ticker conhecido: {m.group(1)} ({data})')
        return dict(ticker=ticker, data_pagamento=data, data_com='', tipo='reembolso_evento', valor_total=valor,
                    qtd_base='', valor_por_cota='', obs=f'provento de ação emprestada, reembolsado pelo tomador ({m.group(1)})')
    m = re.match(r'RENDIMENTO FUNDO FECHADO BALCÃO (.*)', desc)
    if m:
        nome = m.group(1).strip()
        ticker = next((t for k, t in FUNDOS_FECHADOS.items() if nome.startswith(k)), None)
        if not ticker:
            raise ValueError(f'fundo fechado sem código no mapa: "{nome}" ({data})')
        return dict(ticker=ticker, data_pagamento=data, data_com='', tipo='rendimento_fundo', valor_total=valor,
                    qtd_base='', valor_por_cota='', obs='')
    return None


# ---------------------------------------------------------------- fluxos

FLUXOS = [
    ('aporte', r'RECEBIMENTO DE TED|Transferência recebida da conta digital|^Pix recebido|PIX RECEBIDO', 1),
    ('retirada', r'RETIRADA EM C/C|Transferência enviada para a conta digital|Pagamento para BANCO XP|^Pix enviado|PIX ENVIADO', -1),
    ('exterior', r'^Cambio VD Intern|^IOF Cambio Intern', -1),
    ('cashback', r'^Investback$', 1),
]


def fluxo(desc, valor):
    for tipo, rx, sinal in FLUXOS:
        if re.search(rx, desc):
            if (valor > 0) != (sinal > 0):
                raise ValueError(f'sinal inesperado para {tipo}: {desc} {valor}')
            return tipo
    return None


# ---------------------------------------------------------------- movimentos sem nota


def _subscricao_ticker(desc):
    m = re.search(r'BR([A-Z]{4})R\d', desc)
    if m:
        return m.group(1) + '11'
    m = re.search(r'([A-Z]{4})1\d\b', desc)
    return (m.group(1) + '11') if m else ''


def movimento(desc):
    """Devolve (tipo, produto, ticker, descrição) ou None."""
    d = desc
    if 'COMPRA TESOURO DIRETO' in d:
        return 'aplicacao', 'tesouro', '', d
    if 'LIQUIDAÇÃO TESOURO DIRETO' in d:
        return 'resgate', 'tesouro', '', d
    if re.search(r'IRRF S/TÍTULOS TESOURO|TAXA SEMESTRAL TESOURO', d):
        return 'custo', 'tesouro', '', d
    m = re.search(r'APLICAÇÃO FUNDOS (.*)', d)
    if m:
        return 'aplicacao', 'fundo', '', 'Aplicação ' + m.group(1).strip()
    if 'INTEGRALIZAÇÃO DE COTAS' in d:
        return 'aplicacao', 'fundo', '', d
    if 'IR RESGATE CDB' in d:
        return 'custo', 'cdb', '', d
    if 'RESGATE CDB' in d:
        return 'resgate', 'cdb', '', d
    if 'COMPRA CDB' in d:
        return 'aplicacao', 'cdb', '', d
    if 'IOF S/ RESGATE FUNDOS' in d:
        return 'custo', 'fundo', '', d
    if 'PAGAMENTO DE RESGATE DE RENDA VARI' in d:
        m = re.search(r'BR([A-Z]{4})', d)
        return 'venda', 'outro', (m.group(1) + '3') if m else '', d
    if d.startswith('RESGATE '):
        return 'resgate', 'fundo', '', d
    if d.startswith('SUBSCRIÇÃO') or 'SUBSCRIÇÃO DE SOBRAS' in d:
        return 'compra', 'subscricao', _subscricao_ticker(d), d
    if d.startswith('Exercício de Opções'):
        return 'compra', 'opcao', '', d
    m = re.match(r'FRAÇÕES DE AÇÕES ([A-Z0-9]{4}\d{1,2})', d)
    if m:
        return 'venda', 'outro', m.group(1), d
    if re.search(r'BMF|CORRETAGEM|BALCAO', d):
        return 'custo', 'derivativo', '', d
    if d.startswith('MULTA'):
        return 'custo', 'outro', '', d
    return None


def limpa_descricao(tipo, produto, desc):
    desc = re.sub(r'CTA [\d ]+-? ?', '', desc)  # número de conta do favorecido
    if tipo == 'custo' or produto == 'tesouro':  # agrupa taxas iguais: tira datas e números de nota
        desc = re.sub(r'\s*(PR\.\s*)?\d{2}[/-](\d{2}|[A-Z]{3})[/-]\d{2,4}', '', desc)
        desc = re.sub(r'\s*NC\.\s*\d+|\s+\d{5,}$', '', desc).strip()
    return desc


# Fora de propósito: notas de bolsa (outro script), BTC e pares que se anulam.
IGNORAR = re.compile(r'OPERAÇÕES EM BOLSA|BTC|doador|REGULARIZAÇÃO DE COMPRA|ESTORNO DEBITO COMPRAS|Prêmio de Opções')


# ---------------------------------------------------------------- principal


def ler(paths):
    linhas = []
    for p in paths:
        with open(p, encoding='utf-8') as f:
            for i, l in enumerate(f):
                partes = l.rstrip('\n').split('\t')
                if i == 0 and partes[0].strip().lower().startswith('mov'):
                    continue
                if len(partes) != 5:
                    raise ValueError(f'{p}:{i + 1}: esperava 5 colunas, veio {len(partes)}')
                linhas.append(partes)
    # O extrato vem do mais novo para o mais antigo; dentro do dia, a ordem do portal também é decrescente.
    return linhas


def confere_saldo(linhas):
    """Encadeia o saldo do mais antigo para o mais novo, arquivo a arquivo; devolve as quebras."""
    quebras = []
    anterior = None
    for mov, liq, desc, val, saldo in reversed(linhas):
        v, s = num(val), num(saldo)
        if anterior is not None and abs(anterior + v - s) > 0.011:
            quebras.append((liq, desc, round(anterior + v, 2), s))
        anterior = s
    return quebras


def main():
    args = sys.argv[1:]
    mapa = None
    if args and args[0] == '--mapa':
        mapa, args = args[1], args[2:]
    mapa = mapa or os.environ.get('XP_MAPA') or (
        os.path.join(os.path.dirname(os.environ['WALLET_DB']), 'coletas-xp', 'mapa.json') if os.environ.get('WALLET_DB') else None)
    if mapa and os.path.exists(mapa):
        with open(mapa, encoding='utf-8') as f:
            m = json.load(f)
        ISIN_BDR.update(m.get('bdr', {}))
        FUNDOS_FECHADOS.update(m.get('fundos_fechados', {}))
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    saida, paths = args[0], args[1:]
    os.makedirs(saida, exist_ok=True)
    # Ordena os arquivos pelo lançamento mais antigo, para o encadeamento do saldo.
    blocos = sorted((ler([p]) for p in paths), key=lambda b: [int(x) for x in reversed(b[-1][1].split('/'))] if b else [0])
    linhas = [l for b in reversed(blocos) for l in b]

    proventos, fluxos, movimentos, sem_classe = [], [], [], Counter()
    contagem = Counter()
    for mov, liq, desc, val in (l[:4] for l in linhas):
        v, data = num(val), iso(liq)
        p = provento(desc, v, data)
        if p:
            proventos.append(dict(p, fonte=FONTE, coletado_em=''))
            contagem['provento'] += 1
            continue
        t = fluxo(desc, v)
        if t:
            fluxos.append(dict(data=data, tipo=t, valor=v, descricao=desc, fonte=FONTE))
            contagem['fluxo'] += 1
            continue
        if IGNORAR.search(desc):
            contagem['fora (notas, BTC, pares)'] += 1
            continue
        m = movimento(desc)
        if m:
            tipo, produto, ticker, d = m
            movimentos.append(dict(data=data, tipo=tipo, produto=produto, ticker=ticker, valor=v,
                                   descricao=limpa_descricao(tipo, produto, d), fonte=FONTE))
            contagem['movimento'] += 1
            continue
        sem_classe[desc[:70]] += 1

    def grava(nome, campos, rows):
        rows = sorted(rows, key=lambda r: r[campos[1]] if nome == 'fato_provento.csv' else r['data'])
        with open(os.path.join(saida, nome), 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, campos)
            w.writeheader()
            w.writerows(rows)

    grava('fato_provento.csv', ['ticker', 'data_pagamento', 'data_com', 'tipo', 'valor_total', 'qtd_base',
                                'valor_por_cota', 'fonte', 'coletado_em', 'obs'], proventos)
    grava('fato_fluxo.csv', ['data', 'tipo', 'valor', 'descricao', 'fonte'], fluxos)
    grava('fato_movimento.csv', ['data', 'tipo', 'produto', 'ticker', 'valor', 'descricao', 'fonte'], movimentos)

    datas = sorted(iso(l[1]) for l in linhas)
    print(f'{len(linhas)} lançamentos, de {datas[0]} a {datas[-1]}')
    for k, n in sorted(contagem.items()):
        print(f'  {k}: {n}')
    soma = defaultdict(float)
    for r in fluxos:
        soma[r['tipo']] += r['valor']
    print('  fluxos por tipo:', {k: round(v, 2) for k, v in sorted(soma.items())})

    erro = False
    quebras = confere_saldo(linhas)
    if quebras:
        erro = True
        print(f'SALDO NÃO ENCADEIA em {len(quebras)} ponto(s):')
        for q in quebras[:10]:
            print('  ', q)
    if sem_classe:
        erro = True
        print('LANÇAMENTOS SEM CLASSIFICAÇÃO (ajuste o script):')
        for d, n in sem_classe.most_common():
            print(f'  {n} × {d}')
    sys.exit(1 if erro else 0)


if __name__ == '__main__':
    main()
