import type { Sandbox } from '@cloudflare/sandbox'

/**
 * Environment bindings for the Moltbot Worker
 */
export interface MoltbotEnv {
  Sandbox: DurableObjectNamespace<Sandbox>
  TXTCLAW_DIRECTORY?: DurableObjectNamespace
  TXTCLAW_TRACES?: DurableObjectNamespace
  ASSETS: Fetcher // Assets binding for admin UI static files
  MOLTBOT_BUCKET: R2Bucket // R2 bucket for persistent storage
  // AI Gateway configuration (preferred)
  AI_GATEWAY_API_KEY?: string // API key for the provider configured in AI Gateway
  AI_GATEWAY_BASE_URL?: string // AI Gateway URL (e.g., https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic)
  AI_GATEWAY_MODEL?: string // Optional model override for OpenAI-compatible gateways (e.g. amazon/nova-lite)
  TXTCLAW_FORCE_OPENAI_COMPAT?: string // Force OpenAI-compatible provider wiring in startup script
  // Legacy direct provider configuration (fallback)
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
  OPENAI_API_KEY?: string
  MOLTBOT_GATEWAY_TOKEN?: string // Gateway token (mapped to CLAWDBOT_GATEWAY_TOKEN for container)

  CLAWDBOT_BIND_MODE?: string
  DEV_MODE?: string // Set to 'true' for local dev (skips CF Access auth + moltbot device pairing)
  E2E_TEST_MODE?: string // Set to 'true' for E2E tests (skips CF Access auth but keeps device pairing)
  DEBUG_ROUTES?: string // Set to 'true' to enable /debug/* routes
  SANDBOX_SLEEP_AFTER?: string // How long before sandbox sleeps: 'never' (default), or duration like '10m', '1h'
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_DM_POLICY?: string
  DISCORD_BOT_TOKEN?: string
  DISCORD_DM_POLICY?: string
  SLACK_BOT_TOKEN?: string
  SLACK_APP_TOKEN?: string
  // Cloudflare Access configuration for admin routes
  CF_ACCESS_TEAM_DOMAIN?: string // e.g., 'myteam.cloudflareaccess.com'
  CF_ACCESS_AUD?: string // Application Audience (AUD) tag
  // R2 credentials for bucket mounting (set via wrangler secret)
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_BUCKET_NAME?: string // Override bucket name (default: 'moltbot-data')
  CF_ACCOUNT_ID?: string // Cloudflare account ID for R2 endpoint
  // Browser Rendering binding for CDP shim
  BROWSER?: Fetcher
  CDP_SECRET?: string // Shared secret for CDP endpoint authentication
  WORKER_URL?: string // Public URL of the worker (for CDP endpoint)

  // TXT CLAW SaaS control-plane configuration (Twilio + Square)
  TXTCLAW_ONBOARDING_NUMBER?: string // E.164 number used for onboarding flow (the public "main line")
  TXTCLAW_PUBLIC_BASE_URL?: string // Canonical base URL for webhook signature validation (https://<worker-domain>)

  // TXT CLAW public developer API
  TXTCLAW_PUBLIC_API_ENABLED?: string // set "true" to enable /v1/* routes
  TXTCLAW_PUBLIC_API_KEYS?: string // comma-separated bearer keys allowlist
  TXTCLAW_PUBLIC_API_CORS_ORIGINS?: string // optional comma-separated Origin allowlist for browser requests
  TXTCLAW_PUBLIC_API_SMS_SANDBOX_ENABLED?: string // set "true" to enable sms.mode=sandbox (scaffold today)
  TXTCLAW_PUBLIC_API_RPM_PER_KEY?: string // default 60
  TXTCLAW_PUBLIC_API_RPM_PER_IP?: string // default 120
  TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY?: string // default 1000 (launch-week safety cap)
  // Optional plan-based overrides for the dev API lane (stored per Clerk user in the Directory DO).
  TXTCLAW_PUBLIC_API_RPM_PER_KEY_PRO?: string // default 300
  TXTCLAW_PUBLIC_API_RPM_PER_IP_PRO?: string // default 500
  TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY_PRO?: string // default 10000
  TXTCLAW_PUBLIC_API_RPM_PER_KEY_MAX?: string // default 600
  TXTCLAW_PUBLIC_API_RPM_PER_IP_MAX?: string // default 1000
  TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY_MAX?: string // default 50000
  TXTCLAW_PUBLIC_API_RPM_PER_KEY_BYOK?: string // default 600
  TXTCLAW_PUBLIC_API_RPM_PER_IP_BYOK?: string // default 1000
  TXTCLAW_PUBLIC_API_REQ_PER_DAY_PER_KEY_BYOK?: string // default 50000
  TXTCLAW_PUBLIC_API_CREATE_PER_DAY_PER_KEY?: string // default 50
  TXTCLAW_PUBLIC_API_CREATE_PER_MIN_PER_IP?: string // default 10
  TXTCLAW_PUBLIC_API_PREWARM_ON_CREATE?: string // default true (starts gateway on agent create)
  TXTCLAW_PUBLIC_API_WARMUP_PER_HOUR_PER_KEY?: string // default 3
  TXTCLAW_PUBLIC_API_OPENCLAW_TIMEOUT_MS?: string // default 180000 (API lane only)
  TXTCLAW_PUBLIC_API_OPENCLAW_MAX_ATTEMPTS?: string // default 2 (API lane only)
  TXTCLAW_PUBLIC_API_OPENCLAW_RETRY_DELAY_MS?: string // default 0 (API lane only)

