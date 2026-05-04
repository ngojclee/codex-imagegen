import { buildManagementRequestInit } from "./management-request.js";

const loginView = document.querySelector("#loginView");
const disabledView = document.querySelector("#disabledView");
const appView = document.querySelector("#appView");
const loginForm = document.querySelector("#loginForm");
const loginMessage = document.querySelector("#loginMessage");
const importForm = document.querySelector("#importForm");
const importMessage = document.querySelector("#importMessage");
const oauthCompleteForm = document.querySelector("#oauthCompleteForm");
const oauthMessage = document.querySelector("#oauthMessage");
const oauthUrl = document.querySelector("#oauthUrl");
const callbackUrl = document.querySelector("#callbackUrl");
const accountsEl = document.querySelector("#accounts");
const tabButtons = document.querySelectorAll("[data-auth-tab]");
const tabPanels = document.querySelectorAll("[data-auth-panel]");

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

function setAuthTab(tab) {
  tabButtons.forEach((button) => {
    const selected = button.dataset.authTab === tab;
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.authPanel !== tab;
  });
}

async function request(url, options = {}) {
  const res = await fetch(url, buildManagementRequestInit(options));
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
    accountsEl.innerHTML = '<div class="empty-state">No imported accounts yet.</div>';
    return;
  }

  accountsEl.replaceChildren(...accounts.map((account) => {
    const status = normalizeStatus(account.status);
    const row = document.createElement("div");
    row.className = `account ${status}`;
    row.innerHTML = `
      <div class="account-avatar" aria-hidden="true">${escapeHtml(accountInitial(account))}</div>
      <div>
        <div class="account-title">
          <strong>${escapeHtml(account.email || account.display_id)}</strong>
          <span class="badge ${status}">${escapeHtml(account.status)}</span>
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

function normalizeStatus(status) {
  return ["healthy", "cooldown", "dead"].includes(status) ? status : "unknown";
}

function accountInitial(account) {
  const value = account.email || account.display_id || "?";
  return value.trim().charAt(0).toUpperCase() || "?";
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

tabButtons.forEach((button) => {
  button.addEventListener("click", () => setAuthTab(button.dataset.authTab));
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

document.querySelector("#oauthStartBtn").addEventListener("click", async () => {
  setMessage(oauthMessage, "Creating login link...");
  try {
    const result = await request("/management/api/oauth/start", { method: "POST" });
    oauthUrl.value = result.authorize_url;
    setMessage(oauthMessage, `Login link ready. Expires in ${result.expires_in_seconds}s.`, "ok");
  } catch (err) {
    setMessage(oauthMessage, err.message, "error");
  }
});

document.querySelector("#copyOauthBtn").addEventListener("click", async () => {
  if (!oauthUrl.value) return setMessage(oauthMessage, "Create a login link first.", "error");
  await navigator.clipboard.writeText(oauthUrl.value);
  setMessage(oauthMessage, "Login URL copied.", "ok");
});

document.querySelector("#openOauthBtn").addEventListener("click", () => {
  if (!oauthUrl.value) return setMessage(oauthMessage, "Create a login link first.", "error");
  window.open(oauthUrl.value, "_blank", "noopener,noreferrer");
});

oauthCompleteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = oauthCompleteForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  setMessage(oauthMessage, "Exchanging callback code...");
  try {
    const result = await request("/management/api/oauth/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_url: callbackUrl.value }),
    });
    setMessage(oauthMessage, `OAuth login imported: ${result.result.status}`, "ok");
    callbackUrl.value = "";
    await loadAccounts();
  } catch (err) {
    setMessage(oauthMessage, err.message, "error");
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
