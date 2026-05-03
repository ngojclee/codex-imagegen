const loginView = document.querySelector("#loginView");
const disabledView = document.querySelector("#disabledView");
const appView = document.querySelector("#appView");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");
const importForm = document.querySelector("#importForm");
const importMessage = document.querySelector("#importMessage");
const accountsEl = document.querySelector("#accounts");

const stats = {
  total: document.querySelector("#statTotal"),
  healthy: document.querySelector("#statHealthy"),
  cooldown: document.querySelector("#statCooldown"),
  dead: document.querySelector("#statDead"),
};

function show(view) {
  loginView.hidden = view !== "login";
  disabledView.hidden = view !== "disabled";
  appView.hidden = view !== "app";
}

function setMessage(el, text, type = "") {
  el.textContent = text;
  el.className = `message ${type}`.trim();
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "accept": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  return data;
}

async function boot() {
  const session = await request("/management/api/session");
  if (!session.enabled) return show("disabled");
  if (!session.authenticated) return show("login");
  show("app");
  await loadAccounts();
}

async function loadAccounts() {
  const data = await request("/management/api/accounts");
  stats.total.textContent = data.stats.total;
  stats.healthy.textContent = data.stats.healthy;
  stats.cooldown.textContent = data.stats.cooldown;
  stats.dead.textContent = data.stats.dead;
  document.querySelector("#lastUpdated").textContent = new Date().toLocaleTimeString();
  renderAccounts(data.accounts);
}

function renderAccounts(accounts) {
  if (!accounts.length) {
    accountsEl.innerHTML = '<p class="muted">No imported accounts yet.</p>';
    return;
  }

  accountsEl.replaceChildren(...accounts.map((account) => {
    const row = document.createElement("div");
    row.className = "account";
    row.innerHTML = `
      <div>
        <div class="account-title">
          <strong>${escapeHtml(account.email || account.display_id)}</strong>
          <span class="badge ${account.status}">${account.status}</span>
        </div>
        <div class="account-meta">
          ID: ${escapeHtml(account.display_id)}<br />
          Uses: ${account.use_count} · Last used: ${escapeHtml(account.last_used_at || "never")}<br />
          ${account.cooldown_seconds_left ? `Cooldown: ${account.cooldown_seconds_left}s<br />` : ""}
          ${account.dead_reason ? `Reason: ${escapeHtml(account.dead_reason)}` : ""}
        </div>
      </div>
      <div class="account-actions">
        <button type="button" data-action="revive">Revive</button>
        <button type="button" class="danger" data-action="delete">Delete</button>
      </div>
    `;
    row.querySelector('[data-action="revive"]').addEventListener("click", () => revive(account.id));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => remove(account.id));
    return row;
  }));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function revive(id) {
  await request(`/management/api/accounts/${encodeURIComponent(id)}/revive`, { method: "POST" });
  await loadAccounts();
}

async function remove(id) {
  if (!confirm("Remove this auth account from the pool?")) return;
  await request(`/management/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadAccounts();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#password").value;
  setMessage(loginMessage, "Signing in...");
  try {
    await request("/management/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    show("app");
    await loadAccounts();
  } catch (err) {
    setMessage(loginMessage, err.message, "error");
  }
});

importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = importForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  setMessage(importMessage, "Importing...");
  try {
    const form = new FormData(importForm);
    const result = await request("/management/api/import", { method: "POST", body: form });
    setMessage(importMessage, `Imported: ${result.result.status}`, "ok");
    document.querySelector("#authJson").value = "";
    document.querySelector("#authFile").value = "";
    await loadAccounts();
  } catch (err) {
    setMessage(importMessage, err.message, "error");
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#refreshBtn").addEventListener("click", loadAccounts);
document.querySelector("#harvestBtn").addEventListener("click", async () => {
  await request("/management/api/harvest", { method: "POST" });
  await loadAccounts();
});
document.querySelector("#logoutBtn").addEventListener("click", async () => {
  await request("/management/api/logout", { method: "POST" });
  show("login");
});

boot().catch((err) => {
  show("login");
  setMessage(loginMessage, err.message, "error");
});
