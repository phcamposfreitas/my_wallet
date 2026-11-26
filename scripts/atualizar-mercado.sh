#!/bin/sh
# Atualização diária dos dados de mercado: baixa o COTAHIST diário da B3 dos últimos pregões
# que ainda não estão na pasta b3/ (ao lado do banco), importa pela API e continua as séries
# do Banco Central. Pode rodar quantas vezes for: a importação não duplica.
#
# Uso:  WALLET_DB=<caminho do banco> [API_PORT=3340] sh scripts/atualizar-mercado.sh
# Feito para o launchd (macOS: usa `date -v`). A B3 publica o arquivo do dia à noite; dia sem
# pregão não tem arquivo. Quem importa é a API em 127.0.0.1, que precisa estar no ar.
set -u
: "${WALLET_DB:?defina WALLET_DB com o caminho do banco}"
API="http://127.0.0.1:${API_PORT:-3340}/api"
DIR="$(dirname "$WALLET_DB")/b3"
BASE="https://bvmf.bmfbovespa.com.br/InstDados/SerHist"
DIAS="${DIAS:-7}" # quantos dias para trás conferir (cobre feriados e dias com o computador desligado)

echo "== $(date '+%Y-%m-%d %H:%M') =="
if ! curl -sf --max-time 10 "$API/health" >/dev/null; then
  echo "API fora do ar em $API; nada importado"
  exit 1
fi
mkdir -p "$DIR"
falhas=0

i=0
while [ "$i" -lt "$DIAS" ]; do
  dia=$(date -v-"${i}"d +%d%m%Y)
  semana=$(date -v-"${i}"d +%u)
  i=$((i + 1))
  [ "$semana" -ge 6 ] && continue # sábado e domingo
  arquivo="COTAHIST_D$dia.ZIP"
  [ -f "$DIR/$arquivo" ] && continue
  status=$(curl -s -o "$DIR/$arquivo.part" -w '%{http_code}' --max-time 300 "$BASE/$arquivo")
  # A B3 pode responder 200 com uma página de erro: só vale se for um ZIP de verdade.
  if [ "$status" != 200 ] || [ "$(head -c 2 "$DIR/$arquivo.part" 2>/dev/null)" != PK ]; then
    rm -f "$DIR/$arquivo.part"
    echo "$arquivo: sem arquivo na B3 (HTTP $status)"
    continue
  fi
  mv "$DIR/$arquivo.part" "$DIR/$arquivo"
  resposta=$(curl -s --max-time 300 -X POST "$API/prices/import" -H 'content-type: application/json' -d "{\"path\":\"$DIR/$arquivo\"}")
  case "$resposta" in
    *'"ok":true'*) echo "$arquivo: importado $(echo "$resposta" | grep -o '"inserted":[0-9]*' | head -1)" ;;
    *)
      echo "$arquivo: falha na importação: $(echo "$resposta" | cut -c1-300)"
      rm -f "$DIR/$arquivo" # tenta de novo na próxima vez
      falhas=$((falhas + 1))
      ;;
  esac
done

resposta=$(curl -s --max-time 300 -X POST "$API/series/import" -H 'content-type: application/json' -d '{}')
case "$resposta" in
  *'"ok":true'*) echo "séries: atualizadas $(echo "$resposta" | grep -o '"inserted":[0-9]*' | tr '\n' ' ')" ;;
  *)
    echo "séries: falha: $(echo "$resposta" | cut -c1-300)"
    falhas=$((falhas + 1))
    ;;
esac
# Tesouro Direto (PU base dos últimos dias), proventos anunciados na B3 e cotas de fundos (CVM).
# São fontes externas instáveis: uma falha aqui é registrada e tentada de novo na próxima execução.
importa() { # nome, rota, corpo JSON
  resposta=$(curl -s --max-time 600 -X POST "$API/$2" -H 'content-type: application/json' -d "$3")
  case "$resposta" in
    *'"ok":true'*) echo "$1: ok $(echo "$resposta" | grep -o '"inserted":[0-9]*' | tr '\n' ' ')" ;;
    *)
      echo "$1: falha: $(echo "$resposta" | cut -c1-300)"
      falhas=$((falhas + 1))
      ;;
  esac
}
importa tesouro tesouro/import "{\"since\":\"$(date -v-15d +%Y-%m-%d)\"}"
importa proventos market-income/import "{\"since\":\"$(date -v-120d +%Y-%m-%d)\"}"
importa fundos funds/import '{}'

[ "$falhas" -eq 0 ]
