// МУЛЬТИ-ПАРА дельта-нейтральный двусторонний мейкер для dreamDEX (конкурс #2).
// Один процесс ведёт НЕСКОЛЬКО пар (WETH/WBTC/SOMI vs USDso) на ОДНОМ кошельке.
// Зачем: одна пара = один источник встречного потока → пересох поток = простой + низкий темп.
// Несколько пар → когда одна односторонняя/тихая, другие наливают → меньше простоя, ×2-3 темп, цена так же ~0.
//
// НОНС-БЕЗОПАСНОСТЬ: все пары шлют tx через ОДИН общий ethers.NonceManager, а тик обрабатывает пары
// СТРОГО ПОСЛЕДОВАТЕЛЬНО (await каждой пары до следующей) + guard `ticking` → в полёте всегда ≤1 tx → нонс не гонится.
// КАПИТАЛ: USDso общий; balanceOf(USDso) уже исключает залоченное в чужих бидах → пары делят капитал естественно.
// ГАЗ (native SOMI): для SOMI-пары native-баланс = газ + инвентарь → вычитаем газовый резерв, чтобы НЕ продать газ.
//
// ЖЕЛЕЗНОЕ ПРАВИЛО ЮЗЕРА: рынок НЕ должен двигать баланс → ИНВЕНТАРЬ НЕ ЖИВЁТ.
// Вход: PostOnly-бид у касания (мейкер, бесплатно). Выход: НЕМЕДЛЕННЫЙ тейкер IOC-sell через REST API
// (ровно тот путь, которым бот конкурса #1 неделю крутил IOC без ревертов: POST /orders → сервер строит tx →
// шлём своим signer). Прямой placeOrder(IOC) в контракт НЕ использовать — ревертит (flatten_diag).
// Цена цикла ≈ спред на выходе → бидуем ТОЛЬКО при узкой книге (гейт maxBookSpreadBps).
// Остальные фиксы — как в mm.ts (динамический gasPrice, withT-таймауты, dustEff, signer.reset, cancelAllOpen).

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
const MIN_GAS_PRICE_WEI = 12n * 10n ** 9n;
let cachedGasPrice = MIN_GAS_PRICE_WEI, gasPriceCachedAt = 0;

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
  pairs: (process.env.MM_PAIRS || "WETH/USDso,WBTC/USDso").split(",").map(s => s.trim()).filter(Boolean),
  notionalUSDso: num("MM_NOTIONAL_USDSO", 12),
  dustUSDso: num("MM_DUST_USDSO", 0.8),
  halfSpreadBps: num("MM_HALF_SPREAD_BPS", 1),
  inventorySkewBps: num("MM_INVENTORY_SKEW_BPS", 8),
  requoteTriggerBps: num("MM_REQUOTE_TRIGGER_BPS", 3),
  maxBookSpreadBps: num("MM_MAX_BOOK_SPREAD_BPS", 8),   // ГЕЙТ ВХОДА: цена цикла ≈ спред выхода → бидуем только при узкой книге
  takerSlackBps: num("MM_TAKER_SLACK_BPS", 10),          // лимит IOC-sell = bestBid*(1-это) — кроссит книгу, гарантия исполнения
  // ТЕЙКЕР-ЧЁРН (гарантированный темп, модель топов): при простое мейкера сами кроссим УЗКИЙ спред.
  // Цена чёрн-цикла ≈ спред книги → жёсткий гейт по спреду. Пейс = контроль расхода бюджета:
  // при спреде ≤2.5бп и клипе $30 цикл стоит ≤$0.008 за ~$60 объёма → пейс 60с ≈ $10/день бюджета.
  churnMaxSpreadBps: num("MM_CHURN_MAX_SPREAD_BPS", 2.5),
  churnAfterIdleSec: num("MM_CHURN_AFTER_IDLE_SEC", 45), // чёрним только если нет филлов дольше этого (мейкер молчит)
  churnPaceSec: num("MM_CHURN_PACE_SEC", 60),            // база: пейс между чёрнами (дорогие окна / adaptive off)
  quoteFloorUSDso: num("MM_QUOTE_FLOOR_USDSO", 110),     // свободный USDso ниже — чёрн ВЫКЛ (страховка «не обнулиться»)
  // АДАПТИВНЫЙ ЧЁРН (#1): пейс от спреда — узко=дёшево=чаще, широко=дорого=редко. Снимает лимит 60с в дешёвых
  // окнах → темп ↑ И средняя цена ↓. В adaptive idle-гейт снят (чёрн-филлы иначе сбрасывали бы таймер и душили частоту).
  churnAdaptive: (process.env.MM_CHURN_ADAPTIVE ?? "0") === "1",
  churnPaceMinSec: num("MM_CHURN_PACE_MIN_SEC", 10),     // самый частый пейс при спреде ≤0.5бп
  makerEnabled: (process.env.MM_MAKER_ENABLED ?? "1") !== "0",   // 0 = чистый чёрн (мейкер-бид выключен, весь капитал чёрну)
  // Исполнение чёрна (фикс утечки 17 июля: платили ~0.7бп/ед при гейте 0.6 — depth-race в слаке 6бп):
  churnSlackBps: num("MM_CHURN_SLACK_BPS", num("MM_TAKER_SLACK_BPS", 6)),  // узкий лимит ног чёрна: книга уехала → мимо/реверт (~$0.001), НЕ глубокий филл
  churnDepthFrac: num("MM_CHURN_DEPTH_FRAC", 0.95),                        // доля топ-уровня, которую бьём (меньше = меньше гонки за глубину)
  // МЕЙКЕР-ВЫХОД (цена↓): вместо немедленного тейкер-IOC на выходе — PostOnly-аск у касания с TTL, фолбэк IOC.
  // 0 = ВЫКЛ (чистый IOC, поведение как раньше). >0 = держим инвентарь ≤TTL сек ради мейкер-цены на выходе.
  exitMakerTtlSec: num("MM_EXIT_MAKER_TTL_SEC", 0),
  exitStopBps: num("MM_EXIT_STOP_BPS", 8),          // цена ушла против лонга > этого от входа → немедленный IOC (стоп)
  exitMaxInvMult: num("MM_EXIT_MAX_INV_MULT", 1.5), // инвентарь > clip*этого (стек филлов) → немедленный IOC
  maxBidAgeSec: num("MM_MAX_BID_AGE_SEC", 25),           // бид старше — снять (капитал-локк фикс + свежая котировка)
  maxClipMult: num("MM_MAX_CLIP_MULT", 3),      // пара отключается, если минимальный валидный клип > notional*этого
  tickLoopMs: num("MM_TICK_LOOP_MS", 2500),
  gasFloorSOMI: num("MM_GAS_FLOOR_SOMI", 5),     // ниже — не торгуем (юзер: держать >=5 SOMI)
  gasReserveSOMI: num("MM_GAS_RESERVE_SOMI", 15),// для native-базы (SOMI): столько НЕ считаем инвентарём (это газ)
  maxIdleSec: num("MM_MAX_IDLE_SEC", 1200),
  dryRun: (process.env.DRY_RUN ?? "1") !== "0",
};

