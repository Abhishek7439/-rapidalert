/**
 * auth.js – Citizen PWA Phone Authentication  (ES Module)
 * =========================================================
 * Implements real Firebase Phone Auth:
 *   - Invisible reCAPTCHA (auto-solved by Firebase)
 *   - signInWithPhoneNumber (India +91 prefix enforced)
 *   - OTP entry with 6 individual digit boxes
 *   - confirmationResult.confirm(otp)
 *   - On success: upserts /users/{uid} in Firestore
 *   - Rate limiting: 3 OTP send attempts per session
 *   - Resend timer: 30-second cooldown
 *
 * Requires: window.FB set by firebase-init.js
 * Exposes:  window.Auth
 */

import {
    RecaptchaVerifier,
    signInWithPhoneNumber,
    onAuthStateChanged,
    signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';
import {
    doc,
    setDoc,
    getDoc,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-firestore.js';

const { auth, db } = window.FB;

// ── Rate limiting (in-memory, resets on page reload) ──────────────────────────
const MAX_OTP_ATTEMPTS = 3;
let otpSendCount = 0;
let resendTimer = null;
let confirmationResult = null;
let pendingPhone = null;

// ── onAuthStateChanged — check if citizen already logged in ───────────────────
// Uses a buffer pattern: if onAuthStateChanged fires BEFORE checkAuthState is
// called (common on fast devices / cached sessions), we store the result and
// immediately invoke the callback when checkAuthState registers it.
let _authReadyCb = null;
let _authResolved = false;   // true once onAuthStateChanged has fired
let _authResult = undefined; // buffered result (profile or null)

onAuthStateChanged(auth, async (user) => {
    let resolvedValue;
    if (user) {
        // Restore profile from Firestore
        try {
            const snap = await getDoc(doc(db, 'users', user.uid));
            resolvedValue = snap.exists()
                ? snap.data()
                : { name: 'Citizen', phone: user.phoneNumber };
        } catch (err) {
            console.error('[CitizenAuth] Profile fetch error:', err);
            resolvedValue = { name: 'Citizen', phone: user.phoneNumber || '', uid: user.uid };
        }
    } else {
        resolvedValue = null;
    }

    _authResult = resolvedValue;
    _authResolved = true;

    // If checkAuthState was already called, invoke the callback immediately
    if (_authReadyCb) {
        const cb = _authReadyCb;
        _authReadyCb = null;   // prevent double-fire
        cb(_authResult);
    }
});


// ── Main entry: renderAuthScreen ─────────────────────────────────────────────
// Called from citizen index.html after splash.
// @param onSuccessCb  Called with citizen profile object on successful login.
function renderAuthScreen(onSuccessCb) {
    const root = document.getElementById('app-root');
    if (!root) return;

    root.innerHTML = getPhoneStepHTML();
    attachPhoneStepHandlers(onSuccessCb);
}


// ── STEP 1: Phone number entry ────────────────────────────────────────────────
function getPhoneStepHTML() {
    return `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-logo">🚨</div>
          <div class="auth-title">RapidAlert</div>
          <div class="auth-subtitle">Emergency Management · Citizen App</div>

          <div class="auth-step-label">Step 1 of 2 – Enter Mobile Number</div>

          <div class="auth-desc">
            You'll receive a 6-digit OTP via SMS to verify your identity.
          </div>

          <div class="phone-field-group">
            <div class="country-code">+91</div>
            <input
              type="tel"
              id="auth-phone"
              class="auth-input"
              maxlength="10"
              pattern="[6-9][0-9]{9}"
              placeholder="10-digit mobile number"
              autocomplete="tel-national"
              inputmode="numeric"
            />
          </div>

          <div id="phone-error" class="auth-error" style="display:none"></div>

          <div id="recaptcha-container"></div>

          <button class="auth-btn" id="send-otp-btn">
            Send OTP →
          </button>

          <div class="auth-hint">
            🔒 Authorized for registered citizens only.
            OTP valid for 10 minutes.
          </div>
        </div>
      </div>`;
}

function attachPhoneStepHandlers(onSuccessCb) {
    const phoneInput = document.getElementById('auth-phone');
    const sendBtn = document.getElementById('send-otp-btn');
    const phoneErrEl = document.getElementById('phone-error');

    // ── Invisible reCAPTCHA setup ──────────────────────────────────
    // Must be created AFTER the recaptcha-container element is in the DOM.
    let recaptchaVerifier;
    try {
        recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
            size: 'invisible',
            callback: () => { /* reCAPTCHA solved — proceed silently */ },
            'expired-callback': () => {
                showPhoneError('reCAPTCHA expired. Please try again.');
                sendBtn.disabled = false;
            },
        });
    } catch (err) {
        console.error('[CitizenAuth] RecaptchaVerifier init error:', err);
    }

    // Phone number validation
    phoneInput.addEventListener('input', () => {
        phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 10);
        hidePhoneError();
    });

    sendBtn.addEventListener('click', async () => {
        const phoneRaw = phoneInput.value.trim();

        if (!/^[6-9][0-9]{9}$/.test(phoneRaw)) {
            showPhoneError('Enter a valid 10-digit Indian mobile number (starting with 6–9).');
            return;
        }

        if (otpSendCount >= MAX_OTP_ATTEMPTS) {
            showPhoneError('Too many OTP requests. Reload the page and try again.');
            return;
        }

        setPhoneLoading(true, sendBtn);

        const fullPhone = `+91${phoneRaw}`;
        pendingPhone = fullPhone;

        try {
            confirmationResult = await signInWithPhoneNumber(auth, fullPhone, recaptchaVerifier);
            otpSendCount++;

            // Transition to OTP step
            const root = document.getElementById('app-root');
            if (root) {
                root.innerHTML = getOTPStepHTML(phoneRaw);
                attachOTPStepHandlers(onSuccessCb, fullPhone);
                // In dev mode: auto-fetch OTP from emulator and fill boxes
                setTimeout(() => devAutoFillOTP(fullPhone), 600);
            }

        } catch (err) {
            console.error('[CitizenAuth] signInWithPhoneNumber error:', err.code, err.message);
            setPhoneLoading(false, sendBtn);

            const MSG = {
                'auth/invalid-phone-number': 'Invalid phone number format.',
                'auth/too-many-requests': 'Too many requests. Try again in a few minutes.',
                'auth/quota-exceeded': 'SMS quota exceeded. Try again later.',
                'auth/network-request-failed': 'Network error. Check internet connection.',
                'auth/captcha-check-failed': 'reCAPTCHA failed. Reload and try again.',
                'auth/missing-phone-number': 'Phone number is required.',
            };
            showPhoneError(MSG[err.code] || `Error: ${err.message}`);
        }
    });

    function showPhoneError(msg) { if (phoneErrEl) { phoneErrEl.textContent = msg; phoneErrEl.style.display = 'block'; } }
    function hidePhoneError() { if (phoneErrEl) { phoneErrEl.style.display = 'none'; } }
    function setPhoneLoading(on, btn) {
        btn.disabled = on;
        btn.textContent = on ? 'Sending OTP…' : 'Send OTP →';
    }
}


