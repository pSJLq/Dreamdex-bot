// Дельта-нейтральный ДВУСТОРОННИЙ мейкер для dreamDEX (конкурс #2: объём при ≤0.5 б.п., инвентарь≈0).
//
// СТРАТЕГИЯ (единый резтинг-ордер, сторона по инвентарю — обе ноги PostOnly, НИКОГДА не тейкер):
//   • ФЛЭТ (база≈0) → держим PostOnly-БИД у касания. Налили → появилась база (WETH).
//   • ЛОНГ (есть база) → держим PostOnly-АСК (продаём базу мейкером). Скос цены аска растёт с инвентарём
//     → чем больше набрали, тем агрессивнее аск (быстрее сливает), но ВСЕГДА мейкер (PostOnly не кроссит).
//   Обе ноги мейкер → ноль тейкер-ревертов, ловим спред в обе стороны (цена ≈0/в плюс), инвентарь ≤ 1 клип
//   короткое время → рынок почти не двигает баланс. Источник правды по ордерам — getOwnOpenOrders каждый тик.
//
// ИСПОЛНЕНИЕ (kit-grade): getAutoPullRequirement → allowance → staticCall-симуляция → send(NonceManager,
//   явный газ-прайс, таймауты) → OrderPlaced-чек. guard от наслоения тиков. cancelAllOpen на старте/выходе.
//
// Запуск: DRY_RUN=1 читает живую книгу без ордеров; DRY_RUN=0 боевой (юзер). Ключ KEY2(боевой)/KEY(тест).

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const RPC = process.env.DREAMDEX_CHAIN_RPC || "https://api.infra.mainnet.somnia.network/";
const ORDER_TYPE = { Normal: 0, FillOrKill: 1, IOC: 2, PostOnly: 3 } as const;
const SELF_MATCH_CANCEL_TAKER = 0;
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_SENTINEL = "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00";
const TOPIC_ORDER_PLACED = "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d";
const NS_PER_MS = 1_000_000n;
const MIN_GAS_PRICE_WEI = 12n * 10n ** 9n; // пол цены газа
let cachedGasPrice = MIN_GAS_PRICE_WEI, gasPriceCachedAt = 0;
// динамическая цена газа (пол + запас над сетевой) — ФИКСИРОВАННАЯ цена может застрять в мемпуле при
// росте сетевой цены → т.к. NonceManager шлёт нонсы строго по порядку, ВСЕ следующие транзы встают
// в очередь за застрявшей (каждая «таймаутится», хотя реально просто ждёт). Кэш на 20с, чтобы не спамить RPC.
async function gasPrice(): Promise<bigint> {
  if (Date.now() - gasPriceCachedAt < 20_000) return cachedGasPrice;
  try {
    const fee = await withT(provider.getFeeData(), 6_000, "feeData");
    const net = fee.gasPrice ?? MIN_GAS_PRICE_WEI;
    cachedGasPrice = (net * 15n / 10n) > MIN_GAS_PRICE_WEI ? (net * 15n / 10n) : MIN_GAS_PRICE_WEI;
    gasPriceCachedAt = Date.now();
  } catch { /* держим прошлое значение */ }
  return cachedGasPrice;
}

const MARKETS: Record<string, { pool: string; baseDec: number; quoteDec: number; baseIsNative: boolean }> = {
  "WETH/USDso": { pool: "0xa936da11B57b50A344e1293AAaE5232885ea2bDE", baseDec: 18, quoteDec: 18, baseIsNative: false },
  "WBTC/USDso": { pool: "0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA", baseDec: 8,  quoteDec: 18, baseIsNative: false },
  "SOMI/USDso": { pool: "0x035De7403eac6872787779CCA7CCF1b4CDb61379", baseDec: 18, quoteDec: 18, baseIsNative: true  },
};

