/**
 * AuthPool — rotate through a pool of Codex OAuth accounts.
 *
 * Responsibilities:
 *   - Harvest fresh logins from ~/.codex/auth.json into the internal
 *     store (~/.codex-imagegen/accounts/<account_id>.json) whenever
 *     the Codex CLI writes a new login (fs.watch + polling fallback).
 *   - Maintain per-account state: healthy | cooldown | dead.
 *   - Rotate healthy accounts in LRU order.
 *   - Mark cooldown on 429/403, dead when the refresh_token is revoked.
 *   - Append events to a JSONL log for postmortem debugging.
 */
import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import path from "node:path";
import { parseAuthJson, readAuth } from "./auth.mjs";

const DEFAULT_COOLDOWN_MS = 60_000;
const POLL_INTERVAL_MS = 30_000;
const WATCH_DEBOUNCE_MS = 500;

export class NoHealthyAccountsError extends Error {
  constructor(stats) {
    const base =
      stats.total === 0
        ? "No codex accounts in pool."
        : `All ${stats.total} codex accounts unavailable (${stats.dead} dead, ${stats.cooldown} in cooldown).`;
    super(`${base} Run 'codex auth login' to add a fresh account.`);
    this.name = "NoHealthyAccountsError";
    this.stats = stats;
    this.status = 503;
  }
}

function base64UrlDecode(input) {
  const padded = input.padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    "=",
  );
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf8",
  );
}

function extractEmail(auth) {
  const idToken = auth.authJson?.tokens?.id_token;
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload.email || null;
  } catch {
    return null;
  }
}

