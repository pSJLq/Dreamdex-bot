#!/bin/bash
# Боевой мульти-пара mm-multi.ts (trader-2). Env baked. Ключ из .env (KEY2).
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd /root/dreamdex-bot
export DRY_RUN=0
export MM_PAIRS="WETH/USDso,WBTC/USDso"
# СПРЕД-СНАЙПЕР (14 июля): чёрн узких окон = главный мотор (модель t3: 0.85бп @ 133k/день).
# Мейкер-клип меньше (капитал свободен для чёрна), чёрн расшит (floor 35→18 душил ночью: 109 циклов/9.7ч).
# Клип 25: при капитале ~$24 эффективный клип сам ужмётся кэпом freeQuote*0.9 (≈$22) — авто-адаптация.
export MM_NOTIONAL_USDSO=25
export MM_NOTIONAL_WBTC=25
export MM_CHURN_ADAPTIVE=1
# BURST-ЭРА (16 июля 16:52Z): ноги чёрна ~0.9с (предсборка обеих tx + pollingInterval 400мс) → цикл стоит
# ≈ спред гейта. Пейс 10→3с: больше дешёвых циклов (адаптив: ≤0.5бп→3с, ≤1.0бп→9с, шире→60с).
export MM_CHURN_PACE_MIN_SEC=1
# ПЕРЕТЕСТ чистого чёрна С BURST (16 июля 17:52Z): прошлый тест 1.23бп был ДО burst (ноги 2.5-15с).
# Теперь ноги 0.9с → чёрн-цикл ≈ спред гейта. Blended не падал т.к. мейкер (94% объёма) флэтит через тик.
export MM_MAKER_ENABLED=0
export MM_MAX_BID_AGE_SEC=75
export MM_REQUOTE_TRIGGER_BPS=4
export MM_GAS_FLOOR_SOMI=5
export MM_GAS_RESERVE_SOMI=15
export MM_MAX_BOOK_SPREAD_BPS=4.5
export MM_TAKER_SLACK_BPS=6
# ЭНДГЕЙМ-ЖОГ (20 июля, <22ч до Day14): гейт 0.8→2.5. Цена больше НЕ инструмент — растягивать бюджет
# некуда, иначе $14 сгорят неиспользованными. Тратим всё в объём. DQ-риск нулевой: до конца <24ч.
# Откат (если понадобится): 0.8 + floor 3 + pace 2 — бэкап predeploy-20260720T*.
export MM_CHURN_MAX_SPREAD_BPS=2.5
export MM_CHURN_SLACK_BPS=6
export MM_CHURN_DEPTH_FRAC=0.95
export MM_CHURN_AFTER_IDLE_SEC=45
export MM_CHURN_PACE_SEC=60
# ЭНДГЕЙМ 18 июля (all-in по просьбе юзера): floor 14→3 — тратим почти весь USDso в объём,
# держим лишь ~$3 на heartbeat/мини-чёрн до Day14 (ниже — бот встанет → 24ч тишины → DQ = удалят ВЕСЬ объём,
# что убьёт наш единственный путь в #2: коллапс t5/t4 при нас живых). Минимальный клип сам ужмётся по freeQuote.
export MM_QUOTE_FLOOR_USDSO=1
export MM_MAX_IDLE_SEC=720
export MM_TICK_LOOP_MS=1200
# МЕЙКЕР-ВЫХОД: ОТКЛЮЧЁН (=0). Эксперимент 14 июля: аски не наливались за TTL → темп ×0.5 без выигрыша цены.
# Код гейтован env: при 0 поведение = чистый тейкер-IOC (как до эксперимента).
export MM_EXIT_MAKER_TTL_SEC=0
export MM_EXIT_STOP_BPS=8
export MM_EXIT_MAX_INV_MULT=1.5
exec npx tsx src/mm-multi.ts
