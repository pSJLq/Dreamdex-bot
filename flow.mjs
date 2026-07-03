// READ-ONLY: реальный поток сделок на парах (сколько торгуется в час = что мейкер может перехватить).
const API = "https://api.dreamdex.io/v0";
for (const sym of ["WETH:USDso", "WBTC:USDso"]) {
  const tr = await (await fetch(`${API}/markets/${encodeURIComponent(sym)}/trades`)).json();
  const arr = (tr.trades ?? tr ?? []);
  if (!arr.length) { console.log(`${sym}: нет сделок`); continue; }
  let vol = 0, buys = 0, sells = 0, bVol = 0, sVol = 0;
  let tmin = Infinity, tmax = 0;
  for (const t of arr) {
    const cost = parseFloat(t.cost ?? (parseFloat(t.amount ?? 0) * parseFloat(t.price ?? 0)));
    const ts = +(t.timestamp ?? t.createdAt ?? 0);
    vol += cost;
    if (String(t.side).toLowerCase() === "buy") { buys++; bVol += cost; } else { sells++; sVol += cost; }
    if (ts && ts < tmin) tmin = ts;
    if (ts && ts > tmax) tmax = ts;
  }
  const spanMin = (tmax - tmin) / 60000;
  const perHour = spanMin > 0 ? vol / (spanMin / 60) : 0;
  const now = Date.now();
  console.log(`\n=== ${sym} (последние ${arr.length} сделок) ===`);
  console.log(`  окно: ${spanMin.toFixed(1)} мин (последняя ${((now - tmax) / 60000).toFixed(1)} мин назад)`);
  console.log(`  объём в окне: $${vol.toFixed(0)} | ТЕМП ≈ $${perHour.toFixed(0)}/час → ~$${(perHour * 24).toFixed(0)}/сутки`);
  console.log(`  сделок buy ${buys} ($${bVol.toFixed(0)}) / sell ${sells} ($${sVol.toFixed(0)}) | средний размер $${(vol / arr.length).toFixed(1)}`);
  console.log(`  баланс потока: ${(bVol / vol * 100).toFixed(0)}% buy / ${(sVol / vol * 100).toFixed(0)}% sell`);
}
