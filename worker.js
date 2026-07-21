/**
 * tape — Cloudflare Worker backend
 * ---------------------------------------------------------
 * Holds your secrets, talks to Alpaca (stocks + crypto) and
 * the Anthropic API. The frontend never sees your keys.
 *
 * Secrets to set (wrangler secret put <NAME>):
 *   ALPACA_KEY          — Alpaca API key id
 *   ALPACA_SECRET       — Alpaca API secret
 *   ANTHROPIC_API_KEY   — your Anthropic API key
 *   AUTH_KEY            — a password YOU invent; the dashboard sends it
 *
 * Vars (wrangler.toml):
 *   MODE                — "paper" (default, fake money) or "live" (REAL MONEY)
 *   MAX_NOTIONAL        — max $ per single order the worker will accept
 *   MAX_TRADES_PER_DAY  — hard cap on orders per UTC day
 */

const PAPER_BASE = "https://paper-api.alpaca.markets";
const LIVE_BASE = "https://api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Auth-Key",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// naive in-memory day counter (per worker isolate). Good enough as a
// guardrail; resets on deploy/isolate recycle, so treat it as best-effort.
let tradeDay = "";
let tradesToday = 0;

function countTrade(env) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== tradeDay) {
    tradeDay = today;
    tradesToday = 0;
  }
  tradesToday++;
  return tradesToday <= Number(env.MAX_TRADES_PER_DAY || 20);
}

function alpacaHeaders(env) {
  return {
    "APCA-API-KEY-ID": env.ALPACA_KEY,
    "APCA-API-SECRET-KEY": env.ALPACA_SECRET,
    "Content-Type": "application/json",
  };
}

function tradingBase(env) {
  return env.MODE === "live" ? LIVE_BASE : PAPER_BASE;
}

