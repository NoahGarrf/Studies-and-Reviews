/**
 * Ridership Study
 * Analyze a blueprint instantly. Distance-weighted ridership projection,
 * cost-efficiency metrics, and self-calibration against built stations.
 */
(function () {
    'use strict';

    var api = window.SubwayBuilderAPI;
    if (!api) {
        console.error('[Ridership Study] SubwayBuilderAPI not found.');
        return;
    }

    var MY_INSTANCE = (window.__ridershipStudyLoadCount = (window.__ridershipStudyLoadCount || 0) + 1);
    function isCurrentInstance() {
        return window.__ridershipStudyLoadCount === MY_INSTANCE;
    }

    var storage = api.storage.scoped();
    var React = api.utils.React;
    var h = React.createElement;

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------
    var CFG = {
        HOME_RADIUS_M: 1600,
        WORK_RADIUS_M: 1600,
        HOME_FALLOFF: 'hard',       // 'linear' | 'gaussian' | 'hard'
        WORK_FALLOFF: 'hard',
        STUDY_FEE_FRACTION: 0.02,
        STUDY_FEE_MIN: 25000000,
        STUDY_FEE_MAX: 100000000,
        NOISE: 0.0,                   // 0 = exact projection
        RANGE_PERCENT: 0.10,          // +/-10% shown as the reported range
        HISTORY_CAP: 50,
        CALIBRATION_ENABLED: true,
        CALIBRATION_EVAL_DAYS: 1,
        CALIBRATION_MIN_SAMPLES: 1,
        CALIBRATION_CLAMP_MIN: 0.25,
        CALIBRATION_CLAMP_MAX: 4.0,
        // Track length: assume 2 tracks per corridor. Raw total / 2 gives
        // the corridor length for typical 2-track blueprints. For 4-track
        // segments this over-reports by 2x, for single-track under-reports
        // by 2x. Good enough for cost-per-km.
        TRACKS_PER_CORRIDOR: 2
    };

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    var state = {
        studies: {},
        history: [],
        tab: 'study',
        calibration: {
            pending: {},
            samples: []
        }
    };

    var listeners = new Set();
    var panelRegistered = false;

    function notify() {
        listeners.forEach(function (fn) {
            try { fn(); } catch (err) { console.error('[Ridership Study]', err); }
        });
    }

    function useForceUpdate() {
        var pair = React.useState(0);
        var setTick = pair[1];
        React.useEffect(function () {
            var fn = function () { setTick(function (n) { return n + 1; }); };
            listeners.add(fn);
            return function () { listeners.delete(fn); };
        }, []);
    }

    // ------------------------------------------------------------------
    // Scoped scrollbar style
    // ------------------------------------------------------------------
    (function ensureScrollbarStyle() {
        if (typeof document === 'undefined') return;
        var STYLE_ID = 'ridership-study-scrollbar-style';
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '.ridership-study-scroll {' +
            '    scrollbar-width: thin;' +
            '    scrollbar-color: rgba(128,128,128,0.35) transparent;' +
            '}' +
            '.ridership-study-scroll::-webkit-scrollbar {' +
            '    width: 6px;' +
            '    height: 6px;' +
            '}' +
            '.ridership-study-scroll::-webkit-scrollbar-track {' +
            '    background: transparent;' +
            '}' +
            '.ridership-study-scroll::-webkit-scrollbar-thumb {' +
            '    background-color: rgba(128,128,128,0.30);' +
            '    border-radius: 6px;' +
            '    transition: background-color 0.15s ease;' +
            '}' +
            '.ridership-study-scroll:hover::-webkit-scrollbar-thumb {' +
            '    background-color: rgba(128,128,128,0.55);' +
            '}' +
            '.ridership-study-scroll::-webkit-scrollbar-corner {' +
            '    background: transparent;' +
            '}';
        document.head.appendChild(style);
    })();

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------
    function haversine(a, b) {
        var R = 6371000;
        var toRad = function (d) { return (d * Math.PI) / 180; };
        var dLat = toRad(b[1] - a[1]);
        var dLon = toRad(b[0] - a[0]);
        var lat1 = toRad(a[1]);
        var lat2 = toRad(b[1]);
        var s1 = Math.sin(dLat / 2);
        var s2 = Math.sin(dLon / 2);
        var x = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
        return 2 * R * Math.asin(Math.sqrt(x));
    }

    function falloffWeight(distance, radius, mode) {
        if (distance >= radius) return 0;
        if (distance <= 0) return 1;
        if (mode === 'hard') return 1;
        if (mode === 'linear') return 1 - (distance / radius);
        var sigma = radius * 0.5;
        return Math.exp(-(distance * distance) / (2 * sigma * sigma));
    }

    // ------------------------------------------------------------------
    // Game data access
    // ------------------------------------------------------------------
    function allBlueprintStations() {
        try {
            var stations = api.gameState.getStations();
            var out = [];
            for (var i = 0; i < stations.length; i++) {
                var s = stations[i];
                if (s.buildType === 'blueprint' && Array.isArray(s.coords) && s.coords.length >= 2) {
                    out.push(s);
                }
            }
            return out;
        } catch (err) {
            console.error('[Ridership Study] station read failed', err);
            return [];
        }
    }

    function allBlueprintTracks() {
        try {
            var tracks = api.gameState.getTracks();
            var out = [];
            for (var i = 0; i < tracks.length; i++) {
                if (tracks[i].buildType === 'blueprint') out.push(tracks[i]);
            }
            return out;
        } catch (err) {
            console.error('[Ridership Study] track read failed', err);
            return [];
        }
    }

    function blueprintCost() {
        var tracks = allBlueprintTracks();
        if (tracks.length === 0) return 0;
        try {
            var c = api.gameState.calculateBlueprintCost(tracks);
            var total = c && typeof c.totalCost === 'number' ? c.totalCost : 0;
            return total > 0 ? total : 0;
        } catch (err) {
            console.error('[Ridership Study] cost calc failed', err);
            return 0;
        }
    }

    // ------------------------------------------------------------------
    // Track length (raw sum / TRACKS_PER_CORRIDOR)
    // ------------------------------------------------------------------
    function coordLength(coords) {
        var total = 0;
        for (var i = 0; i < coords.length - 1; i++) {
            total += haversine(coords[i], coords[i + 1]);
        }
        return total;
    }

    function rawTrackLengthMeters() {
        var tracks = allBlueprintTracks();
        var total = 0;
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            total += (typeof t.length === 'number' && t.length > 0)
                ? t.length
                : coordLength(t.coords || []);
        }
        return total;
    }

    function getCorridorLengthMeters() {
        var divisor = Math.max(1, CFG.TRACKS_PER_CORRIDOR);
        return rawTrackLengthMeters() / divisor;
    }

    function fingerprint() {
        var stations = allBlueprintStations();
        if (stations.length === 0) return '';
        var keys = [];
        for (var i = 0; i < stations.length; i++) {
            var c = stations[i].coords;
            keys.push(c[0].toFixed(4) + ',' + c[1].toFixed(4));
        }
        keys.sort();
        return keys.join('|');
    }

    function systemRiders() {
        try {
            var stats = api.gameState.getStationRidership();
            return stats && typeof stats.total === 'number' ? stats.total : 0;
        } catch (err) {
            return 0;
        }
    }

    function constructedStationCount() {
        try {
            var all = api.gameState.getStations();
            var n = 0;
            for (var i = 0; i < all.length; i++) {
                if (all[i].buildType === 'constructed') n++;
            }
            return n;
        } catch (err) {
            return 0;
        }
    }

    // ------------------------------------------------------------------
    // Calibration
    // ------------------------------------------------------------------
    function calibrationFactor() {
        if (!CFG.CALIBRATION_ENABLED) return 1;
        var samples = state.calibration.samples;
        if (!samples || samples.length < CFG.CALIBRATION_MIN_SAMPLES) return 1;
        var weights = 0;
        var sum = 0;
        var w = 1;
        for (var i = samples.length - 1; i >= 0; i--) {
            sum += samples[i].ratio * w;
            weights += w;
            w *= 0.8;
        }
        var factor = weights > 0 ? sum / weights : 1;
        if (factor < CFG.CALIBRATION_CLAMP_MIN) factor = CFG.CALIBRATION_CLAMP_MIN;
        if (factor > CFG.CALIBRATION_CLAMP_MAX) factor = CFG.CALIBRATION_CLAMP_MAX;
        return factor;
    }

    function calibrationSampleCount() {
        return state.calibration.samples ? state.calibration.samples.length : 0;
    }

    function applyCalibration(rawRiders) {
        var f = calibrationFactor();
        return rawRiders * f;
    }

    // ------------------------------------------------------------------
    // Projection
    // ------------------------------------------------------------------
    function emptyProjection() {
        return {
            rawNewRiders: 0,
            newRiders: 0,
            calibration: 1,
            systemRiders: 0,
            systemStations: 0,
            systemRidersPerStation: 0,
            projectedRidersPerStation: 0,
            ridershipGrowthPct: 0,
            ridersPerStationGrowthPct: 0,
            blueprintCost: 0,
            lengthKm: 0,
            costPerRider: Infinity,
            costPerKm: Infinity,
            ridersPerKm: 0
        };
    }

    function project() {
        var result = emptyProjection();
        try {
            var demand = api.gameState.getDemandData();
            if (!demand || !demand.points || !demand.popsMap) return result;

            var bpStations = allBlueprintStations();
            if (bpStations.length === 0) return result;

            var allStations = api.gameState.getStations();
            var bpCoords = [];
            for (var i = 0; i < bpStations.length; i++) bpCoords.push(bpStations[i].coords);

            var allCoords = [];
            for (var k = 0; k < allStations.length; k++) {
                var st = allStations[k];
                if (Array.isArray(st.coords) && st.coords.length >= 2) allCoords.push(st.coords);
            }

            function homeWeight(location) {
                var best = 0;
                for (var a = 0; a < bpCoords.length; a++) {
                    var d = haversine(location, bpCoords[a]);
                    var w = falloffWeight(d, CFG.HOME_RADIUS_M, CFG.HOME_FALLOFF);
                    if (w > best) best = w;
                }
                return best;
            }

            function workWeight(location) {
                var best = 0;
                for (var b = 0; b < allCoords.length; b++) {
                    var d = haversine(location, allCoords[b]);
                    var w = falloffWeight(d, CFG.WORK_RADIUS_M, CFG.WORK_FALLOFF);
                    if (w > best) best = w;
                }
                return best;
            }

            var rawNewRiders = 0;
            demand.popsMap.forEach(function (pop) {
                if (!pop.residenceId || !pop.jobId) return;
                var home = demand.points.get(pop.residenceId);
                var work = demand.points.get(pop.jobId);
                if (!home || !work) return;
                if (!Array.isArray(home.location) || !Array.isArray(work.location)) return;

                var hw = homeWeight(home.location);
                if (hw <= 0) return;
                var ww = workWeight(work.location);
                if (ww <= 0) return;

                rawNewRiders += (pop.size || 0) * hw * ww;
            });

            var calibratedRiders = applyCalibration(rawNewRiders);

            var currentRiders = systemRiders();
            var constructed = constructedStationCount();
            var currentPerStation = constructed > 0 ? currentRiders / constructed : 0;

            var projectedRiders = currentRiders + calibratedRiders;
            var projectedStations = constructed + bpStations.length;
            var projectedPerStation = projectedStations > 0 ? projectedRiders / projectedStations : 0;

            var growth = currentRiders > 0
                ? (calibratedRiders / currentRiders) * 100
                : (calibratedRiders > 0 ? 100 : 0);

            var perStationGrowth = currentPerStation > 0
                ? ((projectedPerStation - currentPerStation) / currentPerStation) * 100
                : (projectedPerStation > 0 ? 100 : 0);

            var cost = blueprintCost();
            var lengthMeters = getCorridorLengthMeters();
            var lengthKm = lengthMeters / 1000;

            result.rawNewRiders = rawNewRiders;
            result.newRiders = calibratedRiders;
            result.calibration = calibrationFactor();
            result.systemRiders = currentRiders;
            result.systemStations = constructed;
            result.systemRidersPerStation = currentPerStation;
            result.projectedRidersPerStation = projectedPerStation;
            result.ridershipGrowthPct = growth;
            result.ridersPerStationGrowthPct = perStationGrowth;
            result.blueprintCost = cost;
            result.lengthKm = lengthKm;
            result.costPerRider = calibratedRiders > 0 ? cost / calibratedRiders : Infinity;
            result.costPerKm = lengthKm > 0 ? cost / lengthKm : Infinity;
            result.ridersPerKm = lengthKm > 0 ? calibratedRiders / lengthKm : 0;
            return result;
        } catch (err) {
            console.error('[Ridership Study] projection failed', err);
            return result;
        }
    }

    function addNoise(projectedRiders) {
        var reported;
        if (CFG.NOISE <= 0) {
            reported = Math.max(0, Math.round(projectedRiders));
        } else {
            var jitter = (Math.random() * 2 - 1) * CFG.NOISE;
            reported = Math.max(0, Math.round(projectedRiders * (1 + jitter)));
        }
        var low = Math.round(projectedRiders * (1 - CFG.RANGE_PERCENT));
        var high = Math.round(projectedRiders * (1 + CFG.RANGE_PERCENT));
        if (low < 0) low = 0;
        return { reported: reported, low: low, high: high };
    }

    function studyFee() {
        var c = blueprintCost();
        var fee = c * CFG.STUDY_FEE_FRACTION;
        if (fee < CFG.STUDY_FEE_MIN) return CFG.STUDY_FEE_MIN;
        if (fee > CFG.STUDY_FEE_MAX) return CFG.STUDY_FEE_MAX;
        return fee;
    }

    // ------------------------------------------------------------------
    // Persistence
    // ------------------------------------------------------------------
    function storageKey() {
        var id = api.gameState.getGameSessionId();
        return id ? 'run:' + id + ':ridership-study' : null;
    }

    function persist() {
        var key = storageKey();
        if (!key) return;
        storage.set(key, {
            studies: state.studies,
            history: state.history,
            calibration: state.calibration
        }).catch(function (err) {
            console.error('[Ridership Study] save failed', err);
        });
    }

    function restore() {
        var key = storageKey();
        if (!key) return Promise.resolve();
        return storage.get(key, {}).then(function (saved) {
            if (saved && typeof saved === 'object') {
                if (saved.studies && typeof saved.studies === 'object') state.studies = saved.studies;
                if (Array.isArray(saved.history)) state.history = saved.history;
                if (saved.calibration && typeof saved.calibration === 'object') {
                    var cal = saved.calibration;
                    state.calibration.pending = cal.pending && typeof cal.pending === 'object' ? cal.pending : {};
                    state.calibration.samples = Array.isArray(cal.samples) ? cal.samples : [];
                }
            }
        }).catch(function (err) {
            console.error('[Ridership Study] load failed', err);
        });
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    function runStudy() {
        var key = fingerprint();
        if (!key) {
            api.ui.showNotification('No blueprint to study.', 'error', 'Ridership Study');
            return;
        }
        var existing = state.studies[key];
        if (existing && existing.status === 'completed') {
            api.ui.showNotification('This blueprint already has a completed study.', 'warning', 'Ridership Study');
            return;
        }
        var fee = studyFee();
        var budget = api.gameState.getBudget();
        if (budget < fee) {
            api.ui.showNotification('Not enough money. Study fee is ' + money(fee) + '.', 'error', 'Ridership Study');
            return;
        }

        api.actions.subtractMoney(fee);

        var proj = project();
        var noisy = addNoise(proj.newRiders);
        var day = api.gameState.getCurrentDay ? api.gameState.getCurrentDay() : 0;
        var hour = api.gameState.getCurrentHour ? api.gameState.getCurrentHour() : 0;

        var record = {
            status: 'completed',
            day: day,
            hour: hour,
            fee: fee,
            reported: noisy.reported,
            low: noisy.low,
            high: noisy.high,
            projection: proj
        };

        state.studies[key] = record;
        state.history.unshift(Object.assign({ fingerprint: key }, record));
        if (state.history.length > CFG.HISTORY_CAP) {
            state.history = state.history.slice(0, CFG.HISTORY_CAP);
        }

        if (CFG.CALIBRATION_ENABLED) {
            state.calibration.pending[key] = {
                projected: proj.newRiders,
                rawProjected: proj.rawNewRiders,
                registeredDay: day,
                baselineRiders: proj.systemRiders,
                baselineStations: proj.systemStations,
                stationCoordKeys: key.split('|'),
                evaluated: false
            };
        }

        api.ui.showNotification(
            'Study complete: ' + num(noisy.reported) + ' projected new riders.',
            'success', 'Ridership Study'
        );
        persist();
        notify();
    }

    function rerunStudy() {
        var key = fingerprint();
        if (key) delete state.studies[key];
        runStudy();
    }

    function clearHistory() {
        state.studies = {};
        state.history = [];
        persist();
        notify();
    }

    function resetCalibration() {
        state.calibration.pending = {};
        state.calibration.samples = [];
        persist();
        notify();
        api.ui.showNotification('Calibration reset.', 'info', 'Ridership Study');
    }

    // ------------------------------------------------------------------
    // Calibration tracking
    // ------------------------------------------------------------------
    function constructedCoordKeys() {
        try {
            var all = api.gameState.getStations();
            var out = [];
            for (var i = 0; i < all.length; i++) {
                var s = all[i];
                if (s.buildType === 'constructed' && Array.isArray(s.coords)) {
                    out.push(s.coords[0].toFixed(4) + ',' + s.coords[1].toFixed(4));
                }
            }
            return out;
        } catch (err) {
            return [];
        }
    }

    function checkCalibration() {
        if (!CFG.CALIBRATION_ENABLED) return;
        var pending = state.calibration.pending;
        var keys = Object.keys(pending);
        if (keys.length === 0) return;

        var day = api.gameState.getCurrentDay ? api.gameState.getCurrentDay() : 0;
        var built = constructedCoordKeys();
        var builtSet = {};
        for (var b = 0; b < built.length; b++) builtSet[built[b]] = true;

        var changed = false;
        for (var i = 0; i < keys.length; i++) {
            var fp = keys[i];
            var entry = pending[fp];
            if (entry.evaluated) continue;

            var allBuilt = true;
            for (var k = 0; k < entry.stationCoordKeys.length; k++) {
                if (!builtSet[entry.stationCoordKeys[k]]) { allBuilt = false; break; }
            }
            if (!allBuilt) continue;

            if (typeof entry.constructionDay !== 'number') {
                entry.constructionDay = day;
                changed = true;
                continue;
            }
            if (day - entry.constructionDay < CFG.CALIBRATION_EVAL_DAYS) continue;

            var actualNow = systemRiders();
            var stationsNow = constructedStationCount();
            var actualPerStation = stationsNow > 0 ? actualNow / stationsNow : 0;
            var projectedPerStation = entry.baselineStations > 0
                ? (entry.baselineRiders + entry.projected) / (entry.baselineStations + entry.stationCoordKeys.length)
                : 0;

            var sampleRatio;
            if (projectedPerStation > 0 && actualPerStation > 0) {
                sampleRatio = actualPerStation / projectedPerStation;
            } else if (entry.projected > 0) {
                var actualGrowth = actualNow - entry.baselineRiders;
                sampleRatio = actualGrowth / entry.projected;
            } else {
                entry.evaluated = true;
                changed = true;
                continue;
            }

            if (!Number.isFinite(sampleRatio) || sampleRatio <= 0) {
                entry.evaluated = true;
                changed = true;
                continue;
            }

            state.calibration.samples.push({
                ratio: sampleRatio,
                day: day,
                fingerprint: fp
            });
            if (state.calibration.samples.length > 20) {
                state.calibration.samples = state.calibration.samples.slice(-20);
            }
            entry.evaluated = true;
            changed = true;

            console.log(
                '[Ridership Study] Calibration sample: actual/projected = ' +
                sampleRatio.toFixed(3) + ' (factor now ' + calibrationFactor().toFixed(3) + ')'
            );
        }

        if (changed) {
            persist();
            notify();
        }
    }

    // ------------------------------------------------------------------
    // Formatting
    // ------------------------------------------------------------------
    function money(n) {
        if (!Number.isFinite(n)) return '\u2014';
        var abs = Math.abs(n);
        if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
        if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
        return '$' + Math.round(n);
    }

    function moneyExact(n) {
        if (!Number.isFinite(n)) return '\u2014';
        return '$' + Math.round(n).toLocaleString();
    }

    function num(n) {
        if (!Number.isFinite(n)) return '\u2014';
        return Math.round(n).toLocaleString();
    }

    function ratio(n) {
        if (!Number.isFinite(n)) return '\u2014';
        if (n >= 100) return Math.round(n).toLocaleString();
        return n.toFixed(1);
    }

    // ------------------------------------------------------------------
    // UI primitives
    // ------------------------------------------------------------------
    function row(label, value, opts) {
        var o = opts || {};
        var vStyle = { fontWeight: o.bold ? 700 : 600 };
        if (o.color) vStyle.color = o.color;
        return h('div', {
            style: { display: 'flex', justifyContent: 'space-between', gap: 8 }
        }, [
            h('span', { key: 'l', style: { opacity: 0.7 } }, label),
            h('span', { key: 'v', style: vStyle }, value)
        ]);
    }

    function divider(key) {
        return h('div', {
            key: key,
            style: { borderTop: '1px solid rgba(128,128,128,0.25)', margin: '6px 0' }
        });
    }

    function tabButton(key, label) {
        var active = state.tab === key;
        return h('button', {
            key: key,
            onClick: function () { state.tab = key; notify(); },
            style: {
                flex: 1,
                padding: '6px 8px',
                borderRadius: 6,
                border: 'none',
                background: active ? '#3b82f6' : 'rgba(128,128,128,0.15)',
                color: active ? 'white' : 'inherit',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 11
            }
        }, label);
    }

    // ------------------------------------------------------------------
    // Study tab
    // ------------------------------------------------------------------
    function studyTab() {
        var key = fingerprint();
        var stations = allBlueprintStations();
        var cost = blueprintCost();
        var fee = studyFee();
        var existing = key ? state.studies[key] : null;

        if (!key || stations.length === 0) {
            return h('div', {
                style: {
                    padding: 16,
                    fontSize: 13,
                    opacity: 0.7,
                    textAlign: 'center',
                    lineHeight: 1.5
                }
            }, [
                h('div', { key: 'title', style: { fontWeight: 700, marginBottom: 6 } }, 'Ridership Study'),
                h('div', { key: 'body' }, 'Place a blueprint to run a study.')
            ]);
        }

        if (existing && existing.status === 'completed') {
            var p = existing.projection;
            var kids = [];
            var cf = calibrationFactor();
            var samples = calibrationSampleCount();
            var rangePct = (CFG.RANGE_PERCENT * 100).toFixed(0);

            kids.push(h('div', {
                key: 'riders',
                style: {
                    padding: 12,
                    borderRadius: 6,
                    background: 'rgba(59,130,246,0.1)',
                    border: '1px solid rgba(59,130,246,0.3)'
                }
            }, [
                h('div', { key: 'l', style: { fontSize: 11, opacity: 0.7, marginBottom: 4 } }, 'Projected New Riders'),
                h('div', { key: 'v', style: { fontSize: 22, fontWeight: 700 } }, num(existing.reported)),
                h('div', { key: 'r', style: { fontSize: 11, opacity: 0.7, marginTop: 4 } },
                    'Range: ' + num(existing.low) + ' \u2013 ' + num(existing.high) +
                    ' (\u00B1' + rangePct + '%)')
            ]));

            if (CFG.CALIBRATION_ENABLED) {
                kids.push(h('div', {
                    key: 'cal',
                    style: {
                        padding: 8,
                        borderRadius: 6,
                        background: 'rgba(234,179,8,0.08)',
                        border: '1px solid rgba(234,179,8,0.25)',
                        fontSize: 11,
                        lineHeight: 1.4
                    }
                }, [
                    h('div', { key: 'a' },
                        'Calibration factor: ' + cf.toFixed(3) + 'x' +
                        (samples > 0 ? ' (' + samples + ' sample' + (samples === 1 ? '' : 's') + ')' : ' (no samples yet)')),
                    h('div', { key: 'b', style: { opacity: 0.7, marginTop: 2 } },
                        'Raw projection: ' + num(p.rawNewRiders) + ' riders before calibration')
                ]));
            }

            kids.push(divider('d1'));
            kids.push(h('div', { key: 'sh', style: { fontWeight: 700, fontSize: 12, opacity: 0.85 } }, 'System Impact'));
            kids.push(row('Current system riders', num(p.systemRiders)));
            kids.push(row('Current stations', num(p.systemStations)));
            kids.push(row('Current riders per station', ratio(p.systemRidersPerStation)));
            kids.push(row('Projected riders per station', ratio(p.projectedRidersPerStation)));
            kids.push(row('Ridership growth', '+' + p.ridershipGrowthPct.toFixed(1) + '%', { color: '#22c55e' }));
            kids.push(row('Riders per station growth', '+' + p.ridersPerStationGrowthPct.toFixed(1) + '%', { color: '#22c55e' }));

            kids.push(divider('d2'));
            kids.push(h('div', { key: 'ch', style: { fontWeight: 700, fontSize: 12, opacity: 0.85 } }, 'Cost Metrics'));
            kids.push(row('Blueprint cost', moneyExact(p.blueprintCost)));
            kids.push(row('Cost per new rider',
                Number.isFinite(p.costPerRider) ? moneyExact(p.costPerRider) : '\u221e',
                { bold: true, color: '#eab308' }));
            kids.push(row('Network length', p.lengthKm.toFixed(2) + ' km'));
            kids.push(row('Cost per km',
                Number.isFinite(p.costPerKm) ? money(p.costPerKm) : '\u2014',
                { bold: true, color: '#eab308' }));
            kids.push(row('Riders per km',
                p.ridersPerKm > 0 ? ratio(p.ridersPerKm) : '\u2014',
                { bold: true, color: '#22c55e' }));

            kids.push(divider('d3'));
            kids.push(h('button', {
                key: 'rerun',
                onClick: rerunStudy,
                style: {
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#3b82f6',
                    color: 'white',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontSize: 12
                }
            }, 'Re-run study \u2014 ' + money(fee)));

            return h('div', {
                style: { display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }
            }, kids);
        }

        return h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }
        }, [
            h('div', { key: 'title', style: { fontWeight: 700, fontSize: 14 } }, 'Request Ridership Study'),
            h('div', {
                key: 'desc',
                style: { fontSize: 12, opacity: 0.8, lineHeight: 1.5 }
            }, 'Distance-weighted projection of new ridership, plus cost-efficiency metrics.'),
            divider('d0'),
            h('div', {
                key: 'summary',
                style: {
                    padding: 12,
                    borderRadius: 6,
                    background: 'rgba(34,197,94,0.06)',
                    border: '1px solid rgba(34,197,94,0.25)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4
                }
            }, [
                row('Blueprint stations', num(stations.length)),
                row('Blueprint cost', moneyExact(cost)),
                CFG.CALIBRATION_ENABLED
                    ? row('Calibration factor',
                        calibrationFactor().toFixed(3) + 'x' +
                        (calibrationSampleCount() > 0
                            ? ' (' + calibrationSampleCount() + ')'
                            : ' (none yet)'))
                    : null
            ].filter(Boolean)),
            h('button', {
                key: 'go',
                onClick: runStudy,
                style: {
                    padding: '12px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#22c55e',
                    color: 'white',
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontSize: 14
                }
            }, 'Run study \u2014 ' + money(fee))
        ]);
    }

    // ------------------------------------------------------------------
    // History tab
    // ------------------------------------------------------------------
    function historyTab() {
        var cf = calibrationFactor();
        var samples = calibrationSampleCount();
        var rangePct = (CFG.RANGE_PERCENT * 100).toFixed(0);

        var calCard = CFG.CALIBRATION_ENABLED ? h('div', {
            key: 'calcard',
            style: {
                padding: 10,
                borderRadius: 6,
                background: 'rgba(234,179,8,0.08)',
                border: '1px solid rgba(234,179,8,0.25)',
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 2
            }
        }, [
            h('div', { key: 'h', style: { fontWeight: 700, marginBottom: 2 } }, 'Calibration'),
            row('Factor', cf.toFixed(3) + 'x'),
            row('Samples', samples + ' / ' + CFG.CALIBRATION_MIN_SAMPLES + ' needed'),
            row('Pending evaluations', Object.keys(state.calibration.pending).filter(function (k) {
                return !state.calibration.pending[k].evaluated;
            }).length),
            h('button', {
                key: 'reset',
                onClick: resetCalibration,
                style: {
                    marginTop: 6,
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(239,68,68,0.4)',
                    background: 'transparent',
                    color: '#ef4444',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer'
                }
            }, 'Reset calibration')
        ]) : null;

        if (state.history.length === 0) {
            return h('div', {
                style: { display: 'flex', flexDirection: 'column', gap: 8 }
            }, [
                calCard,
                h('div', {
                    key: 'empty',
                    style: { fontSize: 12, opacity: 0.6, textAlign: 'center', padding: 16 }
                }, 'No studies yet.')
            ].filter(Boolean));
        }

        var entries = state.history.map(function (entry, idx) {
            var p = entry.projection;
            return h('div', {
                key: idx,
                style: {
                    padding: 10,
                    borderRadius: 6,
                    border: '1px solid rgba(128,128,128,0.3)',
                    background: 'rgba(128,128,128,0.05)',
                    fontSize: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2
                }
            }, [
                h('div', {
                    key: 'h',
                    style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 }
                }, [
                    h('span', { key: 'r', style: { fontWeight: 700 } },
                        num(entry.reported) + ' new riders'),
                    h('span', { key: 'd', style: { opacity: 0.6, fontSize: 11 } },
                        'Day ' + entry.day)
                ]),
                h('div', { key: 'rg', style: { fontSize: 10, opacity: 0.55, marginBottom: 2 } },
                    'Range: ' + num(entry.low) + ' \u2013 ' + num(entry.high) +
                    ' (\u00B1' + rangePct + '%)'),
                row('Cost per rider',
                    Number.isFinite(p.costPerRider) ? moneyExact(p.costPerRider) : '\u221e'),
                row('Cost per km',
                    Number.isFinite(p.costPerKm) ? money(p.costPerKm) : '\u2014'),
                row('Riders per km',
                    p.ridersPerKm > 0 ? ratio(p.ridersPerKm) : '\u2014'),
                row('Network length', p.lengthKm.toFixed(2) + ' km')
            ]);
        });

        return h('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 8 }
        }, [
            calCard,
            h('div', {
                key: 'header',
                style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }
            }, [
                h('div', { key: 't', style: { fontWeight: 700, fontSize: 14 } }, 'Study History'),
                h('button', {
                    key: 'clear',
                    onClick: clearHistory,
                    style: {
                        padding: '4px 10px',
                        borderRadius: 6,
                        border: '1px solid rgba(239,68,68,0.4)',
                        background: 'transparent',
                        color: '#ef4444',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer'
                    }
                }, 'Clear')
            ]),
            entries
        ].filter(Boolean));
    }

    // ------------------------------------------------------------------
    // Panel
    // ------------------------------------------------------------------
    function panel() {
        return h('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 8,
                height: '100%',
                boxSizing: 'border-box',
                overflow: 'hidden'
            }
        }, [
            h('div', {
                key: 'tabs',
                style: { display: 'flex', gap: 4, flexShrink: 0 }
            }, [
                tabButton('study', 'Study'),
                tabButton('history', 'History (' + state.history.length + ')')
            ]),
            h('div', {
                key: 'body',
                className: 'ridership-study-scroll',
                style: {
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    paddingRight: 6
                }
            }, state.tab === 'history' ? historyTab() : studyTab())
        ]);
    }

    function PanelRoot() {
        useForceUpdate();
        return panel();
    }

    function registerPanel() {
        if (!isCurrentInstance()) return;
        if (panelRegistered) return;
        if (window.__ridershipStudyPanelInstance === MY_INSTANCE) {
            panelRegistered = true;
            return;
        }
        try {
            var sid = api.gameState.getGameSessionId() || 'nosession';
            api.ui.addFloatingPanel({
                id: 'ridership-study-panel-' + MY_INSTANCE + '-' + sid,
                icon: 'BarChart3',
                tooltip: 'Ridership Study',
                title: 'Ridership Study',
                defaultWidth: 340,
                defaultHeight: 480,
                minWidth: 280,
                minHeight: 240,
                render: function () { return h(PanelRoot); }
            });
            panelRegistered = true;
            window.__ridershipStudyPanelInstance = MY_INSTANCE;
        } catch (err) {
            console.error('[Ridership Study] panel registration failed', err);
        }
    }

    // ------------------------------------------------------------------
    // Lifecycle hooks
    // ------------------------------------------------------------------
    api.hooks.onGameInit(function () {
        if (!isCurrentInstance()) return;
        state.studies = {};
        state.history = [];
        state.tab = 'study';
        state.calibration = { pending: {}, samples: [] };
        panelRegistered = false;
        window.__ridershipStudyPanelInstance = null;
        registerPanel();
        notify();
    });

    api.hooks.onGameLoaded(function () {
        if (!isCurrentInstance()) return;
        registerPanel();
        restore().then(function () {
            registerPanel();
            notify();
        });
    });

    api.hooks.onCityLoad(function () {
        if (!isCurrentInstance()) return;
        registerPanel();
        notify();
    });

    api.hooks.onGameSaved(function () {
        if (!isCurrentInstance()) return;
        persist();
    });

    api.hooks.onGameEnd(function () {
        if (!isCurrentInstance()) return;
        persist();
        panelRegistered = false;
        window.__ridershipStudyPanelInstance = null;
    });

    api.hooks.onBlueprintPlaced(function () {
        if (!isCurrentInstance()) return;
        notify();
    });

    api.hooks.onTrackChange(function () {
        if (!isCurrentInstance()) return;
        notify();
    });

    api.hooks.onStationBuilt(function () {
        if (!isCurrentInstance()) return;
        notify();
    });

    api.hooks.onDayChange(function () {
        if (!isCurrentInstance()) return;
        checkCalibration();
    });

    // ------------------------------------------------------------------
    // Debug
    // ------------------------------------------------------------------
    window.__ridershipStudy = {
        forceRegisterPanel: function () {
            panelRegistered = false;
            window.__ridershipStudyPanelInstance = null;
            registerPanel();
            notify();
            console.log('[Ridership Study] Force-registered panel.');
        },
        panelStatus: function () {
            var out = {
                instance: MY_INSTANCE,
                registered: panelRegistered,
                windowInstance: window.__ridershipStudyPanelInstance,
                currentLoadCount: window.__ridershipStudyLoadCount
            };
            console.log(out);
            return out;
        },
        project: function () {
            var p = project();
            console.log(p);
            return p;
        },
        runStudy: runStudy,
        clear: clearHistory,
        resetCalibration: resetCalibration,
        calibration: function () {
            var out = {
                factor: calibrationFactor(),
                samples: state.calibration.samples,
                pending: state.calibration.pending
            };
            console.log(out);
            return out;
        },
        dump: function () {
            console.log('studies:', state.studies);
            console.log('history:', state.history);
            console.log('calibration:', state.calibration);
        },
        rawTrackLength: function () {
            return rawTrackLengthMeters();
        },
        corridorLength: function () {
            return getCorridorLengthMeters();
        },
        compareTrackLengths: function () {
            var raw = rawTrackLengthMeters();
            var corr = getCorridorLengthMeters();
            var tracks = allBlueprintTracks();
            var out = {
                rawMeters: Math.round(raw),
                rawKm: (raw / 1000).toFixed(2),
                corridorMeters: Math.round(corr),
                corridorKm: (corr / 1000).toFixed(2),
                trackCount: tracks.length,
                divisor: CFG.TRACKS_PER_CORRIDOR
            };
            console.log('[Ridership Study] Track length comparison:', out);
            return out;
        }
    };

    registerPanel();
    console.log('[Ridership Study] Ready (instance ' + MY_INSTANCE + ').');
})();