// Одноразовая конвертация USDso → нативный SOMI (газ) тейкер-покупкой на SOMI:USDso.
// Правило 6 программы: газ после гранта — только конвертацией своих средств. Запуск: npx tsx convert-gas.ts
// ВАЖНО: запускать ТОЛЬКО при остановленном боте (pm2 stop dreamdex) — иначе конфликт nonce.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)) });
import { DreamDexClient } from "./src/exchange.js";

const SPEND = Number(process.env.SPEND_USDSO ?? 6);   // сколько USDso сконвертить в газ

const c = new DreamDexClient({
  restUrl: process.env.DREAMDEX_REST_URL ?? "",
  wsUrl: "",
  rpc: process.env.DREAMDEX_CHAIN_RPC ?? "",
  privateKey: process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY || "",
  tokens: { USDso: "0x00000022dA000002656c64D9eA6011ea952D008A", SOMI: "native" },
});

await c.connect();
const before = await c.getBalances("SOMI/USDso");
console.log(`до: газ=${before.gasSOMI.toFixed(2)} SOMI, USDso(кош+vault)=${before.quoteUSDso.toFixed(2)}`);

const ob = await c.getOrderBook("SOMI/USDso");
console.log(`стакан SOMI: bid=${ob.bid} ask=${ob.ask}`);
if (!(ob.ask > 0)) { console.log("нет аска — выходим без покупки"); process.exit(1); }

const px = ob.ask * 1.005;                 // IOC с запасом 0.5% чтобы точно исполнился
const size = SPEND / ob.ask;               // ~SPEND долларов в SOMI
console.log(`покупаю ~${size.toFixed(2)} SOMI за ~$${SPEND} (IOC по ${px.toFixed(5)})`);
const r = await c.placeIOC!("SOMI/USDso", "buy", px, size);
console.log("ордер:", JSON.stringify(r));

await new Promise((res) => setTimeout(res, 6000));
const after = await c.getBalances("SOMI/USDso");
console.log(`после: газ=${after.gasSOMI.toFixed(2)} SOMI, USDso(кош+vault)=${after.quoteUSDso.toFixed(2)}`);
console.log(`итог: +${(after.gasSOMI - before.gasSOMI).toFixed(2)} SOMI газа за ${(before.quoteUSDso - after.quoteUSDso).toFixed(2)} USDso`);
process.exit(0);
