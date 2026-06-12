# health-backfill

This folder owns the local ingestion/bridge lane for Vel's Health Auto Export
stack. It lives in the HAE server repo because these scripts read local HAE
tokens, post to the HAE `/api/data` endpoint, and run from the same Windows
scheduled task as the HAE sync.

Loads a full Apple Health history (`export.zip`) into the local Health Auto Export
server (`http://localhost:3001`), bypassing the iOS app's crash-prone manual export.

## One-time export (on the iPhone)

Health app → profile picture (top right) → **Export All Health Data** → share the
resulting `export.zip` to this machine (AirDrop to a Mac then copy, or iCloud Drive,
or USB).

## Run

```powershell
# Dry run first — parses everything, posts nothing, prints counts per metric
node tools\health-backfill\backfill.js C:\path\to\export.zip --dry-run

# Real load (idempotent — the server upserts on (source, date), re-runs are safe)
node tools\health-backfill\backfill.js C:\path\to\export.zip
```

Options: `--from 2025-06-01`, `--to 2026-06-01`, `--server http://localhost:3001`,
`--env <path-to-HAE-.env>` (default: the health-auto-export-server repo's `.env`,
where `WRITE_TOKEN` lives), `--chunk 5000`.

## What it loads

| HealthKit type | HAE metric |
|---|---|
| HeartRateVariabilitySDNN | `heart_rate_variability` (raw samples, ms) |
| HeartRate | `heart_rate` (raw samples as Min=Avg=Max) |
| RestingHeartRate | `resting_heart_rate` |
| StepCount | `step_count` (raw interval rows; sum per day downstream) |
| RespiratoryRate | `respiratory_rate` |
| ActiveEnergyBurned | `active_energy` |
| OxygenSaturation | `blood_oxygen_saturation` (converted to %) |
| BodyMass | `weight_body_mass` |
| SleepAnalysis | `sleep_analysis` (stage intervals grouped into one point per night per source) |

Notes:
- Step/energy rows come from both iPhone and Watch; consumers should pick one
  source per day rather than summing across sources, or steps double-count.
- Sleep nights are keyed noon-to-noon, so a 23:00 start and a 02:00 segment land
  on the same night. In-bed-only rows (no actual sleep stages) are dropped.

## Stability radar

`stability-radar.js` is the no-surprises shoulder-tap layer. It reads recent HAE
metrics, judges Vel against her own rolling baselines via `vel-battery-core.js`,
and prepares a Discord webhook payload. It never sends by default.

```powershell
# Read local HAE and print a stability report + Discord payload preview.
node tools\health-backfill\stability-radar.js

# Synthetic/private fixture mode for smoke tests.
node tools\health-backfill\stability-radar.js --fixture C:\path\to\fixture.json

# Live Discord send requires both flags plus a webhook.
node tools\health-backfill\stability-radar.js --allow-live --send-discord --discord-webhook $env:DISCORD_WEBHOOK_URL

# Preferred Haven/Discord path: create a pending command in Discord Resonance.
node tools\health-backfill\stability-radar.js --allow-live --trigger-resonance --resonance-url $env:DISCORD_RESONANCE_URL --resonance-token $env:DISCORD_RESONANCE_TOKEN --resonance-channel-id $env:DISCORD_RESONANCE_CHANNEL_ID
```

Guardrails:
- `--send-discord` alone is not enough; dry-run remains enabled unless
  `--allow-live` is also present.
- `--trigger-resonance` follows the same rule. In dry-run it only prints the
  `/trigger` payload for the Discord-Webhook worker.
- The script writes no health data and does not modify Velastra.
- Use `--json-out <path>` to save the evaluated state and Discord payload.
