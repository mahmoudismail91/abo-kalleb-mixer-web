// Sampler Abo Kalleb: short sounds on the computer keyboard, played through the same master FX and recorder as the mixer.
//
// voice: buffer source -> envelope gain -> panner -> master section -> speakers (+ recorder)

// Physical key positions (KeyboardEvent.code), so the layout works the same on any keyboard language.
const KEY_ROWS = [
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
    ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
    ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'],
    ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'],
];
const KEYS = KEY_ROWS.flat();
const PADS = KEYS.length;   // 36
const keyLabel = code => code.replace(/^(Digit|Key)/, '');

const AUTO_FILL_MAX_BYTES = 25e6;   // folders often hold long recordings too; those don't land on pads by themselves
const SRC_MAX_SEC = 30;             // a pad keeps at most this much of its file...
const DROP_MAX_SEC = 120;           // ...or this much when the file is dropped on it by hand (for chopping)
const MAX_VOICES = 48;
const RELEASE = 0.03;
const THUMB_W = 60, WAVE_W = 800;

let audioCtx, master, recorder, recTimer = null;
let allFiles = [];
let banks = {};        // folder -> { files, pads: [pad|null x 36], bag }
let bankOrder = [];
let currentBank = null;
let selected = -1;
let voices = [];
let kits = store.get('sampler.kits', []);
const heldKeys = new Map();   // key code -> pad it started, for Hold mode

function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    master = createMasterChain(audioCtx);
    master.setVoiceCount(1, 0.01);   // no automatic trim here: hits should be as loud as you play them
    recorder = createRecorder(audioCtx, master.output, {
        onSaved: () => setStatus("WAV Recording saved!"),
        onEmpty: () => setStatus("Recording was empty."),
    });
    ['master', 'reverb', 'delay', 'drive'].forEach(applyMaster);
}

