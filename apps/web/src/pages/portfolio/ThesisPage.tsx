import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type ThesisDetail, type ThesisIncome } from '../../lib/api';
import StackedColumns, { shortMonth } from '../../components/StackedColumns';
import { ASSET_CLASS_LABEL, date, money, pct, signClass } from '../../lib/format';
import { Kpi, Loading } from '../../components/ui';
import Deadlines from '../../components/Deadlines';
import { AsOf, ReviewDate, StatusBadge } from './thesis-ui';

export default function ThesisPage() {
  const { id = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['thesis', id], queryFn: () => api.get<ThesisDetail>(`/theses/${id}`) });
  if (!data) return <Loading error={error} />;
  const t = data;

  return (
    <div className="stack">
      <div>
        <Link to="/carteira/teses" className="small">‹ Todas as teses</Link>
        <h2 style={{ margin: '6px 0 4px' }}>{t.id} · {t.title}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          <StatusBadge status={t.status} />
          {t.block && <> · bloco: {t.block}</>}
          {t.owner && <> · responsável: {t.owner}</>}
          {t.last_review && <> · última revisão em {date(t.last_review)}</>}
          {' · próxima revisão: '}<ReviewDate next={t.next_review} />
          {t.origin && <> · origem: {t.origin}</>}
        </p>
      </div>

      <Deadlines thesisId={t.id} />

      <div className="grid kpis" style={{ marginBottom: 0 }}>
        <Kpi label="Peso na carteira" value={pct(t.weight_pct ?? 0, 1, false)} hint={`${t.assets.length} ${t.assets.length === 1 ? 'ativo' : 'ativos'}`} />
        <Kpi label="Valor" value={money(t.value_cents)} hint={`Custo ${money(t.cost_cents)}`} />
        <Kpi label="Retorno de preço" value={pct(t.price_return_pct, 1)} tone={t.price_return_pct ?? 0} hint="Valor ÷ custo, sem proventos" />
        <Kpi label="Proventos em 12 meses" value={money(t.income_12m_cents)} hint={`${money(t.income_total_cents)} desde o início do extrato`} />
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Ativos da tese</h2>
        <AsOf asOf={t.as_of} />
        {t.tickers_without_position.length > 0 && (
          <p className="small muted" style={{ margin: '4px 0 0' }}>Citados na tese, sem posição na última coleta: {t.tickers_without_position.join(', ')}</p>
        )}
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr>
                <th>Ativo</th>
                <th className="num">Peso na carteira</th>
                <th className="num">Peso na tese</th>
                <th className="num">Valor</th>
                <th className="num">Custo</th>
                <th className="num">Retorno de preço</th>
                <th className="num">Proventos 12 m</th>
                <th className="num">Proventos (total)</th>
              </tr>
            </thead>
            <tbody>
              {t.assets.map((a) => (
                <tr key={a.asset_id}>
                  <td>{a.ticker} <span className="small muted">{ASSET_CLASS_LABEL[a.asset_class] ?? a.asset_class}</span></td>
                  <td className="num">{pct(a.weight_pct, 1, false)}</td>
                  <td className="num">{pct(t.value_cents ? (a.value_cents / t.value_cents) * 100 : null, 1, false)}</td>
                  <td className="num">{money(a.value_cents)}</td>
                  <td className="num muted">{money(a.cost_cents)}</td>
                  <td className={`num ${signClass(a.price_return_pct)}`}>{pct(a.price_return_pct, 1)}</td>
                  <td className="num">{a.pays_cash ? money(a.income_12m_cents) : <span className="muted">sem cupom</span>}</td>
                  <td className="num muted">{a.pays_cash ? money(a.income_total_cents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {t.income && t.income.assets.some((a) => a.total_cents > 0) && <IncomeSection r={t.income} />}

      <div className="card">
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          Texto do arquivo <code>research/teses/{t.file}</code>
          {t.last_review && <>, revisado em {date(t.last_review)}</>}. Os números dentro do texto são da data da revisão; os da tabela acima são os do sistema.
        </p>
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{t.body}</Markdown>
        </div>
      </div>
    </div>
  );
}

const perUnit = (v: number | null) => (v === null ? '' : v.toFixed(v < 0.1 ? 3 : 2).replace('.', ','));

function IncomeSection({ r }: { r: ThesisIncome }) {
  const paying = r.assets.filter((a) => a.total_cents > 0);
  const last = r.months.length - 1;
  // No resumo, só os sinais dos últimos 6 meses; a tabela mostra todos.
  const recent = r.signals.filter((x) => r.months.indexOf(x.month) >= r.months.length - 6);
  return (
    <div className="card">
      <h2 style={{ marginBottom: 4 }}>Renda da tese</h2>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        Proventos recebidos nos últimos 12 meses · extrato até {date(r.income_until)} · média dos 3 últimos meses completos:{' '}
        <strong>{money(r.avg_3m_cents)}</strong>
      </p>
      {recent.length > 0 && (
        <p className="small" style={{ margin: '0 0 10px' }}>
          <span className="badge warn">{recent.length} {recent.length === 1 ? 'sinal' : 'sinais'} em 6 meses</span>{' '}
          {recent.map((s) => `${s.ticker} em ${shortMonth(s.month)}: ${s.kind === 'corte' ? 'corte acima de 10%' : 'sem pagamento'}`).join(' · ')}
        </p>
      )}
      <StackedColumns
        months={r.months}
        series={paying.map((a) => ({ key: a.ticker, label: a.ticker, monthly: a.monthly }))}
        partialLast
        legendValue={(s) => money(s.monthly.reduce((x, y) => x + y, 0))}
      />
      <h3 style={{ margin: '18px 0 4px', fontSize: 14 }}>Valor por cota, mês a mês (R$)</h3>
      <p className="small muted" style={{ margin: '0 0 6px' }}>
        Em vermelho: queda de mais de 10% contra o pagamento anterior, ou mês sem pagamento (só para fundos, que pagam todo mês). O yield divide a
        renda de 12 meses pelo valor e pelo custo da última coleta.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ativo</th>
              {r.months.map((m) => <th className="num" key={m}>{shortMonth(m)}</th>)}
              <th className="num">Recebido</th>
              <th className="num" title="Renda de 12 meses ÷ valor atual">Yield s/ preço</th>
              <th className="num" title="Renda de 12 meses ÷ custo">Yield s/ custo</th>
            </tr>
          </thead>
          <tbody>
            {paying.map((a) => (
              <tr key={a.ticker}>
                <td>{a.ticker}</td>
                {a.per_unit.map((v, i) => (
                  <td
                    key={i}
                    className={`num small ${a.flags[i] === 'corte' ? 'flag-corte' : a.flags[i] === 'sem_pagamento' ? 'flag-sem' : ''}`}
                    title={a.monthly[i] ? `${money(a.monthly[i])} recebidos` : undefined}
                    style={i === last ? { opacity: 0.6 } : undefined}
                  >
                    {a.flags[i] === 'sem_pagamento' ? 'sem pgto' : v === null && a.monthly[i] > 0 ? '•' : perUnit(v)}
                    {a.flags[i] === 'corte' && ' ▼'}
                  </td>
                ))}
                <td className="num">{money(a.total_cents)}</td>
                <td className="num">{pct(a.yield_on_price_pct, 1, false)}</td>
                <td className="num">{pct(a.yield_on_cost_pct, 1, false)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paying.some((a) => a.per_unit.some((v, i) => v === null && a.monthly[i] > 0)) && (
        <p className="small muted" style={{ margin: '6px 0 0' }}>• pagamento registrado sem valor por cota no extrato (passe o cursor para ver o valor recebido)</p>
      )}
    </div>
  );
}