// ── STEP 2: OTP verification ──────────────────────────────────────────────────
function getOTPStepHTML(phoneRaw) {
    const isDev = window.RAPIDALERT_CONFIG?.env === 'development';
    return `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-logo">📲</div>
          <div class="auth-title">Verify OTP</div>
          <div class="auth-step-label">Step 2 of 2 – Enter OTP</div>
          <div class="otp-sent-to">
            OTP sent to <strong>+91 ${phoneRaw}</strong>
          </div>

          ${isDev ? `
          <div id="dev-otp-hint" style="
            background:rgba(59,130,246,0.12);
            border:1px solid rgba(59,130,246,0.4);
            border-radius:10px;
            padding:10px 14px;
            font-size:13px;
            color:#93c5fd;
            margin:10px 0;
            text-align:center;
          ">
            🔧 Dev Mode – Fetching OTP code…
          </div>` : ''}

          <!-- 6 OTP digit boxes -->
          <div class="otp-boxes" id="otp-boxes">
            ${[0, 1, 2, 3, 4, 5].map(i =>
        `<input type="text" class="otp-box" id="otp-box-${i}"
                      maxlength="1" inputmode="numeric" pattern="[0-9]"
                      autocomplete="${i === 0 ? 'one-time-code' : 'off'}">`
    ).join('')}
          </div>

          <div id="otp-error" class="auth-error" style="display:none"></div>

          <button class="auth-btn" id="verify-otp-btn">
            Verify OTP →
          </button>

          <div class="resend-row">
            <span id="resend-timer" style="color:rgba(255,255,255,0.5);font-size:13px"></span>
            <button class="resend-btn" id="resend-btn" style="display:none">
              Resend OTP
            </button>
            <button class="auth-text-btn" id="change-phone-btn">
              ← Change Number
            </button>
          </div>
        </div>
      </div>`;
}

