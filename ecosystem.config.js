module.exports = {
  apps: [{
    name: '3d-modeling-studio',
    script: 'server/index.js',
    cwd: '/path/to/3d-modeling-studio',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      DB_PATH: '/data/3d-modeling-studio/db.json',
      UPLOAD_DIR: '/data/3d-modeling-studio/uploads',
      MODEL_DIR: '/data/3d-modeling-studio/models',
      SPU_API_URL: 'http://your-spu-gpu-service:8000/api/generate',
      SPU_API_KEY: 'your-api-key-here'
    }
  }]
};
