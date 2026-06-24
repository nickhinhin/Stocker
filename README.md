# Stocker Dashboard

A single-page portfolio analytics web app built with React + Vite + TypeScript.
Upload your transactions (or build them in-app), and Stocker turns them into
interactive charts: holdings, asset allocation, currency exposure, dividends,
monthly cash flow, drawdown, rebalance suggestions, and more. Data syncs to
your own private Firebase collection via Google sign-in.

Live domains for the deployed project:

- Production: <https://stockerwebpro.nanistudio.org>
- Firebase Hosting default: <https://stocking-eafe1.firebaseapp.com>

---

## Features

- **Multi-portfolio dashboard** with summary cards, profit series, drawdown,
  transaction heatmap, and per-stock breakdowns.
- **Analysis views** — asset allocation, currency exposure, dividend calendar,
  monthly buy/sell/profit/dividend/fee/cash-flow series, rebalance suggestions.
- **Stock & crypto data** — quotes and candlestick charts pulled from Yahoo
  Finance and Gate.io / Binance through a protected local function proxy.
- **AI portfolio normalization** — paste/drag a CSV, JSON, RTF, or text export
  and OpenAI turns it into the normalized transaction schema.
- **Auth & cloud sync** — Google sign-in backed by Firebase Auth; portfolios
  stored compressed (pako/gzip) in Firestore under a per-user collection.
- **English / 繁體中文 (zh-HK)** UI with locale persistence.
- **Local dev proxy** — the same protected API the Cloud Function exposes is
  mirrored as a Vite middleware plugin so you can run everything on
  `localhost` without deploying.

---

## Tech stack

| Layer            | Choice                                   |
| ---------------- | ---------------------------------------- |
| Framework        | React 18 + TypeScript                    |
| Build tool       | Vite 5                                   |
| Charts           | Custom SVG components (`src/components`) |
| Backend (dev)    | Vite middleware plugin (`vite.config.ts`)|
| Backend (prod)   | Firebase Cloud Functions (`functions/`)  |
| Auth + DB        | Firebase Auth + Cloud Firestore          |
| Compression      | pako (gzip) for stored payloads          |
| AI               | OpenAI Chat Completions (optional)       |

---

## Prerequisites

- **Node.js 18+** (developed against Node 20/24)
- **npm 9+** (ships with recent Node)

---

## Getting started (local development)

```bash
# 1. Install dependencies
npm install
npm --prefix functions install      # only needed if you will deploy

# 2. (Optional) configure environment
#    .env.local is gitignored and has sensible defaults — see below.

# 3. Start the dev server
npm run dev
```

The app is then available at **<http://localhost:5173/>**.

> The same protected endpoints that run as a Firebase Cloud Function in
> production are mirrored in dev by a Vite plugin defined in
> `vite.config.ts` (`localFunctionPlugin`). No separate backend process is
> required.

---

## Available scripts

| Script           | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `npm run dev`    | Start the Vite dev server with HMR (port 5173)         |
| `npm run build`  | Type-check (`tsc`) then build the app into `dist/`     |
| `npm run preview`| Serve the production build locally for verification    |

---

## Environment variables

All variables are **optional** for local development. The repo ships with
sensible built-in fallbacks (the shared production Firebase project and a
permissive local CORS policy). Copy the template into `.env.local` and edit
as needed — Vite loads `.env.local` automatically and the dev middleware
reads values from `process.env`.

```ini
# .env.local  (gitignored)

# --- OpenAI (optional) ------------------------------------------------------
# Enables the AI portfolio-normalization upload feature.
STOCKER_AI_API_KEY=
# Optional: override the OpenAI model (defaults to gpt-5.4-mini)
# STOCKER_AI_MODEL=gpt-5.4-mini

# --- CORS for the local dev server (optional) -------------------------------
# Defaults already allow http://localhost:5173 and http://127.0.0.1:5173.
# LOCAL_FUNCTION_ALLOW_PRIVATE_ORIGINS=true
# LOCAL_FUNCTION_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173

# --- Firebase (optional) ----------------------------------------------------
# All values below fall back to the shared production project. Override only
# if you want to point at your own Firebase project.
# VITE_FIREBASE_API_KEY=
# VITE_FIREBASE_AUTH_DOMAIN=
# VITE_FIREBASE_PROJECT_ID=
# VITE_FIREBASE_STORAGE_BUCKET=
# VITE_FIREBASE_MESSAGING_SENDER_ID=
# VITE_FIREBASE_APP_ID=
# VITE_FIREBASE_MEASUREMENT_ID=
# VITE_FIREBASE_COLLECTION_PREFIX=prod-
```

