# -*- coding: utf-8 -*-
# Деплой боевого mm-multi.ts + run-multi.sh на VPS с ABORT-ГАРДОМ по адресу (==0x889c) и предеплой-бэкапом.
# Запуск: python deploy_multi.py --go   (без --go — только гард+dry, ничего не трогает)
import sys, os, hashlib, paramiko
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE=os.path.dirname(os.path.abspath(__file__))
GO="--go" in sys.argv
EXPECT_ADDR="0x889c71f552B71Bd57221d23dB2c80679a7d3E6E8".lower()
NODE="/root/.nvm/versions/node/v20.20.2/bin/node"
PM2 =f"{NODE} /root/.nvm/versions/node/v20.20.2/bin/pm2"

def envv(k):
    for line in open(os.path.join(HERE,".env"),encoding="utf-8",errors="replace"):
        line=line.strip()
        if line.startswith(k+"="): return line.split("=",1)[1].strip()
    return None

c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(envv("IP"), username=envv("LOGIN") or "root", password=envv("PASS"), timeout=25)
def run(cmd,t=120):
    _i,o,e=c.exec_command(cmd,timeout=t); return o.read().decode("utf-8","replace"), e.read().decode("utf-8","replace")

# 1) ГАРД: адрес ключа на VPS должен быть 0x889c
guard_js='require(\\"dotenv\\").config();const{ethers}=require(\\"ethers\\");const k=process.env.MM_USE_OLD_KEY===\\"1\\"?process.env.DREAMDEX_PRIVATE_KEY:(process.env.DREAMDEX_PRIVATE_KEY2||process.env.DREAMDEX_PRIVATE_KEY);console.log(new ethers.Wallet(k).address)'
o,e=run(f'bash -lc \'cd /root/dreamdex-bot && source ~/.nvm/nvm.sh 2>/dev/null; node -e "{guard_js}"\'')
addr=(o.strip().split("\n")[-1] if o.strip() else "").strip()
print("ГАРД: адрес ключа на VPS =", addr or ("(ошибка) "+e[:200]))
if addr.lower()!=EXPECT_ADDR:
    print(f"❌ ABORT: адрес != {EXPECT_ADDR}. Ничего не тронуто."); c.close(); sys.exit(1)
print("✅ адрес совпал с боевым 0x889c.")

# локальные sha
def sha(p): return hashlib.sha256(open(p,"rb").read()).hexdigest()
loc_mm=os.path.join(HERE,"src","mm-multi.ts"); loc_rn=os.path.join(HERE,"run-multi.sh")
print(f"локально mm-multi.ts sha={sha(loc_mm)[:16]}  run-multi.sh sha={sha(loc_rn)[:16]}")

if not GO:
    print("\n(dry) гард пройден. Для реальной выкатки запусти:  python deploy_multi.py --go"); c.close(); sys.exit(0)

# 2) предеплой-бэкап на VPS
ts,_=run("date -u +%Y%m%dT%H%M%SZ"); ts=ts.strip()
run(f"mkdir -p /root/backups/predeploy-{ts} && cp /root/dreamdex-bot/src/mm-multi.ts /root/backups/predeploy-{ts}/ && cp /root/dreamdex-bot/run-multi.sh /root/backups/predeploy-{ts}/")
print(f"предеплой-бэкап: /root/backups/predeploy-{ts}/")

# 3) загрузка
sftp=c.open_sftp()
sftp.put(loc_mm, "/root/dreamdex-bot/src/mm-multi.ts")
sftp.put(loc_rn, "/root/dreamdex-bot/run-multi.sh")
sftp.close()

# 4) сверка sha на VPS
o,_=run("sha256sum /root/dreamdex-bot/src/mm-multi.ts /root/dreamdex-bot/run-multi.sh")
print("VPS sha после заливки:\n"+o.strip())
if sha(loc_mm)[:16] not in o or sha(loc_rn)[:16] not in o:
    print("❌ sha не совпали — НЕ рестартю. Проверь вручную."); c.close(); sys.exit(1)
print("✅ файлы залиты и сверены.")

# 5) рестарт pm2 (только dreamdex-mm; poker* не трогаем)
o,e=run(f"{PM2} restart dreamdex-mm --update-env 2>&1 | tail -5")
print("pm2 restart:\n"+o.strip())

# 6) стартовые логи
import time; time.sleep(8)
o,_=run("tail -25 /root/.pm2/logs/dreamdex-mm-out.log")
print("\n=== стартовые логи ===\n"+o.strip())
c.close()
