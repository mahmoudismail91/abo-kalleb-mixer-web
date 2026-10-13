// The swamp: a living map on top of the sampler.
//
// Pads switched on become creatures on the map. Where a creature is decides how it sounds:
//   - distance to the centre is presence: close = loud and clear, far = faint; left/right on the map is stereo.
//   - the area it sits in decides its behaviour. Each area has its own algorithm:
//       Clearing (centre)  steady euclidean groove, denser the more energy the creature has
//       Water              hits that ripple out in falling echoes
//       Reeds              insect bursts: fast, short stutters
//       Mud                rare, deep, slow swells an octave or a fifth down
//       Canopy             calls, and other canopy creatures answer a few steps later
// The system keeps moving on its own: creatures wander, tire when they play a lot and recover when quiet,
// drift along the currents you draw, and a slow day/night cycle shifts which areas are loud.
// Pressing a creature's key feeds it: it plays, gains energy, steps towards the centre and wakes its neighbours.
//
// pad.seq: 0 = not on the map, 1 = settled (stays near where you put it), 2 = wanderer (roams between areas)
// pad.mx / pad.my: its position on the map, 0..1 (kept in kits)

const SEQ_NAMES = ['off the map', 'settled', 'wanderer'];
const AREAS = {
    clearing: { name: 'Clearing', color: '#fff4b8' },
    water:    { name: 'Water',    color: '#bfe2ff' },
    reeds:    { name: 'Reeds',    color: '#cdeeb0' },
    mud:      { name: 'Mud',      color: '#dcc6a4' },
    canopy:   { name: 'Canopy',   color: '#9fd3a9' },
};
const SEEDS = [
    ['water', 0.22, 0.28], ['water', 0.80, 0.78],
    ['reeds', 0.78, 0.22], ['reeds', 0.28, 0.82],
    ['mud', 0.07, 0.62],   ['mud', 0.94, 0.42],
    ['canopy', 0.50, 0.06], ['canopy', 0.55, 0.96],
];
const CLEARING_R = 0.17;

let machineOn = false, machineTimer = null, nextStepTime = 0, stepIndex = 0, machineRaf = null;
let startedAt = 0;
let currents = [];          // drawn strokes: arrays of {x, y}; creatures near one get carried along its direction
const life = new WeakMap(); // pad -> { vx, vy, energy, flash, seed }
let mapBg = null, mapBgSize = '';

const mval = id => parseFloat($(id).value);
const stepDur = () => 60 / mval('m-bpm') / 4;
const aspect = () => { const cv = $('m-map'); return cv.clientWidth / Math.max(1, cv.clientHeight) || 2; };

// ---------- the map ----------
// Distance from the centre, with x stretched by the map's shape so circles look round.
function centreDist(x, y) { return Math.hypot((x - 0.5) * aspect(), y - 0.5); }

function areaAt(x, y) {
    if (centreDist(x, y) < CLEARING_R * 1.15) return 'clearing';
    // a little warp so the borders look like a shore, not a diagram
    const wx = x + 0.04 * Math.sin(y * 13 + 1.3), wy = y + 0.04 * Math.sin(x * 11 + 0.7);
    let best = null, bd = Infinity;
    SEEDS.forEach(([area, sx, sy]) => {
        const d = Math.hypot(wx - sx, wy - sy);
        if (d < bd) { bd = d; best = area; }
    });
    return best;
}

// 1 at the centre, 0 at the far corners.
function presence(x, y) { return clamp(1 - centreDist(x, y) / Math.hypot(0.5 * aspect(), 0.5), 0, 1); }

// ---------- creatures ----------
function creatures() {
    const out = [];
    bankOrder.forEach(cat => banks[cat].pads.forEach((pad, i) => {
        if (!pad || !pad.seq) return;
        if (pad.mx == null) placeAtEdge(pad);
        if (!life.has(pad)) life.set(pad, { vx: 0, vy: 0, energy: 0.6, flash: 0, seed: Math.floor(Math.random() * 16) });
        out.push({ pad, cat, i, s: life.get(pad) });
    }));
    return out;
}

