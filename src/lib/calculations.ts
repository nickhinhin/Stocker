import {
  CashBalance,
  EntityDataset,
  NormalizedTransaction,
  PortfolioSummary,
  ProfitPoint,
  PricePoint,
  StockBreakdown,
  StockMetrics,
  TxType,
} from "../types";

interface SymbolAccumulator {
  purchasedShares: number;
  soldShares: number;
  purchaseTotal: number;
  sellingTotal: number;
  dividends: number;
  fees: number;
  lastPrice: number;
}

interface StockGroup {
  id: string;
  symbol: string;
  currency: string;
  transactions: NormalizedTransaction[];
  latestPrice: number;
  latestPriceDate: number;
}

export type ChartRangePreset = "1W" | "1M" | "1Y" | "10Y" | "ALL" | "CUSTOM";

export interface ChartRange {
  preset: ChartRangePreset;
  startDate?: Date;
  endDate?: Date;
}

export interface ChartSlice {
  label: string;
  value: number;
  color: string;
}

export interface ChartBarDatum {
  label: string;
  value: number;
}

export interface CompareLineSeries {
  id: string;
  label: string;
  color: string;
  points: ProfitPoint[];
}

export interface HeatmapData {
  xLabels: string[];
  yLabels: string[];
  values: number[][];
  maxValue: number;
}

export interface InsightMetrics {
  openPositions: number;
  closedPositions: number;
  winRate: number;
  avgProfitPerStock: number;
  bestPerformer: string;
  worstPerformer: string;
  maxDrawdownPct: number;
}

export interface RebalanceSuggestion {
  symbol: string;
  currentWeightPct: number;
  targetWeightPct: number;
  diffPct: number;
  diffValue: number;
  currency: string;
}

export interface PortfolioOverviewPoint {
  date: Date;
  cashBalance: number;
  stockMarketValue: number;
  totalMarketValue: number;
  totalCost: number;
  totalAssets: number;
  totalProfit: number;
  totalReturnPct: number;
}

export interface CalculationConversionOptions {
  targetCurrency?: string;
  convertAmount?: (value: number, fromCurrency: string) => number;
  historicalPriceBySymbol?: Record<string, PricePoint[]>;
}

interface DateBounds {
  minDate: Date;
  maxDate: Date;
}

interface StockEvaluation {
  totalProfit: number;
  totalCost: number;
  activeShares: number;
  holdingProfit: number;
  realizedProfit: number;
  totalDividend: number;
  totalFee: number;
  marketPrice: number;
  marketValue: number;
}

const STOCK_RELEVANT_TYPES = new Set([
  "BUY",
  "SELL",
  "DIVIDEND_CASH",
  "DIVIDEND_SHARE",
  "FEE",
]);

const TRADE_PRICE_TYPES = new Set<TxType>(["BUY", "SELL"]);

const CHART_COLORS = [
  "#3367D6",
  "#22A06B",
  "#F59E0B",
  "#D94884",
  "#06B6D4",
  "#8B5CF6",
  "#EF4444",
  "#14B8A6",
  "#64748B",
];

function isStockTransaction(tx: NormalizedTransaction): boolean {
  if (!tx.symbol || !STOCK_RELEVANT_TYPES.has(tx.type)) {
    return false;
  }
  return tx.symbol !== tx.currency;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [yearText, monthText] = key.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });
}

function pickColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