const SPOT_ABI = [
  "function placeOrder(bool isBid,uint64 userData,uint256 price,uint256 quantity,uint64 expireTimestampNs,uint8 orderType,uint8 selfMatchingOption,address builder,uint96 builderFeeBpsTimes1k) payable returns (bool success,uint128 orderId)",
  "function cancelOrder(uint128 orderId)",
  "function getPoolParams() view returns (address baseToken_,address quoteToken_,uint256 makerFeeBpsTimes1k_,uint256 takerFeeBpsTimes1k_,uint256 tickSize_,uint256 minQuantity_,uint256 lotSize_)",
  "function getBookLevels(bool isBid,uint64 numLevels) view returns (tuple(uint256 price,uint256 quantity)[])",
  "function getAutoPullRequirement(address owner,bool isBid,uint256 price,uint256 quantity,uint96 builderFeeBpsTimes1k) view returns (address inputToken,uint256 requiredAmount,uint256 delta)",
  "function getOwnOpenOrders() view returns (uint128[])",
  "function getOrder(uint128 orderId) view returns (tuple(uint128 orderId,bool isBid,address owner,uint64 userData,uint256 price,uint256 fullQuantity,uint256 quantityRemaining,uint64 expireTimestampNs))",
];
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const num = (k: string, d: number) => { const v = process.env[k]; const n = v ? Number(v) : NaN; return Number.isFinite(n) ? n : d; };
const CFG = {
  symbol: process.env.MM_SYMBOL || "WETH/USDso",
  notionalUSDso: num("MM_NOTIONAL_USDSO", 12),          // размер бида (объём/цикл)
  maxInventoryUSDso: num("MM_MAX_INVENTORY_USDSO", 14), // выше — НЕ бидуем (только сливаем аском)
  dustUSDso: num("MM_DUST_USDSO", 0.8),                 // ниже — считаем «флэт»
  halfSpreadBps: num("MM_HALF_SPREAD_BPS", 1),          // отступ котировки от мида (мейкер у касания)
  inventorySkewBps: num("MM_INVENTORY_SKEW_BPS", 8),    // скос цены аска на 1× notional инвентаря (агрессивнее слив)
  requoteTriggerBps: num("MM_REQUOTE_TRIGGER_BPS", 3),  // перекотировка только при движении мида > этого
  maxBookSpreadBps: num("MM_MAX_BOOK_SPREAD_BPS", 30),  // шире — не котируем (дислокация)
  tickLoopMs: num("MM_TICK_LOOP_MS", 2500),
  gasFloorSOMI: num("MM_GAS_FLOOR_SOMI", 3),
  maxIdleSec: num("MM_MAX_IDLE_SEC", 1200),
  dryRun: (process.env.DRY_RUN ?? "1") !== "0",
};

const KEY = process.env.MM_USE_OLD_KEY === "1" ? process.env.DREAMDEX_PRIVATE_KEY
  : (process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY);
if (!KEY) { console.error("НЕТ ключа в .env"); process.exit(1); }
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(KEY, provider);
const signer = new ethers.NonceManager(wallet); // локальный нонс → нет «nonce too low» после approve
const mkt = MARKETS[CFG.symbol];
if (!mkt) { console.error(`неизвестная пара ${CFG.symbol}`); process.exit(1); }
const pool = new ethers.Contract(mkt.pool, SPOT_ABI, signer);

let tickRaw = 0n, lotRaw = 0n, minQtyRaw = 0n, baseToken = "", quoteToken = "";
const approved = new Set<string>();
let lastQuoteMid = 0, cumVolumeUSDso = 0, lastTxMs = Date.now(), lastNetBase = 0;

const now = () => new Date().toISOString();
const log = (m: string) => console.log(`[${now()}] ${m}`);
const toRaw = (h: number, dec: number) => ethers.parseUnits(h.toFixed(dec), dec);
const fromRaw = (r: bigint, dec: number) => Number(ethers.formatUnits(r, dec));
const alignTick = (p: bigint, side: "bid" | "ask") => { const r = p % tickRaw; if (r === 0n) return p; return side === "bid" ? p - r : p - r + tickRaw; };
const alignLot = (q: bigint) => q - (q % lotRaw);
const expireNs = (ms: number) => (BigInt(Date.now()) + BigInt(ms)) * NS_PER_MS;
const spreadBps = (bid: number, ask: number) => { const m = (bid + ask) / 2; return m > 0 ? ((ask - bid) / m) * 1e4 : 1e9; };
function withT<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms))]);
}