// Клип ПО ПАРЕ: MM_NOTIONAL_WBTC / MM_NOTIONAL_WETH ... переопределяют общий MM_NOTIONAL_USDSO.
// WBTC стакан глубже → там клип можно крупнее; WETH тонкий → мельче.
const pairNotional = (sym: string) => num("MM_NOTIONAL_" + sym.split("/")[0], CFG.notionalUSDso);

const KEY = process.env.MM_USE_OLD_KEY === "1" ? process.env.DREAMDEX_PRIVATE_KEY
  : (process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY);
if (!KEY) { console.error("НЕТ ключа в .env"); process.exit(1); }
const provider = new ethers.JsonRpcProvider(RPC);
// Somnia финализирует за ~0.3-0.8с, но ethers по дефолту опрашивает receipt раз в 4с → каждый wait(1)
// «стоил» ~4.5с (замер 16 июля: дельты ног burst-чёрна 4.51/4.51/4.51 — таймер, не сеть). 400мс → ноги ~1с.
provider.pollingInterval = 400;
const wallet = new ethers.Wallet(KEY, provider);
const signer = new ethers.NonceManager(wallet); // ОДИН на все пары → нонс сериализуется

async function gasPrice(): Promise<bigint> {
  if (Date.now() - gasPriceCachedAt < 20_000) return cachedGasPrice;
  try {
    const fee = await withT(provider.getFeeData(), 6_000, "feeData");
    const net = fee.gasPrice ?? MIN_GAS_PRICE_WEI;
    cachedGasPrice = (net * 15n / 10n) > MIN_GAS_PRICE_WEI ? (net * 15n / 10n) : MIN_GAS_PRICE_WEI;
    gasPriceCachedAt = Date.now();
  } catch { /* держим прошлое */ }
  return cachedGasPrice;
}

