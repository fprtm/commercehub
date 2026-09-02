'use strict';

/**
 * Session-based gate for the owner-facing dashboard. Single-owner login
 * (Phase I "Authentication Strategy") -- there is exactly one role, so this
 * is a simple boolean check, not a role/permission system.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.redirect('/login');
}

module.exports = { requireAuth };
