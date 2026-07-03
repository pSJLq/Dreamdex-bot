// pm2-конфиг: держит бота живым 24/7, сам перезапускает при сбое и после перезагрузки сервера.
// Запуск (из папки бота):  pm2 start ecosystem.config.cjs  →  pm2 save  →  pm2 startup
// Приватный ключ и RPC бот берёт из .env в ЭТОЙ ЖЕ папке — сюда ключ НЕ вписывать.
module.exports = {
  apps: [{
    name: "dreamdex",
    script: "npm",
    args: "start",
    autorestart: true,
    max_restarts: 100,
    restart_delay: 5000,
    max_memory_restart: "400M",
    env: { DASHBOARD_PORT: "3000" }
  }]
};
