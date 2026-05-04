# Codex ImageGen

Codex ImageGen is a small OpenAI-compatible local/remote image proxy. It exposes `/v1/images/generations` and `/v1/images/edits`, uses Codex/ChatGPT OAuth credentials behind the scenes, rotates multiple accounts through an auth pool, and includes a password-gated browser management UI.

The intended deployment is Docker or Portainer with a persistent `/data` mount for OAuth credentials. Do not bake OAuth tokens into the image.

## Current Image

```text
ghcr.io/ngojclee/codex-imagegen:latest
```

If the GHCR package is private, configure registry auth in Portainer or run `docker login ghcr.io` with a GitHub PAT that has `read:packages`.

## Public Security Notes

Before exposing this service outside a trusted network:

- Set strong unique values for `PROXY_API_KEY`, `MANAGEMENT_PASSWORD`, and `MANAGEMENT_SESSION_SECRET`.
- Keep `ADMIN_API_KEY` empty unless you specifically need `/admin/*` API automation.
- Do not reuse `PROXY_API_KEY` as `ADMIN_API_KEY`.
- Put `/management` behind VPN, Tailscale, Cloudflare Access, or a reverse proxy with HTTPS.
- Treat everything under `/data` as sensitive because it stores OAuth refresh tokens.
- Never commit `.env`, `.env.docker`, `auth.json`, `/data`, `output`, `.runtime`, `.omc`, or `.omx`.
- OAuth callback URLs contain one-time `code` values. Paste them only into your own management UI.

Security hardening included in the app:

- Management UI uses an HttpOnly signed cookie.
- Management mutation endpoints require an internal CSRF header.
- `/admin/*` is disabled unless `ADMIN_API_KEY` is set.
- Docker image runs as the non-root `node` user.
- Compose/Portainer examples use `read_only`, `tmpfs: /tmp`, and `no-new-privileges`.
- `npm audit` currently reports 0 vulnerabilities.

## URLs

Assuming your Docker host is `192.0.2.101` and port `3456`:

| Purpose | URL |
|---|---|
| Management UI | `http://192.0.2.101:3456/management` |
| Health check | `http://192.0.2.101:3456/health` |
| Text-to-image | `http://192.0.2.101:3456/v1/images/generations` |
| Image edits | `http://192.0.2.101:3456/v1/images/edits` |

The root `/` is not the GUI. Use `/management`.

## Portainer Deployment

Use [deploy/portainer-stack.yml](deploy/portainer-stack.yml) and [deploy/portainer.env.example](deploy/portainer.env.example).

1. On the Docker host, create the persistent data directory:

   ```bash
   mkdir -p /home/Docker/codex-imagegen/data
   chown -R 1000:1000 /home/Docker/codex-imagegen/data
   chmod 700 /home/Docker/codex-imagegen/data
   ```

   The container runs as UID `1000` (`node`). If your NAS/host uses a different permission model, make sure the container can write to this directory.

2. In Portainer, go to **Stacks** → **Add stack**.

3. Paste the contents of `deploy/portainer-stack.yml` into the Web editor.

4. Paste variables from `deploy/portainer.env.example` into **Environment variables**.

5. Change at least these values:

   ```env
   PROXY_API_KEY=sk-proxy-use-a-long-random-value
   MANAGEMENT_PASSWORD=use-a-strong-password
   MANAGEMENT_SESSION_SECRET=use-a-long-random-secret
   ```

6. If GHCR pull fails with `unauthorized`, add a Portainer registry:

   - Registry URL: `ghcr.io`
   - Username: your GitHub username
   - Password: GitHub PAT with `read:packages`

   Or make the GHCR package public.

7. Deploy the stack.

8. Open:

   ```text
   http://<docker-host>:3456/management
   ```

The Portainer stack uses this bind mount by default:

```text
/home/Docker/codex-imagegen/data:/data
```

Inside the container:

| Container path | Purpose |
|---|---|
| `/data/auth.json` | Optional source auth file for Harvest |
| `/data/pool/accounts` | Imported account auth files |
| `/data/pool/events.log` | Pool events log |
| `/data/output` | Runtime output directory |

## Docker CLI Deployment

