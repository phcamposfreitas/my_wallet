#!/usr/bin/env python3
"""
Remove a senha de faturas em PDF, salvando uma cópia aberta.

Isto NÃO quebra senha: abre o PDF com a senha que VOCÊ fornece e grava uma
versão sem proteção. Uma tentativa por arquivo — o script não adivinha, não
testa variações e não deriva a senha de CPF nem de nada.

A senha é digitada na hora (entrada oculta) ou lida da variável de ambiente
FATURA_SENHA. Ela nunca é gravada em disco, nem impressa, nem embutida aqui.

Uso:
    python3 scripts/desbloquear-fatura.py <arquivo.pdf | pasta> [--saida DIR]

Exemplos:
    # uma pasta inteira (todas com a mesma senha); grava em <pasta>/aberto/
    python3 scripts/desbloquear-fatura.py data/faturas/xp

    # um arquivo, escolhendo a pasta de saída
    python3 scripts/desbloquear-fatura.py data/faturas/xp/2026-02.pdf --saida /tmp/abertas

Requer o venv do projeto:  .venv/bin/python scripts/desbloquear-fatura.py ...
(ou  pip install pypdf  no seu Python)
"""
import argparse
import getpass
import os
import sys
from pathlib import Path

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.errors import PdfReadError
except ImportError:
    sys.exit("pypdf não encontrado. Rode com o venv: .venv/bin/python scripts/desbloquear-fatura.py …")


def coletar_pdfs(alvo: Path) -> list[Path]:
    if alvo.is_dir():
        return sorted(p for p in alvo.glob("*.pdf") if p.is_file())
    if alvo.is_file() and alvo.suffix.lower() == ".pdf":
        return [alvo]
    sys.exit(f"Caminho inválido (nem PDF nem pasta): {alvo}")


def desbloquear(entrada: Path, saida: Path, senha: str) -> str:
    """Devolve: 'ok' | 'sem_senha' | 'senha_incorreta' | 'erro:<msg>'."""
    try:
        reader = PdfReader(str(entrada))
    except PdfReadError as e:
        return f"erro:{e}"

    if reader.is_encrypted:
        # Uma única tentativa, com a senha fornecida. Sem fallback, sem adivinhação.
        try:
            if reader.decrypt(senha) == 0:
                return "senha_incorreta"
        except (PdfReadError, NotImplementedError) as e:
            return f"erro:{e}"
    else:
        resultado = "sem_senha"  # já estava aberto; copia mesmo assim

    writer = PdfWriter()
    try:
        writer.append(reader)
    except Exception as e:  # noqa: BLE001 — qualquer falha de cópia é reportada ao usuário
        return f"erro:{e}"

    saida.mkdir(parents=True, exist_ok=True)
    destino = saida / entrada.name
    with open(destino, "wb") as f:
        writer.write(f)
    return locals().get("resultado", "ok")


def main() -> int:
    ap = argparse.ArgumentParser(description="Salva uma cópia sem senha de faturas em PDF.")
    ap.add_argument("alvo", type=Path, help="arquivo PDF ou pasta com PDFs")
    ap.add_argument("--saida", type=Path, default=None,
                    help="pasta de saída (padrão: <pasta>/aberto)")
    args = ap.parse_args()

    pdfs = coletar_pdfs(args.alvo)
    if not pdfs:
        sys.exit("Nenhum PDF encontrado.")

    base = args.alvo if args.alvo.is_dir() else args.alvo.parent
    saida = args.saida or (base / "aberto")

    # A senha vem de você, nunca do script.
    senha = os.environ.get("FATURA_SENHA") or getpass.getpass("Senha do PDF (não aparece na tela): ")
    if not senha:
        sys.exit("Senha vazia — nada a fazer.")

    print(f"{len(pdfs)} arquivo(s) · saída: {saida}")
    ok = incorreta = erro = 0
    for p in pdfs:
        status = desbloquear(p, saida, senha)
        if status in ("ok", "sem_senha"):
            ok += 1
            print(f"  ✓ {p.name}" + (" (já estava sem senha)" if status == "sem_senha" else ""))
        elif status == "senha_incorreta":
            incorreta += 1
            print(f"  ✗ {p.name}: senha incorreta")
        else:
            erro += 1
            print(f"  ! {p.name}: {status[4:]}")

    print(f"\nConcluído: {ok} aberto(s), {incorreta} com senha incorreta, {erro} com erro.")
    if incorreta:
        print("Senha incorreta: confira e rode de novo. O script não tenta variações por conta própria.")
    return 1 if (incorreta or erro) else 0


if __name__ == "__main__":
    raise SystemExit(main())
