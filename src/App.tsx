import { ChangeEvent, useEffect, useMemo, useState } from "react";
import AreaChart from "./components/AreaChart";
import BarChart from "./components/BarChart";
import HeatmapGrid from "./components/HeatmapGrid";
import MultiLineChart from "./components/MultiLineChart";
import PieChart from "./components/PieChart";
import {
  ChartRangePreset,
  type ChartSlice,
  calculateAssetAllocationSegments,
  calculateCashBalances,
  calculateCurrencyExposureSegments,
  calculateDividendCalendarSeries,
  calculateDrawdownSeries,
  calculateInsightMetrics,
  calculateMonthlyCashFlowSeries,
  calculateMonthlyDividendSeries,
  calculateMonthlyTransactionCountSeries,
  calculateNormalizedCompareSeries,
  calculatePortfolioSummary,
  calculatePortfolioProfitSeries,
  calculateRebalanceSuggestions,
  calculateSeriesForStock,
  calculateStockBreakdown,
  calculateTransactionHeatmap,
  calculateTransactionTypeSeries,
  getStockDateBounds,
} from "./lib/calculations";
import { parseInputByType } from "./lib/formatParser";
import { EntityDataset, NormalizedTransaction, TxType, UserType } from "./types";

type Screen = "choose" | "upload" | "dashboard";
type DashboardTab = "dashboard" | "analysis" | "holdings" | "transactions" | "data" | "settings";
type DateFilterPreset = "all" | "today" | "week" | "month" | "year" | "custom";
type Locale = "en" | "zh-HK";

type TransactionTypeFilter = "all" | TxType;

interface TransactionRow extends NormalizedTransaction {
  portfolioId: string;
  portfolioName: string;
}

interface TransactionDraft {
  id: string;
  portfolioId: string;
  date: string;
  type: TxType;
  symbol: string;
  shares: string;
  price: string;
  fee: string;
  currency: string;
  note: string;
}

interface WebSettings {
  language: Locale;
  showObscure: boolean;
  enableAnimations: boolean;
  showCashInAllocation: boolean;
  defaultCurrency: string;
  defaultImportType: UserType;
  compactTables: boolean;
}

interface PendingCashReview {
  portfolioId: string;
  transaction: NormalizedTransaction;
  currency: string;
  cashBalance: number;
  shortfall: number;
  editingTransactionId: string | null;
}

const STORAGE_KEY = "stocker-web-v2";
const SETTINGS_STORAGE_KEY = "stocker-web-settings-v1";

function detectDefaultLocale(): Locale {
  if (typeof navigator !== "undefined") {
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) {
      return "zh-HK";
    }
  }
  return "en";
}

const DEFAULT_SETTINGS: WebSettings = {
  language: detectDefaultLocale(),
  showObscure: false,
  enableAnimations: true,
  showCashInAllocation: true,
  defaultCurrency: "USD",
  defaultImportType: "stockerpro",
  compactTables: false,
};

const TIME_RANGE_OPTIONS: { value: ChartRangePreset; label: string }[] = [
  { value: "1W", label: "1W" },
  { value: "1M", label: "1M" },
  { value: "1Y", label: "1Y" },
  { value: "10Y", label: "10Y" },
  { value: "ALL", label: "All" },
  { value: "CUSTOM", label: "Custom" },
];

const TIME_RANGE_TITLES: Record<ChartRangePreset, string> = {
  "1W": "1W",
  "1M": "1M",
  "1Y": "1Y",
  "10Y": "10Y",
  ALL: "All Time",
  CUSTOM: "Custom",
};

const TIME_RANGE_TITLES_ZH: Record<ChartRangePreset, string> = {
  "1W": "1週",
  "1M": "1個月",
  "1Y": "1年",
  "10Y": "10年",
  ALL: "全部時間",
  CUSTOM: "自選",
};

const DATE_FILTER_LABELS_ZH: Record<DateFilterPreset, string> = {
  all: "全部",
  today: "今日",
  week: "本週",
  month: "本月",
  year: "今年",
  custom: "自選",
};

const DATE_FILTER_OPTIONS: { value: DateFilterPreset; label: string }[] = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "week", label: "This Week" },
  { value: "month", label: "This Month" },
  { value: "year", label: "This Year" },
  { value: "custom", label: "Custom" },
];

const TRANSACTION_TYPE_OPTIONS: { value: TransactionTypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "BUY", label: "BUY" },
  { value: "SELL", label: "SELL" },
  { value: "DIVIDEND_CASH", label: "DIVIDEND_CASH" },
  { value: "DIVIDEND_SHARE", label: "DIVIDEND_SHARE" },
  { value: "CASH", label: "CASH" },
  { value: "CASH_CONVERT", label: "CASH_CONVERT" },
  { value: "FEE", label: "FEE" },
  { value: "INTEREST", label: "INTEREST" },
];

const PIE_SEGMENT_COLORS = [
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

const CURRENCY_COUNTRY_FALLBACK: Record<string, string> = {
  USD: "US",
  CAD: "Canada",
  HKD: "Hong Kong",
  CNY: "China",
  CNH: "China",
  JPY: "Japan",
  EUR: "Eurozone",
  GBP: "UK",
  AUD: "Australia",
  SGD: "Singapore",
  TWD: "Taiwan",
  KRW: "South Korea",
  INR: "India",
  CHF: "Switzerland",
};

const ETF_SYMBOL_HINTS = new Set([
  "SPY",
  "VOO",
  "IVV",
  "QQQ",
  "VTI",
  "DIA",
  "IWM",
  "EFA",
  "EEM",
  "ARKK",
  "ARKQ",
  "SCHD",
  "VT",
  "FXI",
  "EWJ",
  "EWH",
  "ASHR",
  "2800.HK",
]);

function inferCountryFromSymbol(symbol: string, currency: string): string {
  const upper = symbol.toUpperCase();
  if (upper.endsWith(".HK")) {
    return "Hong Kong";
  }
  if (upper.endsWith(".SS") || upper.endsWith(".SZ")) {
    return "China";
  }
  if (upper.endsWith(".T")) {
    return "Japan";
  }
  if (upper.endsWith(".KS") || upper.endsWith(".KQ")) {
    return "South Korea";
  }
  if (upper.endsWith(".TW")) {
    return "Taiwan";
  }
  if (upper.endsWith(".L")) {
    return "UK";
  }
  if (upper.endsWith(".TO") || upper.endsWith(".TSX")) {
    return "Canada";
  }
  if (upper.endsWith(".AX")) {
    return "Australia";
  }
  if (upper.endsWith(".PA")) {
    return "France";
  }
  if (upper.endsWith(".DE") || upper.endsWith(".F")) {
    return "Germany";
  }
  return CURRENCY_COUNTRY_FALLBACK[currency.toUpperCase()] ?? "Other";
}

function inferCategoryFromSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();

  if (upper.includes("-USD") || upper.includes("USDT") || upper.includes("BTC") || upper.includes("ETH")) {
    return "Crypto";
  }
  if (upper.includes("REIT")) {
    return "REIT";
  }
  if (upper.endsWith("ADR")) {
    return "ADR";
  }
  if (upper.endsWith("ETF") || upper.includes(" ETF") || ETF_SYMBOL_HINTS.has(upper)) {
    return "ETF";
  }
  return "Stock";
}

function buildSlicesFromMap(values: Map<string, number>): ChartSlice[] {
  return [...values.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({
      label,
      value: Math.round(value * 100) / 100,
      color: PIE_SEGMENT_COLORS[index % PIE_SEGMENT_COLORS.length],
    }));
}

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (!year || !month || !day) {
    return undefined;
  }

  return new Date(year, month - 1, day);
}

