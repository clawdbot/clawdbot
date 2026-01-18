---
summary: "Plan: one clean plugin SDK + runtime for all messaging connectors"
read_when:
  - Defining or refactoring the plugin architecture
  - Migrating channel connectors to the plugin SDK/runtime
---
# Plugin SDK + Runtime Refactor Plan

Goal: every messaging connector is a plugin (bundled or external) using one stable API.
No plugin imports from `src/**` directly. All dependencies go through the SDK or runtime.

## Why now
- Current connectors mix patterns: direct core imports, dist-only bridges, and custom helpers.
- This makes upgrades brittle and blocks a clean external plugin surface.

## Target architecture (two layers)

### 1) Plugin SDK (compile-time, stable, publishable)
Scope: types, helpers, and config utilities. No runtime state, no side effects.

Contents (examples):
- Types: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Config helpers: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Pairing helpers: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Onboarding helpers: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding types.
- Tool param helpers: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Docs link helper: `formatDocsLink`.

Delivery:
- Publish as `@clawdbot/plugin-sdk` (or export from core under `clawdbot/plugin-sdk`).
- Semver with explicit stability guarantees.

### 2) Plugin Runtime (execution surface, injected)
Scope: everything that touches core runtime behavior.
Accessed via `ClawdbotPluginApi.runtime` so plugins never import `src/**`.

Proposed surface (minimal but complete):
```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: ClawdbotConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: ClawdbotConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) =>
            void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: ClawdbotConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(cfg: ClawdbotConfig, channel: string, accountId: string, groupId: string): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: ClawdbotConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: ClawdbotConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: ClawdbotConfig): string;
  };
};
```

Notes:
- Runtime is the only way to access core behavior.
- SDK is intentionally small and stable.
- Each runtime method maps to an existing core implementation (no duplication).

## Migration plan (phased, safe)

### Phase 0: scaffolding
- Introduce `@clawdbot/plugin-sdk`.
- Add `api.runtime` to `ClawdbotPluginApi` with the surface above.
- Maintain existing imports during a transition window (deprecation warnings).

### Phase 1: bridge cleanup (low risk)
- Replace per-extension `core-bridge.ts` with `api.runtime`.
- Migrate BlueBubbles, Zalo, Zalo Personal first (already close).
- Remove duplicated bridge code.

### Phase 2: light direct-import plugins
- Migrate Matrix to SDK + runtime.
- Validate onboarding, directory, group mention logic.

### Phase 3: heavy direct-import plugins
- Migrate MS Teams (largest set of runtime helpers).
- Ensure reply/typing semantics match current behavior.

### Phase 4: iMessage pluginization
- Move iMessage into `extensions/imessage`.
- Replace direct core calls with `api.runtime`.
- Keep config keys, CLI behavior, and docs intact.

### Phase 5: enforcement
- Add lint rule / CI check: no `extensions/**` imports from `src/**`.
- Add plugin SDK/version compatibility checks (runtime + SDK semver).

## Compatibility and versioning
- SDK: semver, published, documented changes.
- Runtime: versioned per core release. Add `api.runtime.version`.
- Plugins declare a required runtime range (e.g., `clawdbotRuntime: ">=2026.2.0"`).

## Testing strategy
- Adapter-level unit tests (runtime functions exercised with real core implementation).
- Golden tests per plugin: ensure no behavior drift (routing, pairing, allowlist, mention gating).
- A single end-to-end plugin sample used in CI (install + run + smoke).

## Open questions
- Where to host SDK types: separate package or core export?
- Runtime type distribution: in SDK (types only) or in core?
- How to expose docs links for bundled vs external plugins?
- Do we allow limited direct core imports for in-repo plugins during transition?

## Success criteria
- All channel connectors are plugins using SDK + runtime.
- No `extensions/**` imports from `src/**`.
- New connector templates depend only on SDK + runtime.
- External plugins can be developed and updated without core source access.

Related docs: [Plugins](/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
