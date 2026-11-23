import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { closeDb, getDb } from './server/db.ts';
import { resolveSessionMiddleware } from './server/auth.ts';
import { buildApiRouter } from './server/routes.ts';
import { seedDatabaseIfEmpty } from './server/seed.ts';

function getLanUrls(port: number): string[] {
  const ifaces = os.networkInterfaces();
  const urls: string[] = [`http://localhost:${port}`];
  for (const entries of Object.values(ifaces)) {
    for (const iface of entries || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`);
      }
    }
  }
  return urls;
}

async function startServer() {
  getDb();
  seedDatabaseIfEmpty();

  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);

  app.use('/api', buildApiRouter());

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(process.cwd(), 'dist');

  if (!isProd || !fs.existsSync(distDir)) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.BIND_HOST || '0.0.0.0';

  const server = app.listen(PORT, HOST, () => {
    console.log(`MediNest Pharmacy Management Server running on ${HOST}:${PORT}`);
    for (const u of getLanUrls(PORT)) {
      console.log(`  Access URL: ${u}`);
    }
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; closing MediNest server and checkpointing SQLite WAL...`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Failed to start MediNest server:', err);
  process.exit(1);
});