// ── REST-путь для тейкера (ровно как exchange.ts бота #1 — работал неделю без ревертов) ──
const REST = process.env.DREAMDEX_REST_URL || "https://api.dreamdex.io/v0";
const CHAIN_ID = 5031;
let restToken = "", restAuthing: Promise<void> | null = null;
async function restAuthOnce(): Promise<void> {
  // SIWE: nonce → подпись кошельком → JWT
  const { nonce } = await (await withT(fetch(`${REST}/auth/nonce`), 12_000, "auth.nonce")).json() as any;
  const domain = new URL(REST).host;
  const msg = [
    `${domain} wants you to sign in with your Ethereum account:`, wallet.address, "",
    "Sign in to dreamDEX", "",
    `URI: https://${domain}`, "Version: 1", `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const signature = await wallet.signMessage(msg);
  const r: any = await (await withT(fetch(`${REST}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: msg, signature }),
  }), 12_000, "auth.login")).json();
  if (!r?.token) throw new Error(`auth: нет токена (${JSON.stringify(r).slice(0, 80)})`);
  restToken = r.token;
}
async function restAuth(): Promise<void> {
  if (!restAuthing) restAuthing = restAuthOnce().finally(() => { restAuthing = null; });
  return restAuthing;
}
async function restJson(url: string, opts: any = {}): Promise<any> {
  if (!restToken) await restAuth();
  const run = () => withT(fetch(url, { ...opts, headers: { "content-type": "application/json", authorization: `Bearer ${restToken}` } }), 12_000, "rest");
  let r = await run();
  if (r.status === 401) { await restAuth(); r = await run(); } // JWT протух → перелогин + один повтор
  return r.json();
}
// Универсальная постановка ЧЕРЕЗ REST: сервер строит КОРРЕКТНУЮ tx (как бот #1), мы только подписываем и шлём.
// НЕ хендролим placeOrder в контракт (это давало "unknown custom error" реверты) и НЕ пред-симулируем
// (staticCall/estimateGas ложно ревертят на dreamDEX — гонка книги). Реверт ловим по rc.status!=1 (газ мелкий).
// СБОРКА tx через REST (без отправки). Для burst-чёрна обе ноги собираются ПАРАЛЛЕЛЬНО заранее —
// REST-раундтрип (~2-3с) уходит из критического пути между ногами (замер 16 июля: связка была 5.1с, цель ~1с).
async function restBuildTx(st: PS, side: "buy" | "sell", priceHuman: number, qtyHuman: number, orderType: "postOnly" | "immediateOrCancel"): Promise<any | null> {
  const tickH = fromRaw(st.tickRaw, st.mkt.quoteDec);
  const lotH = fromRaw(st.lotRaw, st.mkt.baseDec);
  const decs = (x: number) => { const s = x.toFixed(12).replace(/0+$/, ""); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; };
  const p = Math.round(priceHuman / tickH) * tickH;
  const a = Math.floor(qtyHuman / lotH) * lotH;
  if (a < fromRaw(st.minQtyRaw, st.mkt.baseDec) || p <= 0) return null;
  await ensureAllowance(st, side === "buy" ? st.quoteToken : st.baseToken);   // wallet-funding: buy тянет USDso, sell тянет base
  const sym = st.symbol.replace("/", ":");
  const body = { type: "limit", side, amount: a.toFixed(decs(lotH)), price: p.toFixed(decs(tickH)), orderType, fundingSource: "wallet" };
  const r = await restJson(`${REST}/markets/${encodeURIComponent(sym)}/orders`, { method: "POST", body: JSON.stringify(body) });
  const tx = r?.transaction ?? r;
  if (!tx?.to || !tx?.data || tx.data === "0x") { logT(st.symbol + side + "empty", `${st.symbol} ${side} ${orderType}: пустая tx (${JSON.stringify(r).slice(0, 90)})`); return null; }
  return tx;
}
// ОТПРАВКА собранной tx (подпись → send → 1 конфирмация).
async function restSendTx(st: PS, tx: any, label: string): Promise<any | null> {
  try {
    const s = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0, gasPrice: await gasPrice() }); // без gasLimit → ethers оценит; кросс-postOnly кинет → скип (газ цел)
    const rc: any = await withT(s.wait(1), 45_000, label + ".wait");
    lastTxMs = Date.now();
    if (rc.status !== 1) { logT(st.symbol + label + "rev", `${st.symbol} ${label} tx revert`); return null; }
    return rc;
  } catch (e) { signer.reset(); logT(st.symbol + label + "senderr", `${st.symbol} ${label} НЕ прошёл: ${(e as Error).message.slice(0, 50)}`); return null; }
}
// Поведение прежнее: сборка + отправка одним вызовом (мейкер/одиночные IOC).
async function restOrder(st: PS, side: "buy" | "sell", priceHuman: number, qtyHuman: number, orderType: "postOnly" | "immediateOrCancel"): Promise<any | null> {
  const tx = await restBuildTx(st, side, priceHuman, qtyHuman, orderType);
  if (!tx) return null;
  return restSendTx(st, tx, side + "." + orderType);
}
// Тейкер IOC — тонкая обёртка над restOrder.
async function takerIOC(st: PS, side: "buy" | "sell", priceHuman: number, qtyHuman: number): Promise<boolean> {
  if (CFG.dryRun) { log(`[dry ${st.symbol}] IOC ${side} ${qtyHuman.toFixed(6)} @ ${priceHuman.toFixed(4)}`); return true; }
  return !!(await restOrder(st, side, priceHuman, qtyHuman, "immediateOrCancel"));
}

// ── Состояние одной пары ─────────────────────────────────────────────────────
interface PS {
  symbol: string;
  mkt: { pool: string; baseDec: number; quoteDec: number; baseIsNative: boolean };
  pool: ethers.Contract;
  tickRaw: bigint; lotRaw: bigint; minQtyRaw: bigint;
  baseToken: string; quoteToken: string;
  approved: Set<string>;
  lastQuoteMid: number; lastNetBase: number; cumVolume: number;
  lastFillMs: number; lastChurnMs: number; lastBidMs: number;   // чёрн: простой мейкера + пейс; lastBidMs: возраст бида
  longSinceMs: number; longEntryMid: number;   // мейкер-выход: когда ушли в лонг + мид входа (для TTL/стопа)
  lastBookBps: number;   // последний спред книги — сигнал «выгодности» пары для адаптивной маршрутизации капитала
  enabled: boolean;
}
const states: PS[] = [];
let lastTxMs = Date.now();

const now = () => new Date().toISOString();
const log = (m: string) => console.log(`[${now()}] ${m}`);
const _thr: Record<string, number> = {};
const logT = (key: string, m: string, ms = 30_000) => { if (Date.now() - (_thr[key] ?? 0) > ms) { _thr[key] = Date.now(); log(m); } }; // троттл-лог, чтоб не спамить
const toRaw = (h: number, dec: number) => ethers.parseUnits(h.toFixed(dec), dec);
const fromRaw = (r: bigint, dec: number) => Number(ethers.formatUnits(r, dec));
const alignTick = (st: PS, p: bigint, side: "bid" | "ask") => { const r = p % st.tickRaw; if (r === 0n) return p; return side === "bid" ? p - r : p - r + st.tickRaw; };
const alignLot = (st: PS, q: bigint) => q - (q % st.lotRaw);
const expireNs = (ms: number) => (BigInt(Date.now()) + BigInt(ms)) * NS_PER_MS;
const spreadBps = (bid: number, ask: number) => { const m = (bid + ask) / 2; return m > 0 ? ((ask - bid) / m) * 1e4 : 1e9; };
function withT<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms))]);
}

