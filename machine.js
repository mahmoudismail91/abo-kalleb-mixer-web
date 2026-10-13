// The drum machine on top of the sampler: pads switched on become elements of a living soundscape,
// and a line you draw decides when and how much each of them plays.
//
// Each element gets a lane, a height on the drawing. As the playhead moves across the drawing, elements whose
// lane is close to the line are likely to sound; far away, they keep quiet. Where nothing is drawn, the pulse rests.
//   pulse (state 1): plays on the step grid, like a drum machine, loosened by Organic.
//   drift (state 2): ignores the grid and the rests, calls out now and then off-beat, slightly detuned and
//                    wandering in the stereo field, like creatures in a swamp.

const DRAW_COLS = 256;
const SEQ_NAMES = ['off', 'pulse', 'drift'];

let drawing = new Array(DRAW_COLS).fill(null);   // per column: line height 0 (bottom) .. 1 (top), null = nothing drawn
let machineOn = false, machineTimer = null, nextStepTime = 0, stepIndex = 0;
let anchor = { time: 0, step: 0 };               // ties audio time to a step, for the playhead
let machineRaf = null;
const marks = [];                                 // recent hits, drawn as dots on the canvas
const lastVoice = new Map();                      // pad -> its last machine voice (elements are monophonic)

const mval = id => parseFloat($(id).value);
const stepDur = () => 60 / mval('m-bpm') / 4;
const stepCount = () => parseInt($('m-steps').value, 10);

// ---------- elements ----------
// Every pad with a state, across all banks, in keyboard order. Lane 0 is the top of the drawing.
function machineElements() {
    const out = [];
    bankOrder.forEach(cat => banks[cat].pads.forEach((pad, i) => { if (pad && pad.seq) out.push({ pad, cat, i }); }));
    const n = out.length;
    out.forEach((el, k) => { el.lane = n === 1 ? 0.5 : 1 - k / (n - 1) * 0.9 - 0.05; });
    return out;
}

function cycleSeq(i) {
    const pad = padAt(i);
    if (!pad) return setStatus("Put a sound on this pad first");
    pad.seq = (pad.seq + 1) % 3;
    if (!pad.seq) { const v = lastVoice.get(pad); if (v) stopVoice(v, 0.1); }
    paintPad(i);
    drawMachine();
    setStatus(`${keyLabel(KEYS[i])}: ${SEQ_NAMES[pad.seq]}` + (pad.seq && !machineOn ? ' · press Enter or ▶ Run to start the machine' : ''));
}

// ---------- the drawing ----------
// Average height of the line over a stretch of the loop (0..1 fractions), or null where nothing is drawn.
function lineAt(f0, f1) {
    const c0 = Math.floor(f0 * DRAW_COLS), c1 = Math.max(c0 + 1, Math.ceil(f1 * DRAW_COLS));
    let sum = 0, n = 0;
    for (let c = c0; c < c1; c++) { const v = drawing[c % DRAW_COLS]; if (v !== null) { sum += v; n++; } }
    return n ? sum / n : null;
}

function clearDrawing() { drawing.fill(null); drawMachine(); }

// A smooth random hill-and-valley line, as a starting point.
function randomDrawing() {
    const pts = Array.from({ length: 7 }, () => Math.random());
    for (let c = 0; c < DRAW_COLS; c++) {
        const x = c / DRAW_COLS * (pts.length - 1), k = Math.floor(x), t = x - k;
        const s = (1 - Math.cos(t * Math.PI)) / 2;
        drawing[c] = clamp(pts[k] * (1 - s) + pts[Math.min(k + 1, pts.length - 1)] * s, 0.03, 0.97);
    }
    // leave a few breaths in it
    for (let gaps = Math.floor(rand(0, 3)); gaps > 0; gaps--) {
        const at = Math.floor(rand(0, DRAW_COLS)), len = Math.floor(rand(8, 28));
        for (let c = at; c < at + len; c++) drawing[c % DRAW_COLS] = null;
    }
    drawMachine();
}

// Mutate: each loop the line drifts a little, like water moving.
function mutateDrawing(amount) {
    if (!amount) return;
    const phase = Math.random() * Math.PI * 2, waves = 1 + Math.floor(Math.random() * 3), push = rand(-1, 1) * amount * 0.15;
    for (let c = 0; c < DRAW_COLS; c++) {
        if (drawing[c] === null) continue;
        drawing[c] = clamp(drawing[c] + push * Math.sin(phase + c / DRAW_COLS * Math.PI * 2 * waves) + rand(-1, 1) * amount * 0.02, 0.02, 0.98);
    }
}

