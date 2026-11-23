import type { ThesesAsOf } from '../../lib/api';
import { date, today } from '../../lib/format';

export const STATUS_LABEL: Record<string, string> = {
  ativa: 'Ativa',
  em_revisao: 'Em revisão',
  em_observacao: 'Em observação',
  encerrada: 'Encerrada',
  sem_status: 'Sem status',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'em_revisao' ? 'warn' : status === 'ativa' ? 'accent' : '';
  return <span className={`badge ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** Próxima revisão, em vermelho quando já passou. */
export function ReviewDate({ next }: { next: string | null }) {
  if (!next) return <span className="muted">—</span>;
  const late = next < today();
  return <span className={late ? 'neg' : ''}>{date(next)}{late ? ' (vencida)' : ''}</span>;
}

/** Idade de cada dado: nada na tela é mais novo que isto. */
export function AsOf({ asOf }: { asOf: ThesesAsOf }) {
  return (
    <p className="small muted" style={{ margin: 0 }}>
      Posições da coleta de {asOf.snapshot ? date(asOf.snapshot) : '—'} · proventos até{' '}
      {asOf.income_until ? date(asOf.income_until) : '—'} · sem cotação diária: valor e peso não mudam entre coletas
    </p>
  );
}