async function readBook(st: PS) {
  const [bids, asks] = await withT(Promise.all([st.pool.getBookLevels(true, 1n), st.pool.getBookLevels(false, 1n)]), 12_000, "readBook");
  const bestBid = bids.length ? fromRaw(bids[0][0], st.mkt.quoteDec) : undefined;
  const bestAsk = asks.length ? fromRaw(asks[0][0], st.mkt.quoteDec) : undefined;
  const bidQty = bids.length ? fromRaw(bids[0][1], st.mkt.baseDec) : 0;   // глубина топ-уровня: IOC не глубже неё → нет sim-ревертов
  const askQty = asks.length ? fromRaw(asks[0][1], st.mkt.baseDec) : 0;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
  return { bestBid, bestAsk, mid, bidQty, askQty };
}
// база в человеческих единицах. Для native (SOMI) вычитаем газовый резерв → газ НЕ считается инвентарём/не продаётся.
async function walletBaseHuman(st: PS): Promise<number> {
  if (st.mkt.baseIsNative) {
    const h = fromRaw(await withT(provider.getBalance(wallet.address), 10_000, "baseBal"), st.mkt.baseDec);
    return Math.max(0, h - CFG.gasReserveSOMI);
  }
  const erc = new ethers.Contract(st.baseToken, ERC20_ABI, provider);
  return fromRaw(await withT(erc.balanceOf(wallet.address), 10_000, "baseBal"), st.mkt.baseDec);
}
async function quoteHuman(st: PS): Promise<number> {
  const erc = new ethers.Contract(st.quoteToken, ERC20_ABI, provider);
  return fromRaw(await withT(erc.balanceOf(wallet.address), 10_000, "quoteBal"), st.mkt.quoteDec);
}
async function getOpenOrders(st: PS): Promise<{ id: bigint; isBid: boolean; price: number; qty: number }[]> {
  const ids: bigint[] = await withT(st.pool.getOwnOpenOrders(), 10_000, "openOrders");
  const out: { id: bigint; isBid: boolean; price: number; qty: number }[] = [];
  for (const id of ids) {
    try { const o = await withT(st.pool.getOrder(id), 8_000, "getOrder"); out.push({ id, isBid: o[1], price: fromRaw(o[4], st.mkt.quoteDec), qty: fromRaw(o[6], st.mkt.baseDec) }); }
    catch { out.push({ id, isBid: false, price: 0, qty: 0 }); }
  }
  return out;
}
async function ensureAllowance(st: PS, token: string) {
  if (token.toLowerCase() === NATIVE_SENTINEL.toLowerCase() || /^0x0+$/i.test(token)) return;
  if (st.approved.has(token.toLowerCase())) return;
  const erc = new ethers.Contract(token, ERC20_ABI, signer);
  const cur: bigint = await withT(erc.allowance(wallet.address, st.mkt.pool), 10_000, "allowance");
  if (cur < (1n << 200n)) { const tx = await erc.approve(st.mkt.pool, ethers.MaxUint256, { gasPrice: await gasPrice() }); await withT(tx.wait(1), 45_000, "approve.wait"); }  // MaxUint256 раз на токен (как exchange.ts)
  st.approved.add(token.toLowerCase());
}
// МЕЙКЕР (PostOnly) через тот же REST-путь. Возвращает on-chain orderId из события OrderPlaced (для трекинга/отмены).
async function place(st: PS, isBid: boolean, priceHuman: number, qtyHuman: number): Promise<bigint | null> {
  if (CFG.dryRun) { log(`[dry ${st.symbol}] ${isBid ? "bid" : "ask"} MAKER ${qtyHuman.toFixed(6)} @ ${priceHuman.toFixed(4)}`); return 1n; }
  const rc = await restOrder(st, isBid ? "buy" : "sell", priceHuman, qtyHuman, "postOnly");
  if (!rc) return null;
  const plog = rc.logs.find((l: any) => (l.topics?.[0] ?? "").toLowerCase() === TOPIC_ORDER_PLACED);
  return plog && plog.topics[1] ? BigInt(plog.topics[1]) : null;
}
async function cancel(st: PS, id: bigint) {
  if (CFG.dryRun) { log(`[dry ${st.symbol}] cancel ${id}`); return; }
  try { const tx = await st.pool.cancelOrder(id, { gasPrice: await gasPrice() }); await withT(tx.wait(1), 45_000, "cancel.wait"); lastTxMs = Date.now(); }
  catch { signer.reset(); }
}
async function cancelAllOpen(st: PS) {
  if (CFG.dryRun) return;
  try { const ids: bigint[] = await withT(st.pool.getOwnOpenOrders(), 10_000, "openOrders"); for (const id of ids) await cancel(st, id); if (ids.length) log(`${st.symbol}: снято открытых: ${ids.length}`); }
  catch (e) { log(`${st.symbol} cancelAllOpen err: ${(e as Error).message.slice(0, 60)}`); }
}

