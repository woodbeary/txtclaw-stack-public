# TXT CLAW BYOK

BYOK lets the runtime operate with your own provider key while keeping the platform API surface the same.

## Endpoints

- `GET /v1/byok`
- `PUT /v1/byok`
- `DELETE /v1/byok`

## Example

```bash
curl -sS "$TXTCLAW_API_BASE_URL/v1/byok" \
  -X PUT \
  -H "Authorization: Bearer $TXTCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai_compat",
    "api_key": "sk_REPLACE_ME",
    "base_url": "https://gateway.example.com/v1/compat",
    "model": "provider/model-name",
    "label": "work"
  }'
```
