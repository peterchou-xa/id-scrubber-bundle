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
  ],
};
