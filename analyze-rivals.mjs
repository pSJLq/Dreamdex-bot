// Разовый READ-ONLY разбор топ-2 кошельков. Без ключа, без ордеров — только публичное чтение.
const RPC = "https://api.infra.mainnet.somnia.network/";
const API = "https://api.dreamdex.io/v0";
const LB  = "https://dreamdex-leaderboard-new.vercel.app/api/leaderboard";
const EXPL = "https://explorer.somnia.network/api"; // blockscout-style

const WALLETS = {
  "ТОП-1": "0xba4E595D6C2e655592c86ce29BbAec202d9175E1",
  "ТОП-2": "0x248B9619213C3aBA4a5AC8Ded692Ba5d5eE8974c",
  "МЫ":    "0x3D3F1BCC7f4A1D3C0d2BD2E25b7dFd6AA8bE0840",
};
// токены (из /markets): addr -> {sym, dec}
const TOKENS = {
  "0x28f34defd2b4cb48d9ee6d89f2be4bc601694c00": { sym: "wSOMI", dec: 18 },
  "0x28bec7e30e6faee657a03e19bf1128aad7632a00": { sym: "USDC.e", dec: 6 },
  "0xc5098b3ca516784323872f17235fa074e167d3d2": { sym: "WBTC", dec: 8 },
  "0x936ab8c674bcb567cd5deb85d8a216494704e9d8": { sym: "WETH", dec: 18 },
  "0x00000022da000002656c64d9ea6011ea952d008a": { sym: "USDso", dec: 18 },
};
// пул -> пара (чтобы по to-адресу tx понять какую пару торгует)
const POOLS = {
  "0x035de7403eac6872787779cca7ccf1b4cdb61379": "SOMI",
  "0x25bff6b7b5e2243424f38e75de7ab03c0522a5ea": "WBTC",
  "0xa936da11b57b50a344e1293aaae5232885ea2bde": "WETH",
};

let id = 1;
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
}
const j = (s) => s.fetch ? s : s; // noop
async function getJSON(url, opts) { const r = await fetch(url, opts); return r.json(); }
const fmt = (bi, dec) => Number(bi) / 10 ** dec;
async function balanceOf(token, holder) {
  const data = "0x70a08231" + holder.toLowerCase().replace("0x", "").padStart(64, "0");
  try { return BigInt(await rpc("eth_call", [{ to: token, data }, "latest"])); } catch { return 0n; }
}
const nativeBal = async (h) => BigInt(await rpc("eth_getBalance", [h, "latest"]));
const txCount   = async (h) => parseInt(await rpc("eth_getTransactionCount", [h, "latest"]), 16);