// ── Тик одной пары (без проверки газа — она глобальная, один раз за общий тик) ──
async function tickPair(st: PS) {
  if (!st.enabled) return;
  const { bestBid, bestAsk, mid, bidQty, askQty } = await readBook(st);
  if (bestBid === undefined || bestAsk === undefined || !mid) { return; }
  const bookBps = spreadBps(bestBid, bestAsk);
  st.lastBookBps = bookBps;   // сигнал выгодности для маршрутизации капитала в глобальном тике
  const tickH = fromRaw(st.tickRaw, st.mkt.quoteDec);
  const minClipUSD = fromRaw(st.minQtyRaw, st.mkt.baseDec) * mid;
  const clip = Math.max(pairNotional(st.symbol), minClipUSD * 1.25);     // клип ПО ПАРЕ, не ниже minQty*цена
  const dustEff = Math.max(CFG.dustUSDso, minClipUSD * 1.05);            // ниже minQty продать нельзя → «флэт», сольётся со следующим филлом

  const open = (CFG.dryRun || !CFG.makerEnabled) ? [] : await getOpenOrders(st);   // чистый чёрн: резтинга нет → экономим RPC (быстрее тик)
  const myBid = open.find(o => o.isBid);
  const myAsk = open.find(o => !o.isBid);
  const walletBase = await walletBaseHuman(st);
  let freeQuote = await quoteHuman(st);   // let: списываем локально при постановке бида → чёрн видит РЕАЛЬНЫЙ остаток (не дотиковый)
  const netBase = walletBase + (myAsk ? myAsk.qty : 0);
  const invUSDso = netBase * mid;

  if (Math.abs(netBase - st.lastNetBase) * mid > 0.3) {
    const d = (netBase - st.lastNetBase) * mid;
    st.cumVolume += Math.abs(d);
    st.lastFillMs = Date.now();   // чёрн-таймер: любой филл = мейкер живой, чёрн не нужен
    log(`FILL[${st.symbol}] ${d > 0 ? "buy" : "sell"} ~$${Math.abs(d).toFixed(1)} | инв=$${invUSDso.toFixed(2)} | объём[${st.symbol}]=$${st.cumVolume.toFixed(0)}`);
  }
  st.lastNetBase = netBase;
  if (invUSDso <= dustEff) { st.longSinceMs = 0; st.longEntryMid = 0; }   // флэт → сброс трекинга лонга

  const moved = st.lastQuoteMid > 0 ? Math.abs((mid - st.lastQuoteMid) / st.lastQuoteMid) * 1e4 : 1e9;

  if (invUSDso > dustEff) {
    // ЛОНГ. Отметка входа (для TTL/стопа мейкер-выхода).
    if (st.longSinceMs === 0) { st.longSinceMs = Date.now(); st.longEntryMid = mid; }

    // МЕЙКЕР-ВЫХОД (exitMakerTtlSec>0): выходим PostOnly-аском у касания вместо кросса спреда тейкером.
    // Цена цикла: вход бид (mid−1бп) + выход аск (mid+1бп) ≈ +2бп мейкер-мейкер, вместо −спред/2 на IOC.
    // Инвентарь живёт ≤TTL. Стопы (немедленный IOC): TTL истёк / цена против лонга > exitStopBps / стек филлов.
    if (CFG.exitMakerTtlSec > 0 && !CFG.dryRun) {
      const heldSec = (Date.now() - st.longSinceMs) / 1000;
      const advBps = st.longEntryMid > 0 ? (st.longEntryMid - mid) / st.longEntryMid * 1e4 : 0; // >0 = цена упала (против лонга)
      const forceIOC = heldSec > CFG.exitMakerTtlSec || advBps > CFG.exitStopBps || invUSDso > clip * CFG.exitMaxInvMult;
      if (!forceIOC) {
        if (myBid) { await cancel(st, myBid.id); return; }   // в лонге не бидуем — снять бид, ждать тик
        if (!myAsk) {
          const base = await walletBaseHuman(st);
          let askPrice = mid * (1 + CFG.halfSpreadBps * 1e-4);
          if (askPrice < bestBid + tickH) askPrice = bestBid + tickH;   // PostOnly не ниже касания
          if (base > 0) {
            const id = await place(st, false, askPrice, base);
            if (id !== null) logT(st.symbol + "exitAsk", `EXIT-ASK[${st.symbol}] maker-sell ${base.toFixed(6)} @ ${askPrice.toFixed(4)} (держ ${heldSec.toFixed(0)}с, спред ${bookBps.toFixed(1)}бп)`);
          }
        }
        return;   // держим аск до филла/TTL/стопа
      }
      logT(st.symbol + "exitIOC", `EXIT→IOC[${st.symbol}] ${heldSec > CFG.exitMakerTtlSec ? "TTL" : advBps > CFG.exitStopBps ? `стоп ${advBps.toFixed(1)}бп` : "стек"} (держ ${heldSec.toFixed(0)}с)`);
    }

    // ТЕЙКЕР-ФЛЭТ (дефолт / фолбэк). АНТИ-SELF-MATCH: снять ВСЕ свои ордера, ждать ОДИН тик, потом IOC-sell
    // (иначе IOC влетает в наш же ордер → реверт, завесило бота на 4ч).
    if (myBid || myAsk) { if (myBid) await cancel(st, myBid.id); if (myAsk) await cancel(st, myAsk.id); return; }
    const base = CFG.dryRun ? netBase : await walletBaseHuman(st);
    const limit = bestBid * (1 - CFG.takerSlackBps * 1e-4);   // лимит через книгу → факт исполнения ≈ bestBid
    if (base > 0) {
      const ok = await takerIOC(st, "sell", limit, base);
      if (ok) log(`FLAT[${st.symbol}] IOC-sell ${base.toFixed(6)} лимит ${limit.toFixed(4)} (инв был $${invUSDso.toFixed(1)})`);
    }
  } else if (bookBps > CFG.maxBookSpreadBps) {
    // книга шире гейта → не котируем (цена цикла ≈ спред выхода)
    if (myBid) await cancel(st, myBid.id);
    if (myAsk) await cancel(st, myAsk.id);
  } else {
    // ФЛЭТ → PostOnly-бид у касания, аск убираем
    if (myAsk) await cancel(st, myAsk.id);
    // КАПИТАЛ-ЛОКК ФИКС: застоявшийся бид (висит > maxBidAgeSec, не налился) — СНЯТЬ и ждать тик.
    // Иначе на малом свободном USDso бид запирает капитал → ни нового бида, ни чёрна → простой (тест встал 09:49).
    // Заодно держит котировку свежей у касания (лучше филлы). Возврат капитала → на след. тике встаём заново.
    if (myBid && st.lastBidMs > 0 && Date.now() - st.lastBidMs > CFG.maxBidAgeSec * 1000) {
      await cancel(st, myBid.id); st.lastBidMs = 0;
      logT(st.symbol + "staleBid", `${st.symbol}: снят застоявшийся бид (>${CFG.maxBidAgeSec}с) — освобождаю капитал`);
      return;
    }
    if (CFG.makerEnabled && freeQuote >= clip * 0.5) {   // makerEnabled=0 → мейкер-бид ВЫКЛ, ниже только чёрн (A/B: чистый чёрн)
      let bidPrice = mid * (1 - CFG.halfSpreadBps * 1e-4);
      if (bidPrice > bestAsk - tickH) bidPrice = bestAsk - tickH;
      const needRequote = !myBid || moved > CFG.requoteTriggerBps;
      if (needRequote) {
        if (myBid) await cancel(st, myBid.id);
        const qty = Math.min(clip, freeQuote * 0.9) / mid;
        const id = await place(st, true, bidPrice, qty);
        if (id !== null) { st.lastQuoteMid = mid; st.lastBidMs = Date.now(); freeQuote -= qty * mid; log(`ORDER[${st.symbol}] maker-bid ${qty.toFixed(6)} @ ${bidPrice.toFixed(4)} (спред ${bookBps.toFixed(1)}бп)`); }
      }
    }
    // ТЕЙКЕР-ЧЁРН: книга УЗКАЯ + пейс + страховка бюджета → сами кроссим спред.
    // buy IOC у аска → инвентарь → следующий тик сольёт штатным FLAT IOC-sell. Цена цикла ≈ спред (≤ гейта).
    // АДАПТИВНЫЙ пейс от спреда (#1): узко=часто, широко=редко. В adaptive idle-гейт снят (иначе чёрн-филлы душат частоту).
    const paceSec = CFG.churnAdaptive
      ? (bookBps <= 0.5 ? CFG.churnPaceMinSec : bookBps <= 1.0 ? CFG.churnPaceMinSec * 3 : CFG.churnPaceSec)
      : CFG.churnPaceSec;
    const idleOk = CFG.churnAdaptive ? true : (Date.now() - st.lastFillMs > CFG.churnAfterIdleSec * 1000);
    const paceOk = Date.now() - st.lastChurnMs > paceSec * 1000;
    // HEARTBEAT (анти-DQ): чистый чёрн без узких окон/капитала может молчать часами, а 24ч тишины = дисквал.
    // Нет НИКАКИХ tx > 40 мин → один минимальный чёрн вне гейта/пейса (~$0.001) как пульс активности.
    const heartbeat = !CFG.makerEnabled && Date.now() - lastTxMs > 40 * 60_000 && bookBps <= CFG.maxBookSpreadBps && freeQuote > minClipUSD * 2;
    if (!CFG.dryRun && ((idleOk && paceOk && bookBps <= CFG.churnMaxSpreadBps && freeQuote >= CFG.quoteFloorUSDso) || heartbeat)) {
      // размер = min(клип, глубина топ-аска, глубина ТОП-БИДА, СВОБОДНЫЙ USDso). bidQty: атомарный выход
      // тоже должен пройти у касания (не глубже) — обе стороны обязаны держать клип. freeQuote — АДАПТИВНО:
      // вторая пара с инвентарём → чёрн сам ужимается, а не ревертит «unknown custom error».
      const clipEff = heartbeat ? minClipUSD * 1.3 : clip;
      const buyQty = Math.min(clipEff / mid, askQty * CFG.churnDepthFrac, bidQty * CFG.churnDepthFrac, (freeQuote * 0.9) / mid);
      const limitBuy = bestAsk * (1 + CFG.churnSlackBps * 1e-4);
      if (buyQty * mid > dustEff) {
        // сначала снять резтинг-бид: иначе он может ТОЖЕ налиться в этот же цикл → двойная экспозиция
        // (мейкер-фил + чёрн-бай одновременно) — наблюдалось в тесте (инв скакнул до $8.70 за 1 тик).
        const fresh = CFG.makerEnabled ? await getOpenOrders(st) : [];   // без мейкера резтинга нет → экономим RPC
        const stillBid = fresh.find(o => o.isBid);
        if (stillBid) await cancel(st, stillBid.id);
        // BURST-ЧЁРН (модель t3: дельты его ног ~100мс). Первая версия «продать в том же тике» дала связку
        // 5.1с — REST-сборка sell-tx (~2-3с) сидела МЕЖДУ ногами. Теперь ОБЕ tx собираются ПАРАЛЛЕЛЬНО ДО
        // выстрела → после конфирмации buy сэлл улетает сразу (сборка уже в руках). Цель: ноги ≤1с.
        // Если сервер отказался собрать sell заранее (нет базы на момент сборки) → фолбэк: свежий баланс → sell.
        // Anti-self-match соблюдён: наш бид снят выше, асков в этой ветке нет.
        const sellLimit = bestBid * (1 - CFG.churnSlackBps * 1e-4);
        const [buyTx, sellTx] = CFG.dryRun ? [null, null] : await Promise.all([
          restBuildTx(st, "buy", limitBuy, buyQty, "immediateOrCancel"),
          restBuildTx(st, "sell", sellLimit, buyQty, "immediateOrCancel"),
        ]);
        if (CFG.dryRun) { log(`[dry ${st.symbol}] burst-чёрн buy+sell ${buyQty.toFixed(6)}`); st.lastChurnMs = Date.now(); }
        else if (buyTx) {
          // SAME-BLOCK ноги (паттерн t3, ~100мс): обе tx уходят ПОДРЯД, НЕ дожидаясь конфирмации buy —
          // нонсы последовательные, чейн исполнит по порядку в одном/соседних блоках. Фиксированный gasLimit
          // (ордер ~1.1M газа, 3M с запасом; излишек вернётся) убирает estimateGas: у sell он ревертил бы
          // до посадки buy, у buy — лишние ~200мс. Если buy не налился — sell ревертнёт (~$0.003 газа),
          // инвентарь/остаток подберёт штатный FLAT следующим тиком.
          const gp = await gasPrice();
          let s1: any = null, s2: any = null;
          try { s1 = await signer.sendTransaction({ to: buyTx.to, data: buyTx.data, value: buyTx.value ?? 0, gasPrice: gp, gasLimit: 3_000_000n }); }
          catch (e) { signer.reset(); logT(st.symbol + "chB", `${st.symbol} churn.buy НЕ отправился: ${(e as Error).message.slice(0, 50)}`); }
          if (s1 && sellTx) {
            try { s2 = await signer.sendTransaction({ to: sellTx.to, data: sellTx.data, value: sellTx.value ?? 0, gasPrice: gp, gasLimit: 3_000_000n }); }
            catch (e) { signer.reset(); logT(st.symbol + "chS", `${st.symbol} churn.sell НЕ отправился: ${(e as Error).message.slice(0, 50)}`); }
          }
          if (s1) {
            st.lastChurnMs = Date.now();
            const rc1: any = await withT(s1.wait(1), 45_000, "churn.buy.wait").catch(() => null);
            const rc2: any = s2 ? await withT(s2.wait(1), 45_000, "churn.sell.wait").catch(() => null) : null;
            lastTxMs = Date.now();
            if (rc1?.status === 1) log(`CHURN[${st.symbol}] IOC-buy ${buyQty.toFixed(6)} @~${bestAsk.toFixed(4)} (спред ${bookBps.toFixed(1)}бп${heartbeat ? ", heartbeat" : ""})`);
            if (rc2?.status === 1) log(`CHURN-FLAT[${st.symbol}] IOC-sell ${buyQty.toFixed(6)} (same-block)`);
          }
        }
      }
    }
  }
}

