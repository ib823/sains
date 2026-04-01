'use strict';

const cds = require('@sap/cds');
const path = require('path');

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
