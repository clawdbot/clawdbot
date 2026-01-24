# Migration Plan: Moving Twitch Plugin to Clawdbot Core

> **Source Reference**
> - **Original Plugin Directory:** `/Users/jayden/projects/clawdbot-twitch.tidyup`
> - **Original Branch:** `tidyup`
> - **Created By:** Claude (Sonnet 4.5) on 2026-01-24
> - **Issue:** External plugin cannot dispatch inbound messages to Clawdbot's agent system

---

## Problem Statement

The Twitch plugin is currently an **external plugin** that cannot dispatch inbound messages to Clawdbot's agent system because:

1. External plugins don't have access to `dispatchInboundMessage` from the core
2. The `ChannelGatewayContext` doesn't provide a message dispatch mechanism
3. Only core channels (built into Clawdbot) can properly route inbound messages

## Solution

Move the Twitch plugin into **Clawdbot core** as a built-in channel, following the same pattern as Discord, WhatsApp, Telegram, etc.

---

## Files in External Plugin (to be migrated)

```
src/
├── actions.ts           # Message action handlers
├── config.ts            # Account config resolution
├── outbound.ts          # Outbound message adapter
├── plugin.ts            # Main plugin definition (twitchPlugin)
├── plugin-sdk.ts        # ❌ DELETE - duplicated types, use core instead
├── probe.ts             # Connection probing
├── resolver.ts          # Username -> user ID resolution
├── send.ts              # Send message functions
├── status.ts            # Status issues collection
├── twitch-client.ts     # Twitch IRC client wrapper
├── types.ts             # ❌ DELETE - mostly duplicated types
├── index.ts             # ❌ DELETE - plugin wrapper, not needed for core
├── access-control.ts    # Access control (allowlist, roles)
├── cli/
│   └── test-connect.ts  # CLI command for testing
└── utils/
    ├── markdown.ts      # Markdown stripping for Twitch
    └── twitch.ts        # Twitch utilities

Tests (all need migration):
├── *.test.ts            # All test files
```

---

## Detailed Migration Steps

### Phase 1: Preparation & Analysis

#### 1.1 Audit Duplicated Types
**Status: ✅ Complete**

The following files contain duplicated types that should be removed and imported from core:

- **`plugin-sdk.ts`** - Entire file is duplicated (ClawdbotPluginApi, config schema)
- **`types.ts`** - Contains many types duplicated from core:
  - `ChannelMeta`, `ChatCapabilities`, `ChannelOutboundAdapter`
  - `ChannelOutboundContext`, `OutboundDeliveryResult`
  - `ChannelPlugin`, `ChannelAccountSnapshot`
  - `ChannelStatusAdapter`, `ChannelGatewayAdapter`
  - `ChannelGatewayContext`, `ChannelLogSink`
  - `ChannelMessageActionAdapter`, `ChannelMessageActionContext`
  - Plus plugin-specific wrapper types (PluginAPI, CoreConfig stubs)

