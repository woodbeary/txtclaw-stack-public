# TXT CLAW Developer API

Create a dedicated OpenClaw-backed agent over HTTP, then send messages to it from your own product or automation layer.

## Environment

```bash
export TXTCLAW_API_BASE_URL="https://api.example.com"
export TXTCLAW_API_KEY="vck_REPLACE_ME"
```

## Create Agent

```bash
curl -sS "$TXTCLAW_API_BASE_URL/v1/agents" \
  -H "Authorization: Bearer $TXTCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "system_prompt": "You are a helpful assistant. Keep replies concise.",
    "sms": { "mode": "none" }
  }'
```

## Send Message

```bash
curl -sS "$TXTCLAW_API_BASE_URL/v1/agents/$AGENT_ID/messages" \
  -H "Authorization: Bearer $TXTCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Draft a concise update for the team." }'
```

## Traceability

- Responses include `trace_id`
- Integrations should log that ID so failures can be investigated quickly
