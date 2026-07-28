// Стратегии-МОДУЛИ. Каждый только ПРЕДЛАГАЕТ ордера; оркестратор их мёржит,
// режет под общий риск и шлёт через единое исполнение (один nonce).

import { OrderBook, Side } from "./exchange.js";

export interface DesiredOrder { symbol: string; side: Side; price: number; size: number; postOnly: boolean; tag: string; }
export interface StratCtx { symbol: string; ob: OrderBook; invUSDso: number; quoteUSDso: number; clipUSDso: number; fair?: number; vaultBaseUSDso?: number; tick?: number; fairFresh?: boolean; }
export interface Strategy { name: string; enabled: boolean; propose(ctx: StratCtx): DesiredOrder[]; }

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// 1) Harvest Maker (имя модуля "growth"): стоит НА КАСАНИИ стакана (top-of-book) post-only,
//    чтобы реально ловить чужой тейкер-поток (соперники-тейкеры бьют НАС → объём + спред в плюс).
//    Прошлая версия котировала ВНУТРИ спреда позади системного MM → 0 филлов; и скос задавливал
//    sell под бид → postOnly кроссил → API возвращал пустую tx → дедлок. Здесь обе беды убраны:
//    - котируем у лучшего бида/аска (+leadTicks внутрь, но НИКОГДА не кроссим → postOnly валиден);
//    - вместо ценового скоса — ГЕЙТ по инвентарю (перелонг → не докупаем, только продаём);
//    - ПРОФИТ-ГАРД 0/+: при свежем внешнем фэйре покупаем только ниже fair, продаём только выше.
export class HarvestMaker implements Strategy {
  name = "growth";
  // leadTicks: на сколько тиков зайти внутрь спреда (0=join лучшего, 1=стать лучшим). minEdgeBps: мин. край vs fair.
  // softInvUSDso: порог инвентаря, выше которого НЕ докупаем (только продаём) → инвентарь тянется к нулю.
  // spreadBps: мин. отступ КАЖДОЙ котировки от мида (анти-adverse-selection). 0 = у касания (макс объём, макс bleed);
  // >0 = котируем глубже/шире → реже филлы, но больше спреда за филл → меньше «отрицательной гаммы» (защита тела).
  constructor(public enabled: boolean, private leadTicks: number, private minEdgeBps: number, private softInvUSDso: number, private spreadBps = 0, private skewBps = 0) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    const ob = c.ob;
    if (!(ob.bid > 0 && ob.ask > ob.bid)) return out;                 // нет вменяемого стакана → молчим
    const tick = c.tick && c.tick > 0 ? c.tick : ob.mid * 1e-4;        // шаг цены (фолбэк ~1bp)
    const lead = Math.max(0, this.leadTicks) * tick;                   // насколько зайти внутрь спреда
    // ЦЕНТР котировок: скорректированный fair (Binance + базис, считается в боте) если свежий — иначе mid dreamDEX.
    // Центрируясь на ЖИВОЙ цене, мы оттягиваем «подставленную» сторону от рынка → меньше stale-пикоффа (adverse selection).
    const center = (c.fairFresh && c.fair && c.fair > 0) ? c.fair : ob.mid;
    const half = Math.max(center * Math.max(0, this.spreadBps) * 1e-4, tick);  // полуспред от центра (мин 1 тик)
    // Норма — у касания; но если центр уехал ВВЕРХ (рост) → аск поднимается ВЫШЕ касания (не продаём дёшево);
    // если ВНИЗ (падение) → бид опускается НИЖЕ касания (не ловим нож). Никогда не кроссим (postOnly валиден).
    let bid = Math.min(center - half, ob.bid + lead, ob.ask - tick);
    let ask = Math.max(center + half, ob.ask - lead, ob.bid + tick);
    if (!(ask > bid)) { bid = ob.bid; ask = ob.ask; }                  // спред = 1 тик → просто join
    // СКОС ПО ИНВЕНТАРЮ (market-neutral): перелонг → ОБЕ котировки ВНИЗ. ask опускается к биду = агрессивный
    // МЕЙКЕР-селл (сбрасываем инвентарь, ловя спред, БЕЗ тейкер-кросса); bid ниже = докупаем реже/дешевле.
    // Тянет инвентарь к нулю → баланс перестаёт зависеть от движения цены. НЕ кроссим (ask ≥ лучший бид + тик).
    if (this.skewBps > 0 && c.invUSDso > 0) {
      const invRatio = clamp(c.invUSDso / Math.max(this.softInvUSDso, 1), 0, 1);
      const skew = this.skewBps * 1e-4 * invRatio;
      ask = Math.max(ask * (1 - skew), ob.bid + tick);
      bid = bid * (1 - skew);
    }
    // ГЕЙТ ПО ИНВЕНТАРЮ (без ценового кросса): перелонг → стоп покупки; короткой стороны на споте нет
    const overLong = c.invUSDso >= this.softInvUSDso;
    const sizeFor = (availUSD: number) => Math.min(c.clipUSDso, Math.max(0, availUSD) * 0.9) / ob.mid;
    if (!overLong && c.quoteUSDso > 1) {                               // покупка базы за свободный USDso
      const sz = sizeFor(Math.min(c.quoteUSDso, c.clipUSDso));
      if (sz > 0) out.push({ symbol: c.symbol, side: "buy", price: bid, size: sz, postOnly: true, tag: this.name });
    }
    // wallet-funded мейкер продаёт базу ИЗ КОШЕЛЬКА → продаваемое = ВЕСЬ инвентарь пары (cancelAll перед
    // переколом освобождает её из висящих ордеров). vaultBaseUSDso тут ≈0 (это vault+ордера), использовать его нельзя.
    const sellableUSD = c.invUSDso;
    if (sellableUSD > 1) {                                             // продажа имеющейся базы за USDso
      const sz = sizeFor(Math.min(sellableUSD, c.clipUSDso));
      if (sz > 0) out.push({ symbol: c.symbol, side: "sell", price: ask, size: sz, postOnly: true, tag: this.name });
    }
    return out;
  }
}
// псевдоним для совместимости со старым импортом
export { HarvestMaker as CapitalGrowthMaker };

