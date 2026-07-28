# -*- coding: utf-8 -*-
# Снапшот "стоимости объёма" для замера МАРЖИНАЛЬНОЙ цены между двумя моментами.
# Метод: точный капитал через reconcile.mjs на VPS (учитывает USDso в открытых
# ордерах — джиттера нет) + сырой объём с лидерборда. Запусти дважды с интервалом
# (напр. утром) → скрипт сам посчитает Δкапитал/Δобъём = маржинальная цена в бп.
#
# Запуск:  python costsnap.py
# Хранилище: cost-snapshots.json (рядом, в проекте — переживает смену сессии).
import sys, os, re, json, time, urllib.request, urllib.parse
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
try:
    import paramiko
except ImportError:
    print("нет paramiko: pip install paramiko"); sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "cost-snapshots.json")
OUR = "0x889c71f552B71Bd57221d23dB2c80679a7d3E6E8"
OURL = OUR.lower()
RPC = "https://api.infra.mainnet.somnia.network/"
API = "https://api.dreamdex.io/v0"
LB  = "https://dreamdex-leaderboard-total.vercel.app/api/leaderboard"

def env(k):
    for line in open(os.path.join(HERE, ".env"), encoding="utf-8", errors="replace"):
        line = line.strip()
        if line.startswith(k + "="):
            return line.split("=", 1)[1].strip()
    return None

def get_json(url, data=None, timeout=20):
    hdr = {"content-type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=hdr, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def price(sym):
    try:
        j = get_json(f"{API}/markets/{urllib.parse.quote(sym, safe='')}/trades")
        arr = j.get("trades", j) if isinstance(j, dict) else j
        return float(arr[0]["price"]) if arr else 0.0
    except Exception as e:
        print("price err", sym, e); return 0.0

def reconcile_vps():
    ip, login, pw = env("IP"), env("LOGIN") or "root", env("PASS")
    c = paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(ip, username=login, password=pw, timeout=25)
    def run(cmd, t=120):
        _i, o, e = c.exec_command(cmd, timeout=t)
        return o.read().decode("utf-8", "replace"), e.read().decode("utf-8", "replace")
    out, err = run("bash -lc 'cd /root/dreamdex-bot && source ~/.nvm/nvm.sh 2>/dev/null; node reconcile.mjs' 2>&1")
    svod, _ = run("grep -aE 'СВОДКА|объём_сумма' /root/.pm2/logs/dreamdex-mm-out.log 2>/dev/null | tail -1")
    c.close()
    def g(pat, s=out):
        m = re.search(pat, s); return float(m.group(1)) if m else None
    rec = {
        "realCapital": g(r"РЕАЛЬНЫЙ КАПИТАЛ[^$]*\$([0-9.]+)"),
        "walletUSDso": g(r"USDso в кошельке[^$]*\$([0-9.]+)"),
        "inOrders":    g(r"заперт в buy-ордерах:\s*\$([0-9.]+)"),
        "vault":       g(r"USDso в vault:\s*\$([0-9.]+)"),
        "inventory":   g(r"ВСЕГО инвентарь:\s*\$([0-9.]+)"),
        "gasSOMI":     g(r"Газ \(нативн\. SOMI\):\s*([0-9.]+)"),
    }
    m = re.search(r"объём_сумма=\$([0-9]+)", svod)
    rec["botCumVolume"] = int(m.group(1)) if m else None
    if rec["realCapital"] is None:
        rec["_raw"] = out[-800:]
    return rec

def main():
    prices = {"WETH": price("WETH:USDso"), "WBTC": price("WBTC:USDso"), "SOMI": price("SOMI:USDso") or 0.1}
    lb = get_json(LB)
    me = next((t for t in lb.get("traders", []) if t.get("address", "").lower() == OURL), None)
    nonce = int(get_json(RPC, {"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionCount", "params": [OUR, "latest"]})["result"], 16)
    rec = reconcile_vps()

    somi = prices["SOMI"] or 0.1
    start = 150 + 50 * somi
    gasUSD = (rec["gasSOMI"] or 0) * somi
    totalAssets = (rec["realCapital"] or 0) + gasUSD
    volRaw = float(me["volumeUsdso"]) if me else None
    allTime_bp = (start - totalAssets) / volRaw * 1e4 if volRaw else None

    snap = {
        "ts_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "epoch": int(time.time()),
        "address": OUR,
        "prices": prices,
        "nonce": nonce,
        "leaderboard": {
            "volumeRaw": volRaw,
            "txCount": me.get("txCount") if me else None,
            "usdsoBalance": me.get("usdsoBalance") if me else None,
            "pnl": me.get("pnl") if me else None,
            "updatedAt": lb.get("updatedAt"),
        },
        "reconcile": rec,
        "derived": {"start": round(start, 2), "gasUSD": round(gasUSD, 2),
                    "totalAssets": round(totalAssets, 2), "spent": round(start - totalAssets, 2),
                    "allTime_bp": round(allTime_bp, 3) if allTime_bp else None},
    }

    snaps = json.load(open(STORE, encoding="utf-8")) if os.path.exists(STORE) else []
    snaps.append(snap)
    json.dump(snaps, open(STORE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print("=" * 64)
    print(f"СНАПШОТ #{len(snaps)}  {snap['ts_utc']}")
    print(f"  реальный капитал: ${rec['realCapital']}  (кош ${rec['walletUSDso']} + ордера ${rec['inOrders']} + vault ${rec['vault']} + инв ${rec['inventory']})")
    print(f"  газ: {rec['gasSOMI']} SOMI (${gasUSD:.2f})   ВСЕГО активов: ${totalAssets:.2f}")
    print(f"  объём(лидерборд): {volRaw}   nonce: {nonce}   цены WETH {prices['WETH']} WBTC {prices['WBTC']} SOMI {somi}")
    print(f"  >> ЦЕНА ЗА ВСЁ ВРЕМЯ = {snap['derived']['allTime_bp']} бп  (потрачено ${snap['derived']['spent']} из ${snap['derived']['start']})")

    if len(snaps) >= 2:
        p = snaps[-2]
        dAssets = p["derived"]["totalAssets"] - totalAssets   # >0 = потрачено за окно
        dVol = volRaw - p["leaderboard"]["volumeRaw"]
        dHrs = (snap["epoch"] - p["epoch"]) / 3600
        marg = dAssets / dVol * 1e4 if dVol else None
        print("-" * 64)
        print(f"МАРЖИНАЛ между #{len(snaps)-1} и #{len(snaps)} (за {dHrs:.1f}ч):")
        print(f"  Δкапитал(потрачено) = ${dAssets:.2f}   Δобъём = {dVol:,.0f}   темп = {dVol/dHrs:,.0f}/ч")
        print(f"  >> ЦЕНА СЕЙЧАС (маржинальная) = {marg:.3f} бп" if marg else "  (Δобъём=0)")
    else:
        print("-" * 64)
        print("Это точка №1. Запусти скрипт ещё раз позже (утром) → покажет маржинальную цену за окно.")
    print("=" * 64)

if __name__ == "__main__":
    main()
