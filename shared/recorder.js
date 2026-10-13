// Records the master output to 16-bit stereo WAV files.
//
// The recorder taps the output on the audio thread (AudioWorklet), so a busy page can't drop audio
// from the recording. Where that isn't available (e.g. opened as a local file) it falls back to a ScriptProcessor.
// Long recordings split into parts, since WAV files can't pass 4 GB.
//
// hooks: onSaved(), onEmpty() when a stopped recording had no audio, onSplit(sessionName) when a part is full.
function createRecorder(ctx, source, hooks = {}) {
    const WAV_MAX_BYTES = 3.8e9;
    // One session per recording; a session may still be receiving its last audio after the next one starts.
    let session = null, seq = 0, splitting = false, tap = null;
    const sessions = {};

    function append(sess, L, R) {
        // Stores 16-bit PCM straight away (half the memory of float) and rolls it into Blobs,
        // which the browser can page out to disk during long sessions.
        const n = L.length, pcm = new Int16Array(n * 2);
        for (let i = 0; i < n; i++) {
            const l = L[i] < -1 ? -1 : L[i] > 1 ? 1 : L[i];
            const r = R[i] < -1 ? -1 : R[i] > 1 ? 1 : R[i];
            pcm[2 * i] = l < 0 ? l * 0x8000 : l * 0x7FFF;
            pcm[2 * i + 1] = r < 0 ? r * 0x8000 : r * 0x7FFF;
        }
        sess.chunks.push(pcm);
        sess.frames += n;
        if (sess.chunks.length >= 100) { sess.blobs.push(new Blob(sess.chunks)); sess.chunks = []; }
        if (sess === session && sess.frames * 4 > WAV_MAX_BYTES && !splitting) {
            splitting = true;
            setTimeout(() => {
                const name = session.name;
                stop();
                start(name);
                splitting = false;
                if (hooks.onSplit) hooks.onSplit(name);
            }, 0);
        }
    }

    const TAP_CODE = `
        class RecTap extends AudioWorkletProcessor {
            constructor() {
                super();
                this.id = 0;
                this.alloc();
                this.port.onmessage = (e) => {
                    const m = e.data;
                    if (m.cmd === 'start') { this.flush(); this.id = m.id; }
                    else if (m.cmd === 'stop' && this.id) {
                        this.flush();
                        this.port.postMessage({ id: this.id, done: true });
                        this.id = 0;
                    }
                };
            }
            alloc() { this.L = new Float32Array(8192); this.R = new Float32Array(8192); this.n = 0; }
            flush() {
                if (this.id && this.n) this.port.postMessage({ id: this.id, L: this.L, R: this.R, n: this.n }, [this.L.buffer, this.R.buffer]);
                this.alloc();
            }
            process(inputs) {
                if (!this.id) return true;
                const ch = inputs[0];
                if (ch && ch.length) { this.L.set(ch[0], this.n); this.R.set(ch[1] || ch[0], this.n); }
                this.n += 128;
                if (this.n + 128 > this.L.length) this.flush();
                return true;
            }
        }
        registerProcessor('rec-tap', RecTap);
    `;

    async function setup() {
        if (ctx.audioWorklet && window.isSecureContext) {
            try {
                const url = URL.createObjectURL(new Blob([TAP_CODE], { type: 'application/javascript' }));
                await ctx.audioWorklet.addModule(url);
                tap = new AudioWorkletNode(ctx, 'rec-tap', { channelCount: 2, channelCountMode: 'explicit' });
                tap.port.onmessage = (e) => {
                    const m = e.data, sess = sessions[m.id];
                    if (!sess) return;
                    if (m.done) { delete sessions[m.id]; exportWAV(sess); }
                    else append(sess, m.L.subarray(0, m.n), m.R.subarray(0, m.n));
                };
                source.connect(tap);
                tap.connect(ctx.destination);   // outputs silence; keeps the node running
                return;
            } catch (err) {
                console.warn("AudioWorklet recorder unavailable, falling back", err);
                tap = null;
            }
        }
        const proc = ctx.createScriptProcessor(4096, 2, 2);
        source.connect(proc);
        proc.connect(ctx.destination);
        proc.onaudioprocess = function(e) {
            e.outputBuffer.getChannelData(0).fill(0);
            e.outputBuffer.getChannelData(1).fill(0);
            if (session) append(session, e.inputBuffer.getChannelData(0), e.inputBuffer.getChannelData(1));
        };
    }
    setup();

    // name ends up in the file name: AlHut_<name>_<timestamp>.wav
    function start(name) {
        if (session) return;
        session = { id: ++seq, name: name || 'mix', chunks: [], blobs: [], frames: 0, startedAt: Date.now() };
        sessions[session.id] = session;
        if (tap) tap.port.postMessage({ cmd: 'start', id: session.id });
    }

    function stop() {
        if (!session) return;
        const sess = session;
        session = null;
        // the worklet sends its last few milliseconds, then 'done' triggers the export
        if (tap) tap.port.postMessage({ cmd: 'stop' });
        else setTimeout(() => { delete sessions[sess.id]; exportWAV(sess); }, 50);
    }

    function exportWAV(sess) {
        if (sess.frames === 0) { if (hooks.onEmpty) hooks.onEmpty(); return; }
        const info = infoChunk();
        const blob = new Blob([wavHeader(sess.frames * 4, info.byteLength), ...sess.blobs, ...sess.chunks, info], { type: 'audio/wav' });
        sess.blobs = sess.chunks = [];
        downloadBlob(blob, `AlHut_${sess.name}_${Date.now()}.wav`);
        if (hooks.onSaved) hooks.onSaved();
    }

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
    }

    // 16-bit stereo PCM header; the RIFF size also covers the LIST/INFO chunk that goes after the audio.
    function wavHeader(dataBytes, infoBytes) {
        const view = new DataView(new ArrayBuffer(44));
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataBytes + infoBytes, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 2, true);
        view.setUint32(24, ctx.sampleRate, true);
        view.setUint32(28, ctx.sampleRate * 4, true);
        view.setUint16(32, 4, true);
        view.setUint16(34, 16, true);
        writeString(view, 36, 'data');
        view.setUint32(40, dataBytes, true);
        return view.buffer;
    }

    function infoChunk() {
        const field = (id, text) => {
            let s = text + '\0';
            if (s.length % 2 === 1) s += '\0';
            return [id, s];
        };
        const fields = [field('IART', 'Al Hut mixer abo kalleb'), field('ISFT', 'Al Hut mixer abo kalleb')];
        const listSize = 4 + fields.reduce((n, [, s]) => n + 8 + s.length, 0);
        const view = new DataView(new ArrayBuffer(8 + listSize));
        writeString(view, 0, 'LIST');
        view.setUint32(4, listSize, true);
        writeString(view, 8, 'INFO');
        let offset = 12;
        fields.forEach(([id, s]) => {
            writeString(view, offset, id);
            view.setUint32(offset + 4, s.length, true);
            writeString(view, offset + 8, s);
            offset += 8 + s.length;
        });
        return view.buffer;
    }

    return {
        start, stop,
        get recording() { return !!session; },
        get startedAt() { return session ? session.startedAt : 0; },
    };
}

// "12:34" or "1:02:03" since a timestamp in ms.
function formatElapsed(since) {
    const s = Math.floor((Date.now() - since) / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
    return (hh ? hh + ':' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}
