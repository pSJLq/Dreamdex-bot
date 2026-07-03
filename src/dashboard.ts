import { createServer, Server } from "node:http";
import { Stats } from "./stats.js";

const LB_URL = "https://dreamdex-leaderboard-new.vercel.app/api/leaderboard";
const OUR = (process.env.DREAMDEX_WALLET || "0x3D3F1BCC7f4A1D3C0d2BD2E25b7dFd6AA8bE0840").toLowerCase();

export function startDashboard(port: number, stats: Stats, onPrepare?: () => Promise<void>): Server {
  const server = createServer(async (req, res) => {
    // СДАЧА: слить всё в USDso + стоп торговли (POST, чтобы не сработало случайным переходом)
    if (req.method === "POST" && req.url?.startsWith("/prepare")) {
      res.setHeader("content-type", "application/json");
      if (onPrepare) { onPrepare().catch(() => {}); res.end(JSON.stringify({ ok: true })); }
      else res.end(JSON.stringify({ ok: false, error: "not wired" }));
      return;
    }
    if (req.url?.startsWith("/stats")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(stats.snapshot()));
      return;
    }
    // РЕАЛЬНЫЕ цифры + конкуренты — проксируем официальный API лидерборда (на сервере → без CORS)
    if (req.url?.startsWith("/leaderboard")) {
      try {
        const r = await fetch(LB_URL);
        const j: any = await r.json();
        j.you = OUR;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(j));
      } catch (e) { res.statusCode = 502; res.end(JSON.stringify({ error: String((e as Error).message) })); }
      return;
    }
    // Live-поток сделок на нашей паре (контекст: какой поток мы ловим)
    if (req.url?.startsWith("/market-trades")) {
      try {
        const syms = (stats.pairs.length ? stats.pairs.map(p => p.symbol) : ["WETH/USDso"]).map(s => s.replace("/", ":"));
        const all: any[] = [];
        for (const sym of syms) {
          try {
            const r = await fetch("https://api.dreamdex.io/v0/markets/" + encodeURIComponent(sym) + "/trades");
            const j: any = await r.json();
            for (const t of (j.trades || []).slice(0, 15)) all.push({ ...t, sym: sym.split(":")[0] }); // по 15 с каждой пары
          } catch { /* пропускаем пару */ }
        }
        all.sort((a, b) => b.timestamp - a.timestamp);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ trades: all.slice(0, 30) }));
      } catch (e) { res.statusCode = 502; res.end(JSON.stringify({ error: String((e as Error).message) })); }
      return;
    }
    if (req.url?.startsWith("/export")) {
      res.setHeader("content-type", "application/json");
      res.setHeader("content-disposition", "attachment; filename=dreamdex-bot-data.json");
      res.end(JSON.stringify(stats.export(), null, 2));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(HTML);
  });
  server.listen(port, () => console.log(`[dashboard] открой в браузере → http://localhost:${port}`));
  return server;
}

const HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>dreamDEX bot</title>
<style>
:root{--bg:#0a0a0f;--card:#14141c;--bd:#26263a;--tx:#e7e9ea;--mut:#8b8b9e;--ac:#a855f7;--g:#34d399;--r:#f87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px ui-monospace,Menlo,Consolas,monospace}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
h1{font-size:16px;margin:0 0 4px}.sub{color:var(--mut);font-size:12px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px}
.card .l{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.card .v{font-size:20px;margin-top:4px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow:hidden;margin-bottom:16px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);font-size:13px}
th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase}
.buy{color:var(--g)}.sell{color:var(--r)}.acc{color:var(--ac)}
.btn{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:9px 14px;font:inherit;cursor:pointer;margin-right:8px}
.btn.sec{background:#26263a}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.on{background:var(--g)}.off{background:var(--r)}
h3{font-size:13px;color:var(--mut);margin:8px 0}
</style></head><body><div class="wrap">
<h1>🦖 dreamDEX volume bot <span id="mode" class="acc"></span></h1>
<div class="sub" id="status">подключение…</div>
<div class="grid" id="cards"></div>
<h3>🏆 Лидерборд <span id="lbsub" style="color:var(--mut);font-weight:400"></span></h3>
<table id="lb"><thead><tr><th>#</th><th>Трейдер</th><th>TX</th><th>Fills</th><th>Объём</th><th>Eff.Volume</th><th>PnL</th><th>USDso</th></tr></thead><tbody></tbody></table>
<h3>Наши пары</h3>
<table id="pairs"><thead><tr><th>Пара</th><th>Mid</th><th>Спред</th><th>Аллокация</th><th>Инвентарь $</th></tr></thead><tbody></tbody></table>
<h3>Поток рынка (live-сделки на паре)</h3>
<table id="fills"><thead><tr><th>Время</th><th>Пара</th><th>Сторона</th><th>Размер</th><th>Цена</th><th>Сумма $</th></tr></thead><tbody></tbody></table>
<button class="btn" onclick="location.href='/export'">⬇ Скачать все данные</button>
<button class="btn sec" onclick="copyData()">📋 Скопировать для Claude</button>
<button class="btn" style="background:var(--r);font-weight:700" onclick="prepareSubmit()">🛑 Слить всё в USDso + СТОП (сдача)</button>
<script>
function fmt(n,d=2){return Number(n).toLocaleString('en-US',{maximumFractionDigits:d})}
function ago(ms){const s=Math.floor((Date.now()-ms)/1000);return s<90?s+'с':Math.floor(s/60)+'м';}
async function tick(){
 let s={},lb={},mt={};
 try{s=await(await fetch('/stats')).json();}catch(e){}
 try{lb=await(await fetch('/leaderboard')).json();}catch(e){}
 try{mt=await(await fetch('/market-trades')).json();}catch(e){}
 try{
  document.getElementById('mode').textContent=s.dry?'(СИМУЛЯЦИЯ)':'(БОЕВОЙ)';
  const live=s.halted?'<span class="dot off"></span>ОСТАНОВЛЕН':'<span class="dot on"></span>РАБОТАЕТ';
  document.getElementById('status').innerHTML=live+' · режим: <b class="acc">'+(s.regime||'-')+'</b> · модули: '+((s.activeModules||[]).join('+')||'-')+' · аптайм '+(s.uptimeSec||0)+'s';
 }catch(e){}
 const traders=((lb.traders)||[]).slice().sort((a,b)=>b.volumeEffective-a.volumeEffective);
 const you=(lb.you||'').toLowerCase();
 let me=null,myRank=0;
 traders.forEach((t,i)=>{if((t.address||'').toLowerCase()===you){me=t;myRank=i+1;}});
 const gap2=(traders[1]&&me)?(traders[1].volumeEffective-me.volumeEffective):0;
 const usdsoOk=Number(s.quoteUSDso)>=Number(s.minQuoteUSDso);
 const usdsoCard='<span style="color:'+(usdsoOk?'var(--g)':'var(--r)')+'">$'+fmt(s.quoteUSDso)+'</span>';
 const pnlV=me?('<span style="color:'+(me.pnl>=0?'var(--g)':'var(--r)')+'">$'+fmt(me.pnl)+'</span>'):'—';
 const delta=Number(s.equity)-150;
 const realCard='$'+fmt(s.equity)+' <span style="font-size:12px;color:'+(delta>=0?'var(--g)':'var(--r)')+'">('+(delta>=0?'+':'')+fmt(delta)+')</span>';
 const cards=[
  ['💰 Реальный баланс (всё)', realCard],
  ['Ранг', me?('#'+myRank+' из '+traders.length):'…'],
  ['Eff.Volume', me?'$'+fmt(me.volumeEffective):'…'],
  ['Объём (raw)', me?'$'+fmt(me.volumeUsdso):'…'],
  ['PnL (лидерборд)', pnlV],
  ['USDso кошелёк (пол $'+fmt(s.minQuoteUSDso,0)+')', usdsoCard],
  ['Инвентарь в парах','$'+fmt(s.inv)],
  ['До топ-2', (myRank>2&&gap2>0)?('+$'+fmt(gap2)):'✅ в топ-2'],
  ['Газ',fmt(s.gas)+' SOMI'],
 ];
 document.getElementById('cards').innerHTML=cards.map(c=>'<div class="card"><div class="l">'+c[0]+'</div><div class="v">'+c[1]+'</div></div>').join('');
 document.getElementById('lbsub').textContent=lb.updatedAt?('· обновлён '+ago(lb.updatedAt)+' назад · ранг по Eff.Volume'):'';
 document.querySelector('#lb tbody').innerHTML=traders.map((t,i)=>{
  const mine=(t.address||'').toLowerCase()===you;
  return '<tr'+(mine?' style="background:#1e1b2e"':'')+'><td>'+(i+1)+'</td><td'+(mine?' class="acc"':'')+'>'+t.handle+(mine?' ◄ МЫ':'')+'</td><td>'+t.txCount+'</td><td>'+(t.fills||0)+'</td><td>$'+fmt(t.volumeUsdso)+'</td><td><b>$'+fmt(t.volumeEffective)+'</b></td><td class="'+(t.pnl>=0?'buy':'sell')+'">$'+fmt(t.pnl)+'</td><td>$'+fmt(t.usdsoBalance)+'</td></tr>';
 }).join('');
 try{document.querySelector('#pairs tbody').innerHTML=(s.pairs||[]).map(p=>'<tr><td>'+p.symbol+'</td><td>'+fmt(p.mid,4)+'</td><td>'+fmt(p.spreadBps,1)+' bps</td><td>'+fmt(p.allocPct,0)+'%</td><td>$'+fmt(p.invUSDso)+'</td></tr>').join('');}catch(e){}
 document.querySelector('#fills tbody').innerHTML=((mt.trades)||[]).map(f=>'<tr><td>'+new Date(f.timestamp).toLocaleTimeString()+'</td><td>'+(f.sym||'')+'</td><td class="'+(f.side==='buy'?'buy':'sell')+'">'+f.side+'</td><td>'+fmt(f.amount,5)+'</td><td>'+fmt(f.price,2)+'</td><td>$'+fmt(f.cost)+'</td></tr>').join('');
}
async function copyData(){try{const d=await(await fetch('/export')).text();await navigator.clipboard.writeText(d);alert('Скопировано! Вставь Claude в чат.')}catch(e){alert('Не вышло: '+e.message)}}
async function prepareSubmit(){if(!confirm('СЛИТЬ ВЕСЬ инвентарь (WETH/WBTC/SOMI кроме 2 на газ) в USDso и ОСТАНОВИТЬ торговлю?\\n\\nЭто для сдачи в конце. Возобновить можно только удалив файл STOPPED + рестарт.'))return;try{const r=await(await fetch('/prepare',{method:'POST'})).json();alert(r.ok?'✅ Запущено: слив инвентаря в USDso + стоп. Займёт ~30-60с — следи за балансом на дашборде/эксплорере.':'Ошибка: '+(r.error||'?'))}catch(e){alert('Ошибка запроса: '+e.message)}}
tick();setInterval(tick,3000);
</script></div></body></html>`;