(function bindDrawing() {
    const cv = $('m-draw');
    let last = null, erase = false;
    const at = (e) => {
        const r = cv.getBoundingClientRect();
        return { c: Math.round(clamp((e.clientX - r.left) / r.width, 0, 0.9999) * (DRAW_COLS - 1)), y: clamp(1 - (e.clientY - r.top) / r.height, 0.02, 0.98) };
    };
    const paint = (p) => {
        const from = last || p, steps = Math.max(1, Math.abs(p.c - from.c));
        for (let s = 0; s <= steps; s++) {
            const c = Math.round(from.c + (p.c - from.c) * s / steps);
            drawing[c] = erase ? null : from.y + (p.y - from.y) * s / steps;
        }
        last = p;
        drawMachine();
    };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
        erase = e.button === 2 || e.shiftKey || $('m-erase').classList.contains('btn-on');
        last = null;
        cv.setPointerCapture(e.pointerId);
        paint(at(e));
    });
    cv.addEventListener('pointermove', (e) => { if (last) paint(at(e)); });
    const up = () => { last = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
})();

function toggleErase() { $('m-erase').classList.toggle('btn-on'); }

// ---------- transport ----------
function toggleMachine() { machineOn ? stopMachine() : startMachine(); }

function startMachine() {
    ensureAudio();
    if (!machineElements().length) setStatus("Click the small dot on a pad to make it an element (once: pulse, twice: drift)");
    if (drawing.every(v => v === null)) randomDrawing();
    machineOn = true;
    stepIndex = 0;
    nextStepTime = audioCtx.currentTime + 0.08;
    anchor = { time: nextStepTime, step: 0 };
    clearInterval(machineTimer);
    machineTimer = setInterval(scheduler, 25);
    scheduler();
    $('m-run').innerText = '■ Stop';
    $('m-run').classList.add('btn-on');
    cancelAnimationFrame(machineRaf);
    const frame = () => { drawMachine(); if (machineOn) machineRaf = requestAnimationFrame(frame); };
    frame();
}

function stopMachine() {
    if (!machineOn) return;
    machineOn = false;
    clearInterval(machineTimer);
    cancelAnimationFrame(machineRaf);
    lastVoice.forEach(v => stopVoice(v, 0.15));
    lastVoice.clear();
    $('m-run').innerText = '▶ Run';
    $('m-run').classList.remove('btn-on');
    drawMachine();
}

// Schedules every step that starts within the next ~120 ms, so timing stays tight even when the page is busy.
function scheduler() {
    const sd = stepDur();
    while (nextStepTime < audioCtx.currentTime + 0.12) {
        const swing = stepIndex % 2 ? mval('m-organic') * 0.18 * sd : 0;
        playStep(stepIndex, nextStepTime + swing, sd);
        nextStepTime += sd;
        stepIndex = (stepIndex + 1) % stepCount();
        if (stepIndex === 0) mutateDrawing(mval('m-mutate'));
    }
}

function playStep(step, when, sd) {
    const steps = stepCount(), life = mval('m-life'), spread = mval('m-spread'), organic = mval('m-organic');
    const f0 = step / steps, f1 = (step + 1) / steps;
    const line = lineAt(f0, f1), prev = lineAt((step - 1 + steps) % steps / steps, f0);
    // a steep line stirs things up
    const stir = line !== null && prev !== null ? Math.min(1, Math.abs(line - prev) * 6) : 0;

    machineElements().forEach(el => {
        const pad = el.pad;
        if (!pad.hit) { if (!pad.loading) loadPad(pad); return; }
        const near = line === null ? 0 : Math.max(0, 1 - Math.abs(line - el.lane) / spread);

        if (pad.seq === 1) {
            if (line === null) return;   // the gaps in the drawing are rests
            const p = life * Math.pow(near, 1.4) * (1 + 0.6 * stir);
            if (Math.random() >= p) return;
            const late = organic * rand(0, 0.22) * sd;
            const gain = clamp(0.45 + 0.55 * near + rand(-0.25, 0.1) * organic, 0.15, 1.1);
            hit(el, when + late, { gain, detune: rand(-0.15, 0.15) * organic, dur: pad.mode === 'gate' ? sd * 2 : 0 });
            // now and then a flam, like two frogs answering each other
            if (Math.random() < organic * 0.12 * near) hit(el, when + late + sd * rand(0.18, 0.4), { gain: gain * 0.6 });
        } else {
            // drift: rarer, free-running, keeps calling even in the gaps
            const p = life * (0.04 + 0.28 * near) * (1 + stir);
            if (Math.random() >= p) return;
            hit(el, when + rand(0, sd * 0.95), {
                gain: clamp(rand(0.35, 0.85) * (0.6 + 0.4 * near), 0.1, 1),
                detune: rand(-1, 1) * (0.5 + 2.5 * organic),
                pan: rand(-0.6, 0.6) * (0.3 + organic),
                attack: rand(0.005, 0.06) * (0.5 + organic),
                dur: pad.mode === 'gate' ? sd * rand(2, 6) : 0,
            });
        }
    });
}