Create `.env.docker` from `.env.docker.example` and edit the secrets:

```bash
cp .env.docker.example .env.docker
```

Run the published image:

```bash
docker pull ghcr.io/ngojclee/codex-imagegen:latest

docker run -d --name codex-imagegen \
  -p 3456:3456 \
  --env-file .env.docker \
  --read-only \
  --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  -v /home/Docker/codex-imagegen/data:/data \
  ghcr.io/ngojclee/codex-imagegen:latest
```

Or build locally:

```bash
docker compose up -d --build
```

## Management UI

Enable the UI by setting `MANAGEMENT_PASSWORD`. Then open:

```text
http://<host>:3456/management
```

The management UI can:

- show pool stats and account health
- create a manual OAuth login link
- import raw `auth.json`
- harvest `/data/auth.json` or `CODEX_AUTH_PATH`
- revive or delete pool accounts

### Recommended Auth Flow: Manual OAuth Login

This works well for Docker/Portainer because the browser login happens on your own computer.

1. Open `/management` and sign in.
2. Click **Create Login Link**.
3. Open or copy the generated OpenAI OAuth URL.
4. Login in your browser.
5. Browser redirects to `OAUTH_REDIRECT_URI`, default:

   ```text
   http://localhost:1455/auth/callback
   ```

   It is fine if the page says it cannot connect. You only need the URL in the browser address bar.

6. Copy the full callback URL, including `code=...&state=...`.
7. Paste it into **Callback URL**.
8. Click **Complete Login**.

The server exchanges the code using PKCE, creates a Codex-compatible auth JSON, and imports it into `/data/pool/accounts`.

### Alternative: Import Raw Auth JSON

If you already have a Codex OAuth file, paste or upload it in the **Import Auth** panel.

Expected Codex format:

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "...",
    "account_id": "..."
  }
}
```

### Alternative: Harvest Mounted Auth

Copy an auth file to the data directory as:

```text
/home/Docker/codex-imagegen/data/auth.json
```

Then click **Harvest** in the management UI.

## API Usage

All image endpoints require:

```http
Authorization: Bearer <PROXY_API_KEY>
```

### Text-to-image

```bash
curl -X POST http://localhost:3456/v1/images/generations \
  -H "Authorization: Bearer sk-proxy-use-a-long-random-value" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a cinematic fantasy city at sunrise"}'
```

Request body fields:

| Field | Type | Required | Notes |
|---|---|---:|---|
| `prompt` | string | yes | Text prompt |
| `model` | string | no | Defaults to `DEFAULT_MODEL` |
| `input_refs` | string[] | no | Data URLs or HTTP image URLs |
| `timeout_ms` | number | no | Defaults to `DEFAULT_TIMEOUT_MS` |
| `size` | string | no | Forwarded to image tool |
| `quality` | string | no | Forwarded to image tool |
| `background` | string | no | Forwarded to image tool |
| `n` | number | no | Accepted for compatibility, ignored; returns one image |

### Image edits

```bash
curl -X POST http://localhost:3456/v1/images/edits \
  -H "Authorization: Bearer sk-proxy-use-a-long-random-value" \
  -F "prompt=Transfer this nail-art pattern onto the target nails" \
  -F "image[]=@source_artwork.png;type=image/png" \
  -F "image[]=@target_nails.png;type=image/png"
```

Upload limits:

- max 10 MB per file
- max 5 multipart files total
- `image[]` or `image` accepted
- `mask` accepted but currently ignored

### Response Shape

```json
{
  "created": 1234567890,
  "request_id": "uuid",
  "data": [
    {
      "b64_json": "iVBORw0KGgo...",
      "revised_prompt": "..."
    }
  ],
  "usage": {
    "elapsed_ms": 12345
  }
}
```

`b64_json` is raw base64 without a `data:image/png;base64,` prefix.

## Optional Admin API

The browser management UI is preferred. The JSON admin API is disabled unless `ADMIN_API_KEY` is set.

When enabled, use:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

Endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /admin/accounts` | List pool accounts |
| `POST /admin/harvest` | Harvest `CODEX_AUTH_PATH` |
| `POST /admin/accounts/:id/revive` | Mark account healthy |
| `DELETE /admin/accounts/:id` | Remove account from pool |

