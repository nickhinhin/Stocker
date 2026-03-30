export type UserType = "stockerx" | "stockerpro" | "new";

export type TxType =
  | "BUY"
  | "SELL"
  | "DIVIDEND_CASH"
  | "DIVIDEND_SHARE"
  | "FEE"
  | "INTEREST"
  | "CASH"
  | "CASH_CONVERT";

export interface NormalizedTransaction {
  id: string;
  date: Date;
  symbol: string;
  type: TxType;
  shares: number;
  price: number;
  fee: number;
  currency: string;
  note?: string;
}

export interface EntityDataset {
  id: string;
  name: string;
  currency: string;
  transactions: NormalizedTransaction[];
  latestPriceBySymbol: Record<string, number>;
}

export interface EntityMetrics {
  id: string;
  name: string;
  currency: string;
  totalProfit: number;
  totalCost: number;
  totalProfitPct: number;
}

export interface StockMetrics {
  id: string;
  symbol: string;
  currency: string;
  totalProfit: number;
  totalCost: number;
  totalProfitPct: number;
  activeShares: number;
}

export interface ProfitPoint {
  date: Date;
  profit: number;
}

export interface StockBreakdown {
  id: string;
  symbol: string;
  currency: string;
  totalProfit: number;
  totalCost: number;
  totalProfitPct: number;
  activeShares: number;
  marketValue: number;
  holdingProfit: number;
  holdingProfitPct: number;
  realizedProfit: number;
  realizedProfitPct: number;
  totalDividend: number;
  totalFee: number;
  lastPrice: number;
  transactionCount: number;
  isClosed: boolean;
}

export interface CashBalance {
  currency: string;
  balance: number;
}

export interface PortfolioSummary {
  currency: string;
  totalAssets: number;
  totalMarketValue: number;
  cashBalance: number;
  totalCost: number;
  totalProfit: number;
  totalProfitPct: number;
  holdingProfit: number;
  holdingProfitPct: number;
  realizedProfit: number;
  realizedProfitPct: number;
  dailyProfit: number;
  dailyProfitPct: number;
  totalDividend: number;
  totalFee: number;
}
