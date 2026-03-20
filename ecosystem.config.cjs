module.exports = {
  apps: [
    {
      name: "mpesa-payments",
      cwd: __dirname,
      script: "dist/index.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
