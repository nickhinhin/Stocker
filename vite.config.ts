import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MONTHLY_AI_UPLOAD_LIMIT = 20;
const OPENAI_MAX_INPUT_CHARS = 120_000;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "https://stockerwebpro.nanistudio.org",
];

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function shouldAllowPrivateTestingOrigins(): boolean {
  const explicit = parseBooleanEnv(process.env.LOCAL_FUNCTION_ALLOW_PRIVATE_ORIGINS);
  if (explicit !== null) {
    return explicit;
  }
  return process.env.NODE_ENV !== "production";
}

function parseAllowedOrigins() {
  const raw = process.env.LOCAL_FUNCTION_ALLOWED_ORIGINS;
  if (!raw || !raw.trim()) {
    return new Set(DEFAULT_ALLOWED_ORIGINS);
  }

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isPrivateIpv4Hostname(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return false;
}

function isLocalTestingOrigin(origin: string): boolean {
  if (!origin) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return true;
    }
    return isPrivateIpv4Hostname(hostname);
  } catch {
    return false;
  }
}

function isAllowedOrigin(
  origin: string,
  allowedOrigins: Set<string>,
  allowPrivateTestingOrigins: boolean,
): boolean {
  return allowedOrigins.has(origin) || (allowPrivateTestingOrigins && isLocalTestingOrigin(origin));
}

function resolveRequestOrigin(request: any): string {
  const originHeader = String(request.headers.origin ?? "").trim();
  if (originHeader) {
    return originHeader;
  }

  const refererHeader = String(request.headers.referer ?? "").trim();
  if (!refererHeader) {
    return "";
  }

  try {
    return new URL(refererHeader).origin;
  } catch {
    return "";
  }
}

function applyCorsHeaders(response: any, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Stocker-App, X-Stocker-Client");
}

function sendJson(response: any, statusCode: number, payload: unknown, origin?: string): void {
  response.statusCode = statusCode;
  if (origin) {
    applyCorsHeaders(response, origin);
  }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function readRequestJson(request: any): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk: any) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("Payload too large."));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        resolve(parsed);
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    request.on("error", reject);
  });
}

