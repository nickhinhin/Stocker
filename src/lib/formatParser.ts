import {
  EntityDataset,
  NormalizedTransaction,
  StockerProAssetMeta,
  StockerProCashAssetMeta,
  StockerProEntityMeta,
  StockerProPortfolioMeta,
  StockerProPositionMeta,
  StockerProTransactionMeta,
  TxType,
  UserType,
} from "../types";

type UnknownRecord = Record<string, unknown>;

const SUPPORTED_TX_TYPES = new Set<TxType>([
  "BUY",
  "SELL",
  "DIVIDEND_CASH",
  "DIVIDEND_SHARE",
  "FEE",
  "INTEREST",
  "CASH",
  "CASH_CONVERT",
]);

function toNumber(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeStored(value: unknown): number {
  // Stocker Pro keeps financial fields as scaled integers in export JSON.
  return Math.round(toNumber(value) / 100) / 1_000_000_000_000;
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function parseDateLike(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return new Date();
    }
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  }

  const text = String(value ?? "").trim();
  if (!text) {
    return new Date();
  }

  const normalized = text.includes(" ")
    ? text.replace(" ", "T")
    : text.replace(/\//g, "-");
  const timestamp = Date.parse(normalized);
  if (!Number.isNaN(timestamp)) {
    return new Date(timestamp);
  }

  return new Date();
}

function sortByDateAsc(
  items: NormalizedTransaction[],
): NormalizedTransaction[] {
  return [...items].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function createTransactionId(prefix: string, values: unknown[]): string {
  const normalized = values
    .map((value) => String(value ?? "").trim())
    .join("|")
    .replace(/\s+/g, "_");
  return `${prefix}-${normalized}`;
}

function stablePositiveIntFromText(seed: string, fallback: number): number {
  const input = seed.trim();
  if (!input) {
    return Math.max(1, fallback);
  }

  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const normalized = (hash >>> 0) % 2_000_000_000;
  return Math.max(1, normalized);
}

function longestBase64Payload(text: string): string | null {
  const matches = text.match(/[A-Za-z0-9+/=]{200,}/g);
  if (!matches || matches.length === 0) {
    return null;
  }
  return matches.sort((a, b) => b.length - a.length)[0];
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function decompressBytes(
  bytes: Uint8Array,
  format: "gzip" | "deflate",
): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Current browser does not support DecompressionStream.");
  }

  const safeBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(safeBuffer).set(bytes);
  const stream = new Blob([safeBuffer])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(arrayBuffer);
}

async function decodeRawPayload(
  raw: string,
  formats: Array<"gzip" | "deflate">,
): Promise<string> {
  // Accept plain JSON files directly.
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // Continue to decode embedded payload.
  }

  const base64 = longestBase64Payload(raw);
  if (!base64) {
    throw new Error("Cannot find embedded payload in this file.");
  }

  const bytes = base64ToBytes(base64);
  for (const format of formats) {
    try {
      const text = await decompressBytes(bytes, format);
      JSON.parse(text);
      return text;
    } catch {
      // Try next decompression format.
    }
  }

  throw new Error("Cannot decode the uploaded file.");
}

function safeParseArray(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) {
    return value as UnknownRecord[];
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as UnknownRecord[]) : [];
    } catch {
      return [];
    }
  }

  return [];
}

function pushLatestPrice(
  priceMap: Record<string, { price: number; date: number }>,
  symbol: string,
  price: number,
  date: Date,
): void {
  if (!symbol || price <= 0) {
    return;
  }
  const timestamp = date.getTime();
  const existing = priceMap[symbol];
  if (!existing || timestamp >= existing.date) {
    priceMap[symbol] = { price, date: timestamp };
  }
}

function unwrapLatestPriceMap(
  map: Record<string, { price: number; date: number }>,
): Record<string, number> {
  const result: Record<string, number> = {};
  Object.entries(map).forEach(([symbol, data]) => {
    result[symbol] = data.price;
  });
  return result;
}

function isStockerXPayload(parsed: unknown): parsed is UnknownRecord[] {
  if (!Array.isArray(parsed)) {
    return false;
  }

  // StockerX payload must include at least one row with stock/dividend/fee arrays.
  return parsed.some((row) => {
    const item = asRecord(row);
    if (!item) {
      return false;
    }
    return (
      Array.isArray(item.stocks) ||
      Array.isArray(item.dividends) ||
      Array.isArray(item.fees)
    );
  });
}

function isStockerProPayload(parsed: unknown): parsed is UnknownRecord {
  const root = asRecord(parsed);
  if (!root) {
    return false;
  }

  // Stocker Pro payload should contain both portfolios and assetTransactions arrays.
  return (
    Array.isArray(root.portfolios) && Array.isArray(root.assetTransactions)
  );
}

