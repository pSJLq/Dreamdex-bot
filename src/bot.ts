import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) }); // .env из папки бота, не из cwd
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ExchangeClient, DreamDexClient, MockClient, Fill, OrderBook, Balances } from "./exchange.js";
import { Strategy, StratCtx, DesiredOrder, CapitalGrowthMaker, VolumeBooster, PickOff, GridMaker } from "./strategy.js";
import { RiskManager } from "./risk.js";
import { RegimeManager } from "./regime.js";
import { Stats, PairRow } from "./stats.js";
import { startDashboard } from "./dashboard.js";

type Config = {
  pairs: string[];
  makerPairs?: string[];
  liquidatePairs?: string[];
  gasReserveSOMI?: number;
  capitalUSDso: number;
  perPairClipUSDso: number;
  requoteMs: number;
  maxInventoryUSDso: number;
  maxDrawdownPct: number;
  gasFloorSOMI: number;
  modules: { growth: boolean; volume: boolean; pickoff: boolean; grid: boolean };
  gridLevels: number;
  gridStepBps: number;
  growthSpreadBps: number;
  growthImproveFrac?: number;
  inventorySkewBps: number;
  pickoffEdgeBps: number;
  regime: { cautionDrawdownPct: number; defensiveDrawdownPct: number; cautionClipMult: number; defensiveClipMult: number };
  pegTolerancePct: number;
  programDays: number;
  dynamicAllocation: boolean;
  dashboardPort: number;
  requoteMoveBps?: number;
  vaultDepositUSDso?: number;
  minQuoteUSDso?: number;
  oscillator?: boolean;          // храповик: тейкер пока есть запас над полом, у пола → мейкер копит
  equityFloorUSDso?: number;     // пол по балансу — защита тела
  floorHysteresisUSDso?: number; // на сколько выше пола подняться, чтобы снова включить тейкер
  flattenFirst?: boolean;
  flattenTargetUSDso?: number;
  tokens?: Record<string, string>;
  // --- HarvestMaker / маркетмейкинг у касания ---
  leadTicks?: number;            // на сколько тиков зайти внутрь спреда (0=join лучшего, 1=стать лучшим)
  makerSpreadBps?: number;       // мин. отступ котировки от мида (анти-adverse-selection; 0=у касания, >0=шире/меньше bleed)
  minEdgeBps?: number;           // мин. край vs свежий внешний фэйр (профит-гард 0/+)
  softInventoryUSDso?: number;   // выше этого инвентаря НЕ докупаем (только продаём) → тянем к нулю
  hardInventoryUSDso?: number;   // выше этого — принудительный тейкер-флэт (раскрутка застрявшего инвентаря)
  takerFlattenThrottleSec?: number; // не чаще раза в N сек на пару
  maxIdleSec?: number;           // watchdog: нет успешной tx дольше → exit(1), pm2 перезапустит (анти-DQ)
  quoteHeartbeatSec?: number;    // перекотировать пару не реже раза в N сек даже без движения цены (on-chain активность = анти-DQ)
  volumePaceSec?: number;        // ДОЗАТОР тейкера: volume-ордера не чаще раза в N сек на пару (0=выкл). Для финального буста объёма.
  takerMaxSpreadBps?: number;    // тейкер кроссит ТОЛЬКО при спреде ≤ этого (0=всегда) → дешёвый объём (цена=спред/2)
};

const cfg: Config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const DRY = process.env.DRY_RUN === "1";
const READONLY = process.env.READ_ONLY === "1"; // живой dreamDEX, но БЕЗ ордеров (только чтение цен/балансов)
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

// 24/7-ВЫЖИВАЕМОСТЬ: сетевой сбой (оборвалось соединение с API/RPC) НЕ должен убивать процесс.
// Раньше одиночный `write ECONNABORTED` от фонового запроса ethers/fetch ронял бота. Теперь — логируем и живём
// дальше: следующий тик переподключится. Реальные деньги защищены риск-стопом, а не падением процесса.
process.on("unhandledRejection", (e: any) => log(`unhandledRejection (пережили, продолжаем): ${e?.message ?? e}`));
process.on("uncaughtException", (e: any) => log(`uncaughtException (пережили, продолжаем): ${e?.message ?? e}`));

