#!/usr/bin/env node
/**
 * Apple Health export.xml -> Health Auto Export server backfill loader.
 *
 * Streams the (potentially multi-GB) export.xml, maps HealthKit records to the
 * HAE server's metric format, and POSTs them in chunks to POST /api/data.
 * The server upserts on (source, date), so re-runs are idempotent and
 * backfilled rows coexist with live Health Auto Export app syncs.
 *
 * Usage:
 *   node backfill.js <export.zip | export.xml | extracted-dir> [options]
 *
 * Options:
 *   --server <url>     HAE server base URL (default http://localhost:3001)
 *   --env <path>       .env file holding WRITE_TOKEN (default: the HAE server repo's .env)
 *   --from <date>      Skip records before this date (YYYY-MM-DD)
 *   --to <date>        Skip records after this date (YYYY-MM-DD)
 *   --chunk <n>        Data points per POST (default 5000)
 *   --dry-run          Parse and count everything, POST nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const DEFAULT_ENV_PATH = path.join(__dirname, '..', '..', '.env');

// HealthKit record type -> HAE metric name + shape
const QUANTITY_TYPES = {
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { metric: 'heart_rate_variability', units: 'ms' },
  HKQuantityTypeIdentifierRestingHeartRate: { metric: 'resting_heart_rate', units: 'bpm' },
  HKQuantityTypeIdentifierHeartRate: { metric: 'heart_rate', units: 'bpm', shape: 'heart_rate' },
  HKQuantityTypeIdentifierStepCount: { metric: 'step_count', units: 'count' },
  HKQuantityTypeIdentifierRespiratoryRate: { metric: 'respiratory_rate', units: 'count/min' },
  HKQuantityTypeIdentifierActiveEnergyBurned: { metric: 'active_energy', units: 'kcal' },
  HKQuantityTypeIdentifierBasalEnergyBurned: { metric: 'basal_energy_burned', units: 'kcal' },
  HKQuantityTypeIdentifierOxygenSaturation: { metric: 'blood_oxygen_saturation', units: '%', transform: (v) => v * 100 },
  HKQuantityTypeIdentifierBodyMass: { metric: 'weight_body_mass', units: 'kg', quantity: 'mass' },
  HKQuantityTypeIdentifierLeanBodyMass: { metric: 'lean_body_mass', units: 'kg', quantity: 'mass' },
  HKQuantityTypeIdentifierBodyFatPercentage: { metric: 'body_fat_percentage', units: '%', quantity: 'percent' },
  HKQuantityTypeIdentifierBodyMassIndex: { metric: 'body_mass_index', units: 'count' },
  HKQuantityTypeIdentifierHeight: { metric: 'height', units: 'cm', quantity: 'length' },
  HKQuantityTypeIdentifierWaistCircumference: { metric: 'waist_circumference', units: 'cm', quantity: 'length' },
};

const SLEEP_TYPE = 'HKCategoryTypeIdentifierSleepAnalysis';
const SLEEP_STAGES = {
  HKCategoryValueSleepAnalysisAsleepCore: 'core',
  HKCategoryValueSleepAnalysisAsleepDeep: 'deep',
  HKCategoryValueSleepAnalysisAsleepREM: 'rem',
  HKCategoryValueSleepAnalysisAwake: 'awake',
  HKCategoryValueSleepAnalysisInBed: 'inBed',
  // Older watchOS / third-party apps log unstaged sleep
  HKCategoryValueSleepAnalysisAsleep: 'core',
  HKCategoryValueSleepAnalysisAsleepUnspecified: 'core',
};

function parseArgs(argv) {
  const args = { chunk: 5000, server: 'http://localhost:3001', env: DEFAULT_ENV_PATH, dryRun: false };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--server') args.server = argv[++i];
    else if (a === '--env') args.env = argv[++i];
    else if (a === '--from') args.from = new Date(argv[++i] + 'T00:00:00');
    else if (a === '--to') args.to = new Date(argv[++i] + 'T23:59:59');
    else if (a === '--chunk') args.chunk = parseInt(argv[++i], 10);
    else positional.push(a);
  }
  args.input = positional[0];
  return args;
}

function readWriteToken(envPath) {
  if (process.env.HAE_WRITE_TOKEN) return process.env.HAE_WRITE_TOKEN;
  const text = fs.readFileSync(envPath, 'utf8');
  const m = text.match(/^WRITE_TOKEN=(.+)$/m);
  if (!m) throw new Error(`WRITE_TOKEN not found in ${envPath}`);
  return m[1].trim();
}

/** Resolve input (zip, xml, or extracted dir) to a path to export.xml. */
function resolveExportXml(input) {
  if (!input) throw new Error('Usage: node backfill.js <export.zip | export.xml | dir>');
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    for (const candidate of ['export.xml', path.join('apple_health_export', 'export.xml')]) {
      const p = path.join(input, candidate);
      if (fs.existsSync(p)) return p;
    }
    throw new Error(`No export.xml found under ${input}`);
  }
  if (input.toLowerCase().endsWith('.xml')) return input;
  if (input.toLowerCase().endsWith('.zip')) {
    const extractDir = path.join(os.tmpdir(), 'apple-health-export');
    fs.mkdirSync(extractDir, { recursive: true });
    console.log(`Extracting ${input} -> ${extractDir} ...`);
    // Windows 10+ ships bsdtar, which reads zip archives
    execFileSync('tar', ['-xf', input, '-C', extractDir], { stdio: 'inherit' });
    return resolveExportXml(extractDir);
  }
  throw new Error(`Unrecognized input: ${input}`);
}

