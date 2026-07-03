// READ-ONLY разведка: реальные ончейн-холдинги соперников + структура сделок (для maker/taker).
import { ethers } from "ethers";
const RPC = "https://api.infra.mainnet.somnia.network/";
const API = "https://api.dreamdex.io/v0";
const provider = new ethers.JsonRpcProvider(RPC);
const TOK = {
  USDso: ["0x00000022da000002656c64d9ea6011ea952d008a", 18],
  WETH:  ["0x936ab8c674bcb567cd5deb85d8a216494704e9d8", 18],
  WBTC:  ["0xc5098b3ca516784323872f17235fa074e167d3d2", 8],
};
const RIV = {
  "trader-2": "0xD84fE2a2220f0269e3d88dab908ADceb2d691E76",
  "trader-3": "0xba4E595D6C2e655592c86ce29BbAec202d9175E1",
  "МЫ":       "0x3D3F1BCC7f4A1D3C0d2BD2E25b7dFd6AA8bE0840",
};
const erc20 = ["function balanceOf(address) view returns (uint256)"];

const price = {};
for (const sym of ["WETH:USDso", "WBTC:USDso"]) {
  const tr = await (await fetch(`${API}/markets/${encodeURIComponent(sym)}/trades`)).json();
  const arr = tr.trades ?? tr ?? [];
  if (arr.length) price[sym.split(":")[0]] = parseFloat(arr[0].price ?? 0);
}
console.log("Цены:", price);
const trS = await (await fetch(`${API}/markets/WETH:USDso/trades`)).json();
const arrS = trS.trades ?? trS ?? [];
console.log("СТРУКТУРА СДЕЛКИ (одна, чтобы увидеть поля):");
console.log(" ", JSON.stringify(arrS[0]));
console.log("  всего в выдаче сделок:", arrS.length);

for (const [name, addr] of Object.entries(RIV)) {
  const nat = Number(ethers.formatEther(await provider.getBalance(addr)));
  let usdso = 0, inv = 0, parts = [];
  for (const [sym, [t, d]] of Object.entries(TOK)) {
    const c = new ethers.Contract(t, erc20, provider);
    let b = 0; try { b = Number(ethers.formatUnits(await c.balanceOf(addr), d)); } catch {}
    const px = sym === "USDso" ? 1 : (price[sym] ?? 0);
    const usd = b * px;
    if (b > 1e-9) parts.push(`${sym} ${b.toFixed(sym === "WBTC" ? 6 : 4)}≈$${usd.toFixed(1)}`);
    if (sym === "USDso") usdso = usd; else inv += usd;
  }
  const real = usdso + inv;
  console.log(`\n[${name}] ${addr.slice(0, 10)}…`);
  console.log(`  газ(SOMI) ${nat.toFixed(2)} | холдинги: ${parts.join(" | ") || "—"}`);
  console.log(`  кошелёк USDso $${usdso.toFixed(1)} | инвентарь $${inv.toFixed(1)} | РЕАЛ.КАПИТАЛ(кош+инв, без vault) $${real.toFixed(1)} | флэт-множ ≈${(real / 150).toFixed(2)}`);
}
