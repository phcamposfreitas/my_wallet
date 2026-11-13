#!/usr/bin/env python3
"""Converte o texto (pdftotext -layout) de uma fatura Nubank no payload da API."""
import re, json, sys, unicodedata

MESES = {'JAN':1,'FEV':2,'MAR':3,'ABR':4,'MAI':5,'JUN':6,'JUL':7,'AGO':8,'SET':9,'OUT':10,'NOV':11,'DEZ':12}

def cents(s):
    # "R$ 1.234,56" ou "−R$ 0,18" -> inteiro em centavos (com sinal)
    neg = '−' in s or s.strip().startswith('-')
    n = re.sub(r'[^\d,]', '', s).replace('.', '').replace(',', '.')
    v = round(float(n) * 100)
    return -v if neg else v

def norm(s):
    return unicodedata.normalize('NFKD', s).encode('ascii','ignore').decode().lower()

def categorize(desc):
    d = norm(desc)
    def has(*ks): return any(k in d for k in ks)
    if has('ifood club'): return 'Assinaturas'
    if has('anthropic','claude','elevenlabs','openai','microsoft','spotify','netflix','subscription','fewgood','google','starlink','intch'):
        return 'Assinaturas' if has('anthropic','claude','elevenlabs','openai','microsoft','spotify','netflix','subscription','starlink') else 'Outros gastos'
    if has('iof'): return 'Impostos e taxas'
    if has('daki','rei das carnes','mercado','super','hortifruti','liv up','assai','carrefour','pao de acucar'): return 'Mercado'
    if has('localiza','uber','99app','99 *','posto','combustivel','estaciona','shell','ipiranga','raizen'): return 'Transporte'
    if has('pratique','farmacia','drogaria','academia','smartfit','clinica','laboratorio','hospital'): return 'Saúde'
    if has('ifd','ifood','restaurante','bar ','pizzaria','sushi','acai','lanchonete','cozinha','burguer','hamburger','pao','cafe','padaria','freixenet','point beer','napoli','benja','daki'):
        # Daki já tratado acima; aqui cobre restaurantes/iFood
        return 'Alimentação'
    if has('centauro','leitura','livraria','ki art','renner','magalu','amazon','loja','shopping','habitt','santillana','multiselo'): return 'Compras'
    if has('atletico','cinema','ingresso','show','spotify'): return 'Lazer'
    return None

def parse(path, due_date, account_name='Nubank'):
    text = open(path, encoding='utf-8').read()
    lines = text.splitlines()

    # restringe o resumo ao bloco "RESUMO DA FATURA ATUAL" (evita a tabela de parcelamento)
    start = next((i for i, ln in enumerate(lines) if 'RESUMO DA FATURA ATUAL' in ln), 0)
    resumo = lines[start:]

    def find_amount(label, src=None):
        for ln in (src if src is not None else lines):
            if label in ln:
                m = re.search(r'−?R\$\s*[\d.]+,\d{2}', ln)
                if m: return cents(m.group())
        return None

    prev = find_amount('Fatura anterior', resumo) or 0
    pay = abs(find_amount('Pagamento recebido', resumo) or 0)
    total = find_amount('Total a pagar', resumo)

    # vencimento (lido do PDF)
    mv = re.search(r'Data de vencimento:\s*(\d{2})\s+([A-Z]{3})\s+(\d{4})', text)
    year = int(mv.group(3)) if mv else 2026
    if mv:
        due_date = f"{int(mv.group(3))}-{MESES[mv.group(2)]:02d}-{int(mv.group(1)):02d}"

    items = []
    # Linha de transação: DD MMM [•••• NNNN] descrição ... valor
    tx_re = re.compile(r'^\s*(\d{2})\s+([A-Z]{3})\s+(?:(?:•|\.){2,}\s*(\d{4})\s+)?(.+?)\s+(−?R\$\s*[\d.]+,\d{2})\s*$')
    conv_re = re.compile(r'Conversão:.*?=\s*R\$')
    for ln in lines:
        m = tx_re.match(ln)
        if not m:
            continue
        dd, mmm, card, desc, val = m.groups()
        desc = desc.strip()
        if mmm not in MESES:
            continue
        # pular pagamentos e subtotais
        if re.match(r'(?i)pagamento', desc):
            continue
        amt = cents(val)
        if amt == 0:  # linhas de R$ 0,00 não têm efeito financeiro
            continue
        mo = MESES[mmm]
        # ano: a data não traz o ano. Uma compra não pode ser posterior ao vencimento,
        # então mês da compra > mês do vencimento significa ano anterior (ex.: "31 DEZ"
        # na fatura que vence em fevereiro, ou parcela antiga listada no início do período).
        y = year
        if mv and mo > MESES[mv.group(2)]:
            y = year - 1
        date = f"{y}-{mo:02d}-{int(dd):02d}"
        it = {"date": date, "description": desc, "amount_cents": amt}
        cat = categorize(desc)
        if cat: it["category"] = cat
        if card: it["card_last4"] = card
        items.append(it)

    # Nubank às vezes arredonda o "Total de compras" e cobra 1 centavo a mais/menos
    # do que a soma dos lançamentos. Reconcilia com uma linha explícita de ajuste.
    if total is not None:
        gap = total - (prev - pay + sum(i["amount_cents"] for i in items))
        if gap != 0 and abs(gap) <= 5:
            items.append({"date": due_date, "description": "Ajuste de arredondamento da fatura (Nubank)", "amount_cents": gap})

    payload = {
        "account": {"name": account_name, "institution": "Nubank"},
        "statement": {
            "due_date": due_date,
            "total_cents": total,
            "previous_balance_cents": prev,
            "payments_cents": pay,
            "source": f"nubank-pdf:{due_date}",
            "extracted_by": "claude",
        },
        "items": items,
    }
    items_sum = sum(i["amount_cents"] for i in items)
    computed = prev - pay + items_sum
    return payload, {"due": due_date, "prev": prev, "pay": pay, "total": total,
                     "items": len(items), "items_sum": items_sum,
                     "computed": computed, "diff": (total - computed) if total is not None else None}

if __name__ == '__main__':
    path, due, out = sys.argv[1], sys.argv[2], sys.argv[3]
    payload, rec = parse(path, due)
    json.dump(payload, open(out, 'w'), ensure_ascii=False)
    print(json.dumps(rec, ensure_ascii=False))
