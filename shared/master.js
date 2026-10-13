// The master section shared by both instruments:
// input -> masterGain -> trim (auto, per layer count) -> drive -+-> dry ---------------+
//                                                               +-> delay <-> fb ------+-> busOut -> limiter -> safety clip -> output
//                                                               +-> reverb ------------+                                 (speakers + recorder)
function createMasterChain(ctx) {
    const node = () => ctx.createGain();
    const masterGain = node(), trimGain = node(), drivePre = node(), drivePost = node(), dryGain = node(), busOut = node();
    // Drive is a fixed saturation curve; the knob only moves the gains around it, so turning it never clicks.
    const driveNode = ctx.createWaveShaper();
    driveNode.curve = makeSaturationCurve();
    driveNode.oversample = '4x';

    masterGain.connect(trimGain);
    trimGain.connect(drivePre);
    drivePre.connect(driveNode);
    driveNode.connect(drivePost);
    drivePost.connect(dryGain);
    dryGain.connect(busOut);

    const delaySend = node();
    const delayNode = ctx.createDelay(2.0);
    delayNode.delayTime.value = 0.5;
    const feedbackFilter = ctx.createBiquadFilter();
    feedbackFilter.type = 'lowpass';
    feedbackFilter.frequency.value = 3200;
    const feedbackGain = node();
    delaySend.gain.value = 0;
    feedbackGain.gain.value = 0;
    drivePost.connect(delaySend);
    delaySend.connect(delayNode);
    delayNode.connect(feedbackFilter);
    feedbackFilter.connect(feedbackGain);
    feedbackGain.connect(delayNode);
    delayNode.connect(busOut);

    const reverbSend = node();
    reverbSend.gain.value = 0;
    const reverbNode = ctx.createConvolver();
    reverbNode.buffer = makeImpulse(ctx, 4.5);
    drivePost.connect(reverbSend);
    delayNode.connect(reverbSend);
    reverbSend.connect(reverbNode);
    reverbNode.connect(busOut);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.3;
    busOut.connect(limiter);

    // The compressor can overshoot on sudden peaks; this gentle clipper catches anything above ~0.8
    // so the output never hard-clips.
    const safetyPre = node();
    safetyPre.gain.value = 0.5;
    const safety = ctx.createWaveShaper();
    safety.curve = makeSafetyCurve();
    safety.oversample = '2x';
    const output = node();
    output.gain.value = 2;
    limiter.connect(safetyPre);
    safetyPre.connect(safety);
    safety.connect(output);
    output.connect(ctx.destination);

    const values = { master: 0.7, reverb: 0, delay: 0, drive: 0 };

    // id is one of master / reverb / delay / drive, v is the knob's 0..1 value.
    function set(id, v) {
        values[id] = v;
        const now = ctx.currentTime;
        if (id === 'master') masterGain.gain.setTargetAtTime(v, now, 0.03);
        if (id === 'reverb') reverbSend.gain.setTargetAtTime(v * 0.8, now, 0.05);
        if (id === 'delay') {
            delaySend.gain.setTargetAtTime(v * 0.8, now, 0.05);
            feedbackGain.gain.setTargetAtTime(v * 0.75, now, 0.05);
        }
        if (id === 'drive') {
            // small-signal gain = 3.2^v: clean and unchanged at 0, warmer and a bit louder as it rises
            drivePre.gain.setTargetAtTime(Math.pow(64, v) / 64, now, 0.05);
            drivePost.gain.setTargetAtTime(16 * Math.pow(0.05, v), now, 0.05);
        }
        if (id === 'reverb' || id === 'delay') {
            // pull the dry signal back as the effects come up, so they don't just add loudness
            dryGain.gain.setTargetAtTime(1 - 0.3 * values.reverb - 0.15 * values.delay, now, 0.05);
        }
    }

    // Several full-level voices add up fast; scale the sum down gently as they pile up.
    function setVoiceCount(n, tc = 0.8) {
        trimGain.gain.setTargetAtTime(Math.min(1, Math.sqrt(2 / Math.max(1, n))), ctx.currentTime, tc);
    }

    return { input: masterGain, output, set, setVoiceCount };
}
