const { onRequest } = require("firebase-functions/v2/https");

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_ALLOWED_ORIGINS = new Set([
  "https://stocking-eafe1.web.app",
  "https://stocking-eafe1.firebaseapp.com",
  "https://stockerwebpro.nanistudio.org",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

const lastCallAtByKey = new Map();
const recentResponseCacheByKey = new Map();
const inFlightRequestByKey = new Map();

function parseBooleanEnv(value) {
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

function shouldAllowPrivateTestingOrigins() {
  const explicit = parseBooleanEnv(process.env.LOCAL_FUNCTION_ALLOW_PRIVATE_ORIGINS);
  if (explicit !== null) {
    return explicit;
  }
  return false;
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

function isPrivateIpv4Hostname(hostname) {
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

function isLocalTestingOrigin(origin) {
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

function isAllowedOrigin(origin, allowedOrigins, allowPrivateTestingOrigins) {
  return allowedOrigins.has(origin) || (allowPrivateTestingOrigins && isLocalTestingOrigin(origin));
}

function resolveRequestOrigin(request) {
  const originHeader = String(request.headers.origin || "").trim();
  if (originHeader) {
    return originHeader;
  }
  const refererHeader = String(request.headers.referer || "").trim();
  if (!refererHeader) {
    return "";
  }
  try {
    return new URL(refererHeader).origin;
  } catch {
    return "";
  }
}

function applyCorsHeaders(response, origin) {
  response.set("Access-Control-Allow-Origin", origin);
  response.set("Vary", "Origin");
  response.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type, X-Stocker-App, X-Stocker-Client");
}

function sendJson(response, statusCode, payload, origin) {
  response.status(statusCode);
  if (origin) {
    applyCorsHeaders(response, origin);
  }
  response.set("Content-Type", "application/json; charset=utf-8");
  response.send(payload);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Upstream request failed (${response.status}): ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchYahooData(payload) {
  const type = String(payload.type || "");
  const symbol = String(payload.symbol || "").trim();
  const range = String(payload.range || "").trim();
  const interval = String(payload.interval || "").trim();

  if (!["lookup", "search", "query", "chart"].includes(type)) {
    throw new Error("Accepted type values: lookup, search, query, chart.");
  }

  if (["lookup", "search", "query"].includes(type) && !symbol) {
    throw new Error(`The function for ${type} requires a "symbol".`);
  }

  if (type === "chart" && (!symbol || !range || !interval)) {
    throw new Error("The function for chart requires symbol, range, and interval.");
  }

  const encodedSymbol = encodeURIComponent(symbol);
  const requestUrlByType = {
    lookup: `https://query2.finance.yahoo.com/v1/finance/lookup?type=all&formatted=true&count=3000&query=${symbol}`,
    search: `https://query2.finance.yahoo.com/v1/finance/search?quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=true&q=${symbol}`,
    query: `https://query2.finance.yahoo.com/v7/finance/quote?lang=zh-Hant-HK&formatted=true&region=TW&symbols=${encodedSymbol}`,
    chart: `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`,
  };

  if (type === "chart") {
    const buildYahooSymbolCandidates = (rawSymbol) => {
      const normalized = String(rawSymbol || "").trim().toUpperCase();
      if (!normalized) {
        return [];
      }
      const candidates = [normalized];
      if (normalized.endsWith("-USDT")) {
        candidates.push(normalized.replace(/-USDT$/, "-USD"));
      }
      return [...new Set(candidates)];
    };

    const symbols = symbol
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (symbols.length > 1) {
      const settled = await Promise.allSettled(
        symbols.map(async (item) => {
          const requestedSymbol = item.toUpperCase();
          const symbolCandidates = buildYahooSymbolCandidates(item);
          let lastError = null;

          for (const candidateSymbol of symbolCandidates) {
            try {
              const chartUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${candidateSymbol}?range=${range}&interval=${interval}`;
              const chartData = await fetchJson(chartUrl);
              return [requestedSymbol, chartData];
            } catch (error) {
              lastError = error;
            }
          }

          throw lastError || new Error(`Unable to fetch chart for ${requestedSymbol}.`);
        }),
      );

      const successEntries = settled
        .filter((item) => item.status === "fulfilled")
        .map((item) => item.value);
      const failedSymbols = settled
        .map((item, index) => ({ item, symbol: symbols[index].toUpperCase() }))
        .filter(({ item }) => item.status === "rejected")
        .map(({ symbol }) => symbol);

      if (successEntries.length === 0) {
        throw new Error(
          `No chart data returned from Yahoo for requested symbols. Failed: ${failedSymbols.join(", ")}`,
        );
      }

      return {
        chartBatch: Object.fromEntries(successEntries),
        chartErrors: failedSymbols,
      };
    }

    if (symbols.length === 1) {
      const requestedSymbol = symbols[0].toUpperCase();
      const symbolCandidates = buildYahooSymbolCandidates(symbols[0]);
      let lastError = null;
      for (const candidateSymbol of symbolCandidates) {
        try {
          const chartUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${candidateSymbol}?range=${range}&interval=${interval}`;
          return await fetchJson(chartUrl);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error(`Unable to fetch chart for ${requestedSymbol}.`);
    }
  }

  if (type !== "query") {
    return fetchJson(requestUrlByType[type]);
  }

  const authCookieResponse = await fetch("https://cms.analytics.yahoo.com/cms?partner_id=NEUAR&orig=ono");
  const setCookie = authCookieResponse.headers.get("set-cookie") || "";
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
    headers: { Cookie: cookie },
  });
}

exports.fetchStockDataHttp = onRequest(
  {
    cors: false,
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (request, response) => {
    const allowedOrigins = parseAllowedOrigins();
    const allowPrivateTestingOrigins = shouldAllowPrivateTestingOrigins();
    const origin = resolveRequestOrigin(request);
    const originAllowed = isAllowedOrigin(origin, allowedOrigins, allowPrivateTestingOrigins);

    if (request.method === "OPTIONS") {
      if (!originAllowed) {
        response.status(403).end();
        return;
      }
      response.status(204);
      applyCorsHeaders(response, origin);
      response.end();
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." }, originAllowed ? origin : undefined);
      return;
    }

    if (!originAllowed) {
      sendJson(response, 403, { error: "This API is restricted to allowed Stocker origins." });
      return;
    }

    const appHeader = String(request.headers["x-stocker-app"] || "").trim();
    if (appHeader !== "stocker-web") {
      sendJson(response, 403, { error: "Missing or invalid app identity header." }, origin);
      return;
    }

    const clientHeader = String(request.headers["x-stocker-client"] || "").trim();
    if (!clientHeader || clientHeader.length < 8 || clientHeader.length > 200) {
      sendJson(response, 403, { error: "Missing or invalid client identity header." }, origin);
      return;
    }

    const body = request.body && typeof request.body === "object" ? request.body : {};
    const requestType = String(body.type || "unknown").trim().toLowerCase();
    const throttleScope = JSON.stringify({
      endpoint: "/api/local-functions/fetch-stock-data",
      type: requestType,
      symbol: String(body.symbol || "").trim().toUpperCase(),
      range: String(body.range || "").trim(),
      interval: String(body.interval || "").trim(),
    });
    const now = Date.now();
    const rateLimitKey = `${origin || "unknown-origin"}:${clientHeader}:${throttleScope}`;
    const lastCallAt = lastCallAtByKey.get(rateLimitKey) || 0;

    if (now - lastCallAt < RATE_LIMIT_WINDOW_MS) {
      const cached = recentResponseCacheByKey.get(rateLimitKey);
      if (cached && now - cached.cachedAt < RATE_LIMIT_WINDOW_MS) {
        sendJson(response, 200, { data: cached.data, cached: true }, origin);
        return;
      }

      const inFlight = inFlightRequestByKey.get(rateLimitKey);
      if (inFlight) {
        try {
          const inFlightData = await inFlight;
          sendJson(response, 200, { data: inFlightData, cached: true }, origin);
        } catch (error) {
          sendJson(response, 500, { error: error.message }, origin);
        }
        return;
      }

      const retryAfterSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - lastCallAt)) / 1000);
      sendJson(response, 429, { error: `Too many requests. Retry after ${retryAfterSeconds} seconds.` }, origin);
      return;
    }

    lastCallAtByKey.set(rateLimitKey, now);

    try {
      const upstreamPromise = fetchYahooData(body);
      inFlightRequestByKey.set(rateLimitKey, upstreamPromise);
      const data = await upstreamPromise;
      recentResponseCacheByKey.set(rateLimitKey, {
        cachedAt: Date.now(),
        data,
      });
      sendJson(response, 200, { data }, origin);
    } catch (error) {
      sendJson(response, 500, { error: error.message || String(error) }, origin);
    } finally {
      inFlightRequestByKey.delete(rateLimitKey);
    }
  },
);