function ensureAudio() {
    initAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function setStatus(msg) { $('status-label').innerText = msg; }

function applyMaster(id) {
    if (!audioCtx) return;
    master.set(id, parseFloat($(`sl-${id}`).value));
}
['master', 'reverb', 'delay', 'drive'].forEach(id => {
    $(`sl-${id}`).addEventListener('input', (e) => {
        $(`val-${id}`).innerText = parseFloat(e.target.value).toFixed(2);
        applyMaster(id);
    });
});

// ---------- library and banks ----------
$('folder-upload').addEventListener('change', (e) => loadLibrary(e.target.files));
$('files-upload').addEventListener('change', (e) => loadLibrary(e.target.files));

setupDropZone($('drop-overlay'), (files, e) => {
    const padEl = e.target.closest && e.target.closest('.pad');
    const audio = audioFilesOf(files);
    if (padEl && audio.length === 1 && currentBank) return dropOnPad(+padEl.dataset.i, audio[0]);
    loadLibrary(files);
}, () => setStatus("Reading dropped files..."));

function loadLibrary(fileList) {
    const files = audioFilesOf(fileList);
    if (!files.length) return setStatus("No audio files found there");
    initAudio();
    stopAll();
    allFiles = files;
    assignCategories(allFiles);
    banks = {};
    allFiles.forEach(f => { (banks[f._cat] = banks[f._cat] || { files: [], pads: [], bag: [] }).files.push(f); });
    bankOrder = Object.keys(banks).sort((a, b) => (a === LOOSE) - (b === LOOSE) || a.localeCompare(b));
    bankOrder.forEach(cat => {
        const b = banks[cat];
        b.files.sort((x, y) => fileKey(x).localeCompare(fileKey(y), undefined, { numeric: true }));
        const fits = b.files.filter(f => f.size <= AUTO_FILL_MAX_BYTES);
        b.pads = Array.from({ length: PADS }, (_, i) => (fits[i] ? newPad(fits[i]) : null));
    });
    const skipped = allFiles.filter(f => f.size > AUTO_FILL_MAX_BYTES).length;
    setStatus(`Found ${allFiles.length} sounds in ${bankOrder.length} bank${bankOrder.length > 1 ? 's' : ''}` +
        (skipped ? ` · ${skipped} long file(s) left off the pads (drop one on a pad to use it)` : ''));
    selected = -1;
    showBank(bankOrder[0]);
}

const selectedBank = () => banks[currentBank];
const bankLabel = cat => (cat === LOOSE ? (bankOrder.length > 1 ? 'main folder' : 'all sounds') : cat);

function newPad(file, like = null) {
    return {
        file, buffer: null, peaks: null, hit: null, loading: null,
        start: 0, end: 0,
        mode: like ? like.mode : 'shot', vol: like ? like.vol : 0.8, pitch: like ? like.pitch : 0,
        pan: like ? like.pan : 0, reverse: like ? like.reverse : false, choke: like ? like.choke : 0,
        seq: like ? like.seq || 0 : 0,   // drum machine state: 0 off, 1 pulse, 2 drift (see machine.js)
    };
}

function showBank(cat) {
    if (!banks[cat]) return;
    currentBank = cat;
    renderBankBar();
    renderPads();
    renderEditor();
    loadBankPads(cat);
}

function stepBank(dir) {
    if (!bankOrder.length) return;
    const i = bankOrder.indexOf(currentBank);
    showBank(bankOrder[(i + dir + bankOrder.length) % bankOrder.length]);
}

// Decodes the pads of a bank a few at a time; a bank is only decoded once you open it.
async function loadBankPads(cat) {
    const pads = banks[cat].pads.filter(p => p && !p.buffer && !p.loading);
    let next = 0;
    const worker = async () => {
        while (next < pads.length) await loadPad(pads[next++]);
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
}

function loadPad(pad, maxSec = SRC_MAX_SEC) {
    if (pad.buffer) return Promise.resolve(true);
    if (!pad.loading) {
        pad.loading = (async () => {
            try {
                const decoded = await audioCtx.decodeAudioData(await pad.file.arrayBuffer());
                const keep = Math.min(decoded.duration, maxSec);
                pad.buffer = keep < decoded.duration ? makeHitBuffer(audioCtx, decoded, 0, keep, false) : decoded;
                if (!pad.end || pad.end > keep) pad.end = keep;
                pad.start = Math.min(pad.start, pad.end - 0.01);
                pad.peaks = computePeaks(pad.buffer, THUMB_W);
                pad.wave = null;
                rebuildHit(pad);
                return true;
            } catch (err) {
                console.error("Decode error", pad.file.name, err);
                setStatus(`Skipped ${pad.file.name} (can't decode)`);
                return false;
            } finally {
                pad.loading = null;
                refreshPadEl(pad);
                if (padAt(selected) === pad) renderEditor();
            }
        })();
        refreshPadEl(pad);
    }
    return pad.loading;
}

// What actually plays: the trimmed part, reversed if asked. Loops get a crossfaded seam instead of fades.
function rebuildHit(pad) {
    if (!pad.buffer) return;
    const len = Math.max(0.01, pad.end - pad.start);
    pad.hit = pad.mode === 'loop' && len > 0.2
        ? makeLoopBuffer(audioCtx, pad.buffer, pad.start, len, pad.reverse)
        : makeHitBuffer(audioCtx, pad.buffer, pad.start, len, pad.reverse);
}

const padAt = i => (currentBank && i >= 0 ? banks[currentBank].pads[i] : null);

// ---------- playing ----------
function trigger(i) {
    const pad = padAt(i);
    if (!pad) return;
    ensureAudio();
    if (!pad.hit) { loadPad(pad); return; }

    if (pad.mode === 'loop' && voices.some(v => v.pad === pad)) return release(pad);
    if (pad.mode !== 'shot') release(pad, 0.01);
    startVoice(pad, audioCtx.currentTime, { loop: pad.mode === 'loop' });
    flashPad(i);
}

// Starts one voice of a pad at `when`. o: loop, gain (x pad vol), detune (semitones on top of the pad's pitch),
// pan (added to the pad's pan), attack (s), dur (s, then it releases by itself).
function startVoice(pad, when, o = {}) {
    if (pad.choke) voices.filter(v => v.pad !== pad && v.pad.choke === pad.choke).forEach(v => stopVoice(v, 0.012, when));
    while (voices.length >= MAX_VOICES) stopVoice(voices[0], 0.01);

    const src = audioCtx.createBufferSource();
    src.buffer = pad.hit;
    src.loop = !!o.loop;
    src.playbackRate.value = Math.pow(2, (pad.pitch + (o.detune || 0)) / 12);
    const level = pad.vol * (o.gain ?? 1), attack = o.attack || 0.002;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + attack);
    const p = audioCtx.createStereoPanner();
    p.pan.value = clamp(pad.pan + (o.pan || 0), -1, 1);
    src.connect(g);
    g.connect(p);
    p.connect(master.input);
    const v = { pad, src, g, p };
    voices.push(v);
    src.onended = () => {
        try { src.disconnect(); g.disconnect(); p.disconnect(); } catch (e) {}
        voices = voices.filter(x => x !== v);
        refreshPadEl(pad);
    };
    src.start(when);
    if (o.dur) {
        g.gain.setValueAtTime(level, when + Math.max(attack, o.dur));
        g.gain.linearRampToValueAtTime(0, when + Math.max(attack, o.dur) + RELEASE);
        src.stop(when + Math.max(attack, o.dur) + RELEASE + 0.01);
    }
    refreshPadEl(pad);
    return v;
}

function stopVoice(v, fade = RELEASE, at = 0) {
    if (v.stopping) return;
    v.stopping = true;
    const now = Math.max(audioCtx.currentTime, at), gain = v.g.gain;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
    else { gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); }
    gain.linearRampToValueAtTime(0, now + fade);
    try { v.src.stop(now + fade + 0.01); } catch (e) {}
    voices = voices.filter(x => x !== v);   // gone from the count right away, the tail finishes on its own
    refreshPadEl(v.pad);
}

