/**
 * Codex ImageGen — Proxy API Server
 * Entry point: loads config, creates server, starts listening.
 */
import { loadConfig } from "./config.mjs";
import { createServer } from "./server.mjs";

const config = loadConfig();
const app = createServer(config);

app.listen(config.port, () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────┐");
  console.log("  │        Codex ImageGen Proxy v0.1.0.0     │");
  console.log("  └─────────────────────────────────────────┘");
  console.log("");
  console.log(`  Server:    http://localhost:${config.port}`);
  console.log(`  Auth:      ${config.authPath}`);
  console.log(`  Model:     ${config.defaultModel}`);
  console.log("");

  if (config.keyGenerated) {
    console.log("  ⚠  New API key generated and saved to .env:");
  } else {
    console.log("  API Key:");
  }
  console.log(`  ${config.apiKey}`);
  console.log("");
  console.log("  Endpoints:");
  console.log("    POST /v1/images/generations  — Generate images");
  console.log("    GET  /health                 — Server status");
  console.log("");
  console.log("  Example:");
  console.log(`    curl -X POST http://localhost:${config.port}/v1/images/generations \\`);
  console.log(`      -H "Authorization: Bearer ${config.apiKey}" \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(`      -d '{"prompt": "a cinematic fantasy city at sunrise"}'`);
  console.log("");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[server] Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[server] Shutting down...");
  process.exit(0);
});
