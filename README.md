# tape

AI-assisted stock + crypto trading terminal. Named for reading the tape — the scrolling quote strip is the first thing you see. Static frontend (GitHub Pages) + Cloudflare Worker backend holding your secrets, wired to **Alpaca** (one API for both US stocks and crypto, with identical paper and live endpoints) and the **Anthropic API** for the analyst/autopilot brain.

```
index.html   → the dashboard (host on GitHub Pages)
worker.js    → Cloudflare Worker (auth, Alpaca proxy, AI analysis, guardrails)
wrangler.toml→ Worker config (mode + trade caps)
```

## 1. Get accounts & keys

1. **Alpaca** — sign up at alpaca.markets. Every account gets a *paper trading* environment instantly with $100k fake money. Generate API keys from the dashboard (paper keys and live keys are separate — start with paper keys).
2. **Anthropic** *(optional)* — get an API key from console.anthropic.com if you want the AI Analyst + Autopilot. Skip it and tape runs as a clean manual trading terminal; the AI panel disables itself automatically.
3. Invent an **AUTH_KEY** — any long random string. This is the password your dashboard uses so nobody else can drive your worker.

## 2. Deploy the worker

```bash
npm i -g wrangler
wrangler login
cd neontrader
wrangler secret put ALPACA_KEY
wrangler secret put ALPACA_SECRET
wrangler secret put AUTH_KEY
wrangler secret put ANTHROPIC_API_KEY   # optional — only for AI features
wrangler deploy
```

The worker is named `trader` in `wrangler.toml`, so it deploys to `https://trader.detlaffcameron.workers.dev` — which the frontend is already pointed at.

## 3. Deploy the frontend

Push `index.html` to a GitHub Pages repo (or just open it locally — it's fully static). On first load the worker URL is pre-filled; you only enter your AUTH_KEY. Both are stored in localStorage.

## 4. Trade (paper first!)

- **Watchlist** — stocks as plain tickers (`NVDA`), crypto as pairs (`BTC/USD`).
- **Order ticket** — market/limit, sized in dollars or units.
- **AI Analyst** — pulls ~90 recent bars + snapshot + your position, sends it to Claude, gets back a strict-JSON verdict (buy/sell/hold, confidence, size, reasoning, risk). You click Execute.
- **Autopilot** — cycles through your watchlist on a timer and auto-executes when confidence ≥ your threshold. Only runs while the tab is open.

## 5. Going live (real money)

Only after you're happy with paper results:

1. Fund your Alpaca live account.
2. Generate **live** API keys and re-run `wrangler secret put ALPACA_KEY` / `ALPACA_SECRET` with them.
3. In `wrangler.toml`, set `MODE = "live"` and `wrangler deploy`.

The header badge turns red and pulses, every manual/AI order gets a confirm dialog, and autopilot demands an explicit confirmation when engaged.

## Guardrails (server-side, can't be bypassed by the UI)

| Var | Default | What it does |
|---|---|---|
| `MODE` | `paper` | Which Alpaca environment orders go to |
| `MAX_NOTIONAL` | `200` | Rejects any order above this many USD |
| `MAX_TRADES_PER_DAY` | `20` | Rejects orders past this count per UTC day (best-effort; resets if the worker isolate recycles) |

## Honest warnings

- **AI trading is not a money printer.** Claude analyzes recent price data; it has no crystal ball, and short-horizon technical signals are weak. Expect losses, especially with autopilot. Keep `MAX_NOTIONAL` small.
- Stock market data uses Alpaca's free IEX feed (slightly limited); crypto data is 24/7.
- Stocks only fill during US market hours; crypto trades round the clock.
- Fractional/notional stock orders must be market orders on Alpaca.
- This is a personal tool, not financial advice, and past paper performance guarantees nothing live.

## Ideas for later

- Persist the daily trade counter in Workers KV so it survives isolate recycles.
- Add stop-loss brackets (`order_class: "bracket"`) to every AI buy.
- Log every AI decision to Firestore and score its hit rate over time before ever going live.