async function main() {
  // ЦЕНЫ из последней сделки каждой пары
  const price = { USDso: 1, "USDC.e": 1 };
  const PAIRS = ["WETH:USDso", "WBTC:USDso", "SOMI:USDso"];
  const flow = {};
  for (const sym of PAIRS) {
    try {
      const tr = await getJSON(`${API}/markets/${encodeURIComponent(sym)}/trades`);
      const arr = (tr.trades ?? tr ?? []);
      const base = sym.split(":")[0];
      if (arr.length) price[base] = parseFloat(arr[0].price ?? 0);
      flow[sym] = arr.slice(0, 15);
    } catch (e) { flow[sym] = []; }
  }
  price.SOMI = price.SOMI || 0.1; price.WETH = price.WETH || 0; price.WBTC = price.WBTC || 0;
  console.log("== ЦЕНЫ (последняя сделка) ==", price);

  // БАЛАНСЫ ON-CHAIN
  console.log("\n== ЧТО ДЕРЖАТ ПРЯМО СЕЙЧАС (on-chain) ==");
  for (const [label, addr] of Object.entries(WALLETS)) {
    const nat = fmt(await nativeBal(addr), 18);
    const tc = await txCount(addr);
    let totalUSD = 0, usdso = 0, invUSD = 0, parts = [];
    for (const [taddr, info] of Object.entries(TOKENS)) {
      const bal = fmt(await balanceOf(taddr, addr), info.dec);
      if (bal > 1e-9) {
        const px = info.sym === "wSOMI" ? price.SOMI : (price[info.sym] ?? 0);
        const usd = bal * px; totalUSD += usd;
        if (info.sym === "USDso") usdso += usd; else invUSD += usd;
        parts.push(`${info.sym} ${bal.toFixed(4)} ≈$${usd.toFixed(1)}`);
      }
    }
    const pnl = usdso - 150;                 // лидерборд считает PnL = USDso в кошельке − 150
    const mult = Math.max(0, 1 + pnl / 150);
    console.log(`\n[${label}] ${addr}  (всего tx с кошелька: ${tc})`);
    console.log(`  газ(нативн.SOMI): ${nat.toFixed(2)}`);
    console.log(`  активы: ${parts.join("  |  ") || "—"}`);
    console.log(`  >> USDso в кошельке: $${usdso.toFixed(1)}  |  инвентарь(токены): $${invUSD.toFixed(1)}  |  лидерборд-PnL≈${pnl.toFixed(1)}  множ≈${mult.toFixed(2)}`);
  }

  // ЛИДЕРБОРД (если домен доступен)
  try {
    const lb = await getJSON(LB);
    console.log("\n== ЛИДЕРБОРД ==");
    for (const t of (lb.traders ?? [])) console.log(`  ${(t.handle||"?").padEnd(14)} ${t.address?.slice(0,8)} raw=${Math.round(t.volumeUsdso)} eff=${Math.round(t.volumeEffective)} pnl=${(t.pnl??0).toFixed(1)} usdso=${(t.usdsoBalance??0).toFixed(1)} tx=${t.txCount} fills=${t.fills}`);
  } catch (e) { console.log("\n== ЛИДЕРБОРД == недоступен (" + e.message + ")"); }

  // ПОТОК СДЕЛОК
  console.log("\n== ПОТОК СДЕЛОК (последние) ==");
  for (const sym of PAIRS) {
    const arr = flow[sym]; if (!arr.length) { console.log(`  ${sym}: нет`); continue; }
    let buys = 0, sells = 0, vol = 0, last = 0; const now = Date.now();
    for (const t of arr) { const sz = parseFloat(t.quantity ?? t.amount ?? 0), px = parseFloat(t.price ?? 0); vol += sz * px; if ((t.side || t.takerSide) === "buy") buys++; else sells++; const ts = +(t.timestamp ?? t.createdAt ?? 0); if (ts > last) last = ts; }
    console.log(`  ${sym.padEnd(11)} ${arr.length} сделок: buy=${buys} sell=${sells} ~$${Math.round(vol)} посл.${last?((now-last)/60000).toFixed(0):"?"}мин назад`);
  }

  // НЕДАВНЯЯ АКТИВНОСТЬ риваловов из эксплорера (какие пулы дёргают = какие пары + темп)
  console.log("\n== НЕДАВНИЕ TX РИВАЛОВ (explorer) ==");
  for (const [label, addr] of Object.entries(WALLETS)) {
    if (label === "МЫ") continue;
    try {
      const r = await getJSON(`${EXPL}?module=account&action=txlist&address=${addr}&sort=desc&page=1&offset=25`);
      const txs = r.result ?? [];
      if (!Array.isArray(txs) || !txs.length) { console.log(`  [${label}] explorer: нет данных (${(r.message||r.status||"?")})`); continue; }
      const byPool = {}; let first = 0, lastT = 0;
      for (const t of txs) {
        const to = (t.to || "").toLowerCase(); const pair = POOLS[to] || (to.slice(0,10));
        byPool[pair] = (byPool[pair] || 0) + 1;
        const ts = +t.timeStamp; if (!first || ts > first) first = ts; if (!lastT || ts < lastT) lastT = ts;
      }
      const spanMin = first && lastT ? ((first - lastT) / 60) : 0;
      const newest = first ? ((Date.now()/1000 - first)/60).toFixed(0) : "?";
      console.log(`  [${label}] последние ${txs.length} tx за ~${spanMin.toFixed(0)}мин (последняя ${newest}мин назад) → пулы: ${JSON.stringify(byPool)}`);
    } catch (e) { console.log(`  [${label}] explorer error: ${e.message}`); }
  }
}
main().catch(e => { console.error("FATAL", e.message); process.exit(1); });