**Keep in `types.ts`:**
- `TwitchAccountConfig` - Twitch-specific config
- `TwitchChannelConfig` - Twitch channel config
- `TwitchRole` - Twitch role enum
- `TwitchTarget` - Twitch send target
- `TwitchChatMessage` - Twitch message structure
- `TwitchPluginConfig` - Plugin-specific config (if still needed)
- `SendResult` - Twitch send result
- `ProviderLogger` - Simple logger interface (or use core's)

#### 1.2 Document Twitch-Specific Types to Preserve
```typescript
// Twitch-specific types that MUST be kept
export type TwitchRole = "moderator" | "owner" | "vip" | "subscriber" | "all";

export interface TwitchAccountConfig {
  username: string;
  token: string;
  clientId?: string;
  channel?: string;
  enabled?: boolean;
  allowFrom?: Array<string>;
  allowedRoles?: TwitchRole[];
  requireMention?: boolean;
  clientSecret?: string;
  refreshToken?: string;
  expiresIn?: number | null;
  obtainmentTimestamp?: number;
}

export interface TwitchChatMessage {
  username: string;
  userId?: string;
  message: string;
  channel: string;
  displayName?: string;
  id?: string;
  timestamp?: Date;
  isMod?: boolean;
  isOwner?: boolean;
  isVip?: boolean;
  isSub?: boolean;
  chatType?: "direct" | "group";
}
```

---

### Phase 2: Core Directory Structure

#### 2.1 Create Directory Structure in Clawdbot Core
```bash
cd opensrc/repos/github.com/clawdbot/clawdbot
mkdir -p src/twitch
mkdir -p src/twitch/monitor
```

#### 2.2 Target File Structure (following Discord pattern)
```
src/twitch/
├── channel.ts           # Channel plugin definition (replaces plugin.ts)
├── config.ts            # Account config (keep from plugin)
├── access-control.ts    # Access control (keep from plugin)
├── probe.ts             # Connection probing (keep from plugin)
├── resolver.ts          # Username resolution (keep from plugin)
├── status.ts            # Status issues (keep from plugin)
├── send.ts              # Outbound send (keep from plugin)
├── send.types.ts        # Send-specific types
├── actions.ts           # Message actions (keep from plugin)
├── twitch-client.ts     # Twitch client wrapper (keep from plugin)
├── types.ts             # Twitch-specific types ONLY
├── utils/
│   ├── markdown.ts      # Markdown utilities (keep from plugin)
│   └── twitch.ts        # Twitch utilities (keep from plugin)
└── monitor/
    ├── provider.ts      # Inbound message provider (NEW)
    ├── message-handler.ts  # Message processing (NEW)
    ├── reply-delivery.ts    # Reply delivery (NEW)
    ├── format.ts            # Message formatting (NEW)
    └── loggers.ts           # Twitch-specific loggers (NEW)
```

---

### Phase 3: Type Deduping

#### 3.1 Remove `plugin-sdk.ts` Entirely
This file is 100% duplicated from core. Delete it after migration.

#### 3.2 Refactor `types.ts`

**BEFORE (current plugin):**
```typescript
// types.ts - ~465 lines with many duplicates
export interface ChannelMeta { /* duplicate */ }
export interface ChatCapabilities { /* duplicate */ }
export interface TwitchAccountConfig { /* keep */ }
export interface TwitchChatMessage { /* keep */ }
// ... many more duplicates
```

**AFTER (core version):**
```typescript
// types.ts - ~100 lines, Twitch-specific only
import type {
  ChannelMeta,
  ChatCapabilities,
  // ... import from core
} from "../channels/plugins/types.core.js";

export type TwitchRole = "moderator" | "owner" | "vip" | "subscriber" | "all";

export interface TwitchAccountConfig {
  username: string;
  token: string;
  // ... Twitch-specific fields
}

export interface TwitchChatMessage {
  username: string;
  message: string;
  // ... Twitch-specific fields
}
```

#### 3.3 Update All Imports Across Files

**Pattern for imports:**
```typescript
// OLD (plugin):
import type { ChannelMeta, CoreConfig } from "./types.js";
import type { ChannelOutboundAdapter } from "./types.js";

// NEW (core):
import type { ChannelMeta, ChatCapabilities } from "../channels/plugins/types.core.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";
```

---

### Phase 4: Core Channel Registration

#### 4.1 Update `src/channels/registry.ts`
```typescript
// ADD "twitch" to CHAT_CHANNEL_ORDER
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "twitch",        // ← ADD HERE
  "slack",
  "signal",
  "imessage",
] as const;

// ADD metadata
const CHAT_CHANNEL_META: Record<ChatChannelId, ChannelMeta> = {
  // ... existing channels
  twitch: {
    id: "twitch",
    label: "Twitch",
    selectionLabel: "Twitch (Chat)",
    detailLabel: "Twitch Chat",
    docsPath: "/channels/twitch",
    docsLabel: "twitch",
    blurb: "connects to Twitch chat for live stream interaction.",
    systemImage: "video.badge.plus",
  },
  // ... existing channels
};
```

#### 4.2 Update `src/utils/message-channel.ts`
```typescript
// Add "twitch" to INTERNAL_MESSAGE_CHANNEL union if needed
// Add to GatewayClientName if Twitch connects via gateway
```

#### 4.3 Register Channel Plugin
Create or update channel plugin registration (typically in channel index file):
```typescript
// src/twitch/index.ts or integration point
import { twitchPlugin } from "./channel.js";
import { registerChannelPlugin } from "../channels/plugins/index.js";

export function registerTwitchChannel() {
  registerChannelPlugin("twitch", twitchPlugin);
}
```

---

### Phase 5: Inbound Message Routing

#### 5.1 Create Message Provider (NEW file)
**`src/twitch/monitor/provider.ts`**

This is the CRITICAL piece that was missing. Follow Discord's pattern:
```typescript
// Reference: src/discord/monitor/provider.ts
import { twitchClientManager } from "../twitch-client.js";
import { createTwitchMessageHandler } from "./message-handler.js";

export async function monitorTwitchChannel(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  account: TwitchAccountConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLogSink;
}) {
  const clientManager = new TwitchClientManager({
    info: (msg) => params.log?.info(`[twitch] ${msg}`),
    warn: (msg) => params.log?.warn(`[twitch] ${msg}`),
    error: (msg) => params.log?.error(`[twitch] ${msg}`),
  });

  // Create message handler that calls dispatchInboundMessage
  const messageHandler = createTwitchMessageHandler({
    cfg: params.cfg,
    accountId: params.accountId,
    account: params.account,
    runtime: params.runtime,
    log: params.log,
  });

  // Set up message listener
  clientManager.onMessage(params.account, async (message) => {
    await messageHandler(message);
  });

  await clientManager.getClient(params.account);
  return {
    close: async () => {
      await clientManager.close();
    },
  };
}
```

#### 5.2 Create Message Handler (NEW file)
**`src/twitch/monitor/message-handler.ts`**

```typescript
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import type { TwitchChatMessage } from "../types.js";

export async function createTwitchMessageHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  account: TwitchAccountConfig;
  runtime: RuntimeEnv;
  log?: ChannelLogSink;
}) {
  return async (message: TwitchChatMessage) => {
    // 1. Resolve route
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "twitch",
      accountId: params.accountId,
      peer: {
        kind: "group", // Twitch chat is always group-like
        id: message.channel,
      },
    });

    // 2. Build MsgContext
    const ctx: MsgContext = {
      Body: message.message,
      RawBody: message.message,
      CommandBody: message.message,
      From: `twitch:${message.userId ?? message.username}`,
      To: route.sessionKey,
      SessionKey: route.sessionKey,
      AccountId: params.accountId,
      ChatType: "group",
      SenderName: message.displayName ?? message.username,
      SenderId: message.userId ?? message.username,
      SenderUsername: message.username,
      Provider: "twitch" as const,
      Surface: "twitch" as const,
      WasMentioned: message.message.includes(params.account.username), // crude check
      MessageSid: message.id ?? `${Date.now()}`,
      Timestamp: message.timestamp?.getTime() ?? Date.now(),
      CommandAuthorized: true, // TODO: access control check
      CommandSource: "text" as const,
      OriginatingChannel: "twitch" as const,
      OriginatingTo: message.channel,
    };

    // 3. Create dispatcher for replies
    const dispatcher = createReplyDispatcher({
      responsePrefix: "", // TODO: from config
      onError: (err) => {
        params.log?.error(`[twitch] dispatch failed: ${String(err)}`);
      },
      deliver: async (payload) => {
        // Send reply via Twitch client
        // TODO: implement sendTwitchReply
        params.log?.info(`[twitch] Reply: ${payload.text?.slice(0, 50)}...`);
      },
    });

    // 4. Dispatch to agent
    await dispatchInboundMessage({
      ctx,
      cfg: params.cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming: true, // Twitch doesn't support streaming
      },
    });
  };
}
```

#### 5.3 Update `plugin.ts` → `channel.ts`
Rename and refactor to use the new monitor:
```typescript
// src/twitch/channel.ts (was plugin.ts)
export const twitchPlugin: ChannelPlugin<TwitchAccountConfig> = {
  id: "twitch", // Use simple ID like core channels
  meta: {
    id: "twitch",
    label: "Twitch",
    // ...
  },
  // ... adapters (config, outbound, actions, resolver, status)

  // GATEWAY - Use new monitor
  gateway: {
    startAccount: async (ctx) => {
      const { monitorTwitchChannel } = await import("./monitor/provider.js");
      const monitor = await monitorTwitchChannel({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        account: ctx.account as TwitchAccountConfig,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
      });
      // Store monitor for cleanup
      ctx.setStatus({ running: true, lastStartAt: Date.now() });
    },
    stopAccount: async (ctx) => {
      // Cleanup monitor
      ctx.setStatus({ running: false, lastStopAt: Date.now() });
    },
  },
};
```

---

### Phase 6: Plugin Wrapper Removal

#### 6.1 Delete `index.ts` (plugin wrapper)
The `index.ts` file contains plugin wrapper code that's not needed for core:
```typescript
// DELETE THIS FILE:
const plugin = {
  id: "clawdbot-twitch",
  name: "Twitch",
  configSchema: emptyPluginConfigSchema(),
  register(api) { /* ... */ },
};
export default plugin;
```

#### 6.2 Remove Plugin Config Schema
Delete `emptyPluginConfigSchema()` and all plugin config schema code. Core channels don't use this.

---

### Phase 7: Dependencies & Package Updates

#### 7.1 Review Dependencies in `package.json`

**Current plugin dependencies:**
```json
{
  "dependencies": {
    "@twurple/cli": "^7.1.0",
    "@twurple/auth": "^7.1.0",
    "@twurple/chat": "^7.1.0",
    "@twurple/common": "^7.1.0"
  }
}
```

**Action:** Add these to Clawdbot core's `package.json`:
```json
{
  "dependencies": {
    "@twurple/cli": "^7.1.0",
    "@twurple/auth": "^7.1.0",
    "@twurple/chat": "^7.1.0",
    "@twurple/common": "^7.1.0"
  }
}
```

#### 7.2 Remove Plugin-Specific Files
```
DELETE:
- src/index.ts (plugin wrapper)
- src/plugin-sdk.ts (duplicated types)
- clawdbot.plugin.json (not needed for core)
```

---

### Phase 8: Testing & Validation

#### 8.1 Build Verification
```bash
cd opensrc/repos/github.com/clawdbot/clawdbot
pnpm build
```

#### 8.2 Type Verification
```bash
pnpm run type-check  # or tsc --noEmit
```

#### 8.3 Lint Verification
```bash
pnpm lint
```

#### 8.4 Test Verification
```bash
pnpm test -- src/twitch
```

#### 8.5 Integration Testing
1. Update user config to use core Twitch channel:
   ```json
   {
     "channels": {
       "twitch": {
         "enabled": true,
         "accounts": {
           "default": {
             "username": "clawdbot",
             "token": "...",
             "clientId": "...",
             "channel": "jaydencarey",
             "requireMention": true
           }
         }
       }
     }
   }
   ```

2. Start gateway:
   ```bash
   clawdbot gateway run
   ```

3. Send test message in Twitch chat:
   ```
   @clawdbot hello
   ```

4. Verify:
   - Gateway connects to Twitch
   - Messages are received
   - Messages are dispatched to agent
   - Agent responds
   - Response is sent back to Twitch chat

---

### Phase 9: Documentation

#### 9.1 Add Channel Documentation
Create `docs/channels/twitch.md` following the pattern of other channels:
```markdown
# Twitch

## Setup

1. Create a Twitch application at [Twitch Dev Portal](https://dev.twitch.tv/console)
2. Get your Client ID and generate a token
3. Configure Clawdbot:

\`\`\`bash
clawdbot channels login --channel twitch
\`\`\`

## Configuration

\`\`\`json
{
  "channels": {
    "twitch": {
      "accounts": {
        "default": {
          "username": "yourbot",
          "token": "...",
          "clientId": "...",
          "channel": "yourchannel",
          "requireMention": true
        }
      }
    }
  }
}
\`\`\`

## Features

- **Chat Types:** Group (channel chat)
- **Mentions:** Require @mention by default
- **Roles:** Support for mods, VIPs, subs
- **Access Control:** Allowlist by user ID or role
```

#### 9.2 Update Main README
Add Twitch to the list of supported channels.

#### 9.3 Update Channel Selection Docs
Update any documentation that lists available channels.

---

## Summary of Key Changes

### Files Deleted
- `src/index.ts` - Plugin wrapper
- `src/plugin-sdk.ts` - Duplicated types
- `clawdbot.plugin.json` - Plugin manifest

### Files Created (Core)
- `src/twitch/monitor/provider.ts` - Inbound message provider
- `src/twitch/monitor/message-handler.ts` - Message processing with dispatchInboundMessage
- `src/twitch/monitor/reply-delivery.ts` - Reply delivery
- `src/twitch/monitor/format.ts` - Message formatting
- `src/twitch/monitor/loggers.ts` - Twitch loggers

### Files Modified
- `src/twitch/types.ts` - Remove duplicated types, keep only Twitch-specific
- `src/twitch/plugin.ts` → `src/twitch/channel.ts` - Rename and refactor
- All other `.ts` files - Update imports to use core paths
- `src/channels/registry.ts` - Add "twitch" to channel list
- `package.json` - Add @twurple dependencies

### Critical Change: Inbound Routing
**Before (plugin):**
```typescript
// Only logged messages
console.info(`[twitch] Received message: ${message.message}`);
```

**After (core):**
```typescript
// Actually routes messages to agent
await dispatchInboundMessage({ ctx, cfg, dispatcher, replyOptions });
```

---

## Checklist

### Pre-Migration
- [ ] Ensure Clawdbot core is at latest commit
- [ ] Create a new branch for the migration
- [ ] Document any Twitch plugin-specific features that need special handling

### Migration
- [ ] Create `src/twitch` directory structure
- [ ] Move and adapt files from plugin to core
- [ ] Remove `plugin-sdk.ts` (all duplicates)
- [ ] Refactor `types.ts` to only contain Twitch-specific types
- [ ] Update all imports across files
- [ ] Delete `src/index.ts` (plugin wrapper)
- [ ] Rename `plugin.ts` → `channel.ts` and refactor
- [ ] Create `monitor/provider.ts` with inbound routing
- [ ] Create `monitor/message-handler.ts` with dispatchInboundMessage
- [ ] Update `src/channels/registry.ts` to add "twitch"
- [ ] Update `package.json` with @twurple dependencies
- [ ] Move tests to core and update imports

### Post-Migration
- [ ] Run `pnpm install` to install new dependencies
- [ ] Run `pnpm build` and fix any build errors
- [ ] Run `pnpm lint` and fix any lint errors
- [ ] Run `pnpm test` and fix any test failures
- [ ] Test Twitch connection manually
- [ ] Test message routing with a real Twitch chat
- [ ] Add/update documentation
- [ ] Update user config to use core Twitch channel
- [ ] Clean up old plugin directory
- [ ] Submit PR to Clawdbot repo

---

## Estimated Effort

- **Type deduping:** 2-3 hours
- **File migration & import updates:** 3-4 hours
- **Inbound routing implementation:** 4-5 hours (critical path)
- **Testing & debugging:** 3-4 hours
- **Documentation:** 1-2 hours

**Total:** ~13-18 hours

---

## References

- Discord channel implementation: `opensrc/repos/github.com/clawdbot/clawdbot/src/discord/`
- Core channel types: `opensrc/repos/github.com/clawdbot/clawdbot/src/channels/plugins/types.core.ts`
- Channel registry: `opensrc/repos/github.com/clawdbot/clawdbot/src/channels/registry.ts`
- Message dispatch: `opensrc/repos/github.com/clawdbot/clawdbot/src/auto-reply/dispatch.ts`
