// Buffer and curve helpers shared by the mixer and the sampler.

function makeImpulse(ctx, seconds) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const impulse = ctx.createBuffer(2, len, rate);
    const preDelay = Math.floor(rate * 0.02);
    for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        let smoothed = 0;
        for (let i = preDelay; i < len; i++) {
            const t = i / len;
            // noise gets darker as the tail decays, like a real room
            smoothed += ((Math.random() * 2 - 1) - smoothed) * (0.9 - 0.75 * t);
            data[i] = smoothed * Math.pow(1 - t, 2.5);
        }
    }
    return impulse;
}

// tanh(4u) over the shaper's -1..1 input. At Drive 0 the signal is scaled down so it only touches
// the straight middle of the curve (clean); more Drive pushes it into the bends.
function makeSaturationCurve() {
    const n = 8193, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(4 * (i * 2 / (n - 1) - 1));
    return curve;
}

// Straight up to 0.8, then rounds off towards 1.0 (input range is +-2 after the 0.5 pre-gain).
function makeSafetyCurve() {
    const n = 4097, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = (i * 2 / (n - 1) - 1) * 2, a = Math.abs(x);
        const y = a <= 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
        curve[i] = Math.sign(x) * y / 2;
    }
    return curve;
}

// A loopable copy of part of a buffer. When there's audio after the slice, it is crossfaded into the
// slice's first 50 ms so the jump from the end back to the start is seamless. A slice that runs into
// the end of the file gets a tiny fade at both ends instead.
function makeLoopBuffer(ctx, src, start, len, reverse) {
    const sr = src.sampleRate, n = Math.round(len * sr), s0 = Math.round(start * sr), total = src.length;
    const xf = Math.min(Math.floor(0.05 * sr), Math.floor(n / 4));
    const hasTail = s0 + n + xf <= total;
    const out = ctx.createBuffer(src.numberOfChannels, n, sr);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const a = src.getChannelData(ch), o = out.getChannelData(ch);
        for (let i = 0; i < n; i++) o[i] = a[(s0 + i) % total];
        if (hasTail) {
            for (let i = 0; i < xf; i++) {
                const g = (i / xf) * Math.PI / 2;
                o[i] = o[i] * Math.sin(g) + a[s0 + n + i] * Math.cos(g);
            }
        } else {
            const m = Math.min(Math.floor(0.005 * sr), Math.floor(n / 8));
            for (let i = 0; i < m; i++) { const g = i / m; o[i] *= g; o[n - 1 - i] *= g; }
        }
        if (reverse) o.reverse();
    }
    return out;
}

// A plain copy of start..start+len with short fades at both ends so a hit never clicks.
function makeHitBuffer(ctx, src, start, len, reverse) {
    const sr = src.sampleRate;
    const s0 = clamp(Math.round(start * sr), 0, src.length - 1);
    const n = Math.max(1, Math.min(src.length - s0, Math.round(len * sr)));
    const out = ctx.createBuffer(src.numberOfChannels, n, sr);
    const fade = Math.min(Math.floor(0.003 * sr), Math.floor(n / 4));
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const o = out.getChannelData(ch);
        o.set(src.getChannelData(ch).subarray(s0, s0 + n));
        for (let i = 0; i < fade; i++) { const g = i / fade; o[i] *= g; o[n - 1 - i] *= g; }
        if (reverse) o.reverse();
    }
    return out;
}

function reversedCopy(ctx, src) {
    const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch++) {
        const o = out.getChannelData(ch);
        o.set(src.getChannelData(ch));
        o.reverse();
    }
    return out;
}

function computePeaks(buffer, bins) {
    const d = buffer.getChannelData(0), per = d.length / bins, step = Math.max(1, Math.floor(per / 64));
    const peaks = new Float32Array(bins);
    let max = 0;
    for (let b = 0; b < bins; b++) {
        let m = 0;
        const end = Math.min(d.length, Math.floor((b + 1) * per));
        for (let i = Math.floor(b * per); i < end; i += step) { const v = Math.abs(d[i]); if (v > m) m = v; }
        peaks[b] = m;
        if (m > max) max = m;
    }
    if (max > 0) for (let b = 0; b < bins; b++) peaks[b] /= max;
    return peaks;
}