  // TXT CLAW developer console (server-to-server, used by txtclaw.com)
  TXTCLAW_CONSOLE_SERVICE_TOKEN?: string // shared token required for /console/v1/*
  TXTCLAW_CONSOLE_SERVICE_TOKEN_NEXT?: string // optional 2nd token for rotation window
  TXTCLAW_CONSOLE_MAX_ACTIVE_KEYS_PER_USER?: string // default 3
  TXTCLAW_CONSOLE_CREATE_KEYS_PER_HOUR_PER_USER?: string // default 5

  // TXT CLAW inference lanes
  TXTCLAW_HOSTED_PRIMARY_MODEL?: string // e.g. "openai/amazon/nova-lite"
  TXTCLAW_HOSTED_FALLBACK_MODEL?: string // optional fallback model (auto-router)
  TXTCLAW_BYOK_ENABLED?: string // set "true" to enable BYOK endpoints + key storage
  TXTCLAW_CREDENTIALS_MASTER_KEY?: string // base64url-encoded 32 bytes (AES-256-GCM)
  TXTCLAW_BYOK_SET_PER_HOUR_PER_KEY?: string // anti-abuse cap for BYOK changes (default 5)

  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string // Used to validate X-Twilio-Signature
  TWILIO_API_KEY_SID?: string
  TWILIO_API_KEY_SECRET?: string
  TWILIO_STATUS_CALLBACK_URL?: string

  SQUARE_ENV?: 'sandbox' | 'production'
  SQUARE_ACCESS_TOKEN?: string
  SQUARE_LOCATION_ID?: string
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string
  SQUARE_WEBHOOK_NOTIFICATION_URL?: string // Canonical URL used for signature validation

  ZENDESK_SUBDOMAIN?: string // e.g. "textclaw"
  ZENDESK_API_EMAIL?: string // Zendesk admin email used with API token auth
  ZENDESK_API_TOKEN?: string // Zendesk API token
  ZENDESK_WEBHOOK_BEARER_TOKEN?: string // Shared bearer token for inbound Zendesk webhook auth
  SUNSHINE_APP_ID?: string // Sunshine Conversations App ID
  SUNSHINE_KEY_ID?: string // Sunshine Conversations key id (username for Basic auth)
  SUNSHINE_KEY_SECRET?: string // Sunshine Conversations key secret (password for Basic auth)
  TXTCLAW_DISABLE_SUNSHINE_AUTOREPLY?: string // set "true" to globally disable Sunshine auto-replies
  TXTCLAW_SUNSHINE_MIN_REPLY_INTERVAL_SECONDS?: string // minimum seconds between Sunshine replies per user (default 8)
  TXTCLAW_SUNSHINE_ALLOWLIST_APP_USERS?: string // comma-separated Sunshine appUser ids allowed for beta traffic
  TXTCLAW_USE_REQUESTER_EXTERNAL_ID_AS_SUNSHINE?: string // set "true" to treat requester_external_id as Sunshine appUser id

