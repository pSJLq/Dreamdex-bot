#!/usr/bin/env bash
# Запускать НА VPS из папки бота:  bash deploy-vps.sh
# Ставит Node (через nvm, без sudo), зависимости, pm2 и поднимает бота 24/7 с автозапуском.
set -e
cd "$(dirname "$0")"

echo "== 1/4 Node =="
if ! command -v node >/dev/null 2>&1; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 20 && nvm use 20
fi
node -v

echo "== 2/4 зависимости =="
npm install

echo "== 3/4 pm2 =="
npm install -g pm2 2>/dev/null || sudo npm install -g pm2

echo "== 4/4 запуск бота 24/7 =="
pm2 delete dreamdex 2>/dev/null || true
pm2 start npm --name dreamdex -- start
pm2 save
pm2 startup 2>/dev/null | tail -1 || true

echo ""
echo "✅ ГОТОВО — бот крутится на VPS под pm2 (переживёт перезагрузку сервера)."
echo "   Смотреть лог:  pm2 logs dreamdex"
echo "   Статус:        pm2 status"
echo "   Стоп:          pm2 stop dreamdex"
