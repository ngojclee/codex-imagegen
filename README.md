# Codex ImageGen

Proxy API server chạy local, cho phép các app bên ngoài gọi tạo ảnh AI thông qua OAuth credentials của Codex CLI.

## Kiến trúc

```
App (NailArt, Web, v.v.)
  │
  │  POST /v1/images/generations
  │  Authorization: Bearer <proxy-api-key>
  ▼
Codex ImageGen Proxy (localhost:3456)
  │
  │  OAuth token từ ~/.codex/auth.json
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

### `POST /v1/images/generations`

Tạo ảnh từ prompt.

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
  "timeout_ms": 900000
}
```

| Field | Kiểu | Bắt buộc | Mô tả |
|-------|------|----------|-------|
| `prompt` | string | ✅ | Prompt mô tả ảnh cần tạo |
| `model` | string | ❌ | Model (default: `gpt-5.4`) |
| `input_refs` | string[] | ❌ | Ảnh tham chiếu (base64 data URL hoặc HTTP URL) |
| `timeout_ms` | number | ❌ | Timeout (default: 900000ms = 15 phút) |

**Response:**
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

### `GET /health`

Kiểm tra trạng thái server và OAuth.

**Response:**
```json
{
  "status": "ok",
  "auth": {
    "found": true,
    "format": "codex-auth-json",
    "expired": false,
    "expires_in_seconds": 3200
  },
  "server": {
    "port": 3456,
    "default_model": "gpt-5.4"
  }
}
```

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
| `CODEX_AUTH_PATH` | `~/.codex/auth.json` | Đường dẫn file auth |
| `DEFAULT_MODEL` | `gpt-5.4` | Model mặc định |
| `DEFAULT_TIMEOUT_MS` | `900000` | Timeout mặc định |

## License

MIT
