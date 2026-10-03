/**
 * Login / licence helpers shared by the popup, dashboard, admin page and background worker (needs config.js).
 * The server re-checks that a customer is active on every call, so deactivating one locks them out at the
 * next check.
 */
const LICENSE_GRACE_MS = 24 * 60 * 60 * 1000; // keep working this long when the server can't be reached

async function apiFetch(path, { method = "GET", body } = {}) {
  const { authToken } = await chrome.storage.local.get("authToken");
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      // Free ngrok tunnels answer browser requests with a warning page unless this header is present.
      "ngrok-skip-browser-warning": "1",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Server error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function logout() {
  await chrome.storage.local.remove(["authToken", "authMobile", "authRole", "authExpiresAt", "licenseCheckedAt"]);
}

/**
 * Returns { ok, role, reason }. A 401/403 from the server logs the user out; if the server can't be reached,
 * the last successful check is trusted for LICENSE_GRACE_MS.
 */
async function checkLicense() {
  const { authToken, authRole, licenseCheckedAt = 0 } = await chrome.storage.local.get([
    "authToken",
    "authRole",
    "licenseCheckedAt",
  ]);
  if (!authToken) return { ok: false, reason: "Please log in from the extension popup (WA icon in the toolbar)." };

  try {
    const me = await apiFetch("/auth/me");
    await chrome.storage.local.set({ authRole: me.role, authExpiresAt: me.expiresAt || null, licenseCheckedAt: Date.now() });
    return { ok: true, role: me.role };
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      await logout();
      return { ok: false, reason: err.message };
    }
    if (Date.now() - licenseCheckedAt < LICENSE_GRACE_MS) return { ok: true, role: authRole };
    return { ok: false, reason: "Can't reach the licence server. Check your internet connection and try again." };
  }
}