// 2) Volume Booster: КРОССИТ спред (тейкер) → объём против РЕАЛЬНОГО стакана.
//    self-cross НЕВОЗМОЖЕН: dreamDEX запрещает self-trading (одна сторона всегда отменяется),
//    поэтому объём = только сделки с чужими ордерами. Берём по ask/bid (по рынку).
//    Стоит спреда → на тонком стакане дёшево; разгоняется только когда есть чужая ликвидность.
export class VolumeBooster implements Strategy {
  name = "volume";
  // maxSpreadBps: кроссим ТОЛЬКО когда спред ≤ этого (0 = без ограничения). Цена тейкера = спред/2,
  // поэтому узкий спред = дешёвый объём (держим стоимость/объём НИЖЕ соперников); широкий пропускаем (ждём узкий).
  constructor(public enabled: boolean, private maxSpreadBps = 0) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    const spreadBps = c.ob.mid > 0 ? (c.ob.ask - c.ob.bid) / c.ob.mid * 1e4 : 1e9;
    if (this.maxSpreadBps > 0 && spreadBps > this.maxSpreadBps) return out;        // спред дорогой → НЕ кроссим сейчас (ждём узкий → цена ниже)
    const half = c.clipUSDso * 0.5;                                                // целевой порог активации — полклипа…
    // …но НЕ выше абсолютного минимума $7: порог «строго полклипа» замораживал хвосты капитала
    // (2 июля: inv $28 < half $30 «нельзя продать» + buyable ~$29 < $30 «нельзя купить» = часы простоя;
    //  5 июля: minQuoteUSDso придавил buyable к $11.94 < 12 → 11ч клина). $7 = минимум над биржевым
    //  minQuantity WBTC (~$6.2) → мёртвая зона отодвинута к ~$14 USDso, дальше ордера всё ещё валидны.
    const actMin = Math.min(half, 7);
    const sizeFor = (availUSD: number) => Math.min(c.clipUSDso, availUSD * 0.95) / c.ob.mid; // размер под доступное (запас 5%)
    if (c.quoteUSDso >= actMin) out.push({ symbol: c.symbol, side: "buy",  price: c.ob.ask, size: sizeFor(c.quoteUSDso), postOnly: false, tag: this.name }); // есть USDso → берём аск
    if (c.invUSDso  >= actMin) out.push({ symbol: c.symbol, side: "sell", price: c.ob.bid, size: sizeFor(c.invUSDso),   postOnly: false, tag: this.name }); // есть база → бьём бид
    return out;                                                                    // не покупаем без USDso и не продаём без базы → нет ревертов и дрейфа
  }
}