const client: ExchangeClient = DRY
  ? new MockClient(cfg.pairs, cfg.capitalUSDso)
  : new DreamDexClient({
      restUrl: process.env.DREAMDEX_REST_URL ?? "",
      wsUrl: process.env.DREAMDEX_WS_URL ?? "",
      rpc: process.env.DREAMDEX_CHAIN_RPC ?? "",
      privateKey: process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY || "",
      orderbookContract: process.env.DREAMDEX_ORDERBOOK_CONTRACT,
      tokens: cfg.tokens,
      vaultDepositUSDso: cfg.vaultDepositUSDso,
      gasReserveSOMI: cfg.gasReserveSOMI,
    });

const risk = new RiskManager({
  maxDrawdownPct: cfg.maxDrawdownPct,
  maxInventoryUSDso: cfg.maxInventoryUSDso,
  gasFloorSOMI: cfg.gasFloorSOMI,
});

const regimeMgr = new RegimeManager(cfg.regime);

const strategies: Strategy[] = [
  new CapitalGrowthMaker(cfg.modules.growth, cfg.leadTicks ?? 1, cfg.minEdgeBps ?? 2, cfg.softInventoryUSDso ?? 30, cfg.makerSpreadBps ?? 0, cfg.inventorySkewBps ?? 0),
  new VolumeBooster(cfg.modules.volume, cfg.takerMaxSpreadBps ?? 0),
  new PickOff(cfg.modules.pickoff, cfg.pickoffEdgeBps, 2),
  new GridMaker(cfg.modules.grid, cfg.gridLevels, cfg.gridStepBps, cfg.maxInventoryUSDso),
].filter(s => s.enabled);

