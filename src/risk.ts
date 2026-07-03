// Риск-менеджер УРОВНЯ КОШЕЛЬКА. Последнее слово за ним: видит весь кошелёк
// (equity/инвентарь/газ через все пары) и может зарубить/урезать ордера любого модуля.

import { DesiredOrder } from "./strategy.js";

export interface RiskConfig { maxDrawdownPct: number; maxInventoryUSDso: number; gasFloorSOMI: number; }

export class RiskManager {
  startEquity = 0;
  halted = false;
  private breaches = 0;
  constructor(private cfg: RiskConfig) {}

  // bot.ts подаёт сюда УЖЕ очищенный от глюков чтения equity (trustedEquity) → здесь только РЕАЛЬНЫЕ пороги.
  assess(equity: number, gasSOMI: number): { ok: boolean; reason?: string } {
    if (!this.startEquity) this.startEquity = equity;
    // Газ-пол — ЕДИНСТВЕННАЯ надёжная причина паузы (нативный SOMI читается с ончейна, без REST-глюков).
    if (gasSOMI <= this.cfg.gasFloorSOMI) return { ok: false, reason: `мало газа ${gasSOMI.toFixed(2)} SOMI` };
    // Катастрофический РЕАЛЬНЫЙ слив. При maxDrawdownPct=90 практически не срабатывает —
    // тело бережёт ПОЛ (sell-only) + ЛИМИТ ИНВЕНТАРЯ, а не жёсткий halt (halt = простой = риск DQ).
    const dd = (1 - equity / this.startEquity) * 100;
    if (dd >= this.cfg.maxDrawdownPct) {
      this.breaches++;
      if (this.breaches >= 3) { this.halted = true; return { ok: false, reason: `drawdown ${dd.toFixed(1)}% ×3 → СТОП` }; }
      return { ok: false, reason: `drawdown ${dd.toFixed(1)}% — наблюдаю (${this.breaches}/3)` };
    }
    this.breaches = 0;
    return { ok: true };
  }

  // PEG-GUARD: стоп, если USDso ушёл от $1 больше допустимого (новый стейбл = риск депега).
  pegGuard(usdsoUsd: number, tolPct: number): boolean {
    if (Math.abs(usdsoUsd - 1) * 100 > tolPct) { this.halted = true; return false; }
    return true;
  }

  // Глобальный нетинг инвентаря: режем ордера, что усугубляют уже пробитый лимит.
  filter(orders: DesiredOrder[], globalInvUSDso: number): DesiredOrder[] {
    if (Math.abs(globalInvUSDso) <= this.cfg.maxInventoryUSDso) return orders;
    return orders.filter(o => {
      if (globalInvUSDso > 0 && o.side === "buy") return false;   // уже перелонг → не докупаем
      if (globalInvUSDso < 0 && o.side === "sell") return false;  // уже перешорт → не допродаём
      return true;
    });
  }
}