// ── Dev helper: Fetch OTP from emulator API and auto-fill boxes ───────────────
async function devAutoFillOTP(fullPhone) {
    if (window.RAPIDALERT_CONFIG?.env !== 'development') return;
    const hintEl = document.getElementById('dev-otp-hint');
    try {
        // The emulator exposes generated OTPs at this endpoint.
        // Use the same host the page was loaded from (set by firebase-init.js).
        const host = window._devEmulatorHost || window.location.hostname || '127.0.0.1';
        const resp = await fetch(
            `http://${host}:9099/emulator/v1/projects/smart-community-8fd9a/verificationCodes`,
            { mode: 'cors' }
        );
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();

        // Find the most recent code for this phone number
        const codes = (data.verificationCodes || []).filter(v => v.phoneNumber === fullPhone);
        const latest = codes[codes.length - 1];

        if (latest?.code) {
            // Auto-fill the 6 boxes
            const boxes = Array.from({ length: 6 }, (_, i) => document.getElementById(`otp-box-${i}`));
            latest.code.split('').forEach((ch, i) => { if (boxes[i]) boxes[i].value = ch; });
            if (hintEl) {
                hintEl.innerHTML = `🔧 <b>Dev OTP auto-filled: <span style="letter-spacing:4px;font-size:18px;font-weight:800;color:#60a5fa">${latest.code}</span></b><br><span style="font-size:11px;opacity:0.7">Tap Verify OTP →</span>`;
            }
            console.info('[DevAuth] OTP auto-filled:', latest.code);
        } else {
            if (hintEl) hintEl.textContent = '🔧 Dev Mode – Check emulator at :9099 for OTP';
        }
    } catch (err) {
        console.warn('[DevAuth] Could not fetch OTP from emulator:', err.message);
        if (hintEl) hintEl.textContent = `🔧 Dev Mode – Could not reach emulator (${err.message}). Check console.`;
    }
}

function attachOTPStepHandlers(onSuccessCb, fullPhone) {
    const boxes = Array.from({ length: 6 }, (_, i) => document.getElementById(`otp-box-${i}`));
    const verifyBtn = document.getElementById('verify-otp-btn');
    const otpErrEl = document.getElementById('otp-error');
    const resendBtn = document.getElementById('resend-btn');
    const timerEl = document.getElementById('resend-timer');
    const changeBtn = document.getElementById('change-phone-btn');

    // Auto-focus first box
    boxes[0]?.focus();

    // OTP box keyboard navigation & auto-advance
    boxes.forEach((box, idx) => {
        box.addEventListener('input', (e) => {
            box.value = box.value.replace(/\D/g, '').slice(0, 1);
            if (box.value && idx < 5) boxes[idx + 1].focus();
            if (boxes.every(b => b.value)) verifyOTP(); // auto-submit when all filled
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !box.value && idx > 0) boxes[idx - 1].focus();
        });
        // Handle paste into first box (fills all 6)
        box.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
            pasted.split('').forEach((ch, i) => { if (boxes[i]) boxes[i].value = ch; });
            const nextEmpty = boxes.findIndex(b => !b.value);
            if (nextEmpty >= 0) boxes[nextEmpty].focus();
            else { boxes[5].focus(); verifyOTP(); }
        });
    });

    // Start 30-second resend countdown
    startResendTimer();

    verifyBtn.addEventListener('click', verifyOTP);

    changeBtn.addEventListener('click', () => {
        clearInterval(resendTimer);
        renderAuthScreen(onSuccessCb); // go back to step 1
    });

    resendBtn.addEventListener('click', async () => {
        if (otpSendCount >= MAX_OTP_ATTEMPTS) {
            showOTPError('Maximum OTP requests reached. Reload and try again.');
            return;
        }
        resendBtn.style.display = 'none';
        showOTPError('');
        boxes.forEach(b => b.value = '');
        boxes[0].focus();

        // Re-create the verifier
        try {
            const verifier = new RecaptchaVerifier(auth, 'resend-recaptcha', { size: 'invisible' });
            let tempDiv = document.getElementById('resend-recaptcha');
            if (!tempDiv) {
                tempDiv = document.createElement('div');
                tempDiv.id = 'resend-recaptcha';
                document.getElementById('app-root').appendChild(tempDiv);
            }
            confirmationResult = await signInWithPhoneNumber(auth, pendingPhone, verifier);
            otpSendCount++;
            startResendTimer();
        } catch (err) {
            console.error('[CitizenAuth] Resend OTP error:', err);
            showOTPError('Failed to resend OTP. Please reload and try again.');
        }
    });

    async function verifyOTP() {
        const otp = boxes.map(b => b.value).join('');
        if (otp.length < 6) { showOTPError('Enter all 6 digits.'); return; }

        setVerifyLoading(true);

        try {
            const { user } = await confirmationResult.confirm(otp);
            clearInterval(resendTimer);

            // Upsert user document in Firestore
            const profile = await upsertCitizenProfile(user);
            onSuccessCb(profile);

        } catch (err) {
            console.error('[CitizenAuth] confirm error:', err.code, err.message);
            setVerifyLoading(false);

            const MSG = {
                'auth/invalid-verification-code': 'Incorrect OTP. Check and try again.',
                'auth/code-expired': 'OTP has expired. Request a new one.',
                'auth/missing-verification-code': 'Enter the 6-digit OTP from your SMS.',
                'auth/too-many-requests': 'Too many attempts. Wait before trying again.',
            };
            showOTPError(MSG[err.code] || `Verification failed: ${err.message}`);
            boxes.forEach(b => b.value = '');
            boxes[0].focus();
        }
    }

    function startResendTimer() {
        let seconds = 30;
        timerEl.textContent = `Resend in ${seconds}s`;
        resendBtn.style.display = 'none';
        clearInterval(resendTimer);
        resendTimer = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                clearInterval(resendTimer);
                timerEl.textContent = '';
                resendBtn.style.display = 'inline-block';
            } else {
                timerEl.textContent = `Resend in ${seconds}s`;
            }
        }, 1000);
    }

    function showOTPError(msg) { if (otpErrEl) { otpErrEl.textContent = msg; otpErrEl.style.display = msg ? 'block' : 'none'; } }
    function setVerifyLoading(on) {
        verifyBtn.disabled = on;
        verifyBtn.textContent = on ? 'Verifying…' : 'Verify OTP →';
        boxes.forEach(b => b.disabled = on);
    }
}