function sortByDateAsc(transactions: NormalizedTransaction[]): NormalizedTransaction[] {
  return [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function applyConversion(
  value: number,
  fromCurrency: string,
  options?: CalculationConversionOptions,
): number {
  if (!options?.convertAmount) {
    return value;
  }
  const converted = options.convertAmount(value, fromCurrency);
  return Number.isFinite(converted) ? converted : value;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function daysBetweenInclusive(start: Date, end: Date): number {
  const diff = end.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000) + 1;
}

function resolveDisplayMinDate(dates: Date[]): Date | null {
  const sorted = dates
    .map((date) => startOfDay(date))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  if (sorted.length === 0) {
    return null;
  }

  const firstDate = sorted[0];
  const firstModernDate = sorted.find((date) => date.getFullYear() > 1970);
  if (!firstModernDate) {
    return firstDate;
  }

  const gapYears = (firstModernDate.getTime() - firstDate.getTime()) / (86_400_000 * 365.25);
  if (firstDate.getFullYear() <= 1970 && gapYears >= 20) {
    return firstModernDate;
  }

  return firstDate;
}

export function calculateCostWithVirtualCash(transactions: NormalizedTransaction[]): number {
  const sorted = sortByDateAsc(transactions);
  let cost = 0;
  let virtualCash: number | null = null;

  for (const tx of sorted) {
    if (!["BUY", "SELL", "DIVIDEND_CASH"].includes(tx.type)) {
      continue;
    }

    const total = tx.shares * tx.price + tx.fee;

    if (tx.type === "BUY") {
      if (virtualCash === null) {
        cost = total;
        virtualCash = 0;
      } else {
        const diff = virtualCash - total;
        if (diff < 0) {
          virtualCash = 0;
          cost -= diff;
        } else {
          virtualCash -= total;
        }
      }
    }

    if (tx.type === "SELL" || tx.type === "DIVIDEND_CASH") {
      virtualCash = (virtualCash ?? 0) + total;
    }
  }

  return round2(cost);
}

function collectStockGroups(entities: EntityDataset[]): StockGroup[] {
  const groups = new Map<string, StockGroup>();

  entities.forEach((entity) => {
    entity.transactions.forEach((tx) => {
      if (!isStockTransaction(tx)) {
        return;
      }

      const key = `${tx.symbol}__${tx.currency}`;
      if (!groups.has(key)) {
        groups.set(key, {
          id: key,
          symbol: tx.symbol,
          currency: tx.currency,
          transactions: [],
          latestPrice: 0,
          latestPriceDate: 0,
        });
      }

      const group = groups.get(key)!;
      group.transactions.push(tx);

      if (
        TRADE_PRICE_TYPES.has(tx.type) &&
        tx.price > 0 &&
        tx.date.getTime() >= group.latestPriceDate
      ) {
        group.latestPrice = tx.price;
        group.latestPriceDate = tx.date.getTime();
      }
    });
  });

  groups.forEach((group) => {
    if (group.latestPrice > 0) {
      return;
    }
    for (const entity of entities) {
      const fallbackPrice = entity.latestPriceBySymbol[group.symbol];
      if (fallbackPrice && fallbackPrice > 0) {
        group.latestPrice = fallbackPrice;
        break;
      }
    }
  });

  return [...groups.values()].map((group) => ({
    ...group,
    transactions: sortByDateAsc(group.transactions),
  }));
}

function evaluateStockAtDate(
  group: StockGroup,
  date: Date,
  marketPriceOverride?: number,
): StockEvaluation {
  const state: SymbolAccumulator = {
    purchasedShares: 0,
    soldShares: 0,
    purchaseTotal: 0,
    sellingTotal: 0,
    dividends: 0,
    fees: 0,
    lastPrice: 0,
  };

  const visibleTransactions: NormalizedTransaction[] = [];

  for (const tx of group.transactions) {
    if (tx.date.getTime() > date.getTime()) {
      break;
    }

    visibleTransactions.push(tx);

    if (tx.type === "BUY") {
      state.purchasedShares += tx.shares;
      state.purchaseTotal += tx.shares * tx.price;
      state.fees += tx.fee;
      if (tx.price > 0) {
        state.lastPrice = tx.price;
      }
      continue;
    }

    if (tx.type === "DIVIDEND_SHARE") {
      // Stock dividend increases quantity but should not increase invested cost.
      state.purchasedShares += tx.shares;
      state.fees += tx.fee;
      continue;
    }

    if (tx.type === "SELL") {
      state.soldShares += tx.shares;
      state.sellingTotal += tx.shares * tx.price;
      state.fees += tx.fee;
      if (tx.price > 0) {
        state.lastPrice = tx.price;
      }
      continue;
    }

    if (tx.type === "DIVIDEND_CASH") {
      state.dividends += tx.shares * tx.price;
      state.fees += tx.fee;
      continue;
    }

    if (tx.type === "FEE") {
      state.fees += tx.shares * tx.price + tx.fee;
    }
  }

  const buyAvg =
    state.purchasedShares > 0 ? state.purchaseTotal / state.purchasedShares : 0;
  const sellAvg = state.soldShares > 0 ? state.sellingTotal / state.soldShares : 0;
  const matchedShares = Math.min(state.purchasedShares, state.soldShares);
  const netTradeProfit =
    state.soldShares > 0 ? (sellAvg - buyAvg) * matchedShares : 0;

  const activeShares = state.purchasedShares - state.soldShares;
  const isTodayPoint = startOfDay(date).getTime() >= startOfDay(new Date()).getTime();
  const marketPrice = typeof marketPriceOverride === "number" && Number.isFinite(marketPriceOverride)
    ? marketPriceOverride
    : isTodayPoint && group.latestPrice > 0
      ? group.latestPrice
      : (state.lastPrice || group.latestPrice || buyAvg || 0);

  let holdingProfit = 0;
  if (activeShares > 0) {
    holdingProfit = (marketPrice - buyAvg) * activeShares;
  } else if (activeShares < 0) {
    holdingProfit = (marketPrice - sellAvg) * activeShares;
  }

  const realizedProfit = netTradeProfit + state.dividends - state.fees;
  const totalProfit = realizedProfit + holdingProfit;
  const totalCost = calculateCostWithVirtualCash(visibleTransactions);
  const marketValue = marketPrice * activeShares;

  return {
    totalProfit: round2(totalProfit),
    totalCost,
    activeShares: round2(activeShares),
    holdingProfit: round2(holdingProfit),
    realizedProfit: round2(realizedProfit),
    totalDividend: round2(state.dividends),
    totalFee: round2(state.fees),
    marketPrice: round2(marketPrice),
    marketValue: round2(marketValue),
  };
}

function resolveHistoricalMarketPriceAtDate(
  history: PricePoint[] | undefined,
  date: Date,
): number | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }

  const targetTime = date.getTime();
  let previous: number | undefined;
  for (const point of history) {
    const price = point.price;
    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }
    const pointTime = point.date.getTime();
    if (pointTime > targetTime) {
      return previous ?? price;
    }
    previous = price;
  }

  return previous;
}

function resolveRecentHistoricalMarketPriceAtDate(
  history: PricePoint[] | undefined,
  date: Date,
  maxAgeDays: number,
): number | undefined {
  if (!history || history.length === 0) {
    return undefined;
  }

  const targetTime = date.getTime();
  const maxAgeMs = Math.max(0, maxAgeDays) * 86_400_000;
  let candidate: PricePoint | undefined;

  for (const point of history) {
    if (!Number.isFinite(point.price) || point.price <= 0) {
      continue;
    }
    const pointTime = point.date.getTime();
    if (pointTime > targetTime) {
      break;
    }
    candidate = point;
  }

  if (!candidate) {
    return undefined;
  }

  if (targetTime - candidate.date.getTime() > maxAgeMs) {
    return undefined;
  }

  return candidate.price;
}

function getGroupDateBounds(group: StockGroup): DateBounds | null {
  if (group.transactions.length === 0) {
    return null;
  }

  const today = startOfDay(new Date());
  const minDate = resolveDisplayMinDate(group.transactions.map((tx) => tx.date));
  if (!minDate) {
    return null;
  }
  return { minDate, maxDate: today };
}

