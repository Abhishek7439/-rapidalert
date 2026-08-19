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
    signInWithCustomToken,
    GoogleAuthProvider,
    signInWithPopup,
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
        const authMode = window.RAPIDALERT_CONFIG?.authMode || 'twilio';
        
        if (authMode === 'google') {
            // Google authentication mode
            try {
                const snap = await getDoc(doc(db, 'users', user.uid));
                resolvedValue = snap.exists() ? snap.data() : null; // returns null to trigger complete profile flow if user doc doesn't exist yet
            } catch (err) {
                console.error('[CitizenAuth] Profile fetch error:', err);
                resolvedValue = { name: user.displayName || 'Citizen', phone: '', uid: user.uid };
            }
        } else {
            // Original Twilio / Phone SMS mode
            const isTwilioMode = authMode === 'twilio';
            if (!user.phoneNumber && !isTwilioMode) {
                console.warn('[CitizenAuth] User authenticated via non-phone provider. Signing out.');
                await signOut(auth).catch(() => {});
                resolvedValue = null;
            } else {
                try {
                    const snap = await getDoc(doc(db, 'users', user.uid));
                    resolvedValue = snap.exists()
                        ? snap.data()
                        : { name: 'Citizen', phone: user.phoneNumber || pendingPhone || '', uid: user.uid };
                } catch (err) {
                    console.error('[CitizenAuth] Profile fetch error:', err);
                    resolvedValue = { name: 'Citizen', phone: user.phoneNumber || pendingPhone || '', uid: user.uid };
                }
            }
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

    const authMode = window.RAPIDALERT_CONFIG?.authMode || 'twilio';
    if (authMode === 'google') {
        if (auth.currentUser) {
            renderCompleteProfileScreen(auth.currentUser, onSuccessCb);
        } else {
            renderGoogleLoginScreen(onSuccessCb);
        }
    } else {
        root.innerHTML = getPhoneStepHTML();
        attachPhoneStepHandlers(onSuccessCb);
    }
}

// ── Google Authentication Screens ─────────────────────────────────────────────

