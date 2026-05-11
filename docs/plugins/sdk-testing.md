---
summary: "Testing utilities and patterns for OpenClaw plugins"
title: "Plugin testing"
sidebarTitle: "Testing"
read_when:
  - You are writing tests for a plugin
  - You need test utilities from the plugin SDK
  - You want to understand contract tests for bundled plugins
---

Reference for test utilities, patterns, and lint enforcement for OpenClaw
plugins.

<Tip>
  **Looking for test examples?** The how-to guides include worked test examples:
  [Channel plugin tests](/plugins/sdk-channel-plugins#step-6-test) and
  [Provider plugin tests](/plugins/sdk-provider-plugins#step-6-test).
</Tip>

## Test utilities

These test-helper subpaths are repo-local source entrypoints for OpenClaw's own
bundled plugin tests. They are not package exports for third-party plugins.

**Plugin API mock import:** `openclaw/plugin-sdk/plugin-test-api`

**Agent runtime contract import:** `openclaw/plugin-sdk/agent-runtime-test-contracts`

**Channel contract import:** `openclaw/plugin-sdk/channel-contract-testing`

**Channel test helper import:** `openclaw/plugin-sdk/channel-test-helpers`

**Channel target test import:** `openclaw/plugin-sdk/channel-target-testing`

**Plugin contract import:** `openclaw/plugin-sdk/plugin-test-contracts`

**Plugin runtime test import:** `openclaw/plugin-sdk/plugin-test-runtime`

**Provider contract import:** `openclaw/plugin-sdk/provider-test-contracts`

**Provider HTTP mock import:** `openclaw/plugin-sdk/provider-http-test-mocks`

**Environment/network test import:** `openclaw/plugin-sdk/test-env`

**Generic fixture import:** `openclaw/plugin-sdk/test-fixtures`

**Node builtin mock import:** `openclaw/plugin-sdk/test-node-mocks`

Prefer the focused subpaths below for new plugin tests. The broad
`openclaw/plugin-sdk/testing` barrel is legacy compatibility only.
Repo guardrails reject new real imports from `plugin-sdk/testing` and
`plugin-sdk/test-utils`; those names remain only as deprecated compatibility
surfaces for compatibility-record tests.

```typescript
import {
  shouldAckReaction,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import { installCommonResolveTargetErrorCases } from "openclaw/plugin-sdk/channel-target-testing";
import { AUTH_PROFILE_RUNTIME_CONTRACT } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expectChannelInboundContextContract } from "openclaw/plugin-sdk/channel-contract-testing";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { describePluginRegistrationContract } from "openclaw/plugin-sdk/plugin-test-contracts";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describeOpenAIProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { getProviderHttpMocks } from "openclaw/plugin-sdk/provider-http-test-mocks";
import { withEnv, withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import {
  bundledPluginRoot,
  createCliRuntimeCapture,
  typedCases,
} from "openclaw/plugin-sdk/test-fixtures";
import { mockNodeBuiltinModule } from "openclaw/plugin-sdk/test-node-mocks";
```

### Available exports

| Export                                               | Purpose                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `createTestPluginApi`                                | Build a minimal plugin API mock for direct registration unit tests. Import from `plugin-sdk/plugin-test-api`                             |
| `AUTH_PROFILE_RUNTIME_CONTRACT`                      | Shared auth-profile contract fixture for native agent runtime adapters. Import from `plugin-sdk/agent-runtime-test-contracts`            |
| `DELIVERY_NO_REPLY_RUNTIME_CONTRACT`                 | Shared delivery suppression contract fixture for native agent runtime adapters. Import from `plugin-sdk/agent-runtime-test-contracts`    |
| `OUTCOME_FALLBACK_RUNTIME_CONTRACT`                  | Shared fallback-classification contract fixture for native agent runtime adapters. Import from `plugin-sdk/agent-runtime-test-contracts` |
| `createParameterFreeTool`                            | Build dynamic-tool schema fixtures for native runtime contract tests. Import from `plugin-sdk/agent-runtime-test-contracts`              |
| `expectChannelInboundContextContract`                | Assert channel inbound context shape. Import from `plugin-sdk/channel-contract-testing`                                                  |
| `installChannelOutboundPayloadContractSuite`         | Install channel outbound payload contract cases. Import from `plugin-sdk/channel-contract-testing`                                       |
| `createStartAccountContext`                          | Build channel account lifecycle contexts. Import from `plugin-sdk/channel-test-helpers`                                                  |
| `installChannelActionsContractSuite`                 | Install generic channel message-action contract cases. Import from `plugin-sdk/channel-test-helpers`                                     |
| `installChannelSetupContractSuite`                   | Install generic channel setup contract cases. Import from `plugin-sdk/channel-test-helpers`                                              |
| `installChannelStatusContractSuite`                  | Install generic channel status contract cases. Import from `plugin-sdk/channel-test-helpers`                                             |
| `expectDirectoryIds`                                 | Assert channel directory ids from a directory-list function. Import from `plugin-sdk/channel-test-helpers`                               |
| `assertBundledChannelEntries`                        | Assert bundled channel entrypoints expose the expected public contract. Import from `plugin-sdk/channel-test-helpers`                    |
| `formatEnvelopeTimestamp`                            | Format deterministic envelope timestamps. Import from `plugin-sdk/channel-test-helpers`                                                  |
| `expectPairingReplyText`                             | Assert channel pairing reply text and extract its code. Import from `plugin-sdk/channel-test-helpers`                                    |
| `describePluginRegistrationContract`                 | Install plugin registration contract checks. Import from `plugin-sdk/plugin-test-contracts`                                              |
| `registerSingleProviderPlugin`                       | Register one provider plugin in loader smoke tests. Import from `plugin-sdk/plugin-test-runtime`                                         |
| `registerProviderPlugin`                             | Capture all provider kinds from one plugin. Import from `plugin-sdk/plugin-test-runtime`                                                 |
| `registerProviderPlugins`                            | Capture provider registrations across multiple plugins. Import from `plugin-sdk/plugin-test-runtime`                                     |
| `requireRegisteredProvider`                          | Assert that a provider collection contains an id. Import from `plugin-sdk/plugin-test-runtime`                                           |
| `createRuntimeEnv`                                   | Build a mocked CLI/plugin runtime environment. Import from `plugin-sdk/plugin-test-runtime`                                              |
| `createPluginSetupWizardStatus`                      | Build setup status helpers for channel plugins. Import from `plugin-sdk/plugin-test-runtime`                                             |
| `describeOpenAIProviderRuntimeContract`              | Install provider-family runtime contract checks. Import from `plugin-sdk/provider-test-contracts`                                        |
| `expectPassthroughReplayPolicy`                      | Assert provider replay policies pass through provider-owned tools and metadata. Import from `plugin-sdk/provider-test-contracts`         |
| `runRealtimeSttLiveTest`                             | Run a live realtime STT provider test with shared audio fixtures. Import from `plugin-sdk/provider-test-contracts`                       |
| `normalizeTranscriptForMatch`                        | Normalize live transcript output before fuzzy assertions. Import from `plugin-sdk/provider-test-contracts`                               |
| `expectExplicitVideoGenerationCapabilities`          | Assert video providers declare explicit generation mode capabilities. Import from `plugin-sdk/provider-test-contracts`                   |
| `expectExplicitMusicGenerationCapabilities`          | Assert music providers declare explicit generation/edit capabilities. Import from `plugin-sdk/provider-test-contracts`                   |
| `mockSuccessfulDashscopeVideoTask`                   | Install a successful DashScope-compatible video task response. Import from `plugin-sdk/provider-test-contracts`                          |
| `getProviderHttpMocks`                               | Access opt-in provider HTTP/auth Vitest mocks. Import from `plugin-sdk/provider-http-test-mocks`                                         |
| `installProviderHttpMockCleanup`                     | Reset provider HTTP/auth mocks after each test. Import from `plugin-sdk/provider-http-test-mocks`                                        |
| `installCommonResolveTargetErrorCases`               | Shared test cases for target resolution error handling. Import from `plugin-sdk/channel-target-testing`                                  |
| `shouldAckReaction`                                  | Check whether a channel should add an ack reaction. Import from `plugin-sdk/channel-feedback`                                            |
| `removeAckReactionAfterReply`                        | Remove ack reaction after reply delivery. Import from `plugin-sdk/channel-feedback`                                                      |
| `createTestRegistry`                                 | Build a channel plugin registry fixture. Import from `plugin-sdk/plugin-test-runtime` or `plugin-sdk/channel-test-helpers`               |
| `createEmptyPluginRegistry`                          | Build an empty plugin registry fixture. Import from `plugin-sdk/plugin-test-runtime` or `plugin-sdk/channel-test-helpers`                |
| `setActivePluginRegistry`                            | Install a registry fixture for plugin runtime tests. Import from `plugin-sdk/plugin-test-runtime` or `plugin-sdk/channel-test-helpers`   |
| `createRequestCaptureJsonFetch`                      | Capture JSON fetch requests in media helper tests. Import from `plugin-sdk/test-env`                                                     |
| `withServer`                                         | Run tests against a disposable local HTTP server. Import from `plugin-sdk/test-env`                                                      |
| `createMockIncomingRequest`                          | Build a minimal incoming HTTP request object. Import from `plugin-sdk/test-env`                                                          |
| `withFetchPreconnect`                                | Run fetch tests with preconnect hooks installed. Import from `plugin-sdk/test-env`                                                       |
| `withEnv` / `withEnvAsync`                           | Temporarily patch environment variables. Import from `plugin-sdk/test-env`                                                               |
| `createTempHomeEnv` / `withTempHome` / `withTempDir` | Create isolated filesystem test fixtures. Import from `plugin-sdk/test-env`                                                              |
| `createMockServerResponse`                           | Create a minimal HTTP server response mock. Import from `plugin-sdk/test-env`                                                            |
| `createCliRuntimeCapture`                            | Capture CLI runtime output in tests. Import from `plugin-sdk/test-fixtures`                                                              |
| `importFreshModule`                                  | Import an ESM module with a fresh query token to bypass module cache. Import from `plugin-sdk/test-fixtures`                             |
| `bundledPluginRoot` / `bundledPluginFile`            | Resolve bundled plugin source or dist fixture paths. Import from `plugin-sdk/test-fixtures`                                              |
| `mockNodeBuiltinModule`                              | Install narrow Node builtin Vitest mocks. Import from `plugin-sdk/test-node-mocks`                                                       |
| `createSandboxTestContext`                           | Build sandbox test contexts. Import from `plugin-sdk/test-fixtures`                                                                      |
| `writeSkill`                                         | Write skill fixtures. Import from `plugin-sdk/test-fixtures`                                                                             |
| `makeAgentAssistantMessage`                          | Build agent transcript message fixtures. Import from `plugin-sdk/test-fixtures`                                                          |
| `peekSystemEvents` / `resetSystemEventsForTest`      | Inspect and reset system event fixtures. Import from `plugin-sdk/test-fixtures`                                                          |
| `sanitizeTerminalText`                               | Sanitize terminal output for assertions. Import from `plugin-sdk/test-fixtures`                                                          |
| `countLines` / `hasBalancedFences`                   | Assert chunking output shape. Import from `plugin-sdk/test-fixtures`                                                                     |
| `runProviderCatalog`                                 | Execute a provider catalog hook with test dependencies                                                                                   |
| `resolveProviderWizardOptions`                       | Resolve provider setup wizard choices in contract tests                                                                                  |
| `resolveProviderModelPickerEntries`                  | Resolve provider model-picker entries in contract tests                                                                                  |
| `buildProviderPluginMethodChoice`                    | Build provider wizard choice ids for assertions                                                                                          |
| `setProviderWizardProvidersResolverForTest`          | Inject provider wizard providers for isolated tests                                                                                      |
| `createProviderUsageFetch`                           | Build provider usage fetch fixtures                                                                                                      |
| `useFrozenTime` / `useRealTime`                      | Freeze and restore timers for time-sensitive tests. Import from `plugin-sdk/test-env`                                                    |
| `createTestWizardPrompter`                           | Build a mocked setup wizard prompter                                                                                                     |
| `createRuntimeTaskFlow`                              | Create isolated runtime task-flow state                                                                                                  |
| `typedCases`                                         | Preserve literal types for table-driven tests. Import from `plugin-sdk/test-fixtures`                                                    |

Bundled-plugin contract suites also use SDK testing subpaths for test-only
registry, manifest, public-artifact, and runtime fixture helpers. Core-only
suites that depend on bundled OpenClaw inventory stay under `src/plugins/contracts`.
Keep new extension tests on a documented focused SDK subpath such as
`plugin-sdk/plugin-test-api`, `plugin-sdk/channel-contract-testing`,
`plugin-sdk/agent-runtime-test-contracts`, `plugin-sdk/channel-test-helpers`,
`plugin-sdk/plugin-test-contracts`, `plugin-sdk/plugin-test-runtime`,
`plugin-sdk/provider-test-contracts`, `plugin-sdk/provider-http-test-mocks`,
`plugin-sdk/test-env`, or `plugin-sdk/test-fixtures` rather than importing the
broad `plugin-sdk/testing` compatibility barrel, repo `src/**` files, or repo
`test/helpers/*` bridges directly.

### Types

Focused testing subpaths also re-export types useful in test files:

```typescript
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MockFn, PluginRuntime, RuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
```

## Testing target resolution

Use `installCommonResolveTargetErrorCases` to add standard error cases for
channel target resolution:

```typescript
import { describe } from "vitest";
import { installCommonResolveTargetErrorCases } from "openclaw/plugin-sdk/channel-target-testing";

describe("my-channel target resolution", () => {
  installCommonResolveTargetErrorCases({
    resolveTarget: ({ to, mode, allowFrom }) => {
      // Your channel's target resolution logic
      return myChannelResolveTarget({ to, mode, allowFrom });
    },
    implicitAllowFrom: ["user1", "user2"],
  });

  // Add channel-specific test cases
  it("should resolve @username targets", () => {
    // ...
  });
});
```

## Testing patterns

### Testing registration contracts

Unit tests that pass a hand-written `api` mock to `register(api)` do not exercise
OpenClaw's loader acceptance gates. Add at least one loader-backed smoke test
for each registration surface your plugin depends on, especially hooks and
exclusive capabilities such as memory.

The real loader fails plugin registration when required metadata is missing or a
plugin calls a capability API it does not own. For example,
`api.registerHook(...)` requires a hook name, and
`api.registerMemoryCapability(...)` requires the plugin manifest or exported
entry to declare `kind: "memory"`.

### Testing runtime config access

Prefer the shared plugin runtime mock from `openclaw/plugin-sdk/channel-test-helpers`
when testing bundled channel plugins. Its deprecated `runtime.config.loadConfig()` and
`runtime.config.writeConfigFile(...)` mocks throw by default so tests catch new
usage of compatibility APIs. Override those mocks only when the test is
explicitly covering legacy compatibility behavior.

### Unit testing a channel plugin

```typescript
import { describe, it, expect, vi } from "vitest";

describe("my-channel plugin", () => {
  it("should resolve account from config", () => {
    const cfg = {
      channels: {
        "my-channel": {
          token: "test-token",
          allowFrom: ["user1"],
        },
      },
    };

    const account = myPlugin.setup.resolveAccount(cfg, undefined);
    expect(account.token).toBe("test-token");
  });

  it("should inspect account without materializing secrets", () => {
    const cfg = {
      channels: {
        "my-channel": { token: "test-token" },
      },
    };

    const inspection = myPlugin.setup.inspectAccount(cfg, undefined);
    expect(inspection.configured).toBe(true);
    expect(inspection.tokenStatus).toBe("available");
    // No token value exposed
    expect(inspection).not.toHaveProperty("token");
  });
});
```

### Unit testing a provider plugin

```typescript
import { describe, it, expect } from "vitest";

describe("my-provider plugin", () => {
  it("should resolve dynamic models", () => {
    const model = myProvider.resolveDynamicModel({
      modelId: "custom-model-v2",
      // ... context
    });

    expect(model.id).toBe("custom-model-v2");
    expect(model.provider).toBe("my-provider");
    expect(model.api).toBe("openai-completions");
  });

  it("should return catalog when API key is available", async () => {
    const result = await myProvider.catalog.run({
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      // ... context
    });

    expect(result?.provider?.models).toHaveLength(2);
  });
});
```

### Mocking the plugin runtime

For code that uses `createPluginRuntimeStore`, mock the runtime in tests:

```typescript
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const store = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "test-plugin",
  errorMessage: "test runtime not set",
});

// In test setup
const mockRuntime = {
  agent: {
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
    // ... other mocks
  },
  config: {
    current: vi.fn(() => ({}) as const),
    mutateConfigFile: vi.fn(),
    replaceConfigFile: vi.fn(),
  },
  // ... other namespaces
} as unknown as PluginRuntime;

store.setRuntime(mockRuntime);

// After tests
store.clearRuntime();
```

### Testing with per-instance stubs

Prefer per-instance stubs over prototype mutation:

```typescript
// Preferred: per-instance stub
const client = new MyChannelClient();
client.sendMessage = vi.fn().mockResolvedValue({ id: "msg-1" });

// Avoid: prototype mutation
// MyChannelClient.prototype.sendMessage = vi.fn();
```

## Contract tests (in-repo plugins)

Bundled plugins have contract tests that verify registration ownership:

```bash
pnpm test -- src/plugins/contracts/
```

These tests assert:

- Which plugins register which providers
- Which plugins register which speech providers
- Registration shape correctness
- Runtime contract compliance

### Running scoped tests

For a specific plugin:

```bash
pnpm test -- <bundled-plugin-root>/my-channel/
```

For contract tests only:

```bash
pnpm test -- src/plugins/contracts/shape.contract.test.ts
pnpm test -- src/plugins/contracts/auth-choice.contract.test.ts
pnpm test -- src/plugins/contracts/runtime-seams.contract.test.ts
```

## Lint enforcement (in-repo plugins)

Three rules are enforced by `pnpm check` for in-repo plugins:

1. **No monolithic root imports** -- `openclaw/plugin-sdk` root barrel is rejected
2. **No direct `src/` imports** -- plugins cannot import `../../src/` directly
3. **No self-imports** -- plugins cannot import their own `plugin-sdk/<name>` subpath

External plugins are not subject to these lint rules, but following the same
patterns is recommended.

## Test configuration

OpenClaw uses Vitest with V8 coverage thresholds. For plugin tests:

```bash
# Run all tests
pnpm test

# Run specific plugin tests
pnpm test -- <bundled-plugin-root>/my-channel/src/channel.test.ts

# Run with a specific test name filter
pnpm test -- <bundled-plugin-root>/my-channel/ -t "resolves account"

# Run with coverage
pnpm test:coverage
```

If local runs cause memory pressure:

```bash
OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test
```

## Related

- [SDK Overview](/plugins/sdk-overview) -- import conventions
- [SDK Channel Plugins](/plugins/sdk-channel-plugins) -- channel plugin interface
- [SDK Provider Plugins](/plugins/sdk-provider-plugins) -- provider plugin hooks
- [Building Plugins](/plugins/building-plugins) -- getting started guide
