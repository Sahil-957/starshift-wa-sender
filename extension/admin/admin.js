const el = (id) => document.getElementById(id);

const DAY_MS = 24 * 60 * 60 * 1000;
let customers = []; // { mobile, name, active, hasPassword, planMonths, expiresAt, createdAt, lastLoginAt }

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function customerLabel(user) {
  return user.name ? `${user.name} (+${user.mobile})` : `+${user.mobile}`;
}

function showPassword(user, password) {
  el("password-for").textContent = customerLabel(user);
  el("password-value").textContent = password;
  el("btn-copy-password").textContent = "Copy";
  el("password-box").classList.remove("hidden");
}

function showActivationLink(user, link) {
  el("activation-for").textContent = customerLabel(user);
  el("activation-value").textContent = link;
  el("btn-copy-activation").textContent = "Copy link";
  el("activation-box").classList.remove("hidden");
}

function statusBadge(user) {
  if (!user.active) return '<span class="status-badge status-cancelled">Inactive</span>';
  if (user.expiresAt && Date.parse(user.expiresAt) <= Date.now()) {
    return '<span class="status-badge status-failed">Expired</span>';
  }
  return '<span class="status-badge status-completed">Active</span>';
}

function validityCell(user) {
  if (!user.expiresAt) return "No limit";
  const date = esc(new Date(user.expiresAt).toLocaleDateString());
  const days = Math.ceil((Date.parse(user.expiresAt) - Date.now()) / DAY_MS);
  if (days <= 0) return `${date} <span class="ended">(ended)</span>`;
  const left = `${days} day${days === 1 ? "" : "s"} left`;
  return `${date} <span class="${days <= 7 ? "expiring" : "days-left"}">(${left})</span>`;
}

async function loadCustomers() {
  customers = (await apiFetch("/admin/users")).users;
  renderCustomers();
}

function renderCustomers() {
  const query = el("search-customers").value.trim().toLowerCase();
  const rows = customers.filter((u) => `${u.name || ""} ${u.mobile}`.toLowerCase().includes(query));
  el("customer-count").textContent = customers.length;

  el("customers-body").innerHTML = rows.length
    ? rows
        .map((u) => {
          const mobile = esc(u.mobile);
          const noPassword = u.hasPassword ? "" : ' <span class="status-badge status-scheduled">No password</span>';
          return `
            <tr>
              <td>${esc(u.name || "-")}</td>
              <td>+${mobile}</td>
              <td>${statusBadge(u)}${noPassword}</td>
              <td>${validityCell(u)}</td>
              <td>${u.lastLoginAt ? esc(new Date(u.lastLoginAt).toLocaleString()) : "-"}</td>
              <td class="actions">
                <button type="button" class="btn-secondary" data-action="toggle" data-mobile="${mobile}">${u.active ? "Deactivate" : "Activate"}</button>
                <select class="renew" data-renew="${mobile}" aria-label="Renew plan">
                  <option value="">Renew...</option>
                  <option value="1">+1 month</option>
                  <option value="3">+3 months</option>
                  <option value="6">+6 months</option>
                  <option value="12">+12 months</option>
                </select>
                <button type="button" class="btn-secondary" data-action="link" data-mobile="${mobile}">Activation link</button>
                <button type="button" class="btn-secondary" data-action="password" data-mobile="${mobile}">Reset password</button>
                <button type="button" class="btn-secondary danger" data-action="delete" data-mobile="${mobile}">Delete</button>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="hint">${customers.length ? "No matches." : "No customers yet."}</td></tr>`;
}

el("search-customers").addEventListener("input", renderCustomers);

el("btn-logout").addEventListener("click", async () => {
  await logout();
  location.href = "../dashboard/dashboard.html";
});

el("btn-add-customer").addEventListener("click", async () => {
  el("admin-error").textContent = "";
  const btn = el("btn-add-customer");
  btn.disabled = true;
  try {
    const { user, password } = await apiFetch("/admin/users", {
      method: "POST",
      body: {
        name: el("new-name").value,
        mobile: el("new-mobile").value,
        months: Number(el("new-plan").value),
        password: el("new-password").value.trim(),
      },
    });
    showPassword(user, password);
    if (user.activationLink) showActivationLink(user, user.activationLink);
    ["new-name", "new-mobile", "new-password"].forEach((id) => (el(id).value = ""));
    await loadCustomers();
  } catch (err) {
    el("admin-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

el("btn-copy-password").addEventListener("click", async () => {
  await navigator.clipboard.writeText(el("password-value").textContent);
  el("btn-copy-password").textContent = "Copied";
});

el("btn-copy-activation").addEventListener("click", async () => {
  await navigator.clipboard.writeText(el("activation-value").textContent);
  el("btn-copy-activation").textContent = "Copied";
});

el("customers-body").addEventListener("change", async (e) => {
  const select = e.target.closest("select[data-renew]");
  if (!select?.value) return;
  const months = Number(select.value);
  const user = customers.find((u) => u.mobile === select.dataset.renew);
  select.value = "";
  if (!user) return;
  if (!confirm(`Extend ${customerLabel(user)}'s validity by ${months} month(s)? This also activates the account.`)) return;

  el("admin-error").textContent = "";
  try {
    await apiFetch(`/admin/users/${user.mobile}/renew`, { method: "POST", body: { months } });
    await loadCustomers();
  } catch (err) {
    el("admin-error").textContent = err.message;
  }
});

el("customers-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const user = customers.find((u) => u.mobile === btn.dataset.mobile);
  if (!user) return;
  const label = customerLabel(user);
  el("admin-error").textContent = "";

  try {
    if (btn.dataset.action === "toggle") {
      await apiFetch(`/admin/users/${user.mobile}`, { method: "PATCH", body: { active: !user.active } });
    } else if (btn.dataset.action === "link") {
      // An existing link keeps working, so it is only replaced when the admin asks for a new one.
      const replace =
        user.activationLink &&
        confirm(
          `${label} already has an activation link.\n\nOK - make a NEW link (the old one stops working).\nCancel - show the current one.`
        );
      const link =
        !user.activationLink || replace
          ? (await apiFetch(`/admin/users/${user.mobile}/activation`, { method: "POST" })).activationLink
          : user.activationLink;
      showActivationLink(user, link);
      await navigator.clipboard.writeText(link).catch(() => {});
    } else if (btn.dataset.action === "password") {
      const typed = prompt(
        `New password for ${label}.\nLeave blank to generate one. The old password stops working and they are logged out.`
      );
      if (typed === null) return;
      const { password } = await apiFetch(`/admin/users/${user.mobile}/password`, {
        method: "POST",
        body: { password: typed.trim() },
      });
      showPassword(user, password);
    } else if (btn.dataset.action === "delete") {
      if (!confirm(`Delete ${label}? They will no longer be able to log in.`)) return;
      await apiFetch(`/admin/users/${user.mobile}`, { method: "DELETE" });
    }
    await loadCustomers();
  } catch (err) {
    el("admin-error").textContent = err.message;
  }
});

(async () => {
  const license = await checkLicense();
  if (!license.ok || license.role !== "admin") {
    el("locked-reason").textContent = license.ok ? "This page is only for the admin account." : license.reason;
    el("locked").classList.remove("hidden");
    return;
  }
  const { authMobile } = await chrome.storage.local.get("authMobile");
  el("admin-as").textContent = `Admin +${authMobile}`;
  el("admin-content").classList.remove("hidden");
  try {
    await loadCustomers();
  } catch (err) {
    el("admin-error").textContent = err.message;
  }
})();