function release(pad, fade = RELEASE) {
    voices.filter(v => v.pad === pad).forEach(v => stopVoice(v, fade));
}

function stopAll() {
    stopMachine();
    if (!audioCtx) return;
    [...voices].forEach(v => stopVoice(v, 0.05));
    heldKeys.clear();
}

function previewSelected() { trigger(selected); }

document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (tag === 'INPUT' && e.code.startsWith('Arrow')) return;   // arrows still move a focused slider
    const i = KEYS.indexOf(e.code);
    const ours = i !== -1 || ['Space', 'Enter', 'BracketLeft', 'BracketRight', 'ArrowLeft', 'ArrowRight'].includes(e.code);
    if (!ours) return;
    e.preventDefault();   // keeps Space from pressing whichever button has focus
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
    if (e.repeat) return;
    if (e.code === 'Space') return stopAll();
    if (e.code === 'Enter') return toggleMachine();
    if (e.code === 'BracketLeft') return stepBank(-1);
    if (e.code === 'BracketRight') return stepBank(1);
    if (e.code === 'ArrowLeft') return stepRegion(-1);
    if (e.code === 'ArrowRight') return stepRegion(1);
    if (e.shiftKey) return selectPad(i);
    heldKeys.set(e.code, padAt(i));
    trigger(i);
});

document.addEventListener('keyup', (e) => {
    const pad = heldKeys.get(e.code);
    heldKeys.delete(e.code);
    if (pad && pad.mode === 'gate') release(pad);
});

// Releasing a key while the page is in the background never arrives, so let go of Hold pads then.
window.addEventListener('blur', () => {
    heldKeys.forEach(pad => { if (pad && pad.mode === 'gate') release(pad); });
    heldKeys.clear();
});

// ---------- pads UI ----------
function renderBankBar() {
    const bar = $('bank-bar');
    bar.innerHTML = '';
    bankOrder.forEach(cat => {
        const b = document.createElement('button');
        b.className = 'btn-grey' + (cat === currentBank ? ' btn-on' : '');
        b.textContent = bankLabel(cat);
        b.title = `${banks[cat].files.length} sounds`;
        b.addEventListener('click', () => showBank(cat));
        bar.appendChild(b);
    });
}

