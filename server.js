require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

// Initialize database
const { dbReady } = require('./database/db');

const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 5016;

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    name: 'EasyMotion',
    version: '1.0.0',
    status: 'running',
    port: PORT,
    uptime: process.uptime()
  });
});

// Serve frontend in production
const frontendDist = path.join(__dirname, 'frontend', 'dist');
const fs = require('fs');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/health')) {
      res.sendFile(path.join(frontendDist, 'index.html'));
    }
  });
}

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   📁 Folder2Page — Auto Content Engine     ║');
  console.log(`║   🌐 Server: http://localhost:${PORT}            ║`);
  console.log('║   ✅ Ready for action!                       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  // Auto-resume if there was a crash/power outage — wait for DB first
  const { resumeIfNeeded } = require('./engine/postingEngine');
  dbReady.then(() => {
    console.log('[Server] DB ready. Checking for unfinished work...');
    resumeIfNeeded();
  });
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  try {
    const { stopEngine } = require('./engine/postingEngine');
    stopEngine();
    const { db } = require('./database/db');
    db.close(() => console.log('[Server] Database closed.'));
  } catch (e) {
    console.error('[Server] Shutdown error:', e);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