function renderGoogleLoginScreen(onSuccessCb) {
    const root = document.getElementById('app-root');
    if (!root) return;

    root.innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-logo">🚨</div>
          <div class="auth-title">RapidAlert</div>
          <div class="auth-subtitle">Emergency Management · Citizen App</div>
          <div class="auth-desc" style="margin-bottom: 25px;">
            Sign in securely with your Google Account to access emergency services and alerts.
          </div>
          <div id="google-error" class="auth-error" style="display:none; margin-bottom: 15px;"></div>
          <button class="auth-btn" id="google-login-btn">
            Sign in with Google
          </button>
          <div class="auth-hint">
            🔒 Secure authentication via Google.
          </div>
        </div>
      </div>`;

    const loginBtn = document.getElementById('google-login-btn');
    const errEl = document.getElementById('google-error');

    loginBtn.addEventListener('click', async () => {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Signing in...';
        if (errEl) errEl.style.display = 'none';

        try {
            const provider = new GoogleAuthProvider();
            const result = await signInWithPopup(auth, provider);
            const user = result.user;
            
            // Check if profile document exists in Firestore
            const snap = await getDoc(doc(db, 'users', user.uid));
            if (snap.exists()) {
                const profile = snap.data();
                // Store in buffered result and trigger callbacks
                _authResult = profile;
                _authResolved = true;
                onSuccessCb(profile);
            } else {
                renderCompleteProfileScreen(user, onSuccessCb);
            }
        } catch (err) {
            console.error('[CitizenAuth] Google login error:', err);
            loginBtn.disabled = false;
            loginBtn.textContent = 'Sign in with Google';
            if (errEl) {
                errEl.textContent = err.message || 'Login failed. Please try again.';
                errEl.style.display = 'block';
            }
        }
    });
}

function renderCompleteProfileScreen(user, onSuccessCb) {
    const root = document.getElementById('app-root');
    if (!root) return;

    root.innerHTML = `
      <div class="auth-container">
        <div class="auth-card">
          <div class="auth-logo">📝</div>
          <div class="auth-title">Complete Profile</div>
          <div class="auth-subtitle">Enter your details to finish registration</div>
          <div class="auth-desc" style="margin-bottom: 20px;">
            RapidAlert needs your name and phone number to send location-targeted emergency alerts.
          </div>
          <div style="text-align: left; width: 100%;">
            <label style="font-size: 13px; color: #94a3b8; display: block; margin-bottom: 6px;">Full Name</label>
            <input type="text" id="profile-name" class="auth-input" style="width: 100%; margin-bottom: 15px; background: rgba(255,255,255,0.06); border: 1px solid var(--border); border-radius: 8px; padding: 12px; color: white;" value="${user.displayName || ''}" placeholder="John Doe" />
            
            <label style="font-size: 13px; color: #94a3b8; display: block; margin-bottom: 6px;">Mobile Number</label>
            <div class="phone-field-group" style="margin-bottom: 20px;">
              <div class="country-code">+91</div>
              <input type="tel" id="profile-phone" class="auth-input" maxlength="10" placeholder="10-digit mobile number" style="width: 100%;" />
            </div>
          </div>
          <div id="profile-error" class="auth-error" style="display:none; margin-bottom: 15px;"></div>
          <button class="auth-btn" id="save-profile-btn">
            Save and Continue →
          </button>
        </div>
      </div>`;

    const nameInput = document.getElementById('profile-name');
    const phoneInput = document.getElementById('profile-phone');
    const saveBtn = document.getElementById('save-profile-btn');
    const errEl = document.getElementById('profile-error');

    // Phone format listener
    phoneInput.addEventListener('input', () => {
        phoneInput.value = phoneInput.value.replace(/\D/g, '').slice(0, 10);
        if (errEl) errEl.style.display = 'none';
    });
    
    nameInput.addEventListener('input', () => {
        if (errEl) errEl.style.display = 'none';
    });

    saveBtn.addEventListener('click', async () => {
        const nameVal = nameInput.value.trim();
        const phoneVal = phoneInput.value.trim();

        if (!nameVal) {
            if (errEl) { errEl.textContent = 'Please enter your full name.'; errEl.style.display = 'block'; }
            return;
        }

        if (!/^[6-9][0-9]{9}$/.test(phoneVal)) {
            if (errEl) { errEl.textContent = 'Enter a valid 10-digit Indian mobile number (starting with 6–9).'; errEl.style.display = 'block'; }
            return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            const userPhone = `+91${phoneVal}`;
            const userRef = doc(db, 'users', user.uid);
            const profile = {
                uid: user.uid,
                phone: userPhone,
                name: nameVal,
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
            
            // Set the global variables and call success callback
            _authResult = profile;
            _authResolved = true;
            onSuccessCb(profile);
        } catch (err) {
            console.error('[CitizenAuth] Error saving profile:', err);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save and Continue →';
            if (errEl) {
                errEl.textContent = 'Error saving profile. Please try again.';
                errEl.style.display = 'block';
            }
        }
    });
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

function getOtpApiUrl(action) { // action = 'send-otp' or 'verify-otp'
    const configuredUrl = (window.RAPIDALERT_CONFIG?.otpServerUrl || '').trim();
    
    // 1. Direct Cloud Functions domain
    if (configuredUrl.includes('cloudfunctions.net')) {
        const fnName = action === 'send-otp' ? 'sendOtp' : 'verifyOtp';
        return `${configuredUrl.replace(/\/$/, '')}/${fnName}`;
    }
    
    // 2. Localhost or explicit port
    if (configuredUrl.startsWith('http://') || configuredUrl.startsWith('https://')) {
        const cleanBase = configuredUrl.replace(/\/$/, '');
        return cleanBase.endsWith('/api') ? `${cleanBase}/${action}` : `${cleanBase}/api/${action}`;
    }

    // 3. Relative or empty URL -> /api/send-otp or /api/verify-otp
    const cleanBase = configuredUrl.replace(/\/$/, '');
    if (!cleanBase || cleanBase === '/api') {
        return `/api/${action}`;
    }
    return `${cleanBase}/${action}`;
}

function attachPhoneStepHandlers(onSuccessCb) {
    const phoneInput = document.getElementById('auth-phone');
    const sendBtn = document.getElementById('send-otp-btn');
    const phoneErrEl = document.getElementById('phone-error');
    const isTwilioMode = window.RAPIDALERT_CONFIG?.authMode === 'twilio';

    // ── Invisible reCAPTCHA setup (initialized for Firebase mode / fallback) ──────
    let recaptchaVerifier;
    try {
        let container = document.getElementById('recaptcha-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'recaptcha-container';
            document.body.appendChild(container);
        }
        recaptchaVerifier = new RecaptchaVerifier(auth, 'recaptcha-container', {
            size: 'invisible',
            callback: () => { /* reCAPTCHA solved */ },
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
            let useFirebaseFallback = false;

            if (isTwilioMode) {
                // ── TWILIO MODE: Call standalone OTP server ──────────────
                try {
                    const resp = await fetch(getOtpApiUrl('send-otp'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone: fullPhone }),
                    });
                    const data = await resp.json();
                    if (!resp.ok) throw new Error(data.error || 'Failed to send OTP');

                    otpSendCount++;
                    console.log('[CitizenAuth] Twilio OTP sent successfully.');
                    if (data.devCode) {
                        console.log('[CitizenAuth] Dev code:', data.devCode);
                        // Automatically pre-fill fallback code in browser to make it easy for testing
                        setTimeout(() => {
                            const codeInput = document.getElementById('auth-otp');
                            if (codeInput) {
                                codeInput.value = data.devCode;
                                // Trigger input event to enable verify button
                                codeInput.dispatchEvent(new Event('input'));
                            }
                        }, 500);
                    }
                } catch (twilioErr) {
                    console.warn('[CitizenAuth] Twilio OTP server offline, falling back to Firebase Auth:', twilioErr.message);
                    useFirebaseFallback = true;
                }
            }

            if (!isTwilioMode || useFirebaseFallback) {
                // ── FIREBASE MODE: Original signInWithPhoneNumber ────────
                if (useFirebaseFallback) {
                    // Update authMode dynamically so step 2 verification does standard Firebase verification
                    window.RAPIDALERT_CONFIG.authMode = 'firebase';
                }
                confirmationResult = await signInWithPhoneNumber(auth, fullPhone, recaptchaVerifier);
                otpSendCount++;
            }

            // Transition to OTP step
            const root = document.getElementById('app-root');
            if (root) {
                root.innerHTML = getOTPStepHTML(phoneRaw);
                attachOTPStepHandlers(onSuccessCb, fullPhone);
                const currentMode = window.RAPIDALERT_CONFIG?.authMode;
                if (currentMode !== 'twilio') {
                    setTimeout(() => devAutoFillOTP(fullPhone), 600);
                }
            }

        } catch (err) {
            console.error('[CitizenAuth] Send OTP error:', err.code || '', err.message);
            setPhoneLoading(false, sendBtn);

            const MSG = {
                'auth/invalid-phone-number': 'Invalid phone number format.',
                'auth/too-many-requests': 'Too many requests. Try again in a few minutes.',
                'auth/quota-exceeded': 'SMS quota exceeded. Try again later.',
                'auth/billing-not-enabled': 'SMS service not available. Please try again.',
                'auth/network-request-failed': 'Network error. Check internet connection.',
                'auth/captcha-check-failed': 'reCAPTCHA failed. Reload and try again.',
                'auth/missing-phone-number': 'Phone number is required.',
            };
            showPhoneError(MSG[err.code] || err.message || 'Error sending OTP.');
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

          <!-- SMS Open Code / WebOTP compatible input layout -->
          <div class="otp-input-container" style="position: relative; overflow: hidden; margin-bottom: 14px; height: 56px;">
            <!-- Hidden real input field targeting autofill / auto-reading -->
            <input
              type="tel"
              id="real-otp-input"
              maxlength="6"
              autocomplete="one-time-code"
              inputmode="numeric"
              pattern="[0-9]{6}"
              style="position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; z-index: 10; cursor: pointer;"
            />
            
            <!-- Visual boxes -->
            <div class="otp-boxes" id="otp-boxes" style="pointer-events: none;">
              ${[0, 1, 2, 3, 4, 5].map(i =>
        `<div class="otp-box" id="otp-box-visual-${i}"></div>`
    ).join('')}
            </div>
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
            const realInput = document.getElementById('real-otp-input');
            if (realInput) {
                realInput.value = latest.code;
                realInput.dispatchEvent(new Event('input'));
            }
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
    const realInput = document.getElementById('real-otp-input');
    const boxes = Array.from({ length: 6 }, (_, i) => document.getElementById(`otp-box-visual-${i}`));
    const verifyBtn = document.getElementById('verify-otp-btn');
    const otpErrEl = document.getElementById('otp-error');
    const resendBtn = document.getElementById('resend-btn');
    const timerEl = document.getElementById('resend-timer');
    const changeBtn = document.getElementById('change-phone-btn');

    // Focus the hidden real input to trigger mobile keyboard
    realInput?.focus();

    function updateVisualBoxes() {
        const val = realInput.value;
        boxes.forEach((box, i) => {
            if (box) {
                box.textContent = val[i] || '';
                // Highlight the active visual box
                const isActive = i === val.length || (i === 5 && val.length === 6);
                const isFocused = document.activeElement === realInput;
                
                if (isActive && isFocused) {
                    box.style.borderColor = 'var(--brand)';
                    box.style.backgroundColor = 'rgba(232, 65, 65, 0.08)';
                    box.style.boxShadow = '0 0 0 3px rgba(232, 65, 65, 0.15)';
                } else {
                    box.style.borderColor = 'var(--border)';
                    box.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
                    box.style.boxShadow = 'none';
                }
            }
        });
    }

    // Input listeners to sync state
    if (realInput) {
        realInput.addEventListener('input', () => {
            realInput.value = realInput.value.replace(/\D/g, '').slice(0, 6);
            updateVisualBoxes();
            if (realInput.value.length === 6) {
                verifyOTP();
            }
        });
        realInput.addEventListener('focus', updateVisualBoxes);
        realInput.addEventListener('blur', updateVisualBoxes);
    }
    
    // Initial visual state
    updateVisualBoxes();

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
        if (realInput) {
            realInput.value = '';
            updateVisualBoxes();
            realInput.focus();
        }

        // Resend OTP
        const isTwilioMode = window.RAPIDALERT_CONFIG?.authMode === 'twilio';
        try {
            if (isTwilioMode) {
                const resp = await fetch(getOtpApiUrl('send-otp'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: pendingPhone }),
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || 'Failed to resend OTP');
                if (data.devCode) console.log('[CitizenAuth] Dev resend code:', data.devCode);
            } else {
                const verifier = new RecaptchaVerifier(auth, 'resend-recaptcha', { size: 'invisible' });
                let tempDiv = document.getElementById('resend-recaptcha');
                if (!tempDiv) {
                    tempDiv = document.createElement('div');
                    tempDiv.id = 'resend-recaptcha';
                    document.getElementById('app-root').appendChild(tempDiv);
                }
                confirmationResult = await signInWithPhoneNumber(auth, pendingPhone, verifier);
            }
            otpSendCount++;
            startResendTimer();
        } catch (err) {
            console.error('[CitizenAuth] Resend OTP error:', err);
            showOTPError('Failed to resend OTP. Please reload and try again.');
        }
    });

    async function verifyOTP() {
        if (!realInput) return;
        const otp = realInput.value;
        if (otp.length < 6) { showOTPError('Enter all 6 digits.'); return; }

        setVerifyLoading(true);
        const isTwilioMode = window.RAPIDALERT_CONFIG?.authMode === 'twilio';

        try {
            let user;

            if (isTwilioMode) {
                // ── TWILIO MODE: Verify OTP via server, get Firebase custom token ──
                const resp = await fetch(getOtpApiUrl('verify-otp'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: fullPhone, code: otp }),
                });
                const data = await resp.json();
                if (!resp.ok) {
                    throw { code: 'auth/invalid-verification-code', message: data.error || 'Verification failed' };
                }

                // Sign into Firebase with the custom token from our OTP server
                const cred = await signInWithCustomToken(auth, data.token);
                user = cred.user;

                // Update user's phone number in their profile if not set
                console.log('[CitizenAuth] Twilio OTP verified, signed in as:', user.uid);

            } else {
                // ── FIREBASE MODE: Original confirm flow ──
                const result = await confirmationResult.confirm(otp);
                user = result.user;
            }

            clearInterval(resendTimer);

            // Upsert user document in Firestore
            const profile = await upsertCitizenProfile(user);
            onSuccessCb(profile);

        } catch (err) {
            console.error('[CitizenAuth] verify error:', err.code || '', err.message);
            setVerifyLoading(false);

            const MSG = {
                'auth/invalid-verification-code': 'Incorrect OTP. Check and try again.',
                'auth/code-expired': 'OTP has expired. Request a new one.',
                'auth/missing-verification-code': 'Enter the 6-digit OTP from your SMS.',
                'auth/too-many-requests': 'Too many attempts. Wait before trying again.',
            };
            showOTPError(MSG[err.code] || err.message || 'Verification failed.');
            realInput.value = '';
            updateVisualBoxes();
            realInput.focus();
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
        if (realInput) realInput.disabled = on;
    }
}


// ── Create / update citizen Firestore document ────────────────────────────────
async function upsertCitizenProfile(user) {
    const userRef = doc(db, 'users', user.uid);
    const userPhone = user.phoneNumber || pendingPhone; // pendingPhone is fallback for Twilio custom token mode
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
                phone: userPhone,
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
            phone: userPhone,
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