function getTargetPointCount(preset: ChartRangePreset, totalDays: number): number {
  if (preset === "1W") {
    return 7;
  }
  if (preset === "1M") {
    return 31;
  }
  if (preset === "1Y") {
    return 366;
  }
  if (preset === "10Y" || preset === "ALL") {
    return 600;
  }
  return Math.min(totalDays, 600);
}

function resolveRangeForGroup(group: StockGroup, range: ChartRange): DateBounds | null {
  const bounds = getGroupDateBounds(group);
  if (!bounds) {
    return null;
  }

  const today = startOfDay(new Date());
  let endDate = startOfDay(range.endDate ?? today);
  if (endDate.getTime() > today.getTime()) {
    endDate = today;
  }

  let startDate = new Date(endDate);
  if (range.preset === "1W") {
    startDate.setDate(endDate.getDate() - 6);
  } else if (range.preset === "1M") {
    startDate.setMonth(endDate.getMonth() - 1);
  } else if (range.preset === "1Y") {
    startDate.setFullYear(endDate.getFullYear() - 1);
  } else if (range.preset === "10Y") {
    startDate.setFullYear(endDate.getFullYear() - 10);
  } else if (range.preset === "ALL") {
    startDate = new Date(bounds.minDate);
  } else if (range.preset === "CUSTOM") {
    startDate = startOfDay(range.startDate ?? bounds.minDate);
  }

  if (startDate.getTime() < bounds.minDate.getTime()) {
    startDate = new Date(bounds.minDate);
  }
  if (endDate.getTime() < bounds.minDate.getTime()) {
    endDate = new Date(bounds.minDate);
  }
  if (startDate.getTime() > endDate.getTime()) {
    startDate = new Date(endDate);
  }

  return { minDate: startDate, maxDate: endDate };
}

function resolveDateRange(
  minDate: Date,
  range: ChartRange,
): { start: Date; end: Date } {
  const today = startOfDay(new Date());
  const end = startOfDay(range.endDate ?? today);
  let safeEnd = end.getTime() > today.getTime() ? today : end;

  let start = new Date(safeEnd);
  if (range.preset === "1W") {
    start.setDate(safeEnd.getDate() - 6);
  } else if (range.preset === "1M") {
    start.setMonth(safeEnd.getMonth() - 1);
  } else if (range.preset === "1Y") {
    start.setFullYear(safeEnd.getFullYear() - 1);
  } else if (range.preset === "10Y") {
    start.setFullYear(safeEnd.getFullYear() - 10);
  } else if (range.preset === "ALL") {
    start = startOfDay(minDate);
  } else {
    start = startOfDay(range.startDate ?? minDate);
  }

  if (start.getTime() < minDate.getTime()) {
    start = startOfDay(minDate);
  }
  if (safeEnd.getTime() < minDate.getTime()) {
    safeEnd = startOfDay(minDate);
  }
  if (start.getTime() > safeEnd.getTime()) {
    start = new Date(safeEnd);
  }

  return { start, end: safeEnd };
}

function getAllTransactions(entities: EntityDataset[]): NormalizedTransaction[] {
  const all = entities.flatMap((entity) => entity.transactions);
  return sortByDateAsc(all);
}

function getFundingTransactions(entities: EntityDataset[]): NormalizedTransaction[] {
  // Keep funding cost aligned with mobile chart logic: use CASH top-up records.
  return getAllTransactions(entities).filter((tx) => tx.type === "CASH");
}

function createFundingCostResolver(
  fundingTransactions: NormalizedTransaction[],
  options?: CalculationConversionOptions,
): (targetTime: number) => number {
  let fundingIndex = 0;
  let cumulativeFunding = 0;

  return (targetTime: number): number => {
    while (
      fundingIndex < fundingTransactions.length &&
      fundingTransactions[fundingIndex].date.getTime() <= targetTime
    ) {
      const tx = fundingTransactions[fundingIndex];
      // Mobile parity: total cost follows CASH amount only (exclude fees).
      const signedFunding = tx.shares * tx.price;
      cumulativeFunding += applyConversion(signedFunding, tx.currency, options);
      fundingIndex += 1;
    }
    return round2(cumulativeFunding);
  };
}

function calculateFundingCostAtDate(
  entities: EntityDataset[],
  date: Date,
  options?: CalculationConversionOptions,
): number {
  const fundingTransactions = getFundingTransactions(entities);
  if (fundingTransactions.length === 0) {
    return 0;
  }

  const targetTime = date.getTime();
  let total = 0;
  for (const tx of fundingTransactions) {
    if (tx.date.getTime() > targetTime) {
      break;
    }
    // Mobile parity: total cost follows CASH amount only (exclude fees).
    total += applyConversion(tx.shares * tx.price, tx.currency, options);
  }
  return round2(total);
}