function sanitizeFileId(accountId) {
  return accountId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class AuthPool {
  constructor(config) {
    this.config = config;
    this.accountsDir = config.accountsDir;
    this.eventsLogPath = config.eventsLogPath;
    this.cooldownDefaultMs = config.cooldownDefaultMs || DEFAULT_COOLDOWN_MS;

    // account_id → {id, filePath, status, cooldownUntil, deadReason,
    //               lastUsedAt, addedAt, email, useCount}
    this.accounts = new Map();

    // LRU queue of account_ids. Front = oldest used.
    this.queue = [];

    this._watcher = null;
    this._poller = null;
    this._watchDebounce = null;
    this._harvestPending = false;
  }

  async init() {
    await mkdir(this.accountsDir, { recursive: true });
    await mkdir(path.dirname(this.eventsLogPath), { recursive: true });
    await this._scan();

    // First-run convenience: if the pool is empty, auto-harvest
    // whatever the user's Codex CLI currently has.
    if (this.accounts.size === 0) {
      await this.harvestFromCodex({ silent: true }).catch(() => {});
    }

    this._startWatcher();
    this._startPoller();
  }

  async stop() {
    if (this._watcher) {
      try { this._watcher.close(); } catch {}
      this._watcher = null;
    }
    if (this._watchDebounce) {
      clearTimeout(this._watchDebounce);
      this._watchDebounce = null;
    }
    if (this._poller) {
      clearInterval(this._poller);
      this._poller = null;
    }
  }

  // ─── Scanning / harvesting ────────────────────────────────────────────────

  async _scan() {
    const entries = await readdir(this.accountsDir).catch(() => []);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(this.accountsDir, name);
      try {
        const auth = await readAuth(filePath);
        const id = auth.accountId;
        if (!id || this.accounts.has(id)) continue;
        this.accounts.set(id, {
          id,
          filePath,
          status: "healthy",
          cooldownUntil: 0,
          deadReason: null,
          lastUsedAt: 0,
          addedAt: Date.now(),
          email: extractEmail(auth),
          useCount: 0,
        });
        this.queue.push(id);
      } catch (err) {
        console.warn(`[pool] Ignoring invalid account file ${filePath}: ${err.message}`);
      }
    }
    console.log(`[pool] Scanned ${this.accounts.size} account(s) from ${this.accountsDir}`);
  }

  /**
   * Copy the Codex CLI's auth.json into the pool (if new / changed).
   * Called on startup, on fs.watch events, on the poll interval, and by
   * the /admin/harvest endpoint.
   */
  async harvestFromCodex(opts = {}) {
    if (this._harvestPending) return { status: "already_running" };
    this._harvestPending = true;
    try {
      if (!existsSync(this.config.authPath)) {
        return { status: "no_source", path: this.config.authPath };
      }

      const sourceRaw = await readFile(this.config.authPath, "utf8");
      let auth;
      try {
        auth = await readAuth(this.config.authPath);
      } catch (err) {
        return { status: "invalid_source", reason: err.message };
      }
      const id = auth.accountId;
      if (!id) return { status: "invalid_source", reason: "no account_id" };

      const email = extractEmail(auth);
      const targetPath = path.join(this.accountsDir, `${sanitizeFileId(id)}.json`);

      if (existsSync(targetPath)) {
        const targetRaw = await readFile(targetPath, "utf8");
        if (targetRaw === sourceRaw) {
          return { status: "unchanged", account_id: id };
        }
        await writeFile(targetPath, sourceRaw, { mode: 0o600 });
        this._logEvent("harvest_update", { account_id: id, email });

        const existing = this.accounts.get(id);
        if (existing && existing.status === "dead") {
          // A fresh login means a fresh refresh_token — give it another chance.
          existing.status = "healthy";
          existing.deadReason = null;
          this._logEvent("revive_on_harvest", { account_id: id });
        }
        if (!opts.silent) console.log(`[pool] Harvested update: ${id} (${email || "no-email"})`);
        return { status: "updated", account_id: id };
      }

      await writeFile(targetPath, sourceRaw, { mode: 0o600 });
      this.accounts.set(id, {
        id,
        filePath: targetPath,
        status: "healthy",
        cooldownUntil: 0,
        deadReason: null,
        lastUsedAt: 0,
        addedAt: Date.now(),
        email,
        useCount: 0,
      });
      this.queue.push(id);
      this._logEvent("harvest_new", { account_id: id, email });
      if (!opts.silent) console.log(`[pool] Harvested new account: ${id} (${email || "no-email"})`);
      return { status: "added", account_id: id };
    } finally {
      this._harvestPending = false;
    }
  }

  async importAuthJson(authJson) {
    const auth = parseAuthJson(authJson, "<management-import>");
    const id = auth.accountId;
    if (!id) return { status: "invalid_source", reason: "no account_id" };

    const email = extractEmail(auth);
    const targetPath = path.join(this.accountsDir, `${sanitizeFileId(id)}.json`);
    const raw = `${JSON.stringify(authJson, null, 2)}\n`;

    if (existsSync(targetPath)) {
      const existingRaw = await readFile(targetPath, "utf8");
      if (existingRaw === raw) {
        return { status: "unchanged", account_id: id, email };
      }

      await writeFile(targetPath, raw, { mode: 0o600 });
      const existing = this.accounts.get(id);
      if (existing) {
        existing.status = "healthy";
        existing.cooldownUntil = 0;
        existing.deadReason = null;
        existing.email = email;
      }
      this._logEvent("import_update", { account_id: id, email });
      return { status: "updated", account_id: id, email };
    }

    await writeFile(targetPath, raw, { mode: 0o600 });
    this.accounts.set(id, {
      id,
      filePath: targetPath,
      status: "healthy",
      cooldownUntil: 0,
      deadReason: null,
      lastUsedAt: 0,
      addedAt: Date.now(),
      email,
      useCount: 0,
    });
    this.queue.push(id);
    this._logEvent("import_new", { account_id: id, email });
    return { status: "added", account_id: id, email };
  }

  _startWatcher() {
    if (!existsSync(this.config.authPath)) {
      console.log(
        `[pool] Source auth file not found at ${this.config.authPath}; watcher idle until file appears (poller will retry).`,
      );
      return;
    }
    try {
      this._watcher = watch(this.config.authPath, (eventType) => {
        if (eventType !== "change" && eventType !== "rename") return;
        if (this._watchDebounce) clearTimeout(this._watchDebounce);
        this._watchDebounce = setTimeout(() => {
          this.harvestFromCodex().catch((err) => {
            console.warn(`[pool] Auto-harvest failed: ${err.message}`);
          });
        }, WATCH_DEBOUNCE_MS);
      });
    } catch (err) {
      console.warn(`[pool] fs.watch failed: ${err.message} — relying on poller.`);
    }
  }

  _startPoller() {
    this._poller = setInterval(() => {
      this.harvestFromCodex().catch(() => {});
    }, POLL_INTERVAL_MS);
    this._poller.unref?.();
  }

  // ─── Rotation ──────────────────────────────────────────────────────────────

  /**
   * Pick next healthy account (LRU). Revives cooldown accounts whose TTL
   * has expired. Returns null if no healthy account is available.
   */
  getNext(excludeIds = new Set()) {
    const now = Date.now();

    for (const acc of this.accounts.values()) {
      if (acc.status === "cooldown" && acc.cooldownUntil <= now) {
        acc.status = "healthy";
        acc.cooldownUntil = 0;
        this._logEvent("cooldown_expired", { account_id: acc.id });
      }
    }

    for (let i = 0; i < this.queue.length; i++) {
      const id = this.queue[i];
      if (excludeIds.has(id)) continue;
      const acc = this.accounts.get(id);
      if (!acc || acc.status !== "healthy") continue;

      this.queue.splice(i, 1);
      this.queue.push(id);
      acc.lastUsedAt = now;
      acc.useCount++;
      return acc;
    }
    return null;
  }

  markCooldown(accountId, ttlMs, reason) {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    acc.status = "cooldown";
    acc.cooldownUntil = Date.now() + ttlMs;
    this._logEvent("mark_cooldown", { account_id: accountId, ttl_ms: ttlMs, reason });
  }

  markDead(accountId, reason) {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    acc.status = "dead";
    acc.deadReason = reason;
    this._logEvent("mark_dead", { account_id: accountId, reason });
  }

  revive(accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc) return false;
    acc.status = "healthy";
    acc.cooldownUntil = 0;
    acc.deadReason = null;
    this._logEvent("manual_revive", { account_id: accountId });
    return true;
  }

  async remove(accountId) {
    const acc = this.accounts.get(accountId);
    if (!acc) return false;
    try { await unlink(acc.filePath); } catch {}
    this.accounts.delete(accountId);
    this.queue = this.queue.filter((id) => id !== accountId);
    this._logEvent("remove", { account_id: accountId });
    return true;
  }

  // ─── Introspection ─────────────────────────────────────────────────────────

  list() {
    const now = Date.now();
    return [...this.accounts.values()].map((a) => ({
      id: a.id,
      email: a.email,
      status: a.status,
      cooldown_seconds_left:
        a.status === "cooldown"
          ? Math.max(0, Math.ceil((a.cooldownUntil - now) / 1000))
          : null,
      dead_reason: a.deadReason,
      use_count: a.useCount,
      last_used_at: a.lastUsedAt > 0 ? new Date(a.lastUsedAt).toISOString() : null,
      added_at: new Date(a.addedAt).toISOString(),
    }));
  }

  stats() {
    const stats = { total: this.accounts.size, healthy: 0, cooldown: 0, dead: 0 };
    for (const acc of this.accounts.values()) stats[acc.status]++;
    return stats;
  }

  // ─── Event log ─────────────────────────────────────────────────────────────

  _logEvent(event, data) {
    const line =
      JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    writeFile(this.eventsLogPath, line, { flag: "a" }).catch(() => {});
  }
}