function renderPads() {
    const wrap = $('pads');
    wrap.innerHTML = '';
    KEY_ROWS.forEach((row, r) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'pad-row';
        rowEl.dataset.row = r;
        row.forEach(code => {
            const i = KEYS.indexOf(code);
            const el = document.createElement('div');
            el.className = 'pad';
            el.dataset.i = i;
            el.innerHTML = '<span class="pad-key"></span><span class="pad-mode"></span><canvas width="60" height="18"></canvas><span class="pad-name"></span>' +
                '<span class="pad-seq" title="Drum machine: click for pulse, again for drift, again for off"></span>';
            el.querySelector('.pad-key').textContent = keyLabel(code);
            el.querySelector('.pad-seq').addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                cycleSeq(i);
            });
            el.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                selectPad(i);
                if (!e.shiftKey) trigger(i);
                el.setPointerCapture(e.pointerId);
            });
            const up = () => { const pad = padAt(i); if (pad && pad.mode === 'gate') release(pad); };
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
            rowEl.appendChild(el);
        });
        wrap.appendChild(rowEl);
    });
    banks[currentBank].pads.forEach((pad, i) => paintPad(i));
}

const padEl = i => document.querySelector(`.pad[data-i="${i}"]`);

function refreshPadEl(pad) {
    if (!currentBank) return;
    const i = banks[currentBank].pads.indexOf(pad);
    if (i !== -1) paintPad(i);
}

function paintPad(i) {
    const el = padEl(i);
    if (!el) return;
    const pad = padAt(i);
    el.classList.toggle('empty', !pad);
    el.classList.toggle('selected', i === selected);
    el.classList.toggle('loading', !!(pad && pad.loading));
    el.classList.toggle('on', !!(pad && pad.mode === 'loop' && voices.some(v => v.pad === pad)));
    ['loop', 'gate'].forEach(m => el.classList.toggle('mode-' + m, !!(pad && pad.mode === m)));
    el.querySelector('.pad-name').textContent = pad ? baseName(pad.file) : 'empty';
    el.title = pad ? fileKey(pad.file) : 'Drop a sound here';
    [1, 2].forEach(n => el.classList.toggle('seq-' + n, !!(pad && pad.seq === n)));
    el.querySelector('.pad-mode').textContent = pad ? { shot: '', gate: 'HOLD', loop: 'LOOP' }[pad.mode] + (pad.choke ? ` C${pad.choke}` : '') : '';
    const cv = el.querySelector('canvas'), g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    if (pad && pad.peaks) {
        const dur = pad.buffer.duration;
        g.fillStyle = '#ffcc00';
        g.fillRect(pad.start / dur * cv.width, 0, (pad.end - pad.start) / dur * cv.width, cv.height);
        g.fillStyle = '#000';
        pad.peaks.forEach((v, x) => { const h = Math.max(1, v * cv.height); g.fillRect(x, (cv.height - h) / 2, 1, h); });
    }
}

function flashPad(i) {
    const el = padEl(i);
    if (!el) return;
    el.classList.add('hit');
    clearTimeout(el._flash);
    el._flash = setTimeout(() => el.classList.remove('hit'), 110);
}

function selectPad(i) {
    const old = selected;
    selected = i;
    if (old !== -1) paintPad(old);
    paintPad(i);
    renderEditor();
}

// ---------- editor ----------
function renderEditor() {
    const pad = padAt(selected);
    $('editor').hidden = selected === -1;
    if (selected === -1) return;
    $('ed-key').textContent = `Pad ${keyLabel(KEYS[selected])}`;
    $('ed-name').textContent = pad ? fileKey(pad.file) : 'Empty: drop a sound on this pad, or re-roll it';
    $('editor').querySelectorAll('.ed-controls input, .ed-controls select, .ed-controls button').forEach(c => { c.disabled = !pad; });
    if (!pad) { drawWave(); return; }
    $('ed-mode').querySelectorAll('button').forEach(b => b.classList.toggle('btn-on', b.dataset.mode === pad.mode));
    $('ed-vol').value = pad.vol;
    $('ed-pitch').value = pad.pitch;
    $('ed-pan').value = pad.pan;
    $('ed-choke').value = String(pad.choke);
    $('ed-reverse').classList.toggle('btn-on', pad.reverse);
    $('ed-val-vol').innerText = pad.vol.toFixed(2);
    $('ed-val-pitch').innerText = (pad.pitch > 0 ? '+' : '') + pad.pitch + ' st';
    $('ed-val-pan').innerText = pad.pan.toFixed(2);
    drawWave();
}

