// ============================================================================
// Vel's baseline + body-battery model — SHARED CORE.
//
// Consumed by tools/health-backfill/daily-summary.js (require) — the nightly
// bridge that pushes battery + crash flags to the velastrahq Worker.
//
// NOTE: site/js/vel-battery.js (the browser dashboard) carries its own copy of
// this model because it predates this file and is edited independently. If you
// change a formula or threshold here, mirror it there (and vice versa).
//
// Everything here judges days against VEL'S OWN rolling percentile bands,
// never population thresholds.
// ============================================================================

(function (root) {
    'use strict';

    // The body-battery formula, v1 — deliberately uncalibrated. Every knob in
    // one place so we can tune it against the backfilled year of crash days.
    const BATTERY_TUNING = {
        sleepRechargeFull: 80,        // % recharge for a night at her median duration
        deepRemBonus: 20,             // extra % when deep+rem share is at/above her median share
        hrvModulation: 0.3,           // recharge efficiency swings ±30% with HRV vs her baseline
        baseDrainPerWakeHour: 2.5,    // % per awake hour at baseline
        rhrDrainBoost: 1.0,           // extra multiplier at +15% resting HR over her median
        stepsDrainPer1000: 1.0,       // % per 1000 steps
        carryoverWeight: 0.5,         // how much yesterday's remaining charge carries in
        startCharge: 60,
    };

    const BASELINE = {
        windowDays: 60,               // rolling window for personal percentiles
        minSamples: 10,               // need this many days before bands are trusted
        sleepDebtWindow: 7,           // days
        sleepDebtHighHours: 5,        // cumulative deficit vs her median that flags "high"
    };

    // ------------------------------------------------------------------ utils

    function localDateKey(isoOrDate) {
        if (typeof isoOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) return isoOrDate;
        const d = new Date(isoOrDate);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function addDays(dateKey, n) {
        const d = new Date(dateKey + 'T12:00:00');
        d.setDate(d.getDate() + n);
        return localDateKey(d);
    }

    function localDayStartIso(dateKey) {
        return new Date(`${dateKey}T00:00:00.000`).toISOString();
    }

    function localDayEndIso(dateKey) {
        return new Date(`${dateKey}T23:59:59.999`).toISOString();
    }

    function eachDay(fromKey, toKey) {
        const days = [];
        for (let k = fromKey; k <= toKey; k = addDays(k, 1)) days.push(k);
        return days;
    }

    function percentile(sortedArr, p) {
        if (!sortedArr.length) return null;
        const idx = (sortedArr.length - 1) * p;
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
    }

    function fmt(n, digits = 0) {
        return n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(digits);
    }

    // ------------------------------------------------------- daily reductions

    function reduceHrvDaily(samples) {
        const byDay = new Map();
        for (const s of samples) {
            if (s.qty == null) continue;
            const k = localDateKey(s.date);
            const d = byDay.get(k) || { values: [] };
            d.values.push(s.qty);
            byDay.set(k, d);
        }
        const out = new Map();
        for (const [k, d] of byDay) {
            const sorted = d.values.slice().sort((a, b) => a - b);
            out.set(k, {
                mean: d.values.reduce((a, b) => a + b, 0) / d.values.length,
                min: sorted[0],
                count: d.values.length,
            });
        }
        return out;
    }

    function reduceDailySingle(samples) {
        // resting HR & similar: ~one row per day per source; average across sources
        const byDay = new Map();
        for (const s of samples) {
            if (s.qty == null) continue;
            const k = localDateKey(s.date);
            if (!byDay.has(k)) byDay.set(k, []);
            byDay.get(k).push(s.qty);
        }
        const out = new Map();
        for (const [k, vals] of byDay) out.set(k, vals.reduce((a, b) => a + b, 0) / vals.length);
        return out;
    }

    function reduceDailySumBySource(samples) {
        // steps / energy arrive as interval rows from BOTH iPhone and Watch.
        // Summing across sources double-counts; take the max single-source sum.
        const byDay = new Map();
        for (const s of samples) {
            if (s.qty == null) continue;
            const k = localDateKey(s.date);
            const sources = byDay.get(k) || new Map();
            sources.set(s.source, (sources.get(s.source) || 0) + s.qty);
            byDay.set(k, sources);
        }
        const out = new Map();
        for (const [k, sources] of byDay) out.set(k, Math.max(...sources.values()));
        return out;
    }

    function reduceSleepNights(rows) {
        // one point per (night, source); prefer the source with the most staged
        // sleep. The HAE app stores stage durations in HOURS (units 'hr');
        // normalize everything to minutes for the model.
        const byNight = new Map();
        for (const r of rows) {
            const toMin = r.units === 'hr' ? 60 : 1;
            const k = localDateKey(r.date);
            const asleep = ((r.core || 0) + (r.deep || 0) + (r.rem || 0)) * toMin;
            const existing = byNight.get(k);
            if (!existing || asleep > existing.asleepMin) {
                byNight.set(k, {
                    asleepMin: asleep,
                    deepRemShare: asleep > 0 ? (((r.deep || 0) + (r.rem || 0)) * toMin) / asleep : 0,
                    deep: (r.deep || 0) * toMin,
                    rem: (r.rem || 0) * toMin,
                    core: (r.core || 0) * toMin,
                    awake: (r.awake || 0) * toMin,
                });
            }
        }
        return byNight;
    }

    // --------------------------------------------------------- baseline engine

    /**
     * For each day, percentile bands over the previous `windowDays` of values
     * (the day itself excluded — today is judged against the past).
     */
    function rollingBands(dailyMap, days, accessor = (v) => v) {
        const bands = new Map();
        const entries = days.map((k) => ({ k, v: dailyMap.has(k) ? accessor(dailyMap.get(k)) : null }));
        const present = entries.filter((e) => e.v != null);
        for (const { k } of entries) {
            const cutoffLo = addDays(k, -BASELINE.windowDays);
            const windowVals = present
                .filter((e) => e.k >= cutoffLo && e.k < k)
                .map((e) => e.v)
                .sort((a, b) => a - b);
            if (windowVals.length >= BASELINE.minSamples) {
                bands.set(k, {
                    p25: percentile(windowVals, 0.25),
                    median: percentile(windowVals, 0.5),
                    p75: percentile(windowVals, 0.75),
                    n: windowVals.length,
                });
            }
        }
        return bands;
    }

    function buildDailyModel(days, hrvDaily, rhrDaily, sleepNights) {
        const hrvBands = rollingBands(hrvDaily, days, (v) => v.mean);
        const rhrBands = rollingBands(rhrDaily, days);
        const sleepBands = rollingBands(sleepNights, days, (v) => v.asleepMin);
        const deepRemBands = rollingBands(sleepNights, days, (v) => v.deepRemShare);

        const model = [];
        for (const k of days) {
            const hrv = hrvDaily.get(k) || null;
            const rhr = rhrDaily.get(k) ?? null;
            const sleep = sleepNights.get(k) || null;
            const hb = hrvBands.get(k) || null;
            const rb = rhrBands.get(k) || null;
            const sb = sleepBands.get(k) || null;
            const db = deepRemBands.get(k) || null;

            // rolling sleep debt vs her own median
            let sleepDebtMin = null;
            if (sb) {
                sleepDebtMin = 0;
                for (let i = 0; i < BASELINE.sleepDebtWindow; i++) {
                    const dk = addDays(k, -i);
                    const night = sleepNights.get(dk);
                    const band = sleepBands.get(dk) || sb;
                    if (night && band) sleepDebtMin += Math.max(0, band.median - night.asleepMin);
                }
            }

            const hrvLow = hrv && hb ? hrv.mean < hb.p25 : false;
            const rhrHigh = rhr != null && rb ? rhr > rb.p75 : false;
            const debtHigh = sleepDebtMin != null && sleepDebtMin > BASELINE.sleepDebtHighHours * 60;

            let status = 'unknown';
            if (hb || rb || sb) {
                const signals = [hrvLow, rhrHigh, debtHigh].filter(Boolean).length;
                if (hrvLow && (rhrHigh || debtHigh)) status = 'red';
                else if (signals >= 1) status = 'yellow';
                else status = 'green';
            }

            model.push({
                date: k, hrv, rhr, sleep,
                hrvBand: hb, rhrBand: rb, sleepBand: sb, deepRemBand: db,
                sleepDebtMin, hrvLow, rhrHigh, debtHigh, status,
            });
        }
        return model;
    }

    // ----------------------------------------------------------- battery model

    function simulateBattery(model, stepsDaily) {
        const T = BATTERY_TUNING;
        let charge = T.startCharge;
        const out = [];
        for (const day of model) {
            const notes = [];

            // recharge from last night's sleep
            let recharge = 0;
            if (day.sleep && day.sleepBand) {
                const durRatio = Math.min(day.sleep.asleepMin / day.sleepBand.median, 1.3);
                recharge = T.sleepRechargeFull * durRatio;
                const shareBase = day.deepRemBand ? day.deepRemBand.median : 0.3;
                if (shareBase > 0) {
                    recharge += T.deepRemBonus * Math.min(day.sleep.deepRemShare / shareBase, 1.5) - T.deepRemBonus * 0.5;
                }
                if (durRatio < 0.75) notes.push(`short sleep: ${(day.sleep.asleepMin / 60).toFixed(1)}h`);
                if (day.sleep.deep < 20) notes.push('almost no deep sleep');
            } else if (day.sleep) {
                recharge = T.sleepRechargeFull * Math.min(day.sleep.asleepMin / 420, 1.3);
            } else {
                notes.push('no sleep data');
                recharge = T.sleepRechargeFull * 0.6; // assume a mediocre night rather than zero
            }

            // HRV modulates recharge efficiency
            if (day.hrv && day.hrvBand) {
                const rel = (day.hrv.mean - day.hrvBand.median) / day.hrvBand.median;
                const factor = 1 + Math.max(-1, Math.min(1, rel * 2)) * T.hrvModulation;
                recharge *= factor;
                if (day.hrvLow) notes.push(`HRV ${fmt(day.hrv.mean, 0)}ms below your p25 (${fmt(day.hrvBand.p25, 0)}ms)`);
            }

            // drain across the waking day
            const wakeHours = day.sleep ? 24 - day.sleep.asleepMin / 60 : 17;
            let drainRate = T.baseDrainPerWakeHour;
            if (day.rhr != null && day.rhrBand) {
                const rel = (day.rhr - day.rhrBand.median) / day.rhrBand.median;
                if (rel > 0) {
                    drainRate *= 1 + Math.min(rel / 0.15, 1.5) * T.rhrDrainBoost;
                    if (day.rhrHigh) notes.push(`resting HR ${fmt(day.rhr, 0)} above your p75 (${fmt(day.rhrBand.p75, 0)})`);
                }
            }
            let drain = drainRate * wakeHours;
            const steps = stepsDaily ? stepsDaily.get(day.date) : null;
            if (steps != null) drain += (steps / 1000) * T.stepsDrainPer1000;
            if (day.debtHigh) notes.push(`sleep debt ${(day.sleepDebtMin / 60).toFixed(1)}h over ${BASELINE.sleepDebtWindow}d`);

            // fill overnight (clamped at 100), drain across the waking day;
            // the plotted value is end-of-day charge
            const morning = Math.max(0, Math.min(100, charge * T.carryoverWeight + recharge));
            charge = Math.max(0, Math.min(100, morning - drain));
            out.push({ date: day.date, battery: Math.round(charge), morning: Math.round(morning), recharge: Math.round(recharge), drain: Math.round(drain), notes, status: day.status });
        }
        return out;
    }

    function describeToday(model) {
        const recent = model.filter((d) => d.hrv || d.rhr != null || d.sleep);
        const today = recent[recent.length - 1];
        if (!today) return { headline: 'No recent data.', detail: '', status: 'unknown', date: null };
        const bits = [];
        if (today.hrv && today.hrvBand) bits.push(`HRV ${fmt(today.hrv.mean, 0)}ms vs your usual ${fmt(today.hrvBand.p25, 0)}–${fmt(today.hrvBand.p75, 0)}ms`);
        else if (today.hrv) bits.push(`HRV ${fmt(today.hrv.mean, 0)}ms (baseline still warming up)`);
        if (today.rhr != null && today.rhrBand) bits.push(`resting HR ${fmt(today.rhr, 0)} vs median ${fmt(today.rhrBand.median, 0)}`);
        if (today.sleep) bits.push(`slept ${(today.sleep.asleepMin / 60).toFixed(1)}h`);
        if (today.sleepDebtMin != null && today.sleepDebtMin > 60) bits.push(`${(today.sleepDebtMin / 60).toFixed(1)}h sleep debt this week`);
        const headlines = {
            red: 'Crash signals. This is the tap on the shoulder.',
            yellow: 'Running below your baseline. Pace yourself.',
            green: 'At your baseline. Genuinely green — yours, not Apple\'s.',
            unknown: 'Not enough history yet to judge today honestly.',
        };
        return { headline: headlines[today.status], detail: `${today.date} · ` + bits.join(' · '), status: today.status, date: today.date };
    }

    const api = {
        BATTERY_TUNING, BASELINE,
        localDateKey, addDays, localDayStartIso, localDayEndIso, eachDay, percentile, fmt,
        reduceHrvDaily, reduceDailySingle, reduceDailySumBySource, reduceSleepNights,
        rollingBands, buildDailyModel, simulateBattery, describeToday,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.VelBatteryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
