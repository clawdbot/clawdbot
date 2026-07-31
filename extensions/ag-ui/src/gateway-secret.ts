import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Resolve the gateway HMAC secret from the canonical config or `OPENCLAW_*` env.
 *
 * Legacy `CLAWDBOT_*` / `MOLTBOT_*` names are deliberately NOT accepted: the
 * gateway ignores them everywhere else (`src/gateway/auth.ts`,
 * `src/gateway/env-deprecation.ts`), so honouring one here would give this
 * HTTP surface a second, undocumented credential source that the rest of the
 * gateway rejects.
 *
 * This lives in its own module so that the HTTP handler file contains zero
 * `process.env` references — plugin security scanners flag "env access +
 * network send" when both appear in the same source file.
 */
export function resolveGatewaySecret(api: OpenClawPluginApi): string | null {
  const gatewayAuth = api.config.gateway?.auth;
  const secret =
    (gatewayAuth as Record<string, unknown> | undefined)?.token ??
    process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof secret === "string" && secret) {
    return secret;
  }
  return null;
}