function parseNumberish(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function loadWebSettings(): WebSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(raw) as Partial<WebSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function formatAgo(date: Date, locale: Locale = "en"): string {
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) {
    return locale === "zh-HK" ? "剛剛" : "just now";
  }
  if (diffMinutes < 60) {
    return locale === "zh-HK" ? `${diffMinutes}分鐘前` : `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return locale === "zh-HK" ? `${diffHours}小時前` : `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return locale === "zh-HK" ? `${diffDays}日前` : `${diffDays}d ago`;
}

function projectYearsToGoal(
  currentValue: number,
  monthlyContribution: number,
  annualReturnPct: number,
  targetValue: number,
): number | null {
  if (targetValue <= currentValue) {
    return 0;
  }
  if (monthlyContribution <= 0 && annualReturnPct <= 0) {
    return null;
  }

  const monthlyRate = annualReturnPct / 100 / 12;
  let value = currentValue;
  let months = 0;

  while (value < targetValue && months < 1200) {
    value *= 1 + monthlyRate;
    value += monthlyContribution;
    months += 1;
  }

  if (value < targetValue) {
    return null;
  }

  return Math.round((months / 12) * 10) / 10;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function sortTransactionsByDateAsc(transactions: NormalizedTransaction[]): NormalizedTransaction[] {
  return [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function shouldUseCurrencyAsSymbol(type: TxType): boolean {
  return type === "CASH" || type === "CASH_CONVERT" || type === "FEE" || type === "INTEREST";
}

function getTransactionNetCashFlow(tx: NormalizedTransaction): number {
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

function buildLatestPriceBySymbol(transactions: NormalizedTransaction[]): Record<string, number> {
  const latest = new Map<string, { date: number; price: number }>();

  for (const tx of transactions) {
    if (!tx.symbol || tx.symbol === tx.currency || tx.price <= 0) {
      continue;
    }

    const existing = latest.get(tx.symbol);
    const timestamp = tx.date.getTime();
    if (!existing || timestamp >= existing.date) {
      latest.set(tx.symbol, { date: timestamp, price: tx.price });
    }
  }

  const result: Record<string, number> = {};
  latest.forEach((value, symbol) => {
    result[symbol] = value.price;
  });
  return result;
}

function isDateInPresetRange(
  date: Date,
  preset: DateFilterPreset,
  customStart: string,
  customEnd: string,
): boolean {
  if (preset === "all") {
    return true;
  }

  const now = new Date();
  const target = startOfDay(date);
  const today = startOfDay(now);

  if (preset === "today") {
    return target.getTime() === today.getTime();
  }

  if (preset === "week") {
    const start = new Date(today);
    const day = start.getDay();
    const offset = day === 0 ? 6 : day - 1;
    start.setDate(today.getDate() - offset);
    return target.getTime() >= start.getTime() && target.getTime() <= today.getTime();
  }

  if (preset === "month") {
    return target.getFullYear() === today.getFullYear() && target.getMonth() === today.getMonth();
  }

  if (preset === "year") {
    return target.getFullYear() === today.getFullYear();
  }

  const customStartDate = parseDateInput(customStart);
  const customEndDate = parseDateInput(customEnd);

  if (!customStartDate && !customEndDate) {
    return false;
  }

  const start = customStartDate ? startOfDay(customStartDate) : undefined;
  const end = customEndDate ? startOfDay(customEndDate) : undefined;

  if (start && target.getTime() < start.getTime()) {
    return false;
  }
  if (end && target.getTime() > end.getTime()) {
    return false;
  }
  return true;
}

function serializeEntities(entities: EntityDataset[]): string {
  return JSON.stringify(
    entities.map((entity) => ({
      ...entity,
      transactions: entity.transactions.map((tx) => ({
        ...tx,
        date: tx.date.toISOString(),
      })),
    })),
  );
}

function deserializeEntities(raw: string): EntityDataset[] {
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((entityRaw, entityIndex) => {
    const transactionsRaw = Array.isArray(entityRaw.transactions)
      ? (entityRaw.transactions as Array<Record<string, unknown>>)
      : [];

    const transactions: NormalizedTransaction[] = transactionsRaw.map((txRaw, txIndex) => {
      const txType = String(txRaw.type ?? "CASH").toUpperCase() as TxType;
      return {
        id: String(txRaw.id ?? `tx-${entityIndex}-${txIndex}`),
        date: new Date(String(txRaw.date ?? new Date().toISOString())),
        symbol: String(txRaw.symbol ?? "").toUpperCase(),
        type: txType,
        shares: Number(txRaw.shares ?? 0),
        price: Number(txRaw.price ?? 0),
        fee: Number(txRaw.fee ?? 0),
        currency: String(txRaw.currency ?? entityRaw.currency ?? "USD").toUpperCase(),
        note: String(txRaw.note ?? ""),
      };
    });

    return {
      id: String(entityRaw.id ?? `portfolio-${entityIndex + 1}`),
      name: String(entityRaw.name ?? `Portfolio ${entityIndex + 1}`),
      currency: String(entityRaw.currency ?? "USD").toUpperCase(),
      transactions: sortTransactionsByDateAsc(transactions),
      latestPriceBySymbol:
        (entityRaw.latestPriceBySymbol as Record<string, number> | undefined) ??
        buildLatestPriceBySymbol(transactions),
    };
  });
}

function buildDefaultDraft(portfolioId: string, currency: string): TransactionDraft {
  return {
    id: `tx-${Date.now()}`,
    portfolioId,
    date: toDateInputValue(new Date()),
    type: "BUY",
    symbol: "",
    shares: "0",
    price: "0",
    fee: "0",
    currency,
    note: "",
  };
}

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>("choose");
  const [activeTab, setActiveTab] = useState<DashboardTab>("dashboard");
  const [userType, setUserType] = useState<UserType | null>(null);
  const [entities, setEntities] = useState<EntityDataset[]>([]);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState<string>("all");
  const [selectedStockId, setSelectedStockId] = useState<string>("");
  const [selectedRange, setSelectedRange] = useState<ChartRangePreset>("1Y");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const [txTypeFilter, setTxTypeFilter] = useState<TransactionTypeFilter>("all");
  const [txDateFilter, setTxDateFilter] = useState<DateFilterPreset>("all");
  const [txCustomStart, setTxCustomStart] = useState("");
  const [txCustomEnd, setTxCustomEnd] = useState("");
  const [txKeyword, setTxKeyword] = useState("");

  const [holdingSearch, setHoldingSearch] = useState("");
  const [holdingSort, setHoldingSort] = useState<"marketValue" | "profit" | "symbol">("marketValue");

  const [goalTarget, setGoalTarget] = useState("1000000");
  const [goalMonthlyContribution, setGoalMonthlyContribution] = useState("1000");
  const [goalReturnPct, setGoalReturnPct] = useState("8");

  const [isTxModalOpen, setTxModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<TransactionRow | null>(null);
  const [draft, setDraft] = useState<TransactionDraft>(buildDefaultDraft("", "USD"));
  const [transactionError, setTransactionError] = useState("");
  const [pendingCashReview, setPendingCashReview] = useState<PendingCashReview | null>(null);
  const [pendingCashAmount, setPendingCashAmount] = useState("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [dataImportType, setDataImportType] = useState<UserType>("stockerpro");
  const [settings, setSettings] = useState<WebSettings>(DEFAULT_SETTINGS);
  const [selectedStockDetailId, setSelectedStockDetailId] = useState<string | null>(null);

  const isZh = settings.language === "zh-HK";
  const localeTag = isZh ? "zh-HK" : "en-US";
  const t = (en: string, zh: string): string => (isZh ? zh : en);
  const rangeTitle = (preset: ChartRangePreset): string =>
    isZh ? TIME_RANGE_TITLES_ZH[preset] : TIME_RANGE_TITLES[preset];
  const dateFilterLabel = (preset: DateFilterPreset, fallback: string): string =>
    isZh ? DATE_FILTER_LABELS_ZH[preset] : fallback;

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        return;
      }
      const restored = deserializeEntities(stored);
      if (restored.length > 0) {
        setEntities(restored);
        setUserType("stockerpro");
        setScreen("dashboard");
      }
    } catch {
      // Ignore invalid local cache.
    }
  }, []);

  useEffect(() => {
    const loaded = loadWebSettings();
    setSettings(loaded);
    setDataImportType(loaded.defaultImportType);
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (screen !== "dashboard") {
      return;
    }
    if (entities.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }

    localStorage.setItem(STORAGE_KEY, serializeEntities(entities));
  }, [entities, screen]);

  const filteredEntities = useMemo(() => {
    if (selectedPortfolioId === "all") {
      return entities;
    }
    return entities.filter((entity) => entity.id === selectedPortfolioId);
  }, [entities, selectedPortfolioId]);

  const portfolioSummary = useMemo(
    () => calculatePortfolioSummary(filteredEntities),
    [filteredEntities],
  );

  const cashBalances = useMemo(
    () => calculateCashBalances(filteredEntities),
    [filteredEntities],
  );

  const stockBreakdown = useMemo(
    () => calculateStockBreakdown(filteredEntities),
    [filteredEntities],
  );

  const stockLeaderboard = useMemo(
    () => [...stockBreakdown].sort((a, b) => b.totalProfit - a.totalProfit),
    [stockBreakdown],
  );

  const holdingStocks = useMemo(
    () => stockBreakdown.filter((item) => item.activeShares !== 0),
    [stockBreakdown],
  );

  const closedStocks = useMemo(
    () => stockBreakdown.filter((item) => item.activeShares === 0),
    [stockBreakdown],
  );

  const displayedHoldingStocks = useMemo(() => {
    const keyword = holdingSearch.trim().toUpperCase();
    const filtered = holdingStocks.filter((item) =>
      keyword ? item.symbol.includes(keyword) : true,
    );

    return [...filtered].sort((a, b) => {
      if (holdingSort === "symbol") {
        return a.symbol.localeCompare(b.symbol);
      }
      if (holdingSort === "profit") {
        return b.totalProfit - a.totalProfit;
      }
      return Math.abs(b.marketValue) - Math.abs(a.marketValue);
    });
  }, [holdingSearch, holdingSort, holdingStocks]);

  const displayedClosedStocks = useMemo(() => {
    const keyword = holdingSearch.trim().toUpperCase();
    return closedStocks.filter((item) => (keyword ? item.symbol.includes(keyword) : true));
  }, [closedStocks, holdingSearch]);

  const selectedStock =
    stockLeaderboard.find((metric) => metric.id === selectedStockId) ??
    stockLeaderboard[0] ??
    null;

  const selectedBounds = useMemo(() => {
    if (!selectedStock) {
      return null;
    }
    return getStockDateBounds(filteredEntities, selectedStock.id);
  }, [filteredEntities, selectedStock]);

  const selectedSeries = useMemo(() => {
    if (!selectedStock) {
      return [];
    }
    return calculateSeriesForStock(filteredEntities, selectedStock.id, {
      preset: selectedRange,
      startDate: selectedRange === "CUSTOM" ? parseDateInput(customStart) : undefined,
      endDate: selectedRange === "CUSTOM" ? parseDateInput(customEnd) : undefined,
    });
  }, [customEnd, customStart, filteredEntities, selectedRange, selectedStock]);

  const rangeProfit = useMemo(() => {
    if (selectedSeries.length === 0) {
      return 0;
    }
    const first = selectedSeries[0].profit;
    const last = selectedSeries[selectedSeries.length - 1].profit;
    return last - first;
  }, [selectedSeries]);

  const rangeProfitPct = useMemo(() => {
    if (!selectedStock || selectedStock.totalCost === 0) {
      return 0;
    }
    return (rangeProfit / selectedStock.totalCost) * 100;
  }, [rangeProfit, selectedStock]);

  const allTransactions = useMemo(() => {
    const rows: TransactionRow[] = [];

    filteredEntities.forEach((entity) => {
      entity.transactions.forEach((tx) => {
        rows.push({
          ...tx,
          portfolioId: entity.id,
          portfolioName: entity.name,
        });
      });
    });

    return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [filteredEntities]);

  const filteredTransactions = useMemo(() => {
    const keyword = txKeyword.trim().toUpperCase();
    return allTransactions.filter((tx) => {
      const passType = txTypeFilter === "all" ? true : tx.type === txTypeFilter;
      if (!passType) {
        return false;
      }

      const passDate = isDateInPresetRange(tx.date, txDateFilter, txCustomStart, txCustomEnd);
      if (!passDate) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      return (
        tx.symbol.includes(keyword) ||
        tx.portfolioName.toUpperCase().includes(keyword) ||
        (tx.note ?? "").toUpperCase().includes(keyword)
      );
    });
  }, [allTransactions, txCustomEnd, txCustomStart, txDateFilter, txKeyword, txTypeFilter]);

  const transactionNetValue = useMemo(
    () => filteredTransactions.reduce((total, tx) => total + getTransactionNetCashFlow(tx), 0),
    [filteredTransactions],
  );

  const currentRange = useMemo(
    () => ({
      preset: selectedRange,
      startDate: selectedRange === "CUSTOM" ? parseDateInput(customStart) : undefined,
      endDate: selectedRange === "CUSTOM" ? parseDateInput(customEnd) : undefined,
    }),
    [customEnd, customStart, selectedRange],
  );

  const portfolioProfitSeries = useMemo(
    () => calculatePortfolioProfitSeries(filteredEntities, currentRange),
    [currentRange, filteredEntities],
  );
  const assetAllocation = useMemo(
    () => calculateAssetAllocationSegments(filteredEntities),
    [filteredEntities],
  );
  const currencyExposure = useMemo(
    () => calculateCurrencyExposureSegments(filteredEntities),
    [filteredEntities],
  );
  const monthlyDividendSeries = useMemo(
    () => calculateMonthlyDividendSeries(filteredEntities, 18),
    [filteredEntities],
  );
  const monthlyCashFlowSeries = useMemo(
    () => calculateMonthlyCashFlowSeries(filteredEntities, 18),
    [filteredEntities],
  );
  const monthlyTxCountSeries = useMemo(
    () => calculateMonthlyTransactionCountSeries(filteredEntities, 18),
    [filteredEntities],
  );
  const txTypeSeries = useMemo(
    () => calculateTransactionTypeSeries(filteredEntities),
    [filteredEntities],
  );
  const compareSeries = useMemo(
    () => calculateNormalizedCompareSeries(filteredEntities, currentRange, 4),
    [currentRange, filteredEntities],
  );
  const transactionHeatmap = useMemo(
    () => calculateTransactionHeatmap(filteredEntities),
    [filteredEntities],
  );
  const insights = useMemo(
    () => calculateInsightMetrics(filteredEntities),
    [filteredEntities],
  );
  const drawdownSeries = useMemo(
    () => calculateDrawdownSeries(filteredEntities, currentRange),
    [currentRange, filteredEntities],
  );
  const dividendCalendarSeries = useMemo(
    () => calculateDividendCalendarSeries(filteredEntities),
    [filteredEntities],
  );
  const rebalanceSuggestions = useMemo(
    () => calculateRebalanceSuggestions(filteredEntities, 6),
    [filteredEntities],
  );

  const goalYears = useMemo(
    () =>
      projectYearsToGoal(
        portfolioSummary.totalAssets,
        parseNumberish(goalMonthlyContribution),
        parseNumberish(goalReturnPct),
        parseNumberish(goalTarget),
      ),
    [goalMonthlyContribution, goalReturnPct, goalTarget, portfolioSummary.totalAssets],
  );

  const visibleAssetAllocation = useMemo(() => {
    if (settings.showCashInAllocation) {
      return assetAllocation;
    }
    return assetAllocation.filter((item) => item.label !== "Cash");
  }, [assetAllocation, settings.showCashInAllocation]);

  const stockDistribution = useMemo(() => {
    return stockBreakdown
      .filter((item) => Math.abs(item.marketValue) > 0)
      .sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue))
      .map((item, index) => ({
        label: item.symbol,
        value: Math.abs(item.marketValue),
        color: PIE_SEGMENT_COLORS[index % PIE_SEGMENT_COLORS.length],
      }));
  }, [stockBreakdown]);

  const stockCountryDistribution = useMemo(() => {
    const grouped = new Map<string, number>();
    stockBreakdown.forEach((item) => {
      const value = Math.abs(item.marketValue);
      if (value <= 0) {
        return;
      }
      const country = inferCountryFromSymbol(item.symbol, item.currency);
      grouped.set(country, (grouped.get(country) ?? 0) + value);
    });
    return buildSlicesFromMap(grouped);
  }, [stockBreakdown]);

  const stockCategoryDistribution = useMemo(() => {
    const grouped = new Map<string, number>();
    stockBreakdown.forEach((item) => {
      const value = Math.abs(item.marketValue);
      if (value <= 0) {
        return;
      }
      const category = inferCategoryFromSymbol(item.symbol);
      grouped.set(category, (grouped.get(category) ?? 0) + value);
    });
    return buildSlicesFromMap(grouped);
  }, [stockBreakdown]);

  const stockDetail = useMemo(() => {
    if (!selectedStockDetailId) {
      return null;
    }
    return stockBreakdown.find((item) => item.id === selectedStockDetailId) ?? null;
  }, [selectedStockDetailId, stockBreakdown]);

  const stockDetailSeries = useMemo(() => {
    if (!stockDetail) {
      return [];
    }
    return calculateSeriesForStock(filteredEntities, stockDetail.id, currentRange);
  }, [currentRange, filteredEntities, stockDetail]);

  const stockDetailTransactions = useMemo(() => {
    if (!stockDetail) {
      return [] as TransactionRow[];
    }
    return allTransactions.filter((tx) => tx.symbol === stockDetail.symbol);
  }, [allTransactions, stockDetail]);

  const tableDensityClass = settings.compactTables ? "table-compact" : "";

  const displayMoney = (value: number, currency: string): string =>
    settings.showObscure ? "••••" : formatCurrency(value, currency);

  const displayPercent = (value: number): string =>
    settings.showObscure ? "•••%" : formatPercent(value);

  const formatPieMoneyValue = (value: number): string =>
    displayMoney(value, portfolioSummary.currency);

  useEffect(() => {
    if (stockLeaderboard.length === 0) {
      setSelectedStockId("");
      return;
    }

    if (!stockLeaderboard.some((item) => item.id === selectedStockId)) {
      setSelectedStockId(stockLeaderboard[0].id);
    }
  }, [stockLeaderboard, selectedStockId]);

  useEffect(() => {
    if (!selectedStockDetailId) {
      return;
    }
    if (!stockLeaderboard.some((item) => item.id === selectedStockDetailId)) {
      setSelectedStockDetailId(null);
    }
  }, [selectedStockDetailId, stockLeaderboard]);

  useEffect(() => {
    if (selectedPortfolioId === "all") {
      return;
    }
    if (!entities.some((entity) => entity.id === selectedPortfolioId)) {
      setSelectedPortfolioId("all");
    }
  }, [entities, selectedPortfolioId]);

  useEffect(() => {
    if (!selectedStock) {
      setCustomStart("");
      setCustomEnd("");
      return;
    }

    const bounds = getStockDateBounds(filteredEntities, selectedStock.id);
    if (!bounds) {
      setCustomStart("");
      setCustomEnd("");
      return;
    }

    setCustomStart(toDateInputValue(bounds.minDate));
    setCustomEnd(toDateInputValue(bounds.maxDate));
  }, [filteredEntities, selectedStock]);

  const selectUserType = async (type: UserType): Promise<void> => {
    setErrorMessage("");
    setUserType(type);

    if (type === "new") {
      const newEntities = await parseInputByType("", "new");
      const preferredCurrency = settings.defaultCurrency.trim().toUpperCase() || "USD";
      setEntities(
        newEntities.map((entity) => ({
          ...entity,
          currency: preferredCurrency,
        })),
      );
      setSelectedPortfolioId("all");
      setSelectedStockId("");
      setSelectedRange("1Y");
      setScreen("dashboard");
      return;
    }

    setScreen("upload");
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    if (!userType || !event.target.files || event.target.files.length === 0) {
      return;
    }

    const file = event.target.files[0];
    setLoading(true);
    setErrorMessage("");

    try {
      const content = await file.text();
      const parsed = await parseInputByType(content, userType);
      if (parsed.length === 0) {
        throw new Error(t("No portfolios/stocker entries found in this file.", "檔案內未找到任何組合資料。"));
      }

      setEntities(parsed);
      setSelectedPortfolioId("all");
      setSelectedStockId("");
      setSelectedRange("1Y");
      setScreen("dashboard");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("Cannot parse this file. Please check the format.", "無法解析此檔案，請檢查格式。");
      setErrorMessage(message);
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  };

  const onDataImportFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    if (!event.target.files || event.target.files.length === 0) {
      return;
    }

    const file = event.target.files[0];
    setLoading(true);
    setErrorMessage("");

    try {
      const content = await file.text();
      const parsed = await parseInputByType(content, dataImportType);
      if (parsed.length === 0) {
        throw new Error(t("No portfolios/stocker entries found in this file.", "檔案內未找到任何組合資料。"));
      }
      setEntities(parsed);
      setSelectedPortfolioId("all");
      setSelectedStockId("");
      setSelectedRange("1Y");
      setScreen("dashboard");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("Cannot parse this file. Please check the format.", "無法解析此檔案，請檢查格式。");
      setErrorMessage(message);
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  };

  const minCustomDate = selectedBounds ? toDateInputValue(selectedBounds.minDate) : "";
  const maxCustomDate = selectedBounds ? toDateInputValue(selectedBounds.maxDate) : "";

  const onCustomStartChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const nextStart = event.target.value;
    setCustomStart(nextStart);
    if (customEnd && nextStart && nextStart > customEnd) {
      setCustomEnd(nextStart);
    }
  };

  const onCustomEndChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const nextEnd = event.target.value;
    setCustomEnd(nextEnd);
    if (customStart && nextEnd && nextEnd < customStart) {
      setCustomStart(nextEnd);
    }
  };

  const openCreateTransaction = (): void => {
    if (entities.length === 0) {
      setTransactionError(t("Please create/import a portfolio first.", "請先建立或匯入投資組合。"));
      return;
    }

    const fallbackPortfolio =
      selectedPortfolioId === "all"
        ? entities[0]
        : entities.find((entity) => entity.id === selectedPortfolioId) ?? entities[0];

    setEditingTransaction(null);
    setDraft(buildDefaultDraft(fallbackPortfolio.id, fallbackPortfolio.currency));
    setTransactionError("");
    setPendingCashReview(null);
    setPendingCashAmount("");
    setTxModalOpen(true);
  };

  const openEditTransaction = (row: TransactionRow): void => {
    setEditingTransaction(row);
    setDraft({
      id: row.id,
      portfolioId: row.portfolioId,
      date: toDateInputValue(row.date),
      type: row.type,
      symbol: row.symbol,
      shares: String(row.shares),
      price: String(row.price),
      fee: String(row.fee),
      currency: row.currency,
      note: row.note ?? "",
    });
    setTransactionError("");
    setPendingCashReview(null);
    setPendingCashAmount("");
    setTxModalOpen(true);
  };

  const closeCashReviewModal = (): void => {
    setPendingCashReview(null);
    setPendingCashAmount("");
  };

  const closeTransactionModal = (): void => {
    setTxModalOpen(false);
    setEditingTransaction(null);
    setTransactionError("");
    closeCashReviewModal();
  };

  const applyTransactionWithCashAdjustment = (
    portfolioId: string,
    transaction: NormalizedTransaction,
    editingTransactionId: string | null,
    cashTopUpAmount: number,
    cashTopUpCurrency: string,
  ): void => {
    const normalizedTopUp = Math.max(0, cashTopUpAmount);
    const autoCashTopUp: NormalizedTransaction | null =
      normalizedTopUp > 0.0001
        ? {
            id: `tx-auto-cash-${Date.now()}`,
            date: new Date(transaction.date),
            type: "CASH",
            symbol: cashTopUpCurrency,
            shares: normalizedTopUp,
            price: 1,
            fee: 0,
            currency: cashTopUpCurrency,
            note: t(
              "Manual cash adjustment before BUY due to insufficient balance.",
              "買入前因餘額不足手動補入現金。",
            ),
          }
        : null;

    setEntities((previous) => {
      return previous.map((entity) => {
        const withoutOriginal = editingTransactionId
          ? entity.transactions.filter((tx) => tx.id !== editingTransactionId)
          : entity.transactions;

        const nextTransactions =
          entity.id === portfolioId
            ? sortTransactionsByDateAsc([
                ...withoutOriginal,
                ...(autoCashTopUp ? [autoCashTopUp] : []),
                transaction,
              ])
            : withoutOriginal;

        return {
          ...entity,
          transactions: nextTransactions,
          latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
        };
      });
    });

    closeTransactionModal();
  };

  const confirmPendingCashReview = (): void => {
    if (!pendingCashReview) {
      return;
    }
    const userInputAmount = parseNumberish(pendingCashAmount);
    const adjustedCashAmount = Math.max(0, Math.min(pendingCashReview.shortfall, userInputAmount));
    applyTransactionWithCashAdjustment(
      pendingCashReview.portfolioId,
      pendingCashReview.transaction,
      pendingCashReview.editingTransactionId,
      adjustedCashAmount,
      pendingCashReview.currency,
    );
  };

  const saveTransaction = (): void => {
    const targetPortfolio = entities.find((entity) => entity.id === draft.portfolioId);
    if (!targetPortfolio) {
      setTransactionError(t("Please select a portfolio.", "請先選擇投資組合。"));
      return;
    }

    const parsedDate = parseDateInput(draft.date);
    if (!parsedDate) {
      setTransactionError(t("Invalid date.", "日期格式錯誤。"));
      return;
    }

    const currency = draft.currency.trim().toUpperCase();
    if (!currency) {
      setTransactionError(t("Currency is required.", "請輸入貨幣。"));
      return;
    }

    let symbol = draft.symbol.trim().toUpperCase();
    if (shouldUseCurrencyAsSymbol(draft.type) && !symbol) {
      symbol = currency;
    }

    if (!symbol) {
      setTransactionError(t("Symbol is required.", "請輸入股票代號。"));
      return;
    }

    const transaction: NormalizedTransaction = {
      id: draft.id || `tx-${Date.now()}`,
      date: parsedDate,
      type: draft.type,
      symbol,
      shares: parseNumberish(draft.shares),
      price: parseNumberish(draft.price),
      fee: parseNumberish(draft.fee),
      currency,
      note: draft.note.trim(),
    };

    const editingTransactionId = editingTransaction?.id ?? null;
    const baseTransactions = editingTransactionId
      ? targetPortfolio.transactions.filter((tx) => tx.id !== editingTransactionId)
      : targetPortfolio.transactions;

    if (transaction.type === "BUY") {
      const cashBalances = calculateCashBalances([{ ...targetPortfolio, transactions: baseTransactions }]);
      const cashBalance = cashBalances.find((item) => item.currency === currency)?.balance ?? 0;
      const requiredCash = transaction.shares * transaction.price + transaction.fee;
      const shortfall = Math.max(0, requiredCash - cashBalance);

      if (shortfall > 0.0001) {
        setPendingCashReview({
          portfolioId: targetPortfolio.id,
          transaction,
          currency,
          cashBalance,
          shortfall,
          editingTransactionId,
        });
        setPendingCashAmount(shortfall.toFixed(2));
        return;
      }
    }

    applyTransactionWithCashAdjustment(
      targetPortfolio.id,
      transaction,
      editingTransactionId,
      0,
      currency,
    );
  };

  const deleteTransaction = (row: TransactionRow): void => {
    const shouldDelete = window.confirm(
      t(`Delete ${row.type} ${row.symbol} transaction?`, `刪除 ${row.symbol} 的 ${row.type} 交易？`),
    );
    if (!shouldDelete) {
      return;
    }

    setEntities((previous) =>
      previous.map((entity) => {
        if (entity.id !== row.portfolioId) {
          return entity;
        }
        const nextTransactions = entity.transactions.filter((tx) => tx.id !== row.id);
        return {
          ...entity,
          transactions: nextTransactions,
          latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
        };
      }),
    );
  };

  const createPortfolio = (): void => {
    const name = window.prompt(t("Portfolio name", "投資組合名稱"));
    if (!name || !name.trim()) {
      return;
    }

    const currencyInput =
      window.prompt(t("Display currency (e.g. USD)", "顯示貨幣（例如 USD）"), settings.defaultCurrency) ??
      settings.defaultCurrency;
    const currency = currencyInput.trim().toUpperCase() || "USD";
    const id = `portfolio-${Date.now()}`;

    setEntities((previous) => [
      ...previous,
      {
        id,
        name: name.trim(),
        currency,
        transactions: [],
        latestPriceBySymbol: {},
      },
    ]);
    setSelectedPortfolioId(id);
  };

  const renamePortfolio = (): void => {
    if (selectedPortfolioId === "all") {
      return;
    }

    const target = entities.find((entity) => entity.id === selectedPortfolioId);
    if (!target) {
      return;
    }

    const nextName = window.prompt(t("New portfolio name", "新的組合名稱"), target.name);
    if (!nextName || !nextName.trim()) {
      return;
    }

    setEntities((previous) =>
      previous.map((entity) =>
        entity.id === selectedPortfolioId
          ? {
              ...entity,
              name: nextName.trim(),
            }
          : entity,
      ),
    );
  };

  const deletePortfolio = (): void => {
    if (selectedPortfolioId === "all") {
      return;
    }

    const target = entities.find((entity) => entity.id === selectedPortfolioId);
    if (!target) {
      return;
    }

    const shouldDelete = window.confirm(
      t(`Delete portfolio \"${target.name}\"?`, `刪除投資組合「${target.name}」？`),
    );
    if (!shouldDelete) {
      return;
    }

    setEntities((previous) => previous.filter((entity) => entity.id !== selectedPortfolioId));
    setSelectedPortfolioId("all");
  };

  const exportWebJson = (): void => {
    const payload = serializeEntities(entities);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `stocker-web-export-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const clearAllData = (): void => {
    const shouldClear = window.confirm(t("Clear all local data?", "清除全部本地資料？"));
    if (!shouldClear) {
      return;
    }

    setEntities([]);
    setSelectedPortfolioId("all");
    setSelectedStockId("");
    setScreen("choose");
    localStorage.removeItem(STORAGE_KEY);
  };

  const updateSetting = <K extends keyof WebSettings>(
    key: K,
    value: WebSettings[K],
  ): void => {
    setSettings((previous) => ({
      ...previous,
      [key]: value,
    }));
  };

  const resetSettings = (): void => {
    setSettings(DEFAULT_SETTINGS);
    setDataImportType(DEFAULT_SETTINGS.defaultImportType);
  };

  const changeTab = (tab: DashboardTab): void => {
    setActiveTab(tab);
    setMenuOpen(false);
  };

  return (
    <div
      className={`app-shell ${settings.enableAnimations ? "" : "reduced-motion"} ${tableDensityClass}`.trim()}
    >
      <header className="top-header">
        <div className="brand">Stocker Web</div>
        <button
          type="button"
          className="secondary-btn lang-btn"
          onClick={() => updateSetting("language", settings.language === "zh-HK" ? "en" : "zh-HK")}
        >
          {settings.language === "zh-HK" ? "English" : "繁中"}
        </button>
        <nav className={`header-nav ${menuOpen ? "open" : ""}`}>
          <button
            type="button"
            className={activeTab === "dashboard" ? "active" : ""}
            onClick={() => changeTab("dashboard")}
          >
            {t("Dashboard", "儀表板")}
          </button>
          <button
            type="button"
            className={activeTab === "analysis" ? "active" : ""}
            onClick={() => changeTab("analysis")}
          >
            {t("Analysis", "分析")}
          </button>
          <button
            type="button"
            className={activeTab === "holdings" ? "active" : ""}
            onClick={() => changeTab("holdings")}
          >
            {t("Holdings", "持倉")}
          </button>
          <button
            type="button"
            className={activeTab === "transactions" ? "active" : ""}
            onClick={() => changeTab("transactions")}
          >
            {t("Transactions", "交易")}
          </button>
          <button
            type="button"
            className={activeTab === "data" ? "active" : ""}
            onClick={() => changeTab("data")}
          >
            {t("Data", "資料")}
          </button>
          <button
            type="button"
            className={activeTab === "settings" ? "active" : ""}
            onClick={() => changeTab("settings")}
          >
            {t("Settings", "設定")}
          </button>
        </nav>
        <button
          className="menu-btn"
          type="button"
          aria-label={t("Open menu", "開啟選單")}
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      {screen === "choose" && (
        <main className="entry-screen">
          <h1>{t("Select Your Data Type", "選擇你的資料格式")}</h1>
          <p className="entry-subtitle">
            {t("Choose your account type first, then upload your exported file.", "先選擇帳戶類型，再上傳匯出檔案。")}
          </p>
          <div className="entry-cards">
            <button type="button" className="entry-card" onClick={() => void selectUserType("stockerx")}>
              <strong>{t("StockerX User", "StockerX 用戶")}</strong>
              <span>{t("Use StockerX export format", "使用 StockerX 匯出格式")}</span>
            </button>
            <button type="button" className="entry-card" onClick={() => void selectUserType("stockerpro")}>
              <strong>{t("Stocker Pro User", "Stocker Pro 用戶")}</strong>
              <span>{t("Use Stocker Pro export format", "使用 Stocker Pro 匯出格式")}</span>
            </button>
            <button type="button" className="entry-card" onClick={() => void selectUserType("new")}>
              <strong>{t("I Am New", "我是新用戶")}</strong>
              <span>{t("Create an empty Stocker Pro profile", "建立空白 Stocker Pro 資料")}</span>
            </button>
          </div>
        </main>
      )}

      {screen === "upload" && (
        <main className="upload-screen">
          <h1>
            {t("Upload", "上傳")} {userType === "stockerx" ? "StockerX" : "Stocker Pro"} {t("File", "檔案")}
          </h1>
          <p className="entry-subtitle">{t("Supports your exported RTF/JSON test file.", "支援匯出的 RTF/JSON 測試檔。")}</p>
          <label className="upload-box">
            <input type="file" onChange={onFileChange} accept=".rtf,.json,.txt" />
            <span>{loading ? t("Reading file...", "正在讀取檔案...") : t("Choose file", "選擇檔案")}</span>
          </label>
          <button type="button" className="back-link" onClick={() => setScreen("choose")}>
            {t("Back", "返回")}
          </button>
          {errorMessage && <div className="error-text">{errorMessage}</div>}
        </main>
      )}

      {screen === "dashboard" && (
        <main className="dashboard-page" id="dashboard">
          <section className="summary-grid">
            <div className="summary-card">
              <span>{t("Total Assets", "總資產")}</span>
              <strong>{displayMoney(portfolioSummary.totalAssets, portfolioSummary.currency)}</strong>
            </div>
            <div className="summary-card">
              <span>{t("Cash Balance", "現金結餘")}</span>
              <strong>{displayMoney(portfolioSummary.cashBalance, portfolioSummary.currency)}</strong>
            </div>
            <div className={`summary-card ${portfolioSummary.totalProfit >= 0 ? "positive" : "negative"}`}>
              <span>{t("Total Profit", "總盈虧")}</span>
              <strong>{displayMoney(portfolioSummary.totalProfit, portfolioSummary.currency)}</strong>
              <small>{displayPercent(portfolioSummary.totalProfitPct)}</small>
            </div>
            <div className={`summary-card ${portfolioSummary.dailyProfit >= 0 ? "positive" : "negative"}`}>
              <span>{t("Daily Profit", "今日盈虧")}</span>
              <strong>{displayMoney(portfolioSummary.dailyProfit, portfolioSummary.currency)}</strong>
              <small>{displayPercent(portfolioSummary.dailyProfitPct)}</small>
            </div>
          </section>

          {activeTab === "dashboard" && (
            <section className="dashboard-grid">
              <section className="chart-panel">
                {selectedStock ? (
                  <>
                    <div className="panel-head">
                      <div>
                        <p className="panel-label">{selectedStock.currency}</p>
                        <h2>
                          {selectedStock.symbol} - {rangeTitle(selectedRange)} {t("Profit / Loss", "盈虧")}
                        </h2>
                      </div>
                      <div className={`metric-badge ${rangeProfit >= 0 ? "positive" : "negative"}`}>
                        <strong>{displayMoney(rangeProfit, selectedStock.currency)}</strong>
                        <span>{displayPercent(rangeProfitPct)}</span>
                      </div>
                    </div>

                    <div className="portfolio-switcher-wrap">
                      <div className="portfolio-switcher-title">{t("Portfolio Filter", "組合篩選")}</div>
                      <div className="portfolio-switcher">
                        <button
                          type="button"
                          className={`portfolio-pill ${selectedPortfolioId === "all" ? "active" : ""}`}
                          onClick={() => setSelectedPortfolioId("all")}
                        >
                          {t("All", "全部")}
                        </button>
                        {entities.map((entity) => (
                          <button
                            type="button"
                            key={entity.id}
                            className={`portfolio-pill ${selectedPortfolioId === entity.id ? "active" : ""}`}
                            onClick={() => setSelectedPortfolioId(entity.id)}
                          >
                            {entity.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="time-range-wrap">
                      <div className="portfolio-switcher-title">{t("P/L Time Range", "盈虧時間範圍")}</div>
                      <div className="portfolio-switcher">
                        {TIME_RANGE_OPTIONS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={`portfolio-pill ${selectedRange === option.value ? "active" : ""}`}
                            onClick={() => setSelectedRange(option.value)}
                          >
                            {isZh && option.value === "ALL"
                              ? "全部"
                              : isZh && option.value === "CUSTOM"
                                ? "自選"
                                : option.label}
                          </button>
                        ))}
                      </div>
                      {selectedRange === "CUSTOM" && (
                        <div className="custom-range-inputs">
                          <label>
                            <span>{t("From", "由")}</span>
                            <input
                              type="date"
                              value={customStart}
                              min={minCustomDate}
                              max={customEnd || maxCustomDate}
                              onChange={onCustomStartChange}
                            />
                          </label>
                          <label>
                            <span>{t("To", "至")}</span>
                            <input
                              type="date"
                              value={customEnd}
                              min={customStart || minCustomDate}
                              max={maxCustomDate}
                              onChange={onCustomEndChange}
                            />
                          </label>
                        </div>
                      )}
                    </div>

                    <AreaChart points={selectedSeries} label={`${selectedStock.symbol} profit chart`} />

                    <div className="portfolio-distribution-wrap">
                      <PieChart
                        segments={stockDistribution}
                        title={t("Stock Distribution", "股票分佈")}
                        itemLabel={t("Stock", "股票")}
                        valueLabel={t("Value", "金額")}
                        weightLabel={t("Weight", "比例")}
                        valueFormatter={formatPieMoneyValue}
                      />
                      <div className="sub-distribution-grid">
                        <PieChart
                          segments={stockCountryDistribution}
                          title={t("Country Distribution", "國家分佈")}
                          itemLabel={t("Country", "國家")}
                          valueLabel={t("Value", "金額")}
                          weightLabel={t("Weight", "比例")}
                          valueFormatter={formatPieMoneyValue}
                        />
                        <PieChart
                          segments={stockCategoryDistribution}
                          title={t("Category Distribution", "種類分佈")}
                          itemLabel={t("Category", "種類")}
                          valueLabel={t("Value", "金額")}
                          weightLabel={t("Weight", "比例")}
                          valueFormatter={formatPieMoneyValue}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="chart-empty">
                    <span>{t("No stock data yet. Import a file to see stock performance.", "暫時未有股票資料，請先匯入檔案。")}</span>
                  </div>
                )}
              </section>

              <section className="performance-panel" id="performance">
                <div className="panel-head slim">
                  <h3>
                    {selectedPortfolioId === "all"
                      ? t("All Stocks", "全部股票")
                      : `${filteredEntities[0]?.name ?? t("Portfolio", "組合")} ${t("Stocks", "股票")}`}
                  </h3>
                </div>
                <div className="performance-list">
                  {stockLeaderboard.length === 0 && (
                    <div className="chart-empty">
                      <span>{t("No stocks found.", "找不到股票資料。")}</span>
                    </div>
                  )}
                  {stockLeaderboard.map((item, index) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`performance-row ${item.id === selectedStock?.id ? "active" : ""}`}
                      onClick={() => setSelectedStockId(item.id)}
                      onDoubleClick={() => setSelectedStockDetailId(item.id)}
                    >
                      <div className="row-left">
                        <span className="avatar">{index + 1}</span>
                        <div className="row-title">
                          <strong>{item.symbol}</strong>
                          <small>
                            {item.currency} | {t("Shares", "股數")}: {item.activeShares}
                          </small>
                        </div>
                      </div>
                      <div className={`row-right ${item.totalProfit >= 0 ? "positive" : "negative"}`}>
                        <strong>{displayMoney(item.totalProfit, item.currency)}</strong>
                        <small>{displayPercent(item.totalProfitPct)}</small>
                      </div>
                    </button>
                  ))}
                </div>
                {selectedStock && (
                  <div className="performance-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => setSelectedStockDetailId(selectedStock.id)}
                    >
                      {t("Open", "開啟")} {selectedStock.symbol} {t("Detail", "詳情")}
                    </button>
                  </div>
                )}
              </section>
            </section>
          )}

          {activeTab === "analysis" && (
            <section className="analysis-grid" id="analysis">
              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Portfolio Insights", "組合洞察")}</h3>
                </div>
                <div className="insight-grid">
                  <div className="insight-card">
                    <span>{t("Open Positions", "未平倉")}</span>
                    <strong>{insights.openPositions}</strong>
                  </div>
                  <div className="insight-card">
                    <span>{t("Closed Positions", "已平倉")}</span>
                    <strong>{insights.closedPositions}</strong>
                  </div>
                  <div className="insight-card">
                    <span>{t("Win Rate", "勝率")}</span>
                    <strong>{displayPercent(insights.winRate)}</strong>
                  </div>
                  <div className="insight-card">
                    <span>{t("Avg Profit / Stock", "每股平均盈虧")}</span>
                    <strong>{displayMoney(insights.avgProfitPerStock, portfolioSummary.currency)}</strong>
                  </div>
                  <div className="insight-card">
                    <span>{t("Best Performer", "最佳表現")}</span>
                    <strong>{insights.bestPerformer}</strong>
                  </div>
                  <div className="insight-card">
                    <span>{t("Worst Performer", "最差表現")}</span>
                    <strong>{insights.worstPerformer}</strong>
                  </div>
                  <div className="insight-card">
                    <span>{t("Max Drawdown", "最大回撤")}</span>
                    <strong className="negative">{displayPercent(-insights.maxDrawdownPct)}</strong>
                  </div>
                </div>
              </section>

              <section className="dual-column-grid">
                <PieChart
                  segments={visibleAssetAllocation}
                  title={t("Asset Allocation", "資產配置")}
                  itemLabel={t("Asset", "資產")}
                  valueLabel={t("Value", "金額")}
                  weightLabel={t("Weight", "比例")}
                  valueFormatter={formatPieMoneyValue}
                />
                <PieChart
                  segments={currencyExposure}
                  title={t("Currency Exposure", "貨幣曝險")}
                  itemLabel={t("Currency", "貨幣")}
                  valueLabel={t("Value", "金額")}
                  weightLabel={t("Weight", "比例")}
                  valueFormatter={formatPieMoneyValue}
                />
              </section>

              <section className="dual-column-grid">
                <BarChart
                  data={monthlyDividendSeries.slice(-12)}
                  title={t("Monthly Dividends (12M)", "每月股息（12個月）")}
                  positiveColor="#1f9a72"
                />
                <BarChart
                  data={monthlyCashFlowSeries.slice(-12)}
                  title={t("Monthly Cash Flow (12M)", "每月現金流（12個月）")}
                  positiveColor="#2f7dd6"
                  negativeColor="#c84f4f"
                />
              </section>

              <section className="dual-column-grid">
                <BarChart
                  data={monthlyTxCountSeries.slice(-12)}
                  title={t("Monthly Transactions (12M)", "每月交易次數（12個月）")}
                />
                <BarChart data={txTypeSeries} title={t("Transaction Type Distribution", "交易類型分佈")} />
              </section>

              <section className="table-panel">
                <MultiLineChart
                  series={compareSeries}
                  title={t("Top Stock Comparison (Indexed = 100)", "主要股票比較（基準=100）")}
                />
              </section>

              <section className="table-panel">
                <AreaChart points={portfolioProfitSeries} label={t("Portfolio profit chart", "組合盈虧圖")} />
              </section>

              <section className="dual-column-grid">
                <BarChart
                  data={drawdownSeries.slice(-20)}
                  title={t("Drawdown %", "回撤百分比")}
                  positiveColor="#4f8fd9"
                  negativeColor="#c84f4f"
                />
                <BarChart
                  data={dividendCalendarSeries}
                  title={t("Dividend Seasonality (By Month)", "股息季節性（按月份）")}
                  positiveColor="#1f9a72"
                />
              </section>

              <section className="table-panel">
                <HeatmapGrid
                  data={transactionHeatmap}
                  title={t("Transaction Activity Heatmap (12M x Type)", "交易活躍熱力圖（12個月 x 類型）")}
                />
              </section>

              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Rebalance Suggestions (Equal Weight Baseline)", "再平衡建議（等權重基準）")}</h3>
                </div>
                <div className="table-scroll">
                  <table className="data-table rebalance-table">
                    <thead>
                      <tr>
                        <th>{t("Symbol", "代號")}</th>
                        <th>{t("Current Weight", "目前權重")}</th>
                        <th>{t("Target Weight", "目標權重")}</th>
                        <th>{t("Diff %", "差異%")}</th>
                        <th>{t("Suggested Trade Value", "建議調整金額")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rebalanceSuggestions.map((item) => (
                        <tr key={item.symbol}>
                          <td>{item.symbol}</td>
                          <td>{displayPercent(item.currentWeightPct)}</td>
                          <td>{displayPercent(item.targetWeightPct)}</td>
                          <td className={item.diffPct >= 0 ? "negative" : "positive"}>
                            {displayPercent(item.diffPct)}
                          </td>
                          <td className={item.diffValue >= 0 ? "negative" : "positive"}>
                            {item.diffValue >= 0 ? t("Reduce ", "減持 ") : t("Add ", "增持 ")}
                            {displayMoney(Math.abs(item.diffValue), item.currency)}
                          </td>
                        </tr>
                      ))}
                      {rebalanceSuggestions.length === 0 && (
                        <tr>
                          <td colSpan={5} className="empty-cell">
                            {t("No rebalance signals.", "暫無再平衡訊號。")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Portfolio Goal Simulator", "資產目標模擬器")}</h3>
                </div>
                <div className="goal-sim-grid">
                  <label>
                    {t("Target Asset", "目標資產")}
                    <input
                      value={goalTarget}
                      onChange={(event) => setGoalTarget(event.target.value)}
                    />
                  </label>
                  <label>
                    {t("Monthly Contribution", "每月供款")}
                    <input
                      value={goalMonthlyContribution}
                      onChange={(event) => setGoalMonthlyContribution(event.target.value)}
                    />
                  </label>
                  <label>
                    {t("Expected Return % (Annual)", "預期年回報率%")}
                    <input
                      value={goalReturnPct}
                      onChange={(event) => setGoalReturnPct(event.target.value)}
                    />
                  </label>
                  <div className="goal-result">
                    {goalYears === null ? (
                      <strong>{t("Cannot reach target with current settings", "以目前設定未能達標")}</strong>
                    ) : (
                      <strong>
                        {t("Estimated time:", "預計時間：")} {goalYears} {t("years", "年")}
                      </strong>
                    )}
                  </div>
                </div>
              </section>
            </section>
          )}

          {activeTab === "holdings" && (
            <section className="dual-column-grid" id="holdings">
              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Holding Stocks", "持倉股票")} ({displayedHoldingStocks.length})</h3>
                </div>
                <div className="filters-row">
                  <label>
                    {t("Search", "搜尋")}
                    <input
                      value={holdingSearch}
                      onChange={(event) => setHoldingSearch(event.target.value)}
                      placeholder={t("Symbol", "股票代號")}
                    />
                  </label>
                  <label>
                    {t("Sort By", "排序方式")}
                    <select
                      value={holdingSort}
                      onChange={(event) =>
                        setHoldingSort(event.target.value as "marketValue" | "profit" | "symbol")
                      }
                    >
                      <option value="marketValue">{t("Market Value", "市值")}</option>
                      <option value="profit">{t("Total Profit", "總盈虧")}</option>
                      <option value="symbol">{t("Symbol", "代號")}</option>
                    </select>
                  </label>
                </div>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t("Symbol", "代號")}</th>
                        <th>{t("Shares", "股數")}</th>
                        <th>{t("Market Value", "市值")}</th>
                        <th>{t("Total P/L", "總盈虧")}</th>
                        <th>{t("Holding P/L", "持倉盈虧")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedHoldingStocks.map((item) => (
                        <tr key={item.id}>
                          <td>{item.symbol}</td>
                          <td>{item.activeShares.toFixed(4)}</td>
                          <td>{displayMoney(item.marketValue, item.currency)}</td>
                          <td className={item.totalProfit >= 0 ? "positive" : "negative"}>
                            {displayMoney(item.totalProfit, item.currency)}
                          </td>
                          <td className={item.holdingProfit >= 0 ? "positive" : "negative"}>
                            {displayMoney(item.holdingProfit, item.currency)}
                          </td>
                        </tr>
                      ))}
                      {displayedHoldingStocks.length === 0 && (
                        <tr>
                          <td colSpan={5} className="empty-cell">
                            {t("No holding stocks.", "沒有持倉股票。")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Closed Stocks", "已平倉股票")} ({displayedClosedStocks.length})</h3>
                </div>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>{t("Symbol", "代號")}</th>
                        <th>{t("Realized P/L", "已實現盈虧")}</th>
                        <th>{t("Dividend", "股息")}</th>
                        <th>{t("Fee", "費用")}</th>
                        <th>{t("Transactions", "交易筆數")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayedClosedStocks.map((item) => (
                        <tr key={item.id}>
                          <td>{item.symbol}</td>
                          <td className={item.realizedProfit >= 0 ? "positive" : "negative"}>
                            {displayMoney(item.realizedProfit, item.currency)}
                          </td>
                          <td>{displayMoney(item.totalDividend, item.currency)}</td>
                          <td>{displayMoney(item.totalFee, item.currency)}</td>
                          <td>{item.transactionCount}</td>
                        </tr>
                      ))}
                      {displayedClosedStocks.length === 0 && (
                        <tr>
                          <td colSpan={5} className="empty-cell">
                            {t("No closed stocks.", "沒有已平倉股票。")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </section>
          )}

          {activeTab === "transactions" && (
            <section className="table-panel" id="transactions">
              <div className="panel-head slim">
                <h3>{t("Transactions", "交易紀錄")}</h3>
                <button type="button" className="primary-btn" onClick={openCreateTransaction}>
                  {t("Add Transaction", "新增交易")}
                </button>
              </div>

              <div className="filters-row">
                <label>
                  {t("Search", "搜尋")}
                  <input
                    value={txKeyword}
                    onChange={(event) => setTxKeyword(event.target.value)}
                    placeholder={t("Symbol / portfolio / note", "代號 / 組合 / 備註")}
                  />
                </label>
                <label>
                  {t("Date Range", "日期範圍")}
                  <select
                    value={txDateFilter}
                    onChange={(event) => setTxDateFilter(event.target.value as DateFilterPreset)}
                  >
                    {DATE_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {dateFilterLabel(option.value, option.label)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  {t("Type", "類型")}
                  <select
                    value={txTypeFilter}
                    onChange={(event) => setTxTypeFilter(event.target.value as TransactionTypeFilter)}
                  >
                    {TRANSACTION_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                {txDateFilter === "custom" && (
                  <>
                    <label>
                      {t("From", "由")}
                      <input
                        type="date"
                        value={txCustomStart}
                        onChange={(event) => setTxCustomStart(event.target.value)}
                      />
                    </label>
                    <label>
                      {t("To", "至")}
                      <input
                        type="date"
                        value={txCustomEnd}
                        onChange={(event) => setTxCustomEnd(event.target.value)}
                      />
                    </label>
                  </>
                )}

                <div className="filter-stats">
                  <span>{t("Count", "筆數")}: {filteredTransactions.length}</span>
                  <span>{t("Net", "淨額")}: {displayMoney(transactionNetValue, filteredEntities[0]?.currency ?? "USD")}</span>
                </div>
              </div>

              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t("Date", "日期")}</th>
                      <th>{t("Portfolio", "組合")}</th>
                      <th>{t("Type", "類型")}</th>
                      <th>{t("Symbol", "代號")}</th>
                      <th>{t("Shares", "股數")}</th>
                      <th>{t("Price", "價格")}</th>
                      <th>{t("Fee", "費用")}</th>
                      <th>{t("Net", "淨額")}</th>
                      <th>{t("Actions", "操作")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTransactions.map((row) => (
                      <tr key={`${row.portfolioId}-${row.id}`}>
                        <td>{row.date.toLocaleDateString(localeTag)}</td>
                        <td>{row.portfolioName}</td>
                        <td>{row.type}</td>
                        <td>{row.symbol}</td>
                        <td>{row.shares.toFixed(4)}</td>
                        <td>{displayMoney(row.price, row.currency)}</td>
                        <td>{displayMoney(row.fee, row.currency)}</td>
                        <td className={getTransactionNetCashFlow(row) >= 0 ? "positive" : "negative"}>
                          {displayMoney(getTransactionNetCashFlow(row), row.currency)}
                        </td>
                        <td>
                          <div className="action-btn-row">
                            <button
                              type="button"
                              className="text-btn"
                              onClick={() => openEditTransaction(row)}
                            >
                              {t("Edit", "編輯")}
                            </button>
                            <button
                              type="button"
                              className="text-btn danger"
                              onClick={() => deleteTransaction(row)}
                            >
                              {t("Delete", "刪除")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredTransactions.length === 0 && (
                      <tr>
                        <td colSpan={9} className="empty-cell">
                          {t("No transactions.", "沒有交易紀錄。")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === "data" && (
            <section className="dual-column-grid" id="data">
              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Portfolio Management", "投資組合管理")}</h3>
                </div>
                <div className="data-tools">
                  <button type="button" className="primary-btn" onClick={createPortfolio}>
                    {t("New Portfolio", "新增組合")}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={renamePortfolio}
                    disabled={selectedPortfolioId === "all"}
                  >
                    {t("Rename Selected", "重新命名已選組合")}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn danger"
                    onClick={deletePortfolio}
                    disabled={selectedPortfolioId === "all"}
                  >
                    {t("Delete Selected", "刪除已選組合")}
                  </button>
                </div>

                <div className="portfolio-switcher-wrap">
                  <div className="portfolio-switcher-title">{t("Select Portfolio", "選擇組合")}</div>
                  <div className="portfolio-switcher">
                    <button
                      type="button"
                      className={`portfolio-pill ${selectedPortfolioId === "all" ? "active" : ""}`}
                      onClick={() => setSelectedPortfolioId("all")}
                    >
                      {t("All", "全部")}
                    </button>
                    {entities.map((entity) => (
                      <button
                        type="button"
                        key={entity.id}
                        className={`portfolio-pill ${selectedPortfolioId === entity.id ? "active" : ""}`}
                        onClick={() => setSelectedPortfolioId(entity.id)}
                      >
                        {entity.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cash-balance-list">
                  <h4>{t("Cash Balances", "現金結餘")}</h4>
                  {cashBalances.length === 0 && <p>{t("No cash balances.", "沒有現金結餘。")}</p>}
                  {cashBalances.map((item) => (
                    <div key={item.currency} className="cash-balance-row">
                      <span>{item.currency}</span>
                      <strong className={item.balance >= 0 ? "positive" : "negative"}>
                        {displayMoney(item.balance, item.currency)}
                      </strong>
                    </div>
                  ))}
                </div>
              </section>

              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Import / Export", "匯入 / 匯出")}</h3>
                </div>

                <div className="data-tools">
                  <label>
                    {t("Import Type", "匯入類型")}
                    <select
                      value={dataImportType}
                      onChange={(event) => {
                        const nextType = event.target.value as UserType;
                        setDataImportType(nextType);
                        updateSetting("defaultImportType", nextType);
                      }}
                    >
                      <option value="stockerx">StockerX</option>
                      <option value="stockerpro">Stocker Pro</option>
                    </select>
                  </label>
                  <label className="upload-box compact">
                    <input
                      type="file"
                      onChange={onDataImportFileChange}
                      accept=".rtf,.json,.txt"
                    />
                    <span>{loading ? t("Importing...", "正在匯入...") : t("Import and Replace Data", "匯入並覆蓋資料")}</span>
                  </label>

                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={exportWebJson}
                    disabled={entities.length === 0}
                  >
                    {t("Export Web JSON", "匯出 Web JSON")}
                  </button>

                  <button type="button" className="secondary-btn" onClick={() => setScreen("choose")}>
                    {t("Re-open Entry Setup", "重新打開入口設定")}
                  </button>

                  <button
                    type="button"
                    className="secondary-btn danger"
                    onClick={clearAllData}
                    disabled={entities.length === 0}
                  >
                    {t("Clear All Data", "清除全部資料")}
                  </button>
                </div>

                {errorMessage && <div className="error-text">{errorMessage}</div>}
              </section>
            </section>
          )}

          {activeTab === "settings" && (
            <section className="settings-grid" id="settings">
              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Display Settings", "顯示設定")}</h3>
                </div>
                <div className="settings-list">
                  <label className="setting-row">
                    <div>
                      <strong>{t("Privacy Mode", "隱私模式")}</strong>
                      <p>{t("Hide amount and percentage numbers on screen.", "隱藏畫面上的金額與百分比。")}</p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.showObscure}
                      onChange={(event) => updateSetting("showObscure", event.target.checked)}
                    />
                  </label>
                  <label className="setting-row">
                    <div>
                      <strong>{t("Enable Animations", "啟用動畫")}</strong>
                      <p>{t("Turn transitions and entrance animations on or off.", "開啟或關閉過場與入場動畫。")}</p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.enableAnimations}
                      onChange={(event) => updateSetting("enableAnimations", event.target.checked)}
                    />
                  </label>
                  <label className="setting-row">
                    <div>
                      <strong>{t("Compact Tables", "緊湊表格")}</strong>
                      <p>{t("Use denser rows to display more records in each table.", "用更緊密行距顯示更多資料。")}</p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.compactTables}
                      onChange={(event) => updateSetting("compactTables", event.target.checked)}
                    />
                  </label>
                  <label className="setting-row">
                    <div>
                      <strong>{t("Include Cash in Allocation", "配置中包含現金")}</strong>
                      <p>{t("Show cash as a separate asset slice in allocation chart.", "在資產配置圖中把現金獨立顯示。")}</p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.showCashInAllocation}
                      onChange={(event) =>
                        updateSetting("showCashInAllocation", event.target.checked)
                      }
                    />
                  </label>
                </div>
              </section>

              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>{t("Defaults", "預設值")}</h3>
                </div>
                <div className="settings-form">
                  <label>
                    {t("Language", "語言")}
                    <select
                      value={settings.language}
                      onChange={(event) => updateSetting("language", event.target.value as Locale)}
                    >
                      <option value="zh-HK">繁體中文</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                  <label>
                    {t("Default Currency", "預設貨幣")}
                    <input
                      value={settings.defaultCurrency}
                      onChange={(event) =>
                        updateSetting("defaultCurrency", event.target.value.toUpperCase())
                      }
                      placeholder="USD"
                      maxLength={6}
                    />
                  </label>
                  <label>
                    {t("Default Import Type", "預設匯入類型")}
                    <select
                      value={settings.defaultImportType}
                      onChange={(event) => {
                        const nextType = event.target.value as UserType;
                        updateSetting("defaultImportType", nextType);
                        setDataImportType(nextType);
                      }}
                    >
                      <option value="stockerx">StockerX</option>
                      <option value="stockerpro">Stocker Pro</option>
                    </select>
                  </label>
                </div>
                <p className="settings-hint">
                  {t(
                    "These defaults are saved in your browser only. Firebase is not connected yet.",
                    "以上預設只會儲存在瀏覽器，本版本尚未連接 Firebase。",
                  )}
                </p>
                <div className="settings-actions">
                  <button type="button" className="secondary-btn" onClick={resetSettings}>
                    {t("Reset To Default", "重設為預設")}
                  </button>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={exportWebJson}
                    disabled={entities.length === 0}
                  >
                    {t("Export Backup JSON", "匯出備份 JSON")}
                  </button>
                </div>
              </section>
            </section>
          )}
        </main>
      )}

      {stockDetail && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelectedStockDetailId(null)}>
          <div
            className="modal-card stock-detail-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="stock-detail-head">
              <h3>
                {stockDetail.symbol} {t("Detail", "詳情")}
              </h3>
              <button type="button" className="secondary-btn" onClick={() => setSelectedStockDetailId(null)}>
                {t("Close", "關閉")}
              </button>
            </div>

            <div className="stock-detail-metrics">
              <div>
                <span>{t("Current Shares", "目前股數")}</span>
                <strong>{stockDetail.activeShares.toFixed(4)}</strong>
              </div>
              <div>
                <span>{t("Market Value", "市值")}</span>
                <strong>{displayMoney(stockDetail.marketValue, stockDetail.currency)}</strong>
              </div>
              <div>
                <span>{t("Total P/L", "總盈虧")}</span>
                <strong className={stockDetail.totalProfit >= 0 ? "positive" : "negative"}>
                  {displayMoney(stockDetail.totalProfit, stockDetail.currency)}
                </strong>
              </div>
              <div>
                <span>{t("Realized P/L", "已實現盈虧")}</span>
                <strong className={stockDetail.realizedProfit >= 0 ? "positive" : "negative"}>
                  {displayMoney(stockDetail.realizedProfit, stockDetail.currency)}
                </strong>
              </div>
              <div>
                <span>{t("Dividend", "股息")}</span>
                <strong>{displayMoney(stockDetail.totalDividend, stockDetail.currency)}</strong>
              </div>
              <div>
                <span>{t("Total Fee", "總費用")}</span>
                <strong>{displayMoney(stockDetail.totalFee, stockDetail.currency)}</strong>
              </div>
            </div>

            <AreaChart points={stockDetailSeries} label={`${stockDetail.symbol} detail chart`} />

            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Date", "日期")}</th>
                    <th>{t("Type", "類型")}</th>
                    <th>{t("Shares", "股數")}</th>
                    <th>{t("Price", "價格")}</th>
                    <th>{t("Fee", "費用")}</th>
                    <th>{t("Net", "淨額")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stockDetailTransactions.map((row) => (
                    <tr key={`${row.portfolioId}-${row.id}`}>
                      <td>{row.date.toLocaleDateString(localeTag)}</td>
                      <td>{row.type}</td>
                      <td>{row.shares.toFixed(4)}</td>
                      <td>{displayMoney(row.price, row.currency)}</td>
                      <td>{displayMoney(row.fee, row.currency)}</td>
                      <td className={getTransactionNetCashFlow(row) >= 0 ? "positive" : "negative"}>
                        {displayMoney(getTransactionNetCashFlow(row), row.currency)}
                      </td>
                    </tr>
                  ))}
                  {stockDetailTransactions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty-cell">
                        {t("No transactions.", "沒有交易紀錄。")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {isTxModalOpen && (
        <div className="modal-backdrop" role="presentation" onClick={closeTransactionModal}>
          <div className="modal-card" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>{editingTransaction ? t("Edit Transaction", "編輯交易") : t("Add Transaction", "新增交易")}</h3>

            <div className="form-grid">
              <label>
                {t("Portfolio", "組合")}
                <select
                  value={draft.portfolioId}
                  onChange={(event) => setDraft((prev) => ({ ...prev, portfolioId: event.target.value }))}
                >
                  {entities.map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {entity.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {t("Date", "日期")}
                <input
                  type="date"
                  value={draft.date}
                  onChange={(event) => setDraft((prev) => ({ ...prev, date: event.target.value }))}
                />
              </label>

              <label>
                {t("Type", "類型")}
                <select
                  value={draft.type}
                  onChange={(event) => setDraft((prev) => ({ ...prev, type: event.target.value as TxType }))}
                >
                  {TRANSACTION_TYPE_OPTIONS.filter((item) => item.value !== "all").map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {t("Symbol", "代號")}
                <input
                  value={draft.symbol}
                  onChange={(event) => setDraft((prev) => ({ ...prev, symbol: event.target.value.toUpperCase() }))}
                  placeholder={t("AAPL", "例如 AAPL")}
                />
              </label>

              <label>
                {t("Shares / Amount", "股數 / 金額")}
                <input
                  value={draft.shares}
                  onChange={(event) => setDraft((prev) => ({ ...prev, shares: event.target.value }))}
                />
              </label>

              <label>
                {t("Price", "價格")}
                <input
                  value={draft.price}
                  onChange={(event) => setDraft((prev) => ({ ...prev, price: event.target.value }))}
                />
              </label>

              <label>
                {t("Fee", "費用")}
                <input
                  value={draft.fee}
                  onChange={(event) => setDraft((prev) => ({ ...prev, fee: event.target.value }))}
                />
              </label>

              <label>
                {t("Currency", "貨幣")}
                <input
                  value={draft.currency}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, currency: event.target.value.toUpperCase() }))
                  }
                />
              </label>
            </div>

            <label className="full-width">
              {t("Note", "備註")}
              <input
                value={draft.note}
                onChange={(event) => setDraft((prev) => ({ ...prev, note: event.target.value }))}
                placeholder={t("Optional", "可選")}
              />
            </label>

            {transactionError && <div className="error-text">{transactionError}</div>}

            <div className="modal-actions">
              <button type="button" className="secondary-btn" onClick={closeTransactionModal}>
                {t("Cancel", "取消")}
              </button>
              <button type="button" className="primary-btn" onClick={saveTransaction}>
                {t("Save", "儲存")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingCashReview && (
        <div className="modal-backdrop" role="presentation" onClick={closeCashReviewModal}>
          <div
            className="modal-card cash-review-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{t("Insufficient Cash Balance", "現金餘額不足")}</h3>
            <p className="cash-review-text">
              {t(
                "You do not have enough cash for this BUY. Default top-up is prefilled, but you can reduce it if you are intentionally using leverage.",
                "你而家買入現金不足。系統已預設補齊金額，但你可以自行減少（例如你想用槓桿／孖展）。",
              )}
            </p>

            <div className="cash-review-grid">
              <div className="cash-review-metric">
                <span>{t("Current Balance", "目前餘額")}</span>
                <strong>{displayMoney(pendingCashReview.cashBalance, pendingCashReview.currency)}</strong>
              </div>
              <div className="cash-review-metric">
                <span>{t("Required Extra Cash", "所需額外現金")}</span>
                <strong>{displayMoney(pendingCashReview.shortfall, pendingCashReview.currency)}</strong>
              </div>
            </div>

            <label className="full-width">
              {t("Cash Top-up Amount", "現金補倉金額")}
              <input
                type="number"
                min="0"
                max={pendingCashReview.shortfall.toString()}
                step="0.01"
                value={pendingCashAmount}
                onChange={(event) => setPendingCashAmount(event.target.value)}
                onBlur={() => {
                  const normalized = Math.max(
                    0,
                    Math.min(pendingCashReview.shortfall, parseNumberish(pendingCashAmount)),
                  );
                  setPendingCashAmount(normalized.toFixed(2));
                }}
              />
            </label>

            <p className="cash-review-tip">
              {t(
                "If top-up is lower than required, this BUY will be treated as leverage (margin).",
                "如果補倉金額少過所需，呢筆買入會被視為槓桿／孖展交易。",
              )}
            </p>

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setPendingCashAmount(pendingCashReview.shortfall.toFixed(2))}
              >
                {t("Fill Required", "補齊所需")}
              </button>
              <button type="button" className="secondary-btn" onClick={() => setPendingCashAmount("0")}>
                {t("Use Leverage", "使用槓桿")}
              </button>
              <button type="button" className="secondary-btn" onClick={closeCashReviewModal}>
                {t("Back", "返回")}
              </button>
              <button type="button" className="primary-btn" onClick={confirmPendingCashReview}>
                {t("Confirm", "確認")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
