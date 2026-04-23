/**
 * Express HTTP server for Codex ImageGen proxy.
 * Provides REST API endpoints for image generation using Codex OAuth.
 */
import express from "express";
import {
  readAuth,
  getValidAuth,
  refreshAuth,
  isTokenExpired,
  tokenSecondsLeft,
} from "./auth.mjs";
import { generateImages, CodexApiError } from "./generate.mjs";

/**
 * Create and configure the Express application.
 */
export function createServer(config) {
  const app = express();

  // ── Body parser (large limit for base64 image references) ──
  app.use(express.json({ limit: "50mb" }));

  // ── Request logging ──
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

  // ── API Key Authentication Middleware ──
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
        error: {
          message: "Invalid API key",
          type: "auth_error",
        },
      });
    }

    next();
  };

  // ─── Routes ─────────────────────────────────────────────────────────────────

  /**
   * GET /health — Server and auth status (no auth required)
   */
  app.get("/health", async (_req, res) => {
    try {
      const auth = await readAuth(config.authPath);
      const expired = isTokenExpired(auth);
      const ttl = tokenSecondsLeft(auth);

      res.json({
        status: expired ? "degraded" : "ok",
        auth: {
          found: true,
          format: auth.format,
          path: config.authPath,
          expired,
          expires_in_seconds: ttl,
        },
        server: {
          port: config.port,
          default_model: config.defaultModel,
          version: "0.1.0.0",
        },
      });
    } catch (error) {
      res.json({
        status: "error",
        auth: {
          found: false,
          error: error.message,
        },
        server: {
          port: config.port,
          default_model: config.defaultModel,
          version: "0.1.0.0",
        },
      });
    }
  });

  // Alias
  app.get("/v1/health", (_req, res) => res.redirect("/health"));

  /**
   * POST /v1/images/generations — Generate images
   *
   * Request body:
   *   {
   *     "prompt": "a cinematic fantasy city at sunrise",
   *     "model": "gpt-5.4",           // optional
   *     "input_refs": ["data:..."],    // optional reference images
   *     "timeout_ms": 900000           // optional
   *   }
   *
   * Response:
   *   {
   *     "created": 1234567890,
   *     "request_id": "...",
   *     "data": [
   *       { "b64_json": "...", "revised_prompt": "..." }
   *     ],
   *     "usage": { "elapsed_ms": 1234 }
   *   }
   */
  app.post("/v1/images/generations", authenticate, async (req, res) => {
    const startTime = Date.now();

    try {
      const { prompt, model, input_refs, timeout_ms } = req.body;

      // Validate prompt
      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        return res.status(400).json({
          error: {
            message: 'Missing or empty "prompt" field',
            type: "invalid_request_error",
          },
        });
      }

      // Get valid auth (auto-refresh if expired)
      let auth = await getValidAuth(config);

      // Attempt generation with 401 retry
      let result;
      try {
        result = await generateImages(config, auth, {
          prompt: prompt.trim(),
          model: model || config.defaultModel,
          inputRefs: input_refs || [],
          timeoutMs: timeout_ms || config.defaultTimeout,
        });
      } catch (error) {
        // On 401, force refresh and retry once
        if (error instanceof CodexApiError && error.status === 401) {
          console.log("[server] Got 401 — refreshing token and retrying...");
          auth = await refreshAuth(auth, config);
          result = await generateImages(config, auth, {
            prompt: prompt.trim(),
            model: model || config.defaultModel,
            inputRefs: input_refs || [],
            timeoutMs: timeout_ms || config.defaultTimeout,
          });
        } else {
          throw error;
        }
      }

      res.json({
        created: Math.floor(Date.now() / 1000),
        request_id: result.requestId,
        data: result.images,
        usage: {
          elapsed_ms: Date.now() - startTime,
        },
      });
    } catch (error) {
      console.error("[server] Generation error:", error.message);

      const status = error instanceof CodexApiError ? error.status : 500;
      res.status(status).json({
        error: {
          message: error.message,
          type: "server_error",
        },
        usage: {
          elapsed_ms: Date.now() - startTime,
        },
      });
    }
  });

  // ── 404 fallback ──
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        message: "Not found. Available endpoints: POST /v1/images/generations, GET /health",
        type: "not_found",
      },
    });
  });

  return app;
}
