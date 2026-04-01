'use strict';

/**
 * Health check endpoint for PaaS platform probes (Railway, Render, etc.)
 * Registered via server.js CDS bootstrap.
 */
module.exports = (app) => {
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      profile: process.env.CDS_ENV || 'development'
    });
  });
};
