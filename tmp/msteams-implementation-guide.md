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

### 2.1 Bot Framework SDK v4 “modern” baseline (Node)

For Node bots, Microsoft’s maintained samples now use:

- `CloudAdapter` + `ConfigurationBotFrameworkAuthentication` (instead of older adapter patterns)
- Express/Restify middleware to parse JSON into `req.body` before `adapter.process(...)`

CloudAdapter’s request processing explicitly requires parsed JSON bodies (it will 400 if `req.body` isn’t an object).

### 2.2 Proactive messaging is required for “slow” work

Teams delivers messages via **HTTP webhook**. If we block the request while waiting on an LLM run, we risk:

- gateway timeouts,
- Teams retries (duplicate inbound),
- or dropped replies.

Best practice for long-running work is:

- capture a `ConversationReference`,
- **return quickly**,
- then send replies later via proactive messaging (`continueConversationAsync` in CloudAdapter).

### 2.3 Microsoft 365 Agents SDK exists (potential future path)

Microsoft is actively building the **Microsoft 365 Agents SDK** (Node/TS) which positions itself as a replacement for parts of Bot Framework (`botbuilder`) for Teams and other channels.

Practical implication for Clawdbot:

- **Ship v1 with Bot Framework** (most stable, most docs, matches Teams docs),
- but structure our MS Teams provider so it can be swapped to Agents SDK later (thin adapter boundary around “receive activity” + “send activity”).

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
9. **Incoming webhooks retirement**: Office 365 connectors / incoming webhooks retirement has moved to 2026-03-31; don’t rely on it as the primary integration surface.

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

1. **Pick SDK + add deps**: start with Bot Framework (`botbuilder`) unless you’re ready to bet on Agents SDK; add packages + types in `package.json`.
2. **Config plumbing**: add `msteams` types + zod schema + schema metadata (`src/config/types.ts`, `src/config/zod-schema.ts`, `src/config/schema.ts`).
3. **Provider skeleton**: add `src/msteams/index.ts`, `token.ts`, and a stub `monitor.ts` that starts/stops cleanly (abortSignal).
4. **Webhook + echo**: implement `webhook.ts` + minimal activity handler that logs inbound text and sends a fast “ok” reply (no agent yet).
5. **Conversation store**: persist `ConversationReference` by `conversation.id` and include tenant/serviceUrl; add a small unit test.
6. **Agent dispatch (async)**: wire inbound messages to `dispatchReplyFromConfig()` using proactive sends (`continueConversationAsync`) to avoid webhook timeouts.
7. **Access control**: implement DM policy + pairing (reuse existing pairing store) + mention gating in channels.
8. **Gateway integration**: add provider manager start/stop/status wiring + config reload rules + hook provider allowlist; ensure gateway status UI reflects it.
9. **Outbound CLI/gateway sends**: add `sendMessageMSTeams` that targets stored conversation IDs; wire `clawdbot send --provider msteams`.
10. **Media**: implement inbound attachment download for `file.download.info` and a safe outbound strategy (link-only first, cards later).
11. **Docs + UI + Onboard**: write `docs/providers/msteams.md`, add a minimal UI config form (appId/secret/tenant + webhook port/path), and update `clawdbot onboard` provider selection.
12. **Hardening**: add dedupe TTL tuning, better error reporting, probe/health endpoints, and integration tests (`monitor.tool-result.test.ts`).
