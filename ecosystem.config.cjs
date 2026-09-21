module.exports = {
  apps: [{
    name: 'ticket-bot',
    script: './src/index.js',
    autorestart: true,
    restart_delay: 5000,
    max_restarts: 20,
    time: true,
  }],
};