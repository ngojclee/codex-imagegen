# Codex ImageGen

Proxy API server chạy local, cho phép các app bên ngoài gọi tạo ảnh AI thông qua OAuth credentials của Codex CLI.

**API shape: OpenAI-compatible** — tương thích với các client gọi `/v1/images/generations` và `/v1/images/edits` theo convention của OpenAI SDK. App chỉ cần đổi `base_url` và `api_key` là chạy được, zero thay đổi code.

## Kiến trúc

```
App (NailArt, Web, v.v.)
  │
  │  POST /v1/images/generations  |  POST /v1/images/edits
  │  Authorization: Bearer <proxy-api-key>
  ▼
Codex ImageGen Proxy (localhost:3456)
  │
  │  AuthPool (LRU rotation, cooldown/dead tracking)
  │   ├── ~/.codex-imagegen/accounts/acc_A.json
  │   ├── ~/.codex-imagegen/accounts/acc_B.json
  │   └── ...
  │
  │  Auto-harvest: watch ~/.codex/auth.json → copy new logins into pool
  ▼
ChatGPT/Codex Responses API (chatgpt.com)
  │
  ▼
Image base64 → trả về cho App
```

## Yêu cầu

- Node.js 22+
- Codex CLI đã login ở chế độ **chatgpt** (OAuth):
  ```bash
  codex auth login
  # Chọn chatgpt mode
  ```
  Login một account là đủ để chạy. Login nhiều account (có thể lặp lại `codex auth login` với các email khác) → proxy tự thu vào pool và xoay vòng.

## Cài đặt

```bash
cd codex-imagegen
npm install
```

## Chạy

```bash
npm start
```

Lần chạy đầu tiên sẽ tự sinh API key và lưu vào `.env`.

## API Endpoints

### `POST /v1/images/generations` — Text-to-image (JSON)

Tạo ảnh từ prompt thuần text. Dùng cho avatar, background from scratch, creative gen.

**Headers:**
```
Authorization: Bearer <proxy-api-key>
Content-Type: application/json
```

**Body:**
```json
{
  "prompt": "a cinematic fantasy city at sunrise",
  "model": "gpt-5.4",
  "input_refs": ["data:image/png;base64,..."],
  "timeout_ms": 900000,
  "size": "1024x1024",
  "quality": "medium",
  "background": "opaque",
  "n": 1
}
```

| Field | Kiểu | Bắt buộc | Mô tả |
|-------|------|----------|-------|
| `prompt` | string | ✅ | Prompt mô tả ảnh cần tạo |
| `model` | string | ❌ | Model (default: `gpt-5.4`) |
| `input_refs` | string[] | ❌ | Ảnh tham chiếu (base64 data URL hoặc HTTP URL) |
| `timeout_ms` | number | ❌ | Timeout (default: 900000ms = 15 phút) |
| `size` | string | ❌ | **Accepted-and-ignored** (OpenAI-compat) |
| `quality` | string | ❌ | **Accepted-and-ignored** (OpenAI-compat) |
| `background` | string | ❌ | **Accepted-and-ignored** (OpenAI-compat) |
| `n` | number | ❌ | **Accepted-and-ignored** — proxy luôn trả 1 ảnh |

### `POST /v1/images/edits` — Image-to-image (multipart)

Tạo ảnh dựa trên ảnh reference. Dùng cho batch/touch up/realism/background swap/style transfer.

**Headers:**
```
Authorization: Bearer <proxy-api-key>
Content-Type: multipart/form-data
```

**Form parts:**

| Part | Kiểu | Bắt buộc | Mô tả |
|------|------|----------|-------|
| `image[]` | file (lặp 1–3 lần) | ✅ | PNG/JPEG binary, ≤ 10 MB/file |
| `prompt` | text | ✅ | Prompt chỉ đạo tạo ảnh |
| `model` | text | ❌ | Model (default: `gpt-5.4`) |
| `mask` | file | ❌ | Log nhưng hiện chưa dùng |
| `size` | text | ❌ | Accepted-and-ignored |
| `quality` | text | ❌ | Accepted-and-ignored |
| `background` | text | ❌ | Accepted-and-ignored |
| `n` | text | ❌ | Accepted-and-ignored |

**Curl ví dụ:**
```bash
curl -X POST http://localhost:3456/v1/images/edits \
  -H "Authorization: Bearer sk-proxy-xxxx" \
  -F "model=gpt-image-1" \
  -F "prompt=Transfer the nail art pattern onto the target nails" \
  -F "size=1024x1024" \
  -F "n=1" \
  -F "image[]=@source_artwork.png;type=image/png" \
  -F "image[]=@target_nails.png;type=image/png"
```

### Response (cho cả 2 endpoint)

```json
{
  "created": 1234567890,
  "request_id": "uuid",
  "data": [
    {
      "b64_json": "iVBORw0KGgo...",
      "revised_prompt": "A cinematic wide-angle..."
    }
  ],
  "usage": {
    "elapsed_ms": 12345
  }
}
```

