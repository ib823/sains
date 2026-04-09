'use strict';

// Force IPv4 DNS resolution for outbound connections (Codespace/Docker fix).
// Must run before any other require that might trigger DNS lookups.
require('dns').setDefaultResultOrder('ipv4first');

const cds = require('@sap/cds');
const path = require('path');

// ── DATABASE_URL OVERRIDE ─────────────────────────────────────────────────
// CAP does NOT substitute ${VAR} placeholders in .cdsrc.json credential strings.
// If DATABASE_URL is set and we're in a postgres profile, override cds.env at
// runtime so the @cap-js/postgres adapter connects to the real database.
if (process.env.DATABASE_URL && (process.env.CDS_ENV || '').startsWith('postgres')) {
  // Ensure ?pgbouncer=true is present for Supabase transaction pooler compatibility.
  // Without it, PgBouncer rejects named prepared statements that @cap-js/postgres sends.
  let dbUrl = process.env.DATABASE_URL;
  if (dbUrl.includes('pooler.supabase.com') && !dbUrl.includes('pgbouncer=true')) {
    dbUrl += (dbUrl.includes('?') ? '&' : '?') + 'pgbouncer=true';
  }
  cds.env.requires.db = {
    kind: 'postgres',
    impl: '@cap-js/postgres',
    credentials: {
      url: dbUrl,
      ssl: { rejectUnauthorized: false },
    },
    pool: {
      min: 1,
      max: 5,
      acquireTimeoutMillis: 60000,
      idleTimeoutMillis: 30000,
      evictionRunIntervalMillis: 10000,
    },
  };
}

cds.on('bootstrap', (app) => {
  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      profile: process.env.CDS_ENV || 'development',
      services: Object.keys(cds.services || {}).filter(s => !s.startsWith('cds.')),
    });
  });

  // CORS for POC — allow simulator UI and customer portal on different origins
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Redirect root to launchpad (POC only — CDS index still at /?cds)
  app.get('/', (req, res, next) => {
    if (req.query.cds !== undefined || req.headers.accept?.includes('application/json')) return next();
    res.redirect('/launchpad/');
  });

  // Serve static pages
  const express = require('express');
  app.use('/simulator-dashboard', express.static(
    path.join(__dirname, 'app', 'simulator-dashboard', 'webapp')
  ));
  app.use('/launchpad', express.static(
    path.join(__dirname, 'app', 'launchpad', 'webapp')
  ));
  app.use('/demo', express.static(
    path.join(__dirname, 'app', 'demo', 'webapp')
  ));
  app.use('/training', express.static(
    path.join(__dirname, 'app', 'training')
  ));

  // Inject training overlay into ALL HTML responses (Fiori preview + others)
  app.use((req, res, next) => {
    if (!req.path.includes('fiori-preview')) return next();
    const originalSend = res.send;
    res.send = function (body) {
      if (typeof body === 'string' && body.includes('</body>')) {
        const injection = `
          <!-- SAINS Training Overlay -->
          <link rel="stylesheet" href="/training/training-styles.css">
          <script src="/training/training-overlay.js"><\/script>
          <script src="/training/training-content.js"><\/script>
          <script src="/training/training-fiori-bootstrap.js"><\/script>
        `;
        body = body.replace('</body>', injection + '\n</body>');
      }
      return originalSend.call(this, body);
    };
    next();
  });
});

module.exports = cds.server;
