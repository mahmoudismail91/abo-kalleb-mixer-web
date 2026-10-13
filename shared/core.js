// Shared helpers for the mixer and the sampler: DOM/number utils, local storage, and loading audio files
// from pickers or drag and drop. Plain script (not a module) so the pages also work opened as local files.

const $ = id => document.getElementById(id);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fileKey = f => f._path || f.webkitRelativePath || f.name;
const baseName = f => f.name.replace(/\.[^/.]+$/, "");

const LOOSE = '(loose)';
const folderLabel = cat => (cat === LOOSE ? 'main folder' : cat);
const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.aif', '.aiff', '.opus', '.webm'];

const store = {
    get(key, fallback) {
        try { const v = localStorage.getItem('alhut.' + key); return v ? JSON.parse(v) : fallback; }
        catch (e) { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem('alhut.' + key, JSON.stringify(value)); } catch (e) {}
    },
};

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Keeps only audio files, skipping macOS "._" shadow files.
function audioFilesOf(fileList) {
    return Array.from(fileList).filter(f => {
        const n = f.name.toLowerCase();
        return !n.startsWith('._') && AUDIO_EXTS.some(ext => n.endsWith(ext));
    });
}

// A file's role is its top-level subfolder inside whatever was loaded.
function assignCategories(files) {
    const paths = files.map(f => fileKey(f).split('/'));
    const firstSegs = new Set(paths.map(p => (p.length > 1 ? p[0] : '')));
    const sharedRoot = firstSegs.size === 1 && !firstSegs.has('');
    files.forEach((f, i) => {
        const rel = sharedRoot ? paths[i].slice(1) : paths[i];
        f._cat = rel.length > 1 ? rel[0] : LOOSE;
    });
}

async function filesFromEntries(entries) {
    const out = [];
    const walk = async (entry) => {
        if (entry.isFile) {
            const f = await new Promise((res, rej) => entry.file(res, rej));
            f._path = entry.fullPath.replace(/^\//, '');
            out.push(f);
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            let batch;
            do {
                batch = await new Promise((res, rej) => reader.readEntries(res, rej));
                for (const child of batch) await walk(child);
            } while (batch.length);
        }
    };
    for (const entry of entries) await walk(entry);
    return out;
}

// Files or whole folders dropped anywhere on the page. onDrop(files, event) gets the flattened file list;
// the event's target says where it landed (the sampler uses that to drop onto a single pad).
function setupDropZone(overlay, onDrop, onReading = () => {}) {
    let dragDepth = 0;
    const dragHasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    document.addEventListener('dragenter', (e) => { if (dragHasFiles(e)) { dragDepth++; overlay.hidden = false; } });
    document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
    document.addEventListener('dragover', (e) => { if (dragHasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', async (e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        overlay.hidden = true;
        // entries must be grabbed synchronously, the list is emptied once the event returns
        const entries = Array.from(e.dataTransfer.items || [])
            .map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
        const plainFiles = Array.from(e.dataTransfer.files);
        onReading();
        onDrop(entries.length ? await filesFromEntries(entries) : plainFiles, e);
    });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);   // revoking immediately can cancel the download in Firefox/Safari
}