## Environment Variables

| Variable | Required | Default | Notes |
|---|---:|---|---|
| `PROXY_API_KEY` | yes for Docker | auto-generated locally | Client API key for image endpoints |
| `ADMIN_API_KEY` | no | empty | Enables `/admin/*`; leave empty to disable |
| `MANAGEMENT_PASSWORD` | yes for UI | empty | Enables `/management`; empty disables UI |
| `MANAGEMENT_SESSION_SECRET` | yes for Docker | generated locally | HMAC secret for management cookie |
| `MANAGEMENT_SESSION_TTL_MS` | no | `43200000` | 12 hours |
| `MANAGEMENT_COOKIE_SECURE` | no | `false` | Set `true` when serving only through HTTPS |
| `PORT` | no | `3456` | Host/container app port |
| `CODEX_AUTH_PATH` | no | `~/.codex/auth.json` or `/data/auth.json` in Docker | Harvest source file |
| `POOL_ROOT` | no | `~/.codex-imagegen` or `/data/pool` in Docker | Pool root |
| `ACCOUNTS_DIR` | no | `<POOL_ROOT>/accounts` | Account auth files |
| `EVENTS_LOG` | no | `<POOL_ROOT>/events.log` | JSONL event log |
| `OUTPUT_DIR` | no | `./output` or `/data/output` in Docker | Runtime output |
| `CODEX_BASE_URL` | no | `https://chatgpt.com/backend-api/codex` | Codex backend base URL |
| `CODEX_REFRESH_URL` | no | `https://auth.openai.com/oauth/token` | OAuth token endpoint |
| `DEFAULT_MODEL` | no | `gpt-5.4` | Default model |
| `DEFAULT_TIMEOUT_MS` | no | `900000` | Request timeout |
| `COOLDOWN_DEFAULT_MS` | no | `60000` | Account cooldown after 429/403 |
| `OAUTH_REDIRECT_URI` | no | `http://localhost:1455/auth/callback` | Manual OAuth redirect URI |
| `OAUTH_SESSION_TTL_MS` | no | `600000` | OAuth state lifetime |
| `DATA_DIR` | Portainer only | `/home/Docker/codex-imagegen/data` | Host bind mount path |

## Build Artifacts

GitHub Actions runs on every push to `master`:

- Node syntax checks
- `docker compose config`
- portable zip artifact: `codex-imagegen-portable.zip`
- GHCR Docker image: `ghcr.io/ngojclee/codex-imagegen:latest`

If GitHub warns about Node.js 20 actions deprecation, that is from upstream GitHub actions runtime and does not affect this app build today.

## Troubleshooting

### Portainer says `version must be a string`

Use the current `deploy/portainer-stack.yml`; it starts with:

```yaml
version: "3.9"
```

### Pulling GHCR image returns `unauthorized`

The package is private or your Docker host is not logged in.

Fix options:

- make the GHCR package public, or
- configure Portainer registry `ghcr.io` with a GitHub PAT that has `read:packages`, or
- run `docker login ghcr.io` on the Docker host.

### `/management` says disabled

Set `MANAGEMENT_PASSWORD` and restart/redeploy.

### Login succeeds but actions fail with CSRF

Use the built-in UI. If calling management API manually, include:

```http
x-codex-imagegen-csrf: 1
```

### Pool is empty

Add an account using OAuth Login, Import Auth, or Harvest `/data/auth.json`.

### Container cannot write to `/data`

The image runs as UID `1000`. Fix host directory permissions, for example:

```bash
chown -R 1000:1000 /home/Docker/codex-imagegen/data
chmod 700 /home/Docker/codex-imagegen/data
```

### OAuth callback page cannot connect

That is expected when using the manual flow. Copy the full URL from the browser address bar and paste it into the management UI.

## Local Development

```bash
npm install
npm start
```

Local first run can auto-generate `.env` with `PROXY_API_KEY`. Docker deployments should set secrets explicitly.

In Docker/production (`NODE_ENV=production`), `PROXY_API_KEY` is required. If `MANAGEMENT_PASSWORD` is set, `MANAGEMENT_SESSION_SECRET` is also required.

## License

MIT
