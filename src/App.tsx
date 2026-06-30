import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { deflate, inflate } from "pako";
import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import stockerWordmark from "./assets/stocker-wordmark.png";
import AreaChart from "./components/AreaChart";
import BarChart from "./components/BarChart";
import HeatmapGrid from "./components/HeatmapGrid";
import MultiLineChart from "./components/MultiLineChart";
import PieChart from "./components/PieChart";
import PortfolioOverviewChart, {
  type PortfolioOverviewMetric,
} from "./components/PortfolioOverviewChart";
import PriceChart, { PriceChartTradeMarker } from "./components/PriceChart";
import {
  calculateAssetAllocationSegments,
  calculateCashBalances,
  calculateCurrencyExposureSegments,
  calculateDividendCalendarSeries,
  calculateDrawdownSeries,
  calculateInsightMetrics,
  calculateMonthlyBuySeries,
  calculateMonthlyCashFlowSeries,
  calculateMonthlyDividendSeries,
  calculateMonthlyFeeSeries,
  calculateMonthlyProfitSeries,
  calculateMonthlySellSeries,
  calculateNormalizedCompareSeries,
  calculatePortfolioOverviewSeries,
  calculatePortfolioProfitSeries,
  calculatePortfolioSummary,
  calculateRebalanceSuggestions,
  calculateSeriesForStock,
  calculateStockBreakdown,
  calculateTransactionHeatmap,
  type CalculationConversionOptions,
  ChartRangePreset,
  type ChartSlice,
  getStockDateBounds,
} from "./lib/calculations";
import {
  firebaseAuth,
  firebaseDatabaseCollection,
  firestoreDb,
  googleProvider,
} from "./lib/firebaseClient";
import {
  buildPortfolioEntityWithMeta,
  buildDualFormatRecords,
  normalizeAiPayloadToEntities,
  parseInputByType,
  reassignEntityPositions,
} from "./lib/formatParser";
import {
  fetchLocalStockData,
  normalizePortfolioWithAi,
} from "./lib/localFunctionApi";
import {
  EntityDataset,
  NormalizedTransaction,
  PricePoint,
  ProfitPoint,
  StockerProAssetMeta,
  StockerProCashAssetMeta,
  StockerProEntityMeta,
  StockerProPortfolioMeta,
  StockerProPositionMeta,
  TxType,
  UserType,
} from "./types";

type Screen = "choose" | "upload" | "dashboard";
type DashboardTab =
  | "dashboard"
  | "analysis"
  | "holdings"
  | "transactions"
  | "data"
  | "settings";
type DateFilterPreset = "all" | "today" | "week" | "month" | "year" | "custom";
type Locale = "en" | "zh-HK";
type PortfolioLineId = "totalMarketValue" | "totalProfit" | "totalReturnPct";

type TransactionTypeFilter = "all" | TxType;
type TransactionDistrict =
  | "US"
  | "HK"
  | "CRYPTO"
  | "TW"
  | "TWO"
  | "SZ"
  | "JP"
  | "CN"
  | "UK"
  | "CA"
  | "AU"
  | "SG"
  | "OTHER";

interface TransactionRow extends NormalizedTransaction {
  portfolioId: string;
  portfolioName: string;
  assetName?: string | null;
}

interface TransactionDraft {
  id: string;
  portfolioId: string;
  date: string;
  type: TxType;
  district: TransactionDistrict;
  symbol: string;
  shares: string;
  price: string;
  fee: string;
  currency: string;
  note: string;
}

interface NewPortfolioDraft {
  name: string;
  currencyType: string;
}

