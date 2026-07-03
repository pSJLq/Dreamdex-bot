// Слой подключения. Стратегия/риск зависят ТОЛЬКО от интерфейса ExchangeClient,
// поэтому реального dreamDEX-клиента впишем в день старта, не трогая логику.
// MockClient (мультипара) даёт запустить бота уже сейчас на симулированных ценах.

export type Side = "buy" | "sell";

// ТАЙМАУТЫ на сеть: связь иногда «повисает» (соединение открыто, ответа нет, ошибки нет) → запрос
// без таймаута зависает НАВСЕГДА → тик встаёт → бот замерзает. Эти обёртки рвут зависший вызов.
async function fetchT(url: string, opts: any = {}, ms = 12000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
function withT<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms))]);
}

export interface OrderBook { symbol: string; bid: number; ask: number; mid: number; ts: number; }
export interface Fill { symbol: string; side: Side; price: number; size: number; orderId: string; ts: number; }
export interface Balances { quoteUSDso: number; baseToken: number; gasSOMI: number; baseWallet?: number; baseVault?: number; }
export interface PlacedOrder { id: string; }

export interface MarketSpec { tick: number; lot: number; minQty: number; }

export interface ExchangeClient {
  connect(): Promise<void>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  getBalances(symbol: string): Promise<Balances>;   // baseToken — для ЭТОЙ пары; quote/gas — общие по кошельку
  placeLimit(symbol: string, side: Side, price: number, size: number, postOnly: boolean): Promise<PlacedOrder>;
  cancelAll(symbol: string): Promise<void>;
  onFill(cb: (f: Fill) => void): void;
  lastTxMs?: number;                                 // время последней УСПЕШНОЙ on-chain транзы (для watchdog анти-DQ)
  getSpec?(symbol: string): MarketSpec | undefined;  // tick/lot/minQty рынка (из /markets) — нужно мейкеру для котировки у касания
  placeIOC?(symbol: string, side: Side, price: number, size: number): Promise<PlacedOrder>;  // тейкер immediate-or-cancel (флэт инвентаря)
  recoverVaults?(keep?: string[]): Promise<void>;    // вытащить USDso из vault'ов (кроме keep-пар) в кошелёк
  resetVaultFunding?(): void;                         // сбросить флаги «vault профинансирован» (при переключении режима)
  depositBaseToVault?(symbol: string, amount: number): Promise<void>;  // база из кошелька → vault (чтобы мейкер мог её продать)
}

// ---------------------------------------------------------------------------
// РЕАЛЬНЫЙ dreamDEX-адаптер — ЗАПОЛНИТЬ в день старта.
// Доки: CCXT (TS/JS) + REST + WebSocket + Solidity-контракт ордербука.
// ВАЖНО: один кошелёк = один nonce → все ордера/отмены идут ЧЕРЕЗ ОДНУ очередь
// (оркестратор это уже сериализует), а здесь — единый signer/менеджер nonce.
// ---------------------------------------------------------------------------
// РЕАЛЬНЫЙ адаптер, написан ПО ДОКАМ (api.dreamdex.io/v0). Авторизация SIWE→JWT;
// рынки/адреса из GET /v0/markets; стакан GET /v0/orderbooks; ордер POST /v0/markets/{sym}/orders
// → отдаёт НЕподписанную транзу → подписываем кошельком и шлём; филлы ловим on-chain (OrderFilled).
// НАПИСАНО ПО СПЕКЕ, НЕ обкатано против живого API — проверка на тестнете в день старта.
// Остаточные VERIFY: точный формат SIWE-сообщения, путь списка открытых ордеров, кодировка OrderId.
// ethers грузится лениво → DRY-режим (мок) его не требует.
export class DreamDexClient implements ExchangeClient {
  private fillCbs: ((f: Fill) => void)[] = [];
  private signer: any; private provider: any; private ethers: any;
  public lastTxMs = 0;                                   // время последней успешной on-chain транзы (watchdog)
  private emptyLogTs: Record<string, number> = {};       // троттл логов «пустая tx» (раз в минуту на пару+сторону)
  private authing: Promise<void> | null = null;          // идёт переавторизация (один перелогин на все запросы, словившие 401)
  private reauthLogged = 0;                               // троттл лога переавторизации
  private token = "";
  private markets: Record<string, any> = {};            // ключ = API-символ "BASE:QUOTE"
  private myOrders: Record<string, { symbol: string; side: Side }> = {};
  private approved: Record<string, boolean> = {};
  private vaulted: Record<string, boolean> = {};
  private vaultTry: Record<string, number> = {};        // троттл попыток долить vault (раз в N сек)
  private lastBalances: Record<string, Balances> = {};  // кеш последнего УСПЕШНОГО чтения (REST упал → не теряем vault)
  private lastBook: Record<string, { ob: OrderBook; ts: number }> = {};  // кеш стакана (кривой формат под нагрузкой → берём последний хороший)
  private restFailLogged = false;
  private bookFailLogged = false;
  private obLogged = false;
  private balLogged = false;
  private ordLogged = false;
  private depLogged = false;
  private placeLoggedSyms = new Set<string>();
  private base: string; private chainId: number;

