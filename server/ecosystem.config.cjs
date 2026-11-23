// Colyseus Cloud runs the server under PM2 with this file.
// Exactly one process: the race room runs the one 5-minute cycle, and a second
// process would start a second cycle of its own. Deploy to one region only.
module.exports = {
  apps: [
    {
      name: 'avalanche-race',
      script: 'index.mjs',
      time: true,
      watch: false,
      instances: 1,
      exec_mode: 'fork', // Colyseus Cloud: never 'cluster'
      wait_ready: true, // @colyseus/tools sends 'ready' once listening
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
