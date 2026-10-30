// PM2: proceso único, sin privilegios (usuario javalive). Instalado por deploy/setup.sh, fuera de la release.
module.exports = {
  apps: [{
    name: 'java-live',
    cwd: '/var/www/java-live/current',
    script: 'server.js',
    exec_mode: 'fork',
    instances: 1,
    uid: 'javalive',
    gid: 'javalive',
    autorestart: true,
    max_memory_restart: '200M',
    env: { NODE_ENV: 'production', PORT: '4012', HOST: '127.0.0.1', RUNNER: 'sandbox' },
  }],
};