  constructor(private cfg: { restUrl?: string; wsUrl?: string; rpc: string; privateKey: string; orderbookContract?: string; tokens?: Record<string, string>; vaultDepositUSDso?: number; gasReserveSOMI?: number; }) {
    this.base = cfg.restUrl || "https://api.dreamdex.io/v0";
    this.chainId = this.base.includes("stg") ? 50312 : 5031;   // testnet : mainnet
  }

  private apiSym(s: string) { return s.replace("/", ":"); }    // бот "SOMI/USDso" → API "SOMI:USDso"
  private headers() { return { "content-type": "application/json", authorization: `Bearer ${this.token}` }; }

  // ОДНА переавторизация на всех: если несколько запросов разом словили 401, перелогиниваемся единожды.
  private async ensureAuth(): Promise<void> {
    if (!this.authing) this.authing = this.auth().finally(() => { this.authing = null; });
    return this.authing;
  }
  // Приватный запрос с авто-перелогином: JWT протух (401) → SIWE заново → один повтор. Возвращает распарсенный JSON.
  private async authedJson(url: string, opts: any = {}, ms = 12000): Promise<any> {
    const run = () => fetchT(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}), authorization: `Bearer ${this.token}` } }, ms);
    let r = await run();
    if (r.status === 401) {                               // токен протух → перелогин и один повтор
      if (Date.now() - this.reauthLogged > 60000) { this.reauthLogged = Date.now(); console.log("[dreamdex] 401 → переавторизация SIWE…"); }
      await this.ensureAuth();
      r = await run();
    }
    return r.json();
  }
  private async send(tx: any) {
    // ЕДИНЫЙ предохранитель: пустая/битая транза (data "" или "0x") = гарантированный реверт + сожжённый газ
    // (≈1.08M gas за штуку). Бывает когда API на cancel/withdraw отдаёт «нечего делать» с пустым data.
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";
    if (!tx?.to || !okData) { return ""; }
    const s: any = await withT(this.signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0 }), 30000, "sendTx");
    await withT(s.wait(), 60000, "txWait");
    this.lastTxMs = Date.now();                              // успешная транза → сбрасываем watchdog простоя
    return s.hash;   // транза может «зависнуть» в ожидании майнинга → таймаут
  }

  // tick/lot/minQty рынка из /markets — мейкеру нужно, чтобы котировать точно у касания (и не кроссить).
  getSpec(symbol: string): MarketSpec | undefined {
    const m = this.markets[this.apiSym(symbol)];
    if (!m) return undefined;
    return { tick: parseFloat(m.tickSize ?? "0"), lot: parseFloat(m.lotSize ?? "0"), minQty: parseFloat(m.minQuantity ?? "0") };
  }

  async connect(): Promise<void> {
    const { ethers } = await import("ethers"); this.ethers = ethers;
    this.provider = new ethers.JsonRpcProvider(this.cfg.rpc || "https://api.infra.mainnet.somnia.network/");
    this.signer = new ethers.Wallet(this.cfg.privateKey, this.provider);
    await this.auth();
    await this.loadMarkets();
    this.watchFills();
    console.log(`[dreamdex] ${await this.signer.getAddress()} | сеть ${this.chainId} | рынков: ${Object.keys(this.markets).length}`);
  }

  // SIWE: nonce → подпись → JWT bearer
  private async auth(): Promise<void> {
    const addr = await this.signer.getAddress();
    const { nonce } = await (await fetchT(`${this.base}/auth/nonce`)).json();
    const domain = new URL(this.base).host;
    const msg = [
      `${domain} wants you to sign in with your Ethereum account:`, addr, "",
      "Sign in to dreamDEX", "",
      `URI: https://${domain}`, "Version: 1", `Chain ID: ${this.chainId}`,
      `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const signature = await this.signer.signMessage(msg);
    const r: any = await (await fetchT(`${this.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg, signature }) })).json();
    this.token = r.token;
    // >>> VERIFY: формат SIWE-сообщения должен точно совпасть с ожиданием сервера. <<<
  }

  private async loadMarkets(): Promise<void> {
    const d: any = await (await fetchT(`${this.base}/markets`)).json();
    for (const m of d.markets) this.markets[m.symbol] = m;
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    const sym = this.apiSym(symbol);
    const d: any = await (await fetchT(`${this.base}/orderbooks?symbols=${encodeURIComponent(sym)}&depth=1`)).json();
    if (!this.obLogged) { this.obLogged = true; console.log("[dreamdex] orderbook raw:", JSON.stringify(d).slice(0, 500)); }
    const ob = Array.isArray(d) ? d[0] : (d.orderbooks?.[0] ?? d[sym] ?? d.orderbook ?? d);
    const px = (x: any) => Array.isArray(x) ? +x[0] : +(x?.price ?? x?.px ?? x?.p); // уровень: [price,size] ИЛИ {price}
    const bid = px(ob?.bids?.[0]); const ask = px(ob?.asks?.[0]);
    if (!isFinite(bid) || !isFinite(ask)) {
      // под нагрузкой/в крэше API иногда отдаёт пустой/кривой стакан → НЕ роняем тик, берём последний хороший (если свежий <60с)
      const c = this.lastBook[symbol];
      if (c && Date.now() - c.ts < 60000) {
        if (!this.bookFailLogged) { this.bookFailLogged = true; console.log(`[dreamdex] стакан ${symbol} кривой → беру последний хороший (не роняю тик)`); }
        return c.ob;
      }
      throw new Error("стакан: не распознал формат уровней (см. raw выше)");
    }
    const book = { symbol, bid, ask, mid: (bid + ask) / 2, ts: Date.now() };
    this.lastBook[symbol] = { ob: book, ts: book.ts };
    return book;
  }

  async getBalances(symbol: string): Promise<Balances> {
    const ethers = this.ethers; const addr = await this.signer.getAddress();
    const native = Number(ethers.formatEther(await withT(this.provider.getBalance(addr), 12000, "getBalance"))); // нативный SOMI = газ
    // ОСНОВНОЙ источник — REST /wallets/{addr}/balance (wallet+vault, читает wSOMI, без RPC-глюков)
    try {
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const markets = r.markets || [];
      const mk = markets.find((x: any) => x.symbol === this.apiSym(symbol));
      if (mk) {
        if (!this.balLogged) { this.balLogged = true; console.log(`[dreamdex] balance raw: ${JSON.stringify(mk)}`); }
        const num = (v: any) => v == null ? 0 : parseFloat(v ?? 0);
        // USDso = кошелёк (общий) + ВСЕ vault'ы по ВСЕМ рынкам (деньги в любом vault — наши;
        // иначе при мультипаре теряем vault другой пары → ложная просадка → ложный стоп).
        const walletQuote = num(mk.quote?.wallet);
        let vaultQuote = 0;
        for (const m of markets) vaultQuote += num(m.quote?.vault);
        const baseWalletVault = num(mk.base?.wallet) + num(mk.base?.vault);   // base — токен ЭТОЙ пары
        const res = await this.getReserved(symbol);                          // деньги в висящих ордерах ЭТОЙ пары
        let baseToken = baseWalletVault + res.base;
        let baseWallet = num(mk.base?.wallet);   // база В КОШЕЛЬКЕ: мейкер из vault её НЕ продаёт → сбрасываем тейкером
        // SOMI: база = wrapped-native, но мы держим НАТИВНЫЙ SOMI. Считаем его СВЕРХ газ-резерва как продаваемый
        // инвентарь → бот сам конвертнёт застрявший SOMI обратно в USDso (продажа SOMI шлёт нативный msg.value).
        // Резерв (gasReserveSOMI) НЕ продаётся: baseToken ≤ native−резерв → нативный SOMI всегда ≥ резерва.
        const mkt = this.markets[this.apiSym(symbol)];
        if (mkt && (mkt.base ?? "").toLowerCase() === "0x28f34defd2b4cb48d9ee6d89f2be4bc601694c00") {
          baseToken = Math.max(0, native - (this.cfg.gasReserveSOMI ?? 50));
          baseWallet = 0;   // SOMI = нативный, своя логика, тейкер-сброс не нужен
        }
        // baseVault = база, которую МЕЙКЕР может продать (в vault + в наших висящих ордерах; кошелёк-часть НЕ продаётся мейкером)
        const result = { quoteUSDso: walletQuote + vaultQuote + res.quote, baseToken, baseWallet, baseVault: Math.max(0, baseToken - baseWallet), gasSOMI: native };
        this.lastBalances[symbol] = result;            // запомнили хорошее чтение (с vault)
        return result;
      }
    } catch { /* падаем ниже: сперва кеш, потом on-chain */ }
    // REST не ответил → берём ПОСЛЕДНИЙ ХОРОШИЙ баланс (с vault!), только газ обновляем.
    // Иначе свалились бы в on-chain wallet-only → потеряли бы vault → ФАНТОМНАЯ просадка → ложный пробой пола.
    if (this.lastBalances[symbol]) {
      if (!this.restFailLogged) { this.restFailLogged = true; console.log(`[dreamdex] REST баланс не ответил → беру кеш (vault сохраняем, не ложная просадка)`); }
      return { ...this.lastBalances[symbol], gasSOMI: native };
    }
    // ЗАПАСНОЙ on-chain (только если кеша ещё нет — самый первый тик; vault на старте ≈0, не критично)
    const m = this.markets[this.apiSym(symbol)];
    const erc20 = ["function balanceOf(address) view returns (uint256)"];
    const isNative = (t?: string) => !t || /^0x0+$/i.test(t);
    const bal = async (token: string, dec: number) => {
      if (isNative(token)) return native;
      try { return Number(ethers.formatUnits(await new ethers.Contract(token, erc20, this.provider).balanceOf(addr), dec)); }
      catch { return 0; }
    };
    const quoteUSDso = m ? await bal(m.quote, m.quoteDecimals) : 0;
    const baseToken = m ? await bal(m.base, m.baseDecimals) : 0;
    return { quoteUSDso, baseToken, gasSOMI: native };
  }

  // 3-й карман: USDso/база, ЗАЛОЧЕННЫЕ в висящих ордерах. REST wallet/vault их не показывает
  // как доступные → без этого equity ложно «проседает» и срабатывает стоп.
  // КЭШ: при сбое/ошибке API (timeout или объект-ошибка вместо массива) отдаём ПОСЛЕДНЕЕ хорошее
  // значение, а НЕ 0 — иначе equity ложно теряет ~$36 «в ордерах» → ложная просадка → ложный halt.
  private lastReserved: Record<string, { quote: number; base: number }> = {};
  private async getReserved(symbol: string): Promise<{ quote: number; base: number }> {
    const sym = this.apiSym(symbol);
    const cached = this.lastReserved[sym] ?? { quote: 0, base: 0 };
    try {
      const list: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders?status=open`);
      const valid = Array.isArray(list?.orders) || Array.isArray(list);   // валидный ответ (пусть и пустой массив = реально 0 ордеров)
      if (!valid) return cached;                                          // API под нагрузкой шлёт объект-ошибку → НЕ верим 0, держим кэш
      const orders = Array.isArray(list?.orders) ? list.orders : list;
      if (!this.ordLogged && orders.length) { this.ordLogged = true; console.log(`[dreamdex] open-order raw: ${JSON.stringify(orders[0])}`); }
      let quote = 0, base = 0;
      for (const o of orders) {
        const px = parseFloat(o.price ?? o.limitPrice ?? 0);
        const remain = parseFloat(o.remainingQuantity ?? o.remaining ?? o.openQuantity ?? o.quantity ?? o.amount ?? 0);
        if (String(o.side ?? "").toLowerCase() === "buy") quote += px * remain; else base += remain;
      }
      const res = { quote, base };
      this.lastReserved[sym] = res;                                       // запомнили хорошее значение
      return res;
    } catch { return cached; }                                           // timeout/сеть → последнее хорошее, не 0
  }

  // Сколько УЖЕ лежит в волте по валюте (чтобы не дублировать депозит при каждом рестарте).
  private async vaultBalance(symbol: string, currency: string): Promise<number> {
    try {
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const mk = (r.markets || []).find((x: any) => x.symbol === this.apiSym(symbol));
      if (!mk) return 0;
      const b = currency === "USDso" ? mk.quote : mk.base;
      return b == null ? 0 : parseFloat(b.vault ?? 0);
    } catch { return 0; }
  }

  // Сброс состояния финансирования vault: после возврата в МЕЙКЕР-фазу осциллятора
  // нужно заново долить vault'ы (adaptive ensureVaultFunded сделает это на ближайших мейкер-ордерах).
  resetVaultFunding(): void { this.vaulted = {}; this.vaultTry = {}; }

  // База из КОШЕЛЬКА → в VAULT. Тогда мейкер сможет продать её НОРМАЛЬНО (postOnly, ловя спред),
  // а не сливать тейкером в минус. Нужно когда инвентарь застрял в кошельке (напр. после тейкер-покупок/крэша).
  async depositBaseToVault(symbol: string, amount: number): Promise<void> {
    const sym = this.apiSym(symbol);
    const m = this.markets[sym]; if (!m || amount <= 0) return;
    const baseCur = sym.split(":")[0];                                   // напр. "WETH"
    // ПЕРЕСЧИТЫВАЕМ реальную базу в кошельке СЕЙЧАС: сумма из тика могла устареть (продажи/прошлый депозит) → "exceeds balance"
    let curWallet = amount;
    try {
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const mk = (r.markets || []).find((x: any) => x.symbol === sym);
      if (mk?.base) curWallet = parseFloat(mk.base.wallet ?? 0);
    } catch { /* нет чтения → используем переданное */ }
    await this.ensureApproved(sym);                                      // база одобрена пулу
    const lot = parseFloat(m.lotSize ?? "0");
    let amt = Math.min(amount, curWallet) * 0.999;                       // не больше чем реально есть (буфер на округление)
    amt = lot > 0 ? Math.floor(amt / lot) * lot : amt;                  // вниз к лоту
    if (amt <= 0) return;
    const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/vault/deposit`, { method: "POST", body: JSON.stringify({ walletAddress: await this.signer.getAddress(), currency: baseCur, amount: String(amt) }) });
    const tx = r.transaction ?? r;
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";
    if (tx?.to && okData) { const h = await this.send(tx); console.log(`[dreamdex] база→vault: ${amt} ${baseCur} (${sym}) → ${(h || "").slice(0, 12)}…`); }
    else console.log(`[dreamdex] база→vault ${sym}: API не дал валидную tx (возможно депозит базы не поддержан) → ${JSON.stringify(r).slice(0, 160)}`);
  }

  // USDso в КОШЕЛЬКЕ и в VAULT для пары одним запросом (для адаптивного депозита).
  private async quoteWalletVault(symbol: string): Promise<{ wallet: number; vault: number }> {
    try {
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const mk = (r.markets || []).find((x: any) => x.symbol === this.apiSym(symbol));
      if (!mk || !mk.quote) return { wallet: 0, vault: 0 };
      return { wallet: parseFloat(mk.quote.wallet ?? 0), vault: parseFloat(mk.quote.vault ?? 0) };
    } catch { return { wallet: 0, vault: 0 }; }
  }

  // ВАЖНО для лидерборда: USDso в vault считается как МИНУС-PnL (лидерборд видит только кошелёк).
  // Вытаскиваем vault-средства в кошелёк — КРОМЕ пар из keep (там vault нужен для мейкер-ордеров).
  async recoverVaults(keep: string[] = []): Promise<void> {
    try {
      const keepSet = new Set(keep.map(p => this.apiSym(p)));
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const withdraw = async (sym: string, currency: string, amount: number) => {
        if (!(amount > 0.0000001)) return;
        const body = { walletAddress: addr, currency, amount: String(amount) };
        const resp: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/vault/withdraw`, { method: "POST", body: JSON.stringify(body) });
        const tx = resp.transaction ?? resp;
        if (tx?.to) { const h = await this.send(tx); console.log(`[dreamdex] VAULT withdraw ${amount} ${currency} (${sym}) → ${(h || "").slice(0, 12)}…`); }
        else console.log(`[dreamdex] vault withdraw ${sym} ${currency}: нет транзы (${JSON.stringify(resp).slice(0, 120)})`);
      };
      for (const m of (r.markets || [])) {
        if (keepSet.has(m.symbol)) continue;                     // keep-пара — vault оставляем
        await withdraw(m.symbol, "USDso", parseFloat(m.quote?.vault ?? 0));                 // вытащить USDso из vault → кошелёк
        const baseCur = (m.symbol || "").split(":")[0];
        if (baseCur && baseCur !== "USDso") await withdraw(m.symbol, baseCur, parseFloat(m.base?.vault ?? 0)); // и базу (WETH/WBTC) тоже
      }
    } catch (e) { console.log(`[dreamdex] recoverVaults error: ${(e as Error).message}`); }
  }

  // dreamDEX: перед торговлей одобрить токены пулу (прямой ERC-20 approve, как в quick-start). Один раз на рынок.
  private async ensureApproved(sym: string): Promise<void> {
    if (this.approved[sym]) return;
    const m = this.markets[sym]; if (!m) { this.approved[sym] = true; return; }
    const ethers = this.ethers;
    const abi = ["function approve(address,uint256) returns (bool)"];
    for (const token of [m.quote, m.base]) {                 // quote(USDso) для покупки, base для продажи
      if (!token || /^0x0+$/i.test(token)) continue;         // нативный токен — пропуск
      try { const c = new ethers.Contract(token, abi, this.signer); await (await c.approve(m.contract, ethers.MaxUint256)).wait(); console.log(`[dreamdex] approve ok ${token.slice(0, 8)}→pool ${sym}`); }
      catch (e) { console.log(`[dreamdex] approve FAIL ${token.slice(0, 8)}→pool ${sym}: ${(e as Error).message.slice(0, 90)}`); }
    }
    this.approved[sym] = true;
  }

  // dreamDEX: положить USDso в волт пула — нужно для maker-лимиток (fundingSource:"vault").
  // АДАПТИВНО: кладём только то, что РЕАЛЬНО есть в кошельке (минус буфер). Если на старте капитал
  // ещё в инвентаре (мало свободного USDso) — депозит НЕ ревертит (0xe450d38c), а доливает на след. тиках,
  // когда распродажа инвентаря пополнит кошелёк. Так оба vault'а (WETH+WBTC) гарантированно финансируются.
  private async ensureVaultFunded(sym: string): Promise<void> {
    if (this.vaulted[sym]) return;
    const target = parseFloat(String(this.cfg.vaultDepositUSDso ?? 0));
    if (target <= 0) { this.vaulted[sym] = true; return; }
    const now = Date.now();
    if (now - (this.vaultTry[sym] ?? 0) < 15000) return;           // не чаще раза в 15с (ждём пока освободится USDso)
    this.vaultTry[sym] = now;
    await this.ensureApproved(sym);
    const { wallet, vault } = await this.quoteWalletVault(sym);
    const need = target - vault;
    if (need <= 0.5) { console.log(`[dreamdex] VAULT профинансирован: ${vault.toFixed(2)}/${target} USDso (${sym})`); this.vaulted[sym] = true; return; }
    const buffer = 5;                                              // оставляем немного USDso в кошельке (на тейкер/газ-актив)
    const amt = Math.min(need, wallet - buffer);
    if (amt < 1) { console.log(`[dreamdex] vault ${sym}: в кошельке мало USDso ($${wallet.toFixed(1)}) — долью позже`); return; }   // НЕ ставим vaulted → дольёт на след. тике
    const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/vault/deposit`, { method: "POST", body: JSON.stringify({ walletAddress: await this.signer.getAddress(), currency: "USDso", amount: String(amt) }) });
    if (!this.depLogged) { this.depLogged = true; console.log(`[dreamdex] deposit raw (${sym}): ${JSON.stringify(r).slice(0, 320)}`); }
    const tx = r.transaction ?? r;
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";
    if (tx?.to && okData) { const h = await this.send(tx); console.log(`[dreamdex] VAULT deposit ${amt.toFixed(2)} USDso (было ${vault.toFixed(2)}, цель ${target}) → ${(h || "—").slice(0, 12)}…`); }
    else { console.log(`[dreamdex] deposit ${sym}: нет валидной tx → пропуск`); return; }
    if (vault + amt >= target * 0.9) this.vaulted[sym] = true;     // цель почти достигнута → больше не доливаем
  }

  // публичные обёртки: мейкер (postOnly) и тейкер (immediate-or-cancel, для флэта инвентаря).
  async placeLimit(symbol: string, side: Side, price: number, size: number, postOnly: boolean): Promise<PlacedOrder> {
    return this._place(symbol, side, price, size, postOnly ? "postOnly" : "normalOrder");
  }
  async placeIOC(symbol: string, side: Side, price: number, size: number): Promise<PlacedOrder> {
    return this._place(symbol, side, price, size, "immediateOrCancel");
  }

  private async _place(symbol: string, side: Side, price: number, size: number, orderType: "postOnly" | "normalOrder" | "immediateOrCancel"): Promise<PlacedOrder> {
    const sym = this.apiSym(symbol);
    const m = this.markets[sym];
    // округляем цену к tickSize, размер вниз к lotSize; ниже minQuantity — не отправляем
    const dec = (s?: string) => (s?.split(".")[1] || "").length;
    const tick = parseFloat(m?.tickSize ?? "0"); const lot = parseFloat(m?.lotSize ?? "0"); const minQ = parseFloat(m?.minQuantity ?? "0");
    const p = tick > 0 ? Math.round(price / tick) * tick : price;
    const a = lot > 0 ? Math.floor(size / lot) * lot : size;
    if (minQ > 0 && a < minQ) return { id: "" };                         // меньше минимума → пропуск
    const priceStr = p.toFixed(dec(m?.tickSize)); const amtStr = a.toFixed(dec(m?.lotSize));
    await this.ensureApproved(sym);   // WALLET-funding для ВСЕХ ордеров: по докам исполненный ордер отдаёт монеты В КОШЕЛЁК
    // (даже vault-funded!), поэтому правильный непрерывный мейкер = wallet-funded postOnly: покупка USDso→WETH в кошелёк,
    // продажа WETH→USDso в кошелёк. Никакого vault/депозитов/застреваний. Нужен только ERC-20 approve (ensureApproved).
    const body = { type: "limit", side, amount: amtStr, price: priceStr, orderType, fundingSource: "wallet" };
    const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders`, { method: "POST", body: JSON.stringify(body) });
    if (!this.placeLoggedSyms.has(sym)) { this.placeLoggedSyms.add(sym); console.log(`[dreamdex] order resp (${sym} ${side} ${orderType}): ${JSON.stringify(r).slice(0, 340)}`); }   // разово на пару: смотрим есть ли value
    const tx = r.transaction ?? r;                       // неподписанная транза {to,data,value}
    // wrapped-native база (wSOMI): на SELL контракт требует прислать НАТИВНЫЙ SOMI как msg.value = количество
    // (оборачивает сам). API возвращает value:0 → досылаем сами, иначе InvalidMsgValue (0x1f89f671).
    const WSOMI = "0x28f34defd2b4cb48d9ee6d89f2be4bc601694c00";
    if (side === "sell" && (m?.base ?? "").toLowerCase() === WSOMI) {
      tx.value = this.ethers.parseUnits(amtStr, m.baseDecimals).toString();
    }
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";   // НЕ шлём пустую/битую tx → иначе реверт + сожжён газ
    if (!tx?.to || !okData) {
      // ДИАГНОСТИКА: логируем ПОЧЕМУ пустая tx (тело ответа API) — троттл раз в минуту на пару+сторону, чтобы не спамить.
      const k = sym + side; const now = Date.now();
      if (now - (this.emptyLogTs[k] ?? 0) > 60000) { this.emptyLogTs[k] = now; console.log(`[dreamdex] ORDER ${side} ${sym} (${orderType}) пустая tx → пропуск. resp: ${JSON.stringify(r).slice(0, 240)}`); }
      return { id: "" };
    }
    const hash = await this.send(tx);
    if (!hash) return { id: "" };                                     // send отсёк битую транзу
    console.log(`[dreamdex] ORDER ${side} ${amtStr} @ ${priceStr} (${orderType}) → ${hash.slice(0, 12)}…`);
    const id = String(r.id ?? hash);
    this.myOrders[id] = { symbol, side };
    if (orderType !== "postOnly") this.fillCbs.forEach(cb => cb({ symbol, side, price: p, size: a, orderId: id, ts: Date.now() })); // тейкер исполняется сразу → засчитываем объём
    return { id };
  }

  async cancelAll(symbol: string): Promise<void> {
    const sym = this.apiSym(symbol);
    // >>> VERIFY: точный путь списка открытых ордеров. <<<
    const list: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders?status=open`);
    // ТОЛЬКО массив: под нагрузкой API отдаёт объект-ошибку ({message:"Too many requests"}) → перебор объекта = "not iterable"
    const arr = Array.isArray(list?.orders) ? list.orders : (Array.isArray(list) ? list : []);
    for (const o of arr) {
      const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders/${o.id}`, { method: "DELETE" });
      const tx = r.transaction ?? r; if (tx?.to) await this.send(tx);
    }
  }

  // Филлы on-chain: слушаем OrderFilled на контракте каждого рынка (WS не нужен).
  private watchFills(): void {
    const ethers = this.ethers;
    const topic = "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399";
    const iface = new ethers.Interface(["event OrderFilled(uint128 indexed takerOrderId, uint128 indexed makerOrderId, uint256 quantityFilled, uint256 takerRemainingQuantity, uint256 makerRemainingQuantity, uint256 fillPrice)"]);
    for (const apiSym in this.markets) {
      const m = this.markets[apiSym]; const botSym = apiSym.replace(":", "/");
      this.provider.on({ address: m.contract, topics: [topic] }, (lg: any) => {
        try {
          const p: any = iface.parseLog(lg);
          const size = Number(ethers.formatUnits(p.args.quantityFilled, m.baseDecimals));
          const price = Number(ethers.formatUnits(p.args.fillPrice, m.quoteDecimals));
          const taker = String(p.args.takerOrderId);
          const mine = this.myOrders[taker] ?? this.myOrders[String(p.args.makerOrderId)];
          if (!mine) return;                              // не наш ордер
          this.fillCbs.forEach(cb => cb({ symbol: botSym, side: mine.side, price, size, orderId: taker, ts: Date.now() }));
        } catch { /* чужой/несовпавший лог */ }
      });
    }
    // >>> VERIFY: кодировка OrderId (кастомный тип) и матчинг с myOrders для точной side. <<<
  }

  onFill(cb: (f: Fill) => void): void { this.fillCbs.push(cb); }
}

// ---------------------------------------------------------------------------
// MOCK (мультипара) — `npm run dry`. Случайное блуждание цены на каждой паре,
// общий кошелёк (quote+gas), per-symbol base. Видно объём/инвентарь/риск.
// ---------------------------------------------------------------------------
export class MockClient implements ExchangeClient {
  private mids: Record<string, number> = {};
  private base: Record<string, number> = {};
  private quote: number;
  private gas = 50;
  public lastTxMs = Date.now();
  private resting: { symbol: string; side: Side; price: number; size: number }[] = [];
  private fillCbs: ((f: Fill) => void)[] = [];

  constructor(symbols: string[], startUSDso = 1000) {
    this.quote = startUSDso;
    const seed: Record<string, number> = { "BTC/USDso": 65000, "ETH/USDso": 3000, "SOMI/USDso": 0.5 };
    for (const s of symbols) { this.mids[s] = seed[s] ?? 100; this.base[s] = 0; }
  }
  async connect() {}
  async getOrderBook(symbol: string): Promise<OrderBook> {
    const m = (this.mids[symbol] *= 1 + (Math.random() - 0.5) * 0.001); // ~5 bps шаг
    const half = m * 0.0003;                                            // ~3 bps книга
    return { symbol, bid: m - half, ask: m + half, mid: m, ts: Date.now() };
  }
  async getBalances(symbol: string): Promise<Balances> {
    const b = this.base[symbol] ?? 0;
    return { quoteUSDso: this.quote, baseToken: b, baseVault: b, baseWallet: 0, gasSOMI: this.gas };  // в моке вся база «в vault»
  }
  getSpec(symbol: string): MarketSpec { const m = this.mids[symbol] ?? 100; return { tick: m * 1e-4, lot: 1e-6, minQty: 1e-6 }; }
  async placeLimit(symbol: string, side: Side, price: number, size: number, _postOnly = false): Promise<PlacedOrder> {
    this.lastTxMs = Date.now();
    this.resting.push({ symbol, side, price, size });
    setTimeout(() => this.maybeFill(symbol), 50 + Math.random() * 300);
    return { id: "m" + Math.random().toString(36).slice(2, 8) };
  }
  async placeIOC(symbol: string, side: Side, price: number, size: number): Promise<PlacedOrder> {
    this.lastTxMs = Date.now();
    if (side === "buy") { this.base[symbol] = (this.base[symbol] ?? 0) + size; this.quote -= size * price; }
    else { this.base[symbol] = (this.base[symbol] ?? 0) - size; this.quote += size * price; }
    this.gas -= 0.01;
    this.fillCbs.forEach(cb => cb({ symbol, side, price, size, orderId: "ioc", ts: Date.now() }));
    return { id: "ioc" + Math.random().toString(36).slice(2, 6) };
  }
  private maybeFill(symbol: string) {
    const idx = this.resting.findIndex(r => r.symbol === symbol);
    if (idx < 0) return;
    const r = this.resting.splice(idx, 1)[0];
    const m = this.mids[symbol];
    const dist = Math.abs(r.price - m) / m;
    if (Math.random() < Math.max(0, 0.9 - dist * 200)) {
      if (r.side === "buy") { this.base[symbol] += r.size; this.quote -= r.size * r.price; }
      else { this.base[symbol] -= r.size; this.quote += r.size * r.price; }
      this.gas -= 0.01;
      this.fillCbs.forEach(cb => cb({ symbol, side: r.side, price: r.price, size: r.size, orderId: "f", ts: Date.now() }));
    }
  }
  async cancelAll(symbol: string) { this.resting = this.resting.filter(r => r.symbol !== symbol); }
  onFill(cb: (f: Fill) => void) { this.fillCbs.push(cb); }
}
