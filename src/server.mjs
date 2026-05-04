/**
 * Express HTTP server for Codex ImageGen proxy.
 * Exposes OpenAI-compatible image endpoints backed by a pool of Codex OAuth accounts.
 */
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  createPkceChallenge,
  exchangeOAuthCode,
  readAuth,
  refreshAuth,
  isTokenExpired,
} from "./auth.mjs";
import { generateImages, CodexApiError } from "./generate.mjs";
import { NoHealthyAccountsError } from "./pool.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const oauthSessions = new Map();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB per file (per OpenAI-compat spec)
const MAX_FILES = 5; // up to 3 image[] + 1 mask + buffer
const loginAttempts = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
});

/**
 * Wrap multer middleware so any upload error is converted to our
 * standard JSON error shape instead of Express' default HTML.
 */
function handleUpload(req, res, next) {
  upload.any()(req, res, (err) => {
    if (!err) return next();
    const message =
      err instanceof multer.MulterError
        ? `Upload error: ${err.message}${err.field ? ` (field: ${err.field})` : ""}`
        : err.message || "Upload failed";
    res.status(400).json({
      error: { message, type: "invalid_request_error" },
    });
  });
}

/**
 * Log OpenAI-compat fields the proxy accepts-and-ignores.
 * size/quality/background are now forwarded; only n is ignored.
 */
