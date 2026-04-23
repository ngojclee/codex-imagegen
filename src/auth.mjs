/**
 * OAuth authentication module for Codex ImageGen proxy.
 * Handles reading Codex/OpenClaw auth files, JWT decoding, and token refresh.
 * Adapted from codex-imagen auth logic.
 */
import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_SKEW_SECONDS = 120; // Refresh 2 minutes before expiry
const REFRESH_TIMEOUT_MS = 30_000;

// ─── JWT Helpers ──────────────────────────────────────────────────────────────

function base64UrlDecode(input) {
  const padded = input.padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    "=",
  );
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

// ─── Auth File Reading ────────────────────────────────────────────────────────

/**
 * Read and parse an auth file.
 * Supports:
 *   - Codex auth.json (chatgpt mode): { auth_mode: "chatgpt", tokens: { ... } }
 *   - OpenClaw auth-profiles.json: { profiles: { "openai-codex:xxx": { ... } } }
 *   - OpenClaw legacy oauth.json: { "openai-codex": { ... } }
 */
export async function readAuth(authPath) {
  if (!existsSync(authPath)) {
    throw new Error(
      `Auth file not found: ${authPath}\n` +
        `Run 'codex auth login' (select chatgpt mode) to create OAuth credentials.`,
    );
  }

  const raw = await readFile(authPath, "utf8");
  const auth = JSON.parse(raw);

  // ── Codex auth.json ──
  if (auth.tokens && typeof auth.tokens === "object") {
    if (auth.auth_mode && auth.auth_mode !== "chatgpt") {
      throw new Error(
        `Auth mode is '${auth.auth_mode}', but 'chatgpt' (OAuth) is required.\n` +
          `Run 'codex auth login' and select the chatgpt/OAuth option.`,
      );
    }

    const accessToken = auth.tokens.access_token;
    const refreshToken = auth.tokens.refresh_token;
    const accountId = auth.tokens.account_id;

    if (!accessToken) throw new Error(`No access_token in ${authPath}`);
    if (!accountId) throw new Error(`No account_id in ${authPath}`);

    const jwt = decodeJwtPayload(accessToken);
    const expiresAt = jwt?.exp ? jwt.exp * 1000 : null;

    return {
      accessToken,
      refreshToken,
      accountId,
      expiresAt,
      authPath,
      authJson: auth,
      format: "codex-auth-json",
    };
  }

  // ── OpenClaw auth-profiles.json ──
  if (auth.profiles && typeof auth.profiles === "object") {
    const candidates = Object.entries(auth.profiles).filter(
      ([, p]) => p?.type === "oauth" && p.provider === "openai-codex",
    );

    if (candidates.length === 0) {
      throw new Error(
        `No openai-codex OAuth profile found in ${authPath}\n` +
          `Run 'openclaw onboard --auth-choice openai-codex' to create one.`,
      );
    }

    // Pick the first candidate (could be improved with scoring like codex-imagen)
    const [profileId, profile] = candidates[0];
    const accessToken = profile.access || profile.access_token;
    const refreshToken = profile.refresh || profile.refresh_token;
    const accountId = profile.accountId || profile.account_id;

    if (!accessToken) throw new Error(`No access token in profile ${profileId}`);
    if (!accountId) throw new Error(`No account_id in profile ${profileId}`);

    const jwt = decodeJwtPayload(accessToken);
    const expiresMs = profile.expires
      ? profile.expires > 10_000_000_000
        ? profile.expires
        : profile.expires * 1000
      : null;
    const expiresAt = expiresMs || (jwt?.exp ? jwt.exp * 1000 : null);

    return {
      accessToken,
      refreshToken,
      accountId,
      expiresAt,
      authPath,
      authJson: auth,
      profileId,
      format: "openclaw-auth-profiles",
    };
  }

  // ── OpenClaw legacy oauth.json ──
  const codexEntry = auth["openai-codex"];
  if (codexEntry && typeof codexEntry === "object") {
    const accessToken = codexEntry.access || codexEntry.access_token;
    const refreshToken = codexEntry.refresh || codexEntry.refresh_token;
    const accountId = codexEntry.accountId || codexEntry.account_id;

    if (!accessToken) throw new Error(`No access token in ${authPath}`);
    if (!accountId) throw new Error(`No account_id in ${authPath}`);

    const jwt = decodeJwtPayload(accessToken);
    const expiresAt = jwt?.exp ? jwt.exp * 1000 : null;

    return {
      accessToken,
      refreshToken,
      accountId,
      expiresAt,
      authPath,
      authJson: auth,
      profileId: "openai-codex:default",
      format: "openclaw-oauth-json",
    };
  }

  throw new Error(
    `Unsupported auth format in ${authPath}.\n` +
      `Expected: Codex auth.json (chatgpt mode), OpenClaw auth-profiles.json, or OpenClaw oauth.json.\n` +
      `Found keys: ${Object.keys(auth).join(", ")}`,
  );
}

