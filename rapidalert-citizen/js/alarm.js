/* ============================================================
   RapidAlert Citizen – alarm.js
   Web Audio API based emergency alarm system.
   Generates real oscillator-based siren sounds (no audio files needed).
   ============================================================ */

window.AlarmSystem = (function () {

    let audioCtx = null;
    let alarmNodes = [];
    let isPlaying = false;
    let alarmInterval = null;

    // ── Get or create AudioContext ────────────────────────────────
    function getCtx() {
        if (!audioCtx || audioCtx.state === 'closed') {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return audioCtx;
    }

    /**
     * UNLOCK: Must be called on first user interaction (click/touch).
     * This resumes the AudioContext if it was suspended by the browser.
     */
    async function unlock() {
        const ctx = getCtx();
        if (ctx.state === 'suspended') {
            await ctx.resume();
            console.info('[Alarm] AudioContext unlocked and resumed.');
        }
    }

    // ── Siren tone generator ──────────────────────────────────────
    function playSirenTone(duration = 1200, isExtreme = false) {
        const ctx = getCtx();
        const now = ctx.currentTime;
        const dur = duration / 1000;

        // Master gain (volume envelope)
        const masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0, now);
        masterGain.gain.exponentialRampToValueAtTime(isExtreme ? 0.9 : 0.6, now + 0.1);
        masterGain.gain.setValueAtTime(isExtreme ? 0.9 : 0.6, now + dur - 0.2);
        masterGain.gain.linearRampToValueAtTime(0, now + dur);
        masterGain.connect(ctx.destination);

        // Osc 1: Deep Sawtooth
        const osc1 = ctx.createOscillator();
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(isExtreme ? 330 : 440, now);
        osc1.frequency.exponentialRampToValueAtTime(isExtreme ? 990 : 880, now + dur / 2);
        osc1.frequency.exponentialRampToValueAtTime(isExtreme ? 330 : 440, now + dur);

        // Osc 2: High Square (Urgency)
        const osc2 = ctx.createOscillator();
        osc2.type = 'square';
        osc2.frequency.setValueAtTime(isExtreme ? 400 : 460, now);
        osc2.frequency.exponentialRampToValueAtTime(isExtreme ? 1200 : 920, now + dur / 2);
        osc2.frequency.exponentialRampToValueAtTime(isExtreme ? 400 : 460, now + dur);

        const gain2 = ctx.createGain();
        gain2.gain.value = 0.4;

        osc1.connect(masterGain);
        osc2.connect(gain2);
        gain2.connect(masterGain);

        osc1.start(now);
        osc1.stop(now + dur);
        osc2.start(now);
        osc2.stop(now + dur);

        alarmNodes.push(osc1, osc2, masterGain, gain2);
        return dur * 1000;
    }

    function playBeepPattern() {
        const ctx = getCtx();
        const now = ctx.currentTime;
        [0, 0.3, 0.6].forEach((offset) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = 880;
            gain.gain.setValueAtTime(0, now + offset);
            gain.gain.linearRampToValueAtTime(0.3, now + offset + 0.05);
            gain.gain.setValueAtTime(0.3, now + offset + 0.2);
            gain.gain.linearRampToValueAtTime(0, now + offset + 0.25);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + offset);
            osc.stop(now + offset + 0.25);
            alarmNodes.push(osc, gain);
        });
    }

    // ── Public API ────────────────────────────────────────────────

    function startAlarm(severity) {
        if (isPlaying) return;
        isPlaying = true;

        const playCycle = () => {
            if (!isPlaying) return;

            // Vibration patterns
            if (severity === 'Evacuate' && navigator.vibrate) {
                navigator.vibrate([800, 200, 800, 200, 800]);
            } else if (severity === 'Emergency' && navigator.vibrate) {
                navigator.vibrate([400, 100, 400]);
            } else if (navigator.vibrate) {
                navigator.vibrate(200);
            }

            if (severity === 'Info') {
                playBeepPattern();
                alarmInterval = setTimeout(playCycle, 3000);
            } else if (severity === 'Warning') {
                playSirenTone(1000, false);
                alarmInterval = setTimeout(playCycle, 2000);
            } else if (severity === 'Emergency') {
                playSirenTone(1200, true);
                alarmInterval = setTimeout(playCycle, 1000);
            } else { // Evacuate
                playSirenTone(800, true);
                setTimeout(() => { if (isPlaying) playSirenTone(800, true); }, 400);
                alarmInterval = setTimeout(playCycle, 600);
            }
        };

        playCycle();
    }

    function stopAlarm() {
        isPlaying = false;
        clearTimeout(alarmInterval);
        if (navigator.vibrate) navigator.vibrate(0);
        alarmNodes.forEach(node => {
            try { node.stop && node.stop(); } catch (e) { }
            try { node.disconnect(); } catch (e) { }
        });
        alarmNodes = [];
    }

    function playSosConfirmation() {
        const ctx = getCtx();
        const now = ctx.currentTime;
        [0, 0.2, 0.4].forEach((t) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = 1100;
            gain.gain.setValueAtTime(0, now + t);
            gain.gain.linearRampToValueAtTime(0.5, now + t + 0.05);
            gain.gain.linearRampToValueAtTime(0, now + t + 0.15);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(now + t); osc.stop(now + t + 0.2);
        });
    }

    function playSafeConfirmation() {
        const ctx = getCtx();
        const now = ctx.currentTime;
        [0, 0.2].forEach((t, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = i === 0 ? 523 : 659;
            gain.gain.setValueAtTime(0, now + t);
            gain.gain.linearRampToValueAtTime(0.4, now + t + 0.1);
            gain.gain.linearRampToValueAtTime(0, now + t + 0.4);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(now + t); osc.stop(now + t + 0.5);
        });
    }

    return { unlock, startAlarm, stopAlarm, playSosConfirmation, playSafeConfirmation };

})();