function drawWave() {
    const cv = $('ed-wave'), dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    const pad = padAt(selected);
    if (!pad || !pad.buffer) return;
    if (!pad.wave) pad.wave = computePeaks(pad.buffer, WAVE_W);
    const dur = pad.buffer.duration, x0 = pad.start / dur * w, x1 = pad.end / dur * w;
    g.fillStyle = '#ffcc00';
    g.fillRect(x0, 0, x1 - x0, h);
    g.fillStyle = '#000';
    const bw = w / pad.wave.length;
    pad.wave.forEach((v, b) => { const bh = Math.max(dpr, v * (h - 8 * dpr)); g.fillRect(b * bw, (h - bh) / 2, Math.max(dpr * 0.6, bw), bh); });
    g.fillStyle = '#ff0000';
    g.fillRect(x0 - dpr, 0, 2 * dpr, h);
    g.fillRect(x1 - dpr, 0, 2 * dpr, h);
    const label = `${(pad.end - pad.start).toFixed(2)} s of ${dur.toFixed(2)} s`;
    g.font = `bold ${11 * dpr}px Courier New, monospace`;
    g.fillStyle = '#fff';
    g.fillRect(4 * dpr, 3 * dpr, g.measureText(label).width + 6 * dpr, 14 * dpr);
    g.fillStyle = '#000';
    g.fillText(label, 7 * dpr, 14 * dpr);
}
window.addEventListener('resize', drawWave);