async function fetchJson(url: string, init?: any): Promise<any> {
  const response = await fetch(url, init);
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Upstream request failed (${response.status}): ${responseText.slice(0, 200)}`);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

async function fetchYahooData(payload: Record<string, unknown>): Promise<any> {
  const type = String(payload.type ?? "");
  const symbol = String(payload.symbol ?? "").trim();
  const range = String(payload.range ?? "").trim();
  const interval = String(payload.interval ?? "").trim();

  if (!["lookup", "search", "query", "chart"].includes(type)) {
    throw new Error("Accepted type values: lookup, search, query, chart.");
  }

  if (["lookup", "search", "query"].includes(type) && !symbol) {
    throw new Error(`The function for ${type} requires a \"symbol\".`);
  }

  if (type === "chart" && (!symbol || !range || !interval)) {
    throw new Error("The function for chart requires symbol, range, and interval.");
  }

  const encodedSymbol = encodeURIComponent(symbol);
  const requestUrlByType: Record<string, string> = {
    lookup: `https://query2.finance.yahoo.com/v1/finance/lookup?type=all&formatted=true&count=3000&query=${symbol}`,
    search: `https://query2.finance.yahoo.com/v1/finance/search?quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=true&q=${symbol}`,
    query: `https://query2.finance.yahoo.com/v7/finance/quote?lang=zh-Hant-HK&formatted=true&region=TW&symbols=${encodedSymbol}`,
    chart: `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`,
  };

  if (type === "chart") {
    const symbols = symbol
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (symbols.length > 1) {
      const entries = await Promise.all(
        symbols.map(async (item) => {
          const chartUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${item}?range=${range}&interval=${interval}`;
          const chartData = await fetchJson(chartUrl);
          return [item.toUpperCase(), chartData] as const;
        }),
      );

      return {
        chartBatch: Object.fromEntries(entries),
      };
    }
  }

  if (type !== "query") {
    return fetchJson(requestUrlByType[type]);
  }

  const authCookieResponse = await fetch("https://cms.analytics.yahoo.com/cms?partner_id=NEUAR&orig=ono");
  const setCookie = authCookieResponse.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  if (!cookie) {
    throw new Error("Unable to create Yahoo session.");
  }

  const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    },
  });

  if (!crumbResponse.ok) {
    throw new Error(`Unable to fetch Yahoo crumb (${crumbResponse.status}).`);
  }

  const crumb = await crumbResponse.text();
  return fetchJson(`${requestUrlByType.query}&crumb=${encodeURIComponent(crumb)}`, {
    headers: {
      Cookie: cookie,
    },
  });
}

async function fetchCryptoData(payload: Record<string, unknown>): Promise<any> {
  const type = String(payload.type ?? "");
  const symbol = String(payload.symbol ?? "").trim();
  const range = String(payload.range ?? "").trim();
  const interval = String(payload.interval ?? "").trim();

  const requestUrlByType: Record<string, string> = {
    market: "https://data.gateapi.io/api2/1/pairs",
    list: "https://data.gateapi.io/api2/1/tickers",
    chart: `https://data.gateapi.io/api2/1/candlestick2/${symbol}?group_sec=${interval}&range_hour=${range}`,
    binance: "https://api1.binance.com/api/v3/ticker/24hr",
  };

  if (!Object.keys(requestUrlByType).includes(type)) {
    throw new Error("Accepted type values: market, list, chart, binance.");
  }

  if (type === "chart" && (!symbol || !range || !interval)) {
    throw new Error("The function for chart requires symbol, range, and interval.");
  }

  return fetchJson(requestUrlByType[type]);
}

function currentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseJsonObjectFromText(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("AI response is empty.");
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("AI response must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`AI response is not valid JSON: ${(error as Error).message}`);
  }
}

async function normalizePortfolioWithOpenAi(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apiKey = String(process.env.STOCKER_AI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Server missing STOCKER_AI_API_KEY. Add it to .env.local and restart.");
  }

  const fileName = String(payload.fileName ?? "upload.txt").slice(0, 160);
  const hintType = String(payload.hintType ?? "unknown").trim().toLowerCase();
  const userInstruction = String(payload.userInstruction ?? "").trim().slice(0, 4_000);
  const currentNormalized = String(payload.currentNormalized ?? "").trim().slice(0, OPENAI_MAX_INPUT_CHARS);
  const rawInput = String(payload.rawText ?? "");
  const content = rawInput.slice(0, OPENAI_MAX_INPUT_CHARS);

  if (!content.trim()) {
    throw new Error("rawText is required for normalization.");
  }

  const model = String(process.env.STOCKER_AI_MODEL ?? "gpt-5.4-mini").trim();
  const systemPrompt = [
    "You normalize portfolio files into strict JSON.",
    "Return only JSON object with this shape:",
    "{",
    '  "portfolios": [',
    "    {",
    '      "id": "string",',
    '      "name": "string",',
    '      "currency": "USD",',
    '      "transactions": [',
    "        {",
    '          "date": "ISO date/time or YYYY-MM-DD",',
    '          "symbol": "string",',
    '          "type": "BUY|SELL|DIVIDEND_CASH|DIVIDEND_SHARE|FEE|INTEREST|CASH|CASH_CONVERT",',
    '          "shares": 0,',
    '          "price": 0,',
    '          "fee": 0,',
    '          "currency": "USD",',
    '          "note": "string"',
    "        }",
    "      ]",
    "    }",
    "  ],",
    '  "warnings": ["string"]',
    "}",
    "Use best-effort extraction from any format (JSON, CSV, RTF, text, PDF, spreadsheet, image metadata).",
    "RawContent may contain a binary wrapper with base64Sample; infer structure from it when possible.",
    "Do not include markdown fences or commentary.",
    "If uncertain, still return closest normalized structure and add warning messages.",
  ].join("\n");

  const userPromptParts = [
    `FileName: ${fileName}`,
    `PreferredHint: ${hintType || "unknown"}`,
    "RawContent:",
    content,
  ];

  if (userInstruction) {
    userPromptParts.push("UserAdjustmentInstruction:");
    userPromptParts.push(userInstruction);
  }

  if (currentNormalized) {
    userPromptParts.push("CurrentNormalizedDraftJSON:");
    userPromptParts.push(currentNormalized);
  }

  const userPrompt = userPromptParts.join("\n\n");

  const completion = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const contentText = completion?.choices?.[0]?.message?.content;
  if (typeof contentText !== "string") {
    throw new Error("AI response missing message content.");
  }

  return parseJsonObjectFromText(contentText);
}

function localFunctionPlugin() {
  const allowedOrigins = parseAllowedOrigins();
  const allowPrivateTestingOrigins = shouldAllowPrivateTestingOrigins();
  const lastCallAtByOrigin = new Map<string, number>();
  const recentResponseCacheByKey = new Map<string, { cachedAt: number; data: unknown }>();
  const inFlightRequestByKey = new Map<string, Promise<unknown>>();
  const monthlyUploadUsageByClient = new Map<string, { month: string; used: number }>();

  const consumeMonthlyAiUploadQuota = (
    usageKey: string,
  ): { month: string; used: number; remaining: number; limit: number } => {
    const month = currentMonthKey();
    const existing = monthlyUploadUsageByClient.get(usageKey);
    const resetUsage = !existing || existing.month !== month;
    const currentUsed = resetUsage ? 0 : existing.used;

    if (currentUsed >= MONTHLY_AI_UPLOAD_LIMIT) {
      throw new Error(`Monthly AI upload limit reached (${MONTHLY_AI_UPLOAD_LIMIT}).`);
    }

    const nextUsed = currentUsed + 1;
    monthlyUploadUsageByClient.set(usageKey, { month, used: nextUsed });
    return {
      month,
      used: nextUsed,
      remaining: Math.max(0, MONTHLY_AI_UPLOAD_LIMIT - nextUsed),
      limit: MONTHLY_AI_UPLOAD_LIMIT,
    };
  };

  const normalizeThrottleScope = (
    requestPath: string,
    requestType: string,
    body: Record<string, unknown>,
  ): string => {
    if (requestPath === "/api/local-functions/normalize-portfolio") {
      return "normalize";
    }

    // Throttle by endpoint + request shape, so stock detail chart requests do not block
    // portfolio chart requests and vice versa.
    return JSON.stringify({
      endpoint: requestPath,
      type: requestType,
      symbol: String(body.symbol ?? "").trim().toUpperCase(),
      range: String(body.range ?? "").trim(),
      interval: String(body.interval ?? "").trim(),
    });
  };

  const handleLocalFunctionRequest = async (request: any, response: any, next: any) => {
    const requestPath = String(request.url ?? "").split("?")[0];
    const isFunctionPath =
      requestPath === "/api/local-functions/fetch-stock-data" ||
      requestPath === "/api/local-functions/fetch-crypto-data" ||
      requestPath === "/api/local-functions/normalize-portfolio";

    if (!isFunctionPath) {
      next();
      return;
    }

    const origin = resolveRequestOrigin(request);
    const originAllowed = isAllowedOrigin(origin, allowedOrigins, allowPrivateTestingOrigins);

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        response.statusCode = 403;
        response.end();
        return;
      }
      response.statusCode = 204;
      applyCorsHeaders(response, origin);
      response.end();
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, {error: "Method not allowed."}, originAllowed ? origin : undefined);
      return;
    }

    if (!originAllowed) {
      sendJson(response, 403, {error: "This API is restricted to allowed Stocker origins."});
      return;
    }

    const appHeader = String(request.headers["x-stocker-app"] ?? "").trim();
    if (appHeader !== "stocker-web") {
      sendJson(response, 403, {error: "Missing or invalid app identity header."}, origin);
      return;
    }

    const clientHeader = String(request.headers["x-stocker-client"] ?? "").trim();
    if (!clientHeader || clientHeader.length < 8 || clientHeader.length > 200) {
      sendJson(response, 403, {error: "Missing or invalid client identity header."}, origin);
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readRequestJson(request);
    } catch (error) {
      sendJson(response, 400, {error: (error as Error).message}, origin);
      return;
    }

    const requestType =
      requestPath === "/api/local-functions/normalize-portfolio"
        ? "normalize"
        : String(body.type ?? "unknown").trim().toLowerCase();
    const throttleScope = normalizeThrottleScope(requestPath, requestType, body);
    const now = Date.now();
    const rateLimitKey = `${origin || "unknown-origin"}:${requestPath}:${throttleScope}`;
    const lastCallAt = lastCallAtByOrigin.get(rateLimitKey) ?? 0;

    // For stock/crypto quote endpoints, reuse fresh response instead of returning 429.
    // This avoids noisy rate-limit errors in the UI while still protecting upstream usage.
    const isNormalizeRequest = requestPath === "/api/local-functions/normalize-portfolio";
    if (!isNormalizeRequest) {
      const cached = recentResponseCacheByKey.get(rateLimitKey);
      if (cached && now - cached.cachedAt < RATE_LIMIT_WINDOW_MS) {
        sendJson(response, 200, {data: cached.data, cached: true}, origin);
        return;
      }

      const inFlight = inFlightRequestByKey.get(rateLimitKey);
      if (inFlight) {
        try {
          const inFlightData = await inFlight;
          sendJson(response, 200, {data: inFlightData, cached: true}, origin);
        } catch (error) {
          sendJson(response, 500, {error: (error as Error).message}, origin);
        }
        return;
      }
    } else if (now - lastCallAt < RATE_LIMIT_WINDOW_MS) {
      const retryAfterSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - lastCallAt)) / 1000);
      sendJson(
        response,
        429,
        {error: `Too many requests. Retry after ${retryAfterSeconds} seconds.`},
        origin,
      );
      return;
    }
    lastCallAtByOrigin.set(rateLimitKey, now);

    try {
      if (requestPath === "/api/local-functions/normalize-portfolio") {
        if (!String(process.env.STOCKER_AI_API_KEY ?? "").trim()) {
          sendJson(
            response,
            500,
            {error: "Server missing STOCKER_AI_API_KEY. Add it to .env.local and restart."},
            origin,
          );
          return;
        }

        let quota;
        try {
          quota = consumeMonthlyAiUploadQuota(`${origin}:${clientHeader}`);
        } catch (error) {
          sendJson(response, 429, {error: (error as Error).message}, origin);
          return;
        }

        const normalized = await normalizePortfolioWithOpenAi(body);
        sendJson(response, 200, {data: {normalized, quota}}, origin);
        return;
      }

      const upstreamPromise = (requestPath === "/api/local-functions/fetch-stock-data"
        ? fetchYahooData(body)
        : fetchCryptoData(body)) as Promise<unknown>;
      inFlightRequestByKey.set(rateLimitKey, upstreamPromise);

      const data = await upstreamPromise;
      recentResponseCacheByKey.set(rateLimitKey, {
        cachedAt: Date.now(),
        data,
      });
      sendJson(response, 200, {data}, origin);
    } catch (error) {
      sendJson(response, 500, {error: (error as Error).message}, origin);
    } finally {
      inFlightRequestByKey.delete(rateLimitKey);
    }
  };

  return {
    name: "local-protected-function-api",
    configureServer(server: any) {
      server.middlewares.use(handleLocalFunctionRequest);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(handleLocalFunctionRequest);
    },
  };
}

export default defineConfig({
  plugins: [react(), localFunctionPlugin()],
});
