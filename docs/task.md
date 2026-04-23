# Codex ImageGen — Task Tracker

## Phase 1: Core Setup
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
- [x] Test server startup — ✅ OK
- [x] Test /health endpoint — ✅ returns auth status correctly
- [x] Test API key middleware — ✅ rejects unauthorized requests

## Phase 2: Git Setup
- [x] git init + initial commit
- [ ] GitHub remote setup

## Phase 3: Full Integration Test
- [ ] Login Codex CLI in chatgpt mode
- [ ] Test actual image generation via proxy
- [ ] Test reference image support
- [ ] Test 401 retry with token refresh