async function readBook() {
  const [bids, asks] = await withT(Promise.all([pool.getBookLevels(true, 1n), pool.getBookLevels(false, 1n)]), 12_000, "readBook");
  const bestBid = bids.length ? fromRaw(bids[0][0], mkt.quoteDec) : undefined;
  const bestAsk = asks.length ? fromRaw(asks[0][0], mkt.quoteDec) : undefined;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
  return { bestBid, bestAsk, mid };
}
async function walletBaseHuman(): Promise<number> {
  if (mkt.baseIsNative) return fromRaw(await withT(provider.getBalance(wallet.address), 10_000, "baseBal"), mkt.baseDec);
  const erc = new ethers.Contract(baseToken, ERC20_ABI, provider);
  return fromRaw(await withT(erc.balanceOf(wallet.address), 10_000, "baseBal"), mkt.baseDec);
}
async function quoteHuman(): Promise<number> {
  const erc = new ethers.Contract(quoteToken, ERC20_ABI, provider);
  return fromRaw(await withT(erc.balanceOf(wallet.address), 10_000, "quoteBal"), mkt.quoteDec);
}
// открытые ордера (истина по резтингу): [{id, isBid, price, qty(remaining)}]
async function getOpenOrders(): Promise<{ id: bigint; isBid: boolean; price: number; qty: number }[]> {
  const ids: bigint[] = await withT(pool.getOwnOpenOrders(), 10_000, "openOrders");
  const out: { id: bigint; isBid: boolean; price: number; qty: number }[] = [];
  for (const id of ids) {
    try { const o = await withT(pool.getOrder(id), 8_000, "getOrder"); out.push({ id, isBid: o[1], price: fromRaw(o[4], mkt.quoteDec), qty: fromRaw(o[6], mkt.baseDec) }); }
    catch { out.push({ id, isBid: false, price: 0, qty: 0 }); }
  }
  return out;
}

async function ensureAllowance(token: string, needRaw: bigint) {
  if (token.toLowerCase() === NATIVE_SENTINEL.toLowerCase() || /^0x0+$/i.test(token)) return;
  if (approved.has(token.toLowerCase())) return;
  const erc = new ethers.Contract(token, ERC20_ABI, signer);
  const cur: bigint = await withT(erc.allowance(wallet.address, mkt.pool), 10_000, "allowance");
  if (cur < needRaw) { const tx = await erc.approve(mkt.pool, needRaw * 8n, { gasPrice: await gasPrice() }); await withT(tx.wait(1), 45_000, "approve.wait"); }
  approved.add(token.toLowerCase());
}

// разместить ордер; вернуть orderId (для мейкера) или null. Тейкер тут НЕ используется.
async function place(isBid: boolean, priceHuman: number, qtyHuman: number, orderType: number): Promise<bigint | null> {
  const side = isBid ? "bid" : "ask";
  const priceRaw = alignTick(toRaw(priceHuman, mkt.quoteDec), side);
  const qtyRaw = alignLot(toRaw(qtyHuman, mkt.baseDec));
  if (priceRaw <= 0n || qtyRaw < minQtyRaw) return null;
  if (CFG.dryRun) { log(`[dry] ${side} ${orderType === ORDER_TYPE.PostOnly ? "MAKER" : "TAKER"} ${qtyHuman.toFixed(6)} @ ${priceHuman.toFixed(4)}`); return 1n; }

  const [inputToken, requiredAmount] = await withT(pool.getAutoPullRequirement(wallet.address, isBid, priceRaw, qtyRaw, 0n), 10_000, "autopull");
  let value = 0n;
  if (inputToken.toLowerCase() === NATIVE_SENTINEL.toLowerCase()) value = requiredAmount;
  else await ensureAllowance(inputToken, requiredAmount);

  const args = [isBid, 0n, priceRaw, qtyRaw, expireNs(60 * 60_000), orderType, SELF_MATCH_CANCEL_TAKER, ZERO, 0n];
  try { const [ok] = await withT(pool.placeOrder.staticCall(...args, { value }), 10_000, "sim"); if (!ok) return null; }
  catch { return null; } // симуляция ревертнула (PostOnly-кросс/таймаут) → не шлём
  let gas = 800_000n;
  try { const est: bigint = await withT(pool.placeOrder.estimateGas(...args, { value }), 8_000, "estGas"); if (est * 13n / 10n > gas) gas = est * 13n / 10n; } catch { }
  let tx: any, rc: any;
  try { tx = await pool.placeOrder(...args, { value, gasLimit: gas, gasPrice: await gasPrice() }); rc = await withT(tx.wait(1), 45_000, "place.wait"); }
  catch (e) { signer.reset(); log(`${side} send err: ${(e as Error).message.slice(0, 70)}`); return null; } // ЛЮБАЯ ошибка отправки → resync нонса (таймаут = вероятный застрявший предшественник)
  lastTxMs = Date.now();
  if (rc.status !== 1) { log(`${side} tx revert`); return null; }
  const plog = rc.logs.find((l: any) => (l.topics?.[0] ?? "").toLowerCase() === TOPIC_ORDER_PLACED);
  return plog && plog.topics[1] ? BigInt(plog.topics[1]) : null;
}
async function cancel(id: bigint) {
  if (CFG.dryRun) { log(`[dry] cancel ${id}`); return; }
  try { const tx = await pool.cancelOrder(id, { gasPrice: await gasPrice() }); await withT(tx.wait(1), 45_000, "cancel.wait"); lastTxMs = Date.now(); }
  catch { signer.reset(); /* «order gone» на филле — норма; таймаут = resync */ }
}
async function cancelAllOpen() {
  if (CFG.dryRun) return;
  try { const ids: bigint[] = await withT(pool.getOwnOpenOrders(), 10_000, "openOrders"); for (const id of ids) await cancel(id); if (ids.length) log(`снято открытых ордеров: ${ids.length}`); }
  catch (e) { log(`cancelAllOpen err: ${(e as Error).message.slice(0, 60)}`); }
}

