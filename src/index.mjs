/**
 * Codex ImageGen — Proxy API Server
 * Entry point: loads config, initializes the auth pool, starts Express.
 */
import { loadConfig } from "./config.mjs";
import { createServer } from "./server.mjs";
import { AuthPool } from "./pool.mjs";

const config = loadConfig();

const pool = new AuthPool(config);
await pool.init();

const app = createServer(config, pool);

const server = app.listen(config.port, () => {
  const stats = pool.stats();

  console.log("");
  console.log("  ┌─────────────────────────────────────────┐");
  console.log("  │        Codex ImageGen Proxy v0.4.1.3     │");
  console.log("  └─────────────────────────────────────────┘");
  console.log("");
  console.log(`  Server:       http://localhost:${config.port}`);
  console.log(`  Source auth:  ${config.authPath}`);
  console.log(`  Pool dir:     ${config.accountsDir}`);
  console.log(`  Events log:   ${config.eventsLogPath}`);
  console.log(`  Model:        ${config.defaultModel}`);
  console.log(
    `  Pool state:   ${stats.total} account(s) — ${stats.healthy} healthy, ${stats.cooldown} cooldown, ${stats.dead} dead`,
  );
  console.log("");

  if (stats.total === 0) {
    console.log("  ⚠  Pool is empty. Run 'codex auth login' — the proxy will harvest it automatically.");
    console.log("");
  }

  if (config.keyGenerated) {
    console.log("  ⚠  New API key generated and saved to .env:");
  } else {
    console.log("  API Key:");
  }
  console.log(`  ${config.apiKey}`);
  console.log("");
  console.log("  Endpoints:");
  console.log("    POST /v1/images/generations         — Text-to-image (JSON)");
  console.log("    POST /v1/images/edits               — Image-to-image (multipart)");
  console.log("    GET  /health                        — Server + pool status");
  console.log("    GET  /admin/accounts                — List pool");
  console.log("    POST /admin/harvest                 — Harvest ~/.codex/auth.json");
  console.log("    POST /admin/accounts/:id/revive     — Revive dead account");
  console.log("    DELETE /admin/accounts/:id          — Remove account");
  console.log("    GET  /management                    — Browser management UI");
  console.log("");
  console.log("  Example:");
  console.log(`    curl -X POST http://localhost:${config.port}/v1/images/generations \\`);
  console.log(`      -H "Authorization: Bearer ${config.apiKey}" \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(`      -d '{"prompt": "a cinematic fantasy city at sunrise"}'`);
  console.log("");
});

async function shutdown(signal) {
  console.log(`\n[server] Received ${signal}, shutting down...`);
  await pool.stop();
  server.close(() => process.exit(0));
  // Force-exit if something hangs.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
