#!/usr/bin/env python3
"""Converte o texto (pdftotext -layout) de uma fatura Itaú no payload da API."""
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
    if has('tim ','vivo','claro','oi ','net ','telefon','amazon web','aws','google','apple.com','microsoft','netflix',
           'spotify','anthropic','claude','openai','disney','hbo','starlink','subscription','prime'):
        return 'Assinaturas'
    if has('iof','anuidade','juros','multa','tarifa','encargo','repasse de iof'): return 'Impostos e taxas'
    if has('raia2','droga raia','drogaria','farmacia','smartfit','academia','clinica','laborator','odonto','hospital','pague menos','drogasil'):
        return 'Saúde'
    if has('posto','uber','99app','ipiranga','shell','raizen','estaciona','combustivel','onibus','metro','latam','gol ','azul '):
        return 'Transporte'
    if has('sacolao','hortifruti','supermerc','mercado','assai','carrefour','epa ','pao de acucar','zona sul'):
        return 'Mercado'
    if has('padaria','lanchonete','burgu','restaurante','pizzaria','sushi','acai','cafe','ifood','bar ','food','hamburg','pao'):
        return 'Alimentação'
    if has('amazon','mercadolivre','magalu','renner','loja','shopping','americanas','aliexpress','shopee','shein','centauro','leitur'):
        return 'Compras'
    if has('loteria','cinema','ingresso','show','atletico','steam','playstation','netflix'):
        return 'Lazer'
    return None

SKIP = re.compile(r'(?i)^(pagamento|total|lançamento|lancamento|saldo|limite|dólar|dolar|repasse|subtotal|p\s+total|l\s+total|s\s+)')

def parse(path, account_name):
    text = open(path, encoding='utf-8').read()
    lines = text.splitlines()

    def find(label):
        for ln in lines:
            if label in ln:
                m = re.search(r'-?[\d.]+,\d{2}', ln)
                if m: return cents(m.group())
        return None

    prev = find('Total da fatura anterior') or 0
    # "Pagamento efetuado em …" aparece no resumo dos dois templates (antigo e novo).
    pay = abs(find('Pagamento efetuado') or 0)
    total = find('Total desta fatura')
    lanc = find('Total dos lançamentos atuais')

    mv = re.search(r'Vencimento:\s*(\d{2})/(\d{2})/(\d{4})', text)
    due_date = f"{mv.group(3)}-{mv.group(2)}-{mv.group(1)}" if mv else None
    vy, vm = (int(mv.group(3)), int(mv.group(2))) if mv else (2026, 1)
    me = re.search(r'Emiss[ãa]o:\s*(\d{2})/(\d{2})/(\d{4})', text)  # emissão = fechamento
    closing_date = f"{me.group(3)}-{me.group(2)}-{me.group(1)}" if me else None

    def ano(mm):
        return vy - 1 if mm > vm else vy

    # Para de ler no início das parcelas futuras (não são cobradas nesta fatura).
    cut = next((i for i, ln in enumerate(lines)
                if re.search(r'(?i)próximas faturas|proximas faturas|compras parceladas', ln)), len(lines))

    items = []
    tx = re.compile(r'^\s*(\d{2})/(\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})')
    for ln in lines[:cut]:
        m = tx.match(ln)
        if not m:
            # Repasse de IOF (internacional) não tem data própria
            mi = re.search(r'Repasse de IOF em R\$\s+(-?[\d.]+,\d{2})', ln)
            if mi and cents(mi.group(1)) != 0:
                items.append({"date": due_date, "description": "Repasse de IOF (internacional)",
                              "amount_cents": cents(mi.group(1)), "category": "Impostos e taxas"})
            continue
        dd, mm, desc, val = m.groups()
        desc = re.sub(r'\s{2,}', ' ', desc).strip()
        if SKIP.match(desc) or re.search(r'(?i)pagamento', desc):
            continue
        amt = cents(val)
        if amt == 0:
            continue
        mo = int(mm)
        it = {"date": f"{ano(mo)}-{mm}-{dd}", "description": desc, "amount_cents": amt}
        c = categorize(desc)
        if c: it["category"] = c
        # Parcela ("SAMSUNG NO ITAU 18/21"): data impressa é a da compra original.
        mp = re.search(r'\s(\d{1,2})/(\d{1,2})$', desc)
        if mp and 0 < int(mp.group(1)) <= int(mp.group(2)):
            it["installment_number"], it["installment_total"] = int(mp.group(1)), int(mp.group(2))
        items.append(it)

    if total is not None:
        gap = total - (prev - pay + sum(i["amount_cents"] for i in items))
        if gap != 0 and abs(gap) <= 5:
            items.append({"date": due_date, "description": "Ajuste de arredondamento da fatura (Itaú)", "amount_cents": gap})

    payload = {
        "account": {"name": account_name, "institution": "Itaú"},
        "statement": {"due_date": due_date, "closing_date": closing_date, "total_cents": total,
                      "previous_balance_cents": prev, "payments_cents": pay,
                      "source": f"itau-pdf:{account_name}:{due_date}", "extracted_by": "claude"},
        "items": items,
    }
    s = sum(i["amount_cents"] for i in items)
    return payload, {"due": due_date, "prev": prev, "pay": pay, "total": total, "lanc": lanc,
                     "items": len(items), "items_sum": s,
                     "diff": (total - (prev - pay + s)) if total is not None else None}

if __name__ == '__main__':
    path, account, out = sys.argv[1], sys.argv[2], sys.argv[3]
    payload, rec = parse(path, account)
    json.dump(payload, open(out, 'w'), ensure_ascii=False)
    print(json.dumps(rec, ensure_ascii=False))
