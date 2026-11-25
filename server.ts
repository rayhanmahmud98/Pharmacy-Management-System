import 'dotenv/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { cleanupExpiredOperationalState, closeDb, getDb, sanitizeHttpError } from './server/db.ts';
import { resolveSessionMiddleware } from './server/auth.ts';
import { buildApiRouter } from './server/routes.ts';
import { seedDatabaseIfEmpty } from './server/seed.ts';

function getLanUrls(port: number): string[] {
  const ifaces = os.networkInterfaces();
  const urls: string[] = [`http://localhost:${port}`];
  const lanIps: string[] = [];
  for (const entries of Object.values(ifaces)) {
    for (const iface of entries || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        lanIps.push(iface.address);
      }
    }
  }
  lanIps.sort((a, b) => {
    const aPrivate = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) ? 0 : 1;
    const bPrivate = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(b) ? 0 : 1;
    return aPrivate - bPrivate || a.localeCompare(b);
  });
  for (const ip of lanIps) {
    urls.push(`http://${ip}:${port}`);
  }
  return urls;
}

async function startServer() {
  await getDb();
  await seedDatabaseIfEmpty();
  await cleanupExpiredOperationalState();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

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

  // Global sanitized JSON error handler (handles body-parser SyntaxError & middleware DB outages)
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    const sanitized = sanitizeHttpError(err);
    if (req.path.startsWith('/api')) {
      res.status(sanitized.status).json({ error: sanitized.message });
      return;
    }
    res.status(sanitized.status).type('text/plain').send(sanitized.message);
  });

  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.BIND_HOST || '0.0.0.0';

  const cleanupTimer = setInterval(() => {
    void cleanupExpiredOperationalState();
  }, 6 * 60 * 60 * 1000);
  cleanupTimer.unref();

  const server = app.listen(PORT, HOST, () => {
    console.log(`MediNest Pharmacy Management Server running on ${HOST}:${PORT}`);
    for (const u of getLanUrls(PORT)) {
      console.log(`  Access URL: ${u}`);
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(cleanupTimer);
    console.log(`Received ${signal}; closing MediNest server and PostgreSQL connection pool...`);
    server.close(() => {
      closeDb()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    setTimeout(() => {
      closeDb()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    }, 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in MediNest server:', reason);
});

startServer().catch((err) => {
  console.error('Failed to start MediNest server:', err);
  process.exit(1);
});
