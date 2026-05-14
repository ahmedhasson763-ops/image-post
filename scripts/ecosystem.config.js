/**
 * PM2 process configuration for Folder2Page / image-post.
 *
 * Usage:
 *   npm install --global pm2          # one-time
 *   pm2 start scripts/ecosystem.config.js
 *   pm2 save && pm2 startup           # survive reboots
 *
 * For multiple tools on the same VPS, copy this file into each tool
 * directory and edit `name` + `PORT` accordingly:
 *   /root/imagestool1   →  name: 'imagestool1', PORT: '5016'
 *   /root/imagestool2   →  name: 'imagestool2', PORT: '5017'
 */
module.exports = {
  apps: [
    {
      name: process.env.TOOL_NAME || 'imagestool1',
      script: 'server.js',
      cwd: __dirname + '/..',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '5016'
      },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '512M',
      out_file: './data/pm2.out.log',
      error_file: './data/pm2.err.log',
      merge_logs: true,
      time: true
    }
  ]
};