function hit(el, when, o) {
    const prev = lastVoice.get(el.pad);
    if (prev) stopVoice(prev, el.pad.seq === 2 ? 0.12 : 0.02, when);
    lastVoice.set(el.pad, startVoice(el.pad, when, o));
    marks.push({ step: anchor.step + (when - anchor.time) / stepDur(), lane: el.lane, born: when, gain: o.gain || 1, drift: el.pad.seq === 2 });
    if (marks.length > 200) marks.shift();
    const delay = Math.max(0, (when - audioCtx.currentTime) * 1000);
    setTimeout(() => { if (el.cat === currentBank) flashPad(el.i); }, delay);
}

// Tempo or length changes start counting from the next step, so the playhead doesn't jump.
['m-bpm', 'm-steps'].forEach(id => $(id).addEventListener('change', () => {
    if (id === 'm-bpm') $('m-bpm').value = clamp(mval('m-bpm') || 100, 40, 240);
    if (machineOn) {
        stepIndex %= stepCount();
        anchor = { time: nextStepTime, step: stepIndex };
    }
    drawMachine();
}));
['m-life', 'm-spread', 'm-organic', 'm-mutate'].forEach(id => {
    const show = () => { $(id + '-val').innerText = mval(id).toFixed(2); };
    $(id).addEventListener('input', show);
    show();
});

// ---------- drawing the canvas ----------
function drawMachine() {
    const cv = $('m-draw'), dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
    if (!w) return;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d'), steps = stepCount();
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);

    // step grid, beats darker
    for (let s = 0; s < steps; s++) {
        g.fillStyle = s % 4 ? '#f1f1f1' : '#dedede';
        g.fillRect(s / steps * w, 0, Math.max(1, dpr), h);
    }

    // lanes, labelled with their keys
    const els = machineElements();
    const spreadPx = mval('m-spread') * h;
    g.font = `bold ${11 * dpr}px Courier New, monospace`;
    els.forEach(el => {
        const y = (1 - el.lane) * h;
        g.fillStyle = el.pad.seq === 2 ? 'rgba(0, 170, 120, 0.07)' : 'rgba(255, 204, 0, 0.12)';
        g.fillRect(0, y - spreadPx * 0.25, w, spreadPx * 0.5);
        g.fillStyle = el.pad.seq === 2 ? '#00a878' : '#b38f00';
        g.fillRect(0, y, w, Math.max(1, dpr));
        g.fillText(`${keyLabel(KEYS[el.i])}${el.pad.seq === 2 ? '~' : ''}`, 4 * dpr, y - 3 * dpr);
    });

    // the line
    g.strokeStyle = '#000';
    g.lineWidth = 3 * dpr;
    g.lineJoin = g.lineCap = 'round';
    g.beginPath();
    let pen = false;
    drawing.forEach((v, c) => {
        if (v === null) { pen = false; return; }
        const x = (c + 0.5) / DRAW_COLS * w, y = (1 - v) * h;
        if (pen) g.lineTo(x, y); else { g.moveTo(x, y); g.lineTo(x + 0.1, y); }
        pen = true;
    });
    g.stroke();

    if (!audioCtx) return;
    const now = audioCtx.currentTime, pos = anchor.step + (now - anchor.time) / stepDur();

    // hits fade out where they happened
    marks.forEach(m => {
        const age = now - m.born;
        if (age < 0 || age > 1.5) return;
        const x = (((m.step % steps) + steps) % steps) / steps * w, y = (1 - m.lane) * h;
        g.globalAlpha = 1 - age / 1.5;
        g.fillStyle = m.drift ? '#00a878' : '#ff6600';
        g.beginPath();
        g.arc(x, y, (3 + 7 * m.gain) * dpr * (1 + age), 0, Math.PI * 2);
        g.fill();
    });
    g.globalAlpha = 1;

    if (machineOn) {
        const x = (((pos % steps) + steps) % steps) / steps * w;
        g.fillStyle = '#ff0000';
        g.fillRect(x - dpr, 0, 2 * dpr, h);
    }
}
window.addEventListener('resize', drawMachine);

// ---------- kits ----------
function machineState() {
    return {
        drawing: drawing.map(v => (v === null ? null : Math.round(v * 1000) / 1000)),
        bpm: mval('m-bpm'), steps: stepCount(),
        life: mval('m-life'), spread: mval('m-spread'), organic: mval('m-organic'), mutate: mval('m-mutate'),
    };
}

function applyMachineState(m) {
    if (Array.isArray(m.drawing) && m.drawing.length === DRAW_COLS) drawing = m.drawing.slice();
    if (m.bpm) $('m-bpm').value = m.bpm;
    if (m.steps) $('m-steps').value = String(m.steps);
    ['life', 'spread', 'organic', 'mutate'].forEach(k => {
        if (m[k] == null) return;
        $('m-' + k).value = m[k];
        $('m-' + k).dispatchEvent(new Event('input'));
    });
    drawMachine();
}

drawMachine();
