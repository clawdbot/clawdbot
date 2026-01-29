# Kimi Code OAuth Support

**Author:** Hermes  
**Date:** 2026-01-28  
**Status:** Proposal  

## Summary

Add native Kimi Code OAuth support to Moltbot, allowing users to authenticate with their Kimi subscription (like Claude Code OAuth) instead of requiring a static API key via OpenRouter.

## Motivation

Kimi Code CLI (`kimi-cli`) uses OAuth device authorization with `auth.kimi.com`, storing short-lived access tokens + refresh tokens. Currently Moltbot only supports Kimi Code via static API key (`KIMICODE_API_KEY`). Users with Kimi subscriptions should be able to use their subscription through Moltbot — same pattern as `anthropic:claude-cli` OAuth.

## Kimi Code OAuth Protocol

### Endpoints

| Endpoint | URL |
|----------|-----|
| Device Authorization | `https://auth.kimi.com/api/oauth/device_authorization` |
| Token (poll + refresh) | `https://auth.kimi.com/api/oauth/token` |
| API Base | `https://api.kimi.com/coding/v1` |

Override host: `KIMI_CODE_OAUTH_HOST` env var.

### Constants

```ts
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";
const REFRESH_THRESHOLD_SECONDS = 300; // refresh when < 5 min remaining
```

### Required Request Headers

All OAuth requests include Moonshot-specific headers:

```ts
{
  "X-Msh-Platform": "kimi_cli",      // or "moltbot"
  "X-Msh-Version": "<version>",
  "X-Msh-Device-Name": hostname(),
  "X-Msh-Device-Model": "macOS 15.3 arm64",
  "X-Msh-Os-Version": platform.version(),
  "X-Msh-Device-Id": "<uuid-hex>"    // persisted per-device
}
```

The `X-Msh-Platform` value should be `"moltbot"` (or reuse `"kimi_cli"` for compatibility if Moonshot validates it).

### Device Authorization Flow (Login)

```
POST /api/oauth/device_authorization
Content-Type: application/x-www-form-urlencoded

client_id=17e5f671-d194-4dfb-9706-5516cb48c098
```

Response:
```json
{
  "user_code": "ABCD-1234",
  "device_code": "<opaque>",
  "verification_uri": "https://...",
  "verification_uri_complete": "https://...?user_code=ABCD-1234",
  "expires_in": 900,
  "interval": 5
}
```

Poll for token:
```
POST /api/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=17e5f671-d194-4dfb-9706-5516cb48c098
device_code=<device_code>
grant_type=urn:ietf:params:oauth:grant-type:device_code
```

Response on success (200):
```json
{
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "expires_in": 900,
  "scope": "kimi-code",
  "token_type": "Bearer"
}
```

### Token Refresh

```
POST /api/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=17e5f671-d194-4dfb-9706-5516cb48c098
grant_type=refresh_token
refresh_token=<refresh_token>
```

Response: same shape as device token response.

Error codes:
- `401` / `403` → refresh token revoked/expired, delete stored tokens
- `5xx` → transient, retry later

### Token Lifetimes

| Token | Lifetime |
|-------|----------|
| Access token | ~15 minutes (900s) |
| Refresh token | ~30 days |

### JWT Payload (Access Token)

```json
{
  "client_id": "17e5f671-d194-4dfb-9706-5516cb48c098",
  "user_id": "<user_id>",
  "scope": "kimi-code",
  "token_id": "<uuid>",
  "device_id": "<uuid-hex>",
  "type": "access",
  "exp": 1769629032,
  "nbf": 1769628132,
  "iat": 1769628132
}
```

### API Authentication

```
Authorization: Bearer <access_token>
```

OpenAI-compatible chat completions at `https://api.kimi.com/coding/v1`.

## Implementation Plan

### Files to Create

#### 1. `src/providers/kimi-code-oauth.ts`

Token refresh function, following the `qwen-portal-oauth.ts` pattern:

