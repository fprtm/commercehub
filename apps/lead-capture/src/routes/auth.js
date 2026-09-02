'use strict';

const express = require('express');
const { log } = require('../utils/logger');

/**
 * @param {object} deps
 * @param {string} deps.ownerUsername
 * @param {string} deps.ownerPassword
 */
function createAuthRouter({ ownerUsername, ownerPassword }) {
  const router = express.Router();

  router.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) {
      return res.redirect('/leads');
    }
    res.render('login', { error: null });
  });

  router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const { username, password } = req.body || {};
    if (username === ownerUsername && password === ownerPassword) {
      req.session.authenticated = true;
      log('owner_login_success', {});
      return res.redirect('/leads');
    }
    log('owner_login_failed', {});
    return res.status(401).render('login', { error: 'Incorrect username or password.' });
  });

  // Not called out by name in the API contracts, but a login without a
  // corresponding logout would be an odd gap in a real handoff to a
  // non-technical owner; added as a small, clearly-scoped addition.
  router.post('/logout', express.urlencoded({ extended: false }), (req, res) => {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  });

  return router;
}

module.exports = { createAuthRouter };
