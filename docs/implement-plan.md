# Codex ImageGen — Proxy API Server

## Mục tiêu

Tạo một HTTP API proxy server chạy local, nhận request từ app bên ngoài, dùng OAuth credentials của Codex CLI trên máy để gọi ChatGPT Codex Responses API generate ảnh.

## Kiến trúc

```
External App ──(API Key)──> Proxy Server ──(OAuth)──> ChatGPT/Codex API
                                │
                                ├── Đọc ~/.codex/auth.json (OAuth token)
                                ├── Auto refresh token khi hết hạn
                                └── Trả ảnh base64 về cho client
```

## API Design

### `POST /v1/images/generations`

```json
// Request
{
  "prompt": "a cinematic fantasy city",
  "model": "gpt-5.4",
  "input_refs": ["data:image/png;base64,..."]
}

// Response
{
  "created": 1234567890,
  "data": [{ "b64_json": "...", "revised_prompt": "..." }]
}
```

### `GET /health`

Kiểm tra trạng thái server + auth.

## Tech Stack

- Node.js 22+ (ESM)
- Express.js for HTTP API
- Zero other dependencies

## Proposed Changes

### [NEW] `package.json` — Project config
### [NEW] `src/config.mjs` — Load .env, config
### [NEW] `src/auth.mjs` — OAuth read/refresh
### [NEW] `src/generate.mjs` — Image generation via Codex API
### [NEW] `src/server.mjs` — Express routes + middleware
### [NEW] `src/index.mjs` — Entry point
### [NEW] `.env.example` — Config template
### [NEW] `.gitignore`
### [NEW] `README.md`

## Verification

1. `npm install`
2. `npm start` — server starts, prints API key
3. `GET /health` — returns auth status
4. `POST /v1/images/generations` — (cần OAuth trước)
