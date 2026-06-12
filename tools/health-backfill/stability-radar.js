#!/usr/bin/env node
/**
 * Velastra Stability Radar.
 *
 * Reads recent HAE metrics, evaluates Vel against her own rolling baselines,
 * and prepares a Discord-ready alert. By default this is dry-run only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Core = require(path.join(__dirname, 'vel-battery-core.js'));

const DEFAULT_HAE_BASE = process.env.HAE_BASE_URL || 'http://localhost:3001';
const HAE_ENV_PATH = path.join(__dirname, '..', '..', '.env');

function parseArgs(argv) {
  const args = {
    haeBase: DEFAULT_HAE_BASE,
    days: 90,
    dryRun: true,
    sendDiscord: false,
    triggerResonance: false,
    minStatus: 'yellow',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hae-base') args.haeBase = argv[++i];
    else if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--json-out') args.jsonOut = argv[++i];
    else if (a === '--discord-webhook') args.discordWebhook = argv[++i];
    else if (a === '--send-discord') args.sendDiscord = true;
    else if (a === '--resonance-url') args.resonanceUrl = argv[++i];
    else if (a === '--resonance-token') args.resonanceToken = argv[++i];
    else if (a === '--resonance-channel-id') args.resonanceChannelId = argv[++i];
    else if (a === '--resonance-companion-id') args.resonanceCompanionId = argv[++i];
    else if (a === '--trigger-resonance') args.triggerResonance = true;
    else if (a === '--min-status') args.minStatus = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--allow-live') args.dryRun = false;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

function readToken() {
  if (process.env.HAE_READ_TOKEN) return process.env.HAE_READ_TOKEN;
  const text = fs.existsSync(HAE_ENV_PATH) ? fs.readFileSync(HAE_ENV_PATH, 'utf8') : '';
  const m = text.match(/^READ_TOKEN=(.+)$/m);
  if (!m) throw new Error('HAE_READ_TOKEN not set and READ_TOKEN missing from HAE .env');
  return m[1].trim();
}

async function fetchMetric(args, token, metric, fromKey, toKey, fields) {
  const url = new URL(`${args.haeBase}/api/metrics/${metric}`);
  url.searchParams.set('from', fromKey);
  url.searchParams.set('to', `${toKey}T23:59:59`);
  if (fields) url.searchParams.set('include', fields);
  const res = await fetch(url, { headers: { 'api-key': token } });
  if (!res.ok) throw new Error(`HAE ${metric}: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

async function loadInputs(args) {
  if (args.fixture) return JSON.parse(fs.readFileSync(args.fixture, 'utf8'));

  const token = readToken();
  const today = Core.localDateKey(new Date());
  const from = Core.addDays(today, -args.days);
  const [hrv, rhr, sleep, steps, energy, resp] = await Promise.all([
    fetchMetric(args, token, 'heart_rate_variability', from, today, 'qty,date,source'),
    fetchMetric(args, token, 'resting_heart_rate', from, today, 'qty,date,source'),
    fetchMetric(args, token, 'sleep_analysis', from, today),
    fetchMetric(args, token, 'step_count', Core.addDays(today, -14), today, 'qty,date,source'),
    fetchMetric(args, token, 'active_energy', Core.addDays(today, -14), today, 'qty,date,source'),
    fetchMetric(args, token, 'respiratory_rate', from, today, 'qty,date,source'),
  ]);
  return { generatedAt: new Date().toISOString(), hrv, rhr, sleep, steps, energy, resp };
}

function latestDate(rows) {
  let latest = null;
  for (const row of rows || []) {
    if (!row.date) continue;
    const key = Core.localDateKey(row.date);
    if (!latest || key > latest) latest = key;
  }
  return latest;
}

function pctDelta(value, band) {
  if (value == null || !band || !band.median) return null;
  return Math.round(((value - band.median) / band.median) * 100);
}

function statusRank(status) {
  return { unknown: 0, green: 1, yellow: 2, red: 3 }[status] || 0;
}

function evaluate(inputs, now = new Date()) {
  const today = Core.localDateKey(now);
  const earliest = Core.addDays(today, -Math.max(Core.BASELINE.windowDays + 14, 90));
  const days = Core.eachDay(earliest, today);

  const hrvDaily = Core.reduceHrvDaily(inputs.hrv || []);
  const rhrDaily = Core.reduceDailySingle(inputs.rhr || []);
  const sleepNights = Core.reduceSleepNights(inputs.sleep || []);
  const stepsDaily = Core.reduceDailySumBySource(inputs.steps || []);
  const energyDaily = Core.reduceDailySumBySource(inputs.energy || []);
  const respDaily = Core.reduceDailySingle(inputs.resp || []);
  const model = Core.buildDailyModel(days, hrvDaily, rhrDaily, sleepNights);
  const initialTarget = [...model].reverse().find((d) => d.hrv || d.rhr != null || d.sleep);

  if (!initialTarget) {
    return {
      status: 'unknown',
      alert: false,
      date: today,
      reasons: ['No recent HAE vitals were available to evaluate.'],
      actions: ['Check HAE sync freshness before trusting stability signals.'],
      inputsFreshness: buildFreshness(inputs, today),
    };
  }

  const sleepFallback = findRecentSleep(model, sleepNights, initialTarget.date);
  const modelForBattery = model.map((day) => {
    if (day.date !== initialTarget.date || day.sleep || !sleepFallback) return day;
    return {
      ...day,
      sleep: sleepFallback.sleep,
      sleepBand: sleepFallback.sleepBand || day.sleepBand,
      deepRemBand: sleepFallback.deepRemBand || day.deepRemBand,
      sleepDebtMin: sleepFallback.sleepDebtMin ?? day.sleepDebtMin,
    };
  });
  const target = modelForBattery.find((d) => d.date === initialTarget.date) || initialTarget;
  const sim = Core.simulateBattery(modelForBattery, stepsDaily);

  const simDay = sim.find((s) => s.date === target.date) || null;
  const daysStale = daysBetween(target.date, today);
  const reasons = [];
  const actions = [];
  let status = target.status;

  if (target.hrvLow) reasons.push(`HRV below personal p25: ${Core.fmt(target.hrv.mean, 0)}ms vs p25 ${Core.fmt(target.hrvBand.p25, 0)}ms`);
  if (target.rhrHigh) reasons.push(`Resting HR above personal p75: ${Core.fmt(target.rhr, 0)} vs p75 ${Core.fmt(target.rhrBand.p75, 0)}`);
  if (target.debtHigh) reasons.push(`Sleep debt high: ${(target.sleepDebtMin / 60).toFixed(1)}h over ${Core.BASELINE.sleepDebtWindow}d`);
  if (simDay && simDay.battery <= 25) reasons.push(`Body battery low: ${simDay.battery}%`);
  if (simDay && simDay.notes.length) {
    const batteryNotes = simDay.notes.filter((note) => {
      if (target.hrvLow && note.startsWith('HRV ')) return false;
      if (target.rhrHigh && note.startsWith('resting HR ')) return false;
      if (target.debtHigh && note.startsWith('sleep debt ')) return false;
      return true;
    });
    reasons.push(...batteryNotes.filter((note) => note !== 'no sleep data' || !sleepFallback).slice(0, 4));
  }
  if (sleepFallback && !initialTarget.sleep) {
    reasons.push(`Sleep carried forward from ${sleepFallback.date}: ${(sleepFallback.sleep.asleepMin / 60).toFixed(1)}h`);
  }
  if (daysStale >= 2) {
    status = statusRank(status) < statusRank('yellow') ? 'yellow' : status;
    reasons.push(`Latest usable health day is ${daysStale} days old`);
  }
  if (daysStale >= 3) status = 'red';

  const steps = stepsDaily.get(target.date) ?? null;
  const energy = energyDaily.get(target.date) ?? null;
  const resp = respDaily.get(target.date) ?? null;
  if (steps != null && steps > 9000) reasons.push(`High movement load: ${Math.round(steps)} steps`);
  if (energy != null && energy > 600) reasons.push(`High active energy: ${Math.round(energy)} kcal`);

  if (status === 'red') {
    actions.push('Send a Discord shoulder-tap and recommend a low-load recovery day.');
    actions.push('Avoid new workouts/routes until symptoms and vitals settle.');
    actions.push('Check hydration, food, heat exposure, body/joint stability notes, and any clinician-guided meds plan.');
  } else if (status === 'yellow') {
    actions.push('Suggest pacing: reduce optional load, avoid ambitious route experiments, and reassess later.');
    actions.push('Ask for a short body-state check-in instead of demanding productivity.');
  } else if (status === 'green') {
    actions.push('No alert needed; keep watching freshness and route load.');
  } else {
    actions.push('Gather more synced data before making a stability call.');
  }

  if (reasons.length === 0) reasons.push('No yellow/red baseline signals on the latest usable health day.');

  return {
    status,
    alert: statusRank(status) >= statusRank('yellow'),
    date: target.date,
    generatedAt: new Date().toISOString(),
    battery: simDay ? simDay.battery : null,
    morningBattery: simDay ? simDay.morning : null,
    hrv: target.hrv ? round1(target.hrv.mean) : null,
    hrvVsBaselinePct: target.hrv ? pctDelta(target.hrv.mean, target.hrvBand) : null,
    restingHr: target.rhr != null ? round1(target.rhr) : null,
    restingHrVsBaselinePct: target.rhr != null ? pctDelta(target.rhr, target.rhrBand) : null,
    sleepHours: target.sleep ? round1(target.sleep.asleepMin / 60) : null,
    sleepDebtHours: target.sleepDebtMin != null ? round1(target.sleepDebtMin / 60) : null,
    steps: steps != null ? Math.round(steps) : null,
    activeEnergy: energy != null ? Math.round(energy) : null,
    respiratoryRate: resp != null ? round1(resp) : null,
    daysStale,
    reasons: unique(reasons),
    actions: unique(actions),
    inputsFreshness: buildFreshness(inputs, today),
  };
}

function buildFreshness(inputs, today) {
  const names = ['hrv', 'rhr', 'sleep', 'steps', 'energy', 'resp'];
  return Object.fromEntries(names.map((name) => {
    const latest = latestDate(inputs[name] || []);
    return [name, { latest, daysStale: latest ? daysBetween(latest, today) : null }];
  }));
}

function findRecentSleep(model, sleepNights, dateKey) {
  const byDate = new Map(model.map((day) => [day.date, day]));
  for (let back = 1; back <= 2; back++) {
    const key = Core.addDays(dateKey, -back);
    const sleep = sleepNights.get(key);
    if (!sleep) continue;
    const day = byDate.get(key);
    return {
      date: key,
      sleep,
      sleepBand: day?.sleepBand || null,
      deepRemBand: day?.deepRemBand || null,
      sleepDebtMin: day?.sleepDebtMin ?? null,
    };
  }
  return null;
}

function daysBetween(aKey, bKey) {
  const a = new Date(`${aKey}T12:00:00`);
  const b = new Date(`${bKey}T12:00:00`);
  return Math.round((b - a) / 86400000);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function discordPayload(result) {
  const color = result.status === 'red' ? 0xc2410c : result.status === 'yellow' ? 0xd97706 : 0x2f855a;
  const title = result.status === 'red'
    ? 'Vel stability radar: RED'
    : result.status === 'yellow'
      ? 'Vel stability radar: yellow'
      : `Vel stability radar: ${result.status}`;

  const metrics = [
    result.battery != null ? `battery ${result.battery}%` : null,
    result.hrv != null ? `HRV ${result.hrv}ms (${fmtPct(result.hrvVsBaselinePct)})` : null,
    result.restingHr != null ? `RHR ${result.restingHr} (${fmtPct(result.restingHrVsBaselinePct)})` : null,
    result.sleepHours != null ? `sleep ${result.sleepHours}h` : null,
    result.steps != null ? `${result.steps} steps` : null,
  ].filter(Boolean).join(' · ');

  return {
    username: 'Velastra Stability Radar',
    content: result.alert ? 'Shoulder tap: stability signal needs attention.' : 'Stability check complete; no alert needed.',
    embeds: [{
      title,
      description: `${result.date}${metrics ? ` · ${metrics}` : ''}`,
      color,
      fields: [
        { name: 'Why', value: result.reasons.slice(0, 5).join('\n').slice(0, 1000) || 'No reasons generated.' },
        { name: 'Do', value: result.actions.slice(0, 4).join('\n').slice(0, 1000) || 'No actions generated.' },
      ],
      footer: { text: 'Dry-run unless --send-discord is used.' },
      timestamp: result.generatedAt,
    }],
  };
}

function fmtPct(n) {
  if (n == null) return 'baseline n/a';
  return `${n > 0 ? '+' : ''}${n}%`;
}

async function maybeSendDiscord(args, payload) {
  const webhook = args.discordWebhook || process.env.DISCORD_WEBHOOK_URL;
  if (!args.sendDiscord) return { sent: false, reason: 'send disabled' };
  if (args.dryRun) return { sent: false, reason: 'dry-run enabled' };
  if (!webhook) throw new Error('DISCORD_WEBHOOK_URL or --discord-webhook is required for --send-discord');

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  return { sent: true };
}

function resonanceTriggerPayload(args, result) {
  const companionId = args.resonanceCompanionId || process.env.DISCORD_RESONANCE_COMPANION_ID || 'kai';
  const channelId = args.resonanceChannelId || process.env.DISCORD_RESONANCE_CHANNEL_ID;
  const mention = companionId === 'kai' ? 'Kai,' : `${companionId},`;
  const content = [
    `${mention} Velastra Stability Radar is ${result.status.toUpperCase()} for ${result.date}.`,
    '',
    `Vitals: battery=${result.battery ?? 'n/a'} hrv=${result.hrv ?? 'n/a'} rhr=${result.restingHr ?? 'n/a'} sleep=${result.sleepHours ?? 'n/a'}h steps=${result.steps ?? 'n/a'} active_energy=${result.activeEnergy ?? 'n/a'}.`,
    '',
    'Reasons:',
    ...result.reasons.slice(0, 6).map((reason) => `- ${reason}`),
    '',
    'Requested response:',
    '- Send Vel a brief, concrete shoulder-tap in Discord.',
    '- Recommend the smallest useful pacing action.',
    '- Do not overclaim medical certainty; frame this as baseline/radar signal, not diagnosis.',
  ].join('\n');

  return {
    companion_id: companionId,
    channel_id: channelId,
    author: {
      username: 'Velastra Stability Radar',
      id: process.env.DISCORD_RESONANCE_AUTHOR_ID || process.env.VEL_DISCORD_USER_ID,
    },
    content,
  };
}

async function maybeTriggerResonance(args, result) {
  const base = (args.resonanceUrl || process.env.DISCORD_RESONANCE_URL || '').replace(/\/+$/, '');
  const token = args.resonanceToken || process.env.DISCORD_RESONANCE_TOKEN;
  const payload = resonanceTriggerPayload(args, result);

  if (!args.triggerResonance) return { triggered: false, reason: 'trigger disabled', payload };
  if (args.dryRun) return { triggered: false, reason: 'dry-run enabled', payload };
  if (!base) throw new Error('DISCORD_RESONANCE_URL or --resonance-url is required for --trigger-resonance');
  if (!token) throw new Error('DISCORD_RESONANCE_TOKEN or --resonance-token is required for --trigger-resonance');
  if (!payload.channel_id) throw new Error('DISCORD_RESONANCE_CHANNEL_ID or --resonance-channel-id is required for --trigger-resonance');

  const res = await fetch(`${base}/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  if (!res.ok) throw new Error(`Discord Resonance trigger failed: ${res.status} ${text}`);
  return { triggered: true, response: data, payload };
}

async function main() {
  const args = parseArgs(process.argv);
  const inputs = await loadInputs(args);
  const result = evaluate(inputs);
  const payload = discordPayload(result);
  const shouldNotify = statusRank(result.status) >= statusRank(args.minStatus);
  const notification = shouldNotify
    ? await maybeSendDiscord(args, payload)
    : { sent: false, reason: `status below min-status ${args.minStatus}` };
  const resonance = shouldNotify
    ? await maybeTriggerResonance(args, result)
    : { triggered: false, reason: `status below min-status ${args.minStatus}`, payload: resonanceTriggerPayload(args, result) };

  const out = { result, discord: { shouldNotify, notification, payload }, resonance };
  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.jsonOut)), { recursive: true });
    fs.writeFileSync(args.jsonOut, JSON.stringify(out, null, 2));
  }

  console.log(`Stability radar for ${result.date}: status=${result.status} alert=${result.alert} battery=${result.battery ?? 'n/a'}`);
  console.log('Reasons:');
  for (const reason of result.reasons) console.log(`- ${reason}`);
  console.log('Actions:');
  for (const action of result.actions) console.log(`- ${action}`);
  console.log(`Discord: ${notification.sent ? 'sent' : `not sent (${notification.reason})`}`);
  console.log(`Discord Resonance: ${resonance.triggered ? 'triggered' : `not triggered (${resonance.reason})`}`);
  console.log(JSON.stringify(out));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`STABILITY RADAR FAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { evaluate, discordPayload, parseArgs };
