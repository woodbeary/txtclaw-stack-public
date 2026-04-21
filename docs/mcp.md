# TXT CLAW MCP

MCP is the optional tool-based lane on top of the HTTP runtime API.

## Start Here

- Use the HTTP API if you want the simplest integration
- Use MCP if your coding agent wants structured tools and traceable operations

```bash
pnpm -s dlx txtclaw-mcp@latest
```

## Required Environment

- `TXTCLAW_API_KEY`
- `TXTCLAW_API_BASE_URL` (optional if your default is already configured)

## Example Config

```json
{
  "mcpServers": {
    "txtclaw": {
      "command": "pnpm",
      "args": ["-s", "dlx", "txtclaw-mcp@latest"],
      "env": {
        "TXTCLAW_API_BASE_URL": "https://api.example.com",
        "TXTCLAW_API_KEY": "vck_REPLACE_ME"
      }
    }
  }
}
```