function logIgnoredFields(endpoint, body) {
  if (body?.n !== undefined && body?.n !== "") {
    console.log(`[server] ${endpoint} accepted-and-ignored: { n: ${body.n} }`);
  }
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function isLoginRateLimited(req) {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxAttempts = 12;
  const key = getClientIp(req);
  const entry = loginAttempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  loginAttempts.set(key, entry);
  return entry.count > maxAttempts;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function buildManagementCookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
  ];
  if (Number.isFinite(options.maxAge)) parts.push(`Max-Age=${Math.ceil(options.maxAge)}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function verifySession(token, secret) {
  if (!token || !token.includes(".")) return false;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function redactAccount(account) {
  return {
    ...account,
    display_id: account.id.length > 10
      ? `${account.id.slice(0, 6)}...${account.id.slice(-4)}`
      : account.id,
  };
}

function cleanOAuthSessions() {
  const now = Date.now();
  for (const [state, session] of oauthSessions.entries()) {
    if (session.expiresAt <= now) oauthSessions.delete(state);
  }
}

function buildAuthorizeUrl({ state, challenge, redirectUri }) {
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("prompt", "login");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile offline_access");
  url.searchParams.set("state", state);
  return url.toString();
}

function parseCallbackUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Callback URL is invalid. Paste the full http://localhost:1455/auth/callback?... URL.");
  }
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  const error = parsed.searchParams.get("error");
  const errorDescription = parsed.searchParams.get("error_description");
  if (error) throw new Error(`OAuth returned error: ${errorDescription || error}`);
  if (!code || !state) throw new Error("Callback URL must include both code and state query parameters.");
  return { code, state };
}

/**
 * Iterate through the account pool until one produces an image.
 *
 * Per-account error handling:
 *   - Token near expiry → refresh before the request.
 *   - HTTP 401 on the API itself → try one refresh, else mark dead.
 *   - HTTP 429 / 403 → cooldown, try the next account.
 *   - Refresh failure (refresh_token revoked) → mark dead, try the next.
 *   - Other errors → surface immediately (no retry).
 */
async function generateWithPool(pool, config, params) {
  const tried = new Set();
  let lastError = null;
  const maxTries = Math.max(1, pool.stats().total);

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const account = pool.getNext(tried);
    if (!account) break;
    tried.add(account.id);

    let auth;
    try {
      auth = await readAuth(account.filePath);
    } catch (err) {
      pool.markCooldown(account.id, 10_000, `read_auth_failed: ${err.message.slice(0, 120)}`);
      lastError = err;
      continue;
    }

    if (isTokenExpired(auth)) {
      try {
        auth = await refreshAuth(auth, config);
      } catch (err) {
        console.log(`[server] Refresh failed for ${account.id}: ${err.message.slice(0, 160)}`);
        pool.markDead(account.id, `refresh_failed: ${err.message.slice(0, 200)}`);
        lastError = err;
        continue;
      }
    }

    try {
      console.log(`[server] Using account ${account.id}${account.email ? ` (${account.email})` : ""}`);
      return await generateImages(config, auth, params);
    } catch (err) {
      if (err instanceof CodexApiError) {
        if (err.status === 401) {
          try {
            auth = await refreshAuth(auth, config);
            return await generateImages(config, auth, params);
          } catch (refreshErr) {
            pool.markDead(
              account.id,
              `refresh_after_401_failed: ${refreshErr.message.slice(0, 200)}`,
            );
            lastError = err;
            continue;
          }
        }
        if (err.status === 429 || err.status === 403) {
          pool.markCooldown(account.id, config.cooldownDefaultMs, `http_${err.status}`);
          lastError = err;
          continue;
        }
      }
      // Transient network / stream-terminated errors from undici —
      // upstream dropped connection mid-stream. Short cooldown, try next account.
      if (err?.isTransientNetwork) {
        pool.markCooldown(account.id, 10_000, `transient_network: ${err.cause?.code || "terminated"}`);
        lastError = err;
        continue;
      }
      // Unrecoverable (generation error, upstream 5xx, safety filter) — surface immediately.
      throw err;
    }
  }

  if (lastError) throw lastError;
  throw new NoHealthyAccountsError(pool.stats());
}

/**
 * Create and configure the Express application.
 */
export function createServer(config, pool) {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (req.path.startsWith("/management") || req.path.startsWith("/admin")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      console.log(
        `[http] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`,
      );
    });
    next();
  });

  const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: {
          message: "Missing Authorization header. Use: Authorization: Bearer <api-key>",
          type: "auth_error",
        },
      });
    }
    const token = authHeader.slice(7).trim();
    if (token !== config.apiKey) {
      return res.status(403).json({
        error: { message: "Invalid API key", type: "auth_error" },
      });
    }
    next();
  };

  const authenticateAdmin = (req, res, next) => {
    if (!config.adminApiKey) {
      return res.status(503).json({
        error: {
          message: "Admin API is disabled. Set ADMIN_API_KEY to enable /admin endpoints.",
          type: "admin_disabled",
        },
      });
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: {
          message: "Missing Authorization header. Use: Authorization: Bearer <admin-api-key>",
          type: "auth_error",
        },
      });
    }
    const token = authHeader.slice(7).trim();
    if (!safeEqual(token, config.adminApiKey)) {
      return res.status(403).json({
        error: { message: "Invalid admin API key", type: "auth_error" },
      });
    }
    next();
  };

  const requireManagement = (req, res, next) => {
    if (!config.managementPassword) {
      return res.status(503).json({
        error: {
          message: "Management UI is disabled. Set MANAGEMENT_PASSWORD to enable it.",
          type: "management_disabled",
        },
      });
    }
    const cookies = parseCookies(req.headers.cookie || "");
    if (!verifySession(cookies.mgmt_session, config.managementSessionSecret)) {
      return res.status(401).json({
        error: { message: "Management login required", type: "auth_error" },
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const csrf = req.headers["x-codex-imagegen-csrf"];
      if (csrf !== "1") {
        return res.status(403).json({
          error: { message: "Missing management CSRF header", type: "auth_error" },
        });
      }
    }
    next();
  };

  const sendError = (res, error, startTime) => {
    const status =
      error instanceof NoHealthyAccountsError
        ? 503
        : error instanceof CodexApiError
          ? error.status
          : 500;
    const type =
      error instanceof NoHealthyAccountsError
        ? "pool_unavailable"
        : "server_error";
    res.status(status).json({
      error: { message: error.message, type },
      usage: { elapsed_ms: Date.now() - startTime },
    });
  };

  // ─── Routes ────────────────────────────────────────────────────────────────

  /**
   * GET /health — No auth required. Reports pool stats.
   */
  app.get("/health", (_req, res) => {
    const stats = pool.stats();
    let status;
    if (stats.total === 0) status = "no_accounts";
    else if (stats.healthy === 0) status = "degraded";
    else status = "ok";

    res.json({
      status,
      pool: stats,
      server: {
        port: config.port,
        default_model: config.defaultModel,
        version: "0.4.1.3",
      },
    });
  });

  app.get("/v1/health", (_req, res) => res.redirect("/health"));

  app.get("/management", (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "management.html"));
  });

  app.use("/management/assets", express.static(path.join(PUBLIC_DIR, "assets")));

  app.get("/management/api/session", (req, res) => {
    const cookies = parseCookies(req.headers.cookie || "");
    const enabled = Boolean(config.managementPassword);
    const authenticated = enabled && verifySession(
      cookies.mgmt_session,
      config.managementSessionSecret,
    );
    res.json({ enabled, authenticated });
  });

  app.post("/management/api/login", (req, res) => {
    if (!config.managementPassword) {
      return res.status(503).json({
        error: {
          message: "Management UI is disabled. Set MANAGEMENT_PASSWORD to enable it.",
          type: "management_disabled",
        },
      });
    }

    if (isLoginRateLimited(req)) {
      return res.status(429).json({
        error: { message: "Too many login attempts. Try again later.", type: "rate_limited" },
      });
    }

    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!safeEqual(password, config.managementPassword)) {
      return res.status(401).json({
        error: { message: "Invalid password", type: "auth_error" },
      });
    }

    const ttl = Number.isFinite(config.managementSessionTtlMs)
      ? config.managementSessionTtlMs
      : 43_200_000;
    const token = signSession({ exp: Date.now() + ttl }, config.managementSessionSecret);
    res.setHeader(
      "Set-Cookie",
      buildManagementCookie("mgmt_session", token, {
        maxAge: ttl / 1000,
        secure: config.managementCookieSecure,
      }),
    );
    res.json({ ok: true });
  });

  app.post("/management/api/logout", (_req, res) => {
    res.setHeader(
      "Set-Cookie",
      buildManagementCookie("mgmt_session", "", {
        maxAge: 0,
        secure: config.managementCookieSecure,
      }),
    );
    res.json({ ok: true });
  });

  app.get("/management/api/accounts", requireManagement, (_req, res) => {
    res.json({ stats: pool.stats(), accounts: pool.list().map(redactAccount) });
  });

  app.post("/management/api/harvest", requireManagement, async (_req, res) => {
    try {
      const result = await pool.harvestFromCodex();
      res.json({ ok: true, result, stats: pool.stats() });
    } catch (err) {
      res.status(500).json({ error: { message: err.message, type: "server_error" } });
    }
  });

  app.post("/management/api/import", requireManagement, handleUpload, async (req, res) => {
    try {
      const file = Array.isArray(req.files)
        ? req.files.find((f) => f.fieldname === "auth")
        : null;
      const raw = file?.buffer?.toString("utf8") || req.body?.auth_json || "";
      if (!raw.trim()) {
        return res.status(400).json({
          error: { message: "Paste auth JSON or upload an auth file.", type: "invalid_request_error" },
        });
      }

      let authJson;
      try {
        authJson = JSON.parse(raw);
      } catch (err) {
        return res.status(400).json({
          error: { message: `Invalid JSON: ${err.message}`, type: "invalid_request_error" },
        });
      }

      const result = await pool.importAuthJson(authJson);
      res.json({ ok: true, result, stats: pool.stats() });
    } catch (err) {
      res.status(400).json({
        error: { message: err.message, type: "invalid_request_error" },
      });
    }
  });

  app.post("/management/api/oauth/start", requireManagement, (_req, res) => {
    cleanOAuthSessions();
    const { verifier, challenge } = createPkceChallenge();
    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = config.oauthRedirectUri;
    const ttl = Number.isFinite(config.oauthSessionTtlMs)
      ? config.oauthSessionTtlMs
      : 600_000;

    oauthSessions.set(state, {
      codeVerifier: verifier,
      redirectUri,
      expiresAt: Date.now() + ttl,
    });

    res.json({
      ok: true,
      authorize_url: buildAuthorizeUrl({ state, challenge, redirectUri }),
      redirect_uri: redirectUri,
      state,
      expires_in_seconds: Math.ceil(ttl / 1000),
    });
  });

  app.post("/management/api/oauth/complete", requireManagement, async (req, res) => {
    try {
      cleanOAuthSessions();
      const callbackUrl = typeof req.body?.callback_url === "string"
        ? req.body.callback_url.trim()
        : "";
      if (!callbackUrl) {
        return res.status(400).json({
          error: { message: "Paste the full callback URL after login.", type: "invalid_request_error" },
        });
      }

      const { code, state } = parseCallbackUrl(callbackUrl);
      const session = oauthSessions.get(state);
      if (!session) {
        return res.status(400).json({
          error: { message: "OAuth state not found or expired. Generate a new login link.", type: "invalid_request_error" },
        });
      }
      oauthSessions.delete(state);

      const authJson = await exchangeOAuthCode(config, {
        code,
        codeVerifier: session.codeVerifier,
        redirectUri: session.redirectUri,
      });
      const result = await pool.importAuthJson(authJson);
      res.json({ ok: true, result, stats: pool.stats() });
    } catch (err) {
      res.status(400).json({
        error: { message: err.message, type: "invalid_request_error" },
      });
    }
  });

  app.post("/management/api/accounts/:id/revive", requireManagement, (req, res) => {
    const ok = pool.revive(req.params.id);
    if (!ok) {
      return res.status(404).json({
        error: { message: `Account not found: ${req.params.id}`, type: "not_found" },
      });
    }
    res.json({ ok: true, stats: pool.stats() });
  });

  app.delete("/management/api/accounts/:id", requireManagement, async (req, res) => {
    const ok = await pool.remove(req.params.id);
    if (!ok) {
      return res.status(404).json({
        error: { message: `Account not found: ${req.params.id}`, type: "not_found" },
      });
    }
    res.json({ ok: true, stats: pool.stats() });
  });

  /**
   * POST /v1/images/generations — text-to-image (JSON body).
   */
  app.post("/v1/images/generations", authenticate, async (req, res) => {
    const startTime = Date.now();
    try {
      const { prompt, model, input_refs, timeout_ms, size, quality, background } = req.body;

      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        return res.status(400).json({
          error: { message: 'Missing or empty "prompt" field', type: "invalid_request_error" },
        });
      }

      logIgnoredFields("/v1/images/generations", req.body);

      const result = await generateWithPool(pool, config, {
        prompt: prompt.trim(),
        model: model || config.defaultModel,
        inputRefs: Array.isArray(input_refs) ? input_refs : [],
        timeoutMs: Number(timeout_ms) > 0 ? Number(timeout_ms) : config.defaultTimeout,
        size: size || undefined,
        quality: quality || undefined,
        background: background || undefined,
      });

      res.json({
        created: Math.floor(Date.now() / 1000),
        request_id: result.requestId,
        data: result.images,
        usage: { elapsed_ms: Date.now() - startTime },
      });
    } catch (error) {
      console.error("[server] /v1/images/generations error:", error.message);
      sendError(res, error, startTime);
    }
  });

  /**
   * POST /v1/images/edits — image-to-image (multipart).
   *
   * Parts:
   *   - image[]   file, 1–3 repeats, ≤ 10 MB each                (required)
   *   - prompt    text                                           (required)
   *   - model     text — falls back to config.defaultModel
   *   - mask      file — logged but currently unused
   *   - size / quality / background / n — accepted-and-ignored
   */
  app.post("/v1/images/edits", authenticate, handleUpload, async (req, res) => {
    const startTime = Date.now();
    try {
      const prompt =
        typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!prompt) {
        return res.status(400).json({
          error: { message: 'Missing or empty "prompt" field', type: "invalid_request_error" },
        });
      }

      const files = Array.isArray(req.files) ? req.files : [];
      const imageFiles = files.filter(
        (f) => f.fieldname === "image[]" || f.fieldname === "image",
      );
      const maskFile = files.find((f) => f.fieldname === "mask");

      if (imageFiles.length === 0) {
        return res.status(400).json({
          error: {
            message:
              'Missing "image[]" file(s). At least one image is required for /v1/images/edits.',
            type: "invalid_request_error",
          },
        });
      }

      logIgnoredFields("/v1/images/edits", req.body);
      if (maskFile) {
        console.log(
          `[server] /v1/images/edits received mask (${maskFile.size} bytes) — ignored`,
        );
      }

      const inputRefs = imageFiles.map((f) => {
        const mime = f.mimetype || "image/png";
        const b64 = f.buffer.toString("base64");
        return `data:${mime};base64,${b64}`;
      });

      console.log(
        `[server] /v1/images/edits: ${imageFiles.length} image(s), prompt ${prompt.length} chars`,
      );

      const model =
        typeof req.body?.model === "string" && req.body.model.trim()
          ? req.body.model.trim()
          : config.defaultModel;
      const timeoutMsRaw = Number(req.body?.timeout_ms);
      const timeoutMs =
        Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
          ? timeoutMsRaw
          : config.defaultTimeout;
      const size = typeof req.body?.size === "string" && req.body.size.trim()
        ? req.body.size.trim() : undefined;
      const quality = typeof req.body?.quality === "string" && req.body.quality.trim()
        ? req.body.quality.trim() : undefined;
      const background = typeof req.body?.background === "string" && req.body.background.trim()
        ? req.body.background.trim() : undefined;

      const result = await generateWithPool(pool, config, {
        prompt,
        model,
        inputRefs,
        timeoutMs,
        size,
        quality,
        background,
      });

      res.json({
        created: Math.floor(Date.now() / 1000),
        request_id: result.requestId,
        data: result.images,
        usage: { elapsed_ms: Date.now() - startTime },
      });
    } catch (error) {
      console.error("[server] /v1/images/edits error:", error.message);
      sendError(res, error, startTime);
    }
  });

  // ─── Admin endpoints (same API key as generation) ─────────────────────────

  /** GET /admin/accounts — list pool contents with per-account status. */
  app.get("/admin/accounts", authenticateAdmin, (_req, res) => {
    res.json({ stats: pool.stats(), accounts: pool.list() });
  });

  /** POST /admin/harvest — manually re-scan the Codex CLI auth file. */
  app.post("/admin/harvest", authenticateAdmin, async (_req, res) => {
    try {
      const result = await pool.harvestFromCodex();
      res.json({ ok: true, result, stats: pool.stats() });
    } catch (err) {
      res.status(500).json({
        error: { message: err.message, type: "server_error" },
      });
    }
  });

  /** POST /admin/accounts/:id/revive — reset a dead/cooldown account to healthy. */
  app.post("/admin/accounts/:id/revive", authenticateAdmin, (req, res) => {
    const ok = pool.revive(req.params.id);
    if (!ok) {
      return res.status(404).json({
        error: { message: `Account not found: ${req.params.id}`, type: "not_found" },
      });
    }
    res.json({ ok: true, account: pool.list().find((a) => a.id === req.params.id) });
  });

  /** DELETE /admin/accounts/:id — remove an account from the pool. */
  app.delete("/admin/accounts/:id", authenticateAdmin, async (req, res) => {
    const ok = await pool.remove(req.params.id);
    if (!ok) {
      return res.status(404).json({
        error: { message: `Account not found: ${req.params.id}`, type: "not_found" },
      });
    }
    res.json({ ok: true, stats: pool.stats() });
  });

  // ── 404 fallback ──
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        message:
          "Not found. Endpoints: POST /v1/images/generations, POST /v1/images/edits, GET /health, GET /admin/accounts, POST /admin/harvest, POST /admin/accounts/:id/revive, DELETE /admin/accounts/:id",
        type: "not_found",
      },
    });
  });

  return app;
}