/** "2025-06-11 08:00:00 -0400" -> Date */
function parseHKDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (m) return new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function normalizeQuantity(def, attrs, rawValue) {
  let value = def.transform ? def.transform(rawValue) : rawValue;
  const originalUnit = attrs.unit || def.units;
  let units = def.units;

  if (def.quantity === 'mass') {
    if (originalUnit === 'lb') value *= 0.45359237;
    else if (originalUnit === 'g') value /= 1000;
    else if (originalUnit !== 'kg') {
      throw new Error(`Unsupported mass unit for ${def.metric}: ${originalUnit}`);
    }
  } else if (def.quantity === 'length') {
    if (originalUnit === 'm') value *= 100;
    else if (originalUnit === 'in') value *= 2.54;
    else if (originalUnit !== 'cm') {
      throw new Error(`Unsupported length unit for ${def.metric}: ${originalUnit}`);
    }
  } else if (def.quantity === 'percent') {
    if (originalUnit === 'count' && value <= 1) value *= 100;
    else if (originalUnit !== '%' && originalUnit !== 'count') {
      throw new Error(`Unsupported percent unit for ${def.metric}: ${originalUnit}`);
    }
  } else if (def.metric === 'active_energy' || def.metric === 'basal_energy_burned') {
    if (originalUnit === 'Cal' || originalUnit === 'kcal') {
      units = 'kcal';
    } else if (originalUnit === 'kJ') {
      value /= 4.184;
    } else {
      throw new Error(`Unsupported energy unit for ${def.metric}: ${originalUnit}`);
    }
  }

  const metadata = {};
  if (originalUnit !== units) {
    metadata.originalUnit = originalUnit;
    metadata.originalValue = String(rawValue);
  }
  return { value, units, metadata };
}

/**
 * Sleep records arrive as many small stage intervals. Group them into one
 * point per (night, source). To match the live Health Auto Export app's
 * convention, a night is keyed to the WAKE date (the interval-start date
 * shifted +12h) and the point's `date` is local midnight of that day, with
 * stage durations in HOURS (units 'hr') — so backfilled nights upsert onto
 * the same (date, source) keys the app writes.
 */
class SleepAggregator {
  constructor() {
    this.nights = new Map();
  }

  add(attrs) {
    const stage = SLEEP_STAGES[attrs.value];
    if (!stage) return;
    const start = parseHKDate(attrs.startDate);
    const end = parseHKDate(attrs.endDate);
    if (!start || !end || end <= start) return;
    const source = decodeXmlEntities(attrs.sourceName || 'Unknown');
    const wakeRef = new Date(start.getTime() + 12 * 3600 * 1000);
    const night = `${wakeRef.getFullYear()}-${String(wakeRef.getMonth() + 1).padStart(2, '0')}-${String(wakeRef.getDate()).padStart(2, '0')}`;
    const key = `${night}|${source}`;

    let agg = this.nights.get(key);
    if (!agg) {
      agg = { night, source, core: 0, rem: 0, deep: 0, awake: 0, inBed: 0, start, end, sleepStart: null, sleepEnd: null };
      this.nights.set(key, agg);
    }
    const hours = (end - start) / 3600000;
    agg[stage] += hours;
    if (start < agg.start) agg.start = start;
    if (end > agg.end) agg.end = end;
    if (stage !== 'inBed' && stage !== 'awake') {
      if (!agg.sleepStart || start < agg.sleepStart) agg.sleepStart = start;
      if (!agg.sleepEnd || end > agg.sleepEnd) agg.sleepEnd = end;
    }
  }