// ── Один тик ────────────────────────────────────────────────────────────────
let ticking = false, tickStart = 0;
async function tick() {
  if (ticking && Date.now() - tickStart < 90_000) return;
  ticking = true; tickStart = Date.now();
  try {
    const somi = fromRaw(await withT(provider.getBalance(wallet.address), 10_000, "gasBal"), 18);
    if (!CFG.dryRun && !mkt.baseIsNative && somi <= CFG.gasFloorSOMI) { log(`gas=${somi.toFixed(2)} — МАЛО ГАЗА, пауза`); return; }
    const { bestBid, bestAsk, mid } = await readBook();
    if (bestBid === undefined || bestAsk === undefined || !mid) { log("книга пуста — пропуск"); return; }
    const bookBps = spreadBps(bestBid, bestAsk);
    const tickH = fromRaw(tickRaw, mkt.quoteDec);
    // «флэт»-порог НЕ ниже непродаваемого остатка: инвентарь < minQty*цена аском не выставить (place режет qty<minQty)
    // → частичный филл ниже minQty попадает в «мёртвую зону» (>dust, но аск не встаёт) и ДЕДЛОЧИТ бота.
    // Трактуем такой остаток как флэт → бот снова бидует → следующий филл его поглощает (walletBase складывается).
    const dustEff = Math.max(CFG.dustUSDso, fromRaw(minQtyRaw, mkt.baseDec) * mid * 1.5);

    const open = CFG.dryRun ? [] : await getOpenOrders();
    const myBid = open.find(o => o.isBid);
    const myAsk = open.find(o => !o.isBid);
    const walletBase = await walletBaseHuman();
    const freeQuote = await quoteHuman();
    const netBase = walletBase + (myAsk ? myAsk.qty : 0);   // база в кошельке + эскроу в аске = наш реальный лонг
    const invUSDso = netBase * mid;

    // объём: изменение netBase = филл (бид↑ / аск↓)
    if (Math.abs(netBase - lastNetBase) * mid > 0.3) {
      const d = (netBase - lastNetBase) * mid;
      cumVolumeUSDso += Math.abs(d);
      log(`FILL[${CFG.symbol}] ${d > 0 ? "MAKER buy" : "MAKER sell"} ~$${Math.abs(d).toFixed(1)} | инв=$${invUSDso.toFixed(2)} | объём=$${cumVolumeUSDso.toFixed(0)}`);
    }
    lastNetBase = netBase;

    const eq = freeQuote + invUSDso + (myBid ? myBid.price * myBid.qty : 0);
    const logEq = (tag: string) => log(`equity=$${eq.toFixed(1)} inv=$${invUSDso.toFixed(2)} gas=${somi.toFixed(2)} vol=$${cumVolumeUSDso.toFixed(0)} спред=${bookBps.toFixed(1)}бп актив=mm${tag}`);

    if (bookBps > CFG.maxBookSpreadBps) { if (myBid) await cancel(myBid.id); if (myAsk) await cancel(myAsk.id); logEq("(книга широка)"); return; }

    const moved = lastQuoteMid > 0 ? Math.abs((mid - lastQuoteMid) / lastQuoteMid) * 1e4 : 1e9;

    if (invUSDso > dustEff) {
      // ЛОНГ → сливаем базу PostOnly-аском (скос вниз с ростом инвентаря), бид убираем
      if (myBid) await cancel(myBid.id);
      const skew = Math.min(invUSDso / CFG.notionalUSDso, 3) * CFG.inventorySkewBps * 1e-4;
      let askPrice = mid * (1 + CFG.halfSpreadBps * 1e-4 - skew);
      if (askPrice < bestBid + tickH) askPrice = bestBid + tickH;      // не кроссить бид (остаёмся мейкером)
      const needRequote = !myAsk || moved > CFG.requoteTriggerBps || Math.abs(myAsk.qty - walletBase) > fromRaw(lotRaw, mkt.baseDec) * 2;
      if (needRequote && walletBase > 0) {
        if (myAsk) await cancel(myAsk.id);
        const sellBase = CFG.dryRun ? netBase : await walletBaseHuman();  // после отмены база вернулась в кошелёк
        const id = await place(false, askPrice, sellBase, ORDER_TYPE.PostOnly);
        if (id !== null) { lastQuoteMid = mid; log(`ORDER maker-ask ${sellBase.toFixed(6)} @ ${askPrice.toFixed(4)} (инв $${invUSDso.toFixed(1)}, скос ${(skew*1e4).toFixed(1)}бп)`); }
      }
      logEq("(лонг→аск)");
    } else {
      // ФЛЭТ → PostOnly-бид у касания, аск убираем
      if (myAsk) await cancel(myAsk.id);
      if (invUSDso <= dustEff && freeQuote >= CFG.notionalUSDso * 0.5) {
        let bidPrice = mid * (1 - CFG.halfSpreadBps * 1e-4);
        if (bidPrice > bestAsk - tickH) bidPrice = bestAsk - tickH;
        const needRequote = !myBid || moved > CFG.requoteTriggerBps;
        if (needRequote) {
          if (myBid) await cancel(myBid.id);
          const qty = Math.min(CFG.notionalUSDso, freeQuote * 0.95) / mid;
          const id = await place(true, bidPrice, qty, ORDER_TYPE.PostOnly);
          if (id !== null) { lastQuoteMid = mid; log(`ORDER maker-bid ${qty.toFixed(6)} @ ${bidPrice.toFixed(4)} (спред ${bookBps.toFixed(1)}бп)`); }
        }
      }
      logEq("(флэт→бид)");
    }
  } catch (e) { log(`tick error: ${(e as Error).message.slice(0, 100)}`); }
  finally { ticking = false; }
}