function buildMonthlySeriesFromTransactions(
  entities: EntityDataset[],
  extractor: (tx: NormalizedTransaction) => number,
  monthCount: number,
  options?: CalculationConversionOptions,
): ChartBarDatum[] {
  const allTransactions = getAllTransactions(entities);
  if (allTransactions.length === 0) {
    return [];
  }

  const lastMonthStart = new Date();
  lastMonthStart.setDate(1);
  lastMonthStart.setHours(0, 0, 0, 0);
  lastMonthStart.setMonth(lastMonthStart.getMonth() - (monthCount - 1));

  const monthly = new Map<string, number>();

  allTransactions.forEach((tx) => {
    if (tx.date.getTime() < lastMonthStart.getTime()) {
      return;
    }
    const key = monthKey(tx.date);
    const current = monthly.get(key) ?? 0;
    const amount = extractor(tx);
    const normalizedAmount =
      amount === 0 ? 0 : applyConversion(amount, tx.currency, options);
    monthly.set(key, current + normalizedAmount);
  });

  const output: ChartBarDatum[] = [];
  const cursor = new Date(lastMonthStart);
  for (let i = 0; i < monthCount; i += 1) {
    const key = monthKey(cursor);
    output.push({
      label: monthLabel(key),
      value: round2(monthly.get(key) ?? 0),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return output;
}

export function calculateStockLeaderboard(entities: EntityDataset[]): StockMetrics[] {
  const today = new Date();
  const groups = collectStockGroups(entities);

  return groups
    .map((group) => {
      const { totalProfit, totalCost, activeShares } = evaluateStockAtDate(group, today);
      return {
        id: group.id,
        symbol: group.symbol,
        currency: group.currency,
        totalProfit,
        totalCost,
        totalProfitPct: totalCost > 0 ? round2((totalProfit / totalCost) * 100) : 0,
        activeShares,
      };
    })
    .sort((a, b) => b.totalProfit - a.totalProfit);
}

export function calculateStockBreakdown(entities: EntityDataset[]): StockBreakdown[] {
  const today = new Date();
  const groups = collectStockGroups(entities);

  return groups
    .map((group) => {
      const metrics = evaluateStockAtDate(group, today);
      return {
        id: group.id,
        symbol: group.symbol,
        currency: group.currency,
        totalProfit: metrics.totalProfit,
        totalCost: metrics.totalCost,
        totalProfitPct:
          metrics.totalCost > 0 ? round2((metrics.totalProfit / metrics.totalCost) * 100) : 0,
        activeShares: metrics.activeShares,
        marketValue: metrics.marketValue,
        holdingProfit: metrics.holdingProfit,
        holdingProfitPct:
          metrics.totalCost > 0 ? round2((metrics.holdingProfit / metrics.totalCost) * 100) : 0,
        realizedProfit: metrics.realizedProfit,
        realizedProfitPct:
          metrics.totalCost > 0 ? round2((metrics.realizedProfit / metrics.totalCost) * 100) : 0,
        totalDividend: metrics.totalDividend,
        totalFee: metrics.totalFee,
        lastPrice: metrics.marketPrice,
        transactionCount: group.transactions.length,
        isClosed: metrics.activeShares === 0,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);
}

function getTransactionCashDelta(tx: NormalizedTransaction): number {
  const gross = tx.shares * tx.price;

  if (tx.type === "BUY") {
    return -(gross + tx.fee);
  }
  if (tx.type === "SELL") {
    return gross - tx.fee;
  }
  if (tx.type === "DIVIDEND_CASH") {
    return gross - tx.fee;
  }
  if (tx.type === "DIVIDEND_SHARE") {
    // Mobile parity: stock-share dividend still deducts fee from cash.
    return -tx.fee;
  }
  if (tx.type === "FEE") {
    return -(gross + tx.fee);
  }
  if (tx.type === "INTEREST") {
    return gross - tx.fee;
  }
  if (tx.type === "CASH" || tx.type === "CASH_CONVERT") {
    return gross - tx.fee;
  }
  return 0;
}

export function calculateCashBalances(entities: EntityDataset[]): CashBalance[] {
  const balances = new Map<string, number>();

  for (const entity of entities) {
    for (const tx of entity.transactions) {
      const current = balances.get(tx.currency) ?? 0;
      balances.set(tx.currency, round2(current + getTransactionCashDelta(tx)));
    }
  }

  return [...balances.entries()]
    .map(([currency, balance]) => ({ currency, balance: round2(balance) }))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

function calculateCashBalancesAtDate(
  entities: EntityDataset[],
  date: Date,
): Map<string, number> {
  const balances = new Map<string, number>();
  const endTime = date.getTime();

  entities.forEach((entity) => {
    entity.transactions.forEach((tx) => {
      if (tx.date.getTime() > endTime) {
        return;
      }
      const current = balances.get(tx.currency) ?? 0;
      balances.set(tx.currency, round2(current + getTransactionCashDelta(tx)));
    });
  });

  return balances;
}

export function calculatePortfolioSummary(
  entities: EntityDataset[],
  options?: CalculationConversionOptions,
): PortfolioSummary {
  const stockBreakdown = calculateStockBreakdown(entities);
  const cashBalances = calculateCashBalances(entities);
  const summaryCurrency = options?.targetCurrency ?? entities[0]?.currency ?? "USD";
  const cashBalance = round2(
    cashBalances.reduce(
      (total, item) => total + applyConversion(item.balance, item.currency, options),
      0,
    ),
  );

  const totalMarketValue = round2(
    stockBreakdown.reduce(
      (total, item) => total + applyConversion(item.marketValue, item.currency, options),
      0,
    ),
  );
  const convertedTotalProfit = round2(
    stockBreakdown.reduce(
      (total, item) => total + applyConversion(item.totalProfit, item.currency, options),
      0,
    ),
  );
  const holdingProfit = round2(
    stockBreakdown.reduce(
      (total, item) => total + applyConversion(item.holdingProfit, item.currency, options),
      0,
    ),
  );
  const realizedProfit = round2(
    stockBreakdown.reduce(
      (total, item) => total + applyConversion(item.realizedProfit, item.currency, options),
      0,
    ),
  );
  const totalDividend = round2(
    stockBreakdown.reduce(
      (total, item) => total + applyConversion(item.totalDividend, item.currency, options),
      0,
    ),
  );
  const totalFee = round2(
    stockBreakdown.reduce(
      (total, item) => total + applyConversion(item.totalFee, item.currency, options),
      0,
    ),
  );
  const totalAssets = round2(totalMarketValue + cashBalance);
  const today = startOfDay(new Date());
  const fundingTotalCost = calculateFundingCostAtDate(entities, today, options);
  const stockDerivedCost = round2(
    stockBreakdown.reduce(
      (total, item) => total + applyConversion(item.totalCost, item.currency, options),
      0,
    ),
  );
  const totalCost = fundingTotalCost !== 0 ? fundingTotalCost : stockDerivedCost;

  const groups = collectStockGroups(entities);
  const yesterday = addDays(today, -1);
  const dailyProfit = round2(
    groups.reduce((total, group) => {
      const history = options?.historicalPriceBySymbol?.[group.symbol];
      const todayHistoricalPrice = resolveRecentHistoricalMarketPriceAtDate(history, today, 5);
      const yesterdayHistoricalPrice = resolveRecentHistoricalMarketPriceAtDate(
        history,
        yesterday,
        5,
      );
      const todayMarketPrice =
        group.latestPrice > 0
          ? group.latestPrice
          : (todayHistoricalPrice ?? undefined);
      const todayValue = applyConversion(
        evaluateStockAtDate(group, today, todayMarketPrice).totalProfit,
        group.currency,
        options,
      );
      const yesterdayValue = applyConversion(
        evaluateStockAtDate(group, yesterday, yesterdayHistoricalPrice).totalProfit,
        group.currency,
        options,
      );
      return total + (todayValue - yesterdayValue);
    }, 0),
  );
  const previousAssetValue = totalAssets - dailyProfit;

  return {
    currency: summaryCurrency,
    totalAssets,
    totalMarketValue,
    cashBalance: round2(cashBalance),
    totalCost,
    totalProfit: convertedTotalProfit,
    totalProfitPct: totalCost > 0 ? round2((convertedTotalProfit / totalCost) * 100) : 0,
    holdingProfit,
    holdingProfitPct: totalCost > 0 ? round2((holdingProfit / totalCost) * 100) : 0,
    realizedProfit,
    realizedProfitPct: totalCost > 0 ? round2((realizedProfit / totalCost) * 100) : 0,
    dailyProfit,
    dailyProfitPct:
      previousAssetValue !== 0 ? round2((dailyProfit / previousAssetValue) * 100) : 0,
    totalDividend,
    totalFee,
  };
}

export function calculateAssetAllocationSegments(
  entities: EntityDataset[],
  maxItems = 8,
  options?: CalculationConversionOptions,
): ChartSlice[] {
  const stockBreakdown = calculateStockBreakdown(entities).filter(
    (item) => Math.abs(item.marketValue) > 0,
  );
  const sorted = [...stockBreakdown].sort(
    (a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue),
  );
  const top = sorted.slice(0, maxItems);
  const rest = sorted.slice(maxItems);

  const segments: ChartSlice[] = top.map((item, index) => ({
    label: item.symbol,
    value: round2(Math.abs(applyConversion(item.marketValue, item.currency, options))),
    color: pickColor(index),
  }));

  if (rest.length > 0) {
    const others = round2(
      rest.reduce(
        (sum, item) => sum + Math.abs(applyConversion(item.marketValue, item.currency, options)),
        0,
      ),
    );
    if (others > 0) {
      segments.push({
        label: "Others",
        value: others,
        color: pickColor(segments.length),
      });
    }
  }

  const cashByCurrency = calculateCashBalances(entities);
  const totalCash = round2(
    cashByCurrency.reduce(
      (sum, item) => sum + Math.abs(applyConversion(item.balance, item.currency, options)),
      0,
    ),
  );
  if (totalCash > 0) {
    segments.push({
      label: "Cash",
      value: totalCash,
      color: pickColor(segments.length),
    });
  }

  return segments.filter((item) => item.value > 0);
}

export function calculateCurrencyExposureSegments(
  entities: EntityDataset[],
  options?: CalculationConversionOptions,
): ChartSlice[] {
  const stockBreakdown = calculateStockBreakdown(entities);
  const cashBalances = calculateCashBalances(entities);
  const exposure = new Map<string, number>();

  stockBreakdown.forEach((item) => {
    const current = exposure.get(item.currency) ?? 0;
    exposure.set(
      item.currency,
      current + Math.abs(applyConversion(item.marketValue, item.currency, options)),
    );
  });

  cashBalances.forEach((item) => {
    const current = exposure.get(item.currency) ?? 0;
    exposure.set(
      item.currency,
      current + Math.abs(applyConversion(item.balance, item.currency, options)),
    );
  });

  return [...exposure.entries()]
    .map(([currency, value], index) => ({
      label: currency,
      value: round2(value),
      color: pickColor(index),
    }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);
}

function getActivityTotal(tx: NormalizedTransaction): number {
  const gross = tx.shares * tx.price;
  if (tx.type === "BUY") {
    return -(gross + tx.fee);
  }
  if (tx.type === "SELL") {
    return gross - tx.fee;
  }
  if (tx.type === "DIVIDEND_CASH") {
    return gross - tx.fee;
  }
  if (tx.type === "DIVIDEND_SHARE") {
    return -tx.fee;
  }
  if (tx.type === "FEE") {
    return -(gross + tx.fee);
  }
  if (tx.type === "INTEREST" || tx.type === "CASH" || tx.type === "CASH_CONVERT") {
    return gross - tx.fee;
  }
  return 0;
}

export function calculateMonthlyDividendSeries(
  entities: EntityDataset[],
  monthCount = 18,
  options?: CalculationConversionOptions,
): ChartBarDatum[] {
  return buildMonthlySeriesFromTransactions(
    entities,
    (tx) =>
      tx.type === "DIVIDEND_CASH" || tx.type === "DIVIDEND_SHARE"
        ? getActivityTotal(tx)
        : 0,
    monthCount,
    options,
  );
}

export function calculateMonthlyBuySeries(
  entities: EntityDataset[],
  monthCount = 18,
  options?: CalculationConversionOptions,
): ChartBarDatum[] {
  return buildMonthlySeriesFromTransactions(
    entities,
    (tx) => (tx.type === "BUY" ? Math.abs(tx.shares * tx.price) : 0),
    monthCount,
    options,
  );
}

export function calculateMonthlySellSeries(
  entities: EntityDataset[],
  monthCount = 18,
  options?: CalculationConversionOptions,
): ChartBarDatum[] {
  return buildMonthlySeriesFromTransactions(
    entities,
    (tx) => (tx.type === "SELL" ? Math.abs(tx.shares * tx.price) : 0),
    monthCount,
    options,
  );
}

export function calculateMonthlyFeeSeries(
  entities: EntityDataset[],
  monthCount = 18,
  options?: CalculationConversionOptions,
): ChartBarDatum[] {
  return buildMonthlySeriesFromTransactions(
    entities,
    (tx) => (tx.type === "FEE" ? getActivityTotal(tx) : 0),
    monthCount,
    options,
  );
}

export function calculateMonthlyCashFlowSeries(
  entities: EntityDataset[],
  monthCount = 18,
  options?: CalculationConversionOptions,
): ChartBarDatum[] {
  return buildMonthlySeriesFromTransactions(
    entities,
    (tx) =>
      tx.type === "CASH" || tx.type === "CASH_CONVERT" || tx.type === "INTEREST"
        ? getActivityTotal(tx)
        : 0,
    monthCount,
    options,
  );
}

export function calculateMonthlyTransactionCountSeries(
  entities: EntityDataset[],
  monthCount = 18,
): ChartBarDatum[] {
  return buildMonthlySeriesFromTransactions(entities, () => 1, monthCount);
}

export function calculateMonthlyProfitSeries(
  entities: EntityDataset[],
  monthCount = 18,
  options?: CalculationConversionOptions,
): ChartBarDatum[] {
  const groups = collectStockGroups(entities);
  if (groups.length === 0) {
    return [];
  }

  const today = startOfDay(new Date());
  const firstMonth = new Date(today.getFullYear(), today.getMonth() - (monthCount - 1), 1);
  const hasHistoricalSource =
    Object.keys(options?.historicalPriceBySymbol ?? {}).length > 0;

  if (!hasHistoricalSource) {
    return buildMonthlySeriesFromTransactions(
      entities,
      getActivityTotal,
      monthCount,
      options,
    );
  }

  const byMonth = new Map<string, number>();
  let previousTotalProfit: number | null = null;
  for (
    let cursor = new Date(firstMonth);
    cursor.getTime() <= today.getTime();
    cursor = addDays(cursor, 1)
  ) {
    const isToday = cursor.getTime() === today.getTime();
    let totalProfit = 0;
    for (const group of groups) {
      const historicalPrice = resolveHistoricalMarketPriceAtDate(
        options?.historicalPriceBySymbol?.[group.symbol],
        cursor,
      );
      const marketPrice = isToday && group.latestPrice > 0 ? group.latestPrice : historicalPrice;
      const metrics = evaluateStockAtDate(group, cursor, marketPrice);
      totalProfit += applyConversion(metrics.totalProfit, group.currency, options);
    }

    const dayProfit = previousTotalProfit === null ? 0 : totalProfit - previousTotalProfit;
    const key = monthKey(cursor);
    byMonth.set(key, (byMonth.get(key) ?? 0) + dayProfit);
    previousTotalProfit = totalProfit;
  }

  const output: ChartBarDatum[] = [];
  const monthCursor = new Date(firstMonth);
  for (let i = 0; i < monthCount; i += 1) {
    const key = monthKey(monthCursor);
    output.push({
      label: monthLabel(key),
      value: round2(byMonth.get(key) ?? 0),
    });
    monthCursor.setMonth(monthCursor.getMonth() + 1);
  }
  return output;
}

export function calculateTransactionTypeSeries(entities: EntityDataset[]): ChartBarDatum[] {
  const counts = new Map<TxType, number>();
  getAllTransactions(entities).forEach((tx) => {
    counts.set(tx.type, (counts.get(tx.type) ?? 0) + 1);
  });

  return [...counts.entries()]
    .map(([type, count]) => ({ label: type, value: count }))
    .sort((a, b) => b.value - a.value);
}

export function calculateTransactionHeatmap(entities: EntityDataset): HeatmapData;
export function calculateTransactionHeatmap(entities: EntityDataset[]): HeatmapData;
export function calculateTransactionHeatmap(
  entities: EntityDataset | EntityDataset[],
): HeatmapData {
  const list = Array.isArray(entities) ? entities : [entities];
  const transactions = getAllTransactions(list);
  const typeLabels: TxType[] = [
    "BUY",
    "SELL",
    "DIVIDEND_CASH",
    "DIVIDEND_SHARE",
    "CASH",
    "CASH_CONVERT",
    "FEE",
    "INTEREST",
  ];

  const now = new Date();
  const months: string[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(monthLabel(monthKey(d)));
  }

  const values = typeLabels.map(() => months.map(() => 0));
  const monthIndexMap = new Map<string, number>();
  for (let i = 0; i < months.length; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - (months.length - 1 - i), 1);
    monthIndexMap.set(monthKey(d), i);
  }

  transactions.forEach((tx) => {
    const monthIndex = monthIndexMap.get(monthKey(tx.date));
    if (monthIndex === undefined) {
      return;
    }
    const typeIndex = typeLabels.indexOf(tx.type);
    if (typeIndex < 0) {
      return;
    }
    values[typeIndex][monthIndex] += 1;
  });

  const maxValue = values.reduce(
    (max, row) => Math.max(max, ...row),
    0,
  );

  return {
    xLabels: months,
    yLabels: typeLabels,
    values,
    maxValue,
  };
}

export function calculateNormalizedCompareSeries(
  entities: EntityDataset[],
  range: ChartRange,
  limit = 3,
): CompareLineSeries[] {
  const breakdown = calculateStockBreakdown(entities)
    .filter((item) => Math.abs(item.marketValue) > 0)
    .sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue))
    .slice(0, limit);

  return breakdown.map((item, index) => {
    const series = calculateSeriesForStock(entities, item.id, range);
    if (series.length === 0) {
      return {
        id: item.id,
        label: item.symbol,
        color: pickColor(index),
        points: [],
      };
    }

    const baseline = item.totalCost + series[0].profit;
    const safeBaseline = baseline === 0 ? 1 : baseline;

    return {
      id: item.id,
      label: item.symbol,
      color: pickColor(index),
      points: series.map((point) => ({
        date: point.date,
        profit: round2(((item.totalCost + point.profit) / safeBaseline) * 100),
      })),
    };
  });
}

export function calculateInsightMetrics(entities: EntityDataset[]): InsightMetrics {
  const breakdown = calculateStockBreakdown(entities);
  const closed = breakdown.filter((item) => item.isClosed);
  const wins = closed.filter((item) => item.realizedProfit > 0).length;
  const allSeries = breakdown.length > 0
    ? calculatePortfolioProfitSeries(entities, { preset: "ALL" })
    : [];

  let peak = allSeries[0]?.profit ?? 0;
  let maxDrawdown = 0;
  allSeries.forEach((point) => {
    peak = Math.max(peak, point.profit);
    const drawdown = peak === 0 ? 0 : ((peak - point.profit) / Math.abs(peak || 1)) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  });

  const sorted = [...breakdown].sort((a, b) => b.totalProfit - a.totalProfit);
  const bestPerformer = sorted[0]?.symbol ?? "-";
  const worstPerformer = sorted[sorted.length - 1]?.symbol ?? "-";

  return {
    openPositions: breakdown.filter((item) => !item.isClosed).length,
    closedPositions: closed.length,
    winRate: closed.length > 0 ? round2((wins / closed.length) * 100) : 0,
    avgProfitPerStock:
      breakdown.length > 0
        ? round2(
            breakdown.reduce((sum, item) => sum + item.totalProfit, 0) / breakdown.length,
          )
        : 0,
    bestPerformer,
    worstPerformer,
    maxDrawdownPct: round2(maxDrawdown),
  };
}

export function calculatePortfolioProfitSeries(
  entities: EntityDataset[],
  range: ChartRange,
): ProfitPoint[] {
  const groups = collectStockGroups(entities);
  if (groups.length === 0) {
    return [];
  }

  const minDate = resolveDisplayMinDate(
    groups.flatMap((group) => group.transactions.map((tx) => tx.date)),
  );
  if (!minDate) {
    return [];
  }

  const { start, end } = resolveDateRange(startOfDay(minDate), range);
  const totalDays = daysBetweenInclusive(start, end);
  const targetPoints = getTargetPointCount(range.preset, totalDays);
  const stepDays = Math.max(1, Math.ceil(totalDays / targetPoints));

  const points: ProfitPoint[] = [];
  let cursor = new Date(start);

  while (cursor.getTime() <= end.getTime()) {
    let total = 0;
    groups.forEach((group) => {
      total += evaluateStockAtDate(group, cursor).totalProfit;
    });
    points.push({ date: new Date(cursor), profit: round2(total) });
    cursor = addDays(cursor, stepDays);
  }

  if (points.length === 0 || points[points.length - 1].date.getTime() !== end.getTime()) {
    let total = 0;
    groups.forEach((group) => {
      total += evaluateStockAtDate(group, end).totalProfit;
    });
    points.push({ date: new Date(end), profit: round2(total) });
  }

  return points;
}

export function calculatePortfolioOverviewSeries(
  entities: EntityDataset[],
  range: ChartRange,
  options?: CalculationConversionOptions,
): PortfolioOverviewPoint[] {
  const allTransactions = getAllTransactions(entities);
  if (allTransactions.length === 0) {
    return [];
  }

  const groups = collectStockGroups(entities);
  const summaryCurrency = options?.targetCurrency ?? entities[0]?.currency ?? "USD";
  const minDate = resolveDisplayMinDate(allTransactions.map((tx) => tx.date));
  if (!minDate) {
    return [];
  }
  const resolveFundingCostAtTime = createFundingCostResolver(
    getFundingTransactions(entities),
    options,
  );
  const fallbackStockCost = round2(
    calculateStockBreakdown(entities).reduce(
      (total, item) => total + applyConversion(item.totalCost, item.currency, options),
      0,
    ),
  );

  const { start, end } = resolveDateRange(startOfDay(minDate), range);
  const totalDays = daysBetweenInclusive(start, end);
  const targetPoints = getTargetPointCount(range.preset, totalDays);
  const stepDays = Math.max(1, Math.ceil(totalDays / targetPoints));

  const points: PortfolioOverviewPoint[] = [];
  let cursor = new Date(start);

  while (cursor.getTime() <= end.getTime()) {
    const totalCostRaw = resolveFundingCostAtTime(cursor.getTime());
    const totalCost = totalCostRaw !== 0 ? totalCostRaw : fallbackStockCost;
    let totalProfit = 0;
    let stockMarketValue = 0;

    const isFinalPoint = cursor.getTime() === end.getTime();
    groups.forEach((group) => {
      const historicalPrice = resolveHistoricalMarketPriceAtDate(
        options?.historicalPriceBySymbol?.[group.symbol],
        cursor,
      );
      const marketPriceForPoint =
        isFinalPoint && group.latestPrice > 0 ? group.latestPrice : historicalPrice;
      const metrics = evaluateStockAtDate(group, cursor, marketPriceForPoint);
      totalProfit += applyConversion(metrics.totalProfit, group.currency, options);
      stockMarketValue += applyConversion(metrics.marketValue, group.currency, options);
    });

    const cashBalances = calculateCashBalancesAtDate(entities, cursor);
    const cashBalance = round2(
      [...cashBalances.entries()].reduce(
        (total, [currency, balance]) => total + applyConversion(balance, currency, options),
        0,
      ),
    );
    const totalAssets = round2(stockMarketValue + cashBalance);
    const totalReturnPct = totalCost > 0 ? round2((totalProfit / totalCost) * 100) : 0;

    points.push({
      date: new Date(cursor),
      cashBalance: round2(cashBalance),
      stockMarketValue: round2(stockMarketValue),
      totalMarketValue: totalAssets,
      totalCost,
      totalAssets,
      totalProfit: round2(totalProfit),
      totalReturnPct,
    });
    cursor = addDays(cursor, stepDays);
  }

  if (points.length === 0 || points[points.length - 1].date.getTime() !== end.getTime()) {
    const totalCostRaw = resolveFundingCostAtTime(end.getTime());
    const totalCost = totalCostRaw !== 0 ? totalCostRaw : fallbackStockCost;
    let totalProfit = 0;
    let stockMarketValue = 0;

    groups.forEach((group) => {
      const historicalPrice = resolveHistoricalMarketPriceAtDate(
        options?.historicalPriceBySymbol?.[group.symbol],
        end,
      );
      const marketPriceForPoint = group.latestPrice > 0 ? group.latestPrice : historicalPrice;
      const metrics = evaluateStockAtDate(group, end, marketPriceForPoint);
      totalProfit += applyConversion(metrics.totalProfit, group.currency, options);
      stockMarketValue += applyConversion(metrics.marketValue, group.currency, options);
    });

    const cashBalances = calculateCashBalancesAtDate(entities, end);
    const cashBalance = round2(
      [...cashBalances.entries()].reduce(
        (total, [currency, balance]) => total + applyConversion(balance, currency, options),
        0,
      ),
    );
    const totalAssets = round2(stockMarketValue + cashBalance);
    const totalReturnPct = totalCost > 0 ? round2((totalProfit / totalCost) * 100) : 0;

    points.push({
      date: new Date(end),
      cashBalance: round2(cashBalance),
      stockMarketValue: round2(stockMarketValue),
      totalMarketValue: totalAssets,
      totalCost,
      totalAssets,
      totalProfit: round2(totalProfit),
      totalReturnPct,
    });
  }

  return points;
}

export function calculateDrawdownSeries(
  entities: EntityDataset[],
  range: ChartRange,
): ChartBarDatum[] {
  const series = calculatePortfolioProfitSeries(entities, range);
  if (series.length === 0) {
    return [];
  }

  let peak = series[0].profit;
  return series.map((point) => {
    peak = Math.max(peak, point.profit);
    const drawdown =
      peak === 0 ? 0 : ((point.profit - peak) / Math.abs(peak || 1)) * 100;
    return {
      label: point.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: round2(drawdown),
    };
  });
}

export function calculateDividendCalendarSeries(
  entities: EntityDataset[],
): ChartBarDatum[] {
  const monthly = new Map<number, number>();
  for (let month = 0; month < 12; month += 1) {
    monthly.set(month, 0);
  }

  getAllTransactions(entities).forEach((tx) => {
    if (tx.type !== "DIVIDEND_CASH") {
      return;
    }
    const month = tx.date.getMonth();
    monthly.set(month, (monthly.get(month) ?? 0) + tx.shares * tx.price);
  });

  const start = new Date();
  return Array.from({ length: 12 }).map((_, index) => {
    const monthDate = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const month = monthDate.getMonth();
    return {
      label: monthDate.toLocaleDateString(undefined, { month: "short" }),
      value: round2(monthly.get(month) ?? 0),
    };
  });
}

export function calculateRebalanceSuggestions(
  entities: EntityDataset[],
  maxItems = 6,
): RebalanceSuggestion[] {
  const holdings = calculateStockBreakdown(entities)
    .filter((item) => item.activeShares !== 0 && Math.abs(item.marketValue) > 0)
    .sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue));
  if (holdings.length === 0) {
    return [];
  }

  const selected = holdings.slice(0, maxItems);
  const total = selected.reduce((sum, item) => sum + Math.abs(item.marketValue), 0);
  if (total === 0) {
    return [];
  }

  const targetWeight = 100 / selected.length;

  return selected
    .map((item) => {
      const currentWeight = (Math.abs(item.marketValue) / total) * 100;
      const diffPct = currentWeight - targetWeight;
      const diffValue = (diffPct / 100) * total;
      return {
        symbol: item.symbol,
        currency: item.currency,
        currentWeightPct: round2(currentWeight),
        targetWeightPct: round2(targetWeight),
        diffPct: round2(diffPct),
        diffValue: round2(diffValue),
      };
    })
    .sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct));
}

