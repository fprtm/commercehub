'use strict';

const express = require('express');

function createHealthRouter() {
  const router = express.Router();
  router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  return router;
}

module.exports = { createHealthRouter };