// ── Глобальный тик: газ 1 раз, затем пары ПОСЛЕДОВАТЕЛЬНО ────────────────────
let ticking = false, tickStart = 0;
async function tick() {
  if (ticking && Date.now() - tickStart < 120_000) return;
  ticking = true; tickStart = Date.now();
  try {
    const somi = fromRaw(await withT(provider.getBalance(wallet.address), 10_000, "gasBal"), 18);
    if (!CFG.dryRun && somi <= CFG.gasFloorSOMI) { log(`gas=${somi.toFixed(2)} <= пол ${CFG.gasFloorSOMI} — ПАУЗА (мало газа)`); return; }
    // АДАПТИВНАЯ МАРШРУТИЗАЦИЯ КАПИТАЛА: пара с более УЗКИМ спредом (дешевле цикл/чёрн = выгоднее) тикает ПЕРВОЙ →
    // на общий дефицитный USDso первой претендует выгодная пара; вторая берёт остаток (чёрн капается по freeQuote).
    const order = [...states].sort((a, b) => a.lastBookBps - b.lastBookBps);
    for (const st of order) {
      try { await tickPair(st); }
      catch (e) { log(`tick[${st.symbol}] error: ${(e as Error).message.slice(0, 90)}`); }
    }
    // сводная строка
    let totVol = 0, totInv = 0; for (const st of states) totVol += st.cumVolume;
    const freeQ = states.length ? await quoteHuman(states[0]).catch(() => NaN) : NaN;
    log(`СВОДКА gas=${somi.toFixed(2)} USDso своб=$${Number.isFinite(freeQ) ? freeQ.toFixed(1) : "?"} объём_сумма=$${totVol.toFixed(0)} пары=[${states.filter(s=>s.enabled).map(s=>s.symbol.split("/")[0]).join(",")}]`);
  } catch (e) { log(`tick error: ${(e as Error).message.slice(0, 100)}`); }
  finally { ticking = false; }
}

