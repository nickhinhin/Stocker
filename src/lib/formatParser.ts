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