async function main() {
  log(`dreamDEX MM старт | пара=${CFG.symbol} | DRY_RUN=${CFG.dryRun} | кошелёк=${wallet.address}`);
  const pp = await pool.getPoolParams();
  baseToken = pp[0]; quoteToken = pp[1]; tickRaw = pp[4]; minQtyRaw = pp[5]; lotRaw = pp[6];
  log(`пул ${CFG.symbol}: tick=${fromRaw(tickRaw, mkt.quoteDec)} lot=${fromRaw(lotRaw, mkt.baseDec)} minQty=${fromRaw(minQtyRaw, mkt.baseDec)} fee=${pp[2]}/${pp[3]}`);
  log(`конфиг: notional=$${CFG.notionalUSDso} maxInv=$${CFG.maxInventoryUSDso} halfSpread=${CFG.halfSpreadBps}бп skew=${CFG.inventorySkewBps}бп requoteTrig=${CFG.requoteTriggerBps}бп loop=${CFG.tickLoopMs}ms`);
  lastNetBase = await walletBaseHuman();
  await cancelAllOpen();

  const timer = setInterval(() => { tick().catch(e => log(`tick outer: ${(e as Error).message.slice(0, 80)}`)); }, CFG.tickLoopMs);
  try { await tick(); } catch (e) { log(`первый тик: ${(e as Error).message.slice(0, 80)}`); }
  if (!CFG.dryRun) setInterval(() => { if (Date.now() - lastTxMs > CFG.maxIdleSec * 1000) { log("WATCHDOG: нет tx > maxIdleSec → exit(1)"); process.exit(1); } }, 60_000);

  const shutdown = async () => { clearInterval(timer); await cancelAllOpen(); log("остановлен, все ордера сняты"); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  const runSec = Number(process.env.RUN_SECONDS ?? 0);
  if (runSec > 0) setTimeout(shutdown, runSec * 1000);
  process.on("unhandledRejection", (e) => log(`unhandledRejection: ${String(e).slice(0, 80)}`));
  process.on("uncaughtException", (e) => log(`uncaughtException: ${String(e).slice(0, 80)}`));
}
main().catch(e => { log(`fatal: ${(e as Error).message}`); process.exit(1); });
