'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { log } = require('../utils/logger');

/** Comma-separated aliases textarea/input -> a trimmed, non-empty array (productsRepo.js normalizes further). */
function parseAliases(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

/**
 * FR-702 (docs/sdd/changes/2026-09-02-dashboard-nav-product-ui-connection-resilience.md):
 * full CRUD for the Product catalog, session-authenticated (owner-only,
 * same `requireAuth` gate every other dashboard route uses) -- no more
 * hand-editing `config/products.json`.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('../services/productsRepo').createProductsRepo>} deps.productsRepo
 */
function createProductsRouter({ productsRepo }) {
  const router = express.Router();

  router.get('/products', requireAuth, (req, res) => {
    const products = productsRepo.listAll();
    res.render('products', { products, flash: req.session.flash || null });
    req.session.flash = null;
  });

  router.post('/products', requireAuth, express.urlencoded({ extended: false }), (req, res) => {
    const { name, aliases } = req.body || {};
    if (!name || !name.trim()) {
      req.session.flash = 'Product name is required.';
      return res.redirect('/products');
    }
    const product = productsRepo.create({ name: name.trim(), aliases: parseAliases(aliases) });
    log('product_created', { id: product.id, name: product.name });
    return res.redirect('/products');
  });

  router.post('/products/:id', requireAuth, express.urlencoded({ extended: false }), (req, res, next) => {
    const id = Number(req.params.id);
    const { name, aliases } = req.body || {};
    try {
      if (!Number.isInteger(id)) {
        const err = new Error(`Invalid product id: ${req.params.id}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (!name || !name.trim()) {
        req.session.flash = 'Product name is required.';
        return res.redirect('/products');
      }
      productsRepo.update(id, { name: name.trim(), aliases: parseAliases(aliases) });
      log('product_updated', { id });
      return res.redirect('/products');
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        req.session.flash = 'This product no longer exists.';
        return res.redirect('/products');
      }
      return next(err);
    }
  });

  router.post('/products/:id/deactivate', requireAuth, express.urlencoded({ extended: false }), (req, res, next) => {
    const id = Number(req.params.id);
    try {
      if (!Number.isInteger(id)) {
        const err = new Error(`Invalid product id: ${req.params.id}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      productsRepo.deactivate(id);
      log('product_deactivated', { id });
      return res.redirect('/products');
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        req.session.flash = 'This product no longer exists.';
        return res.redirect('/products');
      }
      return next(err);
    }
  });

  router.post('/products/:id/activate', requireAuth, express.urlencoded({ extended: false }), (req, res, next) => {
    const id = Number(req.params.id);
    try {
      if (!Number.isInteger(id)) {
        const err = new Error(`Invalid product id: ${req.params.id}`);
        err.code = 'NOT_FOUND';
        throw err;
      }
      productsRepo.activate(id);
      log('product_activated', { id });
      return res.redirect('/products');
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        req.session.flash = 'This product no longer exists.';
        return res.redirect('/products');
      }
      return next(err);
    }
  });

  return router;
}

module.exports = { createProductsRouter };
