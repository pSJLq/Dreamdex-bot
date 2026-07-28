# -*- coding: utf-8 -*-
# ОТКАТ В ОДНУ КОМАНДУ к сохранённому боевому состоянию (до эксперимента с мейкер-выходом).
# Заливает backups/<TS>/{mm-multi.ts,run-multi.sh} на VPS и рестартит dreamdex-mm.
# Запуск: python restore.py            → откат к бэкапу из backups/LATEST.txt (20260714T045038Z)
#         python restore.py <TS>       → откат к конкретному бэкапу backups/<TS>/
import sys, os, hashlib, paramiko
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HERE=os.path.dirname(os.path.abspath(__file__))
NODE="/root/.nvm/versions/node/v20.20.2/bin/node"
PM2 =f"{NODE} /root/.nvm/versions/node/v20.20.2/bin/pm2"

def envv(k):
    for line in open(os.path.join(HERE,".env"),encoding="utf-8",errors="replace"):
        line=line.strip()
        if line.startswith(k+"="): return line.split("=",1)[1].strip()
    return None

ts = sys.argv[1] if len(sys.argv)>1 else open(os.path.join(HERE,"backups","LATEST.txt"),encoding="utf-8").read().split("\n")[0].strip()
bdir=os.path.join(HERE,"backups",ts)
mm=os.path.join(bdir,"mm-multi.ts"); rn=os.path.join(bdir,"run-multi.sh")
if not (os.path.exists(mm) and os.path.exists(rn)):
    print(f"❌ нет бэкапа в {bdir}"); sys.exit(1)
def sha(p): return hashlib.sha256(open(p,"rb").read()).hexdigest()
print(f"ОТКАТ к бэкапу {ts}:  mm-multi.ts sha={sha(mm)[:16]}  run-multi.sh sha={sha(rn)[:16]}")
if input("Подтверди откат (введи YES): ").strip()!="YES":
    print("отменено."); sys.exit(0)

c=paramiko.SSHClient(); c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(envv("IP"), username=envv("LOGIN") or "root", password=envv("PASS"), timeout=25)
def run(cmd,t=120):
    _i,o,e=c.exec_command(cmd,timeout=t); return o.read().decode("utf-8","replace"), e.read().decode("utf-8","replace")
sftp=c.open_sftp()
sftp.put(mm,"/root/dreamdex-bot/src/mm-multi.ts"); sftp.put(rn,"/root/dreamdex-bot/run-multi.sh"); sftp.close()
o,_=run("sha256sum /root/dreamdex-bot/src/mm-multi.ts /root/dreamdex-bot/run-multi.sh")
print("VPS sha после отката:\n"+o.strip())
o,_=run(f"{PM2} restart dreamdex-mm --update-env 2>&1 | tail -4")
print("pm2 restart:\n"+o.strip())
import time; time.sleep(8)
o,_=run("tail -20 /root/.pm2/logs/dreamdex-mm-out.log")
print("\n=== логи после отката ===\n"+o.strip())
c.close()
print("\n✅ откат выполнен.")