`b64_json` là chuỗi base64 thuần, **không có prefix** `data:image/png;base64,`.

### Error shape (cho tất cả endpoint)

```json
{
  "error": {
    "message": "Your prompt triggered a safety filter.",
    "type": "invalid_request_error"
  }
}
```

### `GET /health`

Kiểm tra trạng thái server và pool.

**Response:**
```json
{
  "status": "ok",
  "pool": {
    "total": 3,
    "healthy": 2,
    "cooldown": 1,
    "dead": 0
  },
  "server": {
    "port": 3456,
    "default_model": "gpt-5.4",
    "version": "0.3.0.0"
  }
}
```

`status` giá trị:
- `ok` — có ít nhất 1 account healthy
- `degraded` — có account nhưng tất cả đang cooldown/dead
- `no_accounts` — pool rỗng, cần `codex auth login`

## Multi-auth pool

Proxy quản lý một **pool OAuth accounts** và tự động xoay vòng (LRU) giữa các account đang healthy. Cơ chế:

1. **Auto-harvest**: proxy `fs.watch` file `~/.codex/auth.json`. Mỗi khi bạn chạy `codex auth login` với account mới, proxy tự copy sang `~/.codex-imagegen/accounts/<account_id>.json`. (Có poller 30s làm safety-net cho Windows.)
2. **Rotation**: mỗi request gen ảnh bốc account ít được dùng nhất trong pool healthy.
3. **State machine**:
   - `healthy` → dùng bình thường
   - `cooldown` (60s mặc định) → vừa gặp HTTP 429 hoặc 403, skip tạm thời
   - `dead` → refresh_token bị revoke, skip vĩnh viễn cho đến khi user can thiệp (re-login hoặc gọi `/admin/accounts/:id/revive`)
4. **Khi toàn pool down**: endpoint gen trả `503` với `{"error":{"type":"pool_unavailable","message":"..."}}`.
5. **Event log**: tất cả rotation/cooldown/dead/harvest được append JSONL vào `~/.codex-imagegen/events.log` để debug sau.

### Thêm account

Chỉ cần login lần nữa bằng Codex CLI với account khác:

```bash
codex auth login   # login với account A
# proxy auto-harvest → pool có acc_A
codex auth login   # login với account B
# proxy auto-harvest → pool có acc_A + acc_B
```

Kiểm tra pool:
```bash
curl -H "Authorization: Bearer $PROXY_API_KEY" \
  http://localhost:3456/admin/accounts
```

### Admin endpoints

Tất cả dùng cùng `PROXY_API_KEY` như endpoint gen ảnh.

| Endpoint | Mô tả |
|---|---|
| `GET /admin/accounts` | List pool + status chi tiết từng account |
| `POST /admin/harvest` | Force re-scan `~/.codex/auth.json` (backup nếu watcher miss event) |
| `POST /admin/accounts/:id/revive` | Reset dead/cooldown account về healthy để test lại |
| `DELETE /admin/accounts/:id` | Xóa account khỏi pool (xóa cả file) |

## Ví dụ sử dụng

### curl

```bash
curl -X POST http://localhost:3456/v1/images/generations \
  -H "Authorization: Bearer sk-proxy-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cinematic fantasy city at sunrise"}'
```

### Python

```python
import requests

response = requests.post(
    "http://localhost:3456/v1/images/generations",
    headers={"Authorization": "Bearer sk-proxy-xxxx"},
    json={"prompt": "a cinematic fantasy city at sunrise"}
)

data = response.json()
for img in data["data"]:
    # img["b64_json"] contains base64 PNG
    pass
```

### JavaScript

```javascript
const response = await fetch("http://localhost:3456/v1/images/generations", {
  method: "POST",
  headers: {
    "Authorization": "Bearer sk-proxy-xxxx",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ prompt: "a cinematic fantasy city at sunrise" }),
});

const { data } = await response.json();
// data[0].b64_json contains base64 PNG
```

## Cấu hình (.env)

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `PROXY_API_KEY` | Auto-gen | API key cho client |
| `PORT` | `3456` | Cổng server |
| `CODEX_AUTH_PATH` | `~/.codex/auth.json` | File auth source (để harvest) |
| `POOL_ROOT` | `~/.codex-imagegen` | Thư mục gốc cho pool |
| `ACCOUNTS_DIR` | `<POOL_ROOT>/accounts` | Nơi lưu file auth mỗi account |
| `EVENTS_LOG` | `<POOL_ROOT>/events.log` | Log JSONL cho pool events |
| `COOLDOWN_DEFAULT_MS` | `60000` | TTL cooldown mặc định khi gặp 429/403 |
| `DEFAULT_MODEL` | `gpt-5.4` | Model mặc định |
| `DEFAULT_TIMEOUT_MS` | `900000` | Timeout request |

## License

MIT
