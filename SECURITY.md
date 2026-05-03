# Security Policy

## Supported Version

Security fixes target the `master` branch and the latest `ghcr.io/ngojclee/codex-imagegen:latest` image.

## Sensitive Data

Codex ImageGen stores OAuth credentials in runtime storage, not in source code:

- Docker/Portainer: `/data/pool/accounts/*.json`
- Optional harvest source: `/data/auth.json`
- Local development default: `~/.codex-imagegen/accounts/*.json`

These files contain OAuth refresh tokens. Do not commit, upload, screenshot, or share them.

## Required Deployment Secrets

Set these to strong unique values before deploying:

- `PROXY_API_KEY`
- `MANAGEMENT_PASSWORD`
- `MANAGEMENT_SESSION_SECRET`

Leave `ADMIN_API_KEY` empty unless automation needs `/admin/*` endpoints.

## Public Exposure Guidance

Do not expose this service directly to the public internet without an additional access layer. Prefer one of:

- VPN or Tailscale
- Cloudflare Access
- reverse proxy with HTTPS and authentication
- private LAN only

If served only over HTTPS, set:

```env
MANAGEMENT_COOKIE_SECURE=true
```

## Reporting Issues

If this repository is public, report security issues privately to the maintainer instead of opening a public issue with tokens, logs, callback URLs, or auth files.
