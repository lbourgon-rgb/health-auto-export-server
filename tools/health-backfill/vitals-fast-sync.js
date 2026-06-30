#!/usr/bin/env node
/**
 * Fast vitals rollup: HAE server -> velastrahq Worker.
 *
 * Mirrors the health-card payload from sync-to-velastrahq.ps1 without running
 * Notion or Google Calendar side lanes. Intended for a frequent scheduled task.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const HAE_BASE = process.env.HAE_BASE_URL || 'http://localhost:3001';
const VELASTRAHQ_HEALTH_URL = process.env.VELASTRAHQ_HEALTH_URL || 'https://velastrahq-api.lbourgon.workers.dev/api/health';

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

function dateKey(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateKeyValue, days) {
  const d = new Date(`${dateKeyValue}T12:00:00`);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

async function fetchMetric(token, metric, { from, to, include } = {}) {
  const url = new URL(`${HAE_BASE}/api/metrics/${metric}`);
  if (from) url.searchParams.set('from', from);
  if (to) url.searchParams.set('to', to);
  if (include) url.searchParams.set('include', include);
  const res = await fetch(url, { headers: { 'api-key': token } });
  if (!res.ok) throw new Error(`HAE ${metric} fetch failed: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

function localDayEndIso(dateKeyValue) {
  return new Date(`${dateKeyValue}T23:59:59.999`).toISOString();
}

function localDayStartIso(dateKeyValue) {
  return new Date(`${dateKeyValue}T00:00:00.000`).toISOString();
}

function latestByDate(rows) {
  return rows
    .filter((row) => row && row.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;
}

function dailySum(rows, targetDate) {
  const dayRows = rows.filter((row) => dateKey(row.date) === targetDate && Number.isFinite(Number(row.qty)));
  if (!dayRows.length) return null;
  const qty = dayRows.reduce((sum, row) => sum + Number(row.qty), 0);
  const sources = [...new Set(dayRows.map((row) => row.source).filter(Boolean))].sort();
  return {
    date: targetDate,
    qty,
    rows: dayRows.length,
    source: sources.join(', '),
    units: dayRows[0].units || null,
  };
}

function sleepPayload(row) {
  if (!row) return {};
  const totalSleep = Number(row.core || 0) + Number(row.deep || 0) + Number(row.rem || 0);
  if (!(totalSleep > 0)) return {};
  const deepRemRatio = (Number(row.deep || 0) + Number(row.rem || 0)) / totalSleep;
  const durationScore = Math.min(totalSleep / 8.0, 1.0) * 2.5;
  const qualityScore = deepRemRatio * 2.5;
  return {
    sleep_hours: Math.round(totalSleep * 10) / 10,
    sleep_quality: Math.round((durationScore + qualityScore) * 10) / 10,
  };
}

async function postHealth(apiKey, payload) {
  const res = await fetch(VELASTRAHQ_HEALTH_URL, {
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
  if (!res.ok) throw new Error(`velastrahq health POST failed: ${res.status} ${text}`);
  return body;
}

async function main() {
  const haeToken = envValue('HAE_READ_TOKEN', 'READ_TOKEN');
  const apiKey = envValue('VELASTRAHQ_API_KEY');
  if (!haeToken) throw new Error('HAE_READ_TOKEN is not set and READ_TOKEN is missing from .env');
  if (!apiKey && !dryRun) throw new Error('VELASTRAHQ_API_KEY is not set');

  const today = dateKey(new Date());
  const from = localDayStartIso(addDays(today, -10));
  const to = localDayEndIso(today);

  const [rhrRows, hrvRows, respRows, sleepRows, stepsRows, energyRows] = await Promise.all([
    fetchMetric(haeToken, 'resting_heart_rate', { from, to, include: 'qty,date,source,units' }),
    fetchMetric(haeToken, 'heart_rate_variability', { from, to, include: 'qty,date,source,units' }),
    fetchMetric(haeToken, 'respiratory_rate', { from, to, include: 'qty,date,source,units' }),
    fetchMetric(haeToken, 'sleep_analysis', { from, to }),
    fetchMetric(haeToken, 'step_count', { from, to, include: 'qty,date,source,units' }),
    fetchMetric(haeToken, 'active_energy', { from, to, include: 'qty,date,source,units' }),
  ]);

  const latestRhr = latestByDate(rhrRows);
  const latestHrv = latestByDate(hrvRows);
  const latestResp = latestByDate(respRows);
  const latestSleep = latestByDate(sleepRows);
  const latestEnergy = latestByDate(energyRows);

  const syncDate = [latestRhr, latestHrv, latestResp, latestSleep, latestEnergy]
    .map((row) => dateKey(row && row.date))
    .filter(Boolean)
    .sort()
    .pop();

  if (!syncDate) throw new Error('No recent health data found to sync');

  const steps = dailySum(stepsRows, syncDate);
  const energy = dailySum(energyRows, syncDate);
  const payload = {
    date: syncDate,
    resting_hr: latestRhr ? Math.round(Number(latestRhr.qty)) : null,
    hrv: latestHrv ? Math.round(Number(latestHrv.qty) * 10) / 10 : null,
    ...sleepPayload(latestSleep),
    steps: steps ? Math.round(steps.qty) : null,
    active_energy: energy ? Math.round(energy.qty) : null,
    respiratory_rate: latestResp ? Math.round(Number(latestResp.qty) * 10) / 10 : null,
  };

  console.log(`Fast vitals date=${syncDate} rhr=${payload.resting_hr ?? 'n/a'} hrv=${payload.hrv ?? 'n/a'} steps=${payload.steps ?? 'n/a'} energy=${payload.active_energy ?? 'n/a'} resp=${payload.respiratory_rate ?? 'n/a'} source=${HAE_BASE}`);
  console.log(JSON.stringify(payload));

  if (dryRun) {
    console.log('DRY RUN: skipping velastrahq health POST.');
    return;
  }

  const result = await postHealth(apiKey, payload);
  console.log(`Pushed vitals rollup: ${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(`FAST VITALS SYNC FAILED: ${err.message}`);
  process.exit(1);
});