// 3) Pick-Off / мини-АРБИТРАЖ: сравниваем стакан dreamDEX с ВНЕШНИМ фэйром (фид Binance ETH/BTC).
//    Стакан отстал от рынка (ask дешевле фэйра / bid дороже) → бьём тейкером → ПРИБЫЛЬНЫЙ объём (mult>1).
//    fair приходит из бота (c.fair); если фида нет — c.fair=undefined → сравнение с ob.mid → не сработает (безопасно).
export class PickOff implements Strategy {
  name = "pickoff";
  constructor(public enabled: boolean, private edgeBps: number, private clipMult: number) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    if (!(c.fairFresh && c.fair && c.fair > 0)) return out;       // без СВЕЖЕГО внешнего фэйра pickoff не торгует
    const fair = c.fair;                                          // внешний фэйр (Binance), точно свежий
    const want = c.clipUSDso * this.clipMult;
    const e = this.edgeBps * 1e-4;
    if (c.ob.ask < fair * (1 - e) && c.quoteUSDso > 1)           // dreamDEX дешевле рынка → ПОКУПАЕМ (есть USDso)
      out.push({ symbol: c.symbol, side: "buy",  price: c.ob.ask, size: Math.min(want, c.quoteUSDso * 0.95) / c.ob.mid, postOnly: false, tag: this.name });
    if (c.ob.bid > fair * (1 + e) && c.invUSDso > 1)             // dreamDEX дороже рынка → ПРОДАЁМ (есть база)
      out.push({ symbol: c.symbol, side: "sell", price: c.ob.bid, size: Math.min(want, c.invUSDso * 0.95) / c.ob.mid, postOnly: false, tag: this.name });
    return out;
  }
}

// 4) Grid: лесенка post-only ордеров — покупки НИЖЕ мида, продажи ВЫШЕ. Зарабатывает на колебаниях
//    (купил дёшево / продал дорого = шаг сетки в плюс) + объём. Маркер → спред не теряем, не кроссит.
//    Риск — сильный тренд (копит инвентарь); гасится лимитом инвентаря + стоп-просадкой (risk.ts).
export class GridMaker implements Strategy {
  name = "grid";
  constructor(public enabled: boolean, private levels: number, private stepBps: number, private maxInvUSDso: number) {}
  propose(c: StratCtx): DesiredOrder[] {
    const out: DesiredOrder[] = [];
    const step = this.stepBps * 1e-4;
    const perLevel = c.clipUSDso / Math.max(1, this.levels);     // делим клип на уровни
    const invRatio = c.invUSDso / this.maxInvUSDso;
    const tooLong = invRatio > 0.8, tooShort = invRatio < -0.8;  // у краёв лимита не добавляем в перекос
    let quoteLeft = c.quoteUSDso, baseLeft = c.invUSDso;
    for (let i = 1; i <= this.levels; i++) {
      if (!tooLong && quoteLeft >= perLevel * 0.5) {             // покупка ниже мида (i-й уровень)
        out.push({ symbol: c.symbol, side: "buy", price: c.ob.mid * (1 - i * step), size: Math.min(perLevel, quoteLeft * 0.95) / c.ob.mid, postOnly: true, tag: this.name });
        quoteLeft -= perLevel;
      }
      if (!tooShort && baseLeft >= perLevel * 0.5) {             // продажа выше мида (i-й уровень)
        out.push({ symbol: c.symbol, side: "sell", price: c.ob.mid * (1 + i * step), size: Math.min(perLevel, baseLeft * 0.95) / c.ob.mid, postOnly: true, tag: this.name });
        baseLeft -= perLevel;
      }
    }
    return out;
  }
}
