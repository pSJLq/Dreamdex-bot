// Диагностика ОДНОГО тейкер-слива WETH (старый кошелёк держит ~$15 WETH после теста).
// Показывает: симуляция success? отправка? receipt status? исполнилось (OrderFilled)?  Запуск на VPS через tsx.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
loadEnv({ path: fileURLToPath(new URL("./.env", import.meta.url)) });

const RPC = "https://api.infra.mainnet.somnia.network/";
const POOL = "0xa936da11B57b50A344e1293AAaE5232885ea2bDE"; // WETH:USDso
const WETH = "0x936ab8c674bcb567cd5deb85d8a216494704e9d8";
const TOPIC_FILLED = "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399";
const KEY = process.env.DREAMDEX_PRIVATE_KEY!; // старый кошелёк (полигон)
const ABI = [
  "function placeOrder(bool isBid,uint64 userData,uint256 price,uint256 quantity,uint64 expireTimestampNs,uint8 orderType,uint8 selfMatchingOption,address builder,uint96 builderFeeBpsTimes1k) payable returns (bool success,uint128 orderId)",
  "function getBookLevels(bool isBid,uint64 numLevels) view returns (tuple(uint256 price,uint256 quantity)[])",
  "function getAutoPullRequirement(address owner,bool isBid,uint256 price,uint256 quantity,uint96 b) view returns (address inputToken,uint256 requiredAmount,uint256 delta)",
];
const ERC = ["function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)", "function balanceOf(address) view returns(uint256)"];

(async () => {
  const p = new ethers.JsonRpcProvider(RPC);
  const w = new ethers.Wallet(KEY, p);
  const pool = new ethers.Contract(POOL, ABI, w);
  const weth = new ethers.Contract(WETH, ERC, w);
  const addr = w.address;
  console.log("кошелёк", addr);

  const bal: bigint = await weth.balanceOf(addr);
  console.log("WETH баланс", ethers.formatUnits(bal, 18));
  const bids = await pool.getBookLevels(true, 3n);
  const bestBid = Number(ethers.formatUnits(bids[0][0], 18));
  console.log("bestBid", bestBid, "| уровней бида", bids.length);

  const lot = 10n ** 14n; // 0.0001 WETH
  let qtyRaw = (bal / lot) * lot;
  const limit = bestBid * (1 - 3e-4);
  const priceRaw = (BigInt(Math.floor(limit * 100)) * (10n ** 16n)); // tick 0.01 → *1e16 (18dec quote)
  console.log("продаём qty", ethers.formatUnits(qtyRaw, 18), "@ лимит", limit.toFixed(4));

  const [inTok, reqAmt] = await pool.getAutoPullRequirement(addr, false, priceRaw, qtyRaw, 0n);
  console.log("autopull inputToken", inTok, "requiredAmount", ethers.formatUnits(reqAmt, 18), "(должен быть WETH)");
  const allow: bigint = await weth.allowance(addr, POOL);
  console.log("allowance WETH→pool", ethers.formatUnits(allow, 18));
  if (allow < qtyRaw) { console.log("аппрувим WETH…"); const t = await weth.approve(POOL, qtyRaw * 8n, { gasPrice: 12n * 10n ** 9n }); await t.wait(1); console.log("approve mined"); }

  const expireNs = (BigInt(Date.now()) + 3600000n) * 1_000_000n;
  const args = [false, 0n, priceRaw, qtyRaw, expireNs, 2, 0, ethers.ZeroAddress, 0n]; // IOC sell, selfMatch cancelTaker
  try {
    const sim = await pool.placeOrder.staticCall(...args, { value: 0n });
    console.log("СИМУЛЯЦИЯ success=", sim[0], "orderId=", sim[1]?.toString());
  } catch (e) { console.log("СИМУЛЯЦИЯ РЕВЕРТ:", (e as Error).message.slice(0, 160)); }

  const nonce = await p.getTransactionCount(addr, "latest");
  console.log("шлём с nonce(latest)=", nonce, "gasPrice=12gwei gasLimit=1.5M");
  try {
    const tx = await pool.placeOrder(...args, { value: 0n, gasLimit: 1_500_000n, gasPrice: 12n * 10n ** 9n, nonce });
    console.log("tx hash", tx.hash, "— ждём receipt (до 90с)…");
    const rc = await tx.wait(1, 90_000);
    console.log("RECEIPT status", rc.status, "| логов", rc.logs.length, "| gasUsed", rc.gasUsed.toString());
    const filled = rc.logs.some((l: any) => (l.topics?.[0] ?? "").toLowerCase() === TOPIC_FILLED);
    console.log("OrderFilled в логах?", filled);
  } catch (e) { console.log("ОТПРАВКА/WAIT ОШИБКА:", (e as Error).message.slice(0, 160)); }

  const bal2: bigint = await weth.balanceOf(addr);
  console.log("WETH баланс ПОСЛЕ", ethers.formatUnits(bal2, 18), "| продано", ethers.formatUnits(bal - bal2, 18));
  process.exit(0);
})();