  TXTCLAW_PRICE_CENTS?: string // e.g. "1999"
  TXTCLAW_MIN_PRICE_CENTS?: string // e.g. "900"
  TXTCLAW_CURRENCY?: string // e.g. "USD"
  TXTCLAW_MAX_ACTIVE_USERS?: string // launch cap, default 50
  TXTCLAW_MAX_NEW_PER_DAY?: string // launch cap, default 5
  TXTCLAW_UNPAID_PROMPTS_PER_DAY?: string // default 2
  TXTCLAW_PRO_FAST_REQUESTS_MONTH?: string // default 500
  TXTCLAW_PRO_INBOUND_PER_DAY?: string // default 400
  TXTCLAW_PRO_INBOUND_PER_WEEK?: string // default 2800
  TXTCLAW_PRO_OUTBOUND_PER_DAY?: string // default 400
  TXTCLAW_PRO_OUTBOUND_PER_WEEK?: string // default 2800
  TXTCLAW_PRO_OUTBOUND_PER_MONTH?: string // default 3000
  TXTCLAW_PRO_ESTIMATED_SPEND_CAP_CENTS?: string // default 1600, set 0 to disable
  TXTCLAW_SMS_SEGMENT_COST_CENTS?: string // default 1
  TXTCLAW_FAST_REQUEST_COST_CENTS?: string // default 2
  TXTCLAW_INPUT_TOKEN_COST_PER_1M_CENTS?: string // default 0
  TXTCLAW_OUTPUT_TOKEN_COST_PER_1M_CENTS?: string // default 0
  TXTCLAW_OPENCLAW_TIMEOUT_MS?: string // default 20000
  TXTCLAW_OPENCLAW_MODEL?: string // optional explicit model id for /v1/responses (e.g. openai/amazon/nova-lite)
  TXTCLAW_OPENCLAW_MAX_ATTEMPTS?: string // default 3
  TXTCLAW_OPENCLAW_RETRY_DELAY_MS?: string // default 1500
  TXTCLAW_BRIDGE_ENABLED?: string // set "false" to disable bridge path (default true)
  TXTCLAW_BRIDGE_INITIAL_TIMEOUT_MS?: string // default 1200; fast-bridge race timeout
  TXTCLAW_BRIDGE_MAX_OUTPUT_TOKENS?: string // default 80; short bridge responses only
  TXTCLAW_BRIDGE_TIMEOUT_MS?: string // default 2500; timeout for bridge AI generation
  TXTCLAW_BRIDGE_MODEL?: string // optional bridge model override (defaults to AI_GATEWAY_MODEL)
  TXTCLAW_BOOTSTRAP_ENABLED?: string // set "false" to bypass first-run profile bootstrap (default true)
  TXTCLAW_TWILIO_SEND_MAX_ATTEMPTS?: string // default 3
  TXTCLAW_TWILIO_SEND_RETRY_DELAY_MS?: string // default 1000
  TXTCLAW_ONBOARDING_USE_SANDBOX_LLM?: string // set "true" to use sandbox LLM for unpaid onboarding (default false)
  TXTCLAW_ONBOARDING_MAX_OUTPUT_TOKENS?: string // default 180 tokens for unpaid onboarding replies
  TXTCLAW_ENABLE_TWILIO_ONBOARDING?: string // set "true" to enable legacy Twilio onboarding checkout flow (default false)
  TXTCLAW_WARM_ACK_AFTER_MINUTES?: string // default 30
  TXTCLAW_WARMUP_RETRY_DELAY_MS?: string // default 120000; delayed follow-up retry when warmup fallback is sent
  TXTCLAW_FORCE_RESTART_GATEWAY?: string // set "true" to always restart gateway process before requests (debug/recovery)
  TXTCLAW_DISABLE_NUMBER_PURCHASE?: string // set "true" to prevent buying Twilio numbers during tests
  TXTCLAW_ZENDESK_DIRECT_ACTIVATION?: string // set "true" to activate non-SMS (Zendesk) users immediately after payment
  TXTCLAW_SANDBOX_SLEEP_AFTER?: string // per-TXTCLAW override (e.g. "15m")
}

/**
 * Authenticated user from Cloudflare Access
 */
export interface AccessUser {
  email: string
  name?: string
}

/**
 * Hono app environment type
 */
export type AppEnv = {
  Bindings: MoltbotEnv
  Variables: {
    sandbox: Sandbox
    accessUser?: AccessUser
    // Public developer API request context
    traceId?: string
    apiKeyId?: string
    apiKeyUserId?: string
    apiKeyAuthKind?: 'allowlist' | 'directory'
    apiKeyPlan?: 'free' | 'pro' | 'max' | 'byok' | string
    ipHash?: string | null
    // TXT CLAW public API trace metadata (best-effort; persisted when present)
    txtclawLlmMode?: 'hosted' | 'byok' | string
    txtclawLlmTier?: 'fast' | 'smart' | string
    txtclawModelUsed?: string
    txtclawPromptVersionId?: string
  }
}

/**
 * JWT payload from Cloudflare Access
 */
export interface JWTPayload {
  aud: string[]
  email: string
  exp: number
  iat: number
  iss: string
  name?: string
  sub: string
  type: string
}
