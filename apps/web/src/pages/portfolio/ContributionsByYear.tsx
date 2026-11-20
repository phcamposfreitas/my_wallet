import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ContributionYear, type Trade } from '../../lib/api';
import { money, qty, signClass } from '../../lib/format';

interface AssetYear {
  ticker: string;
  buyQty: number;
  buyCents: number;
  sellQty: number;
  sellCents: number;
}

const tradeValue = (t: Trade) => Math.round(t.quantity * t.price_cents);
const dash = (cents: number) => (cents ? money(cents) : '—');

const KIND_LABEL: Record<string, string> = {
  compra: 'Compra sem nota',
  venda: 'Venda sem nota',
  aplicacao: 'Aplicação',
  resgate: 'Resgate',
  custo: 'Custo',
};
const PRODUCT_LABEL: Record<string, string> = {
  tesouro: 'Tesouro Direto',
  fundo: 'Fundo',
  cdb: 'CDB',
  subscricao: 'Subscrição',
  opcao: 'Opção',
  derivativo: 'Derivativo',
  outro: 'Outro',
};

const COLUMNS = 11;

/** Aportes por ano, com compras, vendas, aplicações, resgates e proventos de cada ano (clique no ano para abrir). */
export default function ContributionsByYear({ byYear }: { byYear: ContributionYear[] }) {
  const { data: trades } = useQuery({ queryKey: ['trades'], queryFn: () => api.get<Trade[]>('/trades') });
  const [open, setOpen] = useState<string | null>(null);

  const assetsByYear = useMemo(() => {
    const years = new Map<string, Map<string, AssetYear>>();
    for (const t of trades ?? []) {
      const y = t.date.slice(0, 4);
      if (!years.has(y)) years.set(y, new Map());
      const assets = years.get(y)!;
      if (!assets.has(t.ticker)) assets.set(t.ticker, { ticker: t.ticker, buyQty: 0, buyCents: 0, sellQty: 0, sellCents: 0 });
      const a = assets.get(t.ticker)!;
      if (t.side === 'buy') {
        a.buyQty += t.quantity;
        a.buyCents += tradeValue(t);
      } else {
        a.sellQty += t.quantity;
        a.sellCents += tradeValue(t);
      }
    }
    return years;
  }, [trades]);

  const total = byYear.reduce(
    (s, y) => ({
      in: s.in + y.in_cents,
      out: s.out + y.out_cents,
      net: s.net + y.net_cents,
      abroad: s.abroad + y.abroad_cents,
      bought: s.bought + y.bought_cents,
      sold: s.sold + y.sold_cents,
      applied: s.applied + y.applied_cents,
      redeemed: s.redeemed + y.redeemed_cents,
      income: s.income + y.income_cents,
    }),
    { in: 0, out: 0, net: 0, abroad: 0, bought: 0, sold: 0, applied: 0, redeemed: 0, income: 0 },
  );

  return (
    <div className="card">
      <h2>Aportes por ano</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ano</th>
              <th className="num">Entrou</th>
              <th className="num">Saiu</th>
              <th className="num">Aportado no ano</th>
              <th className="num">Acumulado</th>
              <th className="num">Enviado ao exterior</th>
              <th className="num">Comprado em ativos</th>
              <th className="num">Vendido em ativos</th>
              <th className="num">Aplicado em Tesouro, fundos e CDB</th>
              <th className="num">Resgatado</th>
              <th className="num">Proventos</th>
            </tr>
          </thead>
          <tbody>
            {byYear.map((y) => {
              const assets = [...(assetsByYear.get(y.year)?.values() ?? [])].sort(
                (a, b) => b.buyCents + b.sellCents - (a.buyCents + a.sellCents),
              );
              const hasDetail = assets.length > 0 || y.movements.length > 0;
              const isOpen = open === y.year;
              return (
                <Fragment key={y.year}>
                  <tr
                    onClick={() => hasDetail && setOpen(isOpen ? null : y.year)}
                    style={{ cursor: hasDetail ? 'pointer' : undefined }}
                    aria-expanded={hasDetail ? isOpen : undefined}
                  >
                    <td>
                      {hasDetail ? (isOpen ? '▾ ' : '▸ ') : ''}
                      {y.year}
                    </td>
                    <td className="num">{dash(y.in_cents)}</td>
                    <td className="num">{y.out_cents ? money(-y.out_cents) : '—'}</td>
                    <td className={`num ${signClass(y.net_cents)}`}>{money(y.net_cents)}</td>
                    <td className="num">{money(y.cumulative_net_cents)}</td>
                    <td className="num">{dash(y.abroad_cents)}</td>
                    <td className="num">{dash(y.bought_cents)}</td>
                    <td className="num">{dash(y.sold_cents)}</td>
                    <td className="num">{dash(y.applied_cents)}</td>
                    <td className="num">{dash(y.redeemed_cents)}</td>
                    <td className="num">{dash(y.income_cents)}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={COLUMNS} style={{ padding: '4px 0 12px 24px' }}>
                        {assets.length > 0 && (
                          <table>
                            <thead>
                              <tr>
                                <th>Ativo (notas de negociação)</th>
                                <th className="num">Qtd. comprada</th>
                                <th className="num">Comprado</th>
                                <th className="num">Preço médio compra</th>
                                <th className="num">Qtd. vendida</th>
                                <th className="num">Vendido</th>
                                <th className="num">Preço médio venda</th>
                              </tr>
                            </thead>
                            <tbody>
                              {assets.map((a) => (
                                <tr key={a.ticker}>
                                  <td>{a.ticker}</td>
                                  <td className="num">{a.buyQty ? qty(a.buyQty) : '—'}</td>
                                  <td className="num">{dash(a.buyCents)}</td>
                                  <td className="num">{a.buyQty ? money(Math.round(a.buyCents / a.buyQty)) : '—'}</td>
                                  <td className="num">{a.sellQty ? qty(a.sellQty) : '—'}</td>
                                  <td className="num">{dash(a.sellCents)}</td>
                                  <td className="num">{a.sellQty ? money(Math.round(a.sellCents / a.sellQty)) : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {y.movements.length > 0 && (
                          <table style={{ marginTop: assets.length ? 12 : 0 }}>
                            <thead>
                              <tr>
                                <th>Sem nota (extrato)</th>
                                <th>Produto</th>
                                <th>Descrição</th>
                                <th className="num">Lançamentos</th>
                                <th className="num">Valor</th>
                              </tr>
                            </thead>
                            <tbody>
                              {y.movements.map((m, i) => (
                                <tr key={i}>
                                  <td>{KIND_LABEL[m.kind] ?? m.kind}</td>
                                  <td>{PRODUCT_LABEL[m.product] ?? m.product}{m.ticker ? ` · ${m.ticker}` : ''}</td>
                                  <td>{m.description}</td>
                                  <td className="num">{m.count}</td>
                                  <td className={`num ${signClass(m.amount_cents)}`}>{money(m.amount_cents)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 600 }}>
              <td>Total</td>
              <td className="num">{money(total.in)}</td>
              <td className="num">{money(-total.out)}</td>
              <td className={`num ${signClass(total.net)}`}>{money(total.net)}</td>
              <td className="num">{money(total.net)}</td>
              <td className="num">{dash(total.abroad)}</td>
              <td className="num">{money(total.bought)}</td>
              <td className="num">{money(total.sold)}</td>
              <td className="num">{money(total.applied)}</td>
              <td className="num">{money(total.redeemed)}</td>
              <td className="num">{money(total.income)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="note" style={{ marginTop: 12 }}>
        Entrou: TEDs e transferências recebidas mais cashback. Saiu: saques, transferências enviadas e faturas pagas com o saldo.
        Comprado e vendido: notas de negociação mais compras e vendas sem nota (subscrições, exercício de opção, frações), sem
        taxas. Aplicado e resgatado: Tesouro Direto, fundos e CDB, pelo extrato. Proventos: dividendos, JCP, rendimentos e
        reembolsos pagos no ano. Clique no ano para ver o detalhe.
      </p>
    </div>
  );
}
