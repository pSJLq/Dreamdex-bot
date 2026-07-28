import { ethers } from "ethers";
const RPC="https://api.infra.mainnet.somnia.network/";
const API="https://api.dreamdex.io/v0";
const prov=new ethers.JsonRpcProvider(RPC);
const T3="0x62bb76b56984186fe99ce6221e81ecd104444d7a";
const T6="0x63a9f0c10dbd4b8f154b1bfa2b970dd06207b465";
const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;};

// 1) t3 цена: VWAP buy vs sell в тех же данных WETH
const j=await (await fetch(`${API}/markets/WETH:USDso/trades`)).json();
const arr=j.trades||[];
const froms={};
for(const grp of chunk(arr,25)){
  const res=await Promise.all(grp.map(t=>prov.send("eth_getTransactionByHash",[t.txHash]).catch(()=>null)));
  res.forEach((tx,i)=>{froms[grp[i].txHash]=(tx?.from||"?").toLowerCase();});
}
const t3trades=arr.filter(t=>froms[t.txHash]===T3);
const agg=(side)=>{let q=0,c=0;for(const t of t3trades)if(t.side===side){q+=+t.amount;c+=+t.cost;}return{q,c,vwap:q?c/q:0};};
const b=agg("buy"),s=agg("sell");
const mktVwap=arr.reduce((s,t)=>s+ +t.cost,0)/arr.reduce((s,t)=>s+ +t.amount,0);
console.log("=== t3 на WETH: цена round-trip ===");
console.log(`  рыночный VWAP: ${mktVwap.toFixed(3)}`);
console.log(`  t3 BUY  VWAP: ${b.vwap.toFixed(3)} (n=${t3trades.filter(t=>t.side==='buy').length}, vol=$${b.c.toFixed(0)})`);
console.log(`  t3 SELL VWAP: ${s.vwap.toFixed(3)} (n=${t3trades.filter(t=>t.side==='sell').length}, vol=$${s.c.toFixed(0)})`);
if(b.vwap&&s.vwap) console.log(`  >> round-trip спред BUY/SELL: ${((b.vwap/s.vwap-1)*1e4).toFixed(2)}бп (цена на ед.объёма ≈ /2 = ${((b.vwap/s.vwap-1)*1e4/2).toFixed(2)}бп)`);

// 2) t6 нонс за 3 минуты (дольше окно, вдруг был всплеск)
console.log("\n=== t6: нонс за 3 минуты ===");
let id=1; const rpc=async(m,p)=>{const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:id++,method:m,params:p})});return(await r.json()).result;};
const n1=parseInt(await rpc("eth_getTransactionCount",["0x63A9F0c10dbD4B8F154B1bFA2B970dD06207B465","latest"]),16);
console.log("нонс сейчас:",n1,"... жду 3 мин");
await new Promise(r=>setTimeout(r,180000));
const n2=parseInt(await rpc("eth_getTransactionCount",["0x63A9F0c10dbD4B8F154B1bFA2B970dD06207B465","latest"]),16);
console.log("нонс через 3мин:",n2,"Δ=",n2-n1);

// 3) t6 как контрагент: ищем его в maker/taker обеих ролях через recent WBTC тоже
const j2=await (await fetch(`${API}/markets/WBTC:USDso/trades`)).json();
const arr2=j2.trades||[];
const froms2={};
for(const grp of chunk(arr2,25)){
  const res=await Promise.all(grp.map(t=>prov.send("eth_getTransactionByHash",[t.txHash]).catch(()=>null)));
  res.forEach((tx,i)=>{froms2[grp[i].txHash]=(tx?.from||"?").toLowerCase();});
}
const t6AsTakerWBTC=arr2.filter(t=>froms2[t.txHash]===T6).length;
const t6AsTakerWETH=arr.filter(t=>froms[t.txHash]===T6).length;
console.log(`\nt6 как ТЕЙКЕР в последних 100 WETH: ${t6AsTakerWETH}, в последних 100 WBTC: ${t6AsTakerWBTC}`);
