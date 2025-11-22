#!/usr/bin/env node
/**
 * recon.js - Improved Simple Web Recon Tool
 *
 * Usage:
 *   node recon.js <target> [--timeout=ms] [--output=folder] [--verbose]
 *
 * Examples:
 *   node recon.js example.com --timeout=10000 --output=reports --verbose
 *
 * Notes:
 * - Use only on domains you have permission to test.
 * - Requires Node.js v14+.
 */

const axios = require('axios');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULT_TIMEOUT = 8000;
const DEFAULT_OUTPUT_DIR = '.';

const SUBDOMAIN_WORDS = [
  'www', 'api', 'admin', 'dev', 'test', 'mail', 'ftp', 'stage', 'beta', 'portal', 'shop', 'm'
];

// Utility: parse command line options
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    target: null,
    timeout: DEFAULT_TIMEOUT,
    outputDir: DEFAULT_OUTPUT_DIR,
    verbose: false,
  };

  args.forEach(arg => {
    if (arg.startsWith('--timeout=')) {
      options.timeout = parseInt(arg.split('=')[1], 10) || DEFAULT_TIMEOUT;
    } else if (arg.startsWith('--output=')) {
      options.outputDir = arg.split('=')[1] || DEFAULT_OUTPUT_DIR;
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (!options.target) {
      options.target = arg;
    }
  });

  return options;
}

function log(...args) {
  console.log(...args);
}

function verboseLog(enabled, ...args) {
  if (enabled) {
    console.log(...args);
  }
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeFilename(s) {
  return s.replace(/[:\/\\?#&=]/g, '_');
}

async function fetchHttp(targetUrl, timeout, verbose) {
  verboseLog(verbose, `[HTTP] Fetching ${targetUrl} (timeout=${timeout}ms)`);
  try {
    const res = await axios.get(targetUrl, {
      timeout,
      validateStatus: () => true // accept all HTTP statuses
    });

    return {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      contentSnippet: typeof res.data === 'string' ? res.data.slice(0, 8192) : '',
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

function detectTechFromHeaders(headers, bodySnippet) {
  const tech = [];
  if (!headers) return tech;

  if (headers.server) tech.push(`Server: ${headers.server}`);
  if (headers['x-powered-by']) tech.push(`X-Powered-By: ${headers['x-powered-by']}`);

  if (headers['set-cookie']) {
    const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : [headers['set-cookie']];
    tech.push(`Cookies: ${cookies[0].split(';')[0]}`);
  }

  const body = (bodySnippet || '').toLowerCase();
  if (body.includes('wp-content') || body.includes('wordpress')) tech.push('WordPress');
  if (body.includes('nginx')) tech.push('nginx (body)');
  if (body.includes('cloudflare')) tech.push('Cloudflare (body)');
  if (body.includes('joomla')) tech.push('Joomla');
  if (body.includes('drupal')) tech.push('Drupal');

  // Add more detection rules here if needed

  return tech;
}

async function resolveDomain(domain, verbose) {
  verboseLog(verbose, `[DNS] Resolving A records for ${domain}`);
  try {
    const addresses = await dns.resolve4(domain);
    return { a: addresses };
  } catch (err) {
    return { error: err.code || err.message };
  }
}

async function checkSubdomains(domain, subdomains, verbose) {
  const results = [];
  verboseLog(verbose, `[DNS] Checking common subdomains of ${domain}`);

  // Run lookups in parallel for speed
  const promises = subdomains.map(async (sub) => {
    const fqdn = `${sub}.${domain}`;
    try {
      const addresses = await dns.resolve4(fqdn);
      verboseLog(verbose, `[DNS] Found: ${fqdn} -> ${addresses.join(', ')}`);
      return { subdomain: fqdn, a: addresses };
    } catch {
      // silently ignore errors (NXDOMAIN, etc)
      return null;
    }
  });

  const resolved = await Promise.all(promises);
  for (const r of resolved) {
    if (r) results.push(r);
  }
  return results;
}

function buildTargetUrl(raw) {
  try {
    if (!/^https?:\/\//i.test(raw)) {
      raw = 'http://' + raw;
    }
    const url = new URL(raw);
    return url.toString();
  } catch {
    return null;
  }
}

async function main() {
  const { target, timeout, outputDir, verbose } = parseArgs();

  if (!target) {
    log('Usage: node recon.js <target> [--timeout=ms] [--output=folder] [--verbose]');
    process.exit(1);
  }

  const targetUrl = buildTargetUrl(target);
  if (!targetUrl) {
    log('Invalid target URL:', target);
    process.exit(1);
  }

  log(`[*] Starting recon for: ${targetUrl}`);

  const urlObj = new URL(targetUrl);
  const domain = urlObj.hostname;

  const report = {
    target: targetUrl,
    domain,
    started_at: new Date().toISOString(),
    http: null,
    dns: null,
    subdomains: [],
    tech: [],
  };

  report.http = await fetchHttp(targetUrl, timeout, verbose);
  report.tech = detectTechFromHeaders(report.http.headers, report.http.contentSnippet);
  report.dns = await resolveDomain(domain, verbose);
  report.subdomains = await checkSubdomains(domain, SUBDOMAIN_WORDS, verbose);

  report.finished_at = new Date().toISOString();

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `recon-${safeFilename(domain)}-${nowIso()}.json`;
  const filepath = path.join(outputDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf8');

  log(`[+] Report saved to: ${filepath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
