# abo-kalleb-mixer-web

A browser-based ambient audio mixer for live track swapping and loose soundscape layering.

I built this because I wanted something simple that lets me drift through the sound recordings and samples I've collected over the years: hit **Next**, hit **Next**, swap a layer, and hear random pieces of an archive meet each other. It is a folder loader and random player at its core, and it has grown into a small generative mixing instrument.

Everything runs client-side with the Web Audio API. No install, no server, nothing is uploaded: your files stay in your browser.

- Run on itch.io: https://mahmoud-ismail.itch.io/al-hut-audio-mixer-abo-kalleb
- My website: https://www.mah-mood.com

---

## What's new in this update

- **Slices mode**: loop short random pieces of files instead of whole files, like instant samples, with an optional **Hop** that jumps each slice to a new spot every 1, 2 or 4 loops.
- **Tempo sync**: lock layers that have a BPM to one shared grid, bar-aligned.
- **Folder Roles**: each subfolder of your library becomes a role (pads, drums, voices...) with its own min/max layer count.
- **Waveform strip on every layer**: see the whole file, the looping slice (yellow) and the playhead (red). Click or drag to move the slice.
- **Hold / reverse / re-slice** per layer, plus per-layer speed, pan, volume and BPM.
- **Master FX**: Reverb, Delay and Drive, with a limiter and safety clipper so the output never hard-clips.
- **Snapshots**: save a moment (layers and settings), recall it later, export/import as JSON.
- **Better recorder**: captures on the audio thread (AudioWorklet), stores 16-bit PCM and pages to disk, so long sessions don't drop audio or eat memory.
- **Drag and drop** files or whole folders anywhere on the page, and **keyboard shortcuts**.
- Seamless loops: crossfaded loop points and click-free fades everywhere.

---

## How it works

1. **Load your sounds.** Use *Load Music Folder*, *Load Files*, or drop files/folders onto the page (mp3, wav, flac, ogg, m4a, aac, aiff, opus, webm).
2. **Press PLAY.** A few random files (1 to 6, chosen by probability) start looping together, each from a random point. **NEXT MIX** rolls a new combination. A shuffle-bag per folder means every file is heard once before any repeats.
3. **Shape it live.** Everything keeps playing while you tweak.

### Modes

| Control | What it does |
|---|---|
| **STANDARD** | Holds the current combination until you change it. |
| **AMBIENT** | Keeps drifting. Every ~10 to 60 s (the *Drift Every* slider) one layer slowly fades out and another fades in. The longest-playing layer usually leaves, so sounds pass through like a stream. Each layer also slowly breathes in volume, pan and filter. |
| **Loops: FULL / SLICES** | FULL loops whole files. SLICES loops short pieces. |
| **Hop** | In SLICES mode, every slice jumps to a new random spot of its file every 1, 2 or 4 loops. |
| **Sync** | Locks layers to one tempo grid. Give a file a BPM by putting it in the name (`beat_120bpm.wav`) or typing it in the layer's BPM box. Files without a BPM float freely. A 70 BPM loop plays as 140 inside a 140 mix. |

### Per layer

- 📌 **Hold**: drift, hop and Next Mix leave this layer alone.
- 🔄 **Swap** it for a fresh random file without stopping the mix.
- ✂ **Cut** a new loop slice from the file.
- ⇆ **Reverse** it.
- ✕ **Fade it out.**
- Volume, pan and speed knobs; **Add Layer** brings in one more.

### Master section

Master volume, **Reverb**, **Delay** and **Drive**. Signal path:

```
tracks -> master gain -> auto trim -> drive -+-> dry ---------+
                                             +-> delay <-> fb +-> limiter -> safety clip -> speakers (+ recorder)
                                             +-> reverb ------+
```

### Folder Roles (☰ Settings)

If your library has subfolders (e.g. `pads`, `drums`, `voices`), each one is a role. Set how many layers it may bring in, like "always 1 pad, max 1 drum". **✕** takes a folder out of the mix; **Max: off** keeps it out every time. Swaps prefer replacing a layer with one from the same role.

### Snapshots

Name a moment and **Save** it: layers, slices and settings. Recall it any time. **Export / Import** moves snapshots between browsers as JSON.

### Recording

**RECORD (WAV)** captures the live master output to a 16-bit stereo WAV with a custom metadata header and downloads it when you stop.

### Keyboard

`P` play/stop · `N` next mix · `M` switch mode

---

## Running it

Just open `index.html` in a modern browser (Chrome, Edge, Firefox), or use the itch.io link above. Keep `mixerabokalleb_logo.*` and `your_background.gif` next to it.

Note: when opened straight from disk some browsers can't use AudioWorklet; the recorder falls back to a ScriptProcessor automatically.

## License

See [LICENSE](LICENSE).
