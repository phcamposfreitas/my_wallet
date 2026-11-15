/**
 * Fixtures sintéticas dos dados de mercado, montadas em memória pelos próprios testes:
 * registros COTAHIST de largura fixa, um ZIP mínimo e uma API do SGS simulada.
 * Nenhum dado real e nenhuma chamada de rede.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import type { FetchFn } from '../src/importers/sgs.ts';

// --- COTAHIST (layout de 245 posições da B3) ------------------------------------

const num = (v: number, len: number) => String(v).padStart(len, '0');
const txt = (s: string, len: number) => s.padEnd(len).slice(0, len);

export interface QuoteFields {
  date: string; // ISO
  ticker: string;
  close: number; // PREULT em centavos (por lote de `factor`)
  market?: string; // TPMERC, padrão '010' (à vista)
  codbdi?: string;
  factor?: number; // FATCOT
  name?: string;
  isin?: string;
  volume?: number; // VOLTOT em centavos
}

/** Um registro tipo 01. Abertura, máxima, mínima e médio repetem o fechamento. */
export function quote(f: QuoteFields): string {
  const line =
    '01' +
    f.date.replaceAll('-', '') +
    txt(f.codbdi ?? '02', 2) +
    txt(f.ticker, 12) +
    (f.market ?? '010') +
    txt(f.name ?? 'EMPRESA', 12) +
    txt('ON', 10) + // ESPECI
    txt('', 3) + // PRAZOT
    txt('R$', 4) + // MODREF
    num(f.close, 13).repeat(5) + // PREABE, PREMAX, PREMIN, PREMED, PREULT
    num(0, 13).repeat(2) + // PREOFC, PREOFV
    num(10, 5) + // TOTNEG
    num(1000, 18) + // QUATOT
    num(f.volume ?? 1_000_000, 18) + // VOLTOT
    num(0, 13) + // PREEXE
    '0' + // INDOPC
    '99991231' + // DATVEN
    num(f.factor ?? 1, 7) + // FATCOT
    num(0, 13) + // PTOEXE
    txt(f.isin ?? 'BRXXXXACNOR0', 12) + // CODISI
    num(100, 3); // DISMES
  if (line.length !== 245) throw new Error(`registro com ${line.length} posições`);
  return line;
}

/**
 * Arquivo completo com CRLF, como os da B3: cabeçalho, registros e trailer. O trailer
 * conta só os registros tipo 01. `trailerCount: null` omite o trailer (arquivo truncado).
 */
export function cotahistText(quotes: string[], opts: { trailerCount?: number | null } = {}): string {
  const lines = [txt('00COTAHIST.2026BOVESPA 20261112', 245), ...quotes];
  const count = opts.trailerCount === undefined ? quotes.length : opts.trailerCount;
  if (count !== null) lines.push(txt(`99COTAHIST.2026BOVESPA 20261112${num(count, 11)}`, 245));
  return lines.join('\r\n') + '\r\n';
}

/** ZIP mínimo com uma entrada comprimida (deflate), como os arquivos da B3. */
export function makeZip(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'latin1');
  const packed = deflateRawSync(data);
  const fileName = Buffer.from(name);
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // versão necessária
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // versão de origem
  central.writeUInt16LE(20, 6); // versão necessária
  central.writeUInt16LE(8, 10); // deflate
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42); // posição do cabeçalho local

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8); // entradas neste disco
  end.writeUInt16LE(1, 10); // entradas no total
  end.writeUInt32LE(central.length + fileName.length, 12); // tamanho do diretório central
  end.writeUInt32LE(local.length + fileName.length + packed.length, 16); // posição do diretório central

  return Buffer.concat([local, fileName, packed, central, fileName, end]);
}

// --- SGS (Banco Central) --------------------------------------------------------

/** código SGS → pontos [data ISO, valor como a API devolve] */
export type SgsPoints = Record<number, Array<[string, string]>>;

const br = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const iso = (b: string) => `${b.slice(6, 10)}-${b.slice(3, 5)}-${b.slice(0, 2)}`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Imita a API: devolve os pontos da janela pedida, 404 "Value(s) not found" quando a
 * janela não tem dados e, se configurado, falhas por código SGS (`times` respostas com `status`).
 */
export function fakeSgs(points: SgsPoints, failures: Record<number, { times: number; status: number; body?: unknown }> = {}) {
  const calls: string[] = [];
  const fetch: FetchFn = async (url) => {
    calls.push(url);
    const m = url.match(/bcdata\.sgs\.(\d+)\/dados\?formato=json&dataInicial=([\d/]+)&dataFinal=([\d/]+)$/);
    if (!m) return json({ error: 'URL inesperada' }, 400);
    const sgs = Number(m[1]);
    const fail = failures[sgs];
    if (fail && fail.times > 0) {
      fail.times--;
      return fail.body === undefined
        ? new Response('<html><body>Serviço indisponível</body></html>', { status: fail.status })
        : json(fail.body, fail.status);
    }
    const from = iso(m[2]);
    const to = iso(m[3]);
    const rows = (points[sgs] ?? []).filter(([d]) => d >= from && d <= to);
    if (!rows.length) return json({ erro: { statusCode: 404, detail: 'SGSNegocioException: Value(s) not found' } }, 404);
    return json(rows.map(([d, valor]) => ({ data: br(d), valor })));
  };
  return { fetch, calls };
}
