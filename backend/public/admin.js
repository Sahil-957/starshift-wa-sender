const $ = (id) => document.getElementById(id);
const token = sessionStorage.getItem("starshiftToken") || "";
async function api(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
  return data;
}
function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
const dateLabel = (value) => value ? new Date(value).toLocaleDateString() : "No expiry";
async function loadCustomers() {
  $("page-error").textContent = "";
  try {
    const { users } = await api("/admin/users");
    $("customer-count").textContent = `${users.length} account(s)`;
    $("customers").innerHTML = users.length ? users.map((u) => `<tr><td><b>${esc(u.name || "Customer")}</b><br><span class="muted">+${esc(u.mobile)}</span></td><td>${dateLabel(u.expiresAt)}</td><td><span class="pill ${u.active ? "active" : ""}">${u.active ? "Active" : "Inactive"}</span></td><td><div class="actions"><button data-activation="${esc(u.mobile)}">Copy activation link</button><button data-renew="${esc(u.mobile)}">Renew</button><button data-toggle="${esc(u.mobile)}" data-active="${u.active}">${u.active ? "Deactivate" : "Activate"}</button><button data-password="${esc(u.mobile)}">Reset password</button><button data-delete="${esc(u.mobile)}" class="danger">Delete</button></div></td></tr>`).join("") : `<tr><td colspan="4">No customers yet.</td></tr>`;
    bindActions(users);
  } catch (error) { $("page-error").textContent = error.message; }
}
function bindActions(users) {
  $("customers").querySelectorAll("[data-activation]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const user = users.find((u) => u.mobile === button.dataset.activation);
      let link = user?.activationLink;
      if (!link) link = (await api(`/admin/users/${button.dataset.activation}/activation`, "POST", {})).activationLink;
      await navigator.clipboard.writeText(link); button.textContent = "Copied";
    } catch (error) { alert(error.message); }
  }));
  $("customers").querySelectorAll("[data-renew]").forEach((button) => button.addEventListener("click", async () => {
    const months = Number(prompt("Renew by how many months? Enter 1, 3, 6, or 12."));
    if (![1, 3, 6, 12].includes(months)) return;
    try { await api(`/admin/users/${button.dataset.renew}/renew`, "POST", { months }); await loadCustomers(); } catch (error) { alert(error.message); }
  }));
  $("customers").querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", async () => {
    try { await api(`/admin/users/${button.dataset.toggle}`, "PATCH", { active: button.dataset.active !== "true" }); await loadCustomers(); } catch (error) { alert(error.message); }
  }));
  $("customers").querySelectorAll("[data-password]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Reset this customer's password? The current password will stop working.")) return;
    try { const { password } = await api(`/admin/users/${button.dataset.password}/password`, "POST", {}); alert(`New password: ${password}`); } catch (error) { alert(error.message); }
  }));
  $("customers").querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm(`Permanently delete customer +${button.dataset.delete}?`)) return;
    try { await api(`/admin/users/${button.dataset.delete}`, "DELETE"); await loadCustomers(); } catch (error) { alert(error.message); }
  }));
}
$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("create-status").textContent = "Creating account…"; $("created-result").classList.add("hidden");
  try {
    const { user, password } = await api("/admin/users", "POST", { name: $("new-name").value.trim(), mobile: $("new-mobile").value.replace(/\D/g, ""), months: Number($("new-months").value) });
    $("create-status").textContent = "Customer created. Share the activation link and temporary password securely.";
    $("created-result").innerHTML = `<b>${esc(user.name || "Customer")} · +${esc(user.mobile)}</b><br>Temporary password: <code>${esc(password)}</code><br>Activation link: <a href="${esc(user.activationLink)}">${esc(user.activationLink)}</a>`;
    $("created-result").classList.remove("hidden"); $("create-form").reset(); await loadCustomers();
  } catch (error) { $("create-status").textContent = error.message; }
});
$("refresh").addEventListener("click", loadCustomers);
$("logout").addEventListener("click", () => { sessionStorage.removeItem("starshiftToken"); location.href = "/app"; });
api("/auth/me").then((me) => {
  if (me.role !== "admin") throw new Error("Admin access required.");
  $("admin-label").textContent = `+${me.mobile}`; $("admin-view").classList.remove("hidden"); loadCustomers();
}).catch(() => $("denied").classList.remove("hidden"));