// Drag an edge (red line) to change where the sound starts or ends; drag inside the yellow part to move
// the whole part along the file without changing its length. Outside it, the nearer edge jumps to where you click.
(function bindWave() {
    const cv = $('ed-wave'), GRAB_PX = 8;
    let drag = null;
    const fracAt = (e) => { const r = cv.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
    // what a press at this point grabs: 'start', 'end' or 'move'
    const hitTest = (e, pad) => {
        const r = cv.getBoundingClientRect(), dur = pad.buffer.duration, x = e.clientX - r.left;
        const xs = pad.start / dur * r.width, xe = pad.end / dur * r.width;
        if (Math.abs(x - xs) <= GRAB_PX && Math.abs(x - xs) <= Math.abs(x - xe)) return 'start';
        if (Math.abs(x - xe) <= GRAB_PX) return 'end';
        if (x > xs && x < xe) return 'move';
        return Math.abs(x - xs) <= Math.abs(x - xe) ? 'start' : 'end';
    };
    const apply = (e) => {
        const pad = padAt(selected), t = fracAt(e) * pad.buffer.duration, minLen = 0.01;
        if (drag.what === 'start') pad.start = Math.min(t, pad.end - minLen);
        else if (drag.what === 'end') pad.end = Math.max(t, pad.start + minLen);
        else moveRegion(pad, t - drag.grabOffset - pad.start);
        drawWave();
    };
    cv.addEventListener('pointerdown', (e) => {
        const pad = padAt(selected);
        if (!pad || !pad.buffer) return;
        const what = hitTest(e, pad);
        drag = { what, grabOffset: fracAt(e) * pad.buffer.duration - pad.start };
        cv.setPointerCapture(e.pointerId);
        if (what !== 'move') apply(e);
    });
    cv.addEventListener('pointermove', (e) => {
        if (drag) return apply(e);
        const pad = padAt(selected);
        cv.style.cursor = pad && pad.buffer ? (hitTest(e, pad) === 'move' ? 'grab' : 'ew-resize') : 'default';
    });
    const done = () => {
        if (!drag) return;
        drag = null;
        const pad = padAt(selected);
        rebuildHit(pad);
        refreshPadEl(pad);
        trigger(selected);
    };
    cv.addEventListener('pointerup', done);
    cv.addEventListener('pointercancel', done);
})();

// Slides the part by `by` seconds, keeping its length and stopping at the ends of the file.
function moveRegion(pad, by) {
    const len = pad.end - pad.start;
    pad.start = clamp(pad.start + by, 0, pad.buffer.duration - len);
    pad.end = pad.start + len;
}

// Steps the selected part one whole length back or forward through the file and plays it,
// so you can walk through a recording piece by piece and keep the parts you like.
function stepRegion(dir) {
    const pad = padAt(selected);
    if (!pad || !pad.buffer) return;
    moveRegion(pad, dir * (pad.end - pad.start));
    release(pad, 0.01);
    rebuildHit(pad);
    renderEditor();
    refreshPadEl(pad);
    trigger(selected);
}

// Every edit applies to the selected pad and rebuilds what it plays when needed.
function editPad(fn, rebuild = false) {
    const pad = padAt(selected);
    if (!pad) return;
    fn(pad);
    if (rebuild) { release(pad, 0.01); rebuildHit(pad); }
    renderEditor();
    refreshPadEl(pad);
}

$('ed-mode').querySelectorAll('button').forEach(b => b.addEventListener('click', () => editPad(p => { p.mode = b.dataset.mode; }, true)));
$('ed-vol').addEventListener('input', (e) => editPad(p => {
    p.vol = parseFloat(e.target.value);
    voices.filter(v => v.pad === p && !v.stopping).forEach(v => v.g.gain.setTargetAtTime(p.vol, audioCtx.currentTime, 0.02));
}));
$('ed-pitch').addEventListener('input', (e) => editPad(p => {
    p.pitch = parseInt(e.target.value, 10);
    voices.filter(v => v.pad === p).forEach(v => v.src.playbackRate.setTargetAtTime(Math.pow(2, p.pitch / 12), audioCtx.currentTime, 0.02));
}));
$('ed-pan').addEventListener('input', (e) => editPad(p => {
    p.pan = parseFloat(e.target.value);
    voices.filter(v => v.pad === p).forEach(v => v.p.pan.setTargetAtTime(p.pan, audioCtx.currentTime, 0.02));
}));
$('ed-choke').addEventListener('change', (e) => editPad(p => { p.choke = parseInt(e.target.value, 10); }));
$('ed-reverse').addEventListener('click', () => editPad(p => { p.reverse = !p.reverse; }, true));

function resetTrim() {
    editPad(p => { if (p.buffer) { p.start = 0; p.end = p.buffer.duration; } }, true);
}

function clearPad() {
    const pad = padAt(selected);
    if (!pad) return;
    release(pad, 0.02);
    banks[currentBank].pads[selected] = null;
    paintPad(selected);
    renderEditor();
}

// Cuts the selected pad's trimmed part into n equal pieces on this pad and the ones after it.
// The pieces share one decoded buffer, so chopping costs no extra memory.
function chopSelected(n) {
    const pad = padAt(selected);
    if (!pad || !pad.buffer) return;
    const pads = banks[currentBank].pads, count = Math.min(n, PADS - selected);
    const step = (pad.end - pad.start) / n;
    if (step < 0.02) return setStatus("Too short to chop that finely");
    for (let k = 0; k < count; k++) {
        const old = pads[selected + k];
        if (old && old !== pad) release(old, 0.02);
        const piece = newPad(pad.file, pad);
        Object.assign(piece, { buffer: pad.buffer, peaks: pad.peaks, wave: pad.wave, start: pad.start + k * step, end: pad.start + (k + 1) * step });
        if (piece.mode === 'loop') piece.mode = 'shot';
        rebuildHit(piece);
        pads[selected + k] = piece;
        paintPad(selected + k);
    }
    renderEditor();
    setStatus(`Chopped into ${count} pads` + (count < n ? ` (ran out of keys after ${count})` : ''));
}

// ---------- re-roll ----------
// One shuffle-bag per bank: every sound in the folder comes up once before any repeats.
function drawFromBank(b) {
    const onPads = new Set(b.pads.filter(Boolean).map(p => fileKey(p.file)));
    const usable = () => b.bag.filter(f => !onPads.has(fileKey(f)) && f.size <= AUTO_FILL_MAX_BYTES);
    let list = usable();
    if (!list.length) { b.bag = shuffle([...b.files]); list = usable(); }
    if (!list.length) return null;
    const f = list[0];
    b.bag.splice(b.bag.indexOf(f), 1);
    return f;
}

function rerollPad(b, i) {
    if (!b || i < 0) return;
    const old = b.pads[i];
    const file = drawFromBank(b);
    if (!file) return setStatus("Every sound in this folder is already on a pad");
    if (old) release(old, 0.02);
    b.pads[i] = newPad(file, old);
    paintPad(i);
    renderEditor();
    loadPad(b.pads[i]).then(ok => { if (ok && i === selected) trigger(i); });
}

function rerollBank() {
    const b = selectedBank();
    if (!b) return setStatus("Load a folder first!");
    const fresh = shuffle(b.files.filter(f => f.size <= AUTO_FILL_MAX_BYTES));
    b.pads.forEach(p => { if (p) release(p, 0.02); });
    b.pads = b.pads.map((p, i) => (fresh[i] ? newPad(fresh[i], p) : null));
    b.bag = [];
    renderPads();
    renderEditor();
    loadBankPads(currentBank);
    setStatus(fresh.length > PADS ? `Rolled ${PADS} new sounds from ${fresh.length}` : "Same sounds, new keys: this folder fits on one bank");
}

// ---------- drop onto a pad ----------
function dropOnPad(i, file) {
    initAudio();
    const pads = banks[currentBank].pads, old = pads[i];
    if (old) release(old, 0.02);
    const pad = newPad(file, old);
    pads[i] = pad;
    selectPad(i);
    loadPad(pad, DROP_MAX_SEC).then(ok => {
        if (!ok) return;
        setStatus(`${file.name} is on ${keyLabel(KEYS[i])}` + (pad.buffer.duration >= DROP_MAX_SEC - 0.01 ? ` (first ${DROP_MAX_SEC} s)` : ''));
        trigger(i);
    });
}

// ---------- kits ----------
const padSettings = p => ({ key: fileKey(p.file), name: p.file.name, start: p.start, end: p.end, mode: p.mode, vol: p.vol, pitch: p.pitch, pan: p.pan, reverse: p.reverse, choke: p.choke, seq: p.seq });

function saveKit() {
    if (!bankOrder.length) return setStatus("Load some sounds first!");
    const name = $('kit-name').value.trim() || `${bankOrder.map(bankLabel).join(' + ')}`.slice(0, 70);
    const kitBanks = {};
    bankOrder.forEach(cat => {
        kitBanks[cat] = banks[cat].pads.map((p, i) => (p ? Object.assign({ i }, padSettings(p)) : null)).filter(Boolean);
    });
    kits.unshift({ name, savedAt: Date.now(), banks: kitBanks, machine: machineState() });
    store.set('sampler.kits', kits);
    $('kit-name').value = '';
    renderKits();
    setStatus(`Saved kit "${name}"`);
}

function loadKit(k) {
    if (!allFiles.length) return setStatus("Load the folder this kit was made from first");
    const byKey = new Map(allFiles.map(f => [fileKey(f), f]));
    const byName = new Map(allFiles.map(f => [f.name, f]));
    let placed = 0, missing = 0;
    stopAll();
    Object.entries(k.banks || {}).forEach(([cat, list]) => {
        if (!banks[cat]) { banks[cat] = { files: [], pads: [], bag: [] }; bankOrder.push(cat); }
        const b = banks[cat];
        b.pads = Array.from({ length: PADS }, () => null);
        list.forEach(s => {
            const file = byKey.get(s.key) || byName.get(s.name);
            if (!file) { missing++; return; }
            const pad = newPad(file, s);
            pad.start = s.start || 0;
            pad.end = s.end || 0;
            b.pads[s.i] = pad;
            placed++;
        });
    });
    bankOrder = bankOrder.filter(cat => banks[cat].files.length || banks[cat].pads.some(Boolean));
    if (!placed) return setStatus(`None of "${k.name}"'s sounds are in the loaded folder`);
    if (k.machine) applyMachineState(k.machine);
    showBank(bankOrder.includes(currentBank) ? currentBank : bankOrder[0]);
    setStatus(`Loaded kit "${k.name}"` + (missing ? ` · ${missing} sound(s) not in this folder` : ''));
}

function renderKits() {
    const list = $('kit-list');
    list.innerHTML = '';
    if (!kits.length) {
        list.innerHTML = '<div class="empty-note">No kits yet. When the pads sound right, hit 💾 Save.</div>';
        return;
    }
    kits.forEach(k => {
        const row = document.createElement('div');
        row.className = 'snap-row';
        row.innerHTML = `
            <span class="snap-name"></span>
            <span class="snap-info"></span>
            <button class="btn-small" data-act="load">▶ Load</button>
            <button class="btn-grey btn-small" data-act="del">✕</button>
        `;
        const pads = Object.values(k.banks || {}).reduce((n, l) => n + l.length, 0);
        row.querySelector('.snap-name').textContent = k.name;
        row.querySelector('.snap-info').textContent = `${pads} pads · ${new Date(k.savedAt).toLocaleDateString()}`;
        row.querySelector('[data-act="load"]').addEventListener('click', () => loadKit(k));
        const del = row.querySelector('[data-act="del"]');
        del.addEventListener('click', () => {
            if (del.dataset.armed) {
                kits.splice(kits.indexOf(k), 1);
                store.set('sampler.kits', kits);
                renderKits();
                return;
            }
            del.dataset.armed = '1';
            del.innerText = 'SURE?';
            setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.innerText = '✕'; } }, 3000);
        });
        list.appendChild(row);
    });
}

