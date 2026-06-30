#!/usr/bin/env node
/**
 * Health sync freshness diagnostic.
 *
 * Read-only probe for the watch -> HAE -> VelastraHQ chain. It prints the
 * newest source sample per metric, public tunnel parity, Velastra API freshness,
 * and the most likely stale leg.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const DEFAULT_METRICS = [
  'heart_rate_variability',
  'resting_heart_rate',
  'sleep_analysis',
  'step_count',
  'active_energy',
  'respiratory_rate',
];

const METRIC_FRESHNESS_MINUTES = {
  heart_rate_variability: 150,
  step_count: 120,
  active_energy: 4 * 60,
  resting_heart_rate: 36 * 60,
  sleep_analysis: 36 * 60,
  respiratory_rate: 18 * 60,
};

function readDotEnv(name) {
  if (!fs.existsSync(ENV_PATH)) return '';
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  const match = text.match(new RegExp(`^${name}=(.+)$`, 'm'));
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

function envValue(name, fallbackName) {
  return process.env[name] || (fallbackName ? readDotEnv(fallbackName) : readDotEnv(name));
}

function ageMinutes(value, now = new Date()) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((now.getTime() - d.getTime()) / 60000));
}

function fmtAge(minutes) {
  if (minutes == null) return 'n/a';
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round((minutes / 60) * 10) / 10}h`;
}

function latestByDate(rows) {
  return rows
    .filter((row) => row && row.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body };
}

async function fetchMetric(base, token, metric) {
  const url = new URL(`${base}/api/metrics/${metric}`);
  url.searchParams.set('include', 'qty,date,source,units');
  const response = await fetchJson(url, { 'api-key': token });
  if (!response.ok || !Array.isArray(response.body)) {
    return { ok: false, status: response.status, count: 0, latest: null };
  }
  return {
    ok: true,
    status: response.status,
    count: response.body.length,
    latest: latestByDate(response.body),
  };
}

function schedulerInfo() {
  if (process.platform !== 'win32') return [];
  const script = `
    $names = @('Velastra-Fast-Vitals-Sync','Velastra-Fast-HRV-Sync','HealthAutoExport-VelastrahQ-Sync','hae-tunnel')
    $rows = foreach ($name in $names) {
      try {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
        $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
        [pscustomobject]@{
          TaskName = $name
          State = [string]$task.State
          LastRunTime = [string]$info.LastRunTime
          LastTaskResult = $info.LastTaskResult
          NextRunTime = [string]$info.NextRunTime
          Missed = $info.NumberOfMissedRuns
        }
      } catch {
        [pscustomobject]@{ TaskName = $name; Error = $_.Exception.Message }
      }
    }
    $rows | ConvertTo-Json -Depth 5
  `;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return [{ error: `scheduler probe failed: ${err.message}` }];
  }
}

function summarizeMetric(name, local, tunnel, now) {
  const localLatest = local.latest;
  const tunnelLatest = tunnel.latest;
  const localAge = ageMinutes(localLatest && localLatest.date, now);
  const tunnelAge = ageMinutes(tunnelLatest && tunnelLatest.date, now);
  const sameDate = !!(localLatest && tunnelLatest && new Date(localLatest.date).getTime() === new Date(tunnelLatest.date).getTime());
  return {
    metric: name,
    local: local.ok ? `${localLatest ? localLatest.date : 'none'} (${fmtAge(localAge)}) count=${local.count}` : `ERROR ${local.status}`,
    tunnel: tunnel.ok ? `${tunnelLatest ? tunnelLatest.date : 'none'} (${fmtAge(tunnelAge)}) count=${tunnel.count}` : `ERROR ${tunnel.status}`,
    parity: sameDate ? 'same latest sample' : 'differs',
    source: (localLatest && localLatest.source) || '',
    age_minutes: localAge,
    stale_after_minutes: METRIC_FRESHNESS_MINUTES[name] || 90,
  };
}

async function main() {
  const token = envValue('HAE_READ_TOKEN', 'READ_TOKEN');
  if (!token) throw new Error('HAE_READ_TOKEN is not set and READ_TOKEN is missing from .env');

  const now = new Date();
  const [metricPairs, health, hrvMirror] = await Promise.all([
    Promise.all(DEFAULT_METRICS.map(async (metric) => {
      const [local, tunnel] = await Promise.all([
        fetchMetric('http://localhost:3001', token, metric),
        fetchMetric('https://hae.velastrae.com', token, metric),
      ]);
      return summarizeMetric(metric, local, tunnel, now);
    })),
    fetchJson('https://velastrahq-gw.lbourgon.workers.dev/api/health'),
    fetchJson('https://velastrahq-api.lbourgon.workers.dev/api/health/hrv?limit=1'),
  ]);

  const staleMetrics = metricPairs.filter((row) => row.age_minutes == null || row.age_minutes > row.stale_after_minutes);
  const freshCriticalMetrics = metricPairs.filter((row) =>
    ['heart_rate_variability', 'step_count', 'active_energy'].includes(row.metric)
    && row.age_minutes != null
    && row.age_minutes <= row.stale_after_minutes
  );
  const latestHealthAge = health.ok && health.body ? ageMinutes(health.body.timestamp, now) : null;
  const latestHrvMirror = hrvMirror.ok && hrvMirror.body ? hrvMirror.body.latest : null;

  console.log(`Health sync freshness diagnostic @ ${now.toISOString()}`);
  console.log('');
  console.log('Scheduled tasks');
  for (const task of schedulerInfo()) {
    if (task.Error || task.error) console.log(`  ${task.TaskName || 'unknown'}: ${task.Error || task.error}`);
    else console.log(`  ${task.TaskName}: state=${task.State} last=${task.LastRunTime} result=${task.LastTaskResult} next=${task.NextRunTime || 'n/a'}`);
  }

  console.log('');
  console.log('HAE source freshness');
  for (const row of metricPairs) {
    const freshness = row.age_minutes == null || row.age_minutes > row.stale_after_minutes
      ? `stale>${fmtAge(row.stale_after_minutes)}`
      : `ok<=${fmtAge(row.stale_after_minutes)}`;
    console.log(`  ${row.metric}: local ${row.local} | tunnel ${row.tunnel} | ${row.parity} | ${freshness}`);
  }

  console.log('');
  if (health.ok) {
    console.log(`Velastra /api/health: date=${health.body.date || 'n/a'} timestamp=${health.body.timestamp || 'n/a'} age=${fmtAge(latestHealthAge)} battery=${health.body.flags && health.body.flags.battery != null ? health.body.flags.battery : 'n/a'}`);
  } else {
    console.log(`Velastra /api/health: ERROR ${health.status}`);
  }
  if (hrvMirror.ok) {
    console.log(`Velastra HRV mirror: latest=${latestHrvMirror ? latestHrvMirror.date : 'none'} sampleAge=${fmtAge(latestHrvMirror ? latestHrvMirror.age_minutes : null)} received=${latestHrvMirror ? latestHrvMirror.received_at : 'n/a'}`);
  } else {
    console.log(`Velastra HRV mirror: ERROR ${hrvMirror.status}`);
  }

  console.log('');
  if (latestHealthAge != null && latestHealthAge <= 15 && staleMetrics.length) {
    const staleNames = staleMetrics.map((row) => row.metric).join(', ');
    const criticalNames = freshCriticalMetrics.map((row) => row.metric).join(', ') || 'none';
    console.log(`Freshness note: Velastra task is fresh. Stale-by-cadence metrics: ${staleNames}. Fresh high-frequency metrics: ${criticalNames}.`);
  } else if (latestHealthAge != null && latestHealthAge > 15) {
    console.log('Likely stale leg: mini PC scheduled task or Velastra API write. /api/health timestamp is old.');
  } else if (latestHealthAge != null) {
    console.log('Freshness note: HAE source, tunnel, and Velastra write look current for their expected cadences.');
  } else {
    console.log('Likely stale leg: unknown; inspect errors above.');
  }
}

main().catch((err) => {
  console.error(`FRESHNESS DIAGNOSTIC FAILED: ${err.message}`);
  process.exit(1);
});
