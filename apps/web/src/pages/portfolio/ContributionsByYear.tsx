import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Portfolio, type Trade } from '../../lib/api';
import { money, qty, signClass } from '../../lib/format';

type YearRow = NonNullable<Portfolio['contributions']>['by_year'][number];

interface AssetYear {
  ticker: string;
  buyQty: number;
  buyCents: number;
  sellQty: number;
  sellCents: number;
}

const tradeValue = (t: Trade) => Math.round(t.quantity * t.price_cents);

/** Aportes por ano, com as compras e vendas de ativos de cada ano (clique no ano para abrir). */
export default function ContributionsByYear({ byYear }: { byYear: YearRow[] }) {
  const { data: trades } = useQuery({ queryKey: ['trades'], queryFn: () => api.get<Trade[]>('/trades') });
  const [open, setOpen] = useState<string | null>(null);

  const tradesByYear = useMemo(() => {
    const years = new Map<string, { buy: number; sell: number; assets: Map<string, AssetYear> }>();
    for (const t of trades ?? []) {
      const y = t.date.slice(0, 4);
      if (!years.has(y)) years.set(y, { buy: 0, sell: 0, assets: new Map() });
      const yr = years.get(y)!;
      if (!yr.assets.has(t.ticker)) yr.assets.set(t.ticker, { ticker: t.ticker, buyQty: 0, buyCents: 0, sellQty: 0, sellCents: 0 });
      const a = yr.assets.get(t.ticker)!;
      const v = tradeValue(t);
      if (t.side === 'buy') {
        yr.buy += v;
        a.buyQty += t.quantity;
        a.buyCents += v;
      } else {
        yr.sell += v;
        a.sellQty += t.quantity;
        a.sellCents += v;
      }
    }
    return years;
  }, [trades]);

  // Anos com aporte ou com operação.
  const years = [...new Set([...byYear.map((y) => y.year), ...tradesByYear.keys()])].sort();
  const flows = new Map(byYear.map((y) => [y.year, y]));

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
            </tr>
          </thead>
          <tbody>
            {years.map((year) => {
              const y = flows.get(year);
              const t = tradesByYear.get(year);
              const isOpen = open === year;
              const assets = t ? [...t.assets.values()].sort((a, b) => b.buyCents + b.sellCents - (a.buyCents + a.sellCents)) : [];
              return (
                <Fragment key={year}>
                  <tr
                    onClick={() => t && setOpen(isOpen ? null : year)}
                    style={{ cursor: t ? 'pointer' : undefined }}
                    aria-expanded={t ? isOpen : undefined}
                  >
                    <td>
                      {t ? (isOpen ? '▾ ' : '▸ ') : ''}
                      {year}
                    </td>
                    <td className="num">{y ? money(y.in_cents) : '—'}</td>
                    <td className="num">{y?.out_cents ? money(-y.out_cents) : '—'}</td>
                    <td className={`num ${signClass(y?.net_cents)}`}>{y ? money(y.net_cents) : '—'}</td>
                    <td className="num">{y ? money(y.cumulative_net_cents) : '—'}</td>
                    <td className="num">{y?.abroad_cents ? money(y.abroad_cents) : '—'}</td>
                    <td className="num">{t?.buy ? money(t.buy) : '—'}</td>
                    <td className="num">{t?.sell ? money(t.sell) : '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} style={{ padding: '4px 0 12px 24px' }}>
                        <table>
                          <thead>
                            <tr>
                              <th>Ativo</th>
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
                                <td className="num">{a.buyCents ? money(a.buyCents) : '—'}</td>
                                <td className="num">{a.buyQty ? money(Math.round(a.buyCents / a.buyQty)) : '—'}</td>
                                <td className="num">{a.sellQty ? qty(a.sellQty) : '—'}</td>
                                <td className="num">{a.sellCents ? money(a.sellCents) : '—'}</td>
                                <td className="num">{a.sellQty ? money(Math.round(a.sellCents / a.sellQty)) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ marginTop: 12 }}>
        Entrou: TEDs e transferências recebidas mais cashback. Saiu: saques, transferências enviadas e faturas pagas com o saldo.
        Comprado e vendido: operações à vista das notas de negociação, sem taxas; clique no ano para ver os ativos. Fundos,
        Tesouro e CDBs não têm nota e não aparecem nessas colunas.
      </p>
    </div>
  );
}
