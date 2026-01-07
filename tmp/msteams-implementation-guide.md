# MS Teams Provider Implementation Guide (Clawdbot)

Practical implementation notes for adding `msteams` as a new provider to Clawdbot.

This document is written to match **this repo’s actual conventions** (verified against `src/` as of 2026-01-07), and to be used as an implementation checklist.

---

## 0) Scope / MVP

**MVP (recommended first milestone)**

- Inbound: receive DMs + channel mentions via Bot Framework webhook.
- Outbound: reply in the same conversation (and optionally proactive follow-ups) using the **Bot Framework connector** (not Graph message-post).
- Basic media inbound: download Teams file attachments when possible; outbound media: send link (or Adaptive Card image) initially.
- DM security: reuse existing Clawdbot `dmPolicy` + pairing store behavior.

**Nice-to-have**

- Rich cards (Adaptive Cards), message update/delete, reactions, channel-wide (non-mention) listening, proactive app installation via Graph, meeting chat support, multi-bot accounts.

---

## 1) Repo Conventions (Verified)

### 1.1 Provider layout

Most providers live in `src/<provider>/` and follow the Slack/Discord pattern:

```
src/slack/
├── index.ts
├── monitor.ts
├── monitor.test.ts
├── monitor.tool-result.test.ts
├── send.ts
├── actions.ts
├── token.ts
└── probe.ts
```

Notes:

- WhatsApp (web) is the exception: it’s split across `src/providers/web/` and shared helpers in `src/web/`.
- Providers often include extra helpers (`webhook.ts`, `client.ts`, `targets.ts`, `daemon.ts`, etc.) when needed (see `src/telegram/`, `src/signal/`, `src/imessage/`).

### 1.2 Monitor pattern & message pipeline

Inbound providers ultimately build a `ctx` payload and call the shared pipeline:

- `dispatchReplyFromConfig()` (auto-reply) + `createReplyDispatcherWithTyping()` (provider typing indicator).
- `resolveAgentRoute()` for session key + agent routing.
- `enqueueSystemEvent()` for human-readable “what happened” logging.
- Pairing gates via `readProviderAllowFromStore()` and `upsertProviderPairingRequest()` for `dmPolicy=pairing`.

A minimal (but accurate) sequence looks like:

1. Validate activity (ignore bot echoes; ignore edits unless you want system events).
2. Resolve peer identity + chat type + routing (`resolveAgentRoute()`).
3. Apply access policy: DM policy + allowFrom/pairing; channel allowlist/mention requirements.
4. Download attachments (bounded by `mediaMaxMb`).
5. Build `ctx` envelope (matches other providers’ field names).
6. Dispatch reply through `dispatchReplyFromConfig()`.

### 1.3 Gateway lifecycle

Providers started by the gateway are managed in:

- `src/gateway/server-providers.ts` (start/stop + runtime snapshot)
- `src/gateway/server.ts` (logger + `runtimeForLogger()` wiring)
- `src/gateway/config-reload.ts` (restart rules + provider kind union)
- `src/gateway/server-methods/providers.ts` (status endpoint)

### 1.4 Outbound delivery plumbing (easy to miss)

The CLI + gateway send paths share outbound helpers:

- `src/infra/outbound/targets.ts` (validates `--to` per provider)
- `src/infra/outbound/deliver.ts` (chunking + send abstraction)
- `src/infra/outbound/format.ts` (summaries / JSON)
- `src/gateway/server-methods/send.ts` (gateway “send” supports multiple providers)
- `src/commands/send.ts` + `src/cli/deps.ts` (direct CLI send wiring)

### 1.5 Pairing integration points

Adding a new provider that supports `dmPolicy=pairing` requires:

- `src/pairing/pairing-store.ts` (extend `PairingProvider`)
- `src/cli/pairing-cli.ts` (provider list + optional notify-on-approve)

### 1.6 UI surfaces

The local web UI has explicit provider forms + unions:

- `ui/src/ui/app.ts` (state + forms per provider)
- `ui/src/ui/types.ts` and `ui/src/ui/ui-types.ts` (provider unions)
- `ui/src/ui/controllers/connections.ts` (load/save config per provider)

If we add `msteams`, the UI must be updated alongside backend config/types.

---

## 2) 2025/2026 Microsoft Guidance (What Changed)

### 2.1 Microsoft 365 Agents SDK (Recommended)

**UPDATE (2026-01):** The Bot Framework SDK (`botbuilder`) was deprecated in December 2025. We now use the **Microsoft 365 Agents SDK** which is the official replacement:

```bash
pnpm add @microsoft/agents-hosting @microsoft/agents-hosting-express @microsoft/agents-hosting-extensions-teams
```

The new SDK uses:
- `ActivityHandler` with fluent API for handling activities
- `startServer()` from `@microsoft/agents-hosting-express` for Express integration
- `AuthConfiguration` with `clientId`, `clientSecret`, `tenantId` (new naming)

Package sizes (for reference):
- `@microsoft/agents-hosting`: ~1.4 MB
- `@microsoft/agents-hosting-express`: ~12 KB
- `@microsoft/agents-hosting-extensions-teams`: ~537 KB (optional, for Teams-specific features)

### 2.2 Proactive messaging is required for “slow” work

Teams delivers messages via **HTTP webhook**. If we block the request while waiting on an LLM run, we risk:

- gateway timeouts,
- Teams retries (duplicate inbound),
- or dropped replies.

Best practice for long-running work is:

- capture a `ConversationReference`,
- **return quickly**,
- then send replies later via proactive messaging (`continueConversationAsync` in CloudAdapter).

### 2.3 SDK Migration Complete

We are using the **Microsoft 365 Agents SDK** (`@microsoft/agents-hosting` v1.1.1+) as the primary SDK. The deprecated Bot Framework SDK (`botbuilder`) is NOT used.