let cumVolume = 0;
const startTime = Date.now();
let startGas = 0;
const lastMid: Record<string, number> = {};   // для перекотировки только по движению цены
const lastQuoteMs: Record<string, number> = {}; // когда последний раз ставили котировки по паре (для heartbeat-перекола)
const lastQuote: Record<string, { bid?: number; ask?: number }> = {}; // последние ВЫСТАВЛЕННЫЕ цены (чтобы не жечь газ на ту же цену)
const lastInvSnap: Record<string, number> = {}; // инвентарь на момент последней котировки (детект филла)
const lastFlatten: Record<string, number> = {}; // троттл тейкер-флэта по парам
const lastVolMs: Record<string, number> = {};   // дозатор тейкера (volume-модуль) по парам
const lastSweepMs: Record<string, number> = {}; // троттл анти-дедлок очистки висящих ордеров по парам
const flattened: Record<string, boolean> = {}; // разовая распродажа инвентаря на старте завершена?
let takerMode = !!cfg.oscillator;              // ОСЦИЛЛЯТОР: старт в тейкере (есть запас над полом); у пола → мейкер
let switching = false;                         // идёт переключение режима (не дёргаем повторно)
let belowFloorState = false;                   // под полом? (логируем только смену состояния, без спама)
let stopped = false;                           // СДАЧА: слили всё в USDso и остановили торговлю (кнопка дашборда)
const stopFile = fileURLToPath(new URL("../STOPPED", import.meta.url)); // флаг-файл сдачи: переживает рестарт pm2
const equityBuf: number[] = [];                // окно чтений equity для МЕДИАНЫ (гасит ±1-клип глюки В ОБЕ стороны)
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// ВНЕШНИЙ ФИД цены (Binance) для pickoff-арбитража: стакан dreamDEX vs реальный рынок.
const BINANCE: Record<string, string> = { "WETH/USDso": "ETHUSDT", "WBTC/USDso": "BTCUSDT", "SOMI/USDso": "SOMIUSDT" };
const fairPrice: Record<string, number> = {};
const fairTs: Record<string, number> = {};             // когда обновляли фэйр (для проверки свежести)
const basisEMA: Record<string, number> = {};           // медленный EMA базиса (mid dreamDEX − Binance) для центрирования котировок
const FAIR_FRESH_MS = 20000;                            // фэйр считаем свежим < 20с (иначе профит-гард/pickoff не используют его)
async function refreshFair() {
  if (DRY) return;   // в моке внешний фид не нужен (цены фейковые)
  for (const sym of cfg.pairs) {
    const bsym = BINANCE[sym]; if (!bsym) continue;
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);  // ТАЙМАУТ: Binance может зависнуть → тик встанет
      const r: any = await (await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${bsym}`, { signal: ac.signal })).json().finally(() => clearTimeout(t));
      if (r?.price) { fairPrice[sym] = parseFloat(r.price); fairTs[sym] = Date.now(); }
    } catch { /* нет фида/таймаут → pickoff/профит-гард на этой паре не используют фэйр (безопасно) */ }
  }
}

const stats = new Stats();
stats.dry = DRY;
startDashboard(Number(process.env.DASHBOARD_PORT) || cfg.dashboardPort || 3000, stats, flattenAndStop);
client.onFill((f: Fill) => {
  cumVolume += f.size * f.price;
  stats.recordFill({ ts: f.ts, symbol: f.symbol, side: f.side, size: f.size, price: f.price });
  log(`FILL[${f.symbol}] ${f.side} ${f.size.toFixed(4)} @ ${f.price.toFixed(2)} | объём=$${cumVolume.toFixed(0)} | ~награда=$${(cumVolume / 500000 * 25).toFixed(2)}`);
});

// ЕДИНОЕ исполнение: все ордера/отмены через одну цепочку (модель одного nonce).
let execChain: Promise<unknown> = Promise.resolve();
function exec(fn: () => Promise<void>): Promise<unknown> {
  execChain = execChain.then(fn).catch(e => log(`exec error: ${(e as Error).message}`));
  return execChain;
}

// Снимок из УЖЕ прочитанных за тик балансов/стаканов (одно чтение → цифры не расходятся).
function computeSnapshot(bals: Record<string, Balances>, books: Record<string, OrderBook>) {
  let invUSDso = 0, quote = 0, gas = 0;
  for (const sym of cfg.pairs) {
    // quoteUSDso = (кошелёк+vault — ОБЩИЕ по кошельку, одинаковы у всех пар) + reserved в ордерах ЭТОЙ пары.
    // Берём МАКС, а НЕ последнюю пару: иначе reserved пары с ордерами (WETH-buy ~$36) терялся, когда
    // последняя пара (WBTC, sell-only) без buy-ордеров → equity ложно проседала на клип → ложный пол/sell-only/«фантом $96».
    quote = Math.max(quote, bals[sym].quoteUSDso); gas = bals[sym].gasSOMI;
    invUSDso += bals[sym].baseToken * books[sym].mid;        // нетим по всем парам
  }
  return { inv: invUSDso, equity: quote + invUSDso, gas, quote };
}

async function cancelAllPairs() { for (const sym of cfg.pairs) await client.cancelAll(sym); }

// СДАЧА (кнопка дашборда / организатор пишет "Stop your bots and convert your balance to USDso"):
// остановить торговлю и слить ВЕСЬ инвентарь в USDso — WETH/WBTC тейкером + SOMI (кроме 2 на газ). Флаг в файл (переживает рестарт).
async function flattenAndStop() {
  if (stopped) { log("СДАЧА: уже остановлен"); return; }
  stopped = true; stats.halted = true;
  try { writeFileSync(stopFile, new Date().toISOString()); } catch { /* флаг не записался — неважно, stopped уже в памяти */ }
  log("🛑 СДАЧА: стоп торговли + слив всего инвентаря в USDso…");
  await exec(async () => {
    await cancelAllPairs();                                       // снять висящие → освободить инвентарь
    if (client.recoverVaults) await client.recoverVaults([]);     // всё из vault → кошелёк
  });
  // продаём базу (WETH/WBTC) в USDso тейкером, несколько проходов (IOC может частично на тонком стакане)
  for (let pass = 0; pass < 6; pass++) {
    let anySold = false;
    for (const sym of cfg.pairs) {
      try {
        const [bal, ob] = await Promise.all([client.getBalances(sym), client.getOrderBook(sym)]);
        const amt = bal.baseToken;
        if (amt * ob.mid > 1 && client.placeIOC) {
          log(`СДАЧА слив [${sym}]: продаю ${amt.toFixed(6)} (~$${(amt * ob.mid).toFixed(1)}) в рынок`);
          await exec(async () => { await client.cancelAll(sym); await client.placeIOC!(sym, "sell", ob.bid, amt); });
          anySold = true;
        }
      } catch (e) { log(`СДАЧА слив [${sym}] ошибка: ${(e as Error).message}`); }
    }
    if (!anySold) break;
    await new Promise(r => setTimeout(r, 3000));                  // дать филлам отразиться в балансе
  }
  // SOMI → USDso, оставить 2 на газ (best-effort: пара wrapped-native, может быть тонкой)
  try {
    const somiSym = "SOMI/USDso";
    if (client.getSpec?.(somiSym) && client.placeIOC) {
      const [bal, ob] = await Promise.all([client.getBalances(somiSym), client.getOrderBook(somiSym)]);
      const sellable = Math.max(0, bal.gasSOMI - 2);             // нативный SOMI − 2 на газ
      if (sellable > 1 && ob.bid > 0) {
        log(`СДАЧА слив SOMI: продаю ${sellable.toFixed(2)} SOMI (оставляю 2 на газ)`);
        await exec(async () => { await client.placeIOC!(somiSym, "sell", ob.bid, sellable); });
      }
    }
  } catch (e) { log(`СДАЧА слив SOMI (неважно, ~$2): ${(e as Error).message}`); }
  log("✅ СДАЧА ГОТОВА: торговля остановлена, инвентарь слит в USDso. Проверь баланс на дашборде/эксплорере.");
}

// ОСЦИЛЛЯТОР — переключение режимов. Тейкер фундится из КОШЕЛЬКА (vault вытаскиваем → множитель растёт,
// капитал свободен под объём). Мейкер фундится из VAULT (доливаем заново). Снимаем висящие ордера при смене.
async function switchToTaker() {
  switching = true;
  await exec(async () => {
    await cancelAllPairs();
    if (client.recoverVaults) await client.recoverVaults([]);        // весь vault → кошелёк (под тейкер + множитель)
  });
  switching = false;
}
async function switchToMaker() {
  switching = true;
  await exec(async () => {
    await cancelAllPairs();
    if (client.resetVaultFunding) client.resetVaultFunding();        // разрешаем заново долить vault (adaptive сделает на мейкер-ордерах)
  });
  switching = false;
}

async function tick() {
  if (risk.halted || stopped) return;
  await refreshFair();   // обновляем внешний фэйр для pickoff
  // ОДНО чтение балансов+стаканов за тик (все цифры из одного источника → не расходятся)
  const books: Record<string, OrderBook> = {};
  const bals: Record<string, Balances> = {};
  for (const sym of cfg.pairs) {
    const [bal, ob] = await Promise.all([client.getBalances(sym), client.getOrderBook(sym)]);
    bals[sym] = bal; books[sym] = ob;
  }
  const g = computeSnapshot(bals, books);
  // ── НАДЁЖНОЕ EQUITY = МЕДИАНА ОКНА ЧТЕНИЙ ────────────────────────────────────
  // API отдаёт карманы (кошелёк/vault/ордера) НЕ атомарно → отдельные тики промахиваются на ±1 клип
  // и ВНИЗ (карман ордера ещё не посчитан), и ВВЕРХ (база на миг видна и в кошельке, И в ордере = задвоилась).
  // МЕДИАНА окна выкидывает оба типа выбросов (они в меньшинстве) и держит истинный центр; реальный плавный
  // сдвиг медиана отслеживает. НЕ латчим экстремум (прошлая версия латчила максимум → переучёт до $150).
  // Глюк не может ни остановить бота, ни исказить множитель; реальную защиту тела даёт ПОЛ + ЛИМИТ ИНВЕНТАРЯ.
  equityBuf.push(g.equity);
  if (equityBuf.length > 9) equityBuf.shift();
  const equitySmooth = median(equityBuf);   // ВСЕ решения (риск/режим/пол/дашборд) на медиане
  const r = risk.assess(equitySmooth, g.gas);
  if (!r.ok) {
    log(`RISK STOP: ${r.reason} | equity=$${equitySmooth.toFixed(1)} inv=$${g.inv.toFixed(1)}`);
    if (risk.halted) await exec(cancelAllPairs);
    return;
  }
  // PEG-GUARD: на реале сюда подаём цену USDso из фида; в моке = 1.0.
  const usdsoUsd = 1.0; // TODO день старта: реальный USDso/USD (Frax PoR / пул USDso-USDC)
  if (!risk.pegGuard(usdsoUsd, cfg.pegTolerancePct)) { log(`PEG STOP: USDso депег ${usdsoUsd}`); await exec(cancelAllPairs); return; }

  // Газ контролируется ЖЁСТКИМ полом в risk.assess (gas <= gasFloorSOMI → пауза).
  // Rate-пейсинг убран: на паре SOMI/USDso нативный SOMI = и газ, и базовый актив,
  // поэтому торговля «качала» чтение газа и ложно тормозила бота.

  // АДАПТИВНЫЙ РЕЖИМ: при просадке капитала глушим объёмный модуль, оставляем зарабатывающие.
  const ddPct = risk.startEquity ? (1 - equitySmooth / risk.startEquity) * 100 : 0;
  const regime = regimeMgr.update(ddPct);
  const active = new Set(regimeMgr.activeModules());   // копия — мутируем под осциллятор, не трогая regimeMgr
  // ОСЦИЛЛЯТОР ПОЛА (храповик): тейкер пока есть запас над полом; коснулись пола → мейкер копит обратно;
  // отросли на +гистерезис → снова тейкер. Тело защищено полом, заработок сверху сливаем в объём. По кругу.
  if (cfg.oscillator && !switching) {
    const floor = cfg.equityFloorUSDso ?? 0;
    const hyst = cfg.floorHysteresisUSDso ?? 1;
    if (takerMode && equitySmooth <= floor) {
      takerMode = false; log(`🛡 ПОЛ $${floor}: equity=$${equitySmooth.toFixed(1)} → МЕЙКЕР (копим обратно, тело под защитой)`);
      await switchToMaker();
    } else if (!takerMode && equitySmooth >= floor + hyst) {
      takerMode = true; log(`🚀 +$${hyst} над полом: equity=$${equitySmooth.toFixed(1)} → ТЕЙКЕР (гоним объём)`);
      await switchToTaker();
    }
  }
  if (cfg.oscillator) {
    if (takerMode) { active.delete("growth"); active.delete("grid"); active.add("volume"); }
    else { active.delete("volume"); active.add("growth"); }
  }
  const clipTotal = cfg.perPairClipUSDso * cfg.pairs.length * regimeMgr.clipMult();
  // ПОЛ-ЗАЩИТА ТЕЛА (работает и без осциллятора): equity ниже пола → НЕ покупаем (не наращиваем инвентарь),
  // мейкер только продаёт инвентарь обратно в USDso → тело поднимается к полу. Не форсит дамп, просто бережёт.
  const belowFloor = (cfg.equityFloorUSDso ?? 0) > 0 && equitySmooth < (cfg.equityFloorUSDso ?? 0);
  if (belowFloor !== belowFloorState) {   // логируем ТОЛЬКО смену состояния (без спама каждый тик)
    belowFloorState = belowFloor;
    log(belowFloor
      ? `🛡 ниже пола $${cfg.equityFloorUSDso} (equity=$${equitySmooth.toFixed(1)}) → защита: только распродажа в USDso, покупки стоп`
      : `✅ выше пола $${cfg.equityFloorUSDso} (equity=$${equitySmooth.toFixed(1)}) → обычная торговля`);
  }

  // #2 ДИНАМО-АЛЛОКАЦИЯ: больше клипа на пары с уже спредом (дешевле гнать объём).
  const weights: Record<string, number> = {};
  let sumW = 0;
  for (const sym of cfg.pairs) {
    const ob = books[sym];
    const spread = (ob.ask - ob.bid) / ob.mid;
    const w = cfg.dynamicAllocation ? 1 / Math.max(spread, 1e-6) : 1;
    weights[sym] = w; sumW += w;
  }

  const pairRows: PairRow[] = [];
  for (const sym of cfg.pairs) {
    const ob = books[sym];
    const bal = bals[sym];
    const clip = clipTotal * (weights[sym] / sumW);
    const invUSDsoPair = bal.baseToken * ob.mid;
    // USDso-ПОЛ: покупаем только на сумму ВЫШЕ пола → USDso (кошелёк+vault) не падает ниже minQuoteUSDso
    const floorShare = (cfg.minQuoteUSDso ?? 0) / cfg.pairs.length;
    let buyable = Math.max(0, bal.quoteUSDso / cfg.pairs.length - floorShare);
    // ФАЗА РАСПРОДАЖИ (разово на старте): пока инвентарь > цели — НЕ покупаем, только продаём в USDso
    if (cfg.flattenFirst && !flattened[sym]) {
      if (invUSDsoPair > (cfg.flattenTargetUSDso ?? 8)) buyable = 0;
      else { flattened[sym] = true; log(`[${sym}] инвентарь распродан (≈$${invUSDsoPair.toFixed(1)}) → старт двустороннего мейкинга`); }
    }
    if ((cfg.liquidatePairs ?? []).includes(sym)) buyable = 0;   // ликвидация: только продаём (без новых покупок → без дрейфа)
    if (belowFloor) buyable = 0;                                 // защита тела: ниже пола не докупаем, только распродаём в USDso
    const vaultBaseUSDso = (bal.baseVault ?? bal.baseToken) * ob.mid;   // база в vault/ордерах (для совместимости; мейкер теперь wallet-funded)
    const spec = client.getSpec?.(sym);
    const binFair = fairPrice[sym];
    const fresh = (Date.now() - (fairTs[sym] ?? 0)) < FAIR_FRESH_MS && binFair > 0;
    // ЦЕНТР для мейкера = Binance + МЕДЛЕННЫЙ EMA базиса (структурный сдвиг dreamDEX от Binance).
    // Так центр движется С Binance мгновенно (анти-stale-пикофф), но держит правильный уровень dreamDEX.
    let centerFair: number | undefined;
    if (fresh) {
      const basis = ob.mid - binFair;
      basisEMA[sym] = basisEMA[sym] === undefined ? basis : basisEMA[sym] * 0.8 + basis * 0.2;  // быстрее сходится на dreamDEX-мид → обе стороны у касания (ловим обе стороны потока)
      centerFair = binFair + basisEMA[sym];
    }
    const fairFresh = fresh && centerFair !== undefined;
    const ctx: StratCtx = { symbol: sym, ob, invUSDso: invUSDsoPair, quoteUSDso: buyable, clipUSDso: clip, fair: centerFair ?? binFair, vaultBaseUSDso, tick: spec?.tick, fairFresh };
    let proposed: DesiredOrder[] = [];
    const isMakerPair = (cfg.makerPairs ?? cfg.pairs).includes(sym);   // мейкер только где vault рабочий (WETH)
    for (const s of strategies) if (active.has(s.name)) {
      if (cfg.oscillator) {
        // осциллятор: режим один на ВСЕ пары (тейкер ИЛИ мейкер) — гейт уже сделан через active
        if (takerMode && (s.name === "growth" || s.name === "grid")) continue;
        if (!takerMode && s.name === "volume") continue;
      } else {
        if ((s.name === "growth" || s.name === "grid") && !isMakerPair) continue;  // мейкер только на makerPairs
        if (s.name === "volume" && isMakerPair) continue;                          // тейкер-churn НЕ на makerPairs (иначе self-match с нашим мейкером)
      }
      proposed.push(...s.propose(ctx));
    }
    proposed = risk.filter(proposed, g.inv);          // вето уровня кошелька
    // ДОЗАТОР ТЕЙКЕРА (финальный буст объёма): пропускаем volume-ордера не чаще раза в volumePaceSec на пару
    // → ровно раскладываем объём во времени, не сжигаем газ/капитал залпом. volumePaceSec=0 → выключено (обычный режим).
    if ((cfg.volumePaceSec ?? 0) > 0 && proposed.some(o => o.tag === "volume")) {
      if (Date.now() - (lastVolMs[sym] ?? 0) < (cfg.volumePaceSec ?? 0) * 1000) proposed = proposed.filter(o => o.tag !== "volume");
      else lastVolMs[sym] = Date.now();
    }
    // ПРИНУДИТЕЛЬНЫЙ ТЕЙКЕР-ФЛЭТ: инвентарь застрял выше hard-порога (мейкер не разгрузил — нет встречного тейка).
    // Бьём бид IOC → гарантированно уменьшаем инвентарь, освобождаем USDso, держим on-chain активность (анти-DQ). Троттл.
    const hardInv = cfg.hardInventoryUSDso ?? Infinity;
    const canFlatten = !READONLY && !!client.placeIOC && invUSDsoPair > hardInv && !belowFloor
      && (Date.now() - (lastFlatten[sym] ?? 0) > (cfg.takerFlattenThrottleSec ?? 30) * 1000);
    const isTaker = proposed.some(o => !o.postOnly);
    // ГАЗ-ЭФФЕКТИВНОСТЬ: перекотировка ТОЛЬКО когда есть смысл. Иначе ордера ПРОСТО ВИСЯТ и исполняются
    // (филл = чужой тейкер платит газ, нам бесплатно). НЕ жжём газ на переустановку той же цены каждый тик.
    // Триггеры: (1) наша цена сместилась > requoteMoveBps (туда уехало касание → надо догнать); (2) набор
    // сторон поменялся (overLong↔двусторонний); (3) прошёл филл (изменился инвентарь); (4) heartbeat (анти-DQ).
    const desiredBid = proposed.find(o => o.side === "buy" && o.postOnly)?.price;
    const desiredAsk = proposed.find(o => o.side === "sell" && o.postOnly)?.price;
    const lq = lastQuote[sym];
    const thresh = ob.mid * (cfg.requoteMoveBps ?? 4) * 1e-4;                 // насколько цена должна уехать, чтобы переколоть
    const sideGone = (d?: number, l?: number) => (d === undefined) !== (l === undefined);
    const moved1 = (d?: number, l?: number) => d !== undefined && l !== undefined && Math.abs(d - l) >= thresh;
    const priceChanged = !lq || sideGone(desiredBid, lq.bid) || sideGone(desiredAsk, lq.ask) || moved1(desiredBid, lq.bid) || moved1(desiredAsk, lq.ask);
    const invChanged = lastInvSnap[sym] === undefined || Math.abs(invUSDsoPair - lastInvSnap[sym]) > Math.max(3, clip * 0.3); // ~детект филла (выше шума чтения)
    const quoteStale = Date.now() - (lastQuoteMs[sym] ?? 0) > (cfg.quoteHeartbeatSec ?? 300) * 1000;
    const needRequote = priceChanged || invChanged || quoteStale;
    if (canFlatten) {
      lastFlatten[sym] = Date.now();
      const reduceUSD = Math.min(invUSDsoPair - (cfg.softInventoryUSDso ?? 30), clip);
      const sz = reduceUSD / ob.mid;
      if (sz > 0) {
        log(`⚖ тейкер-флэт [${sym}]: инвентарь $${invUSDsoPair.toFixed(1)} > $${hardInv} → продаю ~$${reduceUSD.toFixed(0)} в рынок`);
        lastQuote[sym] = {}; lastInvSnap[sym] = invUSDsoPair; lastQuoteMs[sym] = Date.now();
        await exec(async () => { await client.cancelAll(sym); await client.placeIOC!(sym, "sell", ob.bid, sz); });
      }
    } else if (!READONLY && proposed.length && (isTaker || needRequote)) {
      lastQuote[sym] = { bid: desiredBid, ask: desiredAsk };
      lastInvSnap[sym] = invUSDsoPair;
      lastQuoteMs[sym] = Date.now();
      await exec(async () => {
        await client.cancelAll(sym);   // ВСЕГДА снимаем висящие (и тейкер мог зависнуть) → освобождаем баланс, иначе ERC20InsufficientBalance
        for (const o of proposed) {
          // Тейкер-ордер — ТОЛЬКО IOC: исполнился сразу или отменён биржей, висеть НЕ может.
          // normalOrder (GTC) при убежавшей цене повисал в стакане и ЗАПИРАЛ баланс (дедлок 2 июля: $76 в 2 buy-ордерах).
          if (!o.postOnly && client.placeIOC) await client.placeIOC(o.symbol, o.side, o.price, o.size);
          else await client.placeLimit(o.symbol, o.side, o.price, o.size, o.postOnly);
        }
      });
    } else if (!READONLY && !proposed.length && Date.now() - (lastSweepMs[sym] ?? 0) > 90_000) {
      // АНТИ-ДЕДЛОК: предлагать нечего — чаще всего потому, что баланс заперт в зависших ордерах,
      // а ветка с cancelAll выше срабатывает только при наличии новых ордеров → замкнутый круг.
      // Раз в 90с снимаем висящие: опрос open-ордеров бесплатный (REST), транзакции — только если есть что снимать.
      lastSweepMs[sym] = Date.now();
      await exec(() => client.cancelAll(sym));
    }
    pairRows.push({ symbol: sym, mid: ob.mid, spreadBps: (ob.ask - ob.bid) / ob.mid * 1e4, allocPct: weights[sym] / sumW * 100, invUSDso: bal.baseToken * ob.mid });
  }
  // обновляем дашборд
  const running = strategies.filter(s => active.has(s.name)).map(s => s.name); // реально работающие модули
  stats.regime = regime; stats.equity = equitySmooth; stats.startEquity = risk.startEquity; stats.ddPct = ddPct;
  stats.inv = g.inv; stats.gas = g.gas; stats.halted = risk.halted; stats.activeModules = running;  // сырой инвентарь (≥0, без глюка отрицательного)
  stats.quoteUSDso = g.quote; stats.minQuoteUSDso = cfg.minQuoteUSDso ?? 0;
  stats.pairs = pairRows; stats.cumVolume = cumVolume;
  stats.recordTick({ ts: Date.now(), equity: equitySmooth, ddPct, regime, inv: g.inv, gas: g.gas });

  const alloc = cfg.pairs.map(s => `${s.split("/")[0]}:${(weights[s] / sumW * 100).toFixed(0)}%`).join(" ");
  log(`equity=$${equitySmooth.toFixed(1)} dd=${ddPct.toFixed(2)}% режим=${regime} clip×${regimeMgr.clipMult()} inv=$${g.inv.toFixed(1)} gas=${g.gas.toFixed(2)} аллок[${alloc}] актив=${running.join("+")}`);
}

async function shutdown(timer: ReturnType<typeof setInterval>) {
  clearInterval(timer);
  await exec(cancelAllPairs);
  log(`Остановлен. Итоговый объём=$${cumVolume.toFixed(0)} | ~награда=$${(cumVolume / 500000 * 25).toFixed(2)}`);
  process.exit(0);
}

async function main() {
  log(`dreamDEX volume bot старт (DRY=${DRY}${READONLY ? ", READ-ONLY" : ""}) | пары: ${cfg.pairs.join(", ")} | модули: ${strategies.map(s => s.name).join("+")}`);
  if (!DRY && existsSync(stopFile)) { stopped = true; stats.halted = true; log("🛑 Найден файл STOPPED → СДАЧА-режим: торговля НЕ запускается (удали файл STOPPED + рестарт, чтобы возобновить)."); }
  await client.connect();
  // На старте выводим застрявшие vault'ы в кошелёк (vault = минус-PnL). Мейкер-парам vault оставляем.
  if (!DRY && !READONLY && client.recoverVaults) {
    // МЕЙКЕР ТЕПЕРЬ WALLET-FUNDED → vault не нужен вообще. Вытаскиваем ВСЁ из vault в кошелёк (keep=[]),
    // чтобы капитал работал в wallet-funded ордерах, а не лежал в vault (где лидерборд его не считает).
    log(`вывожу всё из vault'ов в кошелёк (мейкер wallet-funded, vault не нужен)…`);
    await client.recoverVaults([]);
  }
  const timer = setInterval(() => { tick().catch(e => log(`tick error: ${(e as Error).message}`)); }, cfg.requoteMs);
  // WATCHDOG (анти-DQ): правило ивента — нет on-chain активности 24ч = дисквал. Если бот «замёрз» (нет ни одной
  // успешной транзы дольше maxIdleSec) — выходим с кодом 1, и pm2 (autorestart) поднимет свежий процесс
  // (заново auth/markets/recoverVaults — это обычно расшивает залипший стейт ордеров). По умолчанию 20 мин.
  if (!DRY && !READONLY) {
    const maxIdleMs = (cfg.maxIdleSec ?? 1200) * 1000;
    setInterval(() => {
      if (risk.halted || stopped) return;                        // намеренный стоп/сдача — не перезапускаем
      const last = (client as any).lastTxMs ?? 0;
      const idle = Date.now() - (last || startTime);             // если tx ещё не было — считаем от старта
      if (idle > maxIdleMs) {
        log(`WATCHDOG: нет успешных tx ${Math.floor(idle / 1000)}с (> ${cfg.maxIdleSec ?? 1200}с) → exit(1), pm2 перезапустит`);
        process.exit(1);
      }
    }, 60000);
  }
  process.on("SIGINT", () => shutdown(timer));
  const runSeconds = Number(process.env.RUN_SECONDS ?? 0);
  if (runSeconds > 0) setTimeout(() => shutdown(timer), runSeconds * 1000);
}
main().catch(e => { log(`fatal: ${(e as Error).message}`); process.exit(1); });
