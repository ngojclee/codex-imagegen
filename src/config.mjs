/**
 * Configuration loader for Codex ImageGen proxy.
 * Reads .env file manually (no external dependencies) and merges with process.env.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Parse a .env file into a key-value object.
 * Supports comments (#), empty lines, and quoted values.
 */
function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return {};

  const content = readFileSync(envPath, "utf8");
  const env = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

/**
 * Load and validate all configuration.
 * On first run, auto-generates an API key and saves to .env.
 */
export function loadConfig() {
  const envPath = path.join(PROJECT_ROOT, ".env");
  const envVars = loadEnvFile(envPath);

  // Helper: process.env > .env file > default
  const get = (key, defaultValue = "") =>
    process.env[key] || envVars[key] || defaultValue;

  const port = parseInt(get("PORT", "3456"), 10);
  const authPath = get(
    "CODEX_AUTH_PATH",
    path.join(os.homedir(), ".codex", "auth.json"),
  );
  const baseUrl = get("CODEX_BASE_URL", "https://chatgpt.com/backend-api/codex");
  const refreshUrl = get(
    "CODEX_REFRESH_URL",
    "https://auth.openai.com/oauth/token",
  );
  const defaultModel = get("DEFAULT_MODEL", "gpt-5.4");
  const defaultTimeout = parseInt(get("DEFAULT_TIMEOUT_MS", "900000"), 10);
  const outputDir = get("OUTPUT_DIR", path.join(PROJECT_ROOT, "output"));

  // Multi-auth pool — stores per-account auth files harvested from Codex CLI
  const poolRoot = get(
    "POOL_ROOT",
    path.join(os.homedir(), ".codex-imagegen"),
  );
  const accountsDir = get("ACCOUNTS_DIR", path.join(poolRoot, "accounts"));
  const eventsLogPath = get("EVENTS_LOG", path.join(poolRoot, "events.log"));
  const cooldownDefaultMs = parseInt(get("COOLDOWN_DEFAULT_MS", "60000"), 10);

  // Auto-generate API key on first run
  let apiKey = get("PROXY_API_KEY", "");
  let keyGenerated = false;

  if (!apiKey) {
    apiKey = `sk-proxy-${randomBytes(24).toString("hex")}`;
    keyGenerated = true;

    // Save to .env for persistence
    const envContent = [
      "# Codex ImageGen Proxy Configuration",
      "# Auto-generated on first run",
      "",
      `PROXY_API_KEY=${apiKey}`,
      `PORT=${port}`,
      `CODEX_AUTH_PATH=${authPath}`,
      `CODEX_BASE_URL=${baseUrl}`,
      `CODEX_REFRESH_URL=${refreshUrl}`,
      `DEFAULT_MODEL=${defaultModel}`,
      `DEFAULT_TIMEOUT_MS=${defaultTimeout}`,
      "",
    ].join("\n");

    writeFileSync(envPath, envContent, "utf8");
  }

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  return {
    port,
    apiKey,
    keyGenerated,
    authPath,
    baseUrl,
    refreshUrl,
    defaultModel,
    defaultTimeout,
    outputDir,
    poolRoot,
    accountsDir,
    eventsLogPath,
    cooldownDefaultMs,
    projectRoot: PROJECT_ROOT,
  };
}
