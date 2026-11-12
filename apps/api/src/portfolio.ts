/**
 * Cálculo de posição pelo método do custo médio (padrão da Receita Federal):
 * - Compra: soma quantidade e custo (preço × qtd + taxas).
 * - Venda: baixa o custo proporcional ao preço médio; o lucro realizado é
 *   (preço × qtd − taxas) − (preço médio × qtd).
 */
export interface TradeInput {
  side: 'buy' | 'sell';
  quantity: number;
  price_cents: number;
  fees_cents: number;
}

export interface Position {
  quantity: number;
  cost_cents: number; // custo total da posição aberta
  avg_price_cents: number;
  realized_cents: number; // lucro/prejuízo realizado em vendas
}

const EPS = 1e-9;

export function computePosition(trades: TradeInput[]): Position {
  let quantity = 0;
  let cost = 0;
  let realized = 0;

  for (const t of trades) {
    if (t.side === 'buy') {
      quantity += t.quantity;
      cost += t.quantity * t.price_cents + t.fees_cents;
    } else {
      if (t.quantity > quantity + EPS) {
        throw new Error(`Venda de ${t.quantity} maior que a posição de ${quantity}`);
      }
      const avg = quantity > 0 ? cost / quantity : 0;
      const costOut = avg * t.quantity;
      realized += t.quantity * t.price_cents - t.fees_cents - costOut;
      cost -= costOut;
      quantity -= t.quantity;
      if (quantity < EPS) {
        quantity = 0;
        cost = 0;
      }
    }
  }

  return {
    quantity,
    cost_cents: Math.round(cost),
    avg_price_cents: quantity > 0 ? Math.round(cost / quantity) : 0,
    realized_cents: Math.round(realized),
  };
}
