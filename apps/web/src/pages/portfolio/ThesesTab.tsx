import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, type Theses, type ThesesIncome, type ThesisAsset, type ThesisGroup } from '../../lib/api';
import { ASSET_CLASS_LABEL, date, money, pct, signClass } from '../../lib/format';
import StackedColumns, { shortMonth } from '../../components/StackedColumns';
import { Kpi, Loading } from '../../components/ui';
import Deadlines from '../../components/Deadlines';
import { AsOf, ReviewDate, StatusBadge } from './thesis-ui';

export default function ThesesTab() {
  const { data, error } = useQuery({ queryKey: ['theses'], queryFn: () => api.get<Theses>('/theses') });
  const income = useQuery({ queryKey: ['theses-income'], queryFn: () => api.get<ThesesIncome>('/theses/income?months=24') });
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!data) return <Loading error={error} />;

  const toggle = (id: string) => {
    const next = new Set(open);
    next.has(id) ? next.delete(id) : next.add(id);
    setOpen(next);
  };
  const groups: { key: string; group: ThesisGroup }[] = [
    ...data.theses.map((t) => ({ key: t.id, group: t as ThesisGroup })),
    ...(data.unassigned.assets.length ? [{ key: '_sem', group: data.unassigned }] : []),
  ];
  const allOpen = groups.length > 0 && groups.every((g) => open.has(g.key));
  const inReview = data.theses.filter((t) => t.status === 'em_revisao').length;
  const maxWeight = Math.max(1, ...groups.map((g) => g.group.weight_pct ?? 0));

  const assetRow = (a: ThesisAsset) => (
    <tr key={a.asset_id} className="sub">
      <td style={{ paddingLeft: 34 }}>
        {a.ticker} <span className="small muted">{ASSET_CLASS_LABEL[a.asset_class] ?? a.asset_class}</span>
      </td>
      <td />
      <td className="num">{pct(a.weight_pct, 1, false)}</td>
      <td className="num">{money(a.value_cents)}</td>
      <td className="num muted">{money(a.cost_cents)}</td>
      <td className={`num ${signClass(a.price_return_pct)}`}>{pct(a.price_return_pct, 1)}</td>
      <td className="num">{a.pays_cash ? money(a.income_12m_cents) : <span className="muted">sem cupom</span>}</td>
      <td />
    </tr>
  );

  return (
    <div className="stack">
      <Deadlines />

      {!data.available && (
        <div className="card empty">
          Nenhuma tese encontrada em <code>research/teses</code>, na pasta de dados. As posições aparecem abaixo como "sem tese".
        </div>
      )}
      {data.duplicated.length > 0 && (
        <div className="card error">
          Ativo em mais de uma tese (o peso é contado duas vezes):{' '}
          {data.duplicated.map((d) => `${d.ticker} em ${d.theses.join(' e ')}`).join('; ')}
        </div>
      )}

      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Teses" value={data.theses.length} hint={inReview ? `${inReview} em revisão` : 'nenhuma em revisão'} />
        <Kpi label="Posições" value={money(data.total_cents)} hint={`${groups.reduce((s, g) => s + g.group.assets.length, 0)} ativos`} />
        <Kpi
          label="Sem tese"
          value={pct(data.unassigned.weight_pct ?? 0, 1, false)}
          hint={data.unassigned.assets.length ? `${data.unassigned.assets.length} ativo(s) · ${money(data.unassigned.value_cents)}` : 'todas as posições têm tese'}
        />
        <Kpi label="Proventos em 12 meses" value={money(groups.reduce((s, g) => s + g.group.income_12m_cents, 0))} hint="só das posições atuais" />
      </div>

      {income.data && income.data.months.length > 0 && <IncomeCard r={income.data} />}

      <div className="card">
        <div className="page-head" style={{ marginBottom: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>Carteira por tese</h2>
            <AsOf asOf={data.as_of} />
          </div>
          <button onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}>
            {allOpen ? 'Recolher tudo' : 'Abrir tudo'}
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tese</th>
                <th>Status</th>
                <th className="num">Peso</th>
                <th className="num">Valor</th>
                <th className="num">Custo</th>
                <th className="num" title="Valor ÷ custo, sem proventos">Retorno de preço</th>
                <th className="num" title="Proventos pagos nos 12 meses até a última coleta">Proventos 12 m</th>
                <th>Próxima revisão</th>
              </tr>
            </thead>
            <tbody>
              {data.theses.map((t) => (
                <Fragment key={t.id}>
                  <tr>
                    <td style={{ whiteSpace: 'normal', minWidth: 260 }}>
                      <button className="ghost expander" aria-expanded={open.has(t.id)} aria-label={`Ativos de ${t.id}`} onClick={() => toggle(t.id)}>
                        {open.has(t.id) ? '▾' : '▸'}
                      </button>
                      <Link to={`/carteira/teses/${t.id}`}><strong>{t.id}</strong> {t.title}</Link>
                      <div className="small muted" style={{ paddingLeft: 30 }}>
                        {t.assets.length} {t.assets.length === 1 ? 'ativo' : 'ativos'}
                        {t.tickers_without_position.length > 0 && ` · sem posição: ${t.tickers_without_position.join(', ')}`}
                      </div>
                    </td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="num">
                      {pct(t.weight_pct ?? 0, 1, false)}
                      <div className="bar-track" style={{ marginTop: 4, minWidth: 60 }}>
                        <div className="bar-fill" style={{ width: `${((t.weight_pct ?? 0) / maxWeight) * 100}%` }} />
                      </div>
                    </td>
                    <td className="num">{money(t.value_cents)}</td>
                    <td className="num muted">{money(t.cost_cents)}</td>
                    <td className={`num ${signClass(t.price_return_pct)}`}>{pct(t.price_return_pct, 1)}</td>
                    <td className="num">{money(t.income_12m_cents)}</td>
                    <td><ReviewDate next={t.next_review} /></td>
                  </tr>
                  {open.has(t.id) && t.assets.map(assetRow)}
                </Fragment>
              ))}
              {data.unassigned.assets.length > 0 && (
                <>
                  <tr>
                    <td>
                      <button className="ghost expander" aria-expanded={open.has('_sem')} aria-label="Ativos sem tese" onClick={() => toggle('_sem')}>
                        {open.has('_sem') ? '▾' : '▸'}
                      </button>
                      <strong>Sem tese</strong>
                      <div className="small muted" style={{ paddingLeft: 30 }}>posições que nenhuma tese cita</div>
                    </td>
                    <td />
                    <td className="num">{pct(data.unassigned.weight_pct ?? 0, 1, false)}</td>
                    <td className="num">{money(data.unassigned.value_cents)}</td>
                    <td className="num muted">{money(data.unassigned.cost_cents)}</td>
                    <td className={`num ${signClass(data.unassigned.price_return_pct)}`}>{pct(data.unassigned.price_return_pct, 1)}</td>
                    <td className="num">{money(data.unassigned.income_12m_cents)}</td>
                    <td />
                  </tr>
                  {open.has('_sem') && data.unassigned.assets.map(assetRow)}
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function IncomeCard({ r }: { r: ThesesIncome }) {
  const c = r.coverage;
  const range = (m: string[]) => `${shortMonth(m[0])} a ${shortMonth(m[m.length - 1])}`;
  return (
    <div className="card">
      <h2 style={{ marginBottom: 4 }}>Renda por tese</h2>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        Proventos recebidos por mês, pela tese atual de cada ativo · extrato até {r.income_until ? date(r.income_until) : '—'} · "Ex-posições" é a renda
        de ativos que já saíram da carteira
      </p>
      <div className="grid kpis" style={{ marginBottom: 12 }}>
        <Kpi label="Média dos 3 últimos meses" value={money(r.avg_3m_cents)} hint="meses completos" />
        <Kpi
          label="Média de 12 meses"
          value={money(r.avg_12m_cents)}
          hint={r.avg_12m_cents ? `3 meses ${pct(((r.avg_3m_cents - r.avg_12m_cents) / r.avg_12m_cents) * 100, 0)} contra 12 meses` : undefined}
        />
        <Kpi
          label="Cobertura dos gastos"
          value={c ? pct(c.pct, 0, false) : 'a coletar'}
          hint={c ? `gasto líquido médio de ${money(c.expense_avg_cents)} · ${range(c.months)}` : 'faltam gastos registrados nos 3 últimos meses'}
        />
      </div>
      <StackedColumns months={r.months} series={r.series} partialLast legendValue={(s) => `${money(r.series.find((x) => x.key === s.key)?.total_12m_cents ?? 0)} em 12 m`} />
    </div>
  );
}
