// РАЗВЕДКА: maker/taker-микс каждого трейдера из публичных данных.
// Сделка на CLOB = tx ТЕЙКЕРА (мейкер-нога была выставлена раньше). from(txHash)=тейкер.
// Значит: доля объёма трейдера, где он sender = его ТЕЙКЕР-часть; остальное его объёма = мейкер-филлы.
const RPC="https://api.infra.mainnet.somnia.network/";
const API="https://api.dreamdex.io/v0";
let id=1;
const rpc=async(m,p)=>{const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:id++,method:m,params:p})});const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result;};
const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;};
const NAMES={
 "0x703e10344158d7c6cb943596328211a0a22422f6":"t1","0x99e98338320f0485d1fb2553dd5c85345783d1a5":"t4",
 "0x63a9f0c10dbd4b8f154b1bfa2b970dd06207b465":"t6","0x889c71f552b71bd57221d23db2c80679a7d3e6e8":"МЫ",
 "0x2445e495b563908973f2d1ba6bd564709e0cf140":"t5","0x62bb76b56984186fe99ce6221e81ecd104444d7a":"t3",
 "0x1adab5ff7a8a51681d38844aa146bf8c534f4bf1":"t7","0x95a63784c502b546f7403064e565c4251313fcbc":"t8"};
const t3="0x62bb76b56984186fe99ce6221e81ecd104444d7a";
const t3txs=[];
for(const PAIR of ["WETH:USDso","WBTC:USDso"]){
  const j=await (await fetch(`${API}/markets/${encodeURIComponent(PAIR)}/trades`)).json();
  const arr=j.trades||[];
  const froms={};
  for(const grp of chunk(arr,25)){
    const res=await Promise.all(grp.map(t=>rpc("eth_getTransactionByHash",[t.txHash]).catch(()=>null)));
    res.forEach((tx,i)=>{froms[grp[i].txHash]=(tx?.from||"?").toLowerCase();});
  }
  const spanMin=(Math.max(...arr.map(t=>t.timestamp))-Math.min(...arr.map(t=>t.timestamp)))/60000;
  const agg={};let tot=0;
  for(const t of arr){
    const f=froms[t.txHash];const n=NAMES[f]||f.slice(0,8);
    agg[n]=agg[n]||{n:0,vol:0,buy:0,sell:0};
    agg[n].n++;agg[n].vol+=+t.cost;agg[n][t.side]++;tot+=+t.cost;
    if(f===t3&&t3txs.length<6)t3txs.push({pair:PAIR,side:t.side,cost:t.cost,tx:t.txHash});
  }
  console.log(`\n=== ${PAIR}: ТЕЙКЕРЫ окна ${spanMin.toFixed(0)}мин (кто кроссит спред) ===`);
  for(const [n,a] of Object.entries(agg).sort((x,y)=>y[1].vol-x[1].vol))
    console.log(`  ${n.padEnd(9)} тейкер-сделок=${String(a.n).padStart(3)} ($${a.vol.toFixed(0).padStart(5)}, ${(100*a.vol/tot).toFixed(0)}% окна) buy=${a.buy} sell=${a.sell} → тейкер-темп ~$${(a.vol/spanMin*1440/1000).toFixed(0)}k/день`);
}
// t3 форензика: у КОГО t3 покупает (контрагент-мейкер из логов receipt)
console.log("\n=== T3: контрагенты его тейкер-сделок (адреса в логах) ===");
for(const tt of t3txs){
  const rc=await rpc("eth_getTransactionReceipt",[tt.tx]).catch(()=>null);
  if(!rc)continue;
  const found=new Set();
  for(const lg of rc.logs||[]){
    for(const top of [...(lg.topics||[]),...(lg.data?chunk(lg.data.slice(2),64).map(x=>"0x"+x):[])]){
      const hex=top.toLowerCase().replace(/^0x/,"");
      if(hex.length===64&&hex.startsWith("000000000000000000000000")){
        const addr="0x"+hex.slice(24);
        if(NAMES[addr]&&addr!==t3)found.add(NAMES[addr]);
      }
    }
  }
  console.log(`  ${tt.pair} ${tt.side} $${(+tt.cost).toFixed(0)} → контрагенты: ${[...found].join(",")||"(не из известных)"}`);
}
