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
      SPU_PROVIDER: 'forge3d',
      SPU_API_URL: 'http://127.0.0.1:8091/v1/jobs',
      FORGE3D_ASSET_ROOT: '/workspace/3d-assets'
    }
  }]
};