  toPoints() {
    const points = [];
    for (const agg of this.nights.values()) {
      const sleepStart = agg.sleepStart || agg.start;
      const sleepEnd = agg.sleepEnd || agg.end;
      // Watch sources rarely log explicit InBed intervals; fall back to span
      const inBed = agg.inBed > 0 ? agg.inBed : (agg.end - agg.start) / 3600000;
      if (agg.core + agg.rem + agg.deep <= 0) continue; // in-bed-only rows are noise
      points.push({
        date: new Date(`${agg.night}T00:00:00`).toISOString(), // local midnight of wake day, like the app
        inBedStart: agg.start.toISOString(),
        inBedEnd: agg.end.toISOString(),
        sleepStart: sleepStart.toISOString(),
        sleepEnd: sleepEnd.toISOString(),
        core: round2(agg.core),
        rem: round2(agg.rem),
        deep: round2(agg.deep),
        awake: round2(agg.awake),
        inBed: round2(inBed),
        source: agg.source,
      });
    }
    return points;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function postMetric(server, token, name, units, points, dryRun) {
  if (dryRun) return;
  const body = JSON.stringify({ data: { metrics: [{ name, units, data: points }] } });
  const res = await fetch(`${server}/api/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': token },
    body,
  });
  const text = await res.text();
  if (!res.ok && res.status !== 207) {
    throw new Error(`POST /api/data failed for ${name}: ${res.status} ${text}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const xmlPath = resolveExportXml(args.input);
  const token = args.dryRun ? null : readWriteToken(args.env);
  const fileSize = fs.statSync(xmlPath).size;
  console.log(`Parsing ${xmlPath} (${(fileSize / 1024 / 1024).toFixed(0)} MB)${args.dryRun ? ' [DRY RUN]' : ''}`);

  const buffers = new Map(); // metric name -> { units, shape, points: [] }
  const counts = new Map();
  const dateRange = new Map(); // metric -> {min, max}
  const sleep = new SleepAggregator();
  let bytesRead = 0;
  let lastPct = -1;
  let skipped = 0;

  const trackRange = (metric, date) => {
    const r = dateRange.get(metric) || { min: date, max: date };
    if (date < r.min) r.min = date;
    if (date > r.max) r.max = date;
    dateRange.set(metric, r);
  };

  const flush = async (name, force = false) => {
    const buf = buffers.get(name);
    if (!buf || buf.points.length === 0) return;
    if (!force && buf.points.length < args.chunk) return;
    const points = buf.points.splice(0, buf.points.length);
    await postMetric(args.server, token, name, buf.units, points, args.dryRun);
    counts.set(name, (counts.get(name) || 0) + points.length);
  };

  const handleRecord = async (attrs) => {
    const type = attrs.type;
    if (type === SLEEP_TYPE) {
      const start = parseHKDate(attrs.startDate);
      if (!start) return;
      if (args.from && start < args.from) return;
      if (args.to && start > args.to) return;
      sleep.add(attrs);
      return;
    }
    const def = QUANTITY_TYPES[type];
    if (!def) return;
    const date = parseHKDate(attrs.startDate);
    let value = parseFloat(attrs.value);
    if (!date || Number.isNaN(value)) { skipped++; return; }
    if (args.from && date < args.from) return;
    if (args.to && date > args.to) return;
    const normalized = normalizeQuantity(def, attrs, value);
    value = normalized.value;

    let buf = buffers.get(def.metric);
    if (!buf) {
      buf = { units: normalized.units, points: [] };
      buffers.set(def.metric, buf);
    }
    const source = decodeXmlEntities(attrs.sourceName || 'Unknown');
    const iso = date.toISOString();
    if (def.shape === 'heart_rate') {
      buf.points.push({ Min: value, Avg: value, Max: value, units: normalized.units, date: iso, source, metadata: normalized.metadata });
    } else {
      buf.points.push({ qty: value, units: normalized.units, date: iso, source, metadata: normalized.metadata });
    }
    trackRange(def.metric, iso);
    await flush(def.metric);
  };

  // Stream line-by-line: Apple writes each <Record .../> opening tag on one line.
  const stream = fs.createReadStream(xmlPath, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 });
  let remainder = '';
  for await (const chunk of stream) {
    bytesRead += Buffer.byteLength(chunk, 'utf8');
    const text = remainder + chunk;
    const lines = text.split('\n');
    remainder = lines.pop();
    for (const line of lines) {
      const idx = line.indexOf('<Record ');
      if (idx === -1) continue;
      const end = line.indexOf('>', idx);
      if (end === -1) continue; // malformed/split line; opening tags fit on one line in practice
      await handleRecord(parseAttrs(line.slice(idx + 8, end)));
    }
    const pct = Math.floor((bytesRead / fileSize) * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      process.stdout.write(`\r  ${pct}% parsed...`);
    }
  }
  if (remainder.includes('<Record ')) {
    const end = remainder.indexOf('>');
    if (end !== -1) await handleRecord(parseAttrs(remainder.slice(remainder.indexOf('<Record ') + 8, end)));
  }
  process.stdout.write('\r  100% parsed.   \n');

  // Final flushes
  for (const name of buffers.keys()) await flush(name, true);

  const sleepPoints = sleep.toPoints();
  for (let i = 0; i < sleepPoints.length; i += args.chunk) {
    const slice = sleepPoints.slice(i, i + args.chunk);
    await postMetric(args.server, token, 'sleep_analysis', 'hr', slice, args.dryRun);
    counts.set('sleep_analysis', (counts.get('sleep_analysis') || 0) + slice.length);
    for (const p of slice) trackRange('sleep_analysis', p.date);
  }

  console.log(`\n=== Backfill ${args.dryRun ? 'dry run' : 'complete'} ===`);
  for (const [name, n] of [...counts.entries()].sort()) {
    const r = dateRange.get(name);
    const range = r ? ` (${r.min.slice(0, 10)} -> ${r.max.slice(0, 10)})` : '';
    console.log(`  ${name.padEnd(26)} ${String(n).padStart(8)} points${range}`);
  }
  if (skipped) console.log(`  (${skipped} records skipped: unparseable date/value)`);
  if (counts.size === 0) console.log('  Nothing matched. Check the input file and --from/--to filters.');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