export function getStockDateBounds(
  entities: EntityDataset[],
  stockId: string,
): DateBounds | null {
  const target = collectStockGroups(entities).find((group) => group.id === stockId);
  if (!target) {
    return null;
  }

  return getGroupDateBounds(target);
}

export function calculateSeriesForStock(
  entities: EntityDataset[],
  stockId: string,
  range: ChartRange,
): ProfitPoint[] {
  const target = collectStockGroups(entities).find((group) => group.id === stockId);
  if (!target) {
    return [];
  }

  const resolvedRange = resolveRangeForGroup(target, range);
  if (!resolvedRange) {
    return [];
  }

  const start = resolvedRange.minDate;
  const end = resolvedRange.maxDate;
  const totalDays = daysBetweenInclusive(start, end);
  const targetPoints = getTargetPointCount(range.preset, totalDays);
  const stepDays = Math.max(1, Math.ceil(totalDays / targetPoints));

  const points: ProfitPoint[] = [];
  let cursor = new Date(start);

  while (cursor.getTime() <= end.getTime()) {
    const pointDate = new Date(cursor);
    const { totalProfit } = evaluateStockAtDate(target, pointDate);
    points.push({ date: pointDate, profit: totalProfit });
    cursor = addDays(cursor, stepDays);
  }

  if (points.length === 0 || points[points.length - 1].date.getTime() !== end.getTime()) {
    const { totalProfit } = evaluateStockAtDate(target, end);
    points.push({ date: new Date(end), profit: totalProfit });
  }

  return points;
}

export function calculateYearSeriesForStock(
  entities: EntityDataset[],
  stockId: string,
): ProfitPoint[] {
  return calculateSeriesForStock(entities, stockId, { preset: "1Y" });
}