// ─── Token Expiry Checks ──────────────────────────────────────────────────────

export function tokenSecondsLeft(auth) {
  if (!auth.expiresAt) return null;
  return Math.floor((auth.expiresAt - Date.now()) / 1000);
}

export function isTokenExpired(auth) {
  if (!auth.expiresAt) return false; // Can't determine — assume valid
  return tokenSecondsLeft(auth) <= REFRESH_SKEW_SECONDS;
}

// ─── OAuth Token Refresh ──────────────────────────────────────────────────────

/**
 * Refresh the OAuth access token using the refresh token.
 * Writes updated credentials back to the auth file atomically.
 */
export async function refreshAuth(auth, config) {
  if (!auth.refreshToken) {
    throw new Error(
      `No refresh token found in ${auth.authPath}.\n` +
        `Run 'codex auth login' again to re-authenticate.`,
    );
  }

  console.log("[auth] Refreshing OAuth token...");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

  try {
    const response = await fetch(config.refreshUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "codex-imagegen/0.1.0",
      },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      const hint =
        response.status === 401
          ? " Token may be expired/revoked. Run 'codex auth login' again."
          : "";
      throw new Error(
        `OAuth refresh failed (HTTP ${response.status}): ${body}${hint}`,
      );
    }

    const data = await response.json();

    // ── Merge refresh response into auth JSON ──
    const updated = structuredClone(auth.authJson);

    if (auth.format === "codex-auth-json") {
      if (!updated.tokens) updated.tokens = {};
      if (data.access_token) updated.tokens.access_token = data.access_token;
      if (data.refresh_token) updated.tokens.refresh_token = data.refresh_token;
      if (data.id_token) updated.tokens.id_token = data.id_token;
      updated.last_refresh = new Date().toISOString();
    } else if (auth.format === "openclaw-auth-profiles" && auth.profileId) {
      const profile = updated.profiles?.[auth.profileId];
      if (profile) {
        if (data.access_token) profile.access = data.access_token;
        if (data.refresh_token) profile.refresh = data.refresh_token;
        if (data.id_token) profile.idToken = data.id_token;
        if (data.expires_in) {
          profile.expires = Date.now() + data.expires_in * 1000;
        }
      }
    } else {
      // Legacy oauth.json
      const provider = "openai-codex";
      const entry = updated[provider];
      if (entry) {
        if (data.access_token) entry.access = data.access_token;
        if (data.refresh_token) entry.refresh = data.refresh_token;
        if (data.id_token) entry.idToken = data.id_token;
        if (data.expires_in) {
          entry.expires = Date.now() + data.expires_in * 1000;
        }
      }
    }

    // ── Atomic write ──
    await writeAuthAtomic(auth.authPath, updated);

    // ── Re-read fresh state ──
    const fresh = await readAuth(auth.authPath);
    const ttl = tokenSecondsLeft(fresh);
    console.log(
      `[auth] Token refreshed successfully. Expires in ${ttl !== null ? `${ttl}s` : "unknown"}`,
    );
    return fresh;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `OAuth refresh timed out after ${REFRESH_TIMEOUT_MS}ms. Check network connectivity.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Write auth JSON atomically: write to temp file, then rename.
 */
async function writeAuthAtomic(authPath, authJson) {
  await mkdir(path.dirname(authPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(authPath),
    `.${path.basename(authPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const data = `${JSON.stringify(authJson, null, 2)}\n`;
  await writeFile(tmpPath, data, { mode: 0o600 });
  await rename(tmpPath, authPath);
  try {
    await chmod(authPath, 0o600);
  } catch {
    // chmod may fail on Windows — acceptable
  }
}

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Get a valid (non-expired) auth object. Refreshes if needed.
 */
export async function getValidAuth(config) {
  let auth = await readAuth(config.authPath);

  if (isTokenExpired(auth)) {
    auth = await refreshAuth(auth, config);
  }

  return auth;
}