// New creatures arrive from somewhere along the edge of the swamp.
function placeAtEdge(pad) {
    const t = Math.random();
    const side = Math.floor(Math.random() * 4);
    pad.mx = side === 0 ? t : side === 1 ? 0.95 : side === 2 ? t : 0.05;
    pad.my = side === 0 ? 0.06 : side === 1 ? t : side === 2 ? 0.94 : t;
}

function cycleSeq(i) {
    const pad = padAt(i);
    if (!pad) return setStatus("Put a sound on this pad first");
    pad.seq = (pad.seq + 1) % 3;
    if (pad.seq === 1 && pad.mx == null) placeAtEdge(pad);
    paintPad(i);
    drawMap();
    setStatus(`${keyLabel(KEYS[i])}: ${SEQ_NAMES[pad.seq]}` + (pad.seq && !machineOn ? ' · press Enter or ▶ Run to wake the swamp' : ''));
}

// A key press on a creature: it calls out (the sampler already played it), gains energy,
// moves a step towards the centre and wakes up whoever is near.
function machineFeed(pad) {
    if (!pad.seq || pad.mx == null) return;
    const s = life.get(pad);
    if (!s) return;
    s.energy = Math.min(1, s.energy + 0.45);
    s.flash = audioCtx.currentTime;
    pad.mx += (0.5 - pad.mx) * 0.12;
    pad.my += (0.5 - pad.my) * 0.12;
    creatures().forEach(c => {
        if (c.pad === pad) return;
        const d = Math.hypot((c.pad.mx - pad.mx) * aspect(), c.pad.my - pad.my);
        if (d < 0.25) c.s.energy = Math.min(1, c.s.energy + 0.25 * (1 - d / 0.25));
    });
}

function scatterCreatures() {
    creatures().forEach(c => { c.pad.mx = rand(0.06, 0.94); c.pad.my = rand(0.08, 0.92); c.s.vx = c.s.vy = 0; });
    drawMap();
}

// ---------- time: wandering, tiring, seasons ----------
const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

function seasonPeriod() { return 240 / (0.25 + mval('m-evolve') * 1.75); }   // seconds for a whole day and night
// near 1 at noon, near 0 at midnight
function daylight(t = audioCtx ? audioCtx.currentTime : 0) {
    return (Math.sin((t - startedAt) / seasonPeriod() * Math.PI * 2) + 1) / 2 * 0.9 + 0.05;   // starts at dawn
}
function seasonName(d) { return d > 0.75 ? 'day' : d < 0.25 ? 'night' : (Math.cos(((audioCtx.currentTime - startedAt) / seasonPeriod()) * Math.PI * 2) > 0 ? 'dawn' : 'dusk'); }

function currentForce(x, y) {
    let fx = 0, fy = 0;
    const R = 0.09;
    currents.forEach(stroke => {
        for (let k = 1; k < stroke.length; k++) {
            const a = stroke[k - 1], b = stroke[k];
            const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
            if (!len2) continue;
            const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1);
            const px = a.x + dx * t, py = a.y + dy * t, d = Math.hypot((x - px) * aspect(), y - py);
            if (d > R) continue;
            const w = 1 - d / R, len = Math.sqrt(len2);
            fx += dx / len * 0.0035 * w + (px - x) * 0.02 * w;
            fy += dy / len * 0.0035 * w + (py - y) * 0.02 * w;
        }
    });
    return [fx, fy];
}

function moveCreatures(list) {
    const evolve = mval('m-evolve');
    list.forEach(({ pad, s }) => {
        const wanderer = pad.seq === 2;
        const wander = (0.0006 + evolve * 0.0035) * (wanderer ? 1.6 : 0.35) * (0.5 + s.energy);
        const [fx, fy] = currentForce(pad.mx, pad.my);
        s.vx = (s.vx + randn() * wander + fx) * (wanderer ? 0.94 : 0.86);
        s.vy = (s.vy + randn() * wander + fy) * (wanderer ? 0.94 : 0.86);
        pad.mx += s.vx;
        pad.my += s.vy;
        if (pad.mx < 0.02 || pad.mx > 0.98) { s.vx *= -0.6; pad.mx = clamp(pad.mx, 0.02, 0.98); }
        if (pad.my < 0.03 || pad.my > 0.97) { s.vy *= -0.6; pad.my = clamp(pad.my, 0.03, 0.97); }
        s.energy = Math.min(1, s.energy + 0.004 * (1 - s.energy));   // quiet creatures recover
    });
}

