import { Hono } from 'hono'
import { MOLTBOT_PORT } from '../config'
import { findExistingMoltbotProcess } from '../gateway'
import { txtclawWebhooks } from '../txtclaw/routes'
import type { AppEnv } from '../types'
import { consoleRoutes } from './console'
import { publicApiV1 } from './public-api-v1'

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>()

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  })
})

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox')

  try {
    const process = await findExistingMoltbotProcess(sandbox)
    if (!process) {
      return c.json({ ok: false, status: 'not_running' })
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 })
      return c.json({ ok: true, status: 'running', processId: process.id })
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id })
    }
  } catch (err) {
    return c.json({ ok: false, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url)
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/')
  const assetUrl = new URL(assetPath, url.origin)
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw))
})

// GET /paid - Public payment completion landing fallback.
// Old checkout links may still point here; never require CF Access for this page.
publicRoutes.get('/paid', (c) => {
  return c.html(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TXTCLAW Payment Confirmed</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #0b1220;
        color: #e5eef9;
        font: 16px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .card {
        max-width: 560px;
        margin: 24px;
        padding: 24px;
        border-radius: 14px;
        border: 1px solid #1f2c44;
        background: #101a2d;
      }
      h1 { margin: 0 0 10px; font-size: 24px; }
      p { margin: 0 0 10px; color: #c9d8ee; }
      .muted { color: #9fb2d0; font-size: 14px; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Payment confirmed</h1>
      <p>Your TXTCLAW beta access is being finalized.</p>
      <p>Return to your Apple chat and send a message. Activation usually completes quickly after invite approval.</p>
      <p class="muted">If this page opened from an older checkout link, no action is required.</p>
    </main>
  </body>
</html>`,
    200,
  )
})

// Public developer API routes.
publicRoutes.route('/v1', publicApiV1)

// TXT CLAW developer console (server-to-server; used by txtclaw.com).
publicRoutes.route('/console', consoleRoutes)

// TXT CLAW webhooks (Twilio + Square). These must be public.
publicRoutes.route('/webhooks', txtclawWebhooks)

export { publicRoutes }
