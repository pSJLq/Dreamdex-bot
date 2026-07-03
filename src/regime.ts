// Адаптивный режим под состояние капитала: чем глубже просадка, тем меньше риска.
// healthy → все модули; caution → выключаем чистый объём (он жжёт капитал), оставляем earn;
// defensive → только growth (чистый заработок). Гистерезис, чтобы не дёргалось на границе.

export interface RegimeConfig {
  cautionDrawdownPct: number;
  defensiveDrawdownPct: number;
  cautionClipMult: number;
  defensiveClipMult: number;
}
export type Regime = "healthy" | "caution" | "defensive";

export class RegimeManager {
  private current: Regime = "healthy";
  private readonly hysteresis = 2; // нужно восстановиться на 2% лучше порога, чтобы шагнуть вверх
  constructor(private cfg: RegimeConfig) {}

  update(ddPct: number): Regime {
    const { cautionDrawdownPct: C, defensiveDrawdownPct: D } = this.cfg;
    const h = this.hysteresis;
    switch (this.current) {
      case "healthy":
        if (ddPct >= D) this.current = "defensive";
        else if (ddPct >= C) this.current = "caution";
        break;
      case "caution":
        if (ddPct >= D) this.current = "defensive";
        else if (ddPct < C - h) this.current = "healthy";
        break;
      case "defensive":
        if (ddPct < C - h) this.current = "healthy";
        else if (ddPct < D - h) this.current = "caution";
        break;
    }
    return this.current;
  }

  activeModules(): Set<string> {
    if (this.current === "healthy") return new Set(["grid", "growth", "volume", "pickoff"]);
    if (this.current === "caution") return new Set(["grid", "growth", "pickoff"]); // глушим чистый объём
    return new Set(["grid", "growth"]);                                            // defensive: грид+earn
  }

  clipMult(): number {
    if (this.current === "healthy") return 1;
    if (this.current === "caution") return this.cfg.cautionClipMult;
    return this.cfg.defensiveClipMult;
  }
}
