module.exports = {
  apps: [
    {
      name: 'identity-scrubber-service',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3030,
      },
    },
    {
      name: 'identity-scrubber-service-dev',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: 'development',
        PORT: 3030,
      },
    },
  ],
};
