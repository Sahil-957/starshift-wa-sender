/**
 * PM2 process config. PM2 keeps the server running: if it crashes (an unhandled error in one
 * account's WhatsApp, an OOM, etc.) PM2 restarts it within seconds and every linked account
 * reconnects on its own (waSessions.restoreAll). It also starts the server back up after a
 * machine reboot once `pm2 startup` + `pm2 save` are set.
 *
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js      # start
 *   pm2 logs starshift-wa              # watch logs
 *   pm2 save && pm2 startup            # survive a server reboot
 *
 * IMPORTANT: one instance only. Each WhatsApp login lives in this process's memory; a second
 * instance would fight over the same session folders. Scale past one server by moving accounts
 * to a second machine, not by adding instances here.
 *
 * Tune per server RAM: raise --max-old-space-size to about half the box's RAM (4096 = 4 GB heap,
 * good for ~16 GB / ~100 accounts), and set max_memory_restart a little under total RAM as a
 * safety net so a leak restarts the process instead of freezing the box.
 */
module.exports = {
  apps: [
    {
      name: "starshift-wa",
      script: "server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      node_args: "--max-old-space-size=4096",
      max_memory_restart: "14G",
      env: { NODE_ENV: "production" },
    },
  ],
};
