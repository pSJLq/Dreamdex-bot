// Быстрая проверка машины режимов (запуск: tsx src/regime.test.ts).
import { RegimeManager } from "./regime.js";

const rm = new RegimeManager({ cautionDrawdownPct: 4, defensiveDrawdownPct: 9, cautionClipMult: 0.6, defensiveClipMult: 0.3 });
for (const dd of [0, 2, 5, 8, 11, 7, 5, 1]) {
  const r = rm.update(dd);
  console.log(`dd=${String(dd).padStart(2)}% -> режим=${r.padEnd(9)} | модули=${[...rm.activeModules()].join("+").padEnd(20)} | clip×${rm.clipMult()}`);
}