```ts
import type { OAuthCredentials } from "@mariozechner/pi-ai";

const KIMI_CODE_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

export async function refreshKimiCodeCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh?.trim()) {
    throw new Error("Kimi Code OAuth refresh token missing; re-authenticate.");
  }

  const host = process.env.KIMI_CODE_OAUTH_HOST || KIMI_CODE_OAUTH_HOST;

  const response = await fetch(`${host}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...kimiDeviceHeaders(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: KIMI_CODE_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Kimi Code OAuth refresh token expired or revoked. Re-authenticate with ` +
        `\`moltbot onboard --auth-choice kimi-code-oauth\`.`
      );
    }
    throw new Error(`Kimi Code OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Kimi Code OAuth refresh response missing access token.");
  }

  return {
    ...credentials,
    access: payload.access_token,
    refresh: payload.refresh_token || credentials.refresh,
    expires: Date.now() + payload.expires_in * 1000,
  };
}
```

### Files to Modify

#### 2. `src/agents/auth-profiles/oauth.ts`

Add `kimi-code` to the refresh dispatch in `refreshOAuthTokenWithLock`:

```ts
import { refreshKimiCodeCredentials } from "../../providers/kimi-code-oauth.js";

// In refreshOAuthTokenWithLock, extend the dispatch:
const result =
  String(cred.provider) === "chutes"
    ? await (async () => { /* existing */ })()
    : String(cred.provider) === "qwen-portal"
      ? await (async () => { /* existing */ })()
      : String(cred.provider) === "kimi-code"
        ? await (async () => {
            const newCredentials = await refreshKimiCodeCredentials(cred);
            return { apiKey: newCredentials.access, newCredentials };
          })()
        : await getOAuthApiKey(cred.provider as OAuthProvider, oauthCreds);
```

#### 3. Onboarding: `src/commands/onboard-non-interactive/local/auth-choice.ts`

Add `kimi-code-oauth` auth choice alongside existing `kimi-code-api-key`:

- **Option A: Import from Kimi CLI** (recommended default)
  - Read `~/.kimi/credentials/kimi-code.json`
  - Convert to Moltbot's `OAuthCredential` format
  - Store as `kimi-code:default` profile with `type: "oauth"`
  
- **Option B: Full device auth flow**
  - Implement device authorization polling (like Anthropic OAuth)
  - Open browser for user verification
  - Store tokens on success

Import approach (Option A):
```ts
// Read from Kimi CLI credential store
const kimiCredPath = path.join(os.homedir(), ".kimi", "credentials", "kimi-code.json");
const raw = JSON.parse(fs.readFileSync(kimiCredPath, "utf-8"));
const credential: OAuthCredential = {
  type: "oauth",
  provider: "kimi-code",
  access: raw.access_token,
  refresh: raw.refresh_token,
  expires: raw.expires_at * 1000, // Kimi uses seconds, Moltbot uses ms
};
```

#### 4. Auth choice options: `src/commands/auth-choice-options.ts`

Add new option:
```ts
options.push({ value: "kimi-code-oauth", label: "Kimi Code (OAuth — import from Kimi CLI)" });
```

#### 5. Config types: `src/config/types.auth.ts`

No changes needed — existing `OAuthCredential` type supports arbitrary providers.

#### 6. Model auth: `src/agents/model-auth.ts`

Add `kimi-code` to the env key map (already exists for API key):
```ts
"kimi-code": "KIMICODE_API_KEY", // fallback if no OAuth profile
```

#### 7. Provider config: `src/agents/models-config.providers.ts`

Update to prefer OAuth profile over env API key:
```ts
const kimiCodeKey =
  resolveApiKeyFromOAuthProfile({ provider: "kimi-code", store: authStore }) ??
  resolveEnvApiKeyVarName("kimi-code") ??
  resolveApiKeyFromProfiles({ provider: "kimi-code", store: authStore });
```

### Auth Profile Store Entry

After login, the profile store (`~/.clawdbot/auth-store.json`) contains:

```json
{
  "kimi-code:default": {
    "type": "oauth",
    "provider": "kimi-code",
    "access": "<jwt-access-token>",
    "refresh": "<jwt-refresh-token>",
    "expires": 1769629032920
  }
}
```

Config auth profile declaration:
```json
{
  "auth": {
    "profiles": {
      "kimi-code:default": {
        "provider": "kimi-code",
        "mode": "oauth"
      }
    }
  }
}
```

## Credential Sharing with Kimi CLI

### Problem

Both Moltbot and Kimi CLI will refresh tokens independently, potentially invalidating each other's access tokens.

### Options

1. **Separate credentials** (simplest) — Moltbot maintains its own OAuth session. Both tools can be logged in simultaneously with separate device IDs. Kimi's OAuth likely supports multiple device sessions.

2. **Read from Kimi CLI on startup, write back on refresh** — Shared credential file. Requires file locking. Fragile.

3. **Import once, then independent** — Moltbot imports the initial refresh token but generates its own access tokens. If Moonshot allows concurrent sessions per refresh token, this works. If not, the first refresh from either side invalidates the other's refresh token.

**Recommendation:** Option 1 (separate credentials). On first `moltbot onboard --auth-choice kimi-code-oauth`, run the full device auth flow with Moltbot's own device ID. This creates a separate session on Moonshot's side. Clean, no conflicts.

Import from Kimi CLI (Option A in onboarding) can be offered as a convenience shortcut, with a note that it may conflict with active Kimi CLI sessions if the server enforces single-session refresh tokens.

## CLI Commands

```bash
# New auth choice
moltbot onboard --auth-choice kimi-code-oauth

# Or interactive
moltbot onboard
# → Select: "Kimi Code (OAuth)"
# → Opens browser for device authorization
# → Polls for token
# → Stores in auth profile store
```

## Provider Config Output

After successful onboarding:

```json5
{
  auth: {
    profiles: {
      "kimi-code:default": {
        provider: "kimi-code",
        mode: "oauth"
      }
    }
  },
  models: {
    providers: {
      "kimi-code": {
        baseUrl: "https://api.kimi.com/coding/v1",
        // apiKey resolved from OAuth profile at runtime
        api: "openai-completions",
        models: [
          {
            id: "kimi-for-coding",
            name: "Kimi For Coding",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32768,
            headers: { "User-Agent": "KimiCLI/0.77" },
            compat: { supportsDeveloperRole: false }
          }
        ]
      }
    }
  }
}
```

## Scope

### In Scope
- Token refresh function (`kimi-code-oauth.ts`)
- OAuth dispatch in auth profiles
- `kimi-code-oauth` onboarding auth choice (device auth flow)
- Optional: import from Kimi CLI credentials

### Out of Scope
- Background token refresh daemon (existing refresh-on-use is sufficient)
- Kimi CLI credential sharing/sync
- Moonshot Open Platform OAuth (different service, API-key-only)

## Testing

1. **Unit test:** `refreshKimiCodeCredentials` with mocked HTTP
2. **Integration test:** Full device auth flow (manual — requires browser)
3. **E2E:** Onboard with `kimi-code-oauth`, run a chat completion, verify token refresh works across sessions

## Live Testing Results (2026-01-28)

### Verified Working
- ✅ Token refresh via `auth.kimi.com/api/oauth/token` (no device headers needed)
- ✅ API calls to `api.kimi.com/coding/v1/chat/completions`
- ✅ Vulkan agent running on `kimi-code/kimi-for-coding` through Moltbot
- ✅ Background token refresh script keeping credentials alive

### Required Headers for API Calls
Kimi Code **rejects requests** (403) without coding agent identification headers:

```json
{
  "User-Agent": "KimiCLI/0.77",
  "X-Msh-Platform": "kimi_cli"
}
```

These are already built into Moltbot's `buildKimiCodeProvider()` via `KIMI_CODE_HEADERS`. When using manual provider config overrides, these must be included at the **model level** (not provider level).

### Required Compat Flag
Kimi Code does not support the `developer` role (returns `400 unsupported role ROLE_UNSPECIFIED`):

```json
{ "compat": { "supportsDeveloperRole": false } }
```

Already built into `KIMI_CODE_COMPAT` in `buildKimiCodeProvider()`.

### Single-Use Refresh Tokens
⚠️ Kimi uses **single-use refresh tokens**. Each refresh invalidates the old refresh token and returns a new one. The refresh function correctly persists the new token, but manual `curl` testing of the refresh endpoint will burn the token if the new one isn't saved.

## References

- Kimi CLI OAuth source: `~/.local/share/uv/tools/kimi-cli/lib/python3.13/site-packages/kimi_cli/auth/oauth.py`
- Moltbot Qwen portal OAuth (closest pattern): `src/providers/qwen-portal-oauth.ts`
- Moltbot auth profiles: `src/agents/auth-profiles/oauth.ts`
- Moltbot provider docs: `docs/providers/moonshot.md`
