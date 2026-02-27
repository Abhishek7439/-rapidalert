/**
 * auth.js – Admin Panel Authentication  (ES Module)
 * ====================================================
 * PERMANENT FIX (competition version):
 *   - NO Firestore reads inside the login try/catch
 *   - App.login + App.startListeners called OUTSIDE try/catch
 *   - Hardcoded UID bypass for master admin account
 *   - All Firestore errors are SILENT (logged only, never shown to user)
 */

import {
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged,
    getIdTokenResult,
} from 'https://www.gstatic.com/firebasejs/10.12.1/firebase-auth.js';

const { auth } = window.FB;

// Master admin hardcoded credentials — permanent bypass for competition
const MASTER_ADMIN_UID = 'zBEtvzRc0UgoL54uNTNlWs3BYYj1';
const MASTER_ADMIN_EMAIL = 'admin@rapidalert.com';

const ADMIN_ROLES = ['district_officer', 'super_admin'];

// ── Helper: build adminData from a Firebase user ──────────────────────────────
function buildAdminData(user, role) {
    return {
        uid: user.uid,
        email: user.email,
        name: user.displayName || user.email.split('@')[0],
        role: role,
        district: null,
    };
}

// ── Helper: activate the admin shell (NEVER throws) ──────────────────────────
function activateAdminShell(adminData) {
    try {
        if (window.App) {
            App.login(adminData);
            // Start listeners in a microtask so ANY listener errors never reach the login UI
            setTimeout(() => {
                try { App.startListeners(adminData.district); } catch (e) { console.warn('[Auth] Listener start error:', e); }
            }, 0);
        }
    } catch (e) {
        console.error('[Auth] Shell activation error:', e);
    }
}

// ── onAuthStateChanged — page-reload session restoration ─────────────────────
onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
        const loginPage = document.getElementById('login-page');
        const shell = document.getElementById('app-shell');
        if (loginPage) loginPage.style.display = 'flex';
        if (shell) shell.style.display = 'none';
        return;
    }

    // Determine role — master admin bypass first
    let role = 'citizen';
    if (firebaseUser.uid === MASTER_ADMIN_UID || firebaseUser.email === MASTER_ADMIN_EMAIL) {
        role = 'super_admin';
    } else {
        try {
            const tok = await getIdTokenResult(firebaseUser, true);
            role = tok.claims.role || 'citizen';
        } catch (_) { /* silent */ }
    }

    if (!ADMIN_ROLES.includes(role)) {
        await signOut(auth).catch(() => { });
        showLoginError('Access denied. Admin role required.');
        return;
    }

    activateAdminShell(buildAdminData(firebaseUser, role));
});

// ── Login form handler ────────────────────────────────────────────────────────
function initAdminLoginPage() {
    const form = document.getElementById('login-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearLoginError();
        setLoginLoading(true);

        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;

        if (!email || !password) {
            showLoginError('Email and password are required.');
            setLoginLoading(false);
            return;
        }

        // ── STEP 1: Firebase Auth sign-in (only thing in try/catch) ──────────
        let user;
        try {
            const cred = await signInWithEmailAndPassword(auth, email, password);
            user = cred.user;
        } catch (err) {
            setLoginLoading(false);
            const MSG = {
                'auth/wrong-password': 'Incorrect password.',
                'auth/user-not-found': 'No account found with this email.',
                'auth/invalid-email': 'Please enter a valid email address.',
                'auth/invalid-credential': 'Invalid email or password.',
                'auth/too-many-requests': 'Too many attempts. Try again later.',
                'auth/user-disabled': 'Account is disabled.',
                'auth/network-request-failed': 'Network error. Check your connection.',
            };
            showLoginError(MSG[err.code] || `Sign-in failed: ${err.message}`);
            return;
        }

        // ── STEP 2: Determine role — NEVER throws ─────────────────────────────
        let role = 'citizen';
        if (user.uid === MASTER_ADMIN_UID || user.email === MASTER_ADMIN_EMAIL) {
            // Hardcoded master admin — instant access
            role = 'super_admin';
            console.log('[Auth] Master admin bypass activated.');
        } else {
            // Try custom claims
            try {
                const tok = await getIdTokenResult(user, true);
                role = tok.claims.role || 'citizen';
            } catch (_) { /* silent fallback */ }
        }

        if (!ADMIN_ROLES.includes(role)) {
            await signOut(auth).catch(() => { });
            setLoginLoading(false);
            showLoginError('Access denied. Your account does not have admin privileges.');
            return;
        }

        // ── STEP 3: Activate shell — completely outside try/catch ─────────────
        console.log('[Auth] Login successful. Role:', role, '| Email:', user.email);
        setLoginLoading(false);
        activateAdminShell(buildAdminData(user, role));
    });
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function adminLogout() {
    try { if (window.App) App.detachAllListeners(); } catch (_) { }
    try { await signOut(auth); } catch (_) { }
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function showLoginError(msg) {
    const el = document.getElementById('login-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function clearLoginError() {
    const el = document.getElementById('login-error');
    if (el) { el.textContent = ''; el.style.display = 'none'; }
}
function setLoginLoading(loading) {
    const btn = document.getElementById('login-btn');
    const eml = document.getElementById('login-email');
    const pass = document.getElementById('login-password');
    if (btn) { btn.disabled = loading; btn.textContent = loading ? 'Signing in…' : 'Login →'; }
    if (eml) eml.disabled = loading;
    if (pass) pass.disabled = loading;
}

window.initAdminLoginPage = initAdminLoginPage;
window.adminLogout = adminLogout;
