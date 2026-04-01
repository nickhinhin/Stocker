import {
  EntityDataset,
  NormalizedTransaction,
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

function sortByDateAsc(items: NormalizedTransaction[]): NormalizedTransaction[] {
  return [...items].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function createTransactionId(prefix: string, values: unknown[]): string {
  const normalized = values
    .map((value) => String(value ?? "").trim())
    .join("|")
    .replace(/\s+/g, "_");
  return `${prefix}-${normalized}`;
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
  const stream = new Blob([safeBuffer]).stream().pipeThrough(new DecompressionStream(format));
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

function normalizeStockerXObject(item: UnknownRecord, index: number): EntityDataset {
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
      stock.regularPriceRaw ?? stock.regularPrice ?? stock.priceRaw ?? stock.price,
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
  const portfolios = Array.isArray(data.portfolios) ? (data.portfolios as UnknownRecord[]) : [];
  const transactions = Array.isArray(data.assetTransactions)
    ? (data.assetTransactions as UnknownRecord[])
    : [];
  const manualMarketPrice = Array.isArray(data.manualMarketPrice)
    ? (data.manualMarketPrice as UnknownRecord[])
    : [];

  return portfolios.map((portfolio, index) => {
    const portfolioId = toNumber(portfolio.id);
    const name = String(portfolio.name ?? `Portfolio ${index + 1}`);
    const currency = String(portfolio.displayCurrencyType ?? "USD");
    const latestPriceMap: Record<string, { price: number; date: number }> = {};

    const mappedTransactions: NormalizedTransaction[] = transactions
      .filter((tx) => toNumber(tx.portfolioId) === portfolioId)
      .map((tx, txIndex) => {
        const typeText = String(tx.type ?? "").trim().toUpperCase();
        const type: TxType = SUPPORTED_TX_TYPES.has(typeText as TxType)
          ? (typeText as TxType)
          : "CASH";

        const txCurrency = String(tx.currencyType ?? currency);
        let symbol = normalizeSymbol(tx.symbol);

        if (!symbol && ["CASH", "CASH_CONVERT", "FEE", "INTEREST"].includes(type)) {
          symbol = txCurrency;
        }

        const date = parseDateLike(
          `${toNumber(tx.year)}-${String(toNumber(tx.month)).padStart(2, "0")}-${String(
            toNumber(tx.day),
          ).padStart(2, "0")}T00:00:00`,
        );
        const price = decodeStored(tx._price);
        const shares = decodeStored(tx._numberOfShares);
        const fee = decodeStored(tx._fee);

        if (symbol && tx.assetType === "STOCK") {
          pushLatestPrice(latestPriceMap, symbol, price, date);
        }

        return {
          id: createTransactionId("sp", [
            portfolioId,
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
          ]),
          date,
          symbol,
          type,
          shares,
          price,
          fee,
          currency: txCurrency,
          note: String(tx.note ?? ""),
        };
      });

    manualMarketPrice
      .filter((it) => toNumber(it.portfolioId) === portfolioId)
      .forEach((priceItem) => {
        const symbol = normalizeSymbol(priceItem.symbol);
        const price = decodeStored(priceItem._price ?? priceItem.price);
        pushLatestPrice(latestPriceMap, symbol, price, new Date());
      });

    return {
      id: String(portfolio.id ?? `portfolio-${index + 1}`),
      name,
      currency,
      transactions: sortByDateAsc(mappedTransactions),
      latestPriceBySymbol: unwrapLatestPriceMap(latestPriceMap),
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

  const currency = normalizeCurrency(tx.currency ?? tx.currencyType, portfolioCurrency);
  let symbol = normalizeSymbol(tx.symbol ?? tx.ticker ?? tx.assetSymbol);
  if (!symbol && ["CASH", "CASH_CONVERT", "FEE", "INTEREST"].includes(type)) {
    symbol = currency;
  }
  if (!symbol) {
    return null;
  }

  const date = parseDateLike(tx.date ?? tx.datetime ?? tx.time ?? tx.timestamp);
  const shares = toNumber(
    tx.shares ?? tx.quantity ?? tx.units ?? tx.size ?? tx.numberOfShares ?? tx.amount ?? 0,
  );
  const price = toNumber(tx.price ?? tx.unitPrice ?? tx.avgPrice ?? tx.costPrice ?? 0);
  const fee = toNumber(tx.fee ?? tx.commission ?? tx.serviceFee ?? 0);
  const note = String(tx.note ?? tx.memo ?? tx.remark ?? "").trim();

  if (symbol !== currency && price > 0) {
    pushLatestPrice(latestPriceMap, symbol, price, date);
  }

  return {
    id: createTransactionId("ai", [portfolioId, txIndex, symbol, type, date.toISOString(), shares, price, fee]),
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

export function normalizeAiPayloadToEntities(payload: unknown): EntityDataset[] {
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
      const currency = normalizeCurrency(portfolio.currency ?? portfolio.currencyType, "USD");
      const latestPriceMap: Record<string, { price: number; date: number }> = {};
      const txRows = Array.isArray(portfolio.transactions) ? portfolio.transactions : [];

      const mappedTransactions = txRows
        .map((txRaw, txIndex) => normalizeAiTransaction(txRaw, currency, id, txIndex, latestPriceMap))
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

function buildStockerProExportObject(entities: EntityDataset[]): UnknownRecord {
  const portfolioIdByEntityId = new Map<string, number>();
  const portfolios = entities.map((entity, index) => {
    const numericId = index + 1;
    portfolioIdByEntityId.set(entity.id, numericId);
    return {
      id: numericId,
      name: entity.name,
      displayCurrencyType: normalizeCurrency(entity.currency, "USD"),
    };
  });

  let transactionId = 1;
  const assetTransactions: UnknownRecord[] = [];
  entities.forEach((entity) => {
    const portfolioId = portfolioIdByEntityId.get(entity.id) ?? 1;
    const sorted = sortByDateAsc(entity.transactions);

    sorted.forEach((tx) => {
      const date = tx.date;
      const time =
        date.getHours() * 3_600_000 +
        date.getMinutes() * 60_000 +
        date.getSeconds() * 1_000 +
        date.getMilliseconds();
      const type: TxType = SUPPORTED_TX_TYPES.has(tx.type) ? tx.type : "CASH";
      const currency = normalizeCurrency(tx.currency, normalizeCurrency(entity.currency, "USD"));
      const symbol = normalizeSymbol(tx.symbol) || currency;
      const isCashType = type === "CASH" || type === "CASH_CONVERT" || type === "INTEREST";

      assetTransactions.push({
        id: transactionId,
        currencyType: currency,
        assetType: isCashType ? "CASH" : "STOCK",
        symbol,
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        time,
        type,
        _numberOfShares: encodeStored(tx.shares),
        _price: encodeStored(tx.price),
        _fee: encodeStored(tx.fee),
        tags: null,
        note: tx.note ?? "",
        positionId: null,
        portfolioId,
        region: "OTHERS",
        isAutoDividend: null,
        exDividendDate: null,
      });

      transactionId += 1;
    });
  });

  let marketPriceId = 1;
  const manualMarketPrice: UnknownRecord[] = [];
  entities.forEach((entity) => {
    const portfolioId = portfolioIdByEntityId.get(entity.id) ?? 1;
    Object.entries(entity.latestPriceBySymbol).forEach(([symbol, price]) => {
      if (!symbol || !Number.isFinite(price) || price <= 0) {
        return;
      }
      manualMarketPrice.push({
        id: marketPriceId,
        portfolioId,
        symbol,
        _price: encodeStored(price),
      });
      marketPriceId += 1;
    });
  });

  return {
    portfolios,
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
      const currency = normalizeCurrency(tx.currency, normalizeCurrency(entity.currency, "USD"));
      const symbol = normalizeSymbol(tx.symbol) || currency;
      const isoDate = tx.date.toISOString();

      if (tx.type === "BUY" || tx.type === "SELL" || tx.type === "DIVIDEND_SHARE") {
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

export function buildDualFormatRecords(entities: EntityDataset[]): DualFormatRecords {
  return {
    stockerProJson: JSON.stringify(buildStockerProExportObject(entities), null, 2),
    stockerXJson: JSON.stringify(buildStockerXExportObject(entities), null, 2),
  };
}

export async function parseInputByType(raw: string, type: UserType): Promise<EntityDataset[]> {
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
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid StockerX format.");
    }
    return parsed.map((item, index) => normalizeStockerXObject(item as UnknownRecord, index));
  }

  const decoded = await decodeRawPayload(raw, ["deflate", "gzip"]);
  const parsed = JSON.parse(decoded) as UnknownRecord;
  return normalizeStockerProObject(parsed);
}
