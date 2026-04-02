import { EntityDataset, NormalizedTransaction, TxType } from "../types";

interface RawTx {
  date: string;
  symbol: string;
  type: TxType;
  shares: number;
  price: number;
  fee: number;
  currency: string;
  note?: string;
}

function buildTransaction(portfolioId: string, index: number, raw: RawTx): NormalizedTransaction {
  return {
    id: `${portfolioId}-tx-${index + 1}`,
    date: new Date(raw.date),
    symbol: raw.symbol,
    type: raw.type,
    shares: raw.shares,
    price: raw.price,
    fee: raw.fee,
    currency: raw.currency,
    note: raw.note,
  };
}

function buildPriceMap(transactions: NormalizedTransaction[]): Record<string, number> {
  const latest = new Map<string, { timestamp: number; price: number }>();

  transactions.forEach((tx) => {
    if (!tx.symbol || tx.symbol === tx.currency || tx.price <= 0) {
      return;
    }
    const timestamp = tx.date.getTime();
    const previous = latest.get(tx.symbol);
    if (!previous || timestamp >= previous.timestamp) {
      latest.set(tx.symbol, { timestamp, price: tx.price });
    }
  });

  const output: Record<string, number> = {};
  latest.forEach((value, key) => {
    output[key] = value.price;
  });
  return output;
}

function buildPortfolio(id: string, name: string, currency: string, rows: RawTx[]): EntityDataset {
  const transactions = rows
    .map((row, index) => buildTransaction(id, index, row))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    id,
    name,
    currency,
    transactions,
    latestPriceBySymbol: buildPriceMap(transactions),
  };
}

export function generateStressTestPortfolios(seed: number): EntityDataset[] {
  const runTag = `${seed}`;

  const globalRows: RawTx[] = [
    { date: "2019-01-03", symbol: "USD", type: "CASH", shares: 22000, price: 1, fee: 0, currency: "USD", note: "Initial funding" },
    { date: "2019-02-14", symbol: "AAPL", type: "BUY", shares: 25, price: 43.2, fee: 1.5, currency: "USD" },
    { date: "2019-06-10", symbol: "AAPL", type: "BUY", shares: 20, price: 49.4, fee: 1.2, currency: "USD" },
    { date: "2020-04-03", symbol: "MSFT", type: "BUY", shares: 18, price: 154.8, fee: 1.7, currency: "USD" },
    { date: "2020-08-19", symbol: "AAPL", type: "SELL", shares: 15, price: 117.5, fee: 1.3, currency: "USD" },
    { date: "2021-02-17", symbol: "AAPL", type: "DIVIDEND_CASH", shares: 30, price: 0.205, fee: 0, currency: "USD" },
    { date: "2021-09-21", symbol: "USD", type: "INTEREST", shares: 1, price: 24.6, fee: 0, currency: "USD" },
    { date: "2022-03-11", symbol: "TSLA", type: "BUY", shares: 8, price: 279.9, fee: 2.1, currency: "USD" },
    { date: "2022-05-30", symbol: "TSLA", type: "FEE", shares: 1, price: 5.2, fee: 0, currency: "USD", note: "Borrow/overnight fee" },
    { date: "2022-12-02", symbol: "TSLA", type: "SELL", shares: 3, price: 194.4, fee: 1.8, currency: "USD" },
    { date: "2023-04-06", symbol: "QQQ", type: "BUY", shares: 10, price: 317.8, fee: 1.6, currency: "USD" },
    { date: "2023-09-29", symbol: "USDHKD=X", type: "CASH_CONVERT", shares: -10000, price: 1, fee: 0, currency: "USD", note: "FX leg (USD out)" },
    { date: "2023-09-29", symbol: "HKD", type: "CASH_CONVERT", shares: 78000, price: 1, fee: 18, currency: "HKD", note: "FX leg (HKD in)" },
    { date: "2024-01-10", symbol: "NVDA", type: "BUY", shares: 6, price: 518.2, fee: 1.9, currency: "USD" },
    { date: "2024-07-12", symbol: "NVDA", type: "SELL", shares: 2, price: 128.4, fee: 1.5, currency: "USD", note: "Post-split trim" },
    { date: "2025-01-09", symbol: "QQQ", type: "DIVIDEND_CASH", shares: 10, price: 0.63, fee: 0, currency: "USD" },
    { date: "2025-06-18", symbol: "AAPL", type: "DIVIDEND_SHARE", shares: 0.28, price: 0, fee: 0, currency: "USD", note: "DRIP sample" },
    { date: "2026-02-20", symbol: "MSFT", type: "SELL", shares: 5, price: 418.1, fee: 1.8, currency: "USD" },
  ];

  const asiaRows: RawTx[] = [
    { date: "2020-01-06", symbol: "HKD", type: "CASH", shares: 120000, price: 1, fee: 0, currency: "HKD" },
    { date: "2020-02-20", symbol: "0700.HK", type: "BUY", shares: 40, price: 399.2, fee: 20, currency: "HKD" },
    { date: "2021-03-08", symbol: "2800.HK", type: "BUY", shares: 150, price: 28.6, fee: 16, currency: "HKD" },
    { date: "2021-10-05", symbol: "0700.HK", type: "SELL", shares: 10, price: 465.8, fee: 18, currency: "HKD" },
    { date: "2022-07-29", symbol: "700.HK", type: "DIVIDEND_CASH", shares: 30, price: 1.6, fee: 0, currency: "HKD" },
    { date: "2023-02-15", symbol: "JPY", type: "CASH", shares: 520000, price: 1, fee: 0, currency: "JPY" },
    { date: "2023-03-13", symbol: "7203.T", type: "BUY", shares: 120, price: 2145, fee: 380, currency: "JPY" },
    { date: "2024-04-24", symbol: "7203.T", type: "SELL", shares: 50, price: 3020, fee: 350, currency: "JPY" },
    { date: "2024-11-08", symbol: "JPY", type: "INTEREST", shares: 1, price: 1800, fee: 0, currency: "JPY" },
    { date: "2025-01-30", symbol: "HKD", type: "FEE", shares: 1, price: 40, fee: 0, currency: "HKD", note: "Custody fee" },
    { date: "2025-10-14", symbol: "2800.HK", type: "SELL", shares: 45, price: 31.1, fee: 14, currency: "HKD" },
  ];

  return [
    buildPortfolio(`stress-global-${runTag}`, `Stress Test Global ${runTag}`, "USD", globalRows),
    buildPortfolio(`stress-asia-${runTag}`, `Stress Test Asia ${runTag}`, "HKD", asiaRows),
  ];
}
