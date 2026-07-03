// READ-ONLY сверка реального баланса: кошелёк + vault + ордера + инвентарь. Ордеров НЕ ставит.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)) });
import { ethers } from "ethers";

const REST = process.env.DREAMDEX_REST_URL || "https://api.dreamdex.io/v0";
const RPC = process.env.DREAMDEX_CHAIN_RPC || "https://api.infra.mainnet.somnia.network/";
const KEY = process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY;
const chainId = REST.includes("stg") ? 50312 : 5031;
const PAIRS = ["WETH:USDso", "WBTC:USDso"];

const provider = new ethers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(KEY, provider);
const addr = await signer.getAddress();

// SIWE → JWT (как в боте)
const { nonce } = await (await fetch(`${REST}/auth/nonce`)).json();
const domain = new URL(REST).host;
const msg = [`${domain} wants you to sign in with your Ethereum account:`, addr, "",
  "Sign in to dreamDEX", "", `URI: https://${domain}`, "Version: 1", `Chain ID: ${chainId}`,
  `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`].join("\n");
const signature = await signer.signMessage(msg);
const { token } = await (await fetch(`${REST}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg, signature }) })).json();
const H = { "content-type": "application/json", authorization: `Bearer ${token}` };

// цены
const price = {};
for (const sym of PAIRS) {
  const tr = await (await fetch(`${REST}/markets/${encodeURIComponent(sym)}/trades`)).json();
  const arr = tr.trades ?? tr ?? [];
  if (arr.length) price[sym.split(":")[0]] = parseFloat(arr[0].price ?? 0);
}
// баланс кошелёк+vault
const bal = await (await fetch(`${REST}/wallets/${addr}/balance`, { headers: H })).json();
let walletUSDso = 0, vaultUSDso = 0, invWalletVaultUSD = 0;
for (const m of (bal.markets || [])) {
  walletUSDso = parseFloat(m.quote?.wallet ?? 0);          // wallet-wide (одинаков у всех пар)
  vaultUSDso += parseFloat(m.quote?.vault ?? 0);           // per-pair → сумма
  const base = (m.symbol || "").split(":")[0];
  invWalletVaultUSD += (parseFloat(m.base?.wallet ?? 0) + parseFloat(m.base?.vault ?? 0)) * (price[base] ?? 0);
}
// ордера → reserved
let resUSDso = 0, resBaseUSD = 0, openCnt = 0;
for (const sym of PAIRS) {
  const list = await (await fetch(`${REST}/markets/${encodeURIComponent(sym)}/orders?status=open`, { headers: H })).json();
  const orders = Array.isArray(list?.orders) ? list.orders : (Array.isArray(list) ? list : []);
  for (const o of orders) {
    openCnt++;
    const px = parseFloat(o.price ?? 0);
    const rem = parseFloat(o.remaining ?? o.remainingQuantity ?? o.amount ?? 0);
    if (String(o.side ?? "").toLowerCase() === "buy") resUSDso += px * rem;
    else resBaseUSD += rem * (price[sym.split(":")[0]] ?? px);
  }
}
const native = Number(ethers.formatEther(await provider.getBalance(addr)));

const totalUSDso = walletUSDso + vaultUSDso + resUSDso;
const totalInv = invWalletVaultUSD + resBaseUSD;
const REAL = totalUSDso + totalInv;
const f = (x) => `$${x.toFixed(2)}`;
console.log(`\n=== РЕАЛЬНЫЙ РАСКЛАД  ${addr}  (цены WETH ${price.WETH} / WBTC ${price.WBTC}) ===`);
console.log(`USDso в кошельке (это видит ЭКСПЛОРЕР и ЛИДЕРБОРД): ${f(walletUSDso)}`);
console.log(`USDso в vault:                                      ${f(vaultUSDso)}`);
console.log(`USDso заперт в buy-ордерах:                         ${f(resUSDso)}`);
console.log(`  → ВСЕГО USDso:                                    ${f(totalUSDso)}`);
console.log(`Инвентарь WETH/WBTC (кошелёк+vault):                ${f(invWalletVaultUSD)}`);
console.log(`Инвентарь в sell-ордерах:                           ${f(resBaseUSD)}`);
console.log(`  → ВСЕГО инвентарь:                                ${f(totalInv)}`);
console.log(`════════════════════════════════════════════════════════════`);
console.log(`РЕАЛЬНЫЙ КАПИТАЛ (всё, что вернётся при флэте):     ${f(REAL)}   (старт $150 → ${REAL>=150?"+":""}${(REAL-150).toFixed(2)})`);
console.log(`Открытых ордеров: ${openCnt} | Газ (нативн. SOMI): ${native.toFixed(2)} (из 50 → потрачено ${(50-native).toFixed(2)} = $${((50-native)*0.1).toFixed(2)})`);
console.log(`СНЕПШОТ-МНОЖИТЕЛЬ при флэте ≈ ${(REAL/150).toFixed(3)}\n`);
