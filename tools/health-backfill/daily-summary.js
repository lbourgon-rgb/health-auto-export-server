#!/usr/bin/env node
/**
 * Nightly shoulder-tap bridge: HAE server (Mongo) -> velastrahq Worker (D1).
 *
 * Computes Vel's day against her own rolling baselines (vel-battery-core.js,
 * the same model as the site's Battery view) and POSTs vitals + crash flags
 * to /api/health so the family's MCP tools (velastrahq_health, vel_biometrics)
 * can see battery level and crash_state — and tap her on the shoulder.
 *
 * Invoked at the end of sync-to-velastrahq.ps1 (scheduled task
 * HealthAutoExport-VelastrahQ-Sync). Can also run standalone:
 *
 *   node daily-summary.js [--dry-run]
 *
 * Env: HAE_READ_TOKEN (or falls back to the HAE repo's .env),
 *      VELASTRAHQ_API_KEY (required unless --dry-run).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Core = require(path.join(__dirname, 'vel-battery-core.js'));

const HAE_BASE = process.env.HAE_BASE_URL || 'http://localhost:3001';
const HAE_ENV_PATH = path.join(__dirname, '..', '..', '.env');
const VELASTRAHQ_HEALTH_URL = 'https://velastrahq-api.lbourgon.workers.dev/api/health';

const dryRun = process.argv.includes('--dry-run');

function readToken() {
  if (process.env.HAE_READ_TOKEN) return process.env.HAE_READ_TOKEN;
  const m = fs.readFileSync(HAE_ENV_PATH, 'utf8').match(/^READ_TOKEN=(.+)$/m);
  if (!m) throw new Error('HAE_READ_TOKEN not set and READ_TOKEN missing from HAE .env');
  return m[1].trim();
}

async function fetchMetric(token, metric, fromKey, toKey, fields) {
  const url = new URL(`${HAE_BASE}/api/metrics/${metric}`);
  url.searchParams.set('from', Core.localDayStartIso(fromKey));
  url.searchParams.set('to', Core.localDayEndIso(toKey));
  if (fields) url.searchParams.set('include', fields);
  const res = await fetch(url, { headers: { 'api-key': token } });
  if (!res.ok) throw new Error(`HAE ${metric}: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

async function main() {
  const token = readToken();
  const apiKey = process.env.VELASTRAHQ_API_KEY;
  if (!apiKey && !dryRun) throw new Error('VELASTRAHQ_API_KEY is not set');

  const today = Core.localDateKey(new Date());
  const leadIn = Core.addDays(today, -(Core.BASELINE.windowDays + 14));

  const [hrvRaw, rhrRaw, sleepRaw, respRaw, stepsRaw, energyRaw] = await Promise.all([
    fetchMetric(token, 'heart_rate_variability', leadIn, today, 'qty,date,source'),
    fetchMetric(token, 'resting_heart_rate', leadIn, today, 'qty,date,source'),
    fetchMetric(token, 'sleep_analysis', leadIn, today),
    fetchMetric(token, 'respiratory_rate', leadIn, today, 'qty,date,source'),
    fetchMetric(token, 'step_count', Core.addDays(today, -7), today, 'qty,date,source'),
    fetchMetric(token, 'active_energy', Core.addDays(today, -7), today, 'qty,date,source'),
  ]);

  const hrvDaily = Core.reduceHrvDaily(hrvRaw);
  const rhrDaily = Core.reduceDailySingle(rhrRaw);
  const respDaily = Core.reduceDailySingle(respRaw);
  const sleepNights = Core.reduceSleepNights(sleepRaw);
  const stepsDaily = Core.reduceDailySumBySource(stepsRaw);
  const energyDaily = Core.reduceDailySumBySource(energyRaw);

  const days = Core.eachDay(leadIn, today);
  const model = Core.buildDailyModel(days, hrvDaily, rhrDaily, sleepNights);
  const sim = Core.simulateBattery(model, stepsDaily);

  // latest day with watch-backed data, mirroring sync-to-velastrahq.ps1
  const target = [...model].reverse().find((d) => d.hrv || d.rhr != null || d.sleep);
  if (!target) throw new Error('No recent health data found on the HAE server');
  const simDay = sim.find((s) => s.date === target.date);

  const pct = (val, band) => band ? Math.round(((val - band.median) / band.median) * 100) : null;
  const flags = {
    battery: simDay ? simDay.battery : null,
    battery_morning: simDay ? simDay.morning : null,
    crash_state: target.status,                       // red | yellow | green | unknown — HER baselines
    hrv_vs_baseline_pct: target.hrv ? pct(target.hrv.mean, target.hrvBand) : null,
    rhr_vs_baseline_pct: target.rhr != null ? pct(target.rhr, target.rhrBand) : null,
    sleep_debt_min: target.sleepDebtMin != null ? Math.round(target.sleepDebtMin) : null,
    battery_notes: simDay ? simDay.notes : [],
  };
  if (target.hrvLow) flags.hrv_below_personal_p25 = true;
  if (target.rhrHigh) flags.rhr_above_personal_p75 = true;

  // If the target day's night hasn't synced yet, fall back to the most recent
  // known night (≤2 days back) so the D1 entry doesn't lose sleep data the
  // plain vitals push already had. The battery model above still saw the gap.
  let sleep = target.sleep;
  if (!sleep) {
    for (let back = 1; back <= 2 && !sleep; back++) {
      const prev = sleepNights.get(Core.addDays(target.date, -back));
      if (prev) {
        sleep = prev;
        flags.sleep_from = Core.addDays(target.date, -back);
      }
    }
  }
  let sleepQuality = null;
  if (sleep) {
    // same 0-5 score the PowerShell sync computes: duration + deep/rem weighting
    const hours = sleep.asleepMin / 60;
    sleepQuality = Math.round((Math.min(hours / 8, 1) * 2.5 + sleep.deepRemShare * 2.5) * 10) / 10;
  }

  const payload = {
    date: target.date,
    resting_hr: target.rhr != null ? Math.round(target.rhr) : null,
    hrv: target.hrv ? Math.round(target.hrv.mean * 10) / 10 : null,
    sleep_hours: sleep ? Math.round((sleep.asleepMin / 60) * 10) / 10 : null,
    sleep_quality: sleepQuality,
    steps: stepsDaily.has(target.date) ? Math.round(stepsDaily.get(target.date)) : null,
    active_energy: energyDaily.has(target.date) ? Math.round(energyDaily.get(target.date)) : null,
    respiratory_rate: respDaily.has(target.date) ? Math.round(respDaily.get(target.date) * 10) / 10 : null,
    flags, // the Worker's POST handler reads `flags` (it merges its own derived flags on top)
  };

  console.log(`Daily summary for ${target.date}: battery=${flags.battery} crash_state=${flags.crash_state}`);
  console.log(JSON.stringify(payload));

  if (dryRun) {
    console.log('DRY RUN: skipping POST to velastrahq.');
    return;
  }

  const res = await fetch(VELASTRAHQ_HEALTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`velastrahq POST failed: ${res.status} ${text}`);
  console.log(`Pushed to velastrahq: ${text}`);
}

main().catch((err) => {
  console.error(`DAILY SUMMARY FAILED: ${err.message}`);
  process.exit(1);
});