interface WebSettings {
  language: Locale;
  showObscure: boolean;
  enableAnimations: boolean;
  showCashInAllocation: boolean;
  defaultCurrency: string;
  displayCurrency: string;
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

interface AiImportResponse {
  normalized?: unknown;
  warnings?: string[];
  quota?: {
    month: string;
    used: number;
    remaining: number;
    limit: number;
  };
}

interface ImportReviewSource {
  rawText: string;
  fileName: string;
  fileCount: number;
  fileNames: string[];
  preferredType: UserType;
  localQuota: UploadQuotaSnapshot;
  usedAi: boolean;
  aiQuota?: AiImportResponse["quota"];
}

interface ImportReviewRow extends NormalizedTransaction {
  portfolioId: string;
  portfolioName: string;
}

interface ImportPortfolioOptions {
  forceAi?: boolean;
  userInstruction?: string;
  currentNormalized?: string;
}

interface ImportBatchItem {
  fileName: string;
  rawText: string;
  entities: EntityDataset[];
  usedAi: boolean;
  localQuota: UploadQuotaSnapshot;
  aiQuota?: AiImportResponse["quota"];
}

const STORAGE_KEY = "stocker-web-v2";
const SETTINGS_STORAGE_KEY = "stocker-web-settings-v1";
const BETA_CONSENT_STORAGE_KEY = "stocker-web-beta-consent-v1";
const ALL_PORTFOLIO_ID = "all";
const STOCK_QUOTE_MIN_REQUEST_GAP_MS = 60 * 1000;
const ENABLE_SYNC_TRACE = Boolean(import.meta.env.DEV);
const ENABLE_PORTFOLIO_SELECTION_TRACE = true;
const MONTHLY_UPLOAD_LIMIT = 20;
const UPLOAD_QUOTA_STORAGE_KEY = "stocker-web-upload-quota-v1";
const FRANKFURTER_LATEST_URL = "https://api.frankfurter.dev/v1/latest";
const STOCK_PRICE_TRANSACTION_TYPES = new Set<TxType>([
  "BUY",
  "SELL",
  "DIVIDEND_CASH",
  "DIVIDEND_SHARE",
  "FEE",
]);
const REQUIRED_ASSET_SYMBOL_TYPES = new Set<TxType>([
  "BUY",
  "SELL",
  "DIVIDEND_CASH",
  "DIVIDEND_SHARE",
]);

const FIXED_USD_FX_RATES: Record<string, number> = {
  USD: 1,
  USDT: 1,
  HKD: 7.8,
  TWD: 32,
  JPY: 150,
  CNY: 7.2,
  CNH: 7.2,
  EUR: 0.92,
  GBP: 0.79,
  AUD: 1.52,
  CAD: 1.36,
  SGD: 1.35,
  KRW: 1350,
  INR: 83,
  CHF: 0.9,
};

interface UploadQuotaSnapshot {
  month: string;
  used: number;
  remaining: number;
  limit: number;
}

function buildSafePortfolioId(
  rawId: string,
  fallbackSeed: string,
  usedIds: Set<string>,
): string {
  const trimmed = rawId.trim();
  let candidate = trimmed || fallbackSeed;
  if (candidate.toLowerCase() === ALL_PORTFOLIO_ID) {
    candidate = fallbackSeed;
  }
  let counter = 2;
  while (
    usedIds.has(candidate) ||
    candidate.toLowerCase() === ALL_PORTFOLIO_ID
  ) {
    candidate = `${fallbackSeed}-${counter}`;
    counter += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function consumeLocalMonthlyUploadQuota(): UploadQuotaSnapshot {
  const month = currentMonthKey();

  try {
    const raw = localStorage.getItem(UPLOAD_QUOTA_STORAGE_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as { month?: string; used?: number })
      : null;
    const sameMonth = parsed?.month === month;
    const currentUsed = sameMonth ? Number(parsed?.used ?? 0) : 0;
    if (currentUsed >= MONTHLY_UPLOAD_LIMIT) {
      throw new Error(
        `Monthly upload limit reached (${MONTHLY_UPLOAD_LIMIT}).`,
      );
    }

    const nextUsed = currentUsed + 1;
    localStorage.setItem(
      UPLOAD_QUOTA_STORAGE_KEY,
      JSON.stringify({
        month,
        used: nextUsed,
      }),
    );

    return {
      month,
      used: nextUsed,
      remaining: Math.max(0, MONTHLY_UPLOAD_LIMIT - nextUsed),
      limit: MONTHLY_UPLOAD_LIMIT,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Monthly upload limit reached")
    ) {
      throw error;
    }
    return {
      month,
      used: 0,
      remaining: MONTHLY_UPLOAD_LIMIT,
      limit: MONTHLY_UPLOAD_LIMIT,
    };
  }
}

function detectDefaultLocale(): Locale {
  if (typeof navigator !== "undefined") {
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) {
      return "zh-HK";
    }
  }
  return "en";
}

function syncTrace(event: string, payload?: Record<string, unknown>): void {
  if (!ENABLE_SYNC_TRACE) {
    return;
  }
  const stamp = new Date().toISOString();
  if (payload) {
    console.info(`[SYNC_TRACE] ${stamp} ${event}`, payload);
    try {
      const serialized = JSON.stringify(payload);
      const limited =
        serialized.length > 4000
          ? `${serialized.slice(0, 4000)}...`
          : serialized;
      console.info(`[SYNC_TRACE_JSON] ${stamp} ${event} ${limited}`);
    } catch {
      // Ignore payload serialization errors in debug logging.
    }
    return;
  }
  console.info(`[SYNC_TRACE] ${stamp} ${event}`);
}

const DEFAULT_SETTINGS: WebSettings = {
  language: detectDefaultLocale(),
  showObscure: false,
  enableAnimations: true,
  showCashInAllocation: true,
  defaultCurrency: "USD",
  displayCurrency: "AUTO",
  defaultImportType: "stockerpro",
  compactTables: false,
};

const COMMON_CURRENCY_CODES = [
  "USD",
  "HKD",
  "TWD",
  "JPY",
  "EUR",
  "GBP",
  "CNY",
  "CAD",
  "AUD",
  "SGD",
  "CHF",
];

const TIME_RANGE_OPTIONS: { value: ChartRangePreset; label: string }[] = [
  { value: "1W", label: "1W" },
  { value: "1M", label: "1M" },
  { value: "1Y", label: "1Y" },
  { value: "10Y", label: "10Y" },
  { value: "ALL", label: "All" },
  { value: "CUSTOM", label: "Custom" },
];

const PORTFOLIO_LINE_OPTIONS: {
  value: PortfolioLineId;
  label: string;
  labelZh: string;
  color: string;
}[] = [
  {
    value: "totalMarketValue",
    label: "Market Value",
    labelZh: "市值",
    color: "#14B8A6",
  },
  { value: "totalProfit", label: "Profit", labelZh: "收益", color: "#7C3AED" },
  {
    value: "totalReturnPct",
    label: "Profit %",
    labelZh: "收益率",
    color: "#F59E0B",
  },
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

const TRANSACTION_TYPE_OPTIONS: {
  value: TransactionTypeFilter;
  label: string;
}[] = [
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

const TRANSACTION_DISTRICT_OPTIONS: {
  value: TransactionDistrict;
  label: string;
  labelZh: string;
  currency?: string;
}[] = [
  { value: "US", label: "US", labelZh: "美國", currency: "USD" },
  { value: "HK", label: "HK", labelZh: "香港", currency: "HKD" },
  { value: "CRYPTO", label: "Crypto", labelZh: "加密貨幣", currency: "USD" },
  { value: "TW", label: "TW", labelZh: "台股", currency: "TWD" },
  { value: "TWO", label: "TWO", labelZh: "台股上櫃", currency: "TWD" },
  { value: "SG", label: "SG", labelZh: "新加坡", currency: "SGD" },
  { value: "UK", label: "UK", labelZh: "英國", currency: "GBP" },
  { value: "SZ", label: "SZ", labelZh: "深股", currency: "CNY" },
  { value: "CN", label: "CN", labelZh: "中股", currency: "CNY" },
  { value: "JP", label: "JP", labelZh: "日本", currency: "JPY" },
  { value: "CA", label: "CA", labelZh: "加拿大", currency: "CAD" },
  { value: "AU", label: "AU", labelZh: "澳洲", currency: "AUD" },
  { value: "OTHER", label: "Others", labelZh: "其他" },
];

const ALLOWED_TRANSACTION_DISTRICTS = new Set<TransactionDistrict>(
  TRANSACTION_DISTRICT_OPTIONS.map((option) => option.value),
);

const DISTRICT_CURRENCY_MAP: Record<
  Exclude<TransactionDistrict, "OTHER">,
  string
> = {
  US: "USD",
  HK: "HKD",
  CRYPTO: "USD",
  TW: "TWD",
  TWO: "TWD",
  SZ: "CNY",
  CN: "CNY",
  JP: "JPY",
  UK: "GBP",
  CA: "CAD",
  AU: "AUD",
  SG: "SGD",
};

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

  if (
    upper.includes("-USD") ||
    upper.includes("USDT") ||
    upper.includes("BTC") ||
    upper.includes("ETH")
  ) {
    return "Crypto";
  }
  if (upper.includes("REIT")) {
    return "REIT";
  }
  if (upper.endsWith("ADR")) {
    return "ADR";
  }
  if (
    upper.endsWith("ETF") ||
    upper.includes(" ETF") ||
    ETF_SYMBOL_HINTS.has(upper)
  ) {
    return "ETF";
  }
  return "Stock";
}

function buildSlicesFromMap(values: Map<string, number>): ChartSlice[] {
  return [...values.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value], index) => ({
      label: String(label ?? "").trim() || "Other",
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

function normalizeCurrencyCode(code: string | undefined | null): string {
  return String(code ?? "")
    .trim()
    .toUpperCase();
}

function normalizeTransactionDistrict(
  value: string | undefined | null,
): TransactionDistrict {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase() as TransactionDistrict;
  return ALLOWED_TRANSACTION_DISTRICTS.has(normalized) ? normalized : "OTHER";
}

function getAutoCurrencyByDistrict(
  district: TransactionDistrict,
): string | null {
  const normalizedDistrict = normalizeTransactionDistrict(district);
  if (normalizedDistrict === "OTHER") {
    return null;
  }
  return DISTRICT_CURRENCY_MAP[normalizedDistrict] ?? null;
}

function inferDistrictFromCurrency(
  currency: string,
  symbol?: string,
): TransactionDistrict {
  const upperSymbol = String(symbol ?? "")
    .trim()
    .toUpperCase();

  if (
    upperSymbol.includes("-USD") ||
    upperSymbol.includes("USDT") ||
    upperSymbol.includes("BTC") ||
    upperSymbol.includes("ETH")
  ) {
    return "CRYPTO";
  }
  if (upperSymbol.endsWith(".SZ")) {
    return "SZ";
  }
  if (upperSymbol.endsWith(".SS") || upperSymbol.endsWith(".SH")) {
    return "CN";
  }
  if (upperSymbol.endsWith(".TWO")) {
    return "TWO";
  }
  if (upperSymbol.endsWith(".TW")) {
    return "TW";
  }

  const normalized = normalizeCurrencyCode(currency);
  if (normalized === "HKD") {
    return "HK";
  }
  if (normalized === "TWD") {
    return "TW";
  }
  if (normalized === "SGD") {
    return "SG";
  }
  if (normalized === "GBP") {
    return "UK";
  }
  if (normalized === "CNY" || normalized === "CNH") {
    return "CN";
  }
  if (normalized === "JPY") {
    return "JP";
  }
  if (normalized === "CAD") {
    return "CA";
  }
  if (normalized === "AUD") {
    return "AU";
  }
  if (normalized === "USD") {
    return "US";
  }
  return "OTHER";
}

function isValidCurrencyCode(code: string): boolean {
  return /^[A-Z0-9]{2,8}$/.test(code);
}

function resolveFxRateFromPairMap(
  pairMap: Record<string, number>,
  fromCurrency: string,
  toCurrency: string,
): number | null {
  const from = normalizeCurrencyCode(fromCurrency) || "USD";
  const to = normalizeCurrencyCode(toCurrency) || "USD";
  if (from === to) {
    return 1;
  }

  const direct = pairMap[`${from}->${to}`];
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  if (from === "USD" || to === "USD") {
    return null;
  }

  const fromToUsd = pairMap[`${from}->USD`];
  const usdToTarget = pairMap[`USD->${to}`];
  if (
    typeof fromToUsd === "number" &&
    Number.isFinite(fromToUsd) &&
    fromToUsd > 0 &&
    typeof usdToTarget === "number" &&
    Number.isFinite(usdToTarget) &&
    usdToTarget > 0
  ) {
    return fromToUsd * usdToTarget;
  }

  return null;
}

function buildFxRatePairMapFromUsdRates(
  usdRateByCurrency: Record<string, number>,
  currencies: string[],
): Record<string, number> {
  const pairMap: Record<string, number> = {};
  const uniqueCurrencies = [
    ...new Set(
      currencies
        .map((currency) => normalizeCurrencyCode(currency))
        .filter((currency) => currency && currency !== "AUTO"),
    ),
  ];
  if (!uniqueCurrencies.includes("USD")) {
    uniqueCurrencies.push("USD");
  }

  uniqueCurrencies.forEach((from) => {
    const fromPerUsd = usdRateByCurrency[from];
    if (
      !(
        typeof fromPerUsd === "number" &&
        Number.isFinite(fromPerUsd) &&
        fromPerUsd > 0
      )
    ) {
      return;
    }

    uniqueCurrencies.forEach((to) => {
      const toPerUsd = usdRateByCurrency[to];
      if (
        !(
          typeof toPerUsd === "number" &&
          Number.isFinite(toPerUsd) &&
          toPerUsd > 0
        )
      ) {
        return;
      }
      pairMap[`${from}->${to}`] = toPerUsd / fromPerUsd;
    });
  });

  return pairMap;
}

interface FxRateFetchResult {
  pairMap: Record<string, number>;
  fallbackCurrencies: string[];
  missingCurrencies: string[];
  liveCurrencies: string[];
}

async function fetchFrankfurterFxRates(
  currencies: string[],
): Promise<FxRateFetchResult> {
  const normalizedCurrencies = [
    ...new Set(
      currencies
        .map((currency) => normalizeCurrencyCode(currency))
        .filter(
          (currency) =>
            currency && currency !== "AUTO" && isValidCurrencyCode(currency),
        ),
    ),
  ];
  if (!normalizedCurrencies.includes("USD")) {
    normalizedCurrencies.push("USD");
  }

  const requestedCurrencies = normalizedCurrencies.filter(
    (currency) => currency !== "USD",
  );
  const usdRateByCurrency: Record<string, number> = { USD: 1 };
  const liveCurrencies: string[] = [];

  if (requestedCurrencies.length > 0) {
    const params = new URLSearchParams({
      base: "USD",
    });
    const response = await fetch(
      `${FRANKFURTER_LATEST_URL}?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Frankfurter FX request failed (${response.status}).`);
    }

    const payload = (await response.json()) as {
      rates?: Record<string, number>;
    };
    Object.entries(payload.rates ?? {}).forEach(([currency, rawRate]) => {
      const normalized = normalizeCurrencyCode(currency);
      const rate = Number(rawRate);
      if (!normalized || !Number.isFinite(rate) || rate <= 0) {
        return;
      }
      usdRateByCurrency[normalized] = rate;
      if (requestedCurrencies.includes(normalized)) {
        liveCurrencies.push(normalized);
      }
    });
  }

  const fallbackCurrencies: string[] = [];
  normalizedCurrencies.forEach((currency) => {
    if (currency in usdRateByCurrency) {
      return;
    }
    const fallback = FIXED_USD_FX_RATES[currency];
    if (
      typeof fallback === "number" &&
      Number.isFinite(fallback) &&
      fallback > 0
    ) {
      usdRateByCurrency[currency] = fallback;
      fallbackCurrencies.push(currency);
    }
  });

  const missingCurrencies = normalizedCurrencies.filter(
    (currency) => !(currency in usdRateByCurrency),
  );
  const pairMap = buildFxRatePairMapFromUsdRates(
    usdRateByCurrency,
    normalizedCurrencies,
  );

  return {
    pairMap,
    fallbackCurrencies,
    missingCurrencies,
    liveCurrencies,
  };
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

function scoreTextCandidate(text: string): number {
  if (!text) {
    return 0;
  }

  const trimmedLength = text.trim().length;
  if (trimmedLength === 0) {
    return 0;
  }

  let readableCount = 0;
  let replacementCount = 0;
  let nullCount = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0) {
      nullCount += 1;
      continue;
    }
    if (code === 0xfffd) {
      replacementCount += 1;
      continue;
    }
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code <= 126) ||
      code >= 160
    ) {
      readableCount += 1;
    }
  }

  const safeLength = Math.max(1, text.length);
  const readableRatio = readableCount / safeLength;
  const replacementPenalty = replacementCount / safeLength;
  const nullPenalty = nullCount / safeLength;
  const lengthFactor = Math.min(1, trimmedLength / 200);

  return (
    Math.max(0, readableRatio - replacementPenalty * 1.6 - nullPenalty * 1.8) *
    lengthFactor
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function compressStringToDeflateBase64(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  // Keep zlib-compatible output (same as mobile app's Compression.compressString).
  return bytesToBase64(deflate(bytes));
}

function decodeBase64ToString(base64: string): string {
  const bytes = base64ToBytes(base64);
  return new TextDecoder().decode(bytes);
}

async function parseRemoteDatabasePayload(
  rawData: string,
): Promise<EntityDataset[]> {
  const text = rawData.trim();
  if (!text) {
    return [];
  }

  const decodeInflatedBase64 = async (): Promise<EntityDataset[]> => {
    const compressed = base64ToBytes(text);
    const inflated = inflate(compressed);
    const decoded = new TextDecoder().decode(inflated);
    try {
      return await parseInputByType(decoded, "stockerpro");
    } catch {
      return deserializeEntities(decoded);
    }
  };

  const parsers: Array<() => Promise<EntityDataset[]>> = [
    () => parseInputByType(text, "stockerpro"),
    () => parseInputByType(text, "stockerx"),
    decodeInflatedBase64,
    async () => deserializeEntities(text),
    async () => deserializeEntities(decodeBase64ToString(text)),
  ];

  for (const parser of parsers) {
    try {
      const result = await parser();
      if (result.length > 0) {
        return result;
      }
    } catch {
      // Try next parser strategy.
    }
  }

  return [];
}

async function readFileContentForImport(file: File): Promise<string> {
  const directText = await file.text();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const decoders = ["utf-8", "utf-16le", "utf-16be", "windows-1252"];
  const candidates = [directText];

  decoders.forEach((encoding) => {
    try {
      const decoded = new TextDecoder(encoding, { fatal: false }).decode(bytes);
      candidates.push(decoded);
    } catch {
      // Skip unsupported decoder.
    }
  });

  let bestText = "";
  let bestScore = 0;
  candidates.forEach((candidate) => {
    const score = scoreTextCandidate(candidate);
    if (score > bestScore) {
      bestScore = score;
      bestText = candidate;
    }
  });

  if (bestText.trim() && bestScore >= 0.18) {
    return bestText;
  }

  const base64Sample = bytesToBase64(
    bytes.slice(0, Math.min(bytes.length, 80_000)),
  );
  return [
    "[STOCKER_UNIVERSAL_IMPORT_BINARY]",
    `fileName: ${file.name}`,
    `mimeType: ${file.type || "application/octet-stream"}`,
    `fileSize: ${file.size}`,
    "base64Sample:",
    base64Sample,
  ].join("\n");
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

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function sortTransactionsByDateAsc(
  transactions: NormalizedTransaction[],
): NormalizedTransaction[] {
  return [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function shouldUseCurrencyAsSymbol(type: TxType): boolean {
  return (
    type === "CASH" ||
    type === "CASH_CONVERT" ||
    type === "FEE" ||
    type === "INTEREST"
  );
}

function isAssetSymbolValue(symbol: string, currency: string): boolean {
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) {
    return false;
  }
  return normalizedSymbol !== currency.trim().toUpperCase();
}

function allowsSymbolInput(type: TxType): boolean {
  return REQUIRED_ASSET_SYMBOL_TYPES.has(type) || type === "FEE";
}

function requiresAssetSymbol(type: TxType): boolean {
  return REQUIRED_ASSET_SYMBOL_TYPES.has(type);
}

function shouldDisplayAssetSymbol(
  type: TxType,
  symbol: string,
  currency: string,
): boolean {
  if (REQUIRED_ASSET_SYMBOL_TYPES.has(type)) {
    return true;
  }
  if (type === "FEE") {
    return isAssetSymbolValue(symbol, currency);
  }
  return false;
}

function resolveAssetNameForTransaction(
  entity: EntityDataset,
  tx: NormalizedTransaction,
): string | null {
  const assetsBySymbol = entity.stockerProMeta?.assetsBySymbol;
  if (!assetsBySymbol) {
    return null;
  }

  const normalizedSymbol = tx.symbol.trim().toUpperCase();
  const normalizedCurrency = tx.currency.trim().toUpperCase();
  const directKey = `${normalizedSymbol}|${normalizedCurrency}`;
  const direct = assetsBySymbol[directKey]?.assetName;
  if (direct != null && direct.trim()) {
    return direct.trim();
  }

  const fallbackAsset = Object.values(assetsBySymbol).find((asset) => {
    return asset.symbol.trim().toUpperCase() === normalizedSymbol;
  });
  const fallbackName = fallbackAsset?.assetName;
  if (fallbackName != null && fallbackName.trim()) {
    return fallbackName.trim();
  }
  return null;
}

function getTransactionSymbolDisplayText(row: TransactionRow): string {
  if (!shouldDisplayAssetSymbol(row.type, row.symbol, row.currency)) {
    return "-";
  }
  const trimmedAssetName = row.assetName?.trim();
  return trimmedAssetName ? trimmedAssetName : row.symbol;
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
  if (tx.type === "DIVIDEND_SHARE") {
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

function buildLatestPriceBySymbol(
  transactions: NormalizedTransaction[],
): Record<string, number> {
  const latest = new Map<string, { date: number; price: number }>();

  for (const tx of transactions) {
    if (tx.type !== "BUY" && tx.type !== "SELL") {
      continue;
    }
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

function isStockSymbolTransaction(tx: NormalizedTransaction): boolean {
  if (!STOCK_PRICE_TRANSACTION_TYPES.has(tx.type)) {
    return false;
  }
  return isAssetSymbolValue(tx.symbol, tx.currency);
}

function collectPortfolioStockSymbols(entities: EntityDataset[]): string[] {
  const symbols = new Set<string>();

  entities.forEach((entity) => {
    entity.transactions.forEach((tx) => {
      if (isStockSymbolTransaction(tx)) {
        symbols.add(tx.symbol.trim().toUpperCase());
      }
    });
  });

  return [...symbols].sort((a, b) => a.localeCompare(b));
}

function isRateLimitMessage(message: string): boolean {
  return /too many requests|retry after|rate limit|429/i.test(message);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseQuoteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = Number(value.replace(/,/g, "").trim());
    if (Number.isFinite(normalized) && normalized > 0) {
      return normalized;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const rawValue = parseQuoteNumber(record.raw);
  if (rawValue) {
    return rawValue;
  }

  return parseQuoteNumber(record.fmt);
}

function buildYahooSymbolCandidates(symbol: string): string[] {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) {
    return [];
  }
  const candidates = [normalized];
  if (normalized.endsWith("-USDT")) {
    candidates.push(normalized.replace(/-USDT$/, "-USD"));
  }
  return [...new Set(candidates)];
}

function resolveQuotedPriceBySymbol(
  quotePriceMap: Record<string, number>,
  symbol: string,
): number | null {
  const candidates = buildYahooSymbolCandidates(symbol);
  for (const candidate of candidates) {
    const price = quotePriceMap[candidate];
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      return price;
    }
  }
  return null;
}

function extractYahooQuotePriceMap(payload: unknown): Record<string, number> {
  const payloadRecord = asRecord(payload);
  const source = payloadRecord?.data ?? payload;
  const sourceRecord = asRecord(source);
  const quoteResponse = asRecord(sourceRecord?.quoteResponse);
  const resultRows = quoteResponse?.result;
  if (!Array.isArray(resultRows)) {
    return {};
  }

  const priceBySymbol: Record<string, number> = {};
  resultRows.forEach((row) => {
    const quoteRow = asRecord(row);
    if (!quoteRow) {
      return;
    }

    const symbolRaw = quoteRow.symbol;
    if (typeof symbolRaw !== "string" || !symbolRaw.trim()) {
      return;
    }
    const symbol = symbolRaw.trim().toUpperCase();

    const priceCandidates = [
      quoteRow.regularMarketPrice,
      quoteRow.postMarketPrice,
      quoteRow.preMarketPrice,
      quoteRow.ask,
      quoteRow.bid,
      quoteRow.regularMarketPreviousClose,
    ];

    for (const candidate of priceCandidates) {
      const parsed = parseQuoteNumber(candidate);
      if (parsed) {
        priceBySymbol[symbol] = parsed;
        break;
      }
    }
  });

  return priceBySymbol;
}

function extractYahooChartPriceSeries(payload: unknown): PricePoint[] {
  const payloadRecord = asRecord(payload);
  const source = payloadRecord?.data ?? payload;
  const sourceRecord = asRecord(source);
  const chart = asRecord(sourceRecord?.chart);
  const results = chart?.result;
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  const firstResult = asRecord(results[0]);
  if (!firstResult) {
    return [];
  }

  const timestamps = Array.isArray(firstResult.timestamp)
    ? firstResult.timestamp
    : [];
  const indicators = asRecord(firstResult.indicators);
  const quoteRows = Array.isArray(indicators?.quote) ? indicators.quote : [];
  const firstQuote = quoteRows.length > 0 ? asRecord(quoteRows[0]) : null;
  const closeValues = Array.isArray(firstQuote?.close) ? firstQuote.close : [];

  const adjustedRows = Array.isArray(indicators?.adjclose)
    ? indicators.adjclose
    : [];
  const firstAdjusted =
    adjustedRows.length > 0 ? asRecord(adjustedRows[0]) : null;
  const adjustedCloseValues = Array.isArray(firstAdjusted?.adjclose)
    ? firstAdjusted.adjclose
    : [];

  const points: PricePoint[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = Number(timestamps[index]);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      continue;
    }

    const closePrice =
      parseQuoteNumber(closeValues[index]) ??
      parseQuoteNumber(adjustedCloseValues[index]);
    if (!closePrice) {
      continue;
    }

    points.push({
      date: new Date(timestamp * 1000),
      price: closePrice,
    });
  }

  return points.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function extractYahooChartPriceSeriesBatch(
  payload: unknown,
): Record<string, PricePoint[]> {
  const payloadRecord = asRecord(payload);
  const source = payloadRecord?.data ?? payload;
  const sourceRecord = asRecord(source);
  const batchRecord = asRecord(
    sourceRecord?.chartBatch ?? sourceRecord?.batch ?? sourceRecord?.charts,
  );

  if (!batchRecord) {
    return {};
  }

  const result: Record<string, PricePoint[]> = {};
  Object.entries(batchRecord).forEach(([symbolRaw, chartPayload]) => {
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol) {
      return;
    }
    const points = extractYahooChartPriceSeries(chartPayload);
    if (points.length > 0) {
      result[symbol] = points;
    }
  });
  return result;
}

function resolveYahooChartRequest(preset: ChartRangePreset): {
  range: string;
  interval: string;
} {
  if (preset === "1W") {
    return { range: "7d", interval: "15m" };
  }
  if (preset === "1M") {
    return { range: "1mo", interval: "1h" };
  }
  if (preset === "1Y") {
    return { range: "1y", interval: "1d" };
  }
  if (preset === "10Y") {
    return { range: "10y", interval: "1wk" };
  }
  if (preset === "ALL") {
    return { range: "max", interval: "1mo" };
  }
  return { range: "max", interval: "1d" };
}

function filterPriceSeriesByCustomRange(
  points: PricePoint[],
  preset: ChartRangePreset,
  customStart: string,
  customEnd: string,
): PricePoint[] {
  if (preset !== "CUSTOM") {
    return points;
  }

  const start = parseDateInput(customStart);
  const end = parseDateInput(customEnd);
  if (!start && !end) {
    return points;
  }

  const startMs = start
    ? startOfDay(start).getTime()
    : Number.NEGATIVE_INFINITY;
  const endMs = end
    ? startOfDay(end).getTime() + 86_399_999
    : Number.POSITIVE_INFINITY;
  return points.filter((point) => {
    const time = point.date.getTime();
    return time >= startMs && time <= endMs;
  });
}

function buildFallbackPriceSeries(
  transactions: NormalizedTransaction[],
  symbol: string,
): PricePoint[] {
  return transactions
    .filter(
      (tx) =>
        tx.symbol === symbol &&
        tx.price > 0 &&
        (tx.type === "BUY" || tx.type === "SELL"),
    )
    .map((tx) => ({
      date: tx.date,
      price: tx.price,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function calculateProfitSeriesFromPriceSeries(
  priceSeries: PricePoint[],
  transactions: NormalizedTransaction[],
): ProfitPoint[] {
  if (priceSeries.length === 0) {
    return [];
  }

  const sortedPrices = [...priceSeries].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const sortedTransactions = [...transactions].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  let txIndex = 0;
  const state = {
    purchasedShares: 0,
    soldShares: 0,
    purchaseTotal: 0,
    sellingTotal: 0,
    dividends: 0,
    fees: 0,
  };

  const series: ProfitPoint[] = [];

  for (const pricePoint of sortedPrices) {
    while (
      txIndex < sortedTransactions.length &&
      sortedTransactions[txIndex].date.getTime() <= pricePoint.date.getTime()
    ) {
      const tx = sortedTransactions[txIndex];

      if (tx.type === "BUY") {
        state.purchasedShares += tx.shares;
        state.purchaseTotal += tx.shares * tx.price;
        state.fees += tx.fee;
      } else if (tx.type === "DIVIDEND_SHARE") {
        state.purchasedShares += tx.shares;
        state.fees += tx.fee;
      } else if (tx.type === "SELL") {
        state.soldShares += tx.shares;
        state.sellingTotal += tx.shares * tx.price;
        state.fees += tx.fee;
      } else if (tx.type === "DIVIDEND_CASH") {
        state.dividends += tx.shares * tx.price;
        state.fees += tx.fee;
      } else if (tx.type === "FEE") {
        state.fees += tx.shares * tx.price + tx.fee;
      }

      txIndex += 1;
    }

    const buyAvg =
      state.purchasedShares > 0
        ? state.purchaseTotal / state.purchasedShares
        : 0;
    const sellAvg =
      state.soldShares > 0 ? state.sellingTotal / state.soldShares : 0;
    const matchedShares = Math.min(state.purchasedShares, state.soldShares);
    const netTradeProfit =
      state.soldShares > 0 ? (sellAvg - buyAvg) * matchedShares : 0;
    const realizedProfit = netTradeProfit + state.dividends - state.fees;
    const activeShares = state.purchasedShares - state.soldShares;

    let holdingProfit = 0;
    if (activeShares > 0) {
      holdingProfit = (pricePoint.price - buyAvg) * activeShares;
    } else if (activeShares < 0) {
      holdingProfit = (pricePoint.price - sellAvg) * activeShares;
    }

    series.push({
      date: pricePoint.date,
      profit: round2(realizedProfit + holdingProfit),
    });
  }

  return series;
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
    return (
      target.getTime() >= start.getTime() && target.getTime() <= today.getTime()
    );
  }

  if (preset === "month") {
    return (
      target.getFullYear() === today.getFullYear() &&
      target.getMonth() === today.getMonth()
    );
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

function serializeEntitiesForCloudSync(entities: EntityDataset[]): string {
  return JSON.stringify(
    entities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      currency: entity.currency,
      transactions: entity.transactions.map((tx) => ({
        id: tx.id,
        date: tx.date.toISOString(),
        symbol: tx.symbol,
        type: tx.type,
        shares: tx.shares,
        price: tx.price,
        fee: tx.fee,
        currency: tx.currency,
        note: tx.note ?? "",
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

    const transactions: NormalizedTransaction[] = transactionsRaw.map(
      (txRaw, txIndex) => {
        const txType = String(txRaw.type ?? "CASH").toUpperCase() as TxType;
        return {
          id: String(txRaw.id ?? `tx-${entityIndex}-${txIndex}`),
          date: new Date(String(txRaw.date ?? new Date().toISOString())),
          symbol: String(txRaw.symbol ?? "").toUpperCase(),
          type: txType,
          shares: Number(txRaw.shares ?? 0),
          price: Number(txRaw.price ?? 0),
          fee: Number(txRaw.fee ?? 0),
          currency: String(
            txRaw.currency ?? entityRaw.currency ?? "USD",
          ).toUpperCase(),
          note: String(txRaw.note ?? ""),
        };
      },
    );

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

function safeDeserializeEntities(raw: string): EntityDataset[] {
  if (!raw.trim()) {
    return [];
  }
  try {
    return deserializeEntities(raw);
  } catch {
    return [];
  }
}

function clonePortfolioMeta(
  meta: StockerProPortfolioMeta,
): StockerProPortfolioMeta {
  return {
    ...meta,
    name: String(meta.name ?? ""),
    displayCurrencyType: String(
      meta.displayCurrencyType ?? "USD",
    ).toUpperCase(),
  };
}

function cloneAssetMeta(meta: StockerProAssetMeta): StockerProAssetMeta {
  return {
    ...meta,
    symbol: meta.symbol.trim().toUpperCase(),
    currencyType: meta.currencyType.trim().toUpperCase(),
    assetName: meta.assetName == null ? null : String(meta.assetName),
    displayOrder:
      meta.displayOrder == null ? null : Math.trunc(Number(meta.displayOrder)),
  };
}

function clonePositionMeta(
  meta: StockerProPositionMeta,
): StockerProPositionMeta {
  return {
    ...meta,
    cumulativeCost:
      meta.cumulativeCost == null ? null : Number(meta.cumulativeCost),
  };
}

function cloneCashAssetMeta(
  meta: StockerProCashAssetMeta,
): StockerProCashAssetMeta {
  return {
    ...meta,
    currencyType: meta.currencyType.trim().toUpperCase(),
  };
}

function cloneStockerProMeta(
  meta: StockerProEntityMeta | undefined,
): StockerProEntityMeta | undefined {
  if (!meta) {
    return undefined;
  }
  return {
    portfolio: clonePortfolioMeta(meta.portfolio),
    assetsBySymbol: Object.fromEntries(
      Object.entries(meta.assetsBySymbol).map(([key, asset]) => [
        key,
        cloneAssetMeta(asset),
      ]),
    ),
    positionsById: Object.fromEntries(
      Object.entries(meta.positionsById).map(([key, position]) => [
        Number(key),
        clonePositionMeta(position),
      ]),
    ) as Record<number, StockerProPositionMeta>,
    positionIdsByAssetId: Object.fromEntries(
      Object.entries(meta.positionIdsByAssetId).map(([key, ids]) => [
        Number(key),
        [...ids],
      ]),
    ) as Record<number, number[]>,
    cashAssetsByCurrency: Object.fromEntries(
      Object.entries(meta.cashAssetsByCurrency).map(([key, cash]) => [
        key,
        cloneCashAssetMeta(cash),
      ]),
    ),
  };
}

function mergeValueByThreeWay<T>(
  baseValue: T | undefined,
  localValue: T | undefined,
  remoteValue: T | undefined,
): T | undefined {
  const localTouched =
    localValue !== undefined && !Object.is(localValue, baseValue);
  const remoteTouched =
    remoteValue !== undefined && !Object.is(remoteValue, baseValue);
  if (localTouched) {
    return localValue;
  }
  if (remoteTouched) {
    return remoteValue;
  }
  if (localValue !== undefined) {
    return localValue;
  }
  if (remoteValue !== undefined) {
    return remoteValue;
  }
  return baseValue;
}

function mergeAssetNameByThreeWay(
  baseValue: string | null | undefined,
  localValue: string | null | undefined,
  remoteValue: string | null | undefined,
): string | null {
  const resolved = mergeValueByThreeWay(baseValue, localValue, remoteValue);
  if ((remoteValue == null || remoteValue === "") && localValue != null) {
    return localValue;
  }
  return resolved == null ? null : resolved;
}

function mergeStockerProMetaByThreeWay(
  baseMeta: StockerProEntityMeta | undefined,
  localMeta: StockerProEntityMeta | undefined,
  remoteMeta: StockerProEntityMeta | undefined,
): StockerProEntityMeta | undefined {
  if (!baseMeta && !localMeta && !remoteMeta) {
    return undefined;
  }

  const fallbackPortfolio: StockerProPortfolioMeta = localMeta?.portfolio ??
    remoteMeta?.portfolio ??
    baseMeta?.portfolio ?? {
      id: 0,
      name: "",
      tags: null,
      note: "",
      displayCurrencyType: "USD",
      displayOrder: null,
    };

  const mergedPortfolio: StockerProPortfolioMeta = {
    ...clonePortfolioMeta(fallbackPortfolio),
    name:
      mergeValueByThreeWay(
        baseMeta?.portfolio.name,
        localMeta?.portfolio.name,
        remoteMeta?.portfolio.name,
      ) ?? "",
    tags: mergeValueByThreeWay(
      baseMeta?.portfolio.tags,
      localMeta?.portfolio.tags,
      remoteMeta?.portfolio.tags,
    ),
    note:
      mergeValueByThreeWay(
        baseMeta?.portfolio.note,
        localMeta?.portfolio.note,
        remoteMeta?.portfolio.note,
      ) ?? "",
    displayCurrencyType:
      mergeValueByThreeWay(
        baseMeta?.portfolio.displayCurrencyType,
        localMeta?.portfolio.displayCurrencyType,
        remoteMeta?.portfolio.displayCurrencyType,
      ) ?? fallbackPortfolio.displayCurrencyType,
    displayOrder:
      mergeValueByThreeWay(
        baseMeta?.portfolio.displayOrder,
        localMeta?.portfolio.displayOrder,
        remoteMeta?.portfolio.displayOrder,
      ) ?? null,
  };

  const mergedAssetsBySymbol: Record<string, StockerProAssetMeta> = {};
  const assetKeys = new Set<string>([
    ...Object.keys(baseMeta?.assetsBySymbol ?? {}),
    ...Object.keys(localMeta?.assetsBySymbol ?? {}),
    ...Object.keys(remoteMeta?.assetsBySymbol ?? {}),
  ]);
  assetKeys.forEach((assetKey) => {
    const baseAsset = baseMeta?.assetsBySymbol[assetKey];
    const localAsset = localMeta?.assetsBySymbol[assetKey];
    const remoteAsset = remoteMeta?.assetsBySymbol[assetKey];
    const fallbackAsset = localAsset ?? remoteAsset ?? baseAsset;
    if (!fallbackAsset) {
      return;
    }
    mergedAssetsBySymbol[assetKey] = {
      ...cloneAssetMeta(fallbackAsset),
      assetName: mergeAssetNameByThreeWay(
        baseAsset?.assetName,
        localAsset?.assetName,
        remoteAsset?.assetName,
      ),
      displayOrder:
        mergeValueByThreeWay(
          baseAsset?.displayOrder,
          localAsset?.displayOrder,
          remoteAsset?.displayOrder,
        ) ?? null,
    };
  });

  const mergedPositionsById: Record<number, StockerProPositionMeta> = {};
  const positionIds = new Set<number>([
    ...Object.keys(baseMeta?.positionsById ?? {}).map((id) => Number(id)),
    ...Object.keys(localMeta?.positionsById ?? {}).map((id) => Number(id)),
    ...Object.keys(remoteMeta?.positionsById ?? {}).map((id) => Number(id)),
  ]);
  positionIds.forEach((positionId) => {
    const basePosition = baseMeta?.positionsById[positionId];
    const localPosition = localMeta?.positionsById[positionId];
    const remotePosition = remoteMeta?.positionsById[positionId];
    const fallbackPosition = localPosition ?? remotePosition ?? basePosition;
    if (!fallbackPosition) {
      return;
    }
    mergedPositionsById[positionId] = clonePositionMeta(fallbackPosition);
  });

  const mergedPositionIdsByAssetId: Record<number, number[]> = {};
  const positionAssetIds = new Set<number>([
    ...Object.keys(baseMeta?.positionIdsByAssetId ?? {}).map((id) =>
      Number(id),
    ),
    ...Object.keys(localMeta?.positionIdsByAssetId ?? {}).map((id) =>
      Number(id),
    ),
    ...Object.keys(remoteMeta?.positionIdsByAssetId ?? {}).map((id) =>
      Number(id),
    ),
  ]);
  positionAssetIds.forEach((assetId) => {
    const baseIds = baseMeta?.positionIdsByAssetId[assetId];
    const localIds = localMeta?.positionIdsByAssetId[assetId];
    const remoteIds = remoteMeta?.positionIdsByAssetId[assetId];
    const chosenIds = mergeValueByThreeWay(baseIds, localIds, remoteIds);
    if (chosenIds) {
      mergedPositionIdsByAssetId[assetId] = [...chosenIds];
    }
  });

  const mergedCashAssetsByCurrency: Record<string, StockerProCashAssetMeta> =
    {};
  const cashCurrencies = new Set<string>([
    ...Object.keys(baseMeta?.cashAssetsByCurrency ?? {}),
    ...Object.keys(localMeta?.cashAssetsByCurrency ?? {}),
    ...Object.keys(remoteMeta?.cashAssetsByCurrency ?? {}),
  ]);
  cashCurrencies.forEach((currency) => {
    const baseCash = baseMeta?.cashAssetsByCurrency[currency];
    const localCash = localMeta?.cashAssetsByCurrency[currency];
    const remoteCash = remoteMeta?.cashAssetsByCurrency[currency];
    const chosen = mergeValueByThreeWay(baseCash, localCash, remoteCash);
    if (chosen) {
      mergedCashAssetsByCurrency[currency] = cloneCashAssetMeta(chosen);
    }
  });

  return {
    portfolio: mergedPortfolio,
    assetsBySymbol: mergedAssetsBySymbol,
    positionsById: mergedPositionsById,
    positionIdsByAssetId: mergedPositionIdsByAssetId,
    cashAssetsByCurrency: mergedCashAssetsByCurrency,
  };
}

function normalizeTransactionForSync(
  tx: NormalizedTransaction,
  fallbackId: string,
): NormalizedTransaction {
  const txDate = Number.isFinite(tx.date.getTime())
    ? new Date(tx.date)
    : new Date();
  return {
    ...tx,
    id: (tx.id || fallbackId).trim() || fallbackId,
    date: txDate,
    symbol: tx.symbol.trim().toUpperCase(),
    currency: tx.currency.trim().toUpperCase(),
    note: tx.note ?? "",
  };
}

function normalizeEntityForSync(
  entity: EntityDataset,
  index: number,
): EntityDataset {
  const fallbackId = `portfolio-${index + 1}`;
  const safeId =
    entity.id.trim() && entity.id.trim().toLowerCase() !== ALL_PORTFOLIO_ID
      ? entity.id.trim()
      : fallbackId;
  const normalizedTransactions = sortTransactionsByDateAsc(
    entity.transactions
      .map((tx, txIndex) =>
        normalizeTransactionForSync(tx, `tx-${safeId}-${txIndex}`),
      )
      .filter((tx) => tx.symbol),
  );

  return {
    id: safeId,
    name: entity.name.trim() || `Portfolio ${index + 1}`,
    currency: normalizeCurrencyCode(entity.currency) || "USD",
    transactions: normalizedTransactions,
    latestPriceBySymbol: buildLatestPriceBySymbol(normalizedTransactions),
    stockerProMeta: cloneStockerProMeta(entity.stockerProMeta),
  };
}

function transactionSnapshot(tx: NormalizedTransaction): string {
  return [
    tx.date.getTime(),
    tx.type,
    tx.symbol,
    tx.currency,
    tx.shares,
    tx.price,
    tx.fee,
    tx.note ?? "",
  ].join("|");
}

function mergeTransactionsByThreeWay(
  baseTransactions: NormalizedTransaction[],
  localTransactions: NormalizedTransaction[],
  remoteTransactions: NormalizedTransaction[],
): NormalizedTransaction[] {
  const byId = (
    rows: NormalizedTransaction[],
  ): Map<string, NormalizedTransaction> => {
    const map = new Map<string, NormalizedTransaction>();
    rows.forEach((row) => {
      map.set(row.id, row);
    });
    return map;
  };

  const baseMap = byId(baseTransactions);
  const localMap = byId(localTransactions);
  const remoteMap = byId(remoteTransactions);
  const allIds = new Set<string>([
    ...baseMap.keys(),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ]);
  const mergedMap = new Map<string, NormalizedTransaction>();

  allIds.forEach((txId) => {
    const baseTx = baseMap.get(txId);
    const localTx = localMap.get(txId);
    const remoteTx = remoteMap.get(txId);

    // New transaction from either side (not present in base): keep whichever exists.
    if (!baseTx) {
      if (localTx && remoteTx) {
        // Same ID added on both sides: choose the newer timestamp snapshot.
        mergedMap.set(
          txId,
          localTx.date.getTime() >= remoteTx.date.getTime()
            ? localTx
            : remoteTx,
        );
      } else if (localTx) {
        mergedMap.set(txId, localTx);
      } else if (remoteTx) {
        mergedMap.set(txId, remoteTx);
      }
      return;
    }

    const baseSnapshot = transactionSnapshot(baseTx);
    const localSnapshot = localTx ? transactionSnapshot(localTx) : null;
    const remoteSnapshot = remoteTx ? transactionSnapshot(remoteTx) : null;

    const localTouched = localTx ? localSnapshot !== baseSnapshot : true;
    const remoteTouched = remoteTx ? remoteSnapshot !== baseSnapshot : true;

    if (!localTouched && !remoteTouched) {
      mergedMap.set(txId, localTx ?? remoteTx ?? baseTx);
      return;
    }

    if (localTouched && !remoteTouched) {
      if (localTx) {
        mergedMap.set(txId, localTx);
      }
      return;
    }

    if (!localTouched && remoteTouched) {
      // Data-loss guard: when remote is missing this tx but local is still unchanged from base,
      // keep the local/base copy to prevent accidental disappearance from stale overwrites.
      if (!remoteTx) {
        mergedMap.set(txId, localTx ?? baseTx);
      } else {
        mergedMap.set(txId, remoteTx);
      }
      return;
    }

    // Both sides touched.
    if (!localTx && !remoteTx) {
      return;
    }
    if (!localTx && remoteTx) {
      mergedMap.set(txId, remoteTx);
      return;
    }
    if (localTx && !remoteTx) {
      mergedMap.set(txId, localTx);
      return;
    }

    // Both changed and both exist: if different, prefer newer tx timestamp.
    const resolvedLocalTx = localTx as NormalizedTransaction;
    const resolvedRemoteTx = remoteTx as NormalizedTransaction;
    if (localSnapshot === remoteSnapshot) {
      mergedMap.set(txId, resolvedLocalTx);
      return;
    }
    mergedMap.set(
      txId,
      resolvedLocalTx.date.getTime() >= resolvedRemoteTx.date.getTime()
        ? resolvedLocalTx
        : resolvedRemoteTx,
    );
  });

  return sortTransactionsByDateAsc([...mergedMap.values()]);
}

function mergeEntitiesByThreeWay(
  baseEntitiesRaw: EntityDataset[],
  localEntitiesRaw: EntityDataset[],
  remoteEntitiesRaw: EntityDataset[],
): EntityDataset[] {
  const baseEntities = baseEntitiesRaw.map((entity, index) =>
    normalizeEntityForSync(entity, index),
  );
  const localEntities = localEntitiesRaw.map((entity, index) =>
    normalizeEntityForSync(entity, index),
  );
  const remoteEntities = remoteEntitiesRaw.map((entity, index) =>
    normalizeEntityForSync(entity, index),
  );

  const mapById = (rows: EntityDataset[]): Map<string, EntityDataset> => {
    const map = new Map<string, EntityDataset>();
    rows.forEach((row) => {
      map.set(row.id, row);
    });
    return map;
  };

  const baseMap = mapById(baseEntities);
  const localMap = mapById(localEntities);
  const mergedMap = mapById(remoteEntities);

  // Apply local portfolio add/update operations over remote.
  localMap.forEach((localEntity, portfolioId) => {
    const baseEntity = baseMap.get(portfolioId);
    const remoteEntity = mergedMap.get(portfolioId);

    if (!baseEntity) {
      mergedMap.set(portfolioId, localEntity);
      return;
    }

    const mergedTransactions = mergeTransactionsByThreeWay(
      baseEntity.transactions,
      localEntity.transactions,
      remoteEntity?.transactions ?? [],
    );
    const mergedStockerProMeta = mergeStockerProMetaByThreeWay(
      baseEntity.stockerProMeta,
      localEntity.stockerProMeta,
      remoteEntity?.stockerProMeta,
    );

    const name =
      baseEntity.name !== localEntity.name
        ? localEntity.name
        : (remoteEntity?.name ?? localEntity.name);
    const currency =
      baseEntity.currency !== localEntity.currency
        ? localEntity.currency
        : (remoteEntity?.currency ?? localEntity.currency);

    mergedMap.set(portfolioId, {
      id: portfolioId,
      name,
      currency,
      transactions: mergedTransactions,
      latestPriceBySymbol: buildLatestPriceBySymbol(mergedTransactions),
      stockerProMeta: mergedStockerProMeta,
    });
  });

  // Apply local portfolio deletions relative to the base snapshot.
  baseMap.forEach((_, portfolioId) => {
    if (!localMap.has(portfolioId)) {
      mergedMap.delete(portfolioId);
    }
  });

  const orderedIds: string[] = [];
  localEntities.forEach((entity) => {
    if (!orderedIds.includes(entity.id)) {
      orderedIds.push(entity.id);
    }
  });
  remoteEntities.forEach((entity) => {
    if (!orderedIds.includes(entity.id)) {
      orderedIds.push(entity.id);
    }
  });

  return orderedIds
    .map((id) => mergedMap.get(id))
    .filter((entity): entity is EntityDataset => Boolean(entity))
    .map((entity, index) => normalizeEntityForSync(entity, index));
}

function buildSyncSummary(entities: EntityDataset[]): Record<string, unknown> {
  const txCount = entities.reduce(
    (total, entity) => total + entity.transactions.length,
    0,
  );
  const latestTxMs = entities
    .flatMap((entity) => entity.transactions.map((tx) => tx.date.getTime()))
    .filter((ms) => Number.isFinite(ms))
    .reduce((max, ms) => (ms > max ? ms : max), 0);
  return {
    portfolios: entities.length,
    transactions: txCount,
    latestTxAt: latestTxMs > 0 ? new Date(latestTxMs).toISOString() : null,
  };
}

function cloneEntitiesForReview(entities: EntityDataset[]): EntityDataset[] {
  return entities.map((entity) => ({
    ...entity,
    latestPriceBySymbol: { ...entity.latestPriceBySymbol },
    transactions: entity.transactions.map((tx) => ({
      ...tx,
      date: new Date(tx.date),
    })),
  }));
}

function normalizeReviewEntities(entities: EntityDataset[]): EntityDataset[] {
  const usedPortfolioIds = new Set<string>();
  return entities
    .map((entity, index) => {
      const portfolioCurrency = normalizeCurrencyCode(entity.currency) || "USD";
      const portfolioId = buildSafePortfolioId(
        entity.id,
        `portfolio-${index + 1}`,
        usedPortfolioIds,
      );
      const portfolioName = entity.name.trim() || `Portfolio ${index + 1}`;

      const transactions = entity.transactions
        .map((tx, txIndex) => {
          const date = Number.isFinite(tx.date.getTime())
            ? new Date(tx.date)
            : new Date();
          const type = tx.type;
          const currency =
            normalizeCurrencyCode(tx.currency) || portfolioCurrency;
          let symbol = tx.symbol.trim().toUpperCase();
          if (shouldUseCurrencyAsSymbol(type) && !symbol) {
            symbol = currency;
          }
          if (!symbol) {
            return null;
          }

          return {
            id: tx.id || `tx-${portfolioId}-${txIndex + 1}`,
            date,
            symbol,
            type,
            shares: Number.isFinite(tx.shares) ? tx.shares : 0,
            price: Number.isFinite(tx.price) ? tx.price : 0,
            fee: Number.isFinite(tx.fee) ? tx.fee : 0,
            currency,
            note: tx.note ?? "",
          } as NormalizedTransaction;
        })
        .filter((tx): tx is NormalizedTransaction => Boolean(tx));

      const sorted = sortTransactionsByDateAsc(transactions);
      return {
        id: portfolioId,
        name: portfolioName,
        currency: portfolioCurrency,
        transactions: sorted,
        latestPriceBySymbol: buildLatestPriceBySymbol(sorted),
      };
    })
    .filter(
      (entity) =>
        entity.transactions.length > 0 || entity.name.trim().length > 0,
    );
}

function normalizePortfolioIdsForUi(entities: EntityDataset[]): {
  normalizedEntities: EntityDataset[];
  idMap: Map<string, string>;
  changed: boolean;
} {
  const usedIds = new Set<string>();
  const idMap = new Map<string, string>();
  let changed = false;

  const normalizedEntities = entities.map((entity, index) => {
    const safeId = buildSafePortfolioId(
      entity.id,
      `portfolio-${index + 1}`,
      usedIds,
    );
    if (safeId !== entity.id) {
      changed = true;
    }
    if (!idMap.has(entity.id)) {
      idMap.set(entity.id, safeId);
    }
    return {
      ...entity,
      id: safeId,
    };
  });

  return { normalizedEntities, idMap, changed };
}

function buildImportBatchRawText(items: ImportBatchItem[]): string {
  if (items.length === 1) {
    return items[0].rawText;
  }
  return items
    .map((item) =>
      [`[STOCKER_IMPORT_FILE] ${item.fileName}`, item.rawText].join("\n"),
    )
    .join("\n\n");
}

function mergeImportBatchEntities(items: ImportBatchItem[]): EntityDataset[] {
  const portfolioMap = new Map<string, EntityDataset>();
  const transactionSignaturesByPortfolio = new Map<string, Set<string>>();
  const usedPortfolioIds = new Set<string>();

  items.forEach((item, itemIndex) => {
    item.entities.forEach((entity, entityIndex) => {
      const currency = normalizeCurrencyCode(entity.currency) || "USD";
      const trimmedId = entity.id.trim();
      const portfolioName =
        entity.name.trim() || `Portfolio ${portfolioMap.size + 1}`;
      const portfolioKey = trimmedId
        ? `id:${trimmedId.toUpperCase()}`
        : `name:${portfolioName.toLowerCase()}|currency:${currency}`;

      if (!portfolioMap.has(portfolioKey)) {
        const safeId = buildSafePortfolioId(
          trimmedId,
          `portfolio-import-${portfolioMap.size + 1}`,
          usedPortfolioIds,
        );
        portfolioMap.set(portfolioKey, {
          id: safeId,
          name: portfolioName,
          currency,
          transactions: [],
          latestPriceBySymbol: {},
        });
        transactionSignaturesByPortfolio.set(portfolioKey, new Set<string>());
      }

      const targetPortfolio = portfolioMap.get(portfolioKey);
      const signatures = transactionSignaturesByPortfolio.get(portfolioKey);
      if (!targetPortfolio || !signatures) {
        return;
      }

      entity.transactions.forEach((tx) => {
        const date = Number.isFinite(tx.date.getTime())
          ? new Date(tx.date)
          : new Date();
        const symbol = tx.symbol.trim().toUpperCase();
        const txCurrency = normalizeCurrencyCode(tx.currency) || currency;

        if (!symbol) {
          return;
        }

        const normalizedTxBase: Omit<NormalizedTransaction, "id"> = {
          date,
          symbol,
          type: tx.type,
          shares: Number.isFinite(tx.shares) ? tx.shares : 0,
          price: Number.isFinite(tx.price) ? tx.price : 0,
          fee: Number.isFinite(tx.fee) ? tx.fee : 0,
          currency: txCurrency,
          note: tx.note ?? "",
        };

        const signature = transactionSnapshot({
          id: "__sig__",
          ...normalizedTxBase,
        });
        if (signatures.has(signature)) {
          return;
        }
        signatures.add(signature);

        const uniqueIndex = targetPortfolio.transactions.length + 1;
        const dateKey = Number.isFinite(date.getTime())
          ? date.getTime()
          : Date.now();
        targetPortfolio.transactions.push({
          id: `imp-${targetPortfolio.id}-${itemIndex + 1}-${entityIndex + 1}-${uniqueIndex}-${dateKey}`,
          ...normalizedTxBase,
        });
      });
    });
  });

  return Array.from(portfolioMap.values()).map((entity, index) =>
    normalizeEntityForSync(entity, index),
  );
}

function buildDefaultDraft(
  portfolioId: string,
  currency: string,
): TransactionDraft {
  const normalizedCurrency = normalizeCurrencyCode(currency) || "USD";
  const district = inferDistrictFromCurrency(normalizedCurrency);
  return {
    id: `tx-${Date.now()}`,
    portfolioId,
    date: toDateInputValue(new Date()),
    type: "BUY",
    district,
    symbol: "",
    shares: "0",
    price: "0",
    fee: "0",
    currency: normalizedCurrency,
    note: "",
  };
}

function buildDefaultNewPortfolioDraft(
  defaultCurrency: string,
): NewPortfolioDraft {
  return {
    name: "",
    currencyType: normalizeCurrencyCode(defaultCurrency) || "USD",
  };
}

function cascadeDeletePortfolioEntity(entity: EntityDataset): EntityDataset {
  if (!entity.stockerProMeta) {
    return {
      ...entity,
      transactions: [],
      latestPriceBySymbol: {},
    };
  }

  // 1) Delete assets. 2) Delete positions attached to deleted assets.
  const afterAssetAndPositionDelete: EntityDataset = {
    ...entity,
    stockerProMeta: {
      ...entity.stockerProMeta,
      assetsBySymbol: {},
      positionsById: {},
      positionIdsByAssetId: {},
    },
  };

  // 3) Delete cash assets.
  const afterCashDelete: EntityDataset = {
    ...afterAssetAndPositionDelete,
    stockerProMeta: {
      ...afterAssetAndPositionDelete.stockerProMeta!,
      cashAssetsByCurrency: {},
    },
  };

  // 4) Delete activities.
  return {
    ...afterCashDelete,
    transactions: [],
    latestPriceBySymbol: {},
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
  const [selectedPortfolioLineId, setSelectedPortfolioLineId] =
    useState<PortfolioLineId>("totalMarketValue");

  const [txTypeFilter, setTxTypeFilter] =
    useState<TransactionTypeFilter>("all");
  const [txDateFilter, setTxDateFilter] = useState<DateFilterPreset>("all");
  const [txCustomStart, setTxCustomStart] = useState("");
  const [txCustomEnd, setTxCustomEnd] = useState("");
  const [txKeyword, setTxKeyword] = useState("");

  const [holdingSearch, setHoldingSearch] = useState("");
  const [holdingSort, setHoldingSort] = useState<
    "marketValue" | "profit" | "symbol"
  >("marketValue");

  const [isTxModalOpen, setTxModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] =
    useState<TransactionRow | null>(null);
  const [draft, setDraft] = useState<TransactionDraft>(
    buildDefaultDraft("", "USD"),
  );
  const [isNewPortfolioModalOpen, setNewPortfolioModalOpen] = useState(false);
  const [newPortfolioDraft, setNewPortfolioDraft] = useState<NewPortfolioDraft>(
    buildDefaultNewPortfolioDraft(DEFAULT_SETTINGS.defaultCurrency),
  );
  const [newPortfolioError, setNewPortfolioError] = useState("");
  const [transactionError, setTransactionError] = useState("");
  const [pendingCashReview, setPendingCashReview] =
    useState<PendingCashReview | null>(null);
  const [pendingCashAmount, setPendingCashAmount] = useState("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [importStatusMessage, setImportStatusMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [isEntryUploadDragOver, setEntryUploadDragOver] = useState(false);
  const [isDataUploadDragOver, setDataUploadDragOver] = useState(false);
  const [isImportReviewOpen, setImportReviewOpen] = useState(false);
  const [importReviewEntities, setImportReviewEntities] = useState<
    EntityDataset[]
  >([]);
  const [importReviewSource, setImportReviewSource] =
    useState<ImportReviewSource | null>(null);
  const [importReviewFeedback, setImportReviewFeedback] = useState("");
  const [importReviewError, setImportReviewError] = useState("");
  const [isImportReviewAdjusting, setImportReviewAdjusting] = useState(false);
  const [dataImportType, setDataImportType] = useState<UserType>("stockerpro");
  const [settings, setSettings] = useState<WebSettings>(DEFAULT_SETTINGS);
  const [selectedStockDetailId, setSelectedStockDetailId] = useState<
    string | null
  >(null);
  const [isQuoteSyncing, setQuoteSyncing] = useState(false);
  const [quoteSyncError, setQuoteSyncError] = useState("");
  const [quoteLastUpdatedAt, setQuoteLastUpdatedAt] = useState<Date | null>(
    null,
  );
  const [quoteSyncedCount, setQuoteSyncedCount] = useState(0);
  const [fxRateByPair, setFxRateByPair] = useState<Record<string, number>>({});
  const [fxSyncError, setFxSyncError] = useState("");
  const [fxLastUpdatedAt, setFxLastUpdatedAt] = useState<Date | null>(null);
  const [fxSyncedCount, setFxSyncedCount] = useState(0);
  const [valuationRange, setValuationRange] = useState<ChartRangePreset>("1Y");
  const [valuationCustomStart, setValuationCustomStart] = useState("");
  const [valuationCustomEnd, setValuationCustomEnd] = useState("");
  const [isValuationSyncing, setValuationSyncing] = useState(false);
  const [valuationSyncError, setValuationSyncError] = useState("");
  const [valuationLastUpdatedAt, setValuationLastUpdatedAt] =
    useState<Date | null>(null);
  const [valuationSeriesCache, setValuationSeriesCache] = useState<
    Record<string, PricePoint[]>
  >({});
  const [portfolioHistoryBySymbol, setPortfolioHistoryBySymbol] = useState<
    Record<string, PricePoint[]>
  >({});
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [isAuthLoading, setAuthLoading] = useState(true);
  const [hasAcceptedBetaRisk, setHasAcceptedBetaRisk] = useState(false);
  const [showBetaConsentModal, setShowBetaConsentModal] = useState(false);
  const [betaConsentChecked, setBetaConsentChecked] = useState(false);
  const [isCloudLoading, setCloudLoading] = useState(false);
  const [isCloudSaving, setCloudSaving] = useState(false);
  const [cloudStatusMessage, setCloudStatusMessage] = useState("");
  const [cloudErrorMessage, setCloudErrorMessage] = useState("");
  const [cloudLastSyncedAt, setCloudLastSyncedAt] = useState<Date | null>(null);
  const [isCloudReady, setCloudReady] = useState(false);
  const quoteSyncInFlightRef = useRef(false);
  const quoteLastRequestedAtRef = useRef(0);
  const quoteRetryTimeoutRef = useRef<number | null>(null);
  const portfolioHistorySyncInFlightRef = useRef(false);
  const portfolioHistoryLastRequestedAtRef = useRef(0);
  const portfolioHistoryAutoRequestedRef = useRef(false);
  const manualPortfolioSelectionRef = useRef<string | null>(null);
  const selectedPortfolioSetReasonRef = useRef("init");
  const selectedPortfolioLastValueRef = useRef(ALL_PORTFOLIO_ID);
  const fxRenderPreviewTraceKeyRef = useRef("");
  const cloudDocExistsRef = useRef(false);
  const cloudHydratingRef = useRef(false);
  const lastCloudSerializedRef = useRef("");
  const latestCloudUpdatedAtMsRef = useRef(0);
  const cloudPersistInFlightRef = useRef(false);
  const cloudPersistQueueRef = useRef<{
    user: User;
    entities: EntityDataset[];
    serialized: string;
  } | null>(null);

  const isZh = settings.language === "zh-HK";
  const localeTag = isZh ? "zh-HK" : "en-US";
  const t = useCallback(
    (en: string, zh: string): string => (isZh ? zh : en),
    [isZh],
  );
  const rangeTitle = (preset: ChartRangePreset): string =>
    isZh ? TIME_RANGE_TITLES_ZH[preset] : TIME_RANGE_TITLES[preset];
  const dateFilterLabel = (
    preset: DateFilterPreset,
    fallback: string,
  ): string => (isZh ? DATE_FILTER_LABELS_ZH[preset] : fallback);
  const setSelectedPortfolioIdWithTrace = useCallback(
    (nextPortfolioId: string, reason: string): void => {
      selectedPortfolioSetReasonRef.current = reason;
      if (ENABLE_PORTFOLIO_SELECTION_TRACE) {
        console.warn("[PORTFOLIO_TRACE:set]", {
          from: selectedPortfolioLastValueRef.current,
          to: nextPortfolioId,
          reason,
          stack: new Error().stack?.split("\n").slice(0, 6).join("\n"),
        });
      }
      setSelectedPortfolioId(nextPortfolioId);
    },
    [],
  );

  useEffect(() => {
    const previousId = selectedPortfolioLastValueRef.current;
    if (previousId === selectedPortfolioId) {
      return;
    }

    if (ENABLE_PORTFOLIO_SELECTION_TRACE) {
      console.warn("[PORTFOLIO_TRACE:changed]", {
        from: previousId,
        to: selectedPortfolioId,
        reason: selectedPortfolioSetReasonRef.current,
        screen,
        tab: activeTab,
        rememberedManual: manualPortfolioSelectionRef.current,
        portfolioIds: entities.map((entity) => entity.id),
      });
    }

    selectedPortfolioLastValueRef.current = selectedPortfolioId;
  }, [activeTab, entities, screen, selectedPortfolioId]);

  const persistCloudData = useCallback(
    async (
      signedInUser: User,
      localEntities: EntityDataset[],
      serializedEntities: string,
    ): Promise<void> => {
      if (!serializedEntities.trim()) {
        return;
      }

      setCloudSaving(true);
      setCloudErrorMessage("");
      syncTrace("persist:start", {
        uid: signedInUser.uid,
        ...buildSyncSummary(localEntities),
      });
      try {
        const docRef = doc(
          firestoreDb,
          firebaseDatabaseCollection,
          signedInUser.uid,
        );
        const baseEntities = safeDeserializeEntities(
          lastCloudSerializedRef.current,
        );
        syncTrace("persist:base", buildSyncSummary(baseEntities));

        const result = await runTransaction(
          firestoreDb,
          async (
            transaction,
          ): Promise<{
            mergedEntities: EntityDataset[];
            mergedSerialized: string;
          }> => {
            const snapshot = await transaction.get(docRef);
            const snapshotData = snapshot.data() as
              | Record<string, unknown>
              | undefined;
            const remoteDataValue = snapshotData?.data;
            const remoteRaw =
              typeof remoteDataValue === "string"
                ? remoteDataValue
                : remoteDataValue
                  ? JSON.stringify(remoteDataValue)
                  : "";

            const remoteEntities = snapshot.exists()
              ? await parseRemoteDatabasePayload(remoteRaw)
              : [];
            syncTrace("persist:remote", {
              exists: snapshot.exists(),
              ...buildSyncSummary(remoteEntities),
            });
            const mergedEntities = mergeEntitiesByThreeWay(
              baseEntities,
              localEntities,
              remoteEntities,
            );
            const mergedSerialized =
              serializeEntitiesForCloudSync(mergedEntities);
            syncTrace("persist:merged", buildSyncSummary(mergedEntities));
            const { stockerProJson } = buildDualFormatRecords(mergedEntities);
            console.log(
              "[cloud:push] payload to write:",
              JSON.parse(stockerProJson),
            );
            const compressed =
              await compressStringToDeflateBase64(stockerProJson);
            const payload: Record<string, unknown> = {
              data: compressed,
              updatedAt: serverTimestamp(),
            };
            if (!snapshot.exists()) {
              payload.createdAt = serverTimestamp();
            }
            transaction.set(docRef, payload, { merge: true });

            return {
              mergedEntities,
              mergedSerialized,
            };
          },
        );

        cloudDocExistsRef.current = true;
        lastCloudSerializedRef.current = result.mergedSerialized;

        if (result.mergedSerialized !== serializedEntities) {
          syncTrace(
            "persist:local-reconciled",
            buildSyncSummary(result.mergedEntities),
          );
          setEntities(result.mergedEntities);
        }

        const syncedAt = new Date();
        setCloudLastSyncedAt(syncedAt);
        setCloudStatusMessage(t("Cloud synced.", "雲端已同步。"));
        syncTrace("persist:done", {
          uid: signedInUser.uid,
          syncedAt: syncedAt.toISOString(),
        });
      } catch (error) {
        syncTrace("persist:error", {
          uid: signedInUser.uid,
          message: error instanceof Error ? error.message : String(error),
        });
        setCloudErrorMessage(
          error instanceof Error
            ? error.message
            : t("Cloud sync failed.", "雲端同步失敗。"),
        );
      } finally {
        setCloudSaving(false);
      }
    },
    [setSelectedPortfolioIdWithTrace, t],
  );

  const loadCloudData = useCallback(
    async (signedInUser: User): Promise<void> => {
      setCloudLoading(true);
      setCloudReady(false);
      setCloudErrorMessage("");
      setCloudStatusMessage(t("Cloud sync ready.", "雲端同步已準備。"));
      cloudHydratingRef.current = true;
      let readyForSync = true;

      try {
        const docRef = doc(
          firestoreDb,
          firebaseDatabaseCollection,
          signedInUser.uid,
        );
        const snapshot = await getDoc(docRef);

        if (!snapshot.exists()) {
          cloudDocExistsRef.current = false;
          setEntities([]);
          setSelectedPortfolioIdWithTrace(
            ALL_PORTFOLIO_ID,
            "loadCloudData:no-document",
          );
          setSelectedStockId("");
          setSelectedStockDetailId(null);
          setScreen("choose");
          setUserType(null);
          setCloudStatusMessage(
            t(
              "No cloud data yet. Your next changes will create it.",
              "雲端暫時冇資料，你下一次更改會建立。",
            ),
          );
          setCloudReady(true);
          return;
        }

        cloudDocExistsRef.current = true;
        const snapshotData = snapshot.data() as Record<string, unknown>;
        const remoteDataValue = snapshotData.data;
        const remoteRaw =
          typeof remoteDataValue === "string"
            ? remoteDataValue
            : remoteDataValue
              ? JSON.stringify(remoteDataValue)
              : "";

        const parsedEntities = await parseRemoteDatabasePayload(remoteRaw);
        if (parsedEntities.length > 0) {
          setEntities(parsedEntities);
          setSelectedPortfolioIdWithTrace(
            ALL_PORTFOLIO_ID,
            "loadCloudData:parsed-entities",
          );
          setSelectedStockId("");
          setSelectedStockDetailId(null);
          setSelectedRange("1Y");
          setUserType("stockerpro");
          setScreen("dashboard");
          setSettings((previous) => {
            if (normalizeCurrencyCode(previous.displayCurrency) !== "AUTO") {
              return previous;
            }
            const preferred = normalizeCurrencyCode(
              parsedEntities[0]?.currency,
            );
            if (!preferred || preferred === "AUTO") {
              return previous;
            }
            return {
              ...previous,
              displayCurrency: preferred,
            };
          });
          lastCloudSerializedRef.current =
            serializeEntitiesForCloudSync(parsedEntities);
          setCloudStatusMessage(
            t("Cloud portfolio loaded.", "已載入雲端投資組合。"),
          );
        } else {
          setEntities([]);
          setSelectedPortfolioIdWithTrace(
            ALL_PORTFOLIO_ID,
            "loadCloudData:parsed-empty",
          );
          setSelectedStockId("");
          setSelectedStockDetailId(null);
          setScreen("choose");
          setUserType(null);
          setCloudErrorMessage(
            t(
              "Cloud data exists but cannot be parsed. You can import manually and overwrite.",
              "雲端資料存在但未能解析，你可先手動匯入再覆蓋。",
            ),
          );
          readyForSync = false;
        }

        const updatedAt = snapshotData.updatedAt as
          | { toDate?: () => Date }
          | undefined;
        if (updatedAt && typeof updatedAt.toDate === "function") {
          const updatedAtDate = updatedAt.toDate();
          setCloudLastSyncedAt(updatedAtDate);
          latestCloudUpdatedAtMsRef.current = Math.max(
            latestCloudUpdatedAtMsRef.current,
            updatedAtDate.getTime(),
          );
        }
      } catch (error) {
        setCloudErrorMessage(
          error instanceof Error
            ? error.message
            : t("Failed to load cloud data.", "載入雲端資料失敗。"),
        );
      } finally {
        cloudHydratingRef.current = false;
        setCloudReady(readyForSync);
        setCloudLoading(false);
      }
    },
    [t],
  );

  const onGoogleSignIn = useCallback(async (): Promise<void> => {
    setCloudErrorMessage("");
    try {
      await signInWithPopup(firebaseAuth, googleProvider);
    } catch (error) {
      setCloudErrorMessage(
        error instanceof Error
          ? error.message
          : t("Google sign-in failed.", "Google 登入失敗。"),
      );
    }
  }, [setSelectedPortfolioIdWithTrace, t]);

  const drainCloudPersistQueue = useCallback(async (): Promise<void> => {
    if (cloudPersistInFlightRef.current) {
      return;
    }

    while (cloudPersistQueueRef.current) {
      const nextPayload = cloudPersistQueueRef.current;
      cloudPersistQueueRef.current = null;
      cloudPersistInFlightRef.current = true;

      try {
        syncTrace("persist:flush", buildSyncSummary(nextPayload.entities));
        await persistCloudData(
          nextPayload.user,
          nextPayload.entities,
          nextPayload.serialized,
        );
      } finally {
        cloudPersistInFlightRef.current = false;
      }
    }
  }, [persistCloudData]);

  const queueCloudPersistForEntities = useCallback(
    (nextEntities: EntityDataset[]): void => {
      if (
        !authUser ||
        isAuthLoading ||
        !isCloudReady ||
        cloudHydratingRef.current ||
        screen !== "dashboard"
      ) {
        return;
      }
      const serialized = serializeEntitiesForCloudSync(nextEntities);
      if (!serialized.trim() || serialized === lastCloudSerializedRef.current) {
        return;
      }
      cloudPersistQueueRef.current = {
        user: authUser,
        entities: nextEntities,
        serialized,
      };
      syncTrace("persist:queued:portfolio-mutation", buildSyncSummary(nextEntities));
      void drainCloudPersistQueue();
    },
    [authUser, drainCloudPersistQueue, isAuthLoading, isCloudReady, screen],
  );

  const openLoginFlow = (): void => {
    if (hasAcceptedBetaRisk) {
      void onGoogleSignIn();
      return;
    }
    setBetaConsentChecked(false);
    setShowBetaConsentModal(true);
  };

  const confirmBetaRiskAndSignIn = (): void => {
    if (!betaConsentChecked) {
      return;
    }
    localStorage.setItem(BETA_CONSENT_STORAGE_KEY, "1");
    setHasAcceptedBetaRisk(true);
    setShowBetaConsentModal(false);
    void onGoogleSignIn();
  };

  const onSignOut = useCallback(async (): Promise<void> => {
    try {
      await signOut(firebaseAuth);
      setEntities([]);
      setSelectedPortfolioIdWithTrace(ALL_PORTFOLIO_ID, "auth:sign-out");
      setSelectedStockId("");
      setSelectedStockDetailId(null);
      setScreen("choose");
      setUserType(null);
      setImportStatusMessage("");
      setCloudStatusMessage(t("Signed out.", "已登出。"));
      localStorage.removeItem(STORAGE_KEY);
      lastCloudSerializedRef.current = "";
      cloudDocExistsRef.current = false;
      latestCloudUpdatedAtMsRef.current = 0;
      setCloudReady(false);
    } catch (error) {
      setCloudErrorMessage(
        error instanceof Error
          ? error.message
          : t("Sign out failed.", "登出失敗。"),
      );
    }
  }, [t]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(firebaseAuth, (nextUser) => {
      setAuthUser(nextUser);
      setAuthLoading(false);

      if (!nextUser) {
        setCloudReady(false);
        setCloudLoading(false);
        setCloudSaving(false);
        setCloudStatusMessage("");
        setCloudLastSyncedAt(null);
        cloudDocExistsRef.current = false;
        latestCloudUpdatedAtMsRef.current = 0;
        return;
      }

      void loadCloudData(nextUser);
    });

    return () => unsubscribe();
  }, [loadCloudData]);

  useEffect(() => {
    if (!authUser || isAuthLoading || !isCloudReady) {
      return;
    }

    const docRef = doc(firestoreDb, firebaseDatabaseCollection, authUser.uid);
    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        void (async () => {
          syncTrace("snapshot:received", {
            uid: authUser.uid,
            exists: snapshot.exists(),
          });
          if (!snapshot.exists()) {
            cloudDocExistsRef.current = false;
            return;
          }

          cloudDocExistsRef.current = true;
          const snapshotData = snapshot.data() as Record<string, unknown>;
          const updatedAt = snapshotData.updatedAt as
            | { toDate?: () => Date }
            | undefined;
          if (!updatedAt || typeof updatedAt.toDate !== "function") {
            return;
          }
          const snapshotUpdatedAt = updatedAt.toDate();
          const snapshotUpdatedAtMs = snapshotUpdatedAt.getTime();
          if (snapshotUpdatedAtMs <= latestCloudUpdatedAtMsRef.current) {
            syncTrace("snapshot:ignored-old", {
              uid: authUser.uid,
              snapshotUpdatedAt: snapshotUpdatedAt.toISOString(),
              latestKnownUpdatedAt:
                latestCloudUpdatedAtMsRef.current > 0
                  ? new Date(latestCloudUpdatedAtMsRef.current).toISOString()
                  : null,
            });
            return;
          }

          latestCloudUpdatedAtMsRef.current = snapshotUpdatedAtMs;
          const remoteDataValue = snapshotData.data;
          const remoteRaw =
            typeof remoteDataValue === "string"
              ? remoteDataValue
              : remoteDataValue
                ? JSON.stringify(remoteDataValue)
                : "";

          const remoteEntities = await parseRemoteDatabasePayload(remoteRaw);
          if (remoteEntities.length === 0) {
            syncTrace("snapshot:empty-remote", { uid: authUser.uid });
            return;
          }
          syncTrace("snapshot:remote", {
            uid: authUser.uid,
            updatedAt: snapshotUpdatedAt.toISOString(),
            ...buildSyncSummary(remoteEntities),
          });

          const remoteSerialized =
            serializeEntitiesForCloudSync(remoteEntities);
          if (!remoteSerialized.trim()) {
            syncTrace("snapshot:empty-serialized", { uid: authUser.uid });
            return;
          }

          const baseSerialized = lastCloudSerializedRef.current;
          const baseEntities = safeDeserializeEntities(baseSerialized);

          // Keep base as actual cloud snapshot so any pending local edits still flush afterward.
          lastCloudSerializedRef.current = remoteSerialized;

          if (screen !== "dashboard") {
            const mergedEntities = mergeEntitiesByThreeWay(
              baseEntities,
              [],
              remoteEntities,
            );
            syncTrace("snapshot:apply-non-dashboard", {
              uid: authUser.uid,
              ...buildSyncSummary(mergedEntities),
            });
            setEntities(mergedEntities);
            setSelectedPortfolioIdWithTrace(
              ALL_PORTFOLIO_ID,
              "snapshot:apply-non-dashboard",
            );
            setSelectedStockId("");
            setSelectedStockDetailId(null);
            setUserType("stockerpro");
            setScreen("dashboard");
          } else {
            setEntities((currentEntities) => {
              const localSerialized =
                serializeEntitiesForCloudSync(currentEntities);
              const mergedEntities = mergeEntitiesByThreeWay(
                baseEntities,
                currentEntities,
                remoteEntities,
              );
              const mergedSerialized =
                serializeEntitiesForCloudSync(mergedEntities);
              if (mergedSerialized === localSerialized) {
                syncTrace("snapshot:no-change", { uid: authUser.uid });
                return currentEntities;
              }
              syncTrace("snapshot:apply-dashboard", {
                uid: authUser.uid,
                local: buildSyncSummary(currentEntities),
                merged: buildSyncSummary(mergedEntities),
              });
              return mergedEntities;
            });
          }

          setCloudLastSyncedAt(snapshotUpdatedAt);
        })();
      },
      (error) => {
        syncTrace("snapshot:error", {
          uid: authUser.uid,
          message: error instanceof Error ? error.message : String(error),
        });
        setCloudErrorMessage(
          error instanceof Error
            ? error.message
            : t("Cloud realtime sync failed.", "雲端即時同步失敗。"),
        );
      },
    );

    return () => unsubscribe();
  }, [authUser, isAuthLoading, isCloudReady, screen, t]);

  useEffect(() => {
    if (isAuthLoading) {
      return;
    }
    if (authUser) {
      return;
    }
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
  }, [authUser, isAuthLoading]);

  useEffect(() => {
    const loaded = loadWebSettings();
    setSettings(loaded);
    setDataImportType(loaded.defaultImportType);
  }, []);

  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const accepted = localStorage.getItem(BETA_CONSENT_STORAGE_KEY) === "1";
    setHasAcceptedBetaRisk(accepted);
  }, []);

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

  useEffect(() => {
    queueCloudPersistForEntities(entities);
  }, [entities, queueCloudPersistForEntities]);

  const filteredEntities = useMemo(() => {
    if (selectedPortfolioId === "all") {
      return entities;
    }
    return entities.filter((entity) => entity.id === selectedPortfolioId);
  }, [entities, selectedPortfolioId]);

  const normalizedDisplayCurrency = useMemo(() => {
    const normalized = normalizeCurrencyCode(settings.displayCurrency);
    return normalized || "AUTO";
  }, [settings.displayCurrency]);

  const convertAmountToDisplay = useCallback(
    (value: number, sourceCurrency: string): number => {
      const from = normalizeCurrencyCode(sourceCurrency) || "USD";
      if (
        normalizedDisplayCurrency === "AUTO" ||
        from === normalizedDisplayCurrency
      ) {
        return value;
      }

      const rate = resolveFxRateFromPairMap(
        fxRateByPair,
        from,
        normalizedDisplayCurrency,
      );
      if (rate && Number.isFinite(rate) && rate > 0) {
        return value * rate;
      }

      return value;
    },
    [fxRateByPair, normalizedDisplayCurrency],
  );

  const calculationConversion = useMemo<
    CalculationConversionOptions | undefined
  >(() => {
    if (normalizedDisplayCurrency === "AUTO") {
      return undefined;
    }
    return {
      targetCurrency: normalizedDisplayCurrency,
      convertAmount: convertAmountToDisplay,
    };
  }, [convertAmountToDisplay, normalizedDisplayCurrency]);

  const portfolioOverviewCalculationOptions = useMemo<
    CalculationConversionOptions | undefined
  >(() => {
    if (
      !calculationConversion &&
      Object.keys(portfolioHistoryBySymbol).length === 0
    ) {
      return undefined;
    }
    return {
      ...(calculationConversion ?? {}),
      historicalPriceBySymbol: portfolioHistoryBySymbol,
    };
  }, [calculationConversion, portfolioHistoryBySymbol]);

  const portfolioSummary = useMemo(
    () =>
      calculatePortfolioSummary(
        filteredEntities,
        portfolioOverviewCalculationOptions,
      ),
    [filteredEntities, portfolioOverviewCalculationOptions],
  );

  useEffect(() => {
    if (!ENABLE_SYNC_TRACE || normalizedDisplayCurrency === "AUTO") {
      return;
    }

    const discoveredCurrencies = new Set<string>();
    entities.forEach((entity) => {
      discoveredCurrencies.add(normalizeCurrencyCode(entity.currency));
      entity.transactions.forEach((tx) =>
        discoveredCurrencies.add(normalizeCurrencyCode(tx.currency)),
      );
    });

    const sample100ByCurrency: Record<string, number> = {};
    [...discoveredCurrencies]
      .filter((currency) => currency && currency !== normalizedDisplayCurrency)
      .slice(0, 10)
      .forEach((currency) => {
        sample100ByCurrency[`${currency}->${normalizedDisplayCurrency}`] =
          convertAmountToDisplay(100, currency);
      });

    const rawSummary = calculatePortfolioSummary(filteredEntities);
    const traceKey = JSON.stringify({
      targetCurrency: normalizedDisplayCurrency,
      fxRateByPair,
      sample100ByCurrency,
      rawTotalAssets: rawSummary.totalAssets,
      shownTotalAssets: portfolioSummary.totalAssets,
    });
    if (traceKey === fxRenderPreviewTraceKeyRef.current) {
      return;
    }
    fxRenderPreviewTraceKeyRef.current = traceKey;

    syncTrace("fx:render:preview", {
      targetCurrency: normalizedDisplayCurrency,
      fxRateByPair,
      sample100ByCurrency,
      rawTotalAssets: rawSummary.totalAssets,
      rawCurrency: rawSummary.currency,
      shownTotalAssets: portfolioSummary.totalAssets,
      shownCurrency: portfolioSummary.currency,
    });
  }, [
    convertAmountToDisplay,
    entities,
    filteredEntities,
    fxRateByPair,
    normalizedDisplayCurrency,
    portfolioSummary.currency,
    portfolioSummary.totalAssets,
  ]);

  const cashBalances = useMemo(
    () => calculateCashBalances(filteredEntities),
    [filteredEntities],
  );

  const displayCurrencyOptions = useMemo(() => {
    const available = new Set<string>(COMMON_CURRENCY_CODES);
    available.add(normalizeCurrencyCode(settings.defaultCurrency));
    available.add(normalizedDisplayCurrency);
    available.add(normalizeCurrencyCode(portfolioSummary.currency));

    entities.forEach((entity) => {
      available.add(normalizeCurrencyCode(entity.currency));
      entity.transactions.forEach((tx) => {
        available.add(normalizeCurrencyCode(tx.currency));
      });
    });

    return [...available]
      .filter(
        (currency) =>
          currency && currency !== "AUTO" && isValidCurrencyCode(currency),
      )
      .sort((a, b) => a.localeCompare(b));
  }, [
    entities,
    normalizedDisplayCurrency,
    portfolioSummary.currency,
    settings.defaultCurrency,
  ]);

  const fxSourceCurrencies = useMemo(() => {
    if (normalizedDisplayCurrency === "AUTO") {
      return [];
    }

    const sourceSet = new Set<string>();
    sourceSet.add(normalizeCurrencyCode(portfolioSummary.currency));
    entities.forEach((entity) => {
      sourceSet.add(normalizeCurrencyCode(entity.currency));
      entity.transactions.forEach((tx) => {
        sourceSet.add(normalizeCurrencyCode(tx.currency));
      });
    });

    return [...sourceSet]
      .filter(
        (currency) =>
          currency &&
          currency !== normalizedDisplayCurrency &&
          currency !== "AUTO" &&
          isValidCurrencyCode(currency),
      )
      .sort((a, b) => a.localeCompare(b));
  }, [entities, normalizedDisplayCurrency, portfolioSummary.currency]);

  const stockBreakdown = useMemo(
    () => calculateStockBreakdown(filteredEntities),
    [filteredEntities],
  );

  const portfolioStockSymbolKey = useMemo(
    () => collectPortfolioStockSymbols(entities).join("|"),
    [entities],
  );

  const stockLeaderboard = useMemo(
    () =>
      [...stockBreakdown].sort(
        (a, b) =>
          convertAmountToDisplay(b.totalProfit, b.currency) -
          convertAmountToDisplay(a.totalProfit, a.currency),
      ),
    [convertAmountToDisplay, stockBreakdown],
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
        return (
          convertAmountToDisplay(b.totalProfit, b.currency) -
          convertAmountToDisplay(a.totalProfit, a.currency)
        );
      }
      return (
        Math.abs(convertAmountToDisplay(b.marketValue, b.currency)) -
        Math.abs(convertAmountToDisplay(a.marketValue, a.currency))
      );
    });
  }, [convertAmountToDisplay, holdingSearch, holdingSort, holdingStocks]);

  const displayedClosedStocks = useMemo(() => {
    const keyword = holdingSearch.trim().toUpperCase();
    return closedStocks.filter((item) =>
      keyword ? item.symbol.includes(keyword) : true,
    );
  }, [closedStocks, holdingSearch]);

  const selectedStock =
    stockLeaderboard.find((metric) => metric.id === selectedStockId) ??
    stockLeaderboard[0] ??
    null;

  const portfolioBounds = useMemo(() => {
    const sortedDates = filteredEntities
      .flatMap((entity) => entity.transactions.map((tx) => startOfDay(tx.date)))
      .filter((date) => Number.isFinite(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    if (sortedDates.length === 0) {
      return null;
    }

    const firstDate = sortedDates[0];
    const firstModernDate = sortedDates.find(
      (date) => date.getFullYear() > 1970,
    );
    const gapYears = firstModernDate
      ? (firstModernDate.getTime() - firstDate.getTime()) /
        (86_400_000 * 365.25)
      : 0;
    const minDate =
      firstModernDate && firstDate.getFullYear() <= 1970 && gapYears >= 20
        ? firstModernDate
        : firstDate;

    return {
      minDate,
      maxDate: startOfDay(new Date()),
    };
  }, [filteredEntities]);

  const allTransactions = useMemo(() => {
    const rows: TransactionRow[] = [];

    filteredEntities.forEach((entity) => {
      entity.transactions.forEach((tx) => {
        rows.push({
          ...tx,
          portfolioId: entity.id,
          portfolioName: entity.name,
          assetName: resolveAssetNameForTransaction(entity, tx),
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

      const passDate = isDateInPresetRange(
        tx.date,
        txDateFilter,
        txCustomStart,
        txCustomEnd,
      );
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
  }, [
    allTransactions,
    txCustomEnd,
    txCustomStart,
    txDateFilter,
    txKeyword,
    txTypeFilter,
  ]);

  const transactionNetValue = useMemo(
    () =>
      filteredTransactions.reduce(
        (total, tx) => total + getTransactionNetCashFlow(tx),
        0,
      ),
    [filteredTransactions],
  );

  const importReviewRows = useMemo(() => {
    const rows: ImportReviewRow[] = [];
    importReviewEntities.forEach((entity) => {
      entity.transactions.forEach((tx) => {
        rows.push({
          ...tx,
          portfolioId: entity.id,
          portfolioName: entity.name,
        });
      });
    });
    return rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [importReviewEntities]);

  const importReviewTxCount = useMemo(
    () => importReviewRows.length,
    [importReviewRows],
  );

  const currentRange = useMemo(
    () => ({
      preset: selectedRange,
      startDate:
        selectedRange === "CUSTOM" ? parseDateInput(customStart) : undefined,
      endDate:
        selectedRange === "CUSTOM" ? parseDateInput(customEnd) : undefined,
    }),
    [customEnd, customStart, selectedRange],
  );

  const portfolioProfitSeries = useMemo(
    () => calculatePortfolioProfitSeries(filteredEntities, currentRange),
    [currentRange, filteredEntities],
  );
  const portfolioOverviewSeries = useMemo(
    () =>
      calculatePortfolioOverviewSeries(
        filteredEntities,
        currentRange,
        portfolioOverviewCalculationOptions,
      ),
    [currentRange, filteredEntities, portfolioOverviewCalculationOptions],
  );
  const portfolioOverviewLatest = useMemo(
    () => portfolioOverviewSeries[portfolioOverviewSeries.length - 1] ?? null,
    [portfolioOverviewSeries],
  );
  const assetAllocation = useMemo(
    () =>
      calculateAssetAllocationSegments(
        filteredEntities,
        8,
        calculationConversion,
      ),
    [calculationConversion, filteredEntities],
  );
  const currencyExposure = useMemo(
    () =>
      calculateCurrencyExposureSegments(
        filteredEntities,
        calculationConversion,
      ),
    [calculationConversion, filteredEntities],
  );
  const monthlyDividendSeries = useMemo(
    () =>
      calculateMonthlyDividendSeries(
        filteredEntities,
        18,
        calculationConversion,
      ),
    [calculationConversion, filteredEntities],
  );
  const monthlyBuySeries = useMemo(
    () =>
      calculateMonthlyBuySeries(filteredEntities, 18, calculationConversion),
    [calculationConversion, filteredEntities],
  );
  const monthlySellSeries = useMemo(
    () =>
      calculateMonthlySellSeries(filteredEntities, 18, calculationConversion),
    [calculationConversion, filteredEntities],
  );
  const monthlyFeeSeries = useMemo(
    () =>
      calculateMonthlyFeeSeries(filteredEntities, 18, calculationConversion),
    [calculationConversion, filteredEntities],
  );
  const monthlyCashFlowSeries = useMemo(
    () =>
      calculateMonthlyCashFlowSeries(
        filteredEntities,
        18,
        calculationConversion,
      ),
    [calculationConversion, filteredEntities],
  );
  const monthlyProfitBarSeries = useMemo(
    () =>
      calculateMonthlyProfitSeries(
        filteredEntities,
        18,
        portfolioOverviewCalculationOptions,
      ),
    [filteredEntities, portfolioOverviewCalculationOptions],
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

  const hasNonZeroBarData = useCallback(
    (series: { value: number }[]) =>
      series.some((item) => Math.abs(item.value) > 0.000001),
    [],
  );

  const visibleAssetAllocation = useMemo(() => {
    if (settings.showCashInAllocation) {
      return assetAllocation;
    }
    return assetAllocation.filter((item) => item.label !== "Cash");
  }, [assetAllocation, settings.showCashInAllocation]);

  const stockDistribution = useMemo(() => {
    return stockBreakdown
      .map((item) => ({
        ...item,
        convertedMarketValue: Math.abs(
          convertAmountToDisplay(item.marketValue, item.currency),
        ),
      }))
      .filter((item) => item.convertedMarketValue > 0)
      .sort((a, b) => b.convertedMarketValue - a.convertedMarketValue)
      .map((item, index) => ({
        label: item.symbol,
        value: item.convertedMarketValue,
        color: PIE_SEGMENT_COLORS[index % PIE_SEGMENT_COLORS.length],
      }));
  }, [convertAmountToDisplay, stockBreakdown]);

  const stockCountryDistribution = useMemo(() => {
    const grouped = new Map<string, number>();
    stockBreakdown.forEach((item) => {
      const value = Math.abs(
        convertAmountToDisplay(item.marketValue, item.currency),
      );
      if (value <= 0) {
        return;
      }
      const country = inferCountryFromSymbol(item.symbol, item.currency);
      grouped.set(country, (grouped.get(country) ?? 0) + value);
    });
    return buildSlicesFromMap(grouped);
  }, [convertAmountToDisplay, stockBreakdown]);

  const stockCategoryDistribution = useMemo(() => {
    const grouped = new Map<string, number>();
    stockBreakdown.forEach((item) => {
      const value = Math.abs(
        convertAmountToDisplay(item.marketValue, item.currency),
      );
      if (value <= 0) {
        return;
      }
      const category = inferCategoryFromSymbol(item.symbol);
      grouped.set(category, (grouped.get(category) ?? 0) + value);
    });
    return buildSlicesFromMap(grouped);
  }, [convertAmountToDisplay, stockBreakdown]);

  const stockDetail = useMemo(() => {
    if (!selectedStockDetailId) {
      return null;
    }
    return (
      stockBreakdown.find((item) => item.id === selectedStockDetailId) ?? null
    );
  }, [selectedStockDetailId, stockBreakdown]);

  const stockDetailRange = useMemo(
    () => ({
      preset: valuationRange,
      startDate:
        valuationRange === "CUSTOM"
          ? parseDateInput(valuationCustomStart)
          : undefined,
      endDate:
        valuationRange === "CUSTOM"
          ? parseDateInput(valuationCustomEnd)
          : undefined,
    }),
    [valuationCustomEnd, valuationCustomStart, valuationRange],
  );

  const stockDetailTransactions = useMemo(() => {
    if (!stockDetail) {
      return [] as TransactionRow[];
    }
    return allTransactions.filter((tx) => tx.symbol === stockDetail.symbol);
  }, [allTransactions, stockDetail]);

  const stockDetailBounds = useMemo(() => {
    if (!stockDetail) {
      return null;
    }
    return getStockDateBounds(filteredEntities, stockDetail.id);
  }, [filteredEntities, stockDetail]);

  const valuationCacheKey = useMemo(() => {
    if (!stockDetail) {
      return "";
    }
    const customStartKey =
      valuationRange === "CUSTOM" ? valuationCustomStart || "none" : "range";
    const customEndKey =
      valuationRange === "CUSTOM" ? valuationCustomEnd || "none" : "range";
    return [
      stockDetail.symbol.toUpperCase(),
      valuationRange,
      customStartKey,
      customEndKey,
    ].join("|");
  }, [stockDetail, valuationCustomEnd, valuationCustomStart, valuationRange]);

  const stockDetailValuationSeries = useMemo(() => {
    if (!stockDetail) {
      return [];
    }
    const cached = valuationCacheKey
      ? valuationSeriesCache[valuationCacheKey]
      : undefined;
    if (cached && cached.length > 0) {
      return cached;
    }
    if (!valuationSyncError) {
      return [];
    }
    return filterPriceSeriesByCustomRange(
      buildFallbackPriceSeries(stockDetailTransactions, stockDetail.symbol),
      valuationRange,
      valuationCustomStart,
      valuationCustomEnd,
    );
  }, [
    stockDetail,
    stockDetailTransactions,
    valuationCacheKey,
    valuationCustomEnd,
    valuationCustomStart,
    valuationSyncError,
    valuationRange,
    valuationSeriesCache,
  ]);

  const stockDetailValuationChangePct = useMemo(() => {
    if (stockDetailValuationSeries.length < 2) {
      return 0;
    }
    const first = stockDetailValuationSeries[0].price;
    const last =
      stockDetailValuationSeries[stockDetailValuationSeries.length - 1].price;
    if (first <= 0) {
      return 0;
    }
    return ((last - first) / first) * 100;
  }, [stockDetailValuationSeries]);

  const stockDetailSeries = useMemo(() => {
    if (!stockDetail) {
      return [];
    }
    if (stockDetailValuationSeries.length > 0) {
      return calculateProfitSeriesFromPriceSeries(
        stockDetailValuationSeries,
        stockDetailTransactions,
      );
    }
    return calculateSeriesForStock(
      filteredEntities,
      stockDetail.id,
      stockDetailRange,
    );
  }, [
    filteredEntities,
    stockDetail,
    stockDetailRange,
    stockDetailTransactions,
    stockDetailValuationSeries,
  ]);

  const stockDetailTradeMarkers = useMemo(() => {
    const timeline = [
      ...stockDetailValuationSeries.map((item) => item.date.getTime()),
      ...stockDetailSeries.map((item) => item.date.getTime()),
    ];
    const minTime =
      timeline.length > 0 ? Math.min(...timeline) : Number.NEGATIVE_INFINITY;
    const maxTime =
      timeline.length > 0 ? Math.max(...timeline) : Number.POSITIVE_INFINITY;

    return stockDetailTransactions
      .filter((tx) => {
        if (tx.type !== "BUY" && tx.type !== "SELL") {
          return false;
        }
        const time = tx.date.getTime();
        return time >= minTime && time <= maxTime;
      })
      .map(
        (tx): PriceChartTradeMarker => ({
          id: tx.id,
          date: tx.date,
          type: tx.type === "BUY" ? "BUY" : "SELL",
          shares: tx.shares,
          price: tx.price,
        }),
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [stockDetailSeries, stockDetailTransactions, stockDetailValuationSeries]);

  const stockDetailLivePrice = useMemo(() => {
    if (!stockDetail) {
      return 0;
    }

    // Keep stock detail modal consistent with current portfolio filter:
    // prefer quote inside filtered entities first, then fallback to all entities.
    for (const entity of filteredEntities) {
      const livePrice = entity.latestPriceBySymbol[stockDetail.symbol];
      if (
        typeof livePrice === "number" &&
        Number.isFinite(livePrice) &&
        livePrice > 0
      ) {
        return livePrice;
      }
    }

    for (const entity of entities) {
      const livePrice = entity.latestPriceBySymbol[stockDetail.symbol];
      if (
        typeof livePrice === "number" &&
        Number.isFinite(livePrice) &&
        livePrice > 0
      ) {
        return livePrice;
      }
    }

    return stockDetail.lastPrice;
  }, [entities, filteredEntities, stockDetail]);

  const stockDetailLiveMarketValue = useMemo(() => {
    if (!stockDetail) {
      return 0;
    }
    return stockDetail.activeShares * stockDetailLivePrice;
  }, [stockDetail, stockDetailLivePrice]);

  const refreshPortfolioQuotes = useCallback(
    async (trigger: "auto" | "manual" = "manual"): Promise<void> => {
      if (screen !== "dashboard") {
        return;
      }

      const stockSymbols = portfolioStockSymbolKey
        ? portfolioStockSymbolKey
            .split("|")
            .map((symbol) => symbol.trim().toUpperCase())
            .filter(Boolean)
        : [];
      const requestSymbols = [...new Set(stockSymbols)];
      const shouldSyncFx =
        normalizedDisplayCurrency !== "AUTO" && fxSourceCurrencies.length > 0;
      if (requestSymbols.length === 0 && !shouldSyncFx) {
        if (trigger === "manual") {
          setQuoteSyncError(
            isZh
              ? "目前未有可更新股價或匯率資料。"
              : "No stock symbols or currencies to refresh right now.",
          );
        }
        return;
      }

      if (quoteSyncInFlightRef.current) {
        return;
      }

      const now = Date.now();
      const elapsedMs = now - quoteLastRequestedAtRef.current;
      if (
        quoteLastRequestedAtRef.current > 0 &&
        elapsedMs < STOCK_QUOTE_MIN_REQUEST_GAP_MS
      ) {
        setQuoteSyncError("");
        if (trigger === "auto" && quoteRetryTimeoutRef.current === null) {
          const waitMs = Math.max(
            250,
            STOCK_QUOTE_MIN_REQUEST_GAP_MS - elapsedMs + 50,
          );
          quoteRetryTimeoutRef.current = window.setTimeout(() => {
            quoteRetryTimeoutRef.current = null;
            void refreshPortfolioQuotes("auto");
          }, waitMs);
        }
        return;
      }

      quoteLastRequestedAtRef.current = now;
      quoteSyncInFlightRef.current = true;
      setQuoteSyncing(true);
      if (quoteRetryTimeoutRef.current !== null) {
        window.clearTimeout(quoteRetryTimeoutRef.current);
        quoteRetryTimeoutRef.current = null;
      }
      if (trigger === "manual") {
        setQuoteSyncError("");
      }

      try {
        if (requestSymbols.length > 0) {
          try {
            const rawResponse = await fetchLocalStockData<unknown>({
              type: "query",
              symbol: requestSymbols.join(","),
            });

            const latestPriceMap = extractYahooQuotePriceMap(rawResponse);
            if (normalizedDisplayCurrency !== "AUTO") {
              syncTrace("fx:quotes:received", {
                quoteSymbolCount: Object.keys(latestPriceMap).length,
                quoteSymbols: Object.keys(latestPriceMap).slice(0, 50),
              });
            }
            const syncedSymbols = Object.keys(latestPriceMap).filter(
              (symbol) => {
                const value = latestPriceMap[symbol];
                return (
                  typeof value === "number" &&
                  Number.isFinite(value) &&
                  value > 0
                );
              },
            );
            if (syncedSymbols.length === 0) {
              throw new Error(
                isZh
                  ? "報價服務未回傳有效股價資料。"
                  : "No valid price returned from quote service.",
              );
            }

            setEntities((previous) =>
              previous.map((entity) => {
                const entitySymbols = new Set<string>();
                entity.transactions.forEach((tx) => {
                  if (isStockSymbolTransaction(tx)) {
                    entitySymbols.add(tx.symbol.toUpperCase());
                  }
                });

                if (entitySymbols.size === 0) {
                  return entity;
                }

                let changed = false;
                const nextLatestPriceBySymbol = {
                  ...entity.latestPriceBySymbol,
                };
                entitySymbols.forEach((symbol) => {
                  const latestPrice = resolveQuotedPriceBySymbol(
                    latestPriceMap,
                    symbol,
                  );
                  if (
                    typeof latestPrice === "number" &&
                    Number.isFinite(latestPrice) &&
                    latestPrice > 0 &&
                    nextLatestPriceBySymbol[symbol] !== latestPrice
                  ) {
                    nextLatestPriceBySymbol[symbol] = latestPrice;
                    changed = true;
                  }
                });

                return changed
                  ? { ...entity, latestPriceBySymbol: nextLatestPriceBySymbol }
                  : entity;
              }),
            );

            const syncedStockCount = stockSymbols.filter((symbol) => {
              const latestPrice = resolveQuotedPriceBySymbol(
                latestPriceMap,
                symbol,
              );
              return !!(
                typeof latestPrice === "number" &&
                Number.isFinite(latestPrice) &&
                latestPrice > 0
              );
            }).length;
            setQuoteSyncedCount(syncedStockCount);
            setQuoteLastUpdatedAt(new Date());
            setQuoteSyncError("");
          } catch (error) {
            if (error instanceof Error && isRateLimitMessage(error.message)) {
              setQuoteSyncError("");
            } else {
              const resolvedErrorMessage =
                error instanceof Error
                  ? error.message
                  : isZh
                    ? "更新股票報價失敗。"
                    : "Failed to refresh stock quotes.";
              setQuoteSyncError(resolvedErrorMessage);
            }
          }
        } else {
          setQuoteSyncError("");
        }

        if (!shouldSyncFx) {
          setFxRateByPair({});
          setFxSyncedCount(0);
          setFxLastUpdatedAt(null);
          setFxSyncError("");
          return;
        }

        syncTrace("fx:request:start", {
          trigger,
          targetCurrency: normalizedDisplayCurrency,
          fxSourceCurrencies,
        });

        try {
          const fxResult = await fetchFrankfurterFxRates([
            normalizedDisplayCurrency,
            ...fxSourceCurrencies,
          ]);

          setFxRateByPair(fxResult.pairMap);
          setFxSyncedCount(Object.keys(fxResult.pairMap).length);
          setFxLastUpdatedAt(new Date());

          const missingCurrencies = fxSourceCurrencies.filter(
            (sourceCurrency) => {
              const rate = resolveFxRateFromPairMap(
                fxResult.pairMap,
                sourceCurrency,
                normalizedDisplayCurrency,
              );
              return !(rate && Number.isFinite(rate) && rate > 0);
            },
          );

          setFxSyncError(
            missingCurrencies.length > 0
              ? isZh
                ? `以下貨幣暫時未能換算：${missingCurrencies.join(", ")}。`
                : `Unable to convert these currencies for now: ${missingCurrencies.join(", ")}.`
              : "",
          );
          syncTrace("fx:conversion:result", {
            targetCurrency: normalizedDisplayCurrency,
            requestedSources: fxSourceCurrencies,
            resolvedPairCount: Object.keys(fxResult.pairMap).length,
            missingCurrencies,
            fallbackCurrencies: fxResult.fallbackCurrencies,
            liveCurrencies: fxResult.liveCurrencies,
          });
        } catch (error) {
          syncTrace("fx:request:error", {
            trigger,
            targetCurrency: normalizedDisplayCurrency,
            message: error instanceof Error ? error.message : String(error),
          });

          const fallbackPairMap = buildFxRatePairMapFromUsdRates(
            FIXED_USD_FX_RATES,
            [normalizedDisplayCurrency, ...fxSourceCurrencies],
          );
          setFxRateByPair(fallbackPairMap);
          setFxSyncedCount(Object.keys(fallbackPairMap).length);
          setFxLastUpdatedAt(new Date());

          const missingCurrencies = fxSourceCurrencies.filter(
            (sourceCurrency) => {
              const rate = resolveFxRateFromPairMap(
                fallbackPairMap,
                sourceCurrency,
                normalizedDisplayCurrency,
              );
              return !(rate && Number.isFinite(rate) && rate > 0);
            },
          );
          setFxSyncError(
            missingCurrencies.length > 0
              ? isZh
                ? `以下貨幣暫時未能換算：${missingCurrencies.join(", ")}。`
                : `Unable to convert these currencies for now: ${missingCurrencies.join(", ")}.`
              : "",
          );
          syncTrace("fx:conversion:result", {
            targetCurrency: normalizedDisplayCurrency,
            requestedSources: fxSourceCurrencies,
            resolvedPairCount: Object.keys(fallbackPairMap).length,
            missingCurrencies,
            fallbackCurrencies: fxSourceCurrencies,
            liveCurrencies: [],
          });
        }
      } catch (error) {
        syncTrace("quote:request:error", {
          trigger,
          targetCurrency: normalizedDisplayCurrency,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error && isRateLimitMessage(error.message)) {
          setQuoteSyncError("");
          return;
        }

        const resolvedErrorMessage =
          error instanceof Error
            ? error.message
            : isZh
              ? "更新股票報價失敗。"
              : "Failed to refresh stock quotes.";
        setQuoteSyncError(resolvedErrorMessage);
      } finally {
        quoteSyncInFlightRef.current = false;
        setQuoteSyncing(false);
      }
    },
    [
      fxSourceCurrencies,
      isZh,
      normalizedDisplayCurrency,
      portfolioStockSymbolKey,
      screen,
    ],
  );

  const refreshPortfolioHistory = useCallback(
    async (trigger: "auto" | "manual" = "auto"): Promise<void> => {
      if (screen !== "dashboard") {
        return;
      }

      const stockSymbols = portfolioStockSymbolKey
        ? portfolioStockSymbolKey.split("|")
        : [];
      if (stockSymbols.length === 0) {
        setPortfolioHistoryBySymbol({});
        return;
      }

      if (portfolioHistorySyncInFlightRef.current) {
        return;
      }

      const now = Date.now();
      const elapsedMs = now - portfolioHistoryLastRequestedAtRef.current;
      if (
        portfolioHistoryLastRequestedAtRef.current > 0 &&
        elapsedMs < STOCK_QUOTE_MIN_REQUEST_GAP_MS
      ) {
        return;
      }

      portfolioHistoryLastRequestedAtRef.current = now;
      portfolioHistorySyncInFlightRef.current = true;

      try {
        const chartRangePreset =
          selectedRange === "CUSTOM" ? "ALL" : selectedRange;
        const request = resolveYahooChartRequest(chartRangePreset);
        const payload = await fetchLocalStockData<unknown>({
          type: "chart",
          symbol: stockSymbols.join(","),
          range: request.range,
          interval: request.interval,
        });

        const batchSeries = extractYahooChartPriceSeriesBatch(payload);
        if (
          Object.keys(batchSeries).length === 0 &&
          stockSymbols.length === 1
        ) {
          const singleSeries = extractYahooChartPriceSeries(payload);
          if (singleSeries.length > 0) {
            batchSeries[stockSymbols[0]] = singleSeries;
          }
        }

        const allTransactions = filteredEntities.flatMap(
          (entity) => entity.transactions,
        );
        const nextHistoryBySymbol: Record<string, PricePoint[]> = {};
        stockSymbols.forEach((symbol) => {
          const normalizedSymbol = symbol.trim().toUpperCase();
          const sourceSeries =
            batchSeries[normalizedSymbol] ??
            buildYahooSymbolCandidates(normalizedSymbol)
              .map((candidate) => batchSeries[candidate])
              .find((candidateSeries): candidateSeries is PricePoint[] =>
                Array.isArray(candidateSeries),
              ) ??
            [];
          const filteredSeries = filterPriceSeriesByCustomRange(
            sourceSeries,
            selectedRange,
            customStart,
            customEnd,
          );
          const fallbackSeries = filterPriceSeriesByCustomRange(
            buildFallbackPriceSeries(allTransactions, normalizedSymbol),
            selectedRange,
            customStart,
            customEnd,
          );
          const finalSeries =
            filteredSeries.length > 0 ? filteredSeries : fallbackSeries;
          if (finalSeries.length > 0) {
            nextHistoryBySymbol[normalizedSymbol] = finalSeries;
          }
        });

        setPortfolioHistoryBySymbol(nextHistoryBySymbol);
      } catch (error) {
        if (
          trigger === "manual" &&
          error instanceof Error &&
          !isRateLimitMessage(error.message)
        ) {
          setQuoteSyncError(error.message);
        }
      } finally {
        portfolioHistorySyncInFlightRef.current = false;
      }
    },
    [
      customEnd,
      customStart,
      filteredEntities,
      portfolioStockSymbolKey,
      screen,
      selectedRange,
    ],
  );

  const refreshValuationChart = useCallback(
    async (trigger: "auto" | "manual" = "manual"): Promise<void> => {
      if (!stockDetail) {
        return;
      }

      const symbol = stockDetail.symbol.trim().toUpperCase();
      if (!symbol) {
        return;
      }

      setValuationSyncing(true);
      if (trigger === "manual") {
        setValuationSyncError("");
      }

      try {
        const request = resolveYahooChartRequest(valuationRange);
        const payload = await fetchLocalStockData<unknown>({
          type: "chart",
          symbol,
          range: request.range,
          interval: request.interval,
        });

        const parsed = extractYahooChartPriceSeries(payload);
        const filtered = filterPriceSeriesByCustomRange(
          parsed,
          valuationRange,
          valuationCustomStart,
          valuationCustomEnd,
        );

        const fallback = filterPriceSeriesByCustomRange(
          buildFallbackPriceSeries(stockDetailTransactions, symbol),
          valuationRange,
          valuationCustomStart,
          valuationCustomEnd,
        );
        const series = filtered.length > 0 ? filtered : fallback;

        setValuationSeriesCache((previous) => ({
          ...previous,
          [valuationCacheKey]: series,
        }));
        setValuationLastUpdatedAt(new Date());
        setValuationSyncError(
          series.length === 0
            ? t(
                "No valuation data returned for this stock.",
                "此股票未有可用估價圖資料。",
              )
            : "",
        );
      } catch (error) {
        if (error instanceof Error && isRateLimitMessage(error.message)) {
          setValuationSyncError("");
          return;
        }
        setValuationSeriesCache((previous) => ({
          ...previous,
          [valuationCacheKey]:
            previous[valuationCacheKey] ??
            filterPriceSeriesByCustomRange(
              buildFallbackPriceSeries(stockDetailTransactions, symbol),
              valuationRange,
              valuationCustomStart,
              valuationCustomEnd,
            ),
        }));
        setValuationSyncError(
          error instanceof Error
            ? error.message
            : t("Failed to refresh valuation chart.", "更新估價圖失敗。"),
        );
      } finally {
        setValuationSyncing(false);
      }
    },
    [
      stockDetail,
      stockDetailTransactions,
      t,
      valuationCacheKey,
      valuationCustomEnd,
      valuationCustomStart,
      valuationRange,
    ],
  );

  const quoteStatusText = useMemo(() => {
    if (!portfolioStockSymbolKey && fxSourceCurrencies.length === 0) {
      return t(
        "No stocks available for quote sync.",
        "目前冇可同步股價嘅股票。",
      );
    }
    if (isQuoteSyncing) {
      return t("Syncing latest stock quotes...", "正在同步最新股票報價...");
    }
    if (quoteSyncError) {
      return quoteSyncError;
    }
    if (!quoteLastUpdatedAt) {
      return t("Waiting for first quote sync.", "等待首次股價同步。");
    }
    const agoText = formatAgo(quoteLastUpdatedAt, settings.language);
    return isZh
      ? `上次更新：${agoText}（${quoteSyncedCount} 隻）`
      : `Last update: ${agoText} (${quoteSyncedCount} symbols)`;
  }, [
    isQuoteSyncing,
    isZh,
    fxSourceCurrencies.length,
    portfolioStockSymbolKey,
    quoteLastUpdatedAt,
    quoteSyncedCount,
    quoteSyncError,
    settings.language,
    t,
  ]);

  const valuationStatusText = useMemo(() => {
    if (!stockDetail) {
      return "";
    }
    if (isValuationSyncing) {
      return t("Loading valuation chart...", "正在載入估價圖...");
    }
    if (valuationSyncError) {
      return valuationSyncError;
    }
    if (!valuationLastUpdatedAt) {
      return t("Waiting for valuation chart data.", "等待估價圖資料。");
    }
    const agoText = formatAgo(valuationLastUpdatedAt, settings.language);
    return isZh
      ? `估價圖更新：${agoText}`
      : `Valuation chart update: ${agoText}`;
  }, [
    isValuationSyncing,
    isZh,
    settings.language,
    stockDetail,
    t,
    valuationLastUpdatedAt,
    valuationSyncError,
  ]);

  const displayCurrencyStatusText = useMemo(() => {
    if (normalizedDisplayCurrency === "AUTO") {
      return t(
        "Showing original currency from each record.",
        "目前顯示每筆資料原本貨幣。",
      );
    }
    if (isQuoteSyncing && fxSourceCurrencies.length > 0) {
      return t("Syncing FX conversion rates...", "正在同步匯率...");
    }
    if (fxSyncError) {
      return fxSyncError;
    }
    if (fxSourceCurrencies.length === 0) {
      return t(
        "No conversion needed for current data.",
        "目前資料唔需要換算。",
      );
    }
    if (!fxLastUpdatedAt) {
      return t("Waiting for first FX sync.", "等待首次匯率同步。");
    }
    const agoText = formatAgo(fxLastUpdatedAt, settings.language);
    return isZh
      ? `顯示貨幣：${normalizedDisplayCurrency}（${agoText}，${fxSyncedCount} 組匯率）`
      : `Display currency: ${normalizedDisplayCurrency} (${agoText}, ${fxSyncedCount} FX pairs)`;
  }, [
    fxLastUpdatedAt,
    fxSourceCurrencies.length,
    fxSyncedCount,
    fxSyncError,
    isQuoteSyncing,
    isZh,
    normalizedDisplayCurrency,
    settings.language,
    t,
  ]);

  const tableDensityClass = settings.compactTables ? "table-compact" : "";

  const displayMoney = (value: number, currency: string): string => {
    if (settings.showObscure) {
      return "••••";
    }

    const sourceCurrency = normalizeCurrencyCode(currency) || "USD";
    if (
      normalizedDisplayCurrency === "AUTO" ||
      sourceCurrency === normalizedDisplayCurrency
    ) {
      return formatCurrency(value, sourceCurrency);
    }

    const fxRate =
      fxRateByPair[`${sourceCurrency}->${normalizedDisplayCurrency}`];
    if (typeof fxRate === "number" && Number.isFinite(fxRate) && fxRate > 0) {
      return formatCurrency(value * fxRate, normalizedDisplayCurrency);
    }

    return formatCurrency(value, sourceCurrency);
  };

  const displayPercent = (value: number): string =>
    settings.showObscure ? "•••%" : formatPercent(value);

  const displayNativeMoney = useCallback(
    (value: number, currency: string): string => {
      if (settings.showObscure) {
        return "••••";
      }
      const normalizedCurrency = normalizeCurrencyCode(currency) || "USD";
      return formatCurrency(value, normalizedCurrency);
    },
    [settings.showObscure],
  );

  const selectedPortfolioLineOption = useMemo(
    () =>
      PORTFOLIO_LINE_OPTIONS.find(
        (option) => option.value === selectedPortfolioLineId,
      ) ?? PORTFOLIO_LINE_OPTIONS[0],
    [selectedPortfolioLineId],
  );

  const portfolioOverviewPrimaryMetric =
    useMemo<PortfolioOverviewMetric>(() => {
      const option = selectedPortfolioLineOption;
      return {
        id: option.value,
        label: isZh ? option.labelZh : option.label,
        color: option.color,
        getValue: (point) => {
          if (option.value === "totalMarketValue") {
            return point.totalMarketValue;
          }
          if (option.value === "totalProfit") {
            return point.totalProfit;
          }
          return point.totalReturnPct;
        },
        formatValue: (value: number) =>
          option.value === "totalReturnPct"
            ? displayPercent(value)
            : displayMoney(value, portfolioSummary.currency),
      };
    }, [
      displayMoney,
      displayPercent,
      isZh,
      portfolioSummary.currency,
      selectedPortfolioLineOption,
    ]);

  const portfolioOverviewMetrics: PortfolioOverviewMetric[] = useMemo(
    () => [portfolioOverviewPrimaryMetric],
    [portfolioOverviewPrimaryMetric],
  );

  const portfolioOverviewLatestPrimaryValue = useMemo(() => {
    if (!portfolioOverviewLatest) {
      return 0;
    }
    if (selectedPortfolioLineId === "totalMarketValue") {
      return portfolioOverviewLatest.totalMarketValue;
    }
    if (selectedPortfolioLineId === "totalProfit") {
      return portfolioOverviewLatest.totalProfit;
    }
    return portfolioOverviewLatest.totalReturnPct;
  }, [portfolioOverviewLatest, selectedPortfolioLineId]);

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
    if (!stockDetail) {
      return;
    }

    if (stockDetailBounds) {
      setValuationCustomStart(toDateInputValue(stockDetailBounds.minDate));
      setValuationCustomEnd(toDateInputValue(stockDetailBounds.maxDate));
    } else {
      setValuationCustomStart("");
      setValuationCustomEnd("");
    }
    setValuationRange("1Y");
    setValuationSyncError("");
  }, [stockDetail, stockDetailBounds]);

  useEffect(() => {
    if (!stockDetail || !valuationCacheKey) {
      return;
    }
    if (isValuationSyncing) {
      return;
    }
    if (valuationSeriesCache[valuationCacheKey]) {
      return;
    }
    void refreshValuationChart("auto");
  }, [
    isValuationSyncing,
    refreshValuationChart,
    stockDetail,
    valuationCacheKey,
    valuationSeriesCache,
  ]);

  useEffect(() => {
    const { normalizedEntities, idMap, changed } =
      normalizePortfolioIdsForUi(entities);
    if (!changed) {
      return;
    }
    setEntities(normalizedEntities);
    if (selectedPortfolioId !== ALL_PORTFOLIO_ID) {
      const remappedId = idMap.get(selectedPortfolioId);
      if (remappedId && remappedId !== selectedPortfolioId) {
        setSelectedPortfolioIdWithTrace(
          remappedId,
          "normalizePortfolioIdsForUi:remap",
        );
      }
    }
  }, [entities, selectedPortfolioId, setSelectedPortfolioIdWithTrace]);

  useEffect(() => {
    if (selectedPortfolioId !== ALL_PORTFOLIO_ID) {
      return;
    }

    const rememberedId = manualPortfolioSelectionRef.current;
    if (!rememberedId) {
      return;
    }

    if (!entities.some((entity) => entity.id === rememberedId)) {
      manualPortfolioSelectionRef.current = null;
      return;
    }

    setSelectedPortfolioIdWithTrace(rememberedId, "manual-selection:restore");
  }, [entities, selectedPortfolioId, setSelectedPortfolioIdWithTrace]);

  useEffect(() => {
    if (!portfolioBounds) {
      setCustomStart("");
      setCustomEnd("");
      return;
    }

    setCustomStart(toDateInputValue(portfolioBounds.minDate));
    setCustomEnd(toDateInputValue(portfolioBounds.maxDate));
  }, [portfolioBounds]);

  useEffect(() => {
    if (normalizedDisplayCurrency !== "AUTO") {
      return;
    }
    setFxSyncError("");
  }, [normalizedDisplayCurrency]);

  useEffect(() => {
    if (screen !== "dashboard") {
      return;
    }
    if (!portfolioStockSymbolKey && fxSourceCurrencies.length === 0) {
      return;
    }

    void refreshPortfolioQuotes("auto");
  }, [
    fxSourceCurrencies.length,
    portfolioStockSymbolKey,
    refreshPortfolioQuotes,
    screen,
  ]);

  useEffect(() => {
    portfolioHistoryAutoRequestedRef.current = false;
  }, [portfolioStockSymbolKey]);

  useEffect(() => {
    return () => {
      if (quoteRetryTimeoutRef.current !== null) {
        window.clearTimeout(quoteRetryTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (screen !== "dashboard") {
      return;
    }
    if (portfolioHistoryAutoRequestedRef.current) {
      return;
    }
    if (!portfolioStockSymbolKey) {
      return;
    }

    portfolioHistoryAutoRequestedRef.current = true;
    void refreshPortfolioHistory("auto");
  }, [portfolioStockSymbolKey, refreshPortfolioHistory, screen]);

  useEffect(() => {
    if (screen !== "dashboard") {
      return;
    }
    if (!portfolioStockSymbolKey) {
      return;
    }
    void refreshPortfolioHistory("auto");
  }, [
    customEnd,
    customStart,
    portfolioStockSymbolKey,
    refreshPortfolioHistory,
    screen,
    selectedRange,
  ]);

  const applyImportedEntities = useCallback(
    (parsed: EntityDataset[]): void => {
      if (parsed.length === 0) {
        return;
      }

      const previousEntities = [...entities];
      const usedPortfolioIds = new Set(previousEntities.map((entity) => entity.id));
      const createdPortfolioIds: string[] = [];
      let nextEntities = [...previousEntities];

      try {
        parsed.forEach((incomingEntity, index) => {
          const nextPortfolioId = buildSafePortfolioId(
            incomingEntity.id,
            `portfolio-import-${index + 1}`,
            usedPortfolioIds,
          );
          const baseCurrency =
            normalizeCurrencyCode(incomingEntity.currency) || "USD";
          const currencyTypes = [
            baseCurrency,
            ...Object.keys(
              incomingEntity.stockerProMeta?.cashAssetsByCurrency ?? {},
            ),
            ...incomingEntity.transactions.map(
              (tx) => normalizeCurrencyCode(tx.currency) || baseCurrency,
            ),
          ];
          const createdPortfolio = buildPortfolioEntityWithMeta({
            id: nextPortfolioId,
            name: incomingEntity.name,
            currencyTypes,
            existingEntities: nextEntities,
          });
          createdPortfolioIds.push(nextPortfolioId);

          const normalizedTransactions = sortTransactionsByDateAsc(
            incomingEntity.transactions.map((tx, txIndex) => ({
              ...tx,
              id: tx.id || `imp-${nextPortfolioId}-${txIndex + 1}`,
              date: Number.isFinite(tx.date.getTime()) ? new Date(tx.date) : new Date(),
              currency: normalizeCurrencyCode(tx.currency) || baseCurrency,
              symbol: tx.symbol.trim().toUpperCase(),
            })),
          );

          const hydratedPortfolio = reassignEntityPositions({
            ...createdPortfolio,
            currency: baseCurrency,
            transactions: normalizedTransactions,
            latestPriceBySymbol: buildLatestPriceBySymbol(normalizedTransactions),
          });

          nextEntities = [...nextEntities, hydratedPortfolio];
        });

        setEntities(nextEntities);
      } catch (error) {
        const rollbackSet = new Set(createdPortfolioIds);
        const rolledBackEntities = nextEntities.filter(
          (entity) => !rollbackSet.has(entity.id),
        );
        const fallbackEntities =
          rolledBackEntities.length > 0 ? rolledBackEntities : previousEntities;
        setEntities(fallbackEntities);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : t("Import failed and has been rolled back.", "匯入失敗，已回滾新增組合。"),
        );
        return;
      }

      setSelectedPortfolioIdWithTrace(ALL_PORTFOLIO_ID, "import:applyImportedEntities");
      setSelectedStockId("");
      setSelectedRange("1Y");
      setScreen("dashboard");
    },
    [entities, setSelectedPortfolioIdWithTrace, t],
  );

  const openImportReview = useCallback(
    (parsed: EntityDataset[], source: ImportReviewSource): void => {
      setImportReviewEntities(cloneEntitiesForReview(parsed));
      setImportReviewSource(source);
      setImportReviewFeedback("");
      setImportReviewError("");
      setImportReviewOpen(true);
    },
    [],
  );

  const closeImportReview = useCallback((): void => {
    setImportReviewOpen(false);
    setImportReviewEntities([]);
    setImportReviewSource(null);
    setImportReviewFeedback("");
    setImportReviewError("");
    setImportReviewAdjusting(false);
  }, []);

  const importPortfolioFromAnyFormat = useCallback(
    async (
      content: string,
      preferredType: UserType,
      fileName: string,
      options?: ImportPortfolioOptions,
    ): Promise<{
      entities: EntityDataset[];
      usedAi: boolean;
      quota?: AiImportResponse["quota"];
    }> => {
      const forceAi = options?.forceAi === true;
      if (!forceAi) {
        const fallbackType: UserType =
          preferredType === "stockerx" ? "stockerpro" : "stockerx";
        const tryTypes: UserType[] =
          preferredType === fallbackType
            ? [preferredType]
            : [preferredType, fallbackType];

        for (const candidateType of tryTypes) {
          try {
            const parsed = await parseInputByType(content, candidateType);
            if (parsed.length > 0) {
              return {
                entities: parsed,
                usedAi: false,
              };
            }
          } catch {
            // Keep trying other parsers, then fallback to AI normalization.
          }
        }
      }

      const aiPayload = await normalizePortfolioWithAi<AiImportResponse>({
        rawText: content,
        fileName,
        hintType: preferredType === "new" ? "unknown" : preferredType,
        userInstruction: options?.userInstruction,
        currentNormalized: options?.currentNormalized,
      });
      const normalized = normalizeAiPayloadToEntities(
        aiPayload.normalized ?? {},
      );
      if (normalized.length === 0) {
        throw new Error(
          t(
            "AI could not normalize this file into a usable portfolio.",
            "AI 未能把此檔案轉成可用投資組合。",
          ),
        );
      }

      return {
        entities: normalized,
        usedAi: true,
        quota: aiPayload.quota,
      };
    },
    [t],
  );

  const selectUserType = async (type: UserType): Promise<void> => {
    setErrorMessage("");
    setImportStatusMessage("");
    setUserType(type);

    if (type === "new") {
      const newEntities = await parseInputByType("", "new");
      const preferredCurrency =
        settings.defaultCurrency.trim().toUpperCase() || "USD";
      setEntities(
        newEntities.map((entity) => ({
          ...entity,
          currency: preferredCurrency,
        })),
      );
      setSelectedPortfolioIdWithTrace(ALL_PORTFOLIO_ID, "selectUserType:new");
      setSelectedStockId("");
      setSelectedRange("1Y");
      setScreen("dashboard");
      return;
    }

    setScreen("upload");
  };

  const importFilesWithReview = useCallback(
    async (
      rawFiles: FileList | File[],
      preferredType: UserType,
    ): Promise<void> => {
      const files = Array.from(rawFiles);
      if (files.length === 0) {
        return;
      }

      setLoading(true);
      setErrorMessage("");
      setImportStatusMessage("");

      const importedItems: ImportBatchItem[] = [];
      const failedMessages: string[] = [];

      try {
        for (const file of files) {
          try {
            const localQuota = consumeLocalMonthlyUploadQuota();
            const content = await readFileContentForImport(file);
            const imported = await importPortfolioFromAnyFormat(
              content,
              preferredType,
              file.name,
            );
            importedItems.push({
              fileName: file.name,
              rawText: content,
              entities: imported.entities,
              usedAi: imported.usedAi,
              localQuota,
              aiQuota: imported.quota,
            });
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : t(
                    "Cannot parse this file. Please check the format.",
                    "無法解析此檔案，請檢查格式。",
                  );
            failedMessages.push(`${file.name}: ${message}`);

            // Stop immediately when monthly quota is reached to avoid noisy repeated errors.
            if (message.includes("Monthly upload limit reached")) {
              break;
            }
          }
        }

        if (importedItems.length === 0) {
          setErrorMessage(
            failedMessages[0] ??
              t(
                "Cannot parse uploaded file(s). Please check the format.",
                "無法解析上傳檔案，請檢查格式。",
              ),
          );
          return;
        }

        const mergedEntities = mergeImportBatchEntities(importedItems);
        if (mergedEntities.length === 0) {
          setErrorMessage(
            t(
              "No valid transactions extracted from uploaded file(s).",
              "上傳檔案中未擷取到有效交易資料。",
            ),
          );
          return;
        }

        const latestAiQuota = [...importedItems]
          .reverse()
          .find((item) => item.aiQuota)?.aiQuota;
        const sourceFileNames = importedItems.map((item) => item.fileName);

        openImportReview(mergedEntities, {
          rawText: buildImportBatchRawText(importedItems),
          fileName:
            sourceFileNames.length === 1
              ? sourceFileNames[0]
              : t(
                  `${sourceFileNames.length} files`,
                  `${sourceFileNames.length} 個檔案`,
                ),
          fileCount: sourceFileNames.length,
          fileNames: sourceFileNames,
          preferredType,
          localQuota: importedItems[importedItems.length - 1].localQuota,
          usedAi: importedItems.some((item) => item.usedAi),
          aiQuota: latestAiQuota,
        });

        if (failedMessages.length > 0) {
          setImportStatusMessage(
            t(
              `Imported ${importedItems.length}/${files.length} files. Please review and confirm.`,
              `已匯入 ${importedItems.length}/${files.length} 個檔案。請檢查後確認。`,
            ),
          );
          setErrorMessage(failedMessages.slice(0, 2).join(" | "));
        } else {
          setImportStatusMessage(
            t(
              "Import parsed. Please review transactions and confirm.",
              "匯入內容已解析。請先檢查交易並確認。",
            ),
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [importPortfolioFromAnyFormat, openImportReview, t],
  );

  const onFileChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    if (!userType || !event.target.files || event.target.files.length === 0) {
      return;
    }
    try {
      await importFilesWithReview(event.target.files, userType);
    } finally {
      event.target.value = "";
    }
  };

  const onDataImportFileChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    if (!event.target.files || event.target.files.length === 0) {
      return;
    }
    try {
      await importFilesWithReview(event.target.files, dataImportType);
    } finally {
      event.target.value = "";
    }
  };

  const onEntryUploadDragOver = useCallback(
    (event: DragEvent<HTMLLabelElement>): void => {
      event.preventDefault();
      setEntryUploadDragOver(true);
    },
    [],
  );

  const onEntryUploadDragLeave = useCallback(
    (event: DragEvent<HTMLLabelElement>): void => {
      event.preventDefault();
      setEntryUploadDragOver(false);
    },
    [],
  );

  const onEntryUploadDrop = useCallback(
    async (event: DragEvent<HTMLLabelElement>): Promise<void> => {
      event.preventDefault();
      setEntryUploadDragOver(false);
      if (!userType || loading || !event.dataTransfer.files.length) {
        return;
      }
      await importFilesWithReview(event.dataTransfer.files, userType);
    },
    [importFilesWithReview, loading, userType],
  );

  const onDataUploadDragOver = useCallback(
    (event: DragEvent<HTMLLabelElement>): void => {
      event.preventDefault();
      setDataUploadDragOver(true);
    },
    [],
  );

  const onDataUploadDragLeave = useCallback(
    (event: DragEvent<HTMLLabelElement>): void => {
      event.preventDefault();
      setDataUploadDragOver(false);
    },
    [],
  );

  const onDataUploadDrop = useCallback(
    async (event: DragEvent<HTMLLabelElement>): Promise<void> => {
      event.preventDefault();
      setDataUploadDragOver(false);
      if (loading || !event.dataTransfer.files.length) {
        return;
      }
      await importFilesWithReview(event.dataTransfer.files, dataImportType);
    },
    [dataImportType, importFilesWithReview, loading],
  );

  const minCustomDate = portfolioBounds
    ? toDateInputValue(portfolioBounds.minDate)
    : "";
  const maxCustomDate = portfolioBounds
    ? toDateInputValue(portfolioBounds.maxDate)
    : "";
  const minValuationCustomDate = stockDetailBounds
    ? toDateInputValue(stockDetailBounds.minDate)
    : "";
  const maxValuationCustomDate = stockDetailBounds
    ? toDateInputValue(stockDetailBounds.maxDate)
    : "";

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

  const selectPortfolioLine = (lineId: PortfolioLineId): void => {
    setSelectedPortfolioLineId(lineId);
  };

  const onValuationCustomStartChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const nextStart = event.target.value;
    setValuationCustomStart(nextStart);
    if (valuationCustomEnd && nextStart && nextStart > valuationCustomEnd) {
      setValuationCustomEnd(nextStart);
    }
  };

  const onValuationCustomEndChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const nextEnd = event.target.value;
    setValuationCustomEnd(nextEnd);
    if (valuationCustomStart && nextEnd && nextEnd < valuationCustomStart) {
      setValuationCustomStart(nextEnd);
    }
  };

  const updateImportReviewTransaction = useCallback(
    (
      portfolioId: string,
      transactionId: string,
      updater: (transaction: NormalizedTransaction) => NormalizedTransaction,
    ): void => {
      setImportReviewEntities((previous) =>
        previous.map((entity) => {
          if (entity.id !== portfolioId) {
            return entity;
          }

          const nextTransactions = entity.transactions.map((tx) =>
            tx.id === transactionId ? updater(tx) : tx,
          );
          return {
            ...entity,
            transactions: sortTransactionsByDateAsc(nextTransactions),
            latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
          };
        }),
      );
    },
    [],
  );

  const moveImportReviewTransaction = useCallback(
    (
      sourcePortfolioId: string,
      targetPortfolioId: string,
      transactionId: string,
    ): void => {
      if (sourcePortfolioId === targetPortfolioId) {
        return;
      }

      setImportReviewEntities((previous) => {
        const source = previous.find(
          (entity) => entity.id === sourcePortfolioId,
        );
        const target = previous.find(
          (entity) => entity.id === targetPortfolioId,
        );
        if (!source || !target) {
          return previous;
        }

        const moving = source.transactions.find(
          (tx) => tx.id === transactionId,
        );
        if (!moving) {
          return previous;
        }

        return previous.map((entity) => {
          if (entity.id === sourcePortfolioId) {
            const nextTransactions = entity.transactions.filter(
              (tx) => tx.id !== transactionId,
            );
            return {
              ...entity,
              transactions: nextTransactions,
              latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
            };
          }

          if (entity.id === targetPortfolioId) {
            const txWithTargetCurrency = {
              ...moving,
              currency: moving.currency || entity.currency,
            };
            const nextTransactions = sortTransactionsByDateAsc([
              ...entity.transactions,
              txWithTargetCurrency,
            ]);
            return {
              ...entity,
              transactions: nextTransactions,
              latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
            };
          }

          return entity;
        });
      });
    },
    [],
  );

  const deleteImportReviewTransaction = useCallback(
    (portfolioId: string, transactionId: string): void => {
      setImportReviewEntities((previous) =>
        previous.map((entity) => {
          if (entity.id !== portfolioId) {
            return entity;
          }
          const nextTransactions = entity.transactions.filter(
            (tx) => tx.id !== transactionId,
          );
          return {
            ...entity,
            transactions: nextTransactions,
            latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
          };
        }),
      );
    },
    [],
  );

  const confirmImportReview = useCallback((): void => {
    if (!importReviewSource) {
      closeImportReview();
      return;
    }

    const normalized = normalizeReviewEntities(importReviewEntities);
    if (
      normalized.length === 0 ||
      normalized.every((entity) => entity.transactions.length === 0)
    ) {
      setImportReviewError(
        t(
          "No valid transactions left. Please edit at least one row before confirming.",
          "目前沒有有效交易，請先編輯至少一筆交易再確認。",
        ),
      );
      return;
    }

    applyImportedEntities(normalized);
    if (importReviewSource.usedAi) {
      const remaining = importReviewSource.aiQuota?.remaining;
      setImportStatusMessage(
        typeof remaining === "number"
          ? t(
              `Imported via AI normalization. Remaining AI imports this month: ${remaining}.`,
              `已透過 AI 轉換匯入。本月 AI 匯入剩餘：${remaining} 次。`,
            )
          : t(
              "Imported via AI normalization fallback.",
              "已透過 AI 轉換備援成功匯入。",
            ),
      );
    } else {
      setImportStatusMessage(
        t(
          `Import successful. Remaining uploads this month: ${importReviewSource.localQuota.remaining}.`,
          `匯入成功。本月剩餘上傳次數：${importReviewSource.localQuota.remaining} 次。`,
        ),
      );
    }
    closeImportReview();
  }, [
    applyImportedEntities,
    closeImportReview,
    importReviewEntities,
    importReviewSource,
    t,
  ]);

  const adjustImportReviewWithPrompt = useCallback(async (): Promise<void> => {
    if (!importReviewSource) {
      return;
    }

    const feedback = importReviewFeedback.trim();
    if (!feedback) {
      setImportReviewError(
        t(
          "Please type what we misunderstood before adjusting.",
          "請先輸入我哋誤解咗咩欄位，再進行調整。",
        ),
      );
      return;
    }

    setImportReviewAdjusting(true);
    setImportReviewError("");

    try {
      const imported = await importPortfolioFromAnyFormat(
        importReviewSource.rawText,
        importReviewSource.preferredType,
        importReviewSource.fileName,
        {
          forceAi: true,
          userInstruction: feedback,
          currentNormalized: serializeEntities(importReviewEntities),
        },
      );
      if (imported.entities.length === 0) {
        throw new Error(
          t(
            "AI returned empty result. Please refine your prompt and try again.",
            "AI 返回空結果，請補充提示再試一次。",
          ),
        );
      }

      setImportReviewEntities(cloneEntitiesForReview(imported.entities));
      setImportReviewSource((previous) =>
        previous
          ? {
              ...previous,
              usedAi: true,
              aiQuota: imported.quota ?? previous.aiQuota,
            }
          : previous,
      );
      setImportStatusMessage(
        t(
          "Adjusted with AI. Please review the updated transactions and confirm import.",
          "已用 AI 調整。請檢查更新後交易，再確認匯入。",
        ),
      );
    } catch (error) {
      setImportReviewError(
        error instanceof Error
          ? error.message
          : t(
              "Unable to adjust now. Please try again.",
              "暫時無法調整，請稍後再試。",
            ),
      );
    } finally {
      setImportReviewAdjusting(false);
    }
  }, [
    importPortfolioFromAnyFormat,
    importReviewEntities,
    importReviewFeedback,
    importReviewSource,
    t,
  ]);

  const openCreateTransaction = (): void => {
    if (entities.length === 0) {
      setTransactionError(
        t(
          "Please create/import a portfolio first.",
          "請先建立或匯入投資組合。",
        ),
      );
      return;
    }

    const fallbackPortfolio =
      selectedPortfolioId === "all"
        ? entities[0]
        : (entities.find((entity) => entity.id === selectedPortfolioId) ??
          entities[0]);

    setEditingTransaction(null);
    setDraft(
      buildDefaultDraft(fallbackPortfolio.id, fallbackPortfolio.currency),
    );
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
      district: inferDistrictFromCurrency(row.currency, row.symbol),
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

        if (entity.id !== portfolioId) {
          return {
            ...entity,
            transactions: withoutOriginal,
            latestPriceBySymbol: buildLatestPriceBySymbol(withoutOriginal),
          };
        }

        const nextTransactions = sortTransactionsByDateAsc([
          ...withoutOriginal,
          ...(autoCashTopUp ? [autoCashTopUp] : []),
          transaction,
        ]);
        const reassignedEntity = reassignEntityPositions({
          ...entity,
          transactions: nextTransactions,
          latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
        });

        return {
          ...reassignedEntity,
          latestPriceBySymbol: buildLatestPriceBySymbol(
            reassignedEntity.transactions,
          ),
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
    const adjustedCashAmount = Math.max(
      0,
      Math.min(pendingCashReview.shortfall, userInputAmount),
    );
    applyTransactionWithCashAdjustment(
      pendingCashReview.portfolioId,
      pendingCashReview.transaction,
      pendingCashReview.editingTransactionId,
      adjustedCashAmount,
      pendingCashReview.currency,
    );
  };

  const saveTransaction = (): void => {
    const targetPortfolio = entities.find(
      (entity) => entity.id === draft.portfolioId,
    );
    if (!targetPortfolio) {
      setTransactionError(
        t("Please select a portfolio.", "請先選擇投資組合。"),
      );
      return;
    }

    const parsedDate = parseDateInput(draft.date);
    if (!parsedDate) {
      setTransactionError(t("Invalid date.", "日期格式錯誤。"));
      return;
    }

    const normalizedDistrict = normalizeTransactionDistrict(draft.district);
    const autoCurrency = getAutoCurrencyByDistrict(normalizedDistrict);
    const currency = autoCurrency ?? normalizeCurrencyCode(draft.currency);
    if (!currency) {
      setTransactionError(t("Currency is required.", "請輸入貨幣。"));
      return;
    }

    const requireSymbol = requiresAssetSymbol(draft.type);
    let symbol = draft.symbol.trim().toUpperCase();
    if (shouldUseCurrencyAsSymbol(draft.type) && !symbol) {
      symbol = currency;
    }

    if (requireSymbol && !symbol) {
      setTransactionError(t("Symbol is required.", "請輸入股票代號。"));
      return;
    }
    if (!allowsSymbolInput(draft.type)) {
      symbol = currency;
    } else if (draft.type === "FEE" && !symbol) {
      symbol = currency;
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
      stockerProMeta: editingTransaction?.stockerProMeta
        ? {
            ...editingTransaction.stockerProMeta,
          }
        : undefined,
    };

    const editingTransactionId = editingTransaction?.id ?? null;
    const baseTransactions = editingTransactionId
      ? targetPortfolio.transactions.filter(
          (tx) => tx.id !== editingTransactionId,
        )
      : targetPortfolio.transactions;

    if (transaction.type === "BUY") {
      const cashBalances = calculateCashBalances([
        { ...targetPortfolio, transactions: baseTransactions },
      ]);
      const cashBalance =
        cashBalances.find((item) => item.currency === currency)?.balance ?? 0;
      const requiredCash =
        transaction.shares * transaction.price + transaction.fee;
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
      t(
        `Delete ${row.type} ${row.symbol} transaction?`,
        `刪除 ${row.symbol} 的 ${row.type} 交易？`,
      ),
    );
    if (!shouldDelete) {
      return;
    }

    setEntities((previous) =>
      previous.map((entity) => {
        if (entity.id !== row.portfolioId) {
          return entity;
        }
        const nextTransactions = entity.transactions.filter(
          (tx) => tx.id !== row.id,
        );
        const reassignedEntity = reassignEntityPositions({
          ...entity,
          transactions: nextTransactions,
          latestPriceBySymbol: buildLatestPriceBySymbol(nextTransactions),
        });
        return {
          ...reassignedEntity,
          latestPriceBySymbol: buildLatestPriceBySymbol(
            reassignedEntity.transactions,
          ),
        };
      }),
    );
  };

  const applyPortfolioMutation = useCallback(
    (
      updater: (previous: EntityDataset[]) => EntityDataset[],
      options: {
        selectedPortfolioId?: string;
        selectionReason?: string;
      } = {},
    ): void => {
      const nextEntities = updater(entities);
      if (nextEntities === entities) {
        return;
      }
      setEntities(nextEntities);
      if (options.selectedPortfolioId) {
        setSelectedPortfolioIdWithTrace(
          options.selectedPortfolioId,
          options.selectionReason ?? "portfolio:mutation",
        );
      }
    },
    [entities, setSelectedPortfolioIdWithTrace],
  );

  const openCreatePortfolioModal = (): void => {
    setNewPortfolioDraft(
      buildDefaultNewPortfolioDraft(settings.defaultCurrency || "USD"),
    );
    setNewPortfolioError("");
    setNewPortfolioModalOpen(true);
  };

  const closeCreatePortfolioModal = (): void => {
    setNewPortfolioModalOpen(false);
    setNewPortfolioError("");
  };

  const createPortfolio = (): void => {
    const name = newPortfolioDraft.name.trim();
    if (!name) {
      setNewPortfolioError(t("Portfolio name is required.", "請輸入投資組合名稱。"));
      return;
    }
    const currencyType =
      normalizeCurrencyCode(newPortfolioDraft.currencyType) || "USD";
    const nextPortfolio = buildPortfolioEntityWithMeta({
      id: "",
      name,
      currencyTypes: [currencyType],
      existingEntities: entities,
    });
    const createdPortfolioId = nextPortfolio.id;
    applyPortfolioMutation(
      () => [...entities, nextPortfolio],
      {
        selectedPortfolioId: createdPortfolioId,
        selectionReason: "portfolio:create",
      },
    );
    closeCreatePortfolioModal();
  };

  const renamePortfolio = (): void => {
    if (selectedPortfolioId === "all") {
      return;
    }

    const target = entities.find((entity) => entity.id === selectedPortfolioId);
    if (!target) {
      return;
    }

    const nextName = window.prompt(
      t("New portfolio name", "新的組合名稱"),
      target.name,
    );
    if (!nextName || !nextName.trim()) {
      return;
    }

    const normalizedName = nextName.trim();
    applyPortfolioMutation((previous) =>
      previous.map((entity) => {
        if (entity.id !== selectedPortfolioId) {
          return entity;
        }
        return {
          ...entity,
          name: normalizedName,
          stockerProMeta: entity.stockerProMeta
            ? {
                ...entity.stockerProMeta,
                portfolio: {
                  ...entity.stockerProMeta.portfolio,
                  name: normalizedName,
                },
              }
            : entity.stockerProMeta,
        };
      }),
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
      t(
        `Delete portfolio \"${target.name}\"?`,
        `刪除投資組合「${target.name}」？`,
      ),
    );
    if (!shouldDelete) {
      return;
    }

    const cascadedEntity = cascadeDeletePortfolioEntity(target);
    if (
      Object.keys(cascadedEntity.stockerProMeta?.assetsBySymbol ?? {}).length > 0 ||
      Object.keys(cascadedEntity.stockerProMeta?.positionsById ?? {}).length > 0 ||
      Object.keys(cascadedEntity.stockerProMeta?.cashAssetsByCurrency ?? {})
        .length > 0 ||
      cascadedEntity.transactions.length > 0
    ) {
      setErrorMessage(
        t(
          "Failed to cascade-delete portfolio dependencies.",
          "刪除組合關聯資料失敗，已中止刪除。",
        ),
      );
      return;
    }

    applyPortfolioMutation((previous) =>
      previous.filter((entity) => entity.id !== selectedPortfolioId),
    );
    setSelectedPortfolioIdWithTrace(ALL_PORTFOLIO_ID, "portfolio:delete");
  };

  const dualFormatRecords = useMemo(() => {
    if (entities.length === 0) {
      return null;
    }
    return buildDualFormatRecords(entities);
  }, [entities]);

  const exportTextFile = (
    content: string,
    fileName: string,
    mimeType = "application/json",
  ): void => {
    const blob = new Blob([content], { type: `${mimeType}; charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportWebJson = (): void => {
    const payload = serializeEntities(entities);
    exportTextFile(payload, `stocker-web-export-${Date.now()}.json`);
  };

  const exportStockerProJson = (): void => {
    if (!dualFormatRecords) {
      return;
    }
    exportTextFile(
      dualFormatRecords.stockerProJson,
      `stocker-pro-export-${Date.now()}.json`,
    );
  };

  const exportStockerXJson = (): void => {
    if (!dualFormatRecords) {
      return;
    }
    exportTextFile(
      dualFormatRecords.stockerXJson,
      `stocker-x-export-${Date.now()}.json`,
    );
  };

  const clearAllData = (): void => {
    const shouldClear = window.confirm(
      t("Clear all local data?", "清除全部本地資料？"),
    );
    if (!shouldClear) {
      return;
    }

    setEntities([]);
    setSelectedPortfolioIdWithTrace(ALL_PORTFOLIO_ID, "data:clearAllData");
    setSelectedStockId("");
    setScreen("choose");
    setImportStatusMessage("");
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

  const selectPortfolioFilter = useCallback(
    (portfolioId: string): void => {
      if (portfolioId === ALL_PORTFOLIO_ID) {
        manualPortfolioSelectionRef.current = null;
      } else {
        manualPortfolioSelectionRef.current = portfolioId;
      }
      setSelectedPortfolioIdWithTrace(
        portfolioId,
        "portfolio-filter:user-click",
      );
    },
    [setSelectedPortfolioIdWithTrace],
  );

  if (isAuthLoading) {
    return (
      <div
        className={`app-shell ${settings.enableAnimations ? "" : "reduced-motion"} ${tableDensityClass}`.trim()}
      >
        <main className="auth-screen">
          <div className="auth-card">
            <img
              className="brand-wordmark"
              src={stockerWordmark}
              alt="Stocker"
            />
            <h1>{t("Connecting to Firebase...", "正在連接 Firebase...")}</h1>
            <p>{t("Please wait a moment.", "請稍候。")}</p>
          </div>
        </main>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div
        className={`app-shell ${settings.enableAnimations ? "" : "reduced-motion"} ${tableDensityClass}`.trim()}
      >
        <main className="auth-screen">
          <div className="auth-card">
            <img
              className="brand-wordmark"
              src={stockerWordmark}
              alt="Stocker"
            />
            <h1>
              {t("Sign In To View Your Portfolio", "登入後查看你嘅投資收益")}
            </h1>
            <p>
              {t(
                "Your data will load from Firebase after Google sign-in.",
                "Google 登入後會自動載入你喺 Firebase 嘅資料。",
              )}
            </p>
            <button
              type="button"
              className="primary-btn auth-btn"
              onClick={openLoginFlow}
            >
              {t("Sign in with Google", "使用 Google 登入")}
            </button>
            {cloudErrorMessage && (
              <div className="error-text">{cloudErrorMessage}</div>
            )}
          </div>
          {showBetaConsentModal && (
            <div
              className="modal-backdrop"
              role="presentation"
              onClick={() => setShowBetaConsentModal(false)}
            >
              <div
                className="modal-card beta-consent-modal"
                role="dialog"
                aria-modal="true"
                onClick={(event) => event.stopPropagation()}
              >
                <h3>Beta Version Notice / Beta 版本注意事項</h3>
                <p>
                  This is a beta version. Data may be lost, and analysis may be
                  inaccurate.
                  <br />
                  目前為 Beta 版本，資料可能遺失，分析結果亦可能不準確。
                </p>
                <label className="beta-consent-check">
                  <input
                    type="checkbox"
                    checked={betaConsentChecked}
                    onChange={(event) =>
                      setBetaConsentChecked(event.target.checked)
                    }
                  />
                  <span>
                    I understand and agree to continue.
                    <br />
                    我已了解以上風險，並同意繼續使用。
                  </span>
                </label>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setShowBetaConsentModal(false)}
                  >
                    Cancel / 取消
                  </button>
                  <button
                    type="button"
                    className="primary-btn"
                    disabled={!betaConsentChecked}
                    onClick={confirmBetaRiskAndSignIn}
                  >
                    Agree and Continue / 同意並繼續
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div
      className={`app-shell ${settings.enableAnimations ? "" : "reduced-motion"} ${tableDensityClass}`.trim()}
    >
      <header className="top-header">
        <div className="header-left">
          <img className="brand-wordmark" src={stockerWordmark} alt="Stocker" />
        </div>

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

        <div className="header-tools">
          <span className="user-chip" title={authUser.email ?? authUser.uid}>
            {authUser.displayName ||
              authUser.email ||
              `${authUser.uid.slice(0, 8)}...`}
          </span>
          <button
            type="button"
            className="header-tool-btn"
            onClick={() =>
              updateSetting(
                "language",
                settings.language === "zh-HK" ? "en" : "zh-HK",
              )
            }
          >
            {settings.language === "zh-HK" ? "English" : "繁中"}
          </button>
          <button
            type="button"
            className="header-tool-btn"
            onClick={() => void onSignOut()}
          >
            {t("Sign Out", "登出")}
          </button>
          <button
            type="button"
            className="header-tool-btn header-tool-btn-primary header-add-trade"
            onClick={() => changeTab("transactions")}
          >
            {t("Add Trade", "新增交易")}
          </button>
        </div>

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
            {t(
              "Choose your account type first, then upload your exported file.",
              "先選擇帳戶類型，再上傳匯出檔案。",
            )}
          </p>
          <div className="entry-cards">
            <button
              type="button"
              className="entry-card"
              onClick={() => void selectUserType("stockerx")}
            >
              <strong>{t("StockerX User", "StockerX 用戶")}</strong>
              <span>
                {t("Use StockerX export format", "使用 StockerX 匯出格式")}
              </span>
            </button>
            <button
              type="button"
              className="entry-card"
              onClick={() => void selectUserType("stockerpro")}
            >
              <strong>{t("Stocker Pro User", "Stocker Pro 用戶")}</strong>
              <span>
                {t(
                  "Use Stocker Pro export format",
                  "使用 Stocker Pro 匯出格式",
                )}
              </span>
            </button>
            <button
              type="button"
              className="entry-card"
              onClick={() => void selectUserType("new")}
            >
              <strong>{t("I Am New", "我是新用戶")}</strong>
              <span>
                {t(
                  "Create an empty Stocker Pro profile",
                  "建立空白 Stocker Pro 資料",
                )}
              </span>
            </button>
          </div>
        </main>
      )}

      {screen === "upload" && (
        <main className="upload-screen">
          <h1>
            {t("Upload", "上傳")}{" "}
            {userType === "stockerx" ? "StockerX" : "Stocker Pro"}{" "}
            {t("File", "檔案")}
          </h1>
          <p className="entry-subtitle">
            {t(
              "Supports importing files in any format.",
              "支援任何格式檔案匯入。",
            )}
          </p>
          <label
            className={`upload-box ${isEntryUploadDragOver ? "drag-over" : ""}`}
            onDragOver={onEntryUploadDragOver}
            onDragLeave={onEntryUploadDragLeave}
            onDrop={(event) => {
              void onEntryUploadDrop(event);
            }}
          >
            <input type="file" onChange={onFileChange} accept="*/*" multiple />
            <span>
              {loading
                ? t("Reading file(s)...", "正在讀取檔案...")
                : t("Choose or drag file(s)", "選擇或拖放檔案")}
            </span>
            <small>
              {t("Multiple files supported.", "支援一次上傳多個檔案。")}
            </small>
          </label>
          <button
            type="button"
            className="back-link"
            onClick={() => setScreen("choose")}
          >
            {t("Back", "返回")}
          </button>
          {errorMessage && <div className="error-text">{errorMessage}</div>}
          {importStatusMessage && (
            <div className="success-text">{importStatusMessage}</div>
          )}
        </main>
      )}

      {screen === "dashboard" && (
        <main className="dashboard-page" id="dashboard">
          <section className="summary-grid">
            <div className="summary-card">
              <span>{t("Total Assets", "總資產")}</span>
              <strong>
                {displayMoney(
                  portfolioSummary.totalAssets,
                  portfolioSummary.currency,
                )}
              </strong>
            </div>
            <div className="summary-card">
              <span>{t("Cash Balance", "現金結餘")}</span>
              <strong>
                {displayMoney(
                  portfolioSummary.cashBalance,
                  portfolioSummary.currency,
                )}
              </strong>
            </div>
            <div
              className={`summary-card ${portfolioSummary.totalProfit >= 0 ? "positive" : "negative"}`}
            >
              <span>{t("Total Profit", "總盈虧")}</span>
              <strong>
                {displayMoney(
                  portfolioSummary.totalProfit,
                  portfolioSummary.currency,
                )}
              </strong>
              <small>{displayPercent(portfolioSummary.totalProfitPct)}</small>
            </div>
            <div
              className={`summary-card ${portfolioSummary.dailyProfit >= 0 ? "positive" : "negative"}`}
            >
              <span>{t("Daily Profit", "今日盈虧")}</span>
              <strong>
                {displayMoney(
                  portfolioSummary.dailyProfit,
                  portfolioSummary.currency,
                )}
              </strong>
              <small>{displayPercent(portfolioSummary.dailyProfitPct)}</small>
            </div>
            <div className="summary-card summary-card-currency">
              <span>{t("Display Currency", "顯示貨幣")}</span>
              <select
                value={normalizedDisplayCurrency}
                onChange={(event) =>
                  updateSetting(
                    "displayCurrency",
                    normalizeCurrencyCode(event.target.value) || "AUTO",
                  )
                }
              >
                <option value="AUTO">
                  {t("Auto (Original)", "自動（原貨幣）")}
                </option>
                {displayCurrencyOptions.map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </select>
              <small
                className={`summary-card-note ${fxSyncError ? "negative" : ""}`}
              >
                {displayCurrencyStatusText}
              </small>
            </div>
          </section>

          {activeTab === "dashboard" && (
            <section className="dashboard-grid">
              <section className="chart-panel">
                <div className="panel-head">
                  <div>
                    <p className="panel-label">
                      {t("Portfolio Overview", "組合總覽")}
                    </p>
                    <h2>
                      {rangeTitle(selectedRange)}{" "}
                      {isZh
                        ? selectedPortfolioLineOption.labelZh
                        : selectedPortfolioLineOption.label}
                    </h2>
                  </div>
                  <div
                    className={`metric-badge ${portfolioOverviewLatestPrimaryValue >= 0 ? "positive" : "negative"}`}
                  >
                    <strong>
                      {selectedPortfolioLineId === "totalReturnPct"
                        ? displayPercent(portfolioOverviewLatestPrimaryValue)
                        : displayMoney(
                            portfolioOverviewLatestPrimaryValue,
                            portfolioSummary.currency,
                          )}
                    </strong>
                    {selectedPortfolioLineId !== "totalReturnPct" && (
                      <span>
                        {displayPercent(
                          portfolioOverviewLatest?.totalReturnPct ?? 0,
                        )}
                      </span>
                    )}
                  </div>
                </div>

                <div className="portfolio-switcher-wrap">
                  <div className="portfolio-switcher-title">
                    {t("Portfolio Filter", "組合篩選")}
                  </div>
                  <div className="portfolio-switcher">
                    <button
                      type="button"
                      className={`portfolio-pill ${selectedPortfolioId === "all" ? "active" : ""}`}
                      onClick={() => selectPortfolioFilter(ALL_PORTFOLIO_ID)}
                    >
                      {t("All", "全部")}
                    </button>
                    {entities.map((entity) => (
                      <button
                        type="button"
                        key={entity.id}
                        className={`portfolio-pill ${selectedPortfolioId === entity.id ? "active" : ""}`}
                        onClick={() => selectPortfolioFilter(entity.id)}
                      >
                        {entity.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="time-range-wrap">
                  <div className="portfolio-switcher-title">
                    {t("P/L Time Range", "盈虧時間範圍")}
                  </div>
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

                <div className="line-filter-wrap">
                  <div className="portfolio-switcher-title">
                    {t("Chart Lines", "圖表線條")}
                  </div>
                  <div className="portfolio-switcher">
                    {PORTFOLIO_LINE_OPTIONS.map((option) => {
                      const active = selectedPortfolioLineId === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`portfolio-pill line-pill ${active ? "active" : ""}`}
                          onClick={() => selectPortfolioLine(option.value)}
                        >
                          <span
                            className="line-pill-dot"
                            style={{ background: option.color }}
                          />
                          <span>{isZh ? option.labelZh : option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <PortfolioOverviewChart
                  points={portfolioOverviewSeries}
                  metrics={portfolioOverviewMetrics}
                  noDataLabel={t(
                    "No portfolio data yet.",
                    "暫時未有組合資料。",
                  )}
                />

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
                            {item.currency} | {t("Shares", "股數")}:{" "}
                            {item.activeShares}
                          </small>
                        </div>
                      </div>
                      <div
                        className={`row-right ${item.totalProfit >= 0 ? "positive" : "negative"}`}
                      >
                        <strong>
                          {displayMoney(item.totalProfit, item.currency)}
                        </strong>
                        <small>{displayPercent(item.totalProfitPct)}</small>
                      </div>
                    </button>
                  ))}
                </div>
                {selectedStock && (
                  <div className="performance-actions">
                    <div className="performance-action-buttons">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() =>
                          setSelectedStockDetailId(selectedStock.id)
                        }
                      >
                        {t("Open", "開啟")} {selectedStock.symbol}{" "}
                        {t("Detail", "詳情")}
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void refreshPortfolioQuotes("manual")}
                        disabled={isQuoteSyncing || !portfolioStockSymbolKey}
                      >
                        {isQuoteSyncing
                          ? t("Syncing...", "同步中...")
                          : t("Check Stock Price", "查看股價")}
                      </button>
                    </div>
                    <p
                      className={`quote-sync-note ${quoteSyncError ? "error" : ""}`}
                    >
                      {quoteStatusText}
                    </p>
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
                    <strong>
                      {displayMoney(
                        insights.avgProfitPerStock,
                        portfolioSummary.currency,
                      )}
                    </strong>
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
                    <strong className="negative">
                      {displayPercent(-insights.maxDrawdownPct)}
                    </strong>
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
                  data={monthlyBuySeries.slice(-12)}
                  title={t(
                    "Monthly Buy Amount (12M)",
                    "每月買入金額（12個月）",
                  )}
                  positiveColor="#22a06b"
                />
                <BarChart
                  data={monthlySellSeries.slice(-12)}
                  title={t(
                    "Monthly Sell Amount (12M)",
                    "每月賣出金額（12個月）",
                  )}
                  positiveColor="#2f7dd6"
                />
              </section>

              <section className="dual-column-grid">
                <BarChart
                  data={
                    hasNonZeroBarData(monthlyDividendSeries.slice(-12))
                      ? monthlyDividendSeries.slice(-12)
                      : []
                  }
                  title={t(
                    "Monthly Dividend Income (12M)",
                    "每月股息收益（12個月）",
                  )}
                  positiveColor="#1f9a72"
                  negativeColor="#c84f4f"
                />
                <BarChart
                  data={
                    hasNonZeroBarData(monthlyFeeSeries.slice(-12))
                      ? monthlyFeeSeries.slice(-12)
                      : []
                  }
                  title={t("Monthly Fee (12M)", "每月手續費（12個月）")}
                  positiveColor="#4f8fd9"
                  negativeColor="#c84f4f"
                />
              </section>

              <section className="dual-column-grid">
                <BarChart
                  data={
                    hasNonZeroBarData(monthlyCashFlowSeries.slice(-12))
                      ? monthlyCashFlowSeries.slice(-12)
                      : []
                  }
                  title={t("Monthly Cash Flow (12M)", "每月現金流（12個月）")}
                  positiveColor="#2f7dd6"
                  negativeColor="#c84f4f"
                />
                <BarChart
                  data={
                    hasNonZeroBarData(monthlyProfitBarSeries.slice(-12))
                      ? monthlyProfitBarSeries.slice(-12)
                      : []
                  }
                  title={t(
                    "Monthly Profit Histogram (12M)",
                    "每月收益柱狀圖（12個月）",
                  )}
                  positiveColor="#1f9a72"
                  negativeColor="#d14e4e"
                />
              </section>

              <section className="table-panel">
                <MultiLineChart
                  series={compareSeries}
                  title={t(
                    "Top Stock Comparison (Indexed = 100)",
                    "主要股票比較（基準=100）",
                  )}
                />
              </section>

              <section className="table-panel">
                <AreaChart
                  points={portfolioProfitSeries}
                  label={t("Portfolio profit chart", "組合盈虧圖")}
                />
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
                  title={t(
                    "Dividend Seasonality (By Month)",
                    "股息季節性（按月份）",
                  )}
                  positiveColor="#1f9a72"
                />
              </section>

              <section className="table-panel">
                <HeatmapGrid
                  data={transactionHeatmap}
                  title={t(
                    "Transaction Activity Heatmap (12M x Type)",
                    "交易活躍熱力圖（12個月 x 類型）",
                  )}
                />
              </section>

              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>
                    {t(
                      "Rebalance Suggestions (Equal Weight Baseline)",
                      "再平衡建議（等權重基準）",
                    )}
                  </h3>
                </div>
                <div className="table-scroll">
                  <table className="data-table rebalance-table">
                    <thead>
                      <tr>
                        <th>{t("Symbol", "代號")}</th>
                        <th>{t("Current Weight", "目前權重")}</th>
                        <th>{t("Target Weight", "目標權重")}</th>
                        <th>{t("Diff %", "差異%")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rebalanceSuggestions.map((item) => (
                        <tr key={item.symbol}>
                          <td>{item.symbol}</td>
                          <td>{displayPercent(item.currentWeightPct)}</td>
                          <td>{displayPercent(item.targetWeightPct)}</td>
                          <td
                            className={
                              item.diffPct >= 0 ? "negative" : "positive"
                            }
                          >
                            {displayPercent(item.diffPct)}
                          </td>
                        </tr>
                      ))}
                      {rebalanceSuggestions.length === 0 && (
                        <tr>
                          <td colSpan={4} className="empty-cell">
                            {t("No rebalance signals.", "暫無再平衡訊號。")}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </section>
          )}

          {activeTab === "holdings" && (
            <section className="dual-column-grid" id="holdings">
              <section className="table-panel">
                <div className="panel-head slim">
                  <h3>
                    {t("Holding Stocks", "持倉股票")} (
                    {displayedHoldingStocks.length})
                  </h3>
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
                        setHoldingSort(
                          event.target.value as
                            | "marketValue"
                            | "profit"
                            | "symbol",
                        )
                      }
                    >
                      <option value="marketValue">
                        {t("Market Value", "市值")}
                      </option>
                      <option value="profit">
                        {t("Total Profit", "總盈虧")}
                      </option>
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
                          <td>
                            {displayMoney(item.marketValue, item.currency)}
                          </td>
                          <td
                            className={
                              item.totalProfit >= 0 ? "positive" : "negative"
                            }
                          >
                            {displayMoney(item.totalProfit, item.currency)}
                          </td>
                          <td
                            className={
                              item.holdingProfit >= 0 ? "positive" : "negative"
                            }
                          >
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
                  <h3>
                    {t("Closed Stocks", "已平倉股票")} (
                    {displayedClosedStocks.length})
                  </h3>
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
                          <td
                            className={
                              item.realizedProfit >= 0 ? "positive" : "negative"
                            }
                          >
                            {displayMoney(item.realizedProfit, item.currency)}
                          </td>
                          <td>
                            {displayMoney(item.totalDividend, item.currency)}
                          </td>
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
                <button
                  type="button"
                  className="primary-btn"
                  onClick={openCreateTransaction}
                >
                  {t("Add Transaction", "新增交易")}
                </button>
              </div>

              <div className="filters-row">
                <label>
                  {t("Search", "搜尋")}
                  <input
                    value={txKeyword}
                    onChange={(event) => setTxKeyword(event.target.value)}
                    placeholder={t(
                      "Symbol / portfolio / note",
                      "代號 / 組合 / 備註",
                    )}
                  />
                </label>
                <label>
                  {t("Date Range", "日期範圍")}
                  <select
                    value={txDateFilter}
                    onChange={(event) =>
                      setTxDateFilter(event.target.value as DateFilterPreset)
                    }
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
                    onChange={(event) =>
                      setTxTypeFilter(
                        event.target.value as TransactionTypeFilter,
                      )
                    }
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
                        onChange={(event) =>
                          setTxCustomStart(event.target.value)
                        }
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
                  <span>
                    {t("Count", "筆數")}: {filteredTransactions.length}
                  </span>
                  <span>
                    {t("Net", "淨額")}:{" "}
                    {displayMoney(
                      transactionNetValue,
                      filteredEntities[0]?.currency ?? "USD",
                    )}
                  </span>
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
                        <td>{getTransactionSymbolDisplayText(row)}</td>
                        <td>{row.shares.toFixed(4)}</td>
                        <td>{displayMoney(row.price, row.currency)}</td>
                        <td>{displayMoney(row.fee, row.currency)}</td>
                        <td
                          className={
                            getTransactionNetCashFlow(row) >= 0
                              ? "positive"
                              : "negative"
                          }
                        >
                          {displayMoney(
                            getTransactionNetCashFlow(row),
                            row.currency,
                          )}
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
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={openCreatePortfolioModal}
                  >
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
                  <div className="portfolio-switcher-title">
                    {t("Select Portfolio", "選擇組合")}
                  </div>
                  <div className="portfolio-switcher">
                    <button
                      type="button"
                      className={`portfolio-pill ${selectedPortfolioId === "all" ? "active" : ""}`}
                      onClick={() => selectPortfolioFilter(ALL_PORTFOLIO_ID)}
                    >
                      {t("All", "全部")}
                    </button>
                    {entities.map((entity) => (
                      <button
                        type="button"
                        key={entity.id}
                        className={`portfolio-pill ${selectedPortfolioId === entity.id ? "active" : ""}`}
                        onClick={() => selectPortfolioFilter(entity.id)}
                      >
                        {entity.name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cash-balance-list">
                  <h4>{t("Cash Balances", "現金結餘")}</h4>
                  {cashBalances.length === 0 && (
                    <p>{t("No cash balances.", "沒有現金結餘。")}</p>
                  )}
                  {cashBalances.map((item) => (
                    <div key={item.currency} className="cash-balance-row">
                      <span>{item.currency}</span>
                      <strong
                        className={item.balance >= 0 ? "positive" : "negative"}
                      >
                        {displayMoney(item.balance, item.currency)}
                      </strong>
                    </div>
                  ))}
                </div>
              </section>

              {false && (
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
                  <label
                    className={`upload-box compact ${isDataUploadDragOver ? "drag-over" : ""}`}
                    onDragOver={onDataUploadDragOver}
                    onDragLeave={onDataUploadDragLeave}
                    onDrop={(event) => {
                      void onDataUploadDrop(event);
                    }}
                  >
                    <input
                      type="file"
                      onChange={onDataImportFileChange}
                      accept="*/*"
                      multiple
                    />
                    <span>
                      {loading
                        ? t("Importing...", "正在匯入...")
                        : t("Import and Replace Data", "匯入並覆蓋資料")}
                    </span>
                    <small>
                      {t(
                        "Supports multi-file drag and drop.",
                        "支援多檔拖放匯入。",
                      )}
                    </small>
                  </label>

                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={exportWebJson}
                    disabled={entities.length === 0}
                  >
                    {t("Export Web JSON", "匯出 Web JSON")}
                  </button>

                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={exportStockerProJson}
                    disabled={!dualFormatRecords}
                  >
                    {t("Export Stocker Pro JSON", "匯出 Stocker Pro JSON")}
                  </button>

                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={exportStockerXJson}
                    disabled={!dualFormatRecords}
                  >
                    {t("Export StockerX JSON", "匯出 StockerX JSON")}
                  </button>

                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setScreen("choose")}
                  >
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

                {errorMessage && (
                  <div className="error-text">{errorMessage}</div>
                )}
                {importStatusMessage && (
                  <div className="success-text">{importStatusMessage}</div>
                )}
                <p className="settings-hint">
                  {t(
                    "Each client can upload up to 20 files per month. AI normalization fallback is also quota-protected server-side.",
                    "每個客戶端每月最多可上傳 20 個檔案，AI 轉換備援亦有伺服器配額保護。",
                  )}
                </p>
              </section>
              )}
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
                      <p>
                        {t(
                          "Hide amount and percentage numbers on screen.",
                          "隱藏畫面上的金額與百分比。",
                        )}
                      </p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.showObscure}
                      onChange={(event) =>
                        updateSetting("showObscure", event.target.checked)
                      }
                    />
                  </label>
                  <label className="setting-row">
                    <div>
                      <strong>{t("Enable Animations", "啟用動畫")}</strong>
                      <p>
                        {t(
                          "Turn transitions and entrance animations on or off.",
                          "開啟或關閉過場與入場動畫。",
                        )}
                      </p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.enableAnimations}
                      onChange={(event) =>
                        updateSetting("enableAnimations", event.target.checked)
                      }
                    />
                  </label>
                  <label className="setting-row">
                    <div>
                      <strong>{t("Compact Tables", "緊湊表格")}</strong>
                      <p>
                        {t(
                          "Use denser rows to display more records in each table.",
                          "用更緊密行距顯示更多資料。",
                        )}
                      </p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.compactTables}
                      onChange={(event) =>
                        updateSetting("compactTables", event.target.checked)
                      }
                    />
                  </label>
                  <label className="setting-row">
                    <div>
                      <strong>
                        {t("Include Cash in Allocation", "配置中包含現金")}
                      </strong>
                      <p>
                        {t(
                          "Show cash as a separate asset slice in allocation chart.",
                          "在資產配置圖中把現金獨立顯示。",
                        )}
                      </p>
                    </div>
                    <input
                      className="setting-toggle"
                      type="checkbox"
                      checked={settings.showCashInAllocation}
                      onChange={(event) =>
                        updateSetting(
                          "showCashInAllocation",
                          event.target.checked,
                        )
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
                      onChange={(event) =>
                        updateSetting("language", event.target.value as Locale)
                      }
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
                        updateSetting(
                          "defaultCurrency",
                          event.target.value.toUpperCase(),
                        )
                      }
                      placeholder="USD"
                      maxLength={6}
                    />
                  </label>
                  <label>
                    {t("Display Currency", "顯示貨幣")}
                    <select
                      value={normalizedDisplayCurrency}
                      onChange={(event) =>
                        updateSetting(
                          "displayCurrency",
                          normalizeCurrencyCode(event.target.value) || "AUTO",
                        )
                      }
                    >
                      <option value="AUTO">
                        {t("Auto (Original)", "自動（原貨幣）")}
                      </option>
                      {displayCurrencyOptions.map((currency) => (
                        <option key={currency} value={currency}>
                          {currency}
                        </option>
                      ))}
                    </select>
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
                    "Defaults are saved locally, and portfolio data is synced to Firebase after sign-in.",
                    "預設值會儲存在本機，而投資資料會於登入後同步到 Firebase。",
                  )}
                </p>
                <p className={`settings-hint ${fxSyncError ? "negative" : ""}`}>
                  {displayCurrencyStatusText}
                </p>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={resetSettings}
                  >
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

      {isImportReviewOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeImportReview}
        >
          <div
            className="modal-card import-review-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-head slim">
              <h3>{t("Review Imported Transactions", "檢查匯入交易")}</h3>
              <div className="import-review-head-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={closeImportReview}
                >
                  {t("Cancel", "取消")}
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={confirmImportReview}
                >
                  {t("Confirm Import", "確認匯入")}
                </button>
              </div>
            </div>

            <div className="import-review-summary">
              <div className="import-review-summary-item">
                <span>{t("Portfolios", "組合數")}</span>
                <strong>{importReviewEntities.length}</strong>
              </div>
              <div className="import-review-summary-item">
                <span>{t("Transactions", "交易數")}</span>
                <strong>{importReviewTxCount}</strong>
              </div>
              <div className="import-review-summary-item">
                <span>{t("Source File", "來源檔案")}</span>
                <strong>{importReviewSource?.fileName ?? "-"}</strong>
              </div>
              <div className="import-review-summary-item">
                <span>{t("File Count", "檔案數")}</span>
                <strong>{importReviewSource?.fileCount ?? 0}</strong>
              </div>
              <div className="import-review-summary-item">
                <span>{t("AI Quota", "AI 配額")}</span>
                <strong>
                  {typeof importReviewSource?.aiQuota?.remaining === "number"
                    ? t(
                        `${importReviewSource.aiQuota.remaining} left`,
                        `剩餘 ${importReviewSource.aiQuota.remaining} 次`,
                      )
                    : t("Not used", "未使用")}
                </strong>
              </div>
            </div>

            {importReviewSource && importReviewSource.fileCount > 1 && (
              <p className="settings-hint import-review-files">
                {t("Included files:", "包含檔案：")}{" "}
                {importReviewSource.fileNames.join(", ")}
              </p>
            )}

            <p className="settings-hint">
              {t(
                "Please verify and edit any row before confirming import.",
                "請先檢查並可直接編輯每筆資料，確認後才會正式匯入。",
              )}
            </p>

            <div className="table-scroll import-review-table">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("Portfolio", "組合")}</th>
                    <th>{t("Date", "日期")}</th>
                    <th>{t("Type", "類型")}</th>
                    <th>{t("Symbol", "代號")}</th>
                    <th>{t("Shares / Amount", "股數 / 金額")}</th>
                    <th>{t("Price", "價格")}</th>
                    <th>{t("Fee", "費用")}</th>
                    <th>{t("Currency", "貨幣")}</th>
                    <th>{t("Note", "備註")}</th>
                    <th>{t("Action", "動作")}</th>
                  </tr>
                </thead>
                <tbody>
                  {importReviewRows.map((row) => (
                    <tr key={`${row.portfolioId}-${row.id}`}>
                      <td>
                        <select
                          value={row.portfolioId}
                          onChange={(event) =>
                            moveImportReviewTransaction(
                              row.portfolioId,
                              event.target.value,
                              row.id,
                            )
                          }
                        >
                          {importReviewEntities.map((entity) => (
                            <option key={entity.id} value={entity.id}>
                              {entity.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="date"
                          value={toDateInputValue(row.date)}
                          onChange={(event) => {
                            const parsed = parseDateInput(event.target.value);
                            if (!parsed) {
                              return;
                            }
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                date: parsed,
                              }),
                            );
                          }}
                        />
                      </td>
                      <td>
                        <select
                          value={row.type}
                          onChange={(event) =>
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                type: event.target.value as TxType,
                              }),
                            )
                          }
                        >
                          {TRANSACTION_TYPE_OPTIONS.filter(
                            (item) => item.value !== "all",
                          ).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          value={row.symbol}
                          onChange={(event) =>
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                symbol: event.target.value.toUpperCase().trim(),
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.0001"
                          value={row.shares}
                          onChange={(event) =>
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                shares: parseNumberish(event.target.value),
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.0001"
                          value={row.price}
                          onChange={(event) =>
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                price: parseNumberish(event.target.value),
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          step="0.0001"
                          value={row.fee}
                          onChange={(event) =>
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                fee: parseNumberish(event.target.value),
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={row.currency}
                          onChange={(event) =>
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                currency: event.target.value
                                  .toUpperCase()
                                  .trim(),
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={row.note ?? ""}
                          onChange={(event) =>
                            updateImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                              (tx) => ({
                                ...tx,
                                note: event.target.value,
                              }),
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="text-btn danger"
                          onClick={() =>
                            deleteImportReviewTransaction(
                              row.portfolioId,
                              row.id,
                            )
                          }
                        >
                          {t("Delete", "刪除")}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {importReviewRows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="empty-cell">
                        {t("No imported transactions.", "沒有可匯入交易。")}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="import-review-feedback">
              <label className="full-width">
                {t(
                  "If you think we misunderstand some columns, type here. We will adjust now.",
                  "如果你覺得我哋誤解咗某啲欄位，請喺呢度輸入，我哋會即時調整。",
                )}
                <textarea
                  value={importReviewFeedback}
                  onChange={(event) =>
                    setImportReviewFeedback(event.target.value)
                  }
                  placeholder={t(
                    "Example: Column A is trade amount, not shares. Column B is total value in HKD.",
                    "例如：A 欄係交易總額唔係股數；B 欄係港幣總值。",
                  )}
                />
              </label>
              <div className="import-review-feedback-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => void adjustImportReviewWithPrompt()}
                  disabled={
                    isImportReviewAdjusting || !importReviewFeedback.trim()
                  }
                >
                  {isImportReviewAdjusting
                    ? t("Adjusting...", "調整中...")
                    : t("Adjust With Prompt", "用提示即時調整")}
                </button>
              </div>
            </div>

            {importReviewError && (
              <div className="error-text">{importReviewError}</div>
            )}
          </div>
        </div>
      )}

      {stockDetail && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setSelectedStockDetailId(null)}
        >
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
              <div className="stock-detail-head-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => void refreshPortfolioQuotes("manual")}
                  disabled={isQuoteSyncing || !portfolioStockSymbolKey}
                >
                  {isQuoteSyncing
                    ? t("Syncing...", "同步中...")
                    : t("Check Stock Price", "查看股價")}
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setSelectedStockDetailId(null)}
                >
                  {t("Close", "關閉")}
                </button>
              </div>
            </div>

            <div className="stock-detail-metrics">
              <div>
                <span>{t("Current Shares", "目前股數")}</span>
                <strong>{stockDetail.activeShares.toFixed(4)}</strong>
              </div>
              <div>
                <span>{t("Live Price", "即時股價")}</span>
                <strong>
                  {displayNativeMoney(
                    stockDetailLivePrice,
                    stockDetail.currency,
                  )}
                </strong>
              </div>
              <div>
                <span>{t("Quote Updated", "報價更新")}</span>
                <strong className={quoteSyncError ? "negative" : ""}>
                  {isQuoteSyncing
                    ? t("Syncing now", "正在同步")
                    : quoteLastUpdatedAt
                      ? isZh
                        ? `${formatAgo(quoteLastUpdatedAt, settings.language)}`
                        : formatAgo(quoteLastUpdatedAt, settings.language)
                      : t("Not synced", "未同步")}
                </strong>
              </div>
              <div>
                <span>{t("Market Value", "市值")}</span>
                <strong>
                  {displayMoney(
                    stockDetailLiveMarketValue,
                    stockDetail.currency,
                  )}
                </strong>
              </div>
              <div>
                <span>{t("Total P/L", "總盈虧")}</span>
                <strong
                  className={
                    stockDetail.totalProfit >= 0 ? "positive" : "negative"
                  }
                >
                  {displayMoney(stockDetail.totalProfit, stockDetail.currency)}
                </strong>
              </div>
              <div>
                <span>{t("Realized P/L", "已實現盈虧")}</span>
                <strong
                  className={
                    stockDetail.realizedProfit >= 0 ? "positive" : "negative"
                  }
                >
                  {displayMoney(
                    stockDetail.realizedProfit,
                    stockDetail.currency,
                  )}
                </strong>
              </div>
              <div>
                <span>{t("Dividend", "股息")}</span>
                <strong>
                  {displayMoney(
                    stockDetail.totalDividend,
                    stockDetail.currency,
                  )}
                </strong>
              </div>
              <div>
                <span>{t("Total Fee", "總費用")}</span>
                <strong>
                  {displayMoney(stockDetail.totalFee, stockDetail.currency)}
                </strong>
              </div>
            </div>

            <p className={`quote-sync-note ${quoteSyncError ? "error" : ""}`}>
              {quoteStatusText}
            </p>

            <section className="valuation-chart-panel">
              <div className="panel-head slim">
                <h3>{t("Price + Profit + Trades", "股價 + 收益 + 交易點")}</h3>
                <div
                  className={`row-right ${stockDetailValuationChangePct >= 0 ? "positive" : "negative"}`}
                >
                  <strong>
                    {displayPercent(stockDetailValuationChangePct)}
                  </strong>
                </div>
              </div>
              <div className="portfolio-switcher">
                {TIME_RANGE_OPTIONS.map((option) => (
                  <button
                    key={`valuation-${option.value}`}
                    type="button"
                    className={`portfolio-pill ${valuationRange === option.value ? "active" : ""}`}
                    onClick={() => setValuationRange(option.value)}
                  >
                    {isZh && option.value === "ALL"
                      ? "全部"
                      : isZh && option.value === "CUSTOM"
                        ? "自選"
                        : option.label}
                  </button>
                ))}
              </div>
              {valuationRange === "CUSTOM" && (
                <div className="custom-range-inputs">
                  <label>
                    <span>{t("From", "由")}</span>
                    <input
                      type="date"
                      value={valuationCustomStart}
                      min={minValuationCustomDate}
                      max={valuationCustomEnd || maxValuationCustomDate}
                      onChange={onValuationCustomStartChange}
                    />
                  </label>
                  <label>
                    <span>{t("To", "至")}</span>
                    <input
                      type="date"
                      value={valuationCustomEnd}
                      min={valuationCustomStart || minValuationCustomDate}
                      max={maxValuationCustomDate}
                      onChange={onValuationCustomEndChange}
                    />
                  </label>
                </div>
              )}
              <div className="valuation-chart-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => void refreshValuationChart("manual")}
                  disabled={isValuationSyncing}
                >
                  {isValuationSyncing
                    ? t("Loading...", "載入中...")
                    : t("Refresh Valuation", "更新估價圖")}
                </button>
              </div>
              <PriceChart
                points={stockDetailValuationSeries}
                profitPoints={stockDetailSeries}
                tradeMarkers={stockDetailTradeMarkers}
                label={`${stockDetail.symbol} valuation + profit chart`}
                valueLabel={t("Price", "價格")}
                valueFormatter={(value) =>
                  displayNativeMoney(value, stockDetail.currency)
                }
                profitLabel={t("Profit", "收益")}
                profitFormatter={(value) =>
                  displayMoney(value, stockDetail.currency)
                }
              />
              <p
                className={`quote-sync-note ${valuationSyncError ? "error" : ""}`}
              >
                {valuationStatusText}
              </p>
            </section>

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
                      <td
                        className={
                          getTransactionNetCashFlow(row) >= 0
                            ? "positive"
                            : "negative"
                        }
                      >
                        {displayMoney(
                          getTransactionNetCashFlow(row),
                          row.currency,
                        )}
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

      {isNewPortfolioModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeCreatePortfolioModal}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>{t("New Portfolio", "新增組合")}</h3>
            <div className="form-grid">
              <label>
                {t("Portfolio name", "投資組合名稱")}
                <input
                  value={newPortfolioDraft.name}
                  onChange={(event) =>
                    setNewPortfolioDraft((previous) => ({
                      ...previous,
                      name: event.target.value,
                    }))
                  }
                  placeholder={t("Required", "必填")}
                  autoFocus
                />
              </label>
              <label>
                {t("Display currency", "顯示幣別")}
                <select
                  value={newPortfolioDraft.currencyType}
                  onChange={(event) =>
                    setNewPortfolioDraft((previous) => ({
                      ...previous,
                      currencyType: event.target.value,
                    }))
                  }
                >
                  {[...new Set(displayCurrencyOptions)]
                    .filter((currency) => currency !== "AUTO")
                    .map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {newPortfolioError && (
              <div className="error-text">{newPortfolioError}</div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={closeCreatePortfolioModal}
              >
                {t("Cancel", "取消")}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={createPortfolio}
              >
                {t("Create", "建立")}
              </button>
            </div>
          </div>
        </div>
      )}

      {isTxModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeTransactionModal}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>
              {editingTransaction
                ? t("Edit Transaction", "編輯交易")
                : t("Add Transaction", "新增交易")}
            </h3>

            <div className="form-grid">
              <label>
                {t("Portfolio", "組合")}
                <select
                  value={draft.portfolioId}
                  onChange={(event) => {
                    const nextPortfolioId = event.target.value;
                    const selectedPortfolio = entities.find(
                      (entity) => entity.id === nextPortfolioId,
                    );
                    setDraft((prev) => ({
                      ...prev,
                      portfolioId: nextPortfolioId,
                      currency:
                        getAutoCurrencyByDistrict(
                          normalizeTransactionDistrict(prev.district),
                        ) ??
                        normalizeCurrencyCode(selectedPortfolio?.currency) ??
                        prev.currency,
                    }));
                  }}
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
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, date: event.target.value }))
                  }
                />
              </label>

              <label>
                {t("Type", "類型")}
                <select
                  value={draft.type}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      type: event.target.value as TxType,
                      symbol: allowsSymbolInput(event.target.value as TxType)
                        ? prev.symbol
                        : "",
                    }))
                  }
                >
                  {TRANSACTION_TYPE_OPTIONS.filter(
                    (item) => item.value !== "all",
                  ).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {t("District", "地區")}
                <select
                  value={draft.district}
                  onChange={(event) => {
                    const nextDistrict = normalizeTransactionDistrict(
                      event.target.value,
                    );
                    const autoCurrency =
                      getAutoCurrencyByDistrict(nextDistrict);
                    setDraft((prev) => ({
                      ...prev,
                      district: nextDistrict,
                      currency: autoCurrency ?? prev.currency,
                    }));
                  }}
                >
                  {TRANSACTION_DISTRICT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {isZh ? option.labelZh : option.label}
                    </option>
                  ))}
                </select>
              </label>

              {allowsSymbolInput(draft.type) && (
                <label>
                  {t("Symbol", "代號")}
                  <input
                    value={draft.symbol}
                    onChange={(event) =>
                      setDraft((prev) => ({
                        ...prev,
                        symbol: event.target.value.toUpperCase(),
                      }))
                    }
                    placeholder={
                      draft.type === "FEE"
                        ? t(
                            "Optional: only for asset fee",
                            "可留空（僅資產扣款手續費才填）",
                          )
                        : t("AAPL", "例如 AAPL")
                    }
                  />
                </label>
              )}

              <label>
                {t("Shares / Amount", "股數 / 金額")}
                <input
                  value={draft.shares}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      shares: event.target.value,
                    }))
                  }
                />
              </label>

              <label>
                {t("Price", "價格")}
                <input
                  value={draft.price}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, price: event.target.value }))
                  }
                />
              </label>

              <label>
                {t("Fee", "費用")}
                <input
                  value={draft.fee}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, fee: event.target.value }))
                  }
                />
              </label>

              <label>
                {t("Currency", "貨幣")}
                <input
                  value={draft.currency}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      currency: event.target.value.toUpperCase(),
                    }))
                  }
                  readOnly={
                    normalizeTransactionDistrict(draft.district) !== "OTHER"
                  }
                  disabled={
                    normalizeTransactionDistrict(draft.district) !== "OTHER"
                  }
                />
              </label>
            </div>

            <label className="full-width">
              {t("Note", "備註")}
              <input
                value={draft.note}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, note: event.target.value }))
                }
                placeholder={t("Optional", "可選")}
              />
            </label>

            {transactionError && (
              <div className="error-text">{transactionError}</div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={closeTransactionModal}
              >
                {t("Cancel", "取消")}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={saveTransaction}
              >
                {t("Save", "儲存")}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingCashReview && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeCashReviewModal}
        >
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
                <strong>
                  {displayMoney(
                    pendingCashReview.cashBalance,
                    pendingCashReview.currency,
                  )}
                </strong>
              </div>
              <div className="cash-review-metric">
                <span>{t("Required Extra Cash", "所需額外現金")}</span>
                <strong>
                  {displayMoney(
                    pendingCashReview.shortfall,
                    pendingCashReview.currency,
                  )}
                </strong>
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
                    Math.min(
                      pendingCashReview.shortfall,
                      parseNumberish(pendingCashAmount),
                    ),
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
                onClick={closeCashReviewModal}
              >
                {t("Back", "返回")}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={confirmPendingCashReview}
              >
                {t("Confirm", "確認")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
