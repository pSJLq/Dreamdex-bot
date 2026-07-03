// Разбор: −$2 это РЫНОК (переоценка инвентаря) или БОТ (покупает дорого/продаёт дёшево = реальная потеря)?
// Метод: при НИЗКОМ инвентаре рыночной экспозиции почти нет → equity ≈ чистый реализованный результат.
// Если equity-при-флэте стабильна во времени → бот в ноль (−2 это рынок). Если падает → бот сливает.
import { readFileSync } from "node:fs";
const j = JSON.parse(readFileSync("история сайта.txt", "utf8"));
const ticks = j.allTicks || [];
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// 1) выкидываем глюки чтения (equity сильно ниже медианы — те самые провалы $119/$130)
const eqMed = med(ticks.map(t => t.equity));
const clean = ticks.filter(t => t.equity > eqMed * 0.95);
console.log(`тиков всего ${ticks.length}, чистых (без глюков чтения) ${clean.length}, медиана equity $${eqMed.toFixed(2)}`);

// 2) equity при НИЗКОМ инвентаре (рыночной экспозиции почти нет) — в начале vs в конце
const lowInv = clean.filter(t => t.inv < 20).sort((a, b) => a.ts - b.ts);
if (lowInv.length >= 4) {
  const firstN = lowInv.slice(0, Math.max(3, lowInv.length >> 2));
  const lastN = lowInv.slice(-Math.max(3, lowInv.length >> 2));
  const eFirst = firstN.reduce((s, t) => s + t.equity, 0) / firstN.length;
  const eLast = lastN.reduce((s, t) => s + t.equity, 0) / lastN.length;
  const invFirst = firstN.reduce((s, t) => s + t.inv, 0) / firstN.length;
  const invLast = lastN.reduce((s, t) => s + t.inv, 0) / lastN.length;
  const mins = (lastN[0].ts - firstN[firstN.length - 1].ts) / 60000;
  console.log(`\n== EQUITY ПРИ НИЗКОМ ИНВЕНТАРЕ (чистый результат торговли) ==`);
  console.log(`  начало: equity $${eFirst.toFixed(3)} (инв ~$${invFirst.toFixed(1)})`);
  console.log(`  конец:  equity $${eLast.toFixed(3)} (инв ~$${invLast.toFixed(1)})`);
  console.log(`  >> чистый реализованный результат за ~${mins.toFixed(0)} мин = ${(eLast - eFirst >= 0 ? "+" : "")}$${(eLast - eFirst).toFixed(3)}`);
  console.log(`  (если ≈0 → бот торгует в ноль, −2 это рынок; если заметный минус → бот покупает дорого/продаёт дёшево)`);
}

// 3) насколько equity объясняется инвентарём (рынком): регрессия equity ~ inv
const n = clean.length;
const mx = clean.reduce((s, t) => s + t.inv, 0) / n, my = clean.reduce((s, t) => s + t.equity, 0) / n;
let sxy = 0, sxx = 0;
for (const t of clean) { sxy += (t.inv - mx) * (t.equity - my); sxx += (t.inv - mx) ** 2; }
const slope = sxy / sxx;
console.log(`\n== СВЯЗЬ equity С ИНВЕНТАРЁМ ==`);
console.log(`  наклон ${slope.toFixed(5)} $equity на $1 инвентаря (≈0 хорошо: инвентарь не тащит вниз; сильный минус = переоценка/слив)`);

// 4) общий диапазон
const eqs = clean.map(t => t.equity);
console.log(`\n== ДИАПАЗОН (без глюков) ==`);
console.log(`  equity min $${Math.min(...eqs).toFixed(2)}  max $${Math.max(...eqs).toFixed(2)}  старт→тек $${clean[0].equity.toFixed(2)}→$${clean[clean.length - 1].equity.toFixed(2)}`);
console.log(`  инвентарь min $${Math.min(...clean.map(t => t.inv)).toFixed(1)}  max $${Math.max(...clean.map(t => t.inv)).toFixed(1)}`);
