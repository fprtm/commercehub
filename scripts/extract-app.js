#!/usr/bin/env node
'use strict';

/**
 * scripts/extract-app.js <app-name> <output-dir>
 * ================================================
 * FR-1106/FR-1107: client-delivery extraction. Copies `apps/<app-name>`'s
 * app package out of the monorepo, and for each `@rimba/*` workspace
 * package it depends on (per its own package.json `dependencies`),
 * vendors that package's source into `<output-dir>/vendor/<pkg-dir-name>/`
 * and rewrites the app's `package.json` to point at the vendored copy via
 * a local `file:` path instead of the workspace-resolved `*` range --
 * producing a standalone folder that needs nothing beyond `npm install`:
 * no registry, no monorepo context, no `workspace:`/npm-workspaces
 * resolution of any kind.
 *
 * FR-1107 (security guardrail): `.env` files, anything under a `data/`
 * directory (local DB / Baileys session credentials -- see the app's own
 * .gitignore for why these are treated as sensitive), and common
 * credential-shaped filenames are explicitly excluded from BOTH the app
 * copy and every vendored package copy. `.env.example` is deliberately
 * NOT excluded -- it's a template with no real secrets, and the client
 * needs it to know which env vars to fill in.
 *
 * Usage:
 *   node scripts/extract-app.js whatsapp-lead-capture /tmp/some-output-dir
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APPS_DIR = path.join(ROOT, 'apps');
const PACKAGES_DIR = path.join(ROOT, 'packages');

// --- Security guardrail exclusions (FR-1107) --------------------------------
// Directory names that are never copied, anywhere in the tree, root or not.
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git', 'data', '.turbo']);

// Exact file basenames that are never copied.
const EXCLUDED_EXACT_FILENAMES = new Set([
  '.env',
  'credentials.json',
  '.npmrc', // may contain registry auth tokens
]);

// Filename patterns that are never copied (credential-shaped files, and any
// .env.* variant EXCEPT the safe, secret-free .env.example template).
const EXCLUDED_FILENAME_PATTERNS = [
  /^\.env\.(?!example$).+$/, // .env.local, .env.production, etc -- NOT .env.example
  /\.pem$/,
  /\.key$/,
  /\.pfx$/,
  /\.p12$/,
];

// Files that are copied from the app/package source but must NOT be carried
// into the extracted output as-is (regenerated/rewritten separately).
const SKIP_FROM_SOURCE_COPY = new Set(['package-lock.json']);

function isExcludedName(basename) {
  if (EXCLUDED_EXACT_FILENAMES.has(basename)) return true;
  return EXCLUDED_FILENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

/**
 * Recursively copies `srcDir` into `destDir`, applying the security
 * guardrail exclusions above. Returns the list of relative paths that were
 * SKIPPED (for reporting/verification), and the count of files copied.
 *
 * @param {string} srcDir
 * @param {string} destDir
 * @param {object} [opts]
 * @param {Set<string>} [opts.extraSkipExactFilenames] - additional exact
 *   basenames to skip at the top level of srcDir only (e.g. package-lock.json).
 * @param {Set<string>} [opts.extraSkipDirNames] - additional directory
 *   basenames to skip anywhere in the tree (e.g. 'test' for vendored packages).
 */
function copyTreeExcluding(srcDir, destDir, opts = {}) {
  const extraSkipExactFilenames = opts.extraSkipExactFilenames || new Set();
  const extraSkipDirNames = opts.extraSkipDirNames || new Set();
  const skipped = [];
  let copiedCount = 0;

  function walk(currentSrc, currentDest, relPath) {
    const entries = fs.readdirSync(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      const entrySrc = path.join(currentSrc, entry.name);
      const entryDest = path.join(currentDest, entry.name);
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name) || extraSkipDirNames.has(entry.name)) {
          skipped.push(`${entryRel}/ (directory)`);
          continue; // eslint-disable-line no-continue
        }
        fs.mkdirSync(entryDest, { recursive: true });
        walk(entrySrc, entryDest, entryRel);
        continue; // eslint-disable-line no-continue
      }

      if (!entry.isFile()) continue; // eslint-disable-line no-continue -- skip symlinks/sockets/etc, never followed

      const isTopLevel = relPath === '';
      if (isTopLevel && extraSkipExactFilenames.has(entry.name)) {
        skipped.push(entryRel);
        continue; // eslint-disable-line no-continue
      }
      if (isExcludedName(entry.name)) {
        skipped.push(entryRel);
        continue; // eslint-disable-line no-continue
      }

      fs.mkdirSync(currentDest, { recursive: true });
      fs.copyFileSync(entrySrc, entryDest);
      copiedCount += 1;
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  walk(srcDir, destDir, '');
  return { skipped, copiedCount };
}

/** Finds the app's real package root: apps/<app-name> directly (the app's
 * package.json, src/, tests/, etc. live as direct children of its apps/
 * folder -- there is no nested `app/` subfolder). */
