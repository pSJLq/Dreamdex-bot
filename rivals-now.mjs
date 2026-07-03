// READ-ONLY: реальные балансы ВСЕХ трейдеров (USDso+WETH+WBTC+нативный SOMI) + цена/объём all-in.
// Старт у всех = $150 USDso + 50 SOMI (~$5) = ~$155. Потрачено = 155 − текущий реал. Цена = потрачено/объём.
import { ethers } from "ethers";
const RPC = "https://api.infra.mainnet.somnia.network/";
const API = "https://api.dreamdex.io/v0";
const LB = "https://dreamdex-leaderboard-new.vercel.app/api/leaderboard";
const provider = new ethers.JsonRpcProvider(RPC);
const TOK = {
  USDso: ["0x00000022da000002656c64d9ea6011ea952d008a", 18],
  WETH:  ["0x936ab8c674bcb567cd5deb85d8a216494704e9d8", 18],
  WBTC:  ["0xc5098b3ca516784323872f17235fa074e167d3d2", 8],
};
const erc20 = ["function balanceOf(address) view returns (uint256)"];

const price = { USDso: 1 };
for (const sym of ["WETH:USDso", "WBTC:USDso", "SOMI:USDso"]) {
  try {
    const tr = await (await fetch(`${API}/markets/${encodeURIComponent(sym)}/trades`)).json();
    const arr = tr.trades ?? tr ?? [];
    if (arr.length) price[sym.split(":")[0]] = parseFloat(arr[0].price ?? 0);
  } catch {}
}
console.log("Цены:", JSON.stringify(price));

async function fetchLB() {
  for (let i = 0; i < 3; i++) {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
      const r = await (await fetch(LB, { signal: ac.signal })).json().finally(() => clearTimeout(t));
      if (r?.traders) return r;
    } catch (e) { console.log(`лидерборд, попытка ${i + 1}/3: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 3000));
  }
  // фолбэк: без лидерборда показываем только ончейн-балансы по известным адресам
  return { traders: [
    { handle: "trader-2", address: "0xD84fE2a2220f0269e3d88dab908ADceb2d691E76", volumeUsdso: 0, txCount: 0 },
    { handle: "trader-5", address: "0x248B9619213C3aBA4a5AC8Ded692Ba5d5eE8974c", volumeUsdso: 0, txCount: 0 },
    { handle: "trader-3", address: "0xba4E595D6C2e655592c86ce29BbAec202d9175E1", volumeUsdso: 0, txCount: 0 },
    { handle: "trader-1", address: "0x3D3F1BCC7f4A1D3C0d2BD2E25b7dFd6AA8bE0840", volumeUsdso: 0, txCount: 0 },
  ] };
}
const lb = await fetchLB();
const rows = [];
for (const t of lb.traders) {
  if (t.handle === "tester") continue;
  const addr = t.address;
  let usdso = 0, inv = 0, parts = [];
  const somi = Number(ethers.formatEther(await provider.getBalance(addr)));
  for (const [sym, [tok, d]] of Object.entries(TOK)) {
    let b = 0; try { b = Number(ethers.formatUnits(await new ethers.Contract(tok, erc20, provider).balanceOf(addr), d)); } catch {}
    const usd = b * (price[sym] ?? 0);
    if (b > 1e-9) parts.push(`${sym}=$${usd.toFixed(1)}`);
    if (sym === "USDso") usdso = usd; else inv += usd;
  }
  const somiUsd = somi * (price.SOMI ?? 0.1);
  const real = usdso + inv + somiUsd;         // всё вместе (капитал + остаток газа)
  const spent = 155 - real;                    // от старта $150+50SOMI
  const bps = t.volumeUsdso > 0 ? spent / t.volumeUsdso * 1e4 : 0;
  rows.push({ h: t.handle, raw: t.volumeUsdso, tx: t.txCount, usdso, inv, somi, somiUsd, real, spent, bps });
}
rows.sort((a, b) => b.raw - a.raw);
console.log("\nтрейдер   | raw объём |   tx   | USDso | инвент | SOMI(шт) | РЕАЛ всё | потрачено | цена б.п.");
for (const r of rows) {
  const me = r.h === "trader-1" ? "  <— МЫ" : "";
  console.log(
    `${r.h.padEnd(9)} | ${String(Math.round(r.raw)).padStart(9)} | ${String(r.tx).padStart(6)} | ${r.usdso.toFixed(1).padStart(5)} | ${r.inv.toFixed(1).padStart(6)} | ${r.somi.toFixed(1).padStart(8)} | ${("$" + r.real.toFixed(1)).padStart(8)} | ${("$" + r.spent.toFixed(1)).padStart(9)} | ${r.bps.toFixed(2).padStart(8)}${me}`
  );
}
console.log("\n(vault чужих не читается без auth — у активных тейкеров он ~0; наш vault = 0 по конфигу)");
