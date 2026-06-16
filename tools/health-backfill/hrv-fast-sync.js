#!/usr/bin/env node
/**
 * Fast HRV mirror: HAE tunnel -> velastrahq Worker.
 *
 * Pulls recent raw HRV samples from Health Auto Export and mirrors them into
 * velastrahq-api without changing the hourly daily health rollup.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const HAE_BASE = process.env.HAE_BASE_URL || 'https://hae.velastrae.com';
const VELASTRAHQ_HRV_URL = process.env.VELASTRAHQ_HRV_URL || 'https://velastrahq-api.lbourgon.workers.dev/api/health/hrv';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

function readDotEnv(name) {
  if (!fs.existsSync(ENV_PATH)) return '';
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const match = text.match(new RegExp(`^${name}=(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

function envValue(name, fallbackName) {
  return process.env[name] || (fallbackName ? readDotEnv(fallbackName) : readDotEnv(name));
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600000).toISOString();
}

async function fetchRecentHrv(token) {
  const url = new URL(`${HAE_BASE}/api/metrics/heart_rate_variability`);
  url.searchParams.set('from', isoHoursAgo(12));
  url.searchParams.set('to', new Date().toISOString());
  url.searchParams.set('include', 'qty,date,source');

  const res = await fetch(url, { headers: { 'api-key': token } });
  if (!res.ok) throw new Error(`HAE HRV fetch failed: ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json) ? json : [];

  return rows
    .filter((sample) => sample && sample.date && Number.isFinite(Number(sample.qty)))
    .map((sample) => ({
      date: new Date(sample.date).toISOString(),
      qty: Number(sample.qty),
      source: String(sample.source || ''),
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function postHrv(apiKey, payload) {
  const res = await fetch(VELASTRAHQ_HRV_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(`velastrahq HRV POST failed: ${res.status} ${text}`);
  return body;
}

async function main() {
  const haeToken = envValue('HAE_READ_TOKEN', 'READ_TOKEN');
  const apiKey = envValue('VELASTRAHQ_API_KEY');
  if (!haeToken) throw new Error('HAE_READ_TOKEN is not set and READ_TOKEN is missing from .env');
  if (!apiKey && !dryRun) throw new Error('VELASTRAHQ_API_KEY is not set');

  const samples = await fetchRecentHrv(haeToken);
  const payload = {
    generated_at: new Date().toISOString(),
    samples,
  };
  const latest = samples.length ? samples[samples.length - 1].date : null;

  console.log(`Fast HRV samples=${samples.length} latest=${latest || 'none'} source=${HAE_BASE}`);
  if (dryRun) {
    console.log(JSON.stringify(payload));
    console.log('DRY RUN: skipping velastrahq HRV POST.');
    return;
  }

  const result = await postHrv(apiKey, payload);
  console.log(`Pushed HRV mirror: ${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(`FAST HRV SYNC FAILED: ${err.message}`);
  process.exit(1);
});