function resolveAppDir(appName) {
  const direct = path.join(APPS_DIR, appName);
  if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
  throw new Error(`Could not find a package.json for app "${appName}" under ${APPS_DIR} (looked in "${direct}")`);
}

/** Every packages/* directory's own package.json name -> directory name,
 * e.g. { '@rimba/product-matcher': 'product-matcher' }. */
function listWorkspacePackages() {
  const map = new Map();
  if (!fs.existsSync(PACKAGES_DIR)) return map;
  for (const dirName of fs.readdirSync(PACKAGES_DIR)) {
    const pkgJsonPath = path.join(PACKAGES_DIR, dirName, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue; // eslint-disable-line no-continue
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    map.set(pkgJson.name, dirName);
  }
  return map;
}

function extractApp(appName, outputDir) {
  const appDir = resolveAppDir(appName);
  const appPkgPath = path.join(appDir, 'package.json');
  const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));

  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0) {
    throw new Error(`Output directory "${outputDir}" already exists and is not empty -- refusing to overwrite.`);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Copy the app itself (excluding secrets/data, and package-lock.json --
  // a fresh lockfile is generated by `npm install` in the output, since the
  // dependency graph is about to change from workspace-resolved to file:-
  // resolved packages).
  const appCopyResult = copyTreeExcluding(appDir, outputDir, {
    extraSkipExactFilenames: SKIP_FROM_SOURCE_COPY,
  });

  // 2. Identify which of the app's dependencies are workspace packages
  // (present under packages/), and vendor each one's source into
  // <output>/vendor/<pkg-dir-name>/ (excluding its own tests -- the
  // extracted output only needs to RUN the package, not re-test it in
  // isolation; the app's own test suite is what proves the vendored copy
  // still behaves correctly).
  const workspacePackages = listWorkspacePackages();
  const vendoredDeps = []; // [{ depName, dirName }]
  const allSkipped = [...appCopyResult.skipped.map((p) => `${appName}/${p}`)];
  let totalCopied = appCopyResult.copiedCount;

  const depFields = ['dependencies', 'devDependencies'];
  for (const field of depFields) {
    const deps = appPkg[field];
    if (!deps) continue; // eslint-disable-line no-continue
    for (const depName of Object.keys(deps)) {
      if (!workspacePackages.has(depName)) continue; // eslint-disable-line no-continue -- a real npm-registry dependency, left alone
      const dirName = workspacePackages.get(depName);
      const pkgSrcDir = path.join(PACKAGES_DIR, dirName);
      const vendorDestDir = path.join(outputDir, 'vendor', dirName);
      const result = copyTreeExcluding(pkgSrcDir, vendorDestDir, {
        extraSkipDirNames: new Set(['test', 'tests']),
      });
      allSkipped.push(...result.skipped.map((p) => `vendor/${dirName}/${p}`));
      totalCopied += result.copiedCount;
      vendoredDeps.push({ depName, dirName, field });
    }
  }

  // 3. Rewrite the extracted package.json: every vendored workspace
  // dependency's version range becomes a local relative file: path instead
  // of the workspace-resolved "*" -- this is what makes `npm install` work
  // with zero monorepo/registry context.
  const outputPkgPath = path.join(outputDir, 'package.json');
  const outputPkg = JSON.parse(fs.readFileSync(outputPkgPath, 'utf8'));
  for (const { depName, dirName, field } of vendoredDeps) {
    outputPkg[field][depName] = `file:./vendor/${dirName}`;
  }
  fs.writeFileSync(outputPkgPath, `${JSON.stringify(outputPkg, null, 2)}\n`);

  return {
    appDir,
    outputDir,
    vendoredDeps,
    skipped: allSkipped,
    totalCopied,
  };
}

function main() {
  const [, , appName, outputDir] = process.argv;
  if (!appName || !outputDir) {
    console.error('Usage: node scripts/extract-app.js <app-name> <output-dir>');
    process.exit(1);
  }

  const resolvedOutputDir = path.isAbsolute(outputDir) ? outputDir : path.join(process.cwd(), outputDir);

  const result = extractApp(appName, resolvedOutputDir);

  console.log(`Extracted "${appName}" -> ${result.outputDir}`);
  console.log(`  Source app dir: ${result.appDir}`);
  console.log(`  Files copied:   ${result.totalCopied}`);
  console.log(`  Vendored packages (${result.vendoredDeps.length}):`);
  for (const { depName, dirName } of result.vendoredDeps) {
    console.log(`    - ${depName} -> vendor/${dirName}`);
  }
  console.log(`  Excluded (security guardrail + lockfile) -- ${result.skipped.length} path(s):`);
  for (const skippedPath of result.skipped) {
    console.log(`    - ${skippedPath}`);
  }
  console.log('\nNext steps: cd into the output dir and run `npm install && npm test`.');
}

if (require.main === module) {
  main();
}

module.exports = { extractApp, resolveAppDir, listWorkspacePackages, isExcludedName };
