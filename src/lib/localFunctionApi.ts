export type LocalStockRequestType = "lookup" | "search" | "query" | "chart";
export type LocalCryptoRequestType = "market" | "list" | "chart" | "binance";
export type PortfolioNormalizeHintType = "stockerx" | "stockerpro" | "unknown";

export interface LocalStockRequest {
  type: LocalStockRequestType;
  symbol: string;
  range?: string;
  interval?: string;
}

export interface LocalCryptoRequest {
  type: LocalCryptoRequestType;
  symbol?: string;
  range?: string;
  interval?: string;
}

export interface PortfolioNormalizeRequest {
  rawText: string;
  fileName?: string;
  hintType?: PortfolioNormalizeHintType;
  userInstruction?: string;
  currentNormalized?: string;
}

interface LocalFunctionError {
  error?: string;
}

const CLIENT_ID_STORAGE_KEY = "stocker-web-client-id-v1";

function generateClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function getClientId(): string {
  if (typeof window === "undefined") {
    return "server-render";
  }

  const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (existing && existing.trim()) {
    return existing;
  }

  const created = generateClientId();
  window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
  return created;
}

async function postLocalFunction<TResponse>(
  endpoint: string,
  payload: unknown,
): Promise<TResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Stocker-App": "stocker-web",
      "X-Stocker-Client": getClientId(),
    },
    body: JSON.stringify(payload),
  });

  const json = (await response.json().catch(() => ({}))) as {data?: TResponse} & LocalFunctionError;

  if (!response.ok) {
    throw new Error(json.error ?? `Request failed with status ${response.status}`);
  }

  return json.data as TResponse;
}

export async function fetchLocalStockData<TResponse = unknown>(
  payload: LocalStockRequest,
): Promise<TResponse> {
  return postLocalFunction<TResponse>("/api/local-functions/fetch-stock-data", payload);
}

export async function fetchLocalCryptoData<TResponse = unknown>(
  payload: LocalCryptoRequest,
): Promise<TResponse> {
  return postLocalFunction<TResponse>("/api/local-functions/fetch-crypto-data", payload);
}

export async function normalizePortfolioWithAi<TResponse = unknown>(
  payload: PortfolioNormalizeRequest,
): Promise<TResponse> {
  return postLocalFunction<TResponse>("/api/local-functions/normalize-portfolio", payload);
}
