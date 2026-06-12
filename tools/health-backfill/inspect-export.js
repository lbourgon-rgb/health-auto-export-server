#!/usr/bin/env node
/**
 * Safe Apple Health export dry-run inspector.
 *
 * Streams export.xml from a zip/xml/dir, counts the streams Velastra needs, and
 * writes a report. It does not post data or write expanded health XML to disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TARGET_QUANTITY_TYPES = {
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { stream: 'hrv', metric: 'heart_rate_variability', expectedUnit: 'ms' },
  HKQuantityTypeIdentifierRestingHeartRate: { stream: 'resting_heart_rate', metric: 'resting_heart_rate', expectedUnit: 'count/min' },
  HKQuantityTypeIdentifierHeartRate: { stream: 'heart_rate', metric: 'heart_rate', expectedUnit: 'count/min' },
  HKQuantityTypeIdentifierStepCount: { stream: 'steps_activity', metric: 'step_count', expectedUnit: 'count' },
  HKQuantityTypeIdentifierActiveEnergyBurned: { stream: 'steps_activity', metric: 'active_energy', expectedUnit: 'kcal' },
  HKQuantityTypeIdentifierBasalEnergyBurned: { stream: 'steps_activity', metric: 'basal_energy_burned', expectedUnit: 'kcal' },
  HKQuantityTypeIdentifierAppleExerciseTime: { stream: 'steps_activity', metric: 'apple_exercise_time', expectedUnit: 'min' },
  HKQuantityTypeIdentifierAppleStandTime: { stream: 'steps_activity', metric: 'apple_stand_time', expectedUnit: 'min' },
  HKQuantityTypeIdentifierBodyMass: { stream: 'body_metrics', metric: 'weight_body_mass', expectedUnit: 'kg' },
  HKQuantityTypeIdentifierBodyFatPercentage: { stream: 'body_metrics', metric: 'body_fat_percentage', expectedUnit: '%' },
  HKQuantityTypeIdentifierBodyMassIndex: { stream: 'body_metrics', metric: 'body_mass_index', expectedUnit: 'count' },
  HKQuantityTypeIdentifierLeanBodyMass: { stream: 'body_metrics', metric: 'lean_body_mass', expectedUnit: 'kg' },
  HKQuantityTypeIdentifierWaistCircumference: { stream: 'body_metrics', metric: 'waist_circumference', expectedUnit: 'cm' },
  HKQuantityTypeIdentifierHeight: { stream: 'body_metrics', metric: 'height', expectedUnit: 'cm' },
};

const TARGET_CATEGORY_TYPES = {
  HKCategoryTypeIdentifierSleepAnalysis: { stream: 'sleep', metric: 'sleep_analysis' },
};

const STREAM_ORDER = [
  'hrv',
  'resting_heart_rate',
  'heart_rate',
  'sleep',
  'workouts',
  'steps_activity',
  'body_metrics',
  'ecg_optional',
  'gpx_routes_optional',
];

function parseArgs(argv) {
  const args = { topSources: 8 };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json-out') args.jsonOut = argv[++i];
    else if (a === '--md-out') args.mdOut = argv[++i];
    else if (a === '--drive-sidecar') args.driveSidecar = argv[++i];
    else if (a === '--ecg-count') args.ecgCount = Number(argv[++i]);
    else if (a === '--ecg-from') args.ecgFrom = argv[++i];
    else if (a === '--ecg-to') args.ecgTo = argv[++i];
    else if (a === '--gpx-count') args.gpxCount = Number(argv[++i]);
    else if (a === '--gpx-from') args.gpxFrom = argv[++i];
    else if (a === '--gpx-to') args.gpxTo = argv[++i];
    else if (a === '--top-sources') args.topSources = Number(argv[++i]);
    else positional.push(a);
  }
  args.input = positional[0];
  if (!args.input) throw new Error('Usage: node inspect-export.js <export.zip | export.xml | extracted-dir> [--json-out report.json] [--md-out report.md]');
  return args;
}

function resolveXmlPath(input) {
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    for (const candidate of ['export.xml', path.join('apple_health_export', 'export.xml')]) {
      const p = path.join(input, candidate);
      if (fs.existsSync(p)) return { kind: 'xml', path: p };
    }
    throw new Error(`No export.xml found under ${input}`);
  }
  if (input.toLowerCase().endsWith('.xml')) return { kind: 'xml', path: input };
  if (input.toLowerCase().endsWith('.zip')) return { kind: 'zip', path: input, entry: 'export.xml' };
  throw new Error(`Unrecognized input: ${input}`);
}

function createXmlStream(resolved) {
  if (resolved.kind === 'xml') return fs.createReadStream(resolved.path, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 });
  const child = spawn('tar', ['-xOf', resolved.path, resolved.entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    if (code !== 0) child.stdout.destroy(new Error(`tar failed reading ${resolved.entry}: ${stderr.trim() || `exit ${code}`}`));
  });
  child.stdout.setEncoding('utf8');
  return child.stdout;
}

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
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = decodeXmlEntities(m[2]);
  return attrs;
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function makeBucket(name) {
  return {
    name,
    rows: 0,
    minDate: null,
    maxDate: null,
    metrics: {},
    units: {},
    sources: {},
    warnings: new Set(),
  };
}

function bump(obj, key, n = 1) {
  obj[key || 'Unknown'] = (obj[key || 'Unknown'] || 0) + n;
}

function trackDate(bucket, date) {
  if (!date) return;
  const iso = date.toISOString();
  if (!bucket.minDate || iso < bucket.minDate) bucket.minDate = iso;
  if (!bucket.maxDate || iso > bucket.maxDate) bucket.maxDate = iso;
}

function sortedTop(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

function loadDriveSidecar(filePath) {
  if (!filePath) return {};
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data;
}

function inspectSidecars(report, sidecar) {
  const files = Array.isArray(sidecar.files) ? sidecar.files : [];
  const ecg = files.filter((f) => /^ecg_.*\.csv$/i.test(f.title || f.name || ''));
  const gpx = files.filter((f) => /^route_.*\.gpx$/i.test(f.title || f.name || ''));
  const ecgBucket = report.streams.ecg_optional;
  const gpxBucket = report.streams.gpx_routes_optional;

  ecgBucket.rows = ecg.length;
  gpxBucket.rows = gpx.length;
  for (const f of ecg) {
    const date = parseDateFromName(f.title || f.name);
    trackDate(ecgBucket, date);
  }
  for (const f of gpx) {
    const date = parseDateFromName(f.title || f.name);
    trackDate(gpxBucket, date);
  }
}

function applyOptionalLaneOverrides(report, args) {
  applyCountOverride(report.streams.ecg_optional, args.ecgCount, args.ecgFrom, args.ecgTo, 'ecg_csv_file');
  applyCountOverride(report.streams.gpx_routes_optional, args.gpxCount, args.gpxFrom, args.gpxTo, 'gpx_route_file');
}

function applyCountOverride(bucket, count, from, to, metric) {
  if (!Number.isFinite(count)) return;
  bucket.rows = count;
  if (count > 0) bucket.metrics[metric] = count;
  if (from) trackDate(bucket, parseDateFromName(from));
  if (to) trackDate(bucket, parseDateFromName(to));
}

function parseDateFromName(name) {
  const m = String(name || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? new Date(`${m[1]}T00:00:00`) : null;
}

function handleRecord(report, attrs) {
  const q = TARGET_QUANTITY_TYPES[attrs.type];
  const c = TARGET_CATEGORY_TYPES[attrs.type];
  const def = q || c;
  if (!def) return;
  const bucket = report.streams[def.stream];
  const date = parseHKDate(attrs.startDate);
  bucket.rows++;
  bump(bucket.metrics, def.metric);
  bump(bucket.sources, attrs.sourceName);
  if (attrs.unit) bump(bucket.units, `${def.metric}:${attrs.unit}`);
  if (q && attrs.unit && q.expectedUnit && attrs.unit !== q.expectedUnit) {
    bucket.warnings.add(`${q.metric} expected ${q.expectedUnit}, saw ${attrs.unit}`);
  }
  if (q && attrs.value != null && Number.isNaN(Number(attrs.value))) {
    bucket.warnings.add(`${q.metric} has non-numeric values`);
  }
  trackDate(bucket, date);
}

function handleWorkout(report, attrs) {
  const bucket = report.streams.workouts;
  const date = parseHKDate(attrs.startDate);
  bucket.rows++;
  bump(bucket.metrics, attrs.workoutActivityType || 'UnknownWorkout');
  bump(bucket.sources, attrs.sourceName);
  if (attrs.durationUnit) bump(bucket.units, `duration:${attrs.durationUnit}`);
  if (attrs.totalDistanceUnit) bump(bucket.units, `distance:${attrs.totalDistanceUnit}`);
  if (attrs.totalEnergyBurnedUnit) bump(bucket.units, `energy:${attrs.totalEnergyBurnedUnit}`);
  trackDate(bucket, date);
}

function normalizeReport(report, topSources) {
  for (const name of Object.keys(report.streams)) {
    const bucket = report.streams[name];
    bucket.topSources = sortedTop(bucket.sources, topSources);
    bucket.warnings = [...bucket.warnings].sort();
  }
  report.risks = buildRisks(report);
  report.idempotency = [
    'Metric apply should use the existing HAE upsert key of (source, date) for normal metrics and heart-rate samples.',
    'Sleep apply should keep the existing grouped (wake-date, source) point strategy so re-runs replace the same night/source rows.',
    'Steps and active energy must not be summed across iPhone and Watch sources downstream; choose the best source per day or de-duplicate by source priority.',
    'Workout apply should use a deterministic workout id from Apple export attributes when present; otherwise hash type/start/end/source/duration.',
    'ECG CSV and GPX route lanes should be imported separately with file-name/date-derived IDs and checksum guards.',
  ];
  return report;
}

function buildRisks(report) {
  const risks = [];
  for (const bucket of Object.values(report.streams)) {
    for (const warning of bucket.warnings) risks.push(`${bucket.name}: ${warning}`);
  }
  const bodyUnits = Object.keys(report.streams.body_metrics.units);
  if (bodyUnits.some((u) => u.includes('body_fat_percentage:count'))) {
    risks.push('body_metrics: Apple may encode body fat as decimal count, while user-facing targets may expect percent; confirm transform before apply.');
  }
  if (report.streams.steps_activity.rows > 0) {
    risks.push('steps_activity: multiple device sources can double-count daily totals unless source-prioritized.');
  }
  if (report.streams.sleep.rows > 0) {
    risks.push('sleep: stage units become hours in HAE; keep this consistent with vel-battery-core expectations.');
  }
  if (report.streams.gpx_routes_optional.rows > 0) {
    risks.push('gpx_routes_optional: route files are optional and location-sensitive; keep separate from core biometrics until approved.');
  }
  return [...new Set(risks)];
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# Apple Health Export Dry-Run Report');
  lines.push('');
  lines.push(`- Input: \`${report.input}\``);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Apply executed: no`);
  lines.push('');
  lines.push('## Files Found');
  for (const f of report.filesFound) {
    lines.push(`- ${f.name}: ${f.kind}${f.sizeBytes != null ? `, ${f.sizeBytes} bytes` : ''}${f.uncompressedBytes != null ? `, ${f.uncompressedBytes} uncompressed bytes` : ''}`);
  }
  lines.push('');
  lines.push('## Stream Coverage');
  lines.push('| Stream | Rows | Date coverage | Metrics | Top sources |');
  lines.push('|---|---:|---|---|---|');
  for (const key of STREAM_ORDER) {
    const s = report.streams[key];
    const coverage = s.minDate ? `${s.minDate.slice(0, 10)} -> ${s.maxDate.slice(0, 10)}` : 'n/a';
    const metrics = Object.entries(s.metrics).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a';
    const sources = s.topSources.map((x) => `${x.name} ${x.count}`).join(', ') || 'n/a';
    lines.push(`| ${key} | ${s.rows} | ${coverage} | ${metrics} | ${sources} |`);
  }
  lines.push('');
  lines.push('## Unit Normalization Risks');
  for (const risk of report.risks) lines.push(`- ${risk}`);
  if (report.risks.length === 0) lines.push('- No immediate unit normalization risks detected.');
  lines.push('');
  lines.push('## Duplicate / Idempotency Strategy');
  for (const item of report.idempotency) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Exact Next Apply Command');
  lines.push('Do not run until explicitly approved:');
  lines.push('');
  lines.push('```powershell');
  lines.push(`node tools\\health-backfill\\backfill.js "${report.input}"`);
  lines.push('```');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv);
  const resolved = resolveXmlPath(args.input);
  const stat = fs.statSync(args.input);
  const report = {
    generatedAt: new Date().toISOString(),
    input: path.resolve(args.input),
    filesFound: [{ name: path.basename(args.input), kind: resolved.kind, sizeBytes: stat.size }],
    streams: Object.fromEntries(STREAM_ORDER.map((name) => [name, makeBucket(name)])),
  };

  if (resolved.kind === 'zip') {
    report.filesFound.push({ name: resolved.entry, kind: 'zip-entry-streamed' });
  } else {
    report.filesFound[0].uncompressedBytes = stat.size;
  }

  inspectSidecars(report, loadDriveSidecar(args.driveSidecar));
  applyOptionalLaneOverrides(report, args);

  const stream = createXmlStream(resolved);
  let remainder = '';
  let recordCount = 0;
  for await (const chunk of stream) {
    const text = remainder + chunk;
    const lines = text.split('\n');
    remainder = lines.pop() || '';
    for (const line of lines) {
      const recordIdx = line.indexOf('<Record ');
      if (recordIdx !== -1) {
        const end = line.indexOf('>', recordIdx);
        if (end !== -1) {
          handleRecord(report, parseAttrs(line.slice(recordIdx + 8, end)));
          recordCount++;
        }
      }
      const workoutIdx = line.indexOf('<Workout ');
      if (workoutIdx !== -1) {
        const end = line.indexOf('>', workoutIdx);
        if (end !== -1) handleWorkout(report, parseAttrs(line.slice(workoutIdx + 9, end)));
      }
    }
    if (recordCount && recordCount % 250000 === 0) process.stderr.write(`Parsed ${recordCount} records...\n`);
  }
  normalizeReport(report, args.topSources);

  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.jsonOut)), { recursive: true });
    fs.writeFileSync(args.jsonOut, JSON.stringify(report, null, 2));
  }
  const md = toMarkdown(report);
  if (args.mdOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.mdOut)), { recursive: true });
    fs.writeFileSync(args.mdOut, md);
  }
  process.stdout.write(md);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
