#!/usr/bin/env python3
"""Converte o texto (pdftotext -layout) de uma fatura do Cartão XP no payload da API."""
import re, json, sys, unicodedata

def cents(s):
    neg = s.strip().startswith('-')
    n = re.sub(r'[^\d,]', '', s).replace(',', '.')
    v = round(float(n) * 100)
    return -v if neg else v

def norm(s):
    return unicodedata.normalize('NFKD', s).encode('ascii','ignore').decode().lower()

def categorize(desc):
    d = norm(desc)
    def has(*ks): return any(k in d for k in ks)
    if has('vida xp','xp *vida','seguro'):
        return 'Seguros'
    if has('ifood club','amazon prime','prime canais','apple.com','google','netflix','spotify','amazon music',
           'anthropic','claude','openai','elevenlabs','microsoft','vindi','tinder','disney','hbo','max '):
        return 'Assinaturas'
    if has('iof','anuidade','juros','multa','tarifa','encargo'): return 'Impostos e taxas'
    if has('raia2','droga raia','drogaria','farmacia','fitpro','sofit','smartfit','academia','drsaude','pague menos','clinica','laboratorio','odonto'):
        return 'Saúde'
    if has('posto','quick ltda','uber','99app','dl *uber','dl*uber','ipiranga','shell','raizen','estaciona','combustivel','onibus','metro'):
        return 'Transporte'
    if has('sup epa','epa ','sacolao','hortifruti','supermerc','mercado','assai','carrefour','pao de acucar','zona sul','sup '):
        return 'Mercado'
    if has('oficina do pao','padaria','lanchonete','burgu','mordidao','choper','bar ','restaurante','pizzaria','sushi','acai',
           'uai santa','cafe','ifood','ifd','mordida','food','burger','hamburg'):
        return 'Alimentação'
    if has('amazon','mercadolivre','mercadolibre','mp*','magalu','renner','araujo loja','leiturinha','leitura','centauro','shopping','loja','americanas','aliexpress','shopee','shein'):
        return 'Compras'
    if has('loteria','loterias','cinema','ingresso','show','atletico','steam','playstation','xbox','nintendo'):
        return 'Lazer'
    return None

def parse(path, account_name='Cartão XP'):
    text = open(path, encoding='utf-8').read()
    lines = text.splitlines()
    low = text

    def find(label):
        for ln in lines:
            if label in ln:
                m = re.search(r'-?[\d.]+,\d{2}', ln)
                if m: return cents(m.group())
        return None

    prev = find('Total da fatura anterior') or 0
    pay = abs(find('Pagamentos/créditos até a emissão da fatura') or 0)
    total = find('Valor total devido')
    despesas = find('Despesas até a emissão desta fatura')

    mv = re.search(r'(\d{2})/(\d{2})/(\d{4})', text)  # 1ª DD/MM/AAAA = vencimento (cabeçalho)
    due_date = f"{mv.group(3)}-{mv.group(2)}-{mv.group(1)}" if mv else None
    # "Fatura fechada em" fica numa linha e a data na seguinte.
    mf = re.search(r'Fatura fechada em[^\n]*\n\s*(\d{2})/(\d{2})/(\d{4})', text)
    closing_date = f"{mf.group(3)}-{mf.group(2)}-{mf.group(1)}" if mf else None

    tx = re.compile(r'^\s*(\d{2})/(\d{2})/(\d{2})(?!\d)\s+(.+?)\s+(-?[\d.]+,\d{2})(?:\s+(-?[\d.]+,\d{2}))?\s*$')
    items = []
    for ln in lines:
        m = tx.match(ln)
        if not m:
            continue
        dd, mm, yy, desc, rs, usd = m.groups()
        desc = re.sub(r'\s{2,}', ' ', desc).strip()
        # Pula pagamentos/créditos (já vêm do resumo) e subtotais. "Pagamento de
        # fatura" e "Pagamentos Validos Normais" (cartão adicional) são o pagamento.
        # Não confundir com nomes de loja tipo "Pratique Pay"/"CredPag" (não começam com "Pagamento").
        if re.match(r'(?i)pagamentos?\b', desc) or re.match(r'(?i)(subtotal|saldo anterior|total)\b', desc):
            continue
        amt = cents(rs)
        if amt == 0:
            continue
        it = {"date": f"20{yy}-{mm}-{dd}", "description": desc, "amount_cents": amt}
        cat = categorize(desc)
        if cat: it["category"] = cat
        # Parcela: a data impressa é a da compra original; a API move parcelas 2/N
        # para o fechamento da fatura (o mês em que foram cobradas).
        mp = re.search(r'-\s*parcela\s*(\d+)\s*/\s*(\d+)', desc, re.I)
        if mp:
            it["installment_number"], it["installment_total"] = int(mp.group(1)), int(mp.group(2))
        if usd and cents(usd) != 0:
            it["original_amount"] = abs(cents(usd)) / 100
            it["original_currency"] = "USD"
        items.append(it)

    if total is not None:
        gap = total - (prev - pay + sum(i["amount_cents"] for i in items))
        if gap != 0 and abs(gap) <= 5:
            items.append({"date": due_date, "description": "Ajuste de arredondamento da fatura (XP)", "amount_cents": gap})

    payload = {
        "account": {"name": account_name, "institution": "XP"},
        "statement": {"due_date": due_date, "closing_date": closing_date, "total_cents": total,
                      "previous_balance_cents": prev, "payments_cents": pay,
                      "source": f"xp-pdf:{due_date}", "extracted_by": "claude"},
        "items": items,
    }
    s = sum(i["amount_cents"] for i in items)
    return payload, {"due": due_date, "prev": prev, "pay": pay, "total": total,
                     "despesas": despesas, "items": len(items), "items_sum": s,
                     "diff": (total - (prev - pay + s)) if total is not None else None}

if __name__ == '__main__':
    path, out = sys.argv[1], sys.argv[2]
    payload, rec = parse(path)
    json.dump(payload, open(out, 'w'), ensure_ascii=False)
    print(json.dumps(rec, ensure_ascii=False))
