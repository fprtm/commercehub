'use strict';

const crypto = require('crypto');

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request body
 * and the configured app secret, per technical-design.md Phase L / Data
 * Flow. Uses a constant-time comparison to avoid timing side-channels.
 *
 * @param {Buffer|string} rawBody - the exact raw request body bytes
 * @param {string|undefined} signatureHeader - the 'X-Hub-Signature-256' header value ("sha256=<hex>")
 * @param {string} appSecret
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const [scheme, providedHash] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !providedHash) return false;

  const expectedHash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const expectedBuf = Buffer.from(expectedHash, 'hex');
  const providedBuf = Buffer.from(providedHash, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

module.exports = { verifySignature };
