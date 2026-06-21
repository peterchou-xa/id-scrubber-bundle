module.exports = {
  apps: [
    {
      name: 'identity-scrubber-service',
      script: 'dist/main.js',
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
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: 'development',
        PORT: 3030,
      },
    },
  ],
};
