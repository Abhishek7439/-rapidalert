/* ============================================================
   RapidAlert – ui.js
   Shared UI functions: Toast, Modal, Login handler
   ============================================================ */

// ── Toast Notifications ────────────────────────────────────────────

/** Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'warning'|'info'} type
 * @param {number} duration ms (default 3500)
 */
function showToast(message, type = 'info', duration = 3500) {
    const icons = { success: '✅', error: '🚨', warning: '⚠️', info: 'ℹ️' };
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span>
                     <span class="toast-msg">${message}</span>`;
    container.appendChild(toast);

    // Auto-remove
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 350);
    }, duration);
}

// Make globally available
window.showToast = showToast;

// ── Confirmation Modal ─────────────────────────────────────────────

/**
 * Show a confirmation modal.
 * @param {Object} opts
 * @param {string} opts.icon  - Emoji for top icon
 * @param {string} opts.title
 * @param {string} opts.body  - HTML body content
 * @param {string} opts.confirmText
 * @param {string} opts.confirmClass - CSS class for confirm btn ('btn-primary'|'btn-danger')
 * @param {Function} opts.onConfirm - Callback on confirm
 */
function showModal({ icon = '⚠️', title, body, confirmText = 'Confirm', confirmClass = 'btn-primary', onConfirm }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'glob-modal';
    overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-icon">${icon}</div>
      <div class="modal-title">${title}</div>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="modal-cancel-btn">Cancel</button>
        <button class="btn ${confirmClass}" id="modal-confirm-btn">${confirmText}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#modal-cancel-btn').onclick = close;
    overlay.querySelector('#modal-confirm-btn').onclick = () => { close(); onConfirm && onConfirm(); };
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

window.showModal = showModal;

// ── Login Page Handler ─────────────────────────────────────────────

function initLoginPage() {
    const form = document.getElementById('login-form');
    const emailEl = document.getElementById('login-email');
    const passEl = document.getElementById('login-password');
    const errorEl = document.getElementById('login-error');
    const submitBtn = document.getElementById('login-btn');

    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.style.display = 'none';
        submitBtn.textContent = 'Logging in…';
        submitBtn.disabled = true;

        try {
            const admin = await App.API.login(emailEl.value.trim(), passEl.value);
            App.login(admin);
        } catch (err) {
            errorEl.textContent = err.message;
            errorEl.style.display = 'block';
            submitBtn.textContent = 'Login';
            submitBtn.disabled = false;
        }
    });
}

window.initLoginPage = initLoginPage;