// ── Create / update citizen Firestore document ────────────────────────────────
async function upsertCitizenProfile(user) {
    const userRef = doc(db, 'users', user.uid);
    let profile;

    try {
        const snap = await getDoc(userRef);

        if (snap.exists()) {
            // Update lastSeen only — preserve existing name, district etc.
            await setDoc(userRef, { lastSeen: serverTimestamp() }, { merge: true });
            profile = snap.data();
        } else {
            // Brand new citizen — create document with defaults
            profile = {
                uid: user.uid,
                phone: user.phoneNumber,
                name: `Citizen-${user.uid.slice(-6)}`,
                role: 'citizen',
                district: null,
                city: null,
                fcmToken: null,
                location: null,
                geohash: null,
                createdAt: serverTimestamp(),
                lastSeen: serverTimestamp(),
            };
            await setDoc(userRef, profile);
        }
    } catch (err) {
        console.error('[CitizenAuth] upsertCitizenProfile error:', err);
        profile = {
            uid: user.uid,
            phone: user.phoneNumber,
            name: `Citizen-${user.uid.slice(-6)}`,
            role: 'citizen',
        };
    }

    return profile;
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function citizenLogout() {
    // Stop geo refresh interval before signing out
    if (window.Geo?.stopGeo) Geo.stopGeo();
    try {
        await signOut(auth);
    } catch (err) {
        console.error('[CitizenAuth] signOut error:', err);
    }
}


// ── Expose ────────────────────────────────────────────────────────────────────
window.Auth = {
    renderAuthScreen,
    /**
     * checkAuthState(cb)
     * Calls cb(profile) immediately if auth has already resolved,
     * otherwise waits for onAuthStateChanged to fire.
     * This prevents blank screens caused by the race condition where
     * onAuthStateChanged fires before boot registers the callback.
     */
    checkAuthState: (cb) => {
        if (_authResolved) {
            // Auth already resolved — invoke immediately (next microtask)
            Promise.resolve().then(() => cb(_authResult));
        } else {
            // Not yet resolved — store callback, onAuthStateChanged will call it
            _authReadyCb = cb;
        }
    },
    logout: citizenLogout,
};
