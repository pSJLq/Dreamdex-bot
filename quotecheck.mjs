// READ-ONLY: где стоят НАШИ котировки относительно касания стакана (на касании = ловим поток).
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)) });
import { ethers } from "ethers";
const REST = process.env.DREAMDEX_REST_URL || "https://api.dreamdex.io/v0";
const RPC = process.env.DREAMDEX_CHAIN_RPC || "https://api.infra.mainnet.somnia.network/";
const KEY = process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY;
const chainId = REST.includes("stg") ? 50312 : 5031;
const provider = new ethers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(KEY, provider);
const addr = await signer.getAddress();
const { nonce } = await (await fetch(`${REST}/auth/nonce`)).json();
const domain = new URL(REST).host;
const msg = [`${domain} wants you to sign in with your Ethereum account:`, addr, "", "Sign in to dreamDEX", "", `URI: https://${domain}`, "Version: 1", `Chain ID: ${chainId}`, `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`].join("\n");
const sig = await signer.signMessage(msg);
const { token } = await (await fetch(`${REST}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg, signature: sig }) })).json();
const H = { authorization: `Bearer ${token}` };
const sym = "WETH:USDso";
// Binance fair
let binFair = 0; try { binFair = parseFloat((await (await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT")).json()).price); } catch {}
// стакан
const ob = (await (await fetch(`${REST}/orderbooks?symbols=${encodeURIComponent(sym)}&depth=1`)).json()).orderbooks[0];
const bid = parseFloat(ob.bids[0].price), ask = parseFloat(ob.asks[0].price), mid = (bid + ask) / 2;
// наши открытые ордера
const list = await (await fetch(`${REST}/markets/${encodeURIComponent(sym)}/orders?status=open`, { headers: H })).json();
const orders = Array.isArray(list?.orders) ? list.orders : (Array.isArray(list) ? list : []);
const myBuy = orders.filter(o => String(o.side).toLowerCase() === "buy").map(o => parseFloat(o.price)).sort((a, b) => b - a)[0];
const mySell = orders.filter(o => String(o.side).toLowerCase() === "sell").map(o => parseFloat(o.price)).sort((a, b) => a - b)[0];
const bp = (x, ref) => ((x - ref) / ref * 1e4).toFixed(1);
console.log(`\nСтакан WETH: бид ${bid} / аск ${ask} (спред ${bp(ask, bid)} bp) | mid ${mid.toFixed(2)} | Binance ${binFair} (dreamDEX выше на ${bp(mid, binFair)} bp)`);
console.log(`Наш BUY:  ${myBuy ?? "—"}  → ${myBuy ? (myBuy >= bid ? `НА КАСАНИИ/лучше (+${bp(myBuy, bid)}bp к биду)` : `позади бида на ${bp(bid, myBuy)}bp`) : "нет ордера"}`);
console.log(`Наш SELL: ${mySell ?? "—"}  → ${mySell ? (mySell <= ask ? `НА КАСАНИИ/лучше (${bp(mySell, ask)}bp к аску)` : `позади аска на ${bp(mySell, ask)}bp`) : "нет ордера"}`);
console.log(`Всего наших открытых ордеров: ${orders.length}`);
