# dreamDEX Volume Bot — Dev Traders Program (trader-1)

Trading bot built for the dreamDEX Dev Traders Program on Somnia mainnet.
Competition KPI: trading volume (week 1 — PnL-weighted, week 2 — raw volume only).

Wallet: `0x3D3F1BCC7f4A1D3C0d2BD2E25b7dFd6AA8bE0840` (trader-1).

## Architecture

One wallet, one process, one execution queue (single nonce chain), multiple strategy modules:

```
src/bot.ts        orchestrator: tick loop, module merging, risk veto, execution queue,
                  taker pacing, inventory management, watchdog, flatten-and-stop
src/strategy.ts   strategy modules (each only *proposes* orders):
                    growth   — HarvestMaker: post-only quotes at the touch (week-1 maker mode)
                    volume   — VolumeBooster: spread-gated IOC round-trips (week-2 volume mode)
                    pickoff  — external-fair (Binance feed) mispricing taker
                    grid     — post-only ladder (optional)
src/exchange.ts   dreamDEX client: SIWE auth → JWT, REST /v0, unsigned tx → ethers sign &
                  broadcast, ERC-20 approvals, vault deposit/withdraw, order/cancel/balances,
                  network timeouts on every call, auto re-login on 401
src/risk.ts       wallet-level risk: drawdown stop, gas floor, order veto
src/regime.ts     drawdown regimes (healthy / caution / defensive) with hysteresis
src/dashboard.ts  local web dashboard :3000 — equity, volume, leaderboard proxy,
                  live market trades, one-click "flatten everything & stop"
src/stats.ts      tick/trade history for the dashboard
```

## Week-2 volume engine (the interesting part)

Raw volume per dollar of budget is `volume = budget / cost-per-$1`. The whole design
minimizes cost per $1 of volume while keeping the burn rate high enough to convert the
entire budget into volume before the deadline:

- **Spread gate** (`takerMaxSpreadBps`): IOC round-trips (buy at ask → sell at bid) fire
  only when the spread is at or below the gate, so worst-case cost = gate/2 per $1 and the
  average is well below (measured ~1.1 bps all-in including gas).
- **IOC-only taker orders**: an order either fills immediately or is cancelled by the
  exchange. Resting GTC orders can strand capital in the book escrow when price runs away
  (we hit this live: $76 locked in two stale buys) — IOC eliminates the entire failure class.
- **Pacing** (`volumePaceSec`) spreads round-trips evenly so the budget burns down to the
  equity floor right at the deadline instead of front-loading and dying early
  (continuous-activity rule: >24h without on-chain trades = disqualification).
- **Inventory discipline**: gated sells unload inventory cheaply; an ungated emergency
  flatten (`hardInventoryUSDso`) only acts as a backstop. An absolute activation minimum
  (`actMin`) prevents threshold deadlocks when the wallet shrinks late in the game.
- **Gas from own funds** (program rule 6): `convert-gas.ts` converts USDso → native SOMI
  via an IOC buy on SOMI:USDso. Gas is ~0.05–0.1 bps per $1 of volume — negligible.

## Reliability (running unattended 24/7)

- pm2 (`ecosystem.config.cjs`) with autorestart; internal watchdog exits the process if no
  successful on-chain tx for `maxIdleSec` (pm2 brings it back fresh — also an anti-DQ guard).
- Anti-deadlock sweep: if nothing is proposed for 90s, cancel any resting orders — frees
  capital that would otherwise lock the bot out of the market.
- Every network call has a timeout; a hung RPC/REST request cannot freeze the tick loop.
- JWT expiry → automatic SIWE re-login on 401.
- Empty/malformed unsigned transactions from the API are never broadcast (gas guard).
- Balance/equity reads are median-filtered; risk acts on trusted equity only, so a flaky
  REST read cannot trigger a false stop.
- `autoheal.sh` (cron, server-side): no fills for 25 min → `pm2 restart dreamdex`.

## Running

```bash
npm install
cp config.example.json config.json     # tune pairs/clip/pace/gates
cp .env.example .env                   # add the funded wallet key (never commit .env)
npm run dry                            # DRY_RUN=1 mock — no real orders
npm start                              # live
```

Dashboard: http://localhost:3000 (set `dashboardPort` in config). On a VPS keep the port
closed and use an SSH tunnel: `ssh -L 3000:localhost:3000 user@host`.

## Ops / analysis tooling

- `reconcile.mjs` — true balance: wallet + vault + open orders + inventory (leaderboard PnL
  only sees wallet USDso, so this is the source of truth).
- `rivals-now.mjs` — all competitors: on-chain holdings, real capital, cost per $1 of volume.
- `flow.mjs`, `quotecheck.mjs`, `investigate.mjs`, `analyze-*.mjs` — market flow, quote
  placement vs touch, competitor holdings, PnL decomposition.
- `check.py` — one-shot health check of the VPS deployment (log counters + leaderboard).
- `DEPLOY.md`, `deploy-vps.sh`, `run-forever.bat` — deployment notes and runners.

## API findings we hit along the way (feedback)

- Wallet-funded **resting** limit orders revert; resting liquidity needs the vault flow
  (`vault/deposit` + `fundingSource: "vault"`). Wallet auto-pull works for immediate orders.
- Fills/cancels deliver proceeds back to the **wallet** by default, even for vault-funded
  orders — the simplest continuous setup is wallet-funded + ERC-20 approvals.
- SOMI:USDso sells require `msg.value` equal to the sell amount (wrapped-native base);
  the API returns the unsigned tx with `value: 0`, so the client fills it in.
- The API occasionally returns an empty `transaction.data` under load — broadcasting it
  burns ~1.1M gas on a guaranteed revert; the client refuses to send empty payloads.
- Leaderboard `usdsoBalance`/PnL counts only wallet USDso — capital sitting in the vault,
  in open orders, or in inventory shows up as negative PnL until flattened.
