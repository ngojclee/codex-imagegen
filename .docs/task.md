# Codex ImageGen — Task Tracker

## Phase 1: Core Setup ✅
- [x] Create project structure
- [x] package.json with express dependency
- [x] .gitignore, .env.example
- [x] Config loader (src/config.mjs)
- [x] Auth module (src/auth.mjs) — read/refresh/validate
- [x] Generate module (src/generate.mjs) — Codex API caller
- [x] Server module (src/server.mjs) — Express routes + middleware
- [x] Entry point (src/index.mjs)
- [x] README.md
- [x] npm install

## Phase 2: Verification ✅
- [x] Test server startup — ✅ OK
- [x] Test /health endpoint — ✅ returns auth status correctly
- [x] Test API key middleware — ✅ rejects unauthorized requests (401)
- [x] Test POST /v1/images/generations — ✅ sends request to Codex API
- [x] Test SSE streaming parser — ✅ correctly parses all event types
- [x] Test error capture — ✅ surfaces actual OpenAI errors to client
- [x] Cross-verify with codex-imagen original — ✅ same behavior

## Phase 3: Integration Test
- [ ] Test successful image generation (blocked: OpenAI server_error)
  - Both this proxy and the original codex-imagen get `server_error`
  - Auth + request format verified correct
  - Likely OpenAI account/service issue, not code issue
- [ ] Test reference image support
- [ ] Test 401 retry with token refresh
- [ ] Save generated image to output dir

## Phase 4: Git & Release
- [x] git init + initial commit
- [x] Debug + error capture improvements committed
- [x] GitHub remote setup
- [x] Push to GitHub

## Phase 5: Docker & Management
- [x] Dockerfile + docker-compose setup
- [x] Management password gate via `MANAGEMENT_PASSWORD`
- [x] Browser UI for auth pool status/import/revive/delete
- [x] Raw auth JSON import into account pool
- [x] Docker/runtime auth guidance documented
- [x] Manual OAuth login link + callback paste flow