// ---------- transport ----------
function toggleMachine() { machineOn ? stopMachine() : startMachine(); }

function startMachine() {
    ensureAudio();
    if (!creatures().length) setStatus("Click the small dot on a pad to put that sound on the map (once: settled, twice: wanderer)");
    machineOn = true;
    stepIndex = 0;
    nextStepTime = audioCtx.currentTime + 0.08;
    if (!startedAt) startedAt = audioCtx.currentTime;
    clearInterval(machineTimer);
    machineTimer = setInterval(scheduler, 25);
    scheduler();
    $('m-run').innerText = '■ Stop';
    $('m-run').classList.add('btn-on');
    cancelAnimationFrame(machineRaf);
    const frame = () => { drawMap(); if (machineOn) machineRaf = requestAnimationFrame(frame); };
    frame();
}

function stopMachine() {
    if (!machineOn) return;
    machineOn = false;
    clearInterval(machineTimer);
    cancelAnimationFrame(machineRaf);
    $('m-run').innerText = '▶ Run';
    $('m-run').classList.remove('btn-on');
    drawMap();
}

// Schedules every step that starts within the next ~120 ms, so timing stays tight even when the page is busy.
function scheduler() {
    const sd = stepDur();
    while (nextStepTime < audioCtx.currentTime + 0.12) {
        const swing = stepIndex % 2 ? mval('m-organic') * 0.16 * sd : 0;
        playStep(stepIndex, nextStepTime + swing, sd);
        nextStepTime += sd;
        stepIndex = (stepIndex + 1) % 64;
    }
}

// ---------- what each area does ----------
// Euclidean rhythm: k hits spread as evenly as possible over n steps.
const euclid = (k, n, step, rot) => ((step + rot) % n) * k % n < k;

const ALGOS = {
    clearing(c, step, when, sd, L) {
        const k = 1 + Math.round(c.s.energy * 6);
        if (!euclid(k, 16, step, c.s.seed) || Math.random() > 0.35 + 0.65 * L) return;
        hit(c, when, { gain: 0.75 + 0.25 * Math.random() });
    },
    water(c, step, when, sd, L) {
        if (step % 4 || Math.random() > L * 0.45 * (0.4 + c.s.energy)) return;
        hit(c, when, { gain: 0.9 });
        let g = 0.9, t = when, det = 0;
        for (let n = 2 + Math.floor(Math.random() * 3); n > 0; n--) {
            t += sd * 3; g *= 0.55; det -= 0.35;
            hit(c, t, { gain: g, detune: det, quiet: true });
        }
    },
    reeds(c, step, when, sd, L) {
        if (Math.random() > L * 0.11 * (0.3 + c.s.energy) * (1.4 - daylight(when))) return;
        const n = 3 + Math.floor(Math.random() * 7), det = rand(-0.6, 0.6);
        for (let k = 0; k < n; k++) hit(c, when + k * sd / 2, { gain: rand(0.3, 0.85), detune: det + rand(-0.1, 0.1), dur: sd * 0.4, quiet: k > 0 });
    },
    mud(c, step, when, sd, L) {
        if (Math.random() > L * 0.035 * (0.5 + c.s.energy) * (1.3 - 0.6 * daylight(when))) return;
        hit(c, when, { gain: 0.8, detune: Math.random() < 0.5 ? -12 : -7, attack: rand(0.12, 0.4) });
    },
    canopy(c, step, when, sd, L, all) {
        if (Math.random() > L * 0.07 * (0.4 + c.s.energy) * (0.4 + daylight(when))) return;
        const notes = [0, 2, 4, 7, 9];
        hit(c, when, { gain: 0.8, detune: notes[Math.floor(Math.random() * notes.length)] });
        all.filter(o => o !== c && o.area === 'canopy').forEach(o => {
            if (Math.random() < 0.6) hit(o, when + sd * Math.floor(rand(2, 7)), { gain: 0.6, detune: notes[Math.floor(Math.random() * notes.length)] });
        });
    },
};

