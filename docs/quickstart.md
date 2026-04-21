# TXT CLAW Quickstart

Goal: create an agent over HTTP, send a message, and optionally add MCP tooling later.

## 1) Set Environment Variables

```bash
export TXTCLAW_API_BASE_URL="https://api.example.com"
export TXTCLAW_API_KEY="vck_REPLACE_ME"
```

## 2) Minimal Create-Agent Request

```bash
curl -sS "$TXTCLAW_API_BASE_URL/v1/agents" \
  -H "Authorization: Bearer $TXTCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "system_prompt": "You are a helpful assistant.", "sms": { "mode": "none" } }'
```

## 3) Send a Message

```bash
curl -sS "$TXTCLAW_API_BASE_URL/v1/agents/$AGENT_ID/messages" \
  -H "Authorization: Bearer $TXTCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "text": "Summarize this in one paragraph." }'
```

## 4) Optional MCP Layer

```bash
pnpm -s dlx txtclaw-mcp@latest
```
