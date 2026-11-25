#!/usr/bin/env python3
"""Lê notas de negociação da XP (modelo B3/SINACOR) e gera fato_operacao.csv.

Uso:
    python3 scripts/xp/notas.py [--mapa mapa.json] <saida.csv> <nota.txt | pasta com .txt> [...]

O mapa (JSON) liga o nome da empresa na nota ao ticker e fica na pasta de dados, fora do
repositório. Sem --mapa, usa $XP_MAPA ou <pasta do WALLET_DB>/coletas-xp/mapa.json.

Entrada: o texto de cada nota extraído com `pdftotext -layout nota.pdf nota.txt` (poppler).
Saída: fato_operacao.csv no formato que `npm run import:xp` lê (uma linha por execução à vista):
    nota,data,liquidacao,ticker,classe,lado,mercado,quantidade,preco,valor,taxas,especificacao

Regras:
- Só o mercado à vista e o fracionário da Bovespa. Opções e operações da BM&F (opções flexíveis,
  termo) ficam de fora e são listadas no resumo.
- O ticker vem da especificação: FIIs trazem o código (BCRI11); "FIAGRO AAZQ" vira AAZQ11; ações
  vêm pelo nome da empresa e da espécie (ex.: "EMPRESA ON"), pelo mapa. Nome novo sem
  correspondência para o script com erro: acrescente-o ao mapa.
- As taxas da nota (liquidação, emolumentos, corretagem, impostos) são rateadas pelo valor de cada
  operação. Em nota que mistura Bovespa e BM&F, o rateio não é possível e as taxas ficam zeradas.
- Conferências (saída com erro se falharem): soma das compras e vendas = resumo da nota e
  quantidade × preço = valor de cada linha.
"""
import csv
import glob
import json
import os
import re
import sys

def carrega_mapa(caminho):
    """Mapa de nomes e classes, na pasta de dados (não no repositório: revela o que foi negociado).

    JSON: {"nomes": {"EMPRESA ON": "XXXX3", ...}, "classes": {"XXXX11": "etf", ...}}
    """
    if not caminho or not os.path.exists(caminho):
        return {}, {}
    with open(caminho, encoding='utf-8') as f:
        m = json.load(f)
    # Nome mais longo primeiro: "MOVIDA PARTI ON" antes de "MOVIDA ON".
    nomes = sorted(m.get('nomes', {}).items(), key=lambda kv: -len(kv[0]))
    return nomes, m.get('classes', {})


NOMES, CLASSES = [], {}

LINHA = re.compile(r'^\s*1-BOVESPA\s+([CV])\s+(VISTA|FRACIONARIO|OPCAO DE COMPRA|OPCAO DE VENDA)\s+(.*?)\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)\s+([DC])\s*$')


def num(s):
    return round(float(s.replace('.', '').replace(',', '.')), 2)


def iso(d):
    return '-'.join(reversed(d.split('/')))


def ticker(spec):
    s = re.sub(r'^\d\d/\d\d\s+', '', re.sub(r'\s+', ' ', spec))
    m = re.search(r'\b([A-Z]{4}\d{1,2}|[A-Z]{4}O\d{3})\b', s)
    if m:
        return m.group(1)
    m = re.match(r'FIAGRO ([A-Z]{4})', s)
    if m:
        return m.group(1) + '11'
    for nome, t in NOMES:
        if s.startswith(nome):
            return t
    raise ValueError(f'especificação sem ticker conhecido: "{s}" (acrescente em "nomes" no mapa)')