async function main() {
  log(`dreamDEX MULTI-MM старт | пары=${CFG.pairs.join(",")} | DRY_RUN=${CFG.dryRun} | кошелёк=${wallet.address}`);
  for (const symbol of CFG.pairs) {
    const mkt = MARKETS[symbol];
    if (!mkt) { log(`неизвестная пара ${symbol} — пропуск`); continue; }
    const pool = new ethers.Contract(mkt.pool, SPOT_ABI, signer);
    const st: PS = { symbol, mkt, pool, tickRaw: 0n, lotRaw: 0n, minQtyRaw: 0n, baseToken: "", quoteToken: "", approved: new Set(), lastQuoteMid: 0, lastNetBase: 0, cumVolume: 0, lastFillMs: Date.now(), lastChurnMs: 0, lastBidMs: 0, longSinceMs: 0, longEntryMid: 0, lastBookBps: 1e9, enabled: false };
    try {
      const pp = await withT(pool.getPoolParams(), 12_000, "poolParams");
      st.baseToken = pp[0]; st.quoteToken = pp[1]; st.tickRaw = pp[4]; st.minQtyRaw = pp[5]; st.lotRaw = pp[6];
      const book = await readBook(st);
      const minClipUSD = book.mid ? fromRaw(st.minQtyRaw, st.mkt.baseDec) * book.mid : Infinity;
      if (minClipUSD > CFG.notionalUSDso * CFG.maxClipMult) {
        log(`${symbol}: minQty*цена=$${minClipUSD.toFixed(2)} > notional*${CFG.maxClipMult} — пара ОТКЛЮЧЕНА (клип был бы слишком крупный)`);
      } else {
        st.enabled = true;
        st.lastNetBase = await walletBaseHuman(st);
      }
      log(`${symbol}: tick=${fromRaw(st.tickRaw, st.mkt.quoteDec)} lot=${fromRaw(st.lotRaw, st.mkt.baseDec)} minQty=${fromRaw(st.minQtyRaw, st.mkt.baseDec)} minClip≈$${minClipUSD.toFixed(2)} fee=${pp[2]}/${pp[3]} => ${st.enabled ? "ВКЛ" : "ВЫКЛ"}`);
    } catch (e) { log(`${symbol}: init err: ${(e as Error).message.slice(0, 80)} — пропуск`); }
    states.push(st);
  }
  const active = states.filter(s => s.enabled);
  if (!active.length) { log("нет активных пар — выход"); process.exit(1); }
  log(`конфиг: notional=$${CFG.notionalUSDso} halfSpread=${CFG.halfSpreadBps}бп skew=${CFG.inventorySkewBps}бп requoteTrig=${CFG.requoteTriggerBps}бп loop=${CFG.tickLoopMs}ms gasFloor=${CFG.gasFloorSOMI} активных пар=${active.length}`);
  for (const st of active) await cancelAllOpen(st);

  const timer = setInterval(() => { tick().catch(e => log(`tick outer: ${(e as Error).message.slice(0, 80)}`)); }, CFG.tickLoopMs);
  try { await tick(); } catch (e) { log(`первый тик: ${(e as Error).message.slice(0, 80)}`); }
  // WATCHDOG по РЕАЛЬНЫМ tx: рабочий бот с чёрном шлёт tx постоянно; НЕТ ни одной tx > maxIdleSec = завис
  // (мейкер молча не встаёт / IOC ревертит по кругу / etc). РЕСТАРТ ДЁШЕВ, СМЕРТЬ КАТАСТРОФИЧНА → рестартим.
  // (Ошибка прошлой версии: сменил на lastAliveMs=«тики живы» → бот печатал СВОДКУ вхолостую 4ч, watchdog молчал.)
  if (!CFG.dryRun) setInterval(() => { if (Date.now() - lastTxMs > CFG.maxIdleSec * 1000) { log(`WATCHDOG: нет РЕАЛЬНЫХ tx > ${CFG.maxIdleSec}с → exit(1) (рестарт un-стакивает)`); process.exit(1); } }, 30_000);

  const shutdown = async () => {
    clearInterval(timer);
    for (const st of states.filter(s => s.enabled)) {
      await cancelAllOpen(st);
      // ЖЕЛЕЗНОЕ ПРАВИЛО: не выходить с открытой позицией — иначе экспозиция висит весь простой до рестарта.
      // Ретрай в неск. попыток (тонкая книга ограничивает qty за один IOC — см. dustEff/bidQty-кап).
      for (let i = 0; i < 4; i++) {
        const base = await walletBaseHuman(st);
        if (base <= 0) break;
        const { bestBid, mid } = await readBook(st).catch(() => ({ bestBid: undefined as number | undefined, mid: undefined as number | undefined }));
        if (bestBid === undefined || !mid) break;
        if (base * mid < CFG.dustUSDso) break;
        const limit = bestBid * (1 - CFG.takerSlackBps * 1e-4);
        const ok = await takerIOC(st, "sell", limit, base);
        log(`${st.symbol} shutdown-flatten попытка ${i + 1}: ${ok ? "ok" : "не удалось"} (${base.toFixed(6)})`);
        if (!ok) break;
      }
    }
    log("остановлен, все ордера сняты, позиции сплющены");
    process.exit(0);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  const runSec = Number(process.env.RUN_SECONDS ?? 0);
  if (runSec > 0) setTimeout(shutdown, runSec * 1000);
  process.on("unhandledRejection", (e) => log(`unhandledRejection: ${String(e).slice(0, 80)}`));
  process.on("uncaughtException", (e) => log(`uncaughtException: ${String(e).slice(0, 80)}`));
}
main().catch(e => { log(`fatal: ${(e as Error).message}`); process.exit(1); });
