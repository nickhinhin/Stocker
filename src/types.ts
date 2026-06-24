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
  stockerProMeta?: StockerProTransactionMeta;
}

export interface StockerProPortfolioMeta {
  id: number;
  webId?: string;
  name: string;
  tags: unknown;
  note: string | null;
  displayCurrencyType: string;
  displayOrder: number | null;
}

export interface StockerProAssetMeta {
  id: number;
  currencyType: string;
  assetType: string | null;
  symbol: string;
  tags: unknown;
  note: string | null;
  assetName: string | null;
  portfolioId: number;
  region: string | null;
  displayOrder: number | null;
}

export interface StockerProPositionMeta {
  id: number;
  assetId: number;
  type: string | null;
  cumulativeCost: number | null;
}

export interface StockerProCashAssetMeta {
  id: number;
  currencyType: string;
  portfolioId: number;
}

export interface StockerProTransactionMeta {
  id?: number;
  webTxId?: string;
  assetType?: string | null;
  positionId?: number | null;
  portfolioId: number;
  region?: string | null;
  tags?: unknown;
  isAutoDividend?: boolean | null;
  exDividendDate?: unknown;
}

export interface StockerProEntityMeta {
  portfolio: StockerProPortfolioMeta;
  assetsBySymbol: Record<string, StockerProAssetMeta>;
  positionsById: Record<number, StockerProPositionMeta>;
  positionIdsByAssetId: Record<number, number[]>;
  cashAssetsByCurrency: Record<string, StockerProCashAssetMeta>;
}

export interface EntityDataset {
  id: string;
  name: string;
  currency: string;
  transactions: NormalizedTransaction[];
  latestPriceBySymbol: Record<string, number>;
  stockerProMeta?: StockerProEntityMeta;
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

export interface PricePoint {
  date: Date;
  price: number;
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