function playStep(step, when, sd) {
    const L = mval('m-life');
    const all = creatures();
    moveCreatures(all);
    all.forEach(c => { c.area = areaAt(c.pad.mx, c.pad.my); });
    all.forEach(c => {
        if (!c.pad.hit) { if (!c.pad.loading) loadPad(c.pad); return; }
        ALGOS[c.area](c, step, when, sd, L, all);
    });
}

// Every hit goes through here: presence sets the level, the map's x sets the pan, Organic loosens timing.
function hit(c, when, o = {}) {
    const { pad, s } = c;
    const org = mval('m-organic');
    const pres = presence(pad.mx, pad.my);
    const late = org * rand(0, 0.18) * stepDur();
    startVoice(pad, when + late, {
        gain: (o.gain ?? 1) * (0.1 + 0.9 * Math.pow(pres, 1.3)),
        pan: clamp((pad.mx - 0.5) * 1.8, -1, 1),
        detune: (o.detune || 0) + rand(-0.12, 0.12) * org,
        attack: o.attack,
        dur: o.dur || (pad.mode === 'gate' ? stepDur() * 2 : 0),
    });
    s.energy = Math.max(0, s.energy - (o.quiet ? 0.01 : 0.035));   // playing tires a creature out
    const at = when + late;
    setTimeout(() => {
        s.flash = audioCtx.currentTime;
        if (c.cat === currentBank) flashPad(c.i);
    }, Math.max(0, (at - audioCtx.currentTime) * 1000));
}

['m-life', 'm-evolve', 'm-organic'].forEach(id => {
    const show = () => { $(id + '-val').innerText = mval(id).toFixed(2); };
    $(id).addEventListener('input', show);
    show();
});
$('m-bpm').addEventListener('change', () => { $('m-bpm').value = clamp(mval('m-bpm') || 96, 40, 240); });

// ---------- mouse: throw creatures, draw currents ----------
(function bindMap() {
    const cv = $('m-map');
    let grab = null, stroke = null, erasing = false, lastPt = null;
    const at = (e) => { const r = cv.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }; };
    const creatureAt = (p) => {
        let best = null, bd = 0.05;
        creatures().forEach(c => { const d = Math.hypot((c.pad.mx - p.x) * aspect(), c.pad.my - p.y); if (d < bd) { bd = d; best = c; } });
        return best;
    };
    const eraseNear = (p) => {
        currents = currents.map(st => st.filter(q => Math.hypot((q.x - p.x) * aspect(), q.y - p.y) > 0.05)).filter(st => st.length > 1);
    };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
        const p = at(e);
        cv.setPointerCapture(e.pointerId);
        erasing = e.button === 2 || e.shiftKey;
        if (erasing) { eraseNear(p); drawMap(); return; }
        const c = creatureAt(p);
        if (c) { grab = c; lastPt = { ...p, t: performance.now() }; return; }
        stroke = [p];
        currents.push(stroke);
        if (currents.length > 12) currents.shift();
    });
    cv.addEventListener('pointermove', (e) => {
        const p = at(e);
        if (erasing && e.buttons) { eraseNear(p); drawMap(); return; }
        if (grab) {
            grab.s.vx = (p.x - lastPt.x) * 0.5;
            grab.s.vy = (p.y - lastPt.y) * 0.5;
            grab.pad.mx = p.x; grab.pad.my = p.y;
            lastPt = p;
            drawMap();
            return;
        }
        if (stroke) {
            const q = stroke[stroke.length - 1];
            if (Math.hypot((p.x - q.x) * aspect(), p.y - q.y) > 0.015) { stroke.push(p); drawMap(); }
            return;
        }
        cv.style.cursor = creatureAt(p) ? 'grab' : 'crosshair';
    });
    const up = () => {
        if (stroke && stroke.length < 2) currents = currents.filter(st => st !== stroke);
        if (grab) { const pad = grab.pad; setStatus(`${keyLabel(KEYS[grab.i])} is in the ${AREAS[areaAt(pad.mx, pad.my)].name.toLowerCase()}`); }
        grab = stroke = null; erasing = false;
        drawMap();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
})();

function clearCurrents() { currents = []; drawMap(); }