| Variable                                | Used by         | Purpose                                                            |
| --------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `STOCKER_AI_API_KEY`                    | Dev + Functions | Required for the AI normalize-portfolio feature                    |
| `STOCKER_AI_MODEL`                      | Dev + Functions | Override the OpenAI model                                          |
| `LOCAL_FUNCTION_ALLOW_PRIVATE_ORIGINS`  | Dev + Functions | Allow any RFC1918/LAN origin in addition to the allow-list         |
| `LOCAL_FUNCTION_ALLOWED_ORIGINS`        | Dev + Functions | Comma-separated allow-list of CORS origins                         |
| `VITE_FIREBASE_*`                       | Client          | Override Firebase project config (defaults to `stocking-eafe1`)    |
| `VITE_FIREBASE_COLLECTION_PREFIX`       | Client          | Firestore collection prefix (default `prod-`)                      |

---

## Project structure

```
Stocker/
├─ index.html                # HTML entry, mounts #root
├─ vite.config.ts            # Vite config + local function middleware plugin
├─ tsconfig.json             # App TS config (src only, noEmit)
├─ tsconfig.node.json        # TS config for build-time node files
├─ firebase.json             # Hosting + Cloud Functions config
├─ .firebaserc               # Default Firebase project: stocking-eafe1
├─ functions/                # Firebase Cloud Functions (deploy target only)
│  ├─ index.js               # fetchStockDataHttp HTTPS function
│  └─ package.json           # Node 20, firebase-functions
└─ src/
   ├─ main.tsx               # React entry
   ├─ App.tsx                # Whole app shell, screens, routing, state
   ├─ styles.css             # Global styles
   ├─ types.ts               # Shared domain types (TxType, EntityDataset...)
   ├─ lib/
   │  ├─ firebaseClient.ts   # Firebase init (app/auth/firestore) + config
   │  ├─ localFunctionApi.ts # Client wrappers for /api/local-functions/*
   │  ├─ calculations.ts     # Portfolio metrics & series generators
   │  ├─ formatParser.ts     # Normalize AI / file payloads into entities
   │  └─ testPortfolio.ts    # Sample portfolio for quick testing
   └─ components/            # SVG chart components (Pie, Bar, Area, ...)
```

---

## Local API surface

The app talks to three POST endpoints that are mounted under
`/api/local-functions/*`. In dev these are served by the Vite middleware
plugin; in production `firebase.json` rewrites `fetch-stock-data` to the
Cloud Function and the others run there too.

| Endpoint                                       | Purpose                                   |
| ---------------------------------------------- | ----------------------------------------- |
| `/api/local-functions/fetch-stock-data`        | Yahoo Finance lookup / search / query / chart |
| `/api/local-functions/fetch-crypto-data`       | Gate.io / Binance market / list / chart   |
| `/api/local-functions/normalize-portfolio`     | AI normalization of uploaded portfolio text |

All three require:

- An `Origin`/`Referer` that matches the CORS allow-list (localhost is allowed).
- Header `X-Stocker-App: stocker-web`.
- Header `X-Stocker-Client: <client-id>` (8–200 chars; the client generates
  and persists a UUID in `localStorage`).

Requests are throttled per origin + endpoint + payload shape (60s window).
For the stock/crypto endpoints, fresh responses within the window are served
from a short-lived cache instead of returning 429.

---

## Deployment (Firebase Hosting + Functions)

This repo is configured to deploy to the Firebase project `stocking-eafe1`
(see `.firebaserc`). Production deploy requires the Firebase CLI:

```bash
npm install -g firebase-tools
firebase login

# Build the client
npm run build

# Deploy everything (hosting + functions)
firebase deploy

# Or deploy pieces individually
firebase deploy --only hosting
firebase deploy --only functions
```

For the AI normalize feature to work in production, set the secret on the
Cloud Function:

```bash
firebase functions:secrets:set STOCKER_AI_API_KEY
# (optional)
firebase functions:secrets:set STOCKER_AI_MODEL
```

---

## Notes & troubleshooting

- **Node version warning** — `functions/package.json` declares
  `"engines": { "node": "20" }`. Running `npm install` there on Node 22/24
  prints an `EBADENGINE` warning; this is harmless for local dev because the
  functions only run when deployed.
- **CORS 403** — if you serve the app from a port other than 5173, add it to
  `LOCAL_FUNCTION_ALLOWED_ORIGINS` or set `LOCAL_FUNCTION_ALLOW_PRIVATE_ORIGINS=true`.
- **AI normalize returns 500** — `STOCKER_AI_API_KEY` is missing or invalid.
  Stock/crypto features are unaffected.
- **Firestore permission errors** — the app expects the deployed Firestore
  security rules to scope each user's collection to their UID. Pointing the
  client at your own Firebase project requires deploying matching rules.

---

## License

Private project. All rights reserved.