def le_nota(path):
    txt = open(path, encoding='utf-8').read()
    cab = re.search(r'Data pregão\s*\n\s*(\d+)\s+\d+\s+(\d\d/\d\d/\d{4})', txt)
    bmf = 'Mercadoria:' in txt
    if not cab:
        # Nota só de BM&F tem outro cabeçalho e nenhuma operação à vista.
        if bmf and not any(LINHA.match(l) for l in txt.splitlines()):
            return None, None, [], [f'{os.path.basename(path)} BM&F'], []
        raise ValueError(f'{path}: não achei número e data do pregão')
    nr, pregao = cab.groups()
    linhas, derivativos = [], []
    for l in txt.splitlines():
        m = LINHA.match(l)
        if not m:
            continue
        cv, merc, spec, q, p, v, _ = m.groups()
        t = ticker(spec)
        if merc.startswith('OPCAO'):
            derivativos.append(f'{pregao} opção {t}')
            continue
        linhas.append(dict(cv=cv, mercado=merc, ticker=t, qtd=int(q.replace('.', '')), preco=num(p), valor=num(v),
                           spec=re.sub(r'\s+', ' ', spec)))
    if bmf:
        derivativos.append(f'{pregao} BM&F')
    if not linhas:
        return nr, pregao, [], derivativos, []
    erros = []
    vendas = num(re.search(r'Vendas à vista\s+([\d.,]+)', txt).group(1))
    compras = num(re.search(r'Compras à vista\s+([\d.,]+)', txt).group(1))
    sv = round(sum(x['valor'] for x in linhas if x['cv'] == 'V'), 2)
    sc = round(sum(x['valor'] for x in linhas if x['cv'] == 'C'), 2)
    if abs(sv - vendas) > 0.01 or abs(sc - compras) > 0.01:
        erros.append(f'{path}: soma das linhas (C {sc}, V {sv}) ≠ resumo (C {compras}, V {vendas})')
    for x in linhas:
        if abs(x['qtd'] * x['preco'] - x['valor']) > 0.011 * max(1, x['qtd'] / 100):
            erros.append(f'{path}: {x["ticker"]} {x["qtd"]} × {x["preco"]} ≠ {x["valor"]}')
    liq = re.search(r'Líquido para\s+(\d\d/\d\d/\d{4})\s+([\d.,]+)\s+([DC])', txt)
    liquido = num(liq.group(2)) * (-1 if liq.group(3) == 'D' else 1)
    custos = None if bmf else round((sv - sc) - liquido, 2)
    base = sv + sc
    ops = []
    for x in linhas:
        taxa = round(custos * x['valor'] / base, 2) if custos is not None and base else 0.0
        ops.append(dict(nota=nr, data=iso(pregao), liquidacao=iso(liq.group(1)), ticker=x['ticker'],
                        classe=CLASSES.get(x['ticker'], ''), lado='buy' if x['cv'] == 'C' else 'sell',
                        mercado=x['mercado'], quantidade=x['qtd'], preco=x['preco'], valor=x['valor'], taxas=taxa,
                        especificacao=x['spec']))
    return nr, pregao, ops, derivativos, erros


def main():
    global NOMES, CLASSES
    args = sys.argv[1:]
    mapa = None
    if args and args[0] == '--mapa':
        mapa, args = args[1], args[2:]
    mapa = mapa or os.environ.get('XP_MAPA') or (
        os.path.join(os.path.dirname(os.environ['WALLET_DB']), 'coletas-xp', 'mapa.json') if os.environ.get('WALLET_DB') else None)
    NOMES, CLASSES = carrega_mapa(mapa)
    if len(args) < 2:
        print(__doc__)
        sys.exit(2)
    saida = args[0]
    arquivos = []
    for a in args[1:]:
        arquivos += sorted(glob.glob(os.path.join(a, '*.txt'))) if os.path.isdir(a) else [a]
    ops, derivativos, erros, notas = [], [], [], 0
    for f in arquivos:
        _, _, o, d, e = le_nota(f)
        ops += o
        derivativos += d
        erros += e
        notas += 1 if o else 0
    ops.sort(key=lambda r: (r['data'], r['nota']))
    campos = ['nota', 'data', 'liquidacao', 'ticker', 'classe', 'lado', 'mercado', 'quantidade', 'preco', 'valor',
              'taxas', 'especificacao']
    with open(saida, 'w', newline='', encoding='utf-8') as fh:
        w = csv.DictWriter(fh, campos)
        w.writeheader()
        w.writerows(ops)
    print(f'{len(arquivos)} nota(s) lida(s), {notas} com operações à vista, {len(ops)} operação(ões), '
          f'taxas R$ {sum(o["taxas"] for o in ops):.2f}')
    if derivativos:
        print('Fora (derivativos):', '; '.join(derivativos))
    if erros:
        print('ERROS:')
        for e in erros:
            print('  ', e)
        sys.exit(1)


if __name__ == '__main__':
    main()