function normalizeStockerXObject(
  item: UnknownRecord,
  index: number,
): EntityDataset {
  const name = String(item.name ?? `Stocker ${index + 1}`);
  const currency = String(item.currencyType ?? "USD");

  const stocks = safeParseArray(item.stocks);
  const dividends = safeParseArray(item.dividends);
  const fees = safeParseArray(item.fees);

  const transactions: NormalizedTransaction[] = [];
  const latestPriceMap: Record<string, { price: number; date: number }> = {};

  stocks.forEach((stock, stockIndex) => {
    const symbol = normalizeSymbol(stock.stockSymbol);
    if (!symbol) {
      return;
    }

    const date = parseDateLike(stock.date);
    const price = toNumber(stock.priceRaw ?? stock.price);
    const fee = toNumber(stock.feeRaw ?? stock.fee);
    const marketHint = toNumber(
      stock.regularPriceRaw ??
        stock.regularPrice ??
        stock.priceRaw ??
        stock.price,
    );

    const txType: TxType =
      String(stock.transaction ?? "")
        .trim()
        .toUpperCase() === "SELL"
        ? "SELL"
        : "BUY";

    transactions.push({
      id: createTransactionId("sx-stock", [
        index,
        stockIndex,
        symbol,
        date.toISOString(),
        txType,
        price,
        fee,
      ]),
      date,
      symbol,
      type: txType,
      shares: toNumber(stock.numberOfShares),
      price,
      fee,
      currency: String(stock.currencyType ?? currency),
      note: String(stock.note ?? ""),
    });

    pushLatestPrice(latestPriceMap, symbol, marketHint || price, date);
  });

  dividends.forEach((dividend, dividendIndex) => {
    const symbol = normalizeSymbol(dividend.stockSymbol);
    if (!symbol) {
      return;
    }

    const date = parseDateLike(dividend.date);
    const amount = toNumber(dividend.amountRaw ?? dividend.amount);
    const fee = toNumber(dividend.feeRaw ?? dividend.fee);

    transactions.push({
      id: createTransactionId("sx-dividend", [
        index,
        dividendIndex,
        symbol,
        date.toISOString(),
        amount,
        fee,
      ]),
      date,
      symbol,
      type: "DIVIDEND_CASH",
      shares: amount,
      price: 1,
      fee,
      currency: String(dividend.currencyType ?? currency),
      note: String(dividend.note ?? ""),
    });
  });

  // Some StockerX files export extra fee entries; include them when tied to a symbol.
  fees.forEach((feeItem, feeIndex) => {
    const symbol = normalizeSymbol(feeItem.stockSymbol);
    if (!symbol) {
      return;
    }

    transactions.push({
      id: createTransactionId("sx-fee", [
        index,
        feeIndex,
        symbol,
        feeItem.date,
        feeItem.amount,
        feeItem.fee,
      ]),
      date: parseDateLike(feeItem.date),
      symbol,
      type: "FEE",
      shares: toNumber(feeItem.amount ?? feeItem.fee),
      price: 1,
      fee: 0,
      currency: String(feeItem.currencyType ?? currency),
      note: String(feeItem.note ?? ""),
    });
  });

  return {
    id: String(item.key ?? `${name}-${index}`),
    name,
    currency,
    transactions: sortByDateAsc(transactions),
    latestPriceBySymbol: unwrapLatestPriceMap(latestPriceMap),
  };
}