async function alpaca(env, base, path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { ...alpacaHeaders(env), ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

const isCrypto = (sym) => sym.includes("/") || /USD[TC]?$/.test(sym) && sym.length > 6;

// ---------- market data helpers ----------

async function getSnapshot(env, symbol) {
  if (symbol.includes("/")) {
    const r = await alpaca(env, DATA_BASE,
      `/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(symbol)}`);
    const snap = r.body?.snapshots?.[symbol];
    return snap ? {
      symbol,
      price: snap.latestTrade?.p ?? snap.latestQuote?.ap,
      dailyBar: snap.dailyBar, prevDailyBar: snap.prevDailyBar,
    } : null;
  }
  const r = await alpaca(env, DATA_BASE, `/v2/stocks/${symbol}/snapshot`);
  const s = r.body;
  if (!s || r.status !== 200) return null;
  return {
    symbol,
    price: s.latestTrade?.p ?? s.latestQuote?.ap,
    dailyBar: s.dailyBar, prevDailyBar: s.prevDailyBar,
  };
}

async function getBars(env, symbol, timeframe = "1Hour", limit = 120) {
  if (symbol.includes("/")) {
    const r = await alpaca(env, DATA_BASE,
      `/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${timeframe}&limit=${limit}`);
    return r.body?.bars?.[symbol] || [];
  }
  const start = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString();
  const r = await alpaca(env, DATA_BASE,
    `/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&start=${start}&adjustment=split&feed=iex`);
  return r.body?.bars || [];
}

// ---------- AI analysis ----------

async function analyze(env, symbol, account, position) {
  const [bars, snap] = await Promise.all([
    getBars(env, symbol, symbol.includes("/") ? "1Hour" : "1Hour", 120),
    getSnapshot(env, symbol),
  ]);
  if (!bars.length || !snap) throw new Error("No market data for " + symbol);

  const compactBars = bars.slice(-90).map(b =>
    ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));

  const sys = `You are the trading analysis engine inside a personal trading dashboard.
Respond ONLY with a JSON object, no markdown fences, no prose outside JSON:
{
 "action": "buy" | "sell" | "hold",
 "confidence": 0-100,
 "suggested_notional_usd": number,
 "time_horizon": "intraday" | "swing" | "position",
 "reasoning": "2-4 sentences, concrete, referencing the data",
 "risk_notes": "1-2 sentences on what invalidates this idea"
}
Rules: be conservative; if the data is ambiguous, action is "hold".
Never suggest more than ${env.MAX_NOTIONAL || 200} USD notional.
If the user already holds the asset and the setup weakened, "sell" is allowed.
This is analysis of technical data only, not personalized financial advice.`;

  const user = `Symbol: ${symbol}
Latest price: ${snap.price}
Today's bar: ${JSON.stringify(snap.dailyBar)}
Previous day: ${JSON.stringify(snap.prevDailyBar)}
Current position: ${position ? JSON.stringify(position) : "none"}
Account equity: ${account?.equity} | buying power: ${account?.buying_power}
Recent hourly bars (oldest→newest): ${JSON.stringify(compactBars)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic API error");
  const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  parsed.price = snap.price;
  parsed.symbol = symbol;
  return parsed;
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // auth gate — everything requires the key
    if (request.headers.get("X-Auth-Key") !== env.AUTH_KEY) {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      // mode + limits, so the UI can display them
      if (path === "/api/config") {
        return json({
          mode: env.MODE === "live" ? "live" : "paper",
          max_notional: Number(env.MAX_NOTIONAL || 200),
          max_trades_per_day: Number(env.MAX_TRADES_PER_DAY || 20),
          ai_enabled: Boolean(env.ANTHROPIC_API_KEY),
        });
      }

      if (path === "/api/account") {
        const r = await alpaca(env, tradingBase(env), "/v2/account");
        return json(r.body, r.status);
      }

      if (path === "/api/positions") {
        const r = await alpaca(env, tradingBase(env), "/v2/positions");
        return json(r.body, r.status);
      }

      if (path === "/api/orders" && request.method === "GET") {
        const r = await alpaca(env, tradingBase(env), "/v2/orders?status=all&limit=30&direction=desc");
        return json(r.body, r.status);
      }

      if (path === "/api/orders" && request.method === "POST") {
        const o = await request.json();
        // ---- guardrails ----
        const notional = Number(o.notional || 0) ||
          Number(o.qty || 0) * Number(o.est_price || 0);
        if (notional > Number(env.MAX_NOTIONAL || 200)) {
          return json({ error: `Blocked: order notional $${notional.toFixed(2)} exceeds MAX_NOTIONAL ($${env.MAX_NOTIONAL || 200}).` }, 400);
        }
        if (!countTrade(env)) {
          return json({ error: "Blocked: daily trade cap reached (MAX_TRADES_PER_DAY)." }, 429);
        }
        const order = {
          symbol: o.symbol,
          side: o.side,                      // "buy" | "sell"
          type: o.type || "market",
          time_in_force: o.symbol.includes("/") ? "gtc" : (o.time_in_force || "day"),
        };
        if (o.notional) order.notional = String(o.notional);
        else order.qty = String(o.qty);
        if (o.type === "limit") order.limit_price = String(o.limit_price);

        const r = await alpaca(env, tradingBase(env), "/v2/orders", {
          method: "POST", body: JSON.stringify(order),
        });
        return json(r.body, r.status);
      }

      if (path.startsWith("/api/orders/") && request.method === "DELETE") {
        const id = path.split("/").pop();
        const r = await alpaca(env, tradingBase(env), `/v2/orders/${id}`, { method: "DELETE" });
        return json(r.body?.raw ? { ok: true } : r.body, r.status === 204 ? 200 : r.status);
      }

      if (path === "/api/snapshot") {
        const symbol = url.searchParams.get("symbol");
        const snap = await getSnapshot(env, symbol);
        return snap ? json(snap) : json({ error: "no data" }, 404);
      }

      if (path === "/api/bars") {
        const symbol = url.searchParams.get("symbol");
        const tf = url.searchParams.get("timeframe") || "1Hour";
        return json({ bars: await getBars(env, symbol, tf, 120) });
      }

      if (path === "/api/analyze" && request.method === "POST") {
        if (!env.ANTHROPIC_API_KEY) {
          return json({ error: "AI analysis is disabled — set the ANTHROPIC_API_KEY secret to enable it." }, 501);
        }
        const { symbol } = await request.json();
        const [acctRes, posRes] = await Promise.all([
          alpaca(env, tradingBase(env), "/v2/account"),
          alpaca(env, tradingBase(env), "/v2/positions"),
        ]);
        const positions = Array.isArray(posRes.body) ? posRes.body : [];
        const pos = positions.find(p =>
          p.symbol === symbol.replace("/", "")) || null;
        const result = await analyze(env, symbol, acctRes.body, pos);
        return json(result);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },
};
