# -*- coding: utf-8 -*-
# Проверка здоровья бота на сервере: свежий лог, счётчики проблем, лидерборд.
# Запуск:  python check.py     (из папки бота)
# Креды берутся из .env рядом и В ЧАТ/ВЫВОД НЕ ПЕЧАТАЮТСЯ.
import sys, os, json, urllib.request
try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass
try:
    import paramiko
except ImportError:
    print("Нет модуля paramiko. Установи:  python -m pip install paramiko"); sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
def load_env(p):
    e = {}
    for line in open(p, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1); e[k.strip()] = v.strip().strip('"').strip("'").rstrip("\r")
    return e
env = load_env(os.path.join(HERE, ".env"))
ip, login, passwd = env.get("IP"), env.get("LOGIN") or "root", env.get("PASS")
if not ip or not passwd:
    print("В .env нет IP/PASS"); sys.exit(1)

cli = paramiko.SSHClient(); cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(ip, 22, login, passwd, timeout=25, look_for_keys=False, allow_agent=False)
REMOTE = r"""
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
L="$HOME/.pm2/logs/dreamdex-out.log"
echo "=== последние строки (equity / ORDER / FILL / проблемы) ==="
grep -E "equity=|ORDER |FILL\[|пол |RISK STOP|глюк|tick error|exceeds" "$L" | tail -10
echo "=== счётчики за текущий лог ==="
printf "  RISK STOP  : %s\n" "$(grep -c 'RISK STOP' "$L")"
printf "  ниже пола  : %s\n" "$(grep -c 'ниже пола' "$L")"
printf "  глюк чтения: %s\n" "$(grep -c 'глюк чтения' "$L")"
printf "  FILL       : %s\n" "$(grep -c 'FILL\[' "$L")"
printf "  ORDER      : %s\n" "$(grep -c 'ORDER ' "$L")"
printf "  ошибки     : %s\n" "$(grep -cE 'tick error|exceeds balance|uncaught' "$L")"
pm2 jlist 2>/dev/null | python3 -c "import sys,json,time;d=json.load(sys.stdin)[0];e=d['pm2_env'];print('=== pm2:', e['status'],'| uptime', int((time.time()*1000-e['pm_uptime'])/1000),'сек | рестартов', e['restart_time'],'===')" 2>/dev/null || pm2 list
"""
print(cli.exec_command(REMOTE, timeout=40)[1].read().decode("utf-8", "ignore"))
cli.close()

try:
    d = json.load(urllib.request.urlopen("https://dreamdex-leaderboard-new.vercel.app/api/leaderboard", timeout=15))
    rows = sorted(d["traders"], key=lambda t: -t["volumeEffective"])
    print("=== ЛИДЕРБОРД (live, по eff) — помни: usdso тут = ТОЛЬКО кошелёк, без ордеров/инвентаря ===")
    for i, t in enumerate(rows, 1):
        me = "  <–– МЫ" if t["address"].lower().startswith("0x3d3f") else ""
        print(f"  {i}. {t['handle']:8} eff={t['volumeEffective']:>9.0f}  raw={t['volumeUsdso']:>9.0f}  usdso={t['usdsoBalance']:>6.1f}  pnl={t['pnl']:>7.1f}  tx={t['txCount']}{me}")
except Exception as ex:
    print("лидерборд недоступен:", ex)