// ---------- drawing ----------
function renderMapBg(w, h) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), cell = Math.max(3, Math.round(w / 180));
    for (let y = 0; y < h; y += cell) {
        for (let x = 0; x < w; x += cell) {
            g.fillStyle = AREAS[areaAt((x + cell / 2) / w, (y + cell / 2) / h)].color;
            g.fillRect(x, y, cell, cell);
        }
    }
    g.font = `bold ${12 * (window.devicePixelRatio || 1)}px Courier New, monospace`;
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    g.textAlign = 'center';
    SEEDS.forEach(([area, sx, sy]) => g.fillText(AREAS[area].name.toUpperCase(), sx * w, sy * h + 4));
    g.fillText('CLEARING', w / 2, h / 2 + CLEARING_R * h + 14);
    // presence rings around the centre
    g.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    g.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(f => {
        g.beginPath();
        g.ellipse(w / 2, h / 2, f * w / 2, f * h / 2, 0, 0, Math.PI * 2);
        g.stroke();
    });
    return cv;
}

function drawMap() {
    const cv = $('m-map'), dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (!w) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    if (mapBgSize !== `${w}x${h}`) { mapBg = renderMapBg(w, h); mapBgSize = `${w}x${h}`; }
    const g = cv.getContext('2d');
    g.drawImage(mapBg, 0, 0);

    const now = audioCtx ? audioCtx.currentTime : 0;
    if (audioCtx && startedAt) {
        const d = daylight(now);
        g.fillStyle = `rgba(10, 20, 60, ${(1 - d) * 0.25})`;
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#000';
        g.font = `bold ${11 * dpr}px Courier New, monospace`;
        g.textAlign = 'right';
        g.fillText(seasonName(d).toUpperCase(), w - 8 * dpr, 16 * dpr);
    }

    // currents
    g.strokeStyle = 'rgba(0, 90, 200, 0.7)';
    g.lineWidth = 3 * dpr;
    g.lineJoin = g.lineCap = 'round';
    g.setLineDash([8 * dpr, 6 * dpr]);
    g.lineDashOffset = -now * 30 * dpr;   // the dashes flow in the stroke's direction
    currents.forEach(st => {
        g.beginPath();
        st.forEach((p, k) => (k ? g.lineTo(p.x * w, p.y * h) : g.moveTo(p.x * w, p.y * h)));
        g.stroke();
    });
    g.setLineDash([]);

    // centre: the listener
    g.strokeStyle = '#000';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.arc(w / 2, h / 2, 5 * dpr, 0, Math.PI * 2);
    g.stroke();

    // creatures
    g.textAlign = 'center';
    g.font = `bold ${12 * dpr}px Courier New, monospace`;
    creatures().forEach(c => {
        const x = c.pad.mx * w, y = c.pad.my * h, r = (7 + 9 * c.s.energy) * dpr;
        const age = now - c.s.flash;
        if (age >= 0 && age < 0.6) {
            g.strokeStyle = `rgba(255, 60, 0, ${1 - age / 0.6})`;
            g.lineWidth = 3 * dpr;
            g.beginPath();
            g.arc(x, y, r + age * 40 * dpr, 0, Math.PI * 2);
            g.stroke();
        }
        g.fillStyle = c.pad.seq === 2 ? '#00c896' : '#ffcc00';
        g.strokeStyle = '#000';
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillStyle = '#000';
        g.fillText(keyLabel(KEYS[c.i]), x, y + 4 * dpr);
    });
}
window.addEventListener('resize', drawMap);

// ---------- kits ----------
function machineState() {
    return {
        bpm: mval('m-bpm'), life: mval('m-life'), evolve: mval('m-evolve'), organic: mval('m-organic'),
        currents: currents.map(st => st.map(p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }))),
    };
}

function applyMachineState(m) {
    if (m.bpm) $('m-bpm').value = m.bpm;
    ['life', 'evolve', 'organic'].forEach(k => {
        if (m[k] == null) return;
        $('m-' + k).value = m[k];
        $('m-' + k).dispatchEvent(new Event('input'));
    });
    if (Array.isArray(m.currents)) currents = m.currents.filter(st => Array.isArray(st) && st.length > 1);
    drawMap();
}

drawMap();