GitHub: https://github.com/Microsoft/Agents-for-js

### 2.4 Deprecations / platform shifts to note

- Creation of **new multi-tenant bots** has been announced as deprecated after **2025-07-31** (plan for **single-tenant** by default).
- Office 365 connectors / incoming webhooks retirement has been extended to **2026-03-31** (don't build a provider around incoming webhooks; use bots).

---

## 2.5) Azure Bot Setup (Prerequisites)

Before writing code, set up the Azure Bot resource. This gives you the credentials needed for config.

### Step 1: Create Azure Bot

1. Go to [Create Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot) (direct link)

2. **Basics tab - Project details:**

   | Field | Value |
   |-------|-------|
   | **Bot handle** | Your bot name, e.g., `clawdbot-msteams` (must be unique) |
   | **Subscription** | Select your Azure subscription |
   | **Resource group** | Create new or use existing (e.g., `Bots`) |
   | **New resource group location** | Choose nearest region (e.g., `West Europe`) |
   | **Data residency** | **Regional** (recommended for GDPR compliance) or Global |
   | **Region** | Same as resource group location |

3. **Basics tab - Pricing:**

   | Field | Value |
   |-------|-------|
   | **Pricing tier** | **Free** for dev/testing, Standard for production |

4. **Basics tab - Microsoft App ID:**

   | Field | Value |
   |-------|-------|
   | **Type of App** | **Single Tenant** (recommended - multi-tenant deprecated after 2025-07-31) |
   | **Creation type** | **Create new Microsoft App ID** |
   | **Service management reference** | Leave empty |

   > **Note:** Single Tenant requires BotFramework SDK 4.15.0 or higher (we'll use 4.23+)

5. Click **Review + create** → **Create** and wait for deployment (~1-2 minutes)

### Step 2: Get Credentials

After the bot is created:

1. Go to your Azure Bot resource → **Configuration**
2. Copy **Microsoft App ID** → this is your `appId`
3. Click "Manage Password" → go to the App Registration
4. Under **Certificates & secrets** → New client secret → copy the **Value** → this is your `appPassword`
5. Go to **Overview** → copy **Directory (tenant) ID** → this is your `tenantId`

### Step 3: Configure Messaging Endpoint

1. In Azure Bot → **Configuration**
2. Set **Messaging endpoint** to your webhook URL:
   - Production: `https://your-domain.com/msteams/messages`
   - Local dev: Use a tunnel (see below)

### Step 4: Enable Teams Channel

1. In Azure Bot → **Channels**
2. Click **Microsoft Teams** → Configure → Save
3. Accept the Terms of Service

### Step 5: Local Development (Tunnel)

Teams can't reach `localhost`. Options:

**Option A: ngrok**
```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/msteams/messages
```

**Option B: Tailscale Funnel**
```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

### Step 6: Create Teams App (for installation)

To install the bot in Teams, you need an app manifest:

1. Create `manifest.json`:
```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "<your-app-id-guid>",
  "packageName": "com.clawdbot.msteams",
  "developer": {
    "name": "Your Name",
    "websiteUrl": "https://clawd.bot",
    "privacyUrl": "https://clawd.bot/privacy",
    "termsOfUseUrl": "https://clawd.bot/terms"
  },
  "name": { "short": "Clawdbot", "full": "Clawdbot MS Teams" },
  "description": { "short": "AI assistant", "full": "Clawdbot AI assistant for Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#FF4500",
  "bots": [
    {
      "botId": "<your-microsoft-app-id>",
      "scopes": ["personal", "team", "groupChat"],
      "supportsFiles": true,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

2. Add 32x32 `outline.png` and 192x192 `color.png` icons
3. Zip all three files into `clawdbot-teams.zip`
4. In Teams → Apps → Manage your apps → Upload a custom app → Upload `clawdbot-teams.zip`

### Step 7: Test the Bot

**Option A: Azure Web Chat (verify webhook first)**

1. Go to Azure Portal → your Azure Bot resource
2. Click **Test in Web Chat** (left sidebar)
3. Send a message - you should see the echo response
4. This confirms your webhook endpoint is working before Teams setup

**Option B: Teams Developer Portal (easier than manual manifest)**

1. Go to https://dev.teams.microsoft.com/apps
2. Click **+ New app**
3. Fill in basic info:
   - **Short name**: Clawdbot
   - **Full name**: Clawdbot MS Teams
   - **Short description**: AI assistant
   - **Full description**: Clawdbot AI assistant for Teams
   - **Developer name**: Your Name
   - **Website**: https://clawd.bot (or any URL)
4. Go to **App features** → **Bot**
5. Select **Enter a bot ID manually**
6. Paste your App ID: `49930686-61cb-44fd-a847-545d3f3fb638` (your Azure Bot's Microsoft App ID)
7. Check scopes: **Personal** (for DMs), optionally **Team** and **Group Chat**
8. Save
9. Click **Distribute** (upper right) → **Download app package** (downloads a .zip)
10. In Teams desktop/web:
    - Click **Apps** (left sidebar)
    - Click **Manage your apps**
    - Click **Upload an app** → **Upload a custom app**
    - Select the downloaded .zip file
11. Click **Add** to install the bot
12. Open a chat with the bot and send a message

### Credentials Summary

After setup, you'll have:

| Config Field | Source |
|--------------|--------|
| `appId` | Azure Bot → Configuration → Microsoft App ID |
| `appPassword` | App Registration → Certificates & secrets → Client secret value |
| `tenantId` | App Registration → Overview → Directory (tenant) ID |

Add these to your Clawdbot config:
```yaml
msteams:
  enabled: true
  appId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  appPassword: "your-client-secret"
  tenantId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  webhook:
    port: 3978
    path: /msteams/messages
```

### Useful Links

- [Azure Portal](https://portal.azure.com)
- [Teams Developer Portal](https://dev.teams.microsoft.com/apps) - create/manage Teams apps
- [Create Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration)
- [Bot Framework Overview](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-overview)
- [Create Teams Bot](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/create-a-bot-for-teams)
- [Teams App Manifest Schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [ngrok](https://ngrok.com) - local dev tunneling
- [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) - alternative tunnel

---

## 3) Recommended Architecture for Clawdbot

### 3.1 Use Bot Framework for both receive + send

Avoid “Graph API sendMessage” as the default path. For Teams, **posting chat/channel messages via Graph** is heavily constrained (often delegated-only and/or policy-restricted), while bots can reliably send messages in the conversations where they’re installed.

**Key idea:** treat Teams as a “bot conversation provider”:

- Receive activity via webhook.
- Reply (and send follow-ups) via the connector using the stored conversation reference.

### 3.2 Run a dedicated webhook server inside the provider monitor

This matches how Telegram webhooks are done (`src/telegram/webhook.ts`): the provider can run its own HTTP server on a configured port/path.

This avoids entangling the Teams webhook with the gateway HTTP server routes and lets users expose only the Teams webhook port if desired.

### 3.3 Explicitly store conversation references

To send proactive replies (or to support `clawdbot send --provider msteams ...`), we need a small store that maps a stable key to a `ConversationReference`.

Recommendation:

- Key by `conversation.id` (works for DMs, group chats, channels).
- Also store `tenantId`, `serviceUrl`, and useful labels (team/channel name when available) for debugging and allowlists.

---

## 4) Configuration Design

### 4.1 Proposed `msteams` config block

Suggested shape (mirrors Slack/Discord style + existing `DmPolicy` and `GroupPolicy`):

```ts
export type MSTeamsConfig = {
  enabled?: boolean;

  // Bot registration (Azure Bot / Entra app)
  appId?: string; // Entra app (bot) ID
  appPassword?: string; // secret
  tenantId?: string; // recommended: single tenant
  appType?: "singleTenant" | "multiTenant"; // default: singleTenant

  // Webhook listener (provider-owned HTTP server)
  webhook?: {
    host?: string; // default: 0.0.0.0
    port?: number; // default: 3978 (Bot Framework conventional)
    path?: string; // default: /msteams/messages
  };

  // Access control
  dm?: {
    enabled?: boolean;
    policy?: DmPolicy; // pairing|open|disabled
    allowFrom?: Array<string | number>; // allowlist for open/allowlist-like flows
  };
  groupPolicy?: GroupPolicy; // open|disabled|allowlist
  channels?: Record<
    string,
    {
      enabled?: boolean;
      requireMention?: boolean;
      users?: Array<string | number>;
      skills?: string[];
      systemPrompt?: string;
    }
  >;

  // Limits
  textChunkLimit?: number;
  mediaMaxMb?: number;
};
```

### 4.2 Env var conventions

To match repo patterns and Microsoft docs, support both:

- Clawdbot-style: `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`
- Bot Framework defaults: `MicrosoftAppId`, `MicrosoftAppPassword`, `MicrosoftAppTenantId`, `MicrosoftAppType`

Resolution order should follow other providers: `opts > env > config`.

---

## 5) File/Module Plan (`src/msteams/`)

Recommended structure (intentionally similar to Slack, with Teams-specific extras):

```
src/msteams/
├── index.ts
├── token.ts
├── monitor.ts
├── webhook.ts              # Express server + CloudAdapter.process
├── conversation-store.ts   # Persist ConversationReference by conversation.id
├── send.ts                 # Proactive send via adapter.continueConversationAsync
├── attachments.ts          # Download helpers for Teams attachment types
├── probe.ts                # Basic credential check (optional)
├── monitor.test.ts
└── monitor.tool-result.test.ts
```

---

## 6) Concrete Code Examples

These are not drop-in (because `botbuilder` isn’t currently a dependency in this repo), but they’re written in the style of existing providers.

### 6.1 `src/msteams/token.ts` (credential resolution)

```ts
export type ResolvedMSTeamsCreds = {
  appId: string | null;
  appPassword: string | null;
  tenantId: string | null;
  appType: "singleTenant" | "multiTenant";
  source: {
    appId: "opts" | "env" | "config" | "missing";
    appPassword: "opts" | "env" | "config" | "missing";
  };
};

export function resolveMSTeamsCreds(
  cfg: { msteams?: { appId?: string; appPassword?: string; tenantId?: string; appType?: string } },
  opts?: { appId?: string; appPassword?: string; tenantId?: string; appType?: string },
): ResolvedMSTeamsCreds {
  const env = process.env;
  const appId =
    opts?.appId?.trim() ||
    env.MSTEAMS_APP_ID?.trim() ||
    env.MicrosoftAppId?.trim() ||
    cfg.msteams?.appId?.trim() ||
    null;
  const appPassword =
    opts?.appPassword?.trim() ||
    env.MSTEAMS_APP_PASSWORD?.trim() ||
    env.MicrosoftAppPassword?.trim() ||
    cfg.msteams?.appPassword?.trim() ||
    null;
  const tenantId =
    opts?.tenantId?.trim() ||
    env.MSTEAMS_TENANT_ID?.trim() ||
    env.MicrosoftAppTenantId?.trim() ||
    cfg.msteams?.tenantId?.trim() ||
    null;

  const appTypeRaw =
    (opts?.appType || env.MicrosoftAppType || cfg.msteams?.appType || "")
      .trim()
      .toLowerCase();
  const appType =
    appTypeRaw === "multitenant" || appTypeRaw === "multi-tenant"
      ? "multiTenant"
      : "singleTenant";

  return {
    appId,
    appPassword,
    tenantId,
    appType,
    source: {
      appId: opts?.appId
        ? "opts"
        : env.MSTEAMS_APP_ID || env.MicrosoftAppId
          ? "env"
          : cfg.msteams?.appId
            ? "config"
            : "missing",
      appPassword: opts?.appPassword
        ? "opts"
        : env.MSTEAMS_APP_PASSWORD || env.MicrosoftAppPassword
          ? "env"
          : cfg.msteams?.appPassword
            ? "config"
            : "missing",
    },
  };
}
```

### 6.2 `src/msteams/webhook.ts` (Express + CloudAdapter)

Key best-practice points:

- `adapter.process(...)` requires JSON middleware (parsed `req.body`).
- Keep request handling fast; offload long work to proactive sends.

```ts
import express from "express";
import type { Server } from "node:http";
import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
} from "botbuilder";
import type { RuntimeEnv } from "../runtime.js";

export async function startMSTeamsWebhook(opts: {
  host: string;
  port: number;
  path: string;
  runtime: RuntimeEnv;
  onTurn: (adapter: CloudAdapter) => (turnContext: unknown) => Promise<void>;
}) {
  const runtime = opts.runtime;
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
    process.env,
  );
  const adapter = new CloudAdapter(botFrameworkAuthentication);

  app.get("/healthz", (_req, res) => res.status(200).send("ok"));
  app.post(opts.path, async (req, res) => {
    await adapter.process(req, res, async (turnContext) => {
      await opts.onTurn(adapter)(turnContext);
    });
  });

  const server: Server = await new Promise((resolve) => {
    const srv = app.listen(opts.port, opts.host, () => resolve(srv));
  });

  runtime.log?.(
    `msteams webhook listening on http://${opts.host}:${opts.port}${opts.path}`,
  );
  return { adapter, server, stop: () => server.close() };
}
```

### 6.3 `src/msteams/monitor.ts` (proactive dispatch pattern)

This is the key “Clawdbot-specific” adaptation: don’t do the long LLM run inside the webhook turn.

```ts
import type { ConversationReference, TurnContext } from "botbuilder";
import { TurnContext as TurnContextApi } from "botbuilder";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import { loadConfig } from "../config/config.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import { saveConversationReference } from "./conversation-store.js";
import { startMSTeamsWebhook } from "./webhook.js";

export async function monitorMSTeamsProvider(opts: {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}) {
  const cfg = loadConfig();
  const runtime = opts.runtime;
  if (cfg.msteams?.enabled === false) return;

  const host = cfg.msteams?.webhook?.host ?? "0.0.0.0";
  const port = cfg.msteams?.webhook?.port ?? 3978;
  const path = cfg.msteams?.webhook?.path ?? "/msteams/messages";

  const seen = new Map<string, number>(); // activity de-dupe
  const ttlMs = 2 * 60_000;

  const { adapter, stop } = await startMSTeamsWebhook({
    host,
    port,
    path,
    runtime:
      runtime ?? { log: console.log, error: console.error, exit: process.exit as any },
    onTurn: (adapter) => async (ctxAny) => {
      const context = ctxAny as TurnContext;
      if (context.activity.type !== "message") return;
      if (
        !context.activity.text &&
        (!context.activity.attachments ||
          context.activity.attachments.length === 0)
      )
        return;

      const activity = context.activity;
      const convoId = activity.conversation?.id ?? "unknown";
      const activityId = activity.id ?? "unknown";
      const dedupeKey = `${convoId}:${activityId}`;
      const now = Date.now();
      for (const [key, ts] of seen) if (now - ts > ttlMs) seen.delete(key);
      if (seen.has(dedupeKey)) return;
      seen.set(dedupeKey, now);

      const reference: ConversationReference =
        TurnContextApi.getConversationReference(activity);
      saveConversationReference(convoId, reference).catch(() => {});

      // Kick off the long-running work without blocking the webhook request:
      void (async () => {
        const cfg = loadConfig();
        const route = resolveAgentRoute({
          cfg,
          provider: "msteams",
          teamId: (activity.channelData as any)?.team?.id ?? undefined,
          peer: {
            kind:
              (activity.conversation as any)?.conversationType === "channel"
                ? "channel"
                : "dm",
            id:
              (activity.from as any)?.aadObjectId ??
              activity.from?.id ??
              "unknown",
          },
        });

        enqueueSystemEvent(
          `Teams message: ${String(activity.text ?? "").slice(0, 160)}`,
          {
            sessionKey: route.sessionKey,
            contextKey: `msteams:message:${convoId}:${activityId}`,
          },
        );

        const appId =
          cfg.msteams?.appId ??
          process.env.MSTEAMS_APP_ID ??
          process.env.MicrosoftAppId ??
          "";

        const { dispatcher, replyOptions, markDispatchIdle } =
          createReplyDispatcherWithTyping({
            responsePrefix: cfg.messages?.responsePrefix,
            onReplyStart: async () => {
              // typing indicator
              await adapter.continueConversationAsync(appId, reference, async (ctx) => {
                await (ctx as any).sendActivity({ type: "typing" });
              });
            },
            deliver: async (payload) => {
              await adapter.continueConversationAsync(appId, reference, async (ctx) => {
                await (ctx as any).sendActivity(payload.text ?? "");
              });
            },
            onError: (err, info) => {
              runtime?.error?.(`msteams ${info.kind} reply failed: ${String(err)}`);
            },
          });

        const ctxPayload = {
          Provider: "msteams" as const,
          Surface: "msteams" as const,
          From: `msteams:${activity.from?.id ?? "unknown"}`,
          To: `conversation:${convoId}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType:
            (activity.conversation as any)?.conversationType === "channel"
              ? "room"
              : "direct",
          MessageSid: activityId,
          ReplyToId: activity.replyToId ?? activityId,
          Timestamp: activity.timestamp ? Date.parse(String(activity.timestamp)) : undefined,
          Body: String(activity.text ?? ""),
        };

        await dispatchReplyFromConfig({
          ctx: ctxPayload as any,
          cfg,
          dispatcher,
          replyOptions,
        });
        markDispatchIdle();
      })().catch((err) => runtime?.error?.(String(err)));
    },
  });

  const shutdown = () => stop();
  opts.abortSignal?.addEventListener("abort", shutdown, { once: true });
}
```

### 6.4 Attachment download (Teams file attachments)

Teams commonly sends file uploads as an attachment with content type:

- `application/vnd.microsoft.teams.file.download.info`

The `downloadUrl` is the URL to fetch (often time-limited). A minimal helper:

```ts
type TeamsFileDownloadInfo = {
  downloadUrl?: string;
  uniqueId?: string;
  fileType?: string;
};

export function resolveTeamsDownloadUrl(att: {
  contentType?: string;
  content?: unknown;
}): string | null {
  if (att.contentType !== "application/vnd.microsoft.teams.file.download.info")
    return null;
  const content = (att.content ?? {}) as TeamsFileDownloadInfo;
  const url = typeof content.downloadUrl === "string" ? content.downloadUrl.trim() : "";
  return url ? url : null;
}
```

Initial recommendation: support this type first; treat other attachment types as “link-only” until needed.

---

## 7) Integration Checklist (Files to Create/Modify)

### 7.1 New backend files

- `src/msteams/*` (new provider implementation; see structure above)

### 7.2 Backend integration points (must update)

**Config & validation**

- `src/config/types.ts` (add `MSTeamsConfig`; extend unions like `QueueModeByProvider`, `AgentElevatedAllowFromConfig`, `HookMappingConfig.provider`)
- `src/config/zod-schema.ts` (add schema + cross-field validation for `dm.policy="open"` → allowFrom includes `"*"`, etc.)
- `src/config/schema.ts` (labels + descriptions used by tooling/UI)

**Gateway provider lifecycle**

- `src/gateway/server-providers.ts` (runtime status + start/stop + snapshot)
- `src/gateway/server.ts` (logger + runtime env wiring)
- `src/gateway/config-reload.ts` (provider kind union + reload rules)
- `src/gateway/server-methods/providers.ts` (status payload)
- `src/infra/provider-summary.ts` (optional but recommended: show “Teams configured” in `clawdbot status`)

**Outbound sending**

- `src/infra/outbound/targets.ts` (validate `--to` format for Teams)
- `src/infra/outbound/deliver.ts` (provider caps + handler + result union)
- `src/infra/outbound/format.ts` (optional: add more metadata fields)
- `src/commands/send.ts` (treat `msteams` as direct-send provider if we implement `sendMessageMSTeams`)
- `src/cli/deps.ts` (add `sendMessageMSTeams`)
- `src/gateway/server-methods/send.ts` (support `provider === "msteams"` for gateway sends)

**Pairing**

- `src/pairing/pairing-store.ts` (add `"msteams"` to `PairingProvider`)
- `src/cli/pairing-cli.ts` (include provider in CLI; decide whether `--notify` is supported for Teams)

**Onboarding wizard**

- `src/commands/onboard-types.ts` (add `"msteams"` to `ProviderChoice`)
- `src/commands/onboard-providers.ts` (collect appId/secret/tenant, write config, add primer notes)

**Hooks**

- `src/gateway/hooks.ts` (extend provider allowlist validation: `last|whatsapp|telegram|discord|slack|signal|imessage|msteams`)

**Docs**

- `docs/providers/msteams.md` (Mintlify link conventions apply under `docs/**`)

### 7.3 UI integration points

- `ui/src/ui/ui-types.ts` (provider unions)
- `ui/src/ui/types.ts` (gateway status typing)
- `ui/src/ui/controllers/connections.ts` (load/save `msteams` config)
- `ui/src/ui/app.ts` (form state, validation, UX)

---

## 8) MS Teams Gotchas (Plan for These)

1. **Webhook timeouts / retries**: don’t block the webhook while waiting on LLM output; send replies proactively and dedupe inbound activities.
2. **Proactive messaging requirements**: the app must be installed in the chat/team; and you need a valid conversation reference (or you must create a conversation).
3. **Threading**: channel replies often need `replyToId` to keep replies in-thread; verify behavior for channel vs chat and standardize.
4. **Mentions**: Teams message text includes `<at>...</at>`; strip bot mentions before sending to the agent and implement mention gating using `entities`.
5. **Attachment downloads**: file uploads commonly arrive as `file.download.info` with time-limited URLs; enforce `mediaMaxMb` and handle 403/expired URLs.
6. **Formatting limits**: Teams markdown is more limited than Slack; assume “plain text + links” for v1, and only later add Adaptive Cards.
7. **Tenant/admin restrictions**: many orgs restrict custom app install or bot scopes. Expect setup friction; document it clearly.
8. **Single-tenant default**: multi-tenant bot creation has a deprecation cutoff (2025-07-31); prefer single-tenant in config defaults and docs.
9. **Incoming webhooks retirement**: Office 365 connectors / incoming webhooks retirement has moved to 2026-03-31; don't rely on it as the primary integration surface.
10. **Team ID format mismatch**: The `groupId` query param in Teams URLs (e.g., `075b1d78-...`) is **NOT** the team ID used by the Bot Framework. Teams sends the team's conversation thread ID via `activity.channelData.team.id`. To get the correct IDs from URLs:

    **Team URL:**
    ```
    https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                        └────────────────────────────┘
                                        Team ID (URL-decode this)
    ```

    **Channel URL:**
    ```
    https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                          └─────────────────────────┘
                                          Channel ID (URL-decode this)
    ```

    **For config:**
    - Team ID = path segment after `/team/` (URL-decoded)
    - Channel ID = path segment after `/channel/` (URL-decoded)
    - **Ignore** the `groupId` query parameter

---

## 9) Receiving All Messages Without @Mentions (RSC Permissions)

By default, Teams bots only receive messages when:
- The bot is directly messaged (1:1 chat)
- The bot is @mentioned in a channel or group chat

To receive **all messages** in channels and group chats without requiring @mentions, you must configure **Resource-Specific Consent (RSC)** permissions in your app manifest.

### 9.1 Available RSC Permissions

| Permission | Scope | What it enables |
|------------|-------|-----------------|
| `ChannelMessage.Read.Group` | Team | Receive all channel messages in teams where app is installed |
| `ChatMessage.Read.Chat` | Chat | Receive all messages in group chats where app is installed |

**Important:** These are RSC (app-level) permissions, not Graph API permissions. They enable real-time webhook delivery, not historical message retrieval.

### 9.2 Manifest Configuration

Add the `webApplicationInfo` and `authorization` sections to your `manifest.json`:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "<your-app-id-guid>",
  "packageName": "com.clawdbot.msteams",
  "developer": {
    "name": "Your Name",
    "websiteUrl": "https://clawd.bot",
    "privacyUrl": "https://clawd.bot/privacy",
    "termsOfUseUrl": "https://clawd.bot/terms"
  },
  "name": { "short": "Clawdbot", "full": "Clawdbot MS Teams" },
  "description": { "short": "AI assistant", "full": "Clawdbot AI assistant for Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#FF4500",
  "bots": [
    {
      "botId": "<your-microsoft-app-id>",
      "scopes": ["personal", "team", "groupChat"],
      "supportsFiles": true,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": [],
  "webApplicationInfo": {
    "id": "<your-microsoft-app-id>",
    "resource": "https://RscPermission"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        {
          "name": "ChannelMessage.Read.Group",
          "type": "Application"
        },
        {
          "name": "ChatMessage.Read.Chat",
          "type": "Application"
        }
      ]
    }
  }
}
```

**Key points:**
- `webApplicationInfo.id` must match your bot's Microsoft App ID
- `webApplicationInfo.resource` should be `https://RscPermission`
- Both permissions are `type: "Application"` (not delegated)

### 9.3 Filtering @Mention Messages (If Needed)

If you want to respond differently to @mentions vs. regular messages, check the `entities` array:

```typescript
// Check if the bot was mentioned in the activity
function wasBotMentioned(activity: TeamsActivity): boolean {
  const botId = activity.recipient?.id;
  if (!botId) return false;
  const entities = activity.entities ?? [];
  return entities.some(
    (e) => e.type === "mention" && e.mentioned?.id === botId,
  );
}

// Usage in message handler
const mentioned = wasBotMentioned(activity);
if (mentioned) {
  // Direct response to @mention
} else {
  // Background listening - perhaps log or conditionally respond
}
```

### 9.4 Updating an Existing App

To add RSC permissions to an already-installed app:

1. Update your `manifest.json` with the `webApplicationInfo` and `authorization` sections
2. Increment the `version` field (e.g., `1.0.0` → `1.1.0`)
3. Re-zip the manifest with icons
4. **Option A (Teams Admin Center):**
   - Go to Teams Admin Center → Teams apps → Manage apps
   - Find your app → Upload new version
5. **Option B (Sideload):**
   - In Teams → Apps → Manage your apps → Upload a custom app
   - Upload the new zip (replaces existing installation)
6. **For team channels:** Reinstall the app in each team for permissions to take effect

### 9.5 RSC vs Graph API

| Capability | RSC Permissions | Graph API |
|------------|-----------------|-----------|
| **Real-time messages** | ✅ Via webhook | ❌ Polling only |
| **Historical messages** | ❌ No backfill | ✅ Can query history |
| **Setup complexity** | App manifest only | Requires admin consent + token flow |
| **Works offline** | ❌ Must be running | ✅ Query anytime |

**Bottom line:** RSC is for real-time listening; Graph API is for historical backfill. For a bot that needs to catch up on missed messages while it was offline, you would need Graph API with `ChannelMessage.Read.All` (requires admin consent).

### 9.6 Troubleshooting RSC

1. **Not receiving messages:** Verify `webApplicationInfo.id` matches your bot's App ID exactly
2. **Permissions not applied:** Re-upload the app and reinstall in the team/chat
3. **Admin blocked:** Some orgs restrict RSC permissions; check with IT admin
4. **Wrong scope:** `ChannelMessage.Read.Group` is for teams; `ChatMessage.Read.Chat` is for group chats
5. **"Something went wrong" on upload:** Upload via https://admin.teams.microsoft.com instead, open browser DevTools (F12), go to Network tab, and check the response body for the actual error message
6. **Icon file cannot be empty:** The manifest references icon files that are 0 bytes; create valid PNG icons (32x32 for outline, 192x192 for color)
7. **webApplicationInfo.Id already in use:** The app is still installed in another team/chat; find and uninstall it first, or wait for propagation delay (5-10 min)
8. **Sideload failing:** Try "Upload an app to your org's app catalog" instead of "Upload a custom app" - this uploads to the org catalog and often bypasses sideload restrictions

### 9.7 Reference Links

- [Receive all channel messages with RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [RSC permissions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Teams app manifest schema](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)

---

## 10) Historical Message Access via Graph API Proxy

### 10.1 Motivation

On Discord, Clawdbot delivers an excellent UX: users can ask "what did we discuss a year ago?" and the bot can search the entire message history. Even more basically, it can read messages sent while the bot was offline, so users don't have to repeat themselves when the bot comes back online.

Unfortunately, Teams lacks Discord's granular role-based permissions. To read any historical message via Graph API, you must request extremely broad permissions:

| Permission | Type | Scope |
|------------|------|-------|
| `ChannelMessage.Read.All` | Application | Read ALL channel messages in the entire tenant |
| `Chat.Read.All` | Application | Read ALL chats including DMs in the entire tenant |

Both require admin consent and grant access to **everything** - there's no way to limit to specific channels at the permission level.

This creates a trust decision for organizations:
- **Opt out**: Don't grant these permissions. Bot only works in real-time (RSC). Messages sent while offline are lost.
- **Opt in**: Grant broad permissions, gain powerful features (history search, offline catchup), but must trust the infrastructure completely.

For organizations that opt in, the recommended architecture ensures the bot can only access what it's explicitly configured for, even though the underlying token has broader access.

### 10.2 Architecture: Graph API Proxy Gateway

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Tenant                          │
│                                                             │
│  ┌─────────────┐     ┌──────────────┐     ┌─────────────┐  │
│  │   Clawdbot  │────▶│  Graph Proxy │────▶│  Graph API  │  │
│  │  (no token) │     │  (has token) │     │  (tenant)   │  │
│  └─────────────┘     └──────────────┘     └─────────────┘  │
│         │                   │                              │
│         │                   ▼                              │
│         │            ┌─────────────┐                       │
│         │            │  Allowlist  │                       │
│         │            │  Config     │                       │
│         │            └─────────────┘                       │
│         │                                                  │
│         ▼                                                  │
│  ┌─────────────┐                                           │
│  │   Teams     │  (real-time via RSC webhook)              │
│  └─────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

**Key principle:** The Graph API token (with tenant-wide access) lives in a separate proxy service, never in Clawdbot itself. Clawdbot requests messages through the proxy, which enforces an allowlist before fetching.

### 10.3 How It Works

1. **Graph Proxy** is a small service (Cloud Function, MCP server, or microservice)
2. It holds the `ChannelMessage.Read.All` / `Chat.Read.All` token
3. Clawdbot requests: `GET /messages?team=X&channel=Y&since=timestamp`
4. Proxy checks allowlist: "Is Clawdbot permitted to read channel Y?"
5. If allowed → fetch from Graph API, return messages
6. If denied → return 403 Forbidden, log the attempt

### 10.4 Proxy Allowlist Config

```yaml
graph_proxy:
  # Audit logging
  log_all_requests: true

  # Allowed teams/channels (explicit allowlist)
  allowed:
    - team: "075b1d78-d02e-42a1-8b3b-91724ce8fa64"
      channels:
        - "19:15bc31ae32f04f1c95a66921a98072e8@thread.tacv2"  # Zeno channel
        # Backend and General NOT listed = no access even though token could read them

  # Optional: rate limiting
  rate_limit:
    requests_per_minute: 60

  # Optional: max history depth
  max_history_days: 365
```

### 10.5 Security Benefits

| Benefit | Description |
|---------|-------------|
| **Token isolation** | Clawdbot never sees the Graph API token |
| **Explicit allowlist** | Only configured channels are accessible, despite broad token scope |
| **Centralized audit** | All access attempts logged in one place |
| **Defense in depth** | Code bugs in Clawdbot can't leak access to unauthorized channels |
| **Revocation** | Disable proxy = instant cutoff, no token rotation needed in Clawdbot |

### 10.6 Implementation Options

1. **MCP Server** - Clawdbot calls it as a tool; fits naturally into the agent architecture
2. **HTTP Microservice** - Simple REST API; can run as sidecar or separate deployment
3. **Cloud Function** - Serverless; scales to zero when not in use; easy to deploy

### 10.7 Example API Surface

```
GET  /api/messages?team={id}&channel={id}&since={timestamp}&limit={n}
GET  /api/messages?team={id}&channel={id}&before={timestamp}&limit={n}
GET  /api/search?team={id}&channel={id}&query={text}&limit={n}
```

All endpoints check allowlist before executing. Returns 403 if channel not in allowlist.

### 10.8 Graph API Endpoints (Reference)

The proxy would call these Microsoft Graph endpoints:

```
# List channel messages
GET /teams/{team-id}/channels/{channel-id}/messages

# List replies to a message
GET /teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies

# Get messages in a chat (for group chats, not channels)
GET /chats/{chat-id}/messages
```

See: [Microsoft Graph Messages API](https://learn.microsoft.com/en-us/graph/api/channel-list-messages)

### 10.9 When to Use This

| Scenario | Recommendation |
|----------|----------------|
| Small team, high trust | Maybe skip proxy, use config-based filtering in Clawdbot |
| Enterprise, compliance-sensitive | Use proxy pattern for audit trail and access control |
| Multi-tenant SaaS | Definitely use proxy; isolate customer tokens |
| Personal/hobbyist use | Real-time RSC is probably sufficient |

---

## 11) Private Channels

### 11.1 Bot Support in Private Channels

Historically, Microsoft Teams **did not allow** bots in private channels. This has been gradually changing, but limitations remain.

**Current state (late 2025):**

| Feature | Standard Channels | Private Channels |
|---------|-------------------|------------------|
| Bot installation | ✅ Yes | ⚠️ Limited |
| Real-time messages (webhook) | ✅ Yes | ⚠️ May not work |
| RSC permissions | ✅ Yes | ⚠️ May behave differently |
| @mentions | ✅ Yes | ⚠️ If bot is accessible |
| Graph API history | ✅ Yes | ✅ Yes (with permissions) |

### 11.2 Testing Private Channel Support

To verify if your bot works in private channels:

1. Create a private channel in a team where the bot is installed
2. Try @mentioning the bot - see if it receives the message
3. If RSC is enabled, try sending without @mention
4. Check gateway logs for incoming activity

### 11.3 Workarounds if Private Channels Don't Work

If the bot can't receive real-time messages in private channels:

1. **Use standard channels** for bot interactions
2. **Use DMs** - users can always message the bot directly
3. **Graph API Proxy** - can read private channel history if permissions are granted (requires `ChannelMessage.Read.All`)
4. **Shared channels** - cross-tenant shared channels may have different behavior

### 11.4 Graph API Access to Private Channels

The Graph API **can** access private channel messages with `ChannelMessage.Read.All`, even if the bot can't receive real-time webhooks. This means the proxy pattern (Section 10) works for private channel history.

```
GET /teams/{team-id}/channels/{private-channel-id}/messages
```

The channel ID for private channels follows the same format: `19:xxx@thread.tacv2`

### 11.5 Recommendations

| Use Case | Recommendation |
|----------|----------------|
| Need real-time bot interaction | Use standard channels or DMs |
| Need to search private channel history | Use Graph API Proxy |
| Compliance/audit of private channels | Graph API with `ChannelMessage.Read.All` |

**Note:** Microsoft continues to improve private channel support. Check the latest documentation if this is critical for your use case.

---

## References (Current as of 2026-01)

- Bot Framework (Node) CloudAdapter sample: https://raw.githubusercontent.com/microsoft/BotBuilder-Samples/main/samples/javascript_nodejs/02.echo-bot/index.js
- Teams proactive messaging overview: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
- Teams bot file uploads / downloadUrl attachments: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
- CloudAdapter proactive API (`continueConversationAsync`): https://raw.githubusercontent.com/microsoft/botbuilder-js/main/libraries/botbuilder-core/src/cloudAdapterBase.ts
- Microsoft 365 Agents SDK (Node/TS): https://raw.githubusercontent.com/microsoft/Agents-for-js/main/README.md
- Office 365 connectors retirement update: https://techcommunity.microsoft.com/blog/microsoftteamsblog/retirement-of-office-365-connectors-within-microsoft-teams/4369576

---

## Next Steps (Actionable Implementation Order)

### Completed (2026-01-07)

1. ✅ **Add SDK packages**: Microsoft 365 Agents SDK (`@microsoft/agents-hosting`, `@microsoft/agents-hosting-express`, `@microsoft/agents-hosting-extensions-teams`)
2. ✅ **Config plumbing**: `MSTeamsConfig` type + zod schema (`src/config/types.ts`, `src/config/zod-schema.ts`)
3. ✅ **Provider skeleton**: `src/msteams/` with `index.ts`, `token.ts`, `probe.ts`, `send.ts`, `monitor.ts`
4. ✅ **Gateway integration**: Provider manager start/stop wiring in `server-providers.ts` and `server.ts`
5. ✅ **Echo bot tested**: Verified end-to-end flow (Azure Bot → Tailscale → Gateway → SDK → Response)

### Debugging Notes

- **SDK listens on all paths**: The `startServer()` function responds to POST on any path (not just `/api/messages`), but Azure Bot default is `/api/messages`
- **SDK handles HTTP internally**: Custom logging in monitor.ts `log.debug()` doesn't show HTTP traffic - SDK processes requests before our handler
- **Tailscale Funnel**: Must be running separately (`tailscale funnel 3978`) - doesn't work well as background task
- **Auth errors (401)**: Expected when testing manually without Azure JWT - means endpoint is reachable

### Completed (2026-01-07 - Session 2)

6. ✅ **Agent dispatch (sync)**: Wired inbound messages to `dispatchReplyFromConfig()` - replies sent via `context.sendActivity()` within turn
7. ✅ **Typing indicator**: Added typing indicator support via `sendActivities([{ type: "typing" }])`
8. ✅ **Type system updates**: Added `msteams` to `TextChunkProvider`, `OriginatingChannelType`, and route-reply switch
9. ✅ **@mention stripping**: Strip `<at>...</at>` HTML tags from message text
10. ✅ **Session key fix**: Remove `;messageid=...` suffix from conversation ID
11. ✅ **Config reload**: Added msteams to `config-reload.ts` (ProviderKind, ReloadAction, RELOAD_RULES)
12. ✅ **Pairing support**: Added msteams to PairingProvider type
13. ✅ **Conversation store**: Created `src/msteams/conversation-store.ts` for storing ConversationReference
14. ✅ **DM policy**: Implemented DM policy check with pairing support (disabled/pairing/open/allowlist)

### Implementation Notes

**Current Approach (Synchronous):**
The current implementation sends replies synchronously within the Teams turn context. This works for quick responses but may timeout for slow LLM responses.

```typescript
// Current: Reply within turn context (src/msteams/monitor.ts)
const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
  deliver: async (payload) => {
    await deliverReplies({ replies: [payload], context });
  },
  onReplyStart: sendTypingIndicator,
});
await dispatchReplyFromConfig({ ctx: ctxPayload, cfg, dispatcher, replyOptions });
```

**Key Fields in ctxPayload:**
- `Provider: "msteams"` / `Surface: "msteams"`
- `From`: `msteams:<userId>` (DM) or `msteams:channel:<conversationId>` (channel)
- `To`: `user:<userId>` (DM) or `conversation:<conversationId>` (group/channel)
- `ChatType`: `"direct"` | `"group"` | `"room"` based on conversation type

**DM Policy:**
- `dmPolicy: "disabled"` - Drop all DMs
- `dmPolicy: "open"` - Allow all DMs
- `dmPolicy: "pairing"` (default) - Require pairing code approval
- `dmPolicy: "allowlist"` - Only allow from `allowFrom` list

### Remaining

15. **Proactive messaging**: For slow LLM responses, use stored ConversationReference to send async replies
16. **Outbound CLI/gateway sends**: Implement `sendMessageMSTeams` properly; wire `clawdbot send --provider msteams`
17. **Media**: Implement inbound attachment download and outbound strategy
18. **Docs + UI + Onboard**: Write `docs/providers/msteams.md`, add UI config form, update `clawdbot onboard`
19. ✅ **RSC documentation**: Added section 9 documenting how to receive all channel/chat messages without @mentions
