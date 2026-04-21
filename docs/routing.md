# TXT CLAW Routing

TXT CLAW supports two inference lanes:

- `hosted`: the platform chooses and runs the provider path
- `byok`: the caller brings a provider key and routing details

## Hosted Defaults

- `llm.mode`: `hosted`
- `llm.tier`: `fast`

## Example

```bash
curl -sS "$TXTCLAW_API_BASE_URL/v1/agents" \
  -H "Authorization: Bearer $TXTCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "system_prompt": "You are a helpful assistant.",
    "llm": { "mode": "hosted", "tier": "fast" },
    "sms": { "mode": "none" }
  }'
```
