import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { getDb } from './server/db.ts';
import { resolveSessionMiddleware } from './server/auth.ts';
import { buildApiRouter } from './server/routes.ts';
import { seedDatabaseIfEmpty } from './server/seed.ts';

async function startServer() {
  // Initialize SQLite WAL database & deterministic seed data
  getDb();
  seedDatabaseIfEmpty();

  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(resolveSessionMiddleware);

  // API routes
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
  // Desktop Windows deployment sets BIND_HOST=127.0.0.1; container preview binds 0.0.0.0:3000
  const HOST = process.env.BIND_HOST || '0.0.0.0';

  app.listen(PORT, HOST, () => {
    console.log(`ShifaRx Pharmacy Management Server running at http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ShifaRx server:', err);
  process.exit(1);
});
