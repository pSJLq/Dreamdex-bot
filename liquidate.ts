// ФИНАЛЬНАЯ ЛИКВИДАЦИЯ (ивент кончился): продать весь WETH/WBTC/SOMI в USDso, оставить ~1.5 SOMI на газ.
// Переиспользует боевой DreamDexClient (те же placeIOC/подпись). Бот должен быть ОСТАНОВЛЕН (pm2 stop dreamdex) — иначе конфликт nonce.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)) });
import { readFileSync } from "node:fs";
import { DreamDexClient } from "./src/exchange.js";

const cfg: any = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const client = new DreamDexClient({
  restUrl: process.env.DREAMDEX_REST_URL ?? "",
  wsUrl: process.env.DREAMDEX_WS_URL ?? "",
  rpc: process.env.DREAMDEX_CHAIN_RPC ?? "",
  privateKey: process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY || "",
  tokens: cfg.tokens,
  gasReserveSOMI: cfg.gasReserveSOMI,
});
const log = (s: string) => console.log(`[liq] ${s}`);

await client.connect();
log("подключено. Ликвидирую всё в USDso…");

const BASE_PAIRS = ["WETH/USDso", "WBTC/USDso"];
// 1) WETH и WBTC → USDso (тейкер, несколько проходов — IOC может частично на тонком стакане)
for (let pass = 0; pass < 8; pass++) {
  let anySold = false;
  for (const sym of BASE_PAIRS) {
    try {
      const [bal, ob] = await Promise.all([client.getBalances(sym), client.getOrderBook(sym)]);
      const amt = bal.baseToken; const usd = amt * ob.mid;
      if (usd > 0.3) {
        log(`продаю ${sym}: ${amt.toFixed(6)} (~$${usd.toFixed(2)})`);
        await client.cancelAll(sym);
        await client.placeIOC(sym, "sell", ob.bid, amt);
        anySold = true;
      }
    } catch (e) { log(`${sym} ошибка: ${(e as Error).message}`); }
  }
  if (!anySold) break;
  await new Promise(r => setTimeout(r, 3500));
}
// 2) SOMI → USDso, оставить ~1.5 (буфер на газ самой транзы; юзер просил ~1)
for (let pass = 0; pass < 5; pass++) {
  try {
    const somi = "SOMI/USDso";
    const [bal, ob] = await Promise.all([client.getBalances(somi), client.getOrderBook(somi)]);
    const sellable = Math.min(Math.max(0, bal.gasSOMI - 1.5), 8);   // мелкими кусками (wSOMI капризна)
    if (sellable > 0.5 && ob.bid > 0) {
      log(`продаю SOMI: ${sellable.toFixed(2)} (оставляю ~1.5 на газ)`);
      await client.placeIOC(somi, "sell", ob.bid, sellable);
    } else { log(`SOMI: больше нечего продавать (${bal.gasSOMI.toFixed(2)} SOMI)`); break; }
  } catch (e) { log(`SOMI ошибка: ${(e as Error).message}`); break; }
  await new Promise(r => setTimeout(r, 3500));
}
// финальный баланс
await new Promise(r => setTimeout(r, 2500));
const bW = await client.getBalances("WETH/USDso");
const bB = await client.getBalances("WBTC/USDso");
const obW = await client.getOrderBook("WETH/USDso");
const obB = await client.getOrderBook("WBTC/USDso");
log(`════ ФИНАЛ ════ USDso ~$${bW.quoteUSDso.toFixed(2)} | остаток WETH ~$${(bW.baseToken * obW.mid).toFixed(2)} | остаток WBTC ~$${(bB.baseToken * obB.mid).toFixed(2)} | SOMI ${bW.gasSOMI.toFixed(2)}`);
log("готово ✅ Проверь баланс на эксплорере.");
process.exit(0);