function normalizeStockerProObject(data: UnknownRecord): EntityDataset[] {
  const portfolios = Array.isArray(data.portfolios)
    ? (data.portfolios as UnknownRecord[])
    : [];
  const assets = Array.isArray(data.assets)
    ? (data.assets as UnknownRecord[])
    : [];
  const positions = Array.isArray(data.positions)
    ? (data.positions as UnknownRecord[])
    : [];
  const cashAssets = Array.isArray(data.cashAssets)
    ? (data.cashAssets as UnknownRecord[])
    : [];
  const transactions = Array.isArray(data.assetTransactions)
    ? (data.assetTransactions as UnknownRecord[])
    : [];
  const manualMarketPrice = Array.isArray(data.manualMarketPrice)
    ? (data.manualMarketPrice as UnknownRecord[])
    : [];

  const positionsByAssetId = new Map<number, StockerProPositionMeta[]>();
  positions.forEach((raw) => {
    const assetId = toNumber(raw.assetId);
    if (!assetId) {
      return;
    }
    const normalizedPosition: StockerProPositionMeta = {
      id: toNumber(raw.id),
      assetId,
      type: raw.type == null ? null : String(raw.type),
      cumulativeCost:
        raw.cumulativeCost == null ? null : toNumber(raw.cumulativeCost),
    };
    if (!positionsByAssetId.has(assetId)) {
      positionsByAssetId.set(assetId, []);
    }
    positionsByAssetId.get(assetId)!.push(normalizedPosition);
  });

  const assetsByPortfolioId = new Map<number, StockerProAssetMeta[]>();
  assets.forEach((raw) => {
    const portfolioId = toNumber(raw.portfolioId);
    if (!portfolioId) {
      return;
    }
    const normalized: StockerProAssetMeta = {
      id: toNumber(raw.id),
      currencyType: normalizeCurrency(raw.currencyType, "USD"),
      assetType: raw.assetType == null ? null : String(raw.assetType),
      symbol: normalizeSymbol(raw.symbol),
      tags: raw.tags ?? null,
      note: raw.note == null ? null : String(raw.note),
      assetName: raw.assetName == null ? null : String(raw.assetName),
      portfolioId,
      region: raw.region == null ? null : String(raw.region),
      displayOrder:
        raw.displayOrder == null
          ? null
          : Math.trunc(toNumber(raw.displayOrder)),
    };
    if (!assetsByPortfolioId.has(portfolioId)) {
      assetsByPortfolioId.set(portfolioId, []);
    }
    assetsByPortfolioId.get(portfolioId)!.push(normalized);
  });

  const cashAssetsByPortfolioId = new Map<number, StockerProCashAssetMeta[]>();
  cashAssets.forEach((raw) => {
    const portfolioId = toNumber(raw.portfolioId);
    if (!portfolioId) {
      return;
    }
    const normalized: StockerProCashAssetMeta = {
      id: toNumber(raw.id),
      currencyType: normalizeCurrency(raw.currencyType, "USD"),
      portfolioId,
    };
    if (!cashAssetsByPortfolioId.has(portfolioId)) {
      cashAssetsByPortfolioId.set(portfolioId, []);
    }
    cashAssetsByPortfolioId.get(portfolioId)!.push(normalized);
  });

  return portfolios.map((portfolio, index) => {
    const portfolioId = toNumber(portfolio.id) || index + 1;
    const portfolioIdText = String(portfolio.id ?? `${portfolioId}`);
    const name = String(portfolio.name ?? `Portfolio ${index + 1}`);
    const currency = normalizeCurrency(portfolio.displayCurrencyType, "USD");
    const latestPriceMap: Record<string, { price: number; date: number }> = {};
    const metaByAssetSymbol: Record<string, StockerProAssetMeta> = {};
    const metaByPositionId: Record<number, StockerProPositionMeta> = {};
    const positionIdsByAssetId: Record<number, number[]> = {};
    const metaByCashCurrency: Record<string, StockerProCashAssetMeta> = {};

    (assetsByPortfolioId.get(portfolioId) ?? []).forEach((asset) => {
      const key = `${asset.symbol}|${asset.currencyType}`;
      metaByAssetSymbol[key] = asset;
      const positionMetas = positionsByAssetId.get(asset.id) ?? [];
      positionIdsByAssetId[asset.id] = positionMetas.map((item) => item.id);
      positionMetas.forEach((positionMeta) => {
        metaByPositionId[positionMeta.id] = positionMeta;
      });
    });
    (cashAssetsByPortfolioId.get(portfolioId) ?? []).forEach((cashAsset) => {
      metaByCashCurrency[cashAsset.currencyType] = cashAsset;
    });

    const portfolioMeta: StockerProPortfolioMeta = {
      id: portfolioId,
      webId:
        portfolio.webId == null || String(portfolio.webId).trim() === ""
          ? undefined
          : String(portfolio.webId),
      name,
      tags: portfolio.tags ?? null,
      note: portfolio.note == null ? null : String(portfolio.note),
      displayCurrencyType: currency,
      displayOrder:
        portfolio.displayOrder == null
          ? null
          : Math.trunc(toNumber(portfolio.displayOrder)),
    };

    const mappedTransactions: NormalizedTransaction[] = transactions
      .filter((tx) => toNumber(tx.portfolioId) === portfolioId)
      .map((tx, txIndex) => {
        const typeText = String(tx.type ?? "")
          .trim()
          .toUpperCase();
        const type: TxType = SUPPORTED_TX_TYPES.has(typeText as TxType)
          ? (typeText as TxType)
          : "CASH";

        const txCurrency = normalizeCurrency(tx.currencyType, currency);
        let symbol = normalizeSymbol(tx.symbol);

        if (
          !symbol &&
          ["CASH", "CASH_CONVERT", "FEE", "INTEREST"].includes(type)
        ) {
          symbol = txCurrency;
        }

        const dateBase = parseDateLike(
          `${toNumber(tx.year)}-${String(toNumber(tx.month)).padStart(2, "0")}-${String(
            toNumber(tx.day),
          ).padStart(2, "0")}T00:00:00`,
        );
        const timeOfDay = Math.max(
          0,
          Math.min(86_399_999, Math.trunc(toNumber(tx.time))),
        );
        const date = new Date(dateBase.getTime() + timeOfDay);
        const price = decodeStored(tx._price);
        const shares = decodeStored(tx._numberOfShares);
        const fee = decodeStored(tx._fee);

        if (
          symbol &&
          tx.assetType === "STOCK" &&
          (type === "BUY" || type === "SELL")
        ) {
          pushLatestPrice(latestPriceMap, symbol, price, date);
        }

        const rawWebTxId = String(tx.webTxId ?? "").trim();
        const normalizedTxId =
          rawWebTxId ||
          createTransactionId("sp", [
            portfolioIdText,
            txIndex,
            tx.id ?? "",
            tx.symbol ?? "",
            tx.year ?? "",
            tx.month ?? "",
            tx.day ?? "",
            tx.time ?? "",
            type,
            shares,
            price,
            fee,
          ]);
        const txMeta: StockerProTransactionMeta = {
          id: tx.id == null ? undefined : toNumber(tx.id),
          webTxId: rawWebTxId || undefined,
          assetType: tx.assetType == null ? null : String(tx.assetType),
          positionId: tx.positionId == null ? null : toNumber(tx.positionId),
          portfolioId,
          region: tx.region == null ? null : String(tx.region),
          tags: tx.tags ?? null,
          isAutoDividend:
            tx.isAutoDividend == null ? null : Boolean(tx.isAutoDividend),
          exDividendDate: tx.exDividendDate ?? null,
        };

        return {
          id: normalizedTxId,
          date,
          symbol,
          type,
          shares,
          price,
          fee,
          currency: txCurrency,
          note: String(tx.note ?? ""),
          stockerProMeta: txMeta,
        };
      });

    manualMarketPrice
      .filter((it) => toNumber(it.portfolioId) === portfolioId)
      .forEach((priceItem) => {
        const symbol = normalizeSymbol(priceItem.symbol);
        const directPrice = toNumber(priceItem.marketPrice);
        const price =
          directPrice > 0
            ? directPrice
            : decodeStored(priceItem._price ?? priceItem.price);
        pushLatestPrice(latestPriceMap, symbol, price, new Date());
      });

    return {
      id: portfolioIdText,
      name,
      currency,
      transactions: sortByDateAsc(mappedTransactions),
      latestPriceBySymbol: unwrapLatestPriceMap(latestPriceMap),
      stockerProMeta: {
        portfolio: portfolioMeta,
        assetsBySymbol: metaByAssetSymbol,
        positionsById: metaByPositionId,
        positionIdsByAssetId,
        cashAssetsByCurrency: metaByCashCurrency,
      } as StockerProEntityMeta,
    };
  });
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function normalizeCurrency(value: unknown, fallback = "USD"): string {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  return normalized || fallback;
}

function dedupeCurrencyTypes(currencyTypes: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  currencyTypes.forEach((currencyType) => {
    const normalized = normalizeCurrency(currencyType, "");
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function collectNextPortfolioMetaId(entities: EntityDataset[]): number {
  let nextPortfolioMetaId = 1;
  entities.forEach((entity, index) => {
    const metaId = Math.trunc(toNumber(entity.stockerProMeta?.portfolio.id));
    if (metaId > 0) {
      nextPortfolioMetaId = Math.max(nextPortfolioMetaId, metaId + 1);
      return;
    }
    const fallbackId = Math.trunc(toNumber(entity.id));
    if (fallbackId > 0) {
      nextPortfolioMetaId = Math.max(nextPortfolioMetaId, fallbackId + 1);
      return;
    }
    nextPortfolioMetaId = Math.max(nextPortfolioMetaId, index + 2);
  });
  return nextPortfolioMetaId;
}

function collectNextCashAssetId(entities: EntityDataset[]): number {
  let nextCashAssetId = 1;
  entities.forEach((entity) => {
    Object.values(entity.stockerProMeta?.cashAssetsByCurrency ?? {}).forEach(
      (cashAsset) => {
        const cashAssetId = Math.trunc(toNumber(cashAsset.id));
        if (cashAssetId > 0) {
          nextCashAssetId = Math.max(nextCashAssetId, cashAssetId + 1);
        }
      },
    );
  });
  return nextCashAssetId;
}

interface BuildPortfolioEntityInput {
  id: string;
  name: string;
  currencyTypes: string[];
  existingEntities: EntityDataset[];
}

export function buildPortfolioEntityWithMeta(
  input: BuildPortfolioEntityInput,
): EntityDataset {
  const nextPortfolioMetaId = collectNextPortfolioMetaId(input.existingEntities);
  const requestedId = input.id.trim();
  // Keep entity.id aligned with persisted portfolio.id to avoid cloud merge loops.
  const portfolioId = requestedId || String(nextPortfolioMetaId);
  const portfolioName = input.name.trim() || "Portfolio";
  const uniqueCurrencyTypes = dedupeCurrencyTypes(input.currencyTypes);
  const currencies =
    uniqueCurrencyTypes.length > 0 ? uniqueCurrencyTypes : ["USD"];
  const displayCurrencyType = currencies[0];
  let nextCashAssetId = collectNextCashAssetId(input.existingEntities);

  const cashAssetsByCurrency: Record<string, StockerProCashAssetMeta> = {};
  currencies.forEach((currencyType) => {
    cashAssetsByCurrency[currencyType] = {
      id: nextCashAssetId,
      currencyType,
      portfolioId: nextPortfolioMetaId,
    };
    nextCashAssetId += 1;
  });

  return {
    id: portfolioId,
    name: portfolioName,
    currency: displayCurrencyType,
    transactions: [],
    latestPriceBySymbol: {},
    stockerProMeta: {
      portfolio: {
        id: nextPortfolioMetaId,
        webId: requestedId || undefined,
        name: portfolioName,
        tags: null,
        note: "",
        displayCurrencyType,
        displayOrder: null,
      },
      assetsBySymbol: {},
      positionsById: {},
      positionIdsByAssetId: {},
      cashAssetsByCurrency,
    },
  };
}

function encodeStored(value: number): number {
  return Math.round(toNumber(value) * 100_000_000_000_000);
}

function normalizeAiTransaction(
  txRaw: unknown,
  portfolioCurrency: string,
  portfolioId: string,
  txIndex: number,
  latestPriceMap: Record<string, { price: number; date: number }>,
): NormalizedTransaction | null {
  const tx = asRecord(txRaw);
  if (!tx) {
    return null;
  }

  const typeText = String(tx.type ?? tx.transactionType ?? tx.action ?? "")
    .trim()
    .toUpperCase();
  const type: TxType = SUPPORTED_TX_TYPES.has(typeText as TxType)
    ? (typeText as TxType)
    : "CASH";

  const currency = normalizeCurrency(
    tx.currency ?? tx.currencyType,
    portfolioCurrency,
  );
  let symbol = normalizeSymbol(tx.symbol ?? tx.ticker ?? tx.assetSymbol);
  if (!symbol && ["CASH", "CASH_CONVERT", "FEE", "INTEREST"].includes(type)) {
    symbol = currency;
  }
  if (!symbol) {
    return null;
  }

  const date = parseDateLike(tx.date ?? tx.datetime ?? tx.time ?? tx.timestamp);
  const shares = toNumber(
    tx.shares ??
      tx.quantity ??
      tx.units ??
      tx.size ??
      tx.numberOfShares ??
      tx.amount ??
      0,
  );
  const price = toNumber(
    tx.price ?? tx.unitPrice ?? tx.avgPrice ?? tx.costPrice ?? 0,
  );
  const fee = toNumber(tx.fee ?? tx.commission ?? tx.serviceFee ?? 0);
  const note = String(tx.note ?? tx.memo ?? tx.remark ?? "").trim();

  if (symbol !== currency && price > 0) {
    pushLatestPrice(latestPriceMap, symbol, price, date);
  }

  return {
    id: createTransactionId("ai", [
      portfolioId,
      txIndex,
      symbol,
      type,
      date.toISOString(),
      shares,
      price,
      fee,
    ]),
    date,
    symbol,
    type,
    shares,
    price,
    fee,
    currency,
    note,
  };
}

export function normalizeAiPayloadToEntities(
  payload: unknown,
): EntityDataset[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }

  const portfolios = Array.isArray(root.portfolios) ? root.portfolios : [];

  return portfolios
    .map((portfolioRaw, index) => {
      const portfolio = asRecord(portfolioRaw);
      if (!portfolio) {
        return null;
      }

      const id = String(portfolio.id ?? `ai-portfolio-${index + 1}`);
      const name = String(portfolio.name ?? `AI Portfolio ${index + 1}`);
      const currency = normalizeCurrency(
        portfolio.currency ?? portfolio.currencyType,
        "USD",
      );
      const latestPriceMap: Record<string, { price: number; date: number }> =
        {};
      const txRows = Array.isArray(portfolio.transactions)
        ? portfolio.transactions
        : [];

      const mappedTransactions = txRows
        .map((txRaw, txIndex) =>
          normalizeAiTransaction(txRaw, currency, id, txIndex, latestPriceMap),
        )
        .filter((tx): tx is NormalizedTransaction => Boolean(tx));

      return {
        id,
        name,
        currency,
        transactions: sortByDateAsc(mappedTransactions),
        latestPriceBySymbol: unwrapLatestPriceMap(latestPriceMap),
      } as EntityDataset;
    })
    .filter((entity): entity is EntityDataset => Boolean(entity));
}

function isCashLikeType(
  type: TxType,
  symbol?: string,
  currency?: string,
): boolean {
  if (type === "CASH" || type === "CASH_CONVERT" || type === "INTEREST") {
    return true;
  }
  if (type !== "FEE") {
    return false;
  }
  const normalizedSymbol = normalizeSymbol(symbol ?? "");
  const normalizedCurrency = normalizeCurrency(currency ?? "", "USD");
  if (!normalizedSymbol) {
    return true;
  }
  return normalizedSymbol === normalizedCurrency;
}

function calculatePositionCumulativeCost(
  transactions: NormalizedTransaction[],
): number {
  let cost = 0;
  let virtualCash: number | null = null;
  for (const tx of sortByDateAsc(transactions)) {
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
    } else {
      virtualCash = (virtualCash ?? 0) + total;
    }
  }
  return Number(cost.toFixed(8));
}

const POSITION_ZERO_EPSILON = 1e-8;

function isPositionFlat(shares: number): boolean {
  return Math.abs(shares) <= POSITION_ZERO_EPSILON;
}

function sortTransactionsForPositionReassign(
  transactions: NormalizedTransaction[],
): NormalizedTransaction[] {
  return [...transactions].sort((left, right) => {
    const byDate = left.date.getTime() - right.date.getTime();
    if (byDate !== 0) {
      return byDate;
    }
    return left.id.localeCompare(right.id);
  });
}

function resolvePortfolioMetaId(
  entity: EntityDataset,
  meta: StockerProEntityMeta | undefined,
): number {
  const preferredId = Math.trunc(meta?.portfolio.id ?? toNumber(entity.id));
  if (preferredId > 0) {
    return preferredId;
  }
  return stablePositiveIntFromText(entity.id || entity.name, 1);
}

export function reassignEntityPositions(entity: EntityDataset): EntityDataset {
  const previousMeta = entity.stockerProMeta;
  const portfolioId = resolvePortfolioMetaId(entity, previousMeta);
  const portfolioCurrency = normalizeCurrency(entity.currency, "USD");

  const assetsBySymbol: Record<string, StockerProAssetMeta> =
    Object.fromEntries(
      Object.entries(previousMeta?.assetsBySymbol ?? {}).map(([key, value]) => [
        key,
        {
          ...value,
          symbol: normalizeSymbol(value.symbol),
          currencyType: normalizeCurrency(
            value.currencyType,
            portfolioCurrency,
          ),
        },
      ]),
    );
  const cashAssetsByCurrency: Record<string, StockerProCashAssetMeta> = {
    ...(previousMeta?.cashAssetsByCurrency ?? {}),
  };

  let nextAssetId = 1;
  Object.values(assetsBySymbol).forEach((asset) => {
    nextAssetId = Math.max(nextAssetId, Math.trunc(toNumber(asset.id)) + 1);
  });
  Object.values(previousMeta?.positionsById ?? {}).forEach((position) => {
    nextAssetId = Math.max(
      nextAssetId,
      Math.trunc(toNumber(position.assetId)) + 1,
    );
  });

  let nextPositionId = 1;
  Object.values(previousMeta?.positionsById ?? {}).forEach((position) => {
    nextPositionId = Math.max(
      nextPositionId,
      Math.trunc(toNumber(position.id)) + 1,
    );
  });

  const sortedTransactions = sortTransactionsForPositionReassign(
    entity.transactions,
  );
  const positionIdsByAssetId = new Map<number, number[]>();
  const positionsById = new Map<number, StockerProPositionMeta>();
  const positionStateByAsset = new Map<
    string,
    { positionId: number | null; shares: number }
  >();

  const ensureAsset = (
    symbol: string,
    currency: string,
    region: string | null | undefined,
  ): StockerProAssetMeta => {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedCurrency = normalizeCurrency(currency, portfolioCurrency);
    const key = `${normalizedSymbol}|${normalizedCurrency}`;
    const existing = assetsBySymbol[key];
    if (existing) {
      return existing;
    }

    const created: StockerProAssetMeta = {
      id: nextAssetId,
      currencyType: normalizedCurrency,
      assetType: "STOCK",
      symbol: normalizedSymbol,
      tags: null,
      note: "",
      assetName: null,
      portfolioId,
      region: region ?? "OTHERS",
      displayOrder: null,
    };
    nextAssetId += 1;
    assetsBySymbol[key] = created;
    return created;
  };

  const ensurePosition = (
    assetId: number,
    requestedType: "LONG" | "SHORT",
    state: { positionId: number | null; shares: number },
  ): number => {
    if (state.positionId != null) {
      return state.positionId;
    }
    const createdPositionId = nextPositionId;
    nextPositionId += 1;
    state.positionId = createdPositionId;
    state.shares = 0;

    const currentIds = positionIdsByAssetId.get(assetId) ?? [];
    currentIds.push(createdPositionId);
    positionIdsByAssetId.set(assetId, currentIds);

    positionsById.set(createdPositionId, {
      id: createdPositionId,
      assetId,
      type: requestedType,
      cumulativeCost: null,
    });

    return createdPositionId;
  };

  const reassignedTransactions = sortedTransactions.map((tx) => {
    const normalizedCurrency = normalizeCurrency(
      tx.currency,
      portfolioCurrency,
    );
    const normalizedSymbol = normalizeSymbol(tx.symbol) || normalizedCurrency;
    const txMeta = tx.stockerProMeta;
    const cashLike = isCashLikeType(
      tx.type,
      normalizedSymbol,
      normalizedCurrency,
    );

    if (cashLike) {
      if (!txMeta) {
        return tx;
      }
      return {
        ...tx,
        stockerProMeta: {
          ...txMeta,
          portfolioId,
          positionId: null,
        },
      };
    }

    const asset = ensureAsset(
      normalizedSymbol,
      normalizedCurrency,
      txMeta?.region,
    );
    const assetKey = `${asset.symbol}|${asset.currencyType}`;
    const state = positionStateByAsset.get(assetKey) ?? {
      positionId: null,
      shares: 0,
    };
    positionStateByAsset.set(assetKey, state);

    let assignedPositionId: number;
    switch (tx.type) {
      case "BUY":
      case "DIVIDEND_SHARE": {
        assignedPositionId = ensurePosition(asset.id, "LONG", state);
        state.shares += tx.shares;
        break;
      }
      case "SELL": {
        assignedPositionId = ensurePosition(asset.id, "SHORT", state);
        state.shares -= tx.shares;
        break;
      }
      default: {
        assignedPositionId = ensurePosition(asset.id, "LONG", state);
        break;
      }
    }

    if (isPositionFlat(state.shares)) {
      state.positionId = null;
      state.shares = 0;
    }

    const nextTxMeta: StockerProTransactionMeta = {
      ...(txMeta ?? { portfolioId }),
      portfolioId,
      assetType: txMeta?.assetType ?? "STOCK",
      region: txMeta?.region ?? asset.region ?? "OTHERS",
      positionId: assignedPositionId,
    };

    return {
      ...tx,
      symbol: normalizedSymbol,
      currency: normalizedCurrency,
      stockerProMeta: nextTxMeta,
    };
  });

  const finalPositionTxBuckets = new Map<number, NormalizedTransaction[]>();
  reassignedTransactions.forEach((tx) => {
    const positionId = tx.stockerProMeta?.positionId;
    if (positionId == null) {
      return;
    }
    const bucket = finalPositionTxBuckets.get(positionId) ?? [];
    bucket.push(tx);
    finalPositionTxBuckets.set(positionId, bucket);
  });

  const nextPositionsById = new Map<number, StockerProPositionMeta>();
  const nextPositionIdsByAssetId = new Map<number, number[]>();
  finalPositionTxBuckets.forEach((bucket, positionId) => {
    // Drop positions that have no attached transactions.
    if (bucket.length <= 0) {
      return;
    }
    const previous = positionsById.get(positionId);
    if (!previous) {
      return;
    }
    const nextPosition: StockerProPositionMeta = {
      ...previous,
      cumulativeCost: calculatePositionCumulativeCost(bucket),
    };
    nextPositionsById.set(positionId, nextPosition);
    const currentIds = nextPositionIdsByAssetId.get(nextPosition.assetId) ?? [];
    currentIds.push(positionId);
    nextPositionIdsByAssetId.set(nextPosition.assetId, currentIds);
  });

  const activeAssetIds = new Set<number>(nextPositionIdsByAssetId.keys());
  const nextAssetsBySymbol: Record<string, StockerProAssetMeta> =
    Object.fromEntries(
      Object.entries(assetsBySymbol).filter(([, asset]) =>
        activeAssetIds.has(asset.id),
      ),
    );

  const nextMeta: StockerProEntityMeta = {
    portfolio: previousMeta?.portfolio
      ? {
          ...previousMeta.portfolio,
          id: portfolioId,
          displayCurrencyType: normalizeCurrency(
            previousMeta.portfolio.displayCurrencyType,
            portfolioCurrency,
          ),
        }
      : {
          id: portfolioId,
          webId: undefined,
          name: entity.name,
          tags: null,
          note: "",
          displayCurrencyType: portfolioCurrency,
          displayOrder: null,
        },
    assetsBySymbol: nextAssetsBySymbol,
    positionsById: Object.fromEntries(nextPositionsById.entries()) as Record<
      number,
      StockerProPositionMeta
    >,
    positionIdsByAssetId: Object.fromEntries(
      [...nextPositionIdsByAssetId.entries()].map(([assetId, ids]) => [
        assetId,
        [...ids],
      ]),
    ) as Record<number, number[]>,
    cashAssetsByCurrency,
  };

  return {
    ...entity,
    transactions: reassignedTransactions,
    stockerProMeta: nextMeta,
  };
}

function buildStockerProExportObject(entities: EntityDataset[]): UnknownRecord {
  const portfolios: UnknownRecord[] = [];
  const cashAssetRecords = new Map<number, UnknownRecord>();
  const assetRecords = new Map<number, UnknownRecord>();
  const positionRecords = new Map<number, UnknownRecord>();
  const assetTransactions: UnknownRecord[] = [];
  const usedPortfolioIds = new Set<number>();
  const usedTransactionIds = new Set<number>();

  let nextPortfolioId = 1;
  let nextCashAssetId = 1;
  let nextAssetId = 1;
  let nextPositionId = 1;
  let nextTransactionId = 1;

  entities.forEach((entity) => {
    const meta = entity.stockerProMeta;
    if (meta?.portfolio.id) {
      nextPortfolioId = Math.max(nextPortfolioId, meta.portfolio.id + 1);
    }
    Object.values(meta?.cashAssetsByCurrency ?? {}).forEach((cashAsset) => {
      nextCashAssetId = Math.max(nextCashAssetId, cashAsset.id + 1);
    });
    Object.values(meta?.assetsBySymbol ?? {}).forEach((asset) => {
      nextAssetId = Math.max(nextAssetId, asset.id + 1);
    });
    Object.values(meta?.positionsById ?? {}).forEach((position) => {
      nextPositionId = Math.max(nextPositionId, position.id + 1);
    });
    entity.transactions.forEach((tx) => {
      if (tx.stockerProMeta?.id) {
        nextTransactionId = Math.max(
          nextTransactionId,
          tx.stockerProMeta.id + 1,
        );
      }
    });
  });

  entities.forEach((entity, index) => {
    const meta = entity.stockerProMeta;
    let portfolioId = meta?.portfolio.id || toNumber(entity.id) || index + 1;
    while (!portfolioId || usedPortfolioIds.has(portfolioId)) {
      portfolioId = nextPortfolioId;
      nextPortfolioId += 1;
    }
    usedPortfolioIds.add(portfolioId);
    nextPortfolioId = Math.max(nextPortfolioId, portfolioId + 1);
    const portfolioCurrency = normalizeCurrency(entity.currency, "USD");

    const rawDisplayOrder = meta?.portfolio.displayOrder;
    const portfolioRecord: UnknownRecord = {
      id: portfolioId,
      name: entity.name,
      tags: meta?.portfolio.tags ?? null,
      note:
        meta?.portfolio.note === null
          ? null
          : String(meta?.portfolio.note ?? ""),
      displayCurrencyType: portfolioCurrency,
      displayOrder:
        rawDisplayOrder == null ? null : Math.trunc(toNumber(rawDisplayOrder)),
    };
    portfolios.push(portfolioRecord);

    const assetByKey = new Map<string, StockerProAssetMeta>();
    const positionIdsByAssetId = new Map<number, number[]>();
    Object.values(meta?.assetsBySymbol ?? {}).forEach((asset) => {
      const key = `${asset.symbol}|${normalizeCurrency(asset.currencyType, portfolioCurrency)}`;
      assetByKey.set(key, asset);
      assetRecords.set(asset.id, {
        id: asset.id,
        currencyType: normalizeCurrency(asset.currencyType, portfolioCurrency),
        assetType: asset.assetType ?? "STOCK",
        symbol: asset.symbol,
        tags: asset.tags ?? null,
        note: asset.note === null ? null : String(asset.note ?? ""),
        assetName: asset.assetName ?? null,
        portfolioId,
        region: asset.region ?? "OTHERS",
        displayOrder: asset.displayOrder,
      });
    });
    Object.entries(meta?.positionIdsByAssetId ?? {}).forEach(
      ([assetIdText, positionIds]) => {
        const assetId = toNumber(assetIdText);
        positionIdsByAssetId.set(assetId, [...positionIds]);
      },
    );
    Object.values(meta?.positionsById ?? {}).forEach((position) => {
      positionRecords.set(position.id, {
        id: position.id,
        assetId: position.assetId,
        type: position.type ?? "LONG",
        cumulativeCost: position.cumulativeCost,
      });
      if (!positionIdsByAssetId.has(position.assetId)) {
        positionIdsByAssetId.set(position.assetId, []);
      }
      const ids = positionIdsByAssetId.get(position.assetId)!;
      if (!ids.includes(position.id)) {
        ids.push(position.id);
      }
    });

    const cashByCurrency = new Map<string, StockerProCashAssetMeta>();
    Object.values(meta?.cashAssetsByCurrency ?? {}).forEach((cashAsset) => {
      cashByCurrency.set(
        normalizeCurrency(cashAsset.currencyType, portfolioCurrency),
        cashAsset,
      );
      cashAssetRecords.set(cashAsset.id, {
        id: cashAsset.id,
        currencyType: normalizeCurrency(
          cashAsset.currencyType,
          portfolioCurrency,
        ),
        portfolioId,
      });
    });

    const ensureCashAsset = (currency: string): void => {
      const normalizedCurrency = normalizeCurrency(currency, portfolioCurrency);
      if (cashByCurrency.has(normalizedCurrency)) {
        return;
      }
      const created: StockerProCashAssetMeta = {
        id: nextCashAssetId,
        currencyType: normalizedCurrency,
        portfolioId,
      };
      nextCashAssetId += 1;
      cashByCurrency.set(normalizedCurrency, created);
      cashAssetRecords.set(created.id, {
        id: created.id,
        currencyType: created.currencyType,
        portfolioId: created.portfolioId,
      });
    };

    const ensureStockAsset = (
      symbol: string,
      currency: string,
      region: string | null | undefined,
    ): StockerProAssetMeta => {
      const normalizedSymbol = normalizeSymbol(symbol);
      const normalizedCurrency = normalizeCurrency(currency, portfolioCurrency);
      const key = `${normalizedSymbol}|${normalizedCurrency}`;
      const existing = assetByKey.get(key);
      if (existing) {
        return existing;
      }
      const created: StockerProAssetMeta = {
        id: nextAssetId,
        currencyType: normalizedCurrency,
        assetType: "STOCK",
        symbol: normalizedSymbol,
        tags: null,
        note: "",
        assetName: null,
        portfolioId,
        region: region ?? "OTHERS",
        displayOrder: null,
      };
      nextAssetId += 1;
      assetByKey.set(key, created);
      assetRecords.set(created.id, {
        id: created.id,
        currencyType: created.currencyType,
        assetType: created.assetType,
        symbol: created.symbol,
        tags: created.tags,
        note: created.note,
        assetName: created.assetName,
        portfolioId: created.portfolioId,
        region: created.region,
        displayOrder: created.displayOrder,
      });
      return created;
    };

    const positionTxBuckets = new Map<number, NormalizedTransaction[]>();
    const positionShares = new Map<number, number>();

    const sorted = sortByDateAsc(entity.transactions);
    ensureCashAsset(portfolioCurrency);

    sorted.forEach((tx) => {
      const date = tx.date;
      const time =
        date.getHours() * 3_600_000 +
        date.getMinutes() * 60_000 +
        date.getSeconds() * 1_000 +
        date.getMilliseconds();
      const type: TxType = SUPPORTED_TX_TYPES.has(tx.type) ? tx.type : "CASH";
      const currency = normalizeCurrency(tx.currency, portfolioCurrency);
      const symbol = normalizeSymbol(tx.symbol) || currency;
      const isCashType = isCashLikeType(type, symbol, currency);
      const txMeta = tx.stockerProMeta;

      ensureCashAsset(currency);

      let assetType = txMeta?.assetType;
      let region = txMeta?.region;
      let positionId = txMeta?.positionId ?? null;
      if (assetType === undefined) {
        assetType = isCashType ? "CASH" : "STOCK";
      }

      if (!isCashType) {
        const asset = ensureStockAsset(symbol, currency, region);
        if (region === undefined) {
          region = asset.region ?? "OTHERS";
        }
        assetType = assetType || "STOCK";

        if (!positionIdsByAssetId.has(asset.id)) {
          positionIdsByAssetId.set(asset.id, []);
        }

        const knownPositionIds = positionIdsByAssetId.get(asset.id)!;
        if (positionId != null && !knownPositionIds.includes(positionId)) {
          knownPositionIds.push(positionId);
        }

        let selectedPositionId = positionId;
        if (selectedPositionId == null) {
          const activePositionId = knownPositionIds.find(
            (id) => (positionShares.get(id) ?? 0) > 0,
          );
          if (activePositionId != null) {
            selectedPositionId = activePositionId;
          } else {
            selectedPositionId = nextPositionId;
            nextPositionId += 1;
            knownPositionIds.push(selectedPositionId);
            positionRecords.set(selectedPositionId, {
              id: selectedPositionId,
              assetId: asset.id,
              type: "LONG",
              cumulativeCost: null,
            });
          }
        }
        positionId = selectedPositionId;

        if (!positionRecords.has(positionId)) {
          positionRecords.set(positionId, {
            id: positionId,
            assetId: asset.id,
            type: "LONG",
            cumulativeCost: null,
          });
        }

        const existingShares = positionShares.get(positionId) ?? 0;
        if (type === "BUY" || type === "DIVIDEND_SHARE") {
          positionShares.set(positionId, existingShares + tx.shares);
        } else if (type === "SELL") {
          positionShares.set(positionId, existingShares - tx.shares);
        } else {
          positionShares.set(positionId, existingShares);
        }

        if (!positionTxBuckets.has(positionId)) {
          positionTxBuckets.set(positionId, []);
        }
        positionTxBuckets.get(positionId)!.push(tx);
      }

      let txId = txMeta?.id ?? nextTransactionId;
      while (usedTransactionIds.has(txId)) {
        txId += 1;
      }
      usedTransactionIds.add(txId);
      nextTransactionId = Math.max(nextTransactionId, txId + 1);

      assetTransactions.push({
        id: txId,
        webTxId: txMeta?.webTxId ?? tx.id,
        currencyType: currency,
        assetType,
        symbol,
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        time,
        type,
        _numberOfShares: encodeStored(tx.shares),
        _price: encodeStored(tx.price),
        _fee: encodeStored(tx.fee),
        tags: txMeta?.tags ?? null,
        note: tx.note ?? "",
        positionId,
        portfolioId,
        region: region ?? null,
        isAutoDividend: txMeta?.isAutoDividend ?? null,
        exDividendDate: txMeta?.exDividendDate ?? null,
      });
    });

    positionTxBuckets.forEach((bucket, positionId) => {
      const current = positionRecords.get(positionId) ?? { id: positionId };
      positionRecords.set(positionId, {
        ...current,
        cumulativeCost: calculatePositionCumulativeCost(bucket),
      });
    });

    const activePositionIds = new Set<number>(positionTxBuckets.keys());
    const entityPositionIds = new Set<number>();
    positionIdsByAssetId.forEach((ids) => {
      ids.forEach((id) => entityPositionIds.add(id));
    });
    entityPositionIds.forEach((positionId) => {
      if (!activePositionIds.has(positionId)) {
        positionRecords.delete(positionId);
      }
    });

    const activeAssetIds = new Set<number>();
    activePositionIds.forEach((positionId) => {
      const position = positionRecords.get(positionId);
      if (!position) {
        return;
      }
      activeAssetIds.add(toNumber(position.assetId));
    });
    const entityAssetIds = new Set<number>();
    assetByKey.forEach((asset) => {
      entityAssetIds.add(toNumber(asset.id));
    });
    entityAssetIds.forEach((assetId) => {
      if (!activeAssetIds.has(assetId)) {
        assetRecords.delete(assetId);
      }
    });
  });

  const cashAssets = [...cashAssetRecords.values()].sort(
    (a, b) => toNumber(a.id) - toNumber(b.id),
  );
  const assets = [...assetRecords.values()].sort(
    (a, b) => toNumber(a.id) - toNumber(b.id),
  );
  const positions = [...positionRecords.values()].sort(
    (a, b) => toNumber(a.id) - toNumber(b.id),
  );

  let marketPriceId = 1;
  const manualMarketPrice: UnknownRecord[] = [];
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  entities.forEach((entity) => {
    Object.entries(entity.latestPriceBySymbol).forEach(([symbol, price]) => {
      if (!symbol || !Number.isFinite(price) || price <= 0) {
        return;
      }
      manualMarketPrice.push({
        id: marketPriceId,
        year,
        month,
        day,
        marketPrice: price,
        symbol: symbol.trim().toUpperCase(),
      });
      marketPriceId += 1;
    });
  });

  return {
    portfolios,
    cashAssets,
    assets,
    positions,
    assetTransactions,
    manualMarketPrice,
  };
}

function buildStockerXExportObject(entities: EntityDataset[]): UnknownRecord[] {
  return entities.map((entity, index) => {
    const stocks: UnknownRecord[] = [];
    const dividends: UnknownRecord[] = [];
    const fees: UnknownRecord[] = [];

    sortByDateAsc(entity.transactions).forEach((tx) => {
      const currency = normalizeCurrency(
        tx.currency,
        normalizeCurrency(entity.currency, "USD"),
      );
      const symbol = normalizeSymbol(tx.symbol) || currency;
      const isoDate = tx.date.toISOString();

      if (
        tx.type === "BUY" ||
        tx.type === "SELL" ||
        tx.type === "DIVIDEND_SHARE"
      ) {
        stocks.push({
          stockSymbol: symbol,
          date: isoDate,
          numberOfShares: tx.shares,
          priceRaw: tx.price,
          price: tx.price,
          feeRaw: tx.fee,
          fee: tx.fee,
          currencyType: currency,
          transaction: tx.type === "SELL" ? "SELL" : "BUY",
          note: tx.note ?? "",
        });
        return;
      }

      if (tx.type === "DIVIDEND_CASH") {
        const amount = tx.shares * tx.price;
        dividends.push({
          stockSymbol: symbol,
          date: isoDate,
          amountRaw: amount,
          amount,
          feeRaw: tx.fee,
          fee: tx.fee,
          currencyType: currency,
          note: tx.note ?? "",
        });
        return;
      }

      const cashValue = tx.shares * tx.price;
      fees.push({
        stockSymbol: symbol,
        date: isoDate,
        amount: cashValue,
        fee: tx.fee,
        currencyType: currency,
        note: `${tx.type}${tx.note ? ` | ${tx.note}` : ""}`,
      });
    });

    return {
      key: entity.id || `stockerx-${index + 1}`,
      name: entity.name || `Stocker ${index + 1}`,
      currencyType: normalizeCurrency(entity.currency, "USD"),
      stocks,
      dividends,
      fees,
    };
  });
}

export interface DualFormatRecords {
  stockerProJson: string;
  stockerXJson: string;
}

export function buildDualFormatRecords(
  entities: EntityDataset[],
): DualFormatRecords {
  return {
    stockerProJson: JSON.stringify(
      buildStockerProExportObject(entities),
      null,
      2,
    ),
    stockerXJson: JSON.stringify(buildStockerXExportObject(entities), null, 2),
  };
}

export async function parseInputByType(
  raw: string,
  type: UserType,
): Promise<EntityDataset[]> {
  if (type === "new") {
    return [
      {
        id: "new-user",
        name: "My Stocker Pro",
        currency: "USD",
        transactions: [],
        latestPriceBySymbol: {},
      },
    ];
  }

  if (type === "stockerx") {
    const decoded = await decodeRawPayload(raw, ["gzip", "deflate"]);
    const parsed = JSON.parse(decoded);
    if (!isStockerXPayload(parsed)) {
      throw new Error("Invalid StockerX format.");
    }
    return parsed.map((item, index) =>
      normalizeStockerXObject(item as UnknownRecord, index),
    );
  }

  const decoded = await decodeRawPayload(raw, ["deflate", "gzip"]);
  const parsed = JSON.parse(decoded);
  console.log("[cloud:pull] parsed:", parsed);
  if (!isStockerProPayload(parsed)) {
    throw new Error("Invalid Stocker Pro format.");
  }
  return normalizeStockerProObject(parsed);
}