function exportKits() {
    if (!kits.length) return setStatus("No kits to export yet");
    const blob = new Blob([JSON.stringify(kits, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `AlHut_kits_${new Date().toISOString().slice(0, 10)}.json`);
}

$('kit-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        const incoming = (Array.isArray(data) ? data : [data]).filter(k => k && k.banks && typeof k.banks === 'object');
        if (!incoming.length) throw new Error('no kits');
        const seen = new Set(kits.map(k => k.name + k.savedAt));
        const added = incoming.filter(k => !seen.has(k.name + k.savedAt));
        kits = [...added, ...kits];
        store.set('sampler.kits', kits);
        renderKits();
        setStatus(`Imported ${added.length} kit(s)`);
    } catch (err) {
        setStatus("That file isn't a kit export");
    }
});

// ---------- recording ----------
function updateRecLabel() {
    if (recorder && recorder.recording) $('btn-record').innerText = `■ STOP REC ${formatElapsed(recorder.startedAt)}`;
}

function toggleRecord() {
    ensureAudio();
    const btn = $('btn-record');
    if (!recorder.recording) {
        const name = (currentBank ? bankLabel(currentBank) : 'sampler').replace(/[^\p{L}\p{N}]/gu, '').substring(0, 20);
        recorder.start('sampler_' + (name || 'kit'));
        updateRecLabel();
        recTimer = setInterval(updateRecLabel, 500);
        btn.style.background = "var(--warning)";
        setStatus("🔴 Recording to WAV... play!");
    } else {
        recorder.stop();
        clearInterval(recTimer);
        btn.innerText = "🔴 RECORD (WAV)";
        btn.style.background = "var(--danger)";
        setStatus("Processing WAV file. Please wait...");
    }
}

// Empty grid until something is loaded, so the layout is visible straight away.
banks = { [LOOSE]: { files: [], pads: Array(PADS).fill(null), bag: [] } };
bankOrder = [];
currentBank = LOOSE;
renderPads();
renderKits();
