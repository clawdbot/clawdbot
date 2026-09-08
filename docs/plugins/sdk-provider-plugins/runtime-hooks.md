---
summary: "Per-hook provider wiring for auth exchange, headers, transport identity, usage, and the hook order table"
read_when:
  - You need a token exchange, custom headers, or native transport identity
  - You are exposing provider usage and billing data
  - You want the provider hook order table and runtime fallback notes
title: "Provider hook wiring"
sidebarTitle: "Hook wiring"
---

Wire individual provider hooks when a family builder does not cover the
behavior. Part of the [Building provider plugins](/plugins/sdk-provider-plugins)
guide; start with [Provider hook
families](/plugins/sdk-provider-plugins/hook-families) for the shared builders.

## Hook examples

<Tabs>
  <Tab title="Token exchange">
    For providers that need a token exchange before each inference call:

    ```typescript
    prepareRuntimeAuth: async (ctx) => {
      const exchanged = await exchangeToken(ctx.apiKey);
      return {
        apiKey: exchanged.token,
        baseUrl: exchanged.baseUrl,
        expiresAt: exchanged.expiresAt,
      };
    },
    ```

  </Tab>
  <Tab title="Custom headers">
    For providers that need custom request headers or body modifications:

    ```typescript
    // wrapStreamFn returns a StreamFn derived from ctx.streamFn
    wrapStreamFn: (ctx) => {
      if (!ctx.streamFn) return undefined;
      const inner = ctx.streamFn;
      return (model, context, options) =>
        inner(model, context, {
          ...options,
          headers: {
            ...options?.headers,
            "X-Acme-Version": "2",
          },
        });
    },
    ```

    Existing wrappers may still pass the deprecated `maxRetries` stream option,
    including `0`. Built-in text transports ignore it: the embedded runner owns
    retry budgeting, and SDK-internal retries stay disabled. New wrappers should
    omit the option. This shipped source contract is retained until a future
    Plugin SDK major release and a published-plugin reader sweep confirm removal
    is safe; it does not change image-generation or native-runtime retry policy.

  </Tab>
  <Tab title="Native transport identity">
    For providers that need native request/session headers or metadata on
    generic HTTP or WebSocket transports:

    ```typescript
    resolveTransportTurnState: (ctx) => ({
      headers: {
        "x-request-id": ctx.turnId,
      },
      metadata: {
        session_id: ctx.sessionId ?? "",
        turn_id: ctx.turnId,
      },
      websocket: {
        headers: {
          "x-session-id": ctx.sessionId ?? "",
        },
        degradeCooldownMs: 60_000,
      },
    }),
    ```

    The older `resolveWebSocketSessionPolicy` hook remains supported but is
    deprecated. Move its fields under `resolveTransportTurnState.websocket`;
    fields from the new hook take precedence during migration.

  </Tab>
  <Tab title="Usage and billing">
    For providers that expose usage/billing data:

    ```typescript
    resolveUsageAuth: async (ctx) => {
      const auth = await ctx.resolveOAuthToken();
      return auth ? { token: auth.token } : null;
    },
    fetchUsageSnapshot: async (ctx) => {
      return await fetchAcmeUsage(ctx.token, ctx.timeoutMs);
    },
    ```

    `resolveUsageAuth` has three outcomes. Return
    `{ token, accountId?, subscriptionType?, rateLimitTier? }` when the
    provider has a usage/billing credential (the optional fields carry
    non-secret plan metadata from the resolved profile into
    `fetchUsageSnapshot`). Return
    `{ handled: true }` only when the provider has definitively handled usage
    auth but has no usable usage token, and OpenClaw must skip generic
    API-key/OAuth fallback. Return `null` or `undefined` when the provider did
    not handle the request and OpenClaw should continue with generic fallback.

    Declare the provider id in `contracts.usageProviders`. When that manifest
    contract and **both** hooks are present, OpenClaw automatically includes
    the provider in usage collection without loading unrelated provider
    plugins. No core allowlist update is required.
    `fetchUsageSnapshot` returns the shared provider-neutral shape:

    - `plan`: provider-reported subscription or key label
    - `windows`: resettable quota windows as used percentages
    - `billing`: typed `balance`, `spend`, or `budget` entries; `unit` can be
      an ISO currency or a provider unit such as `credits`
    - `summary`: compact provider-specific context that does not fit those
      structured fields

    Keep currency semantics exact. A provider credit is not USD unless the
    upstream contract says so. A plugin that implements only
    `fetchUsageSnapshot` remains available for explicit/synthetic callers but
    is not auto-discovered, because OpenClaw cannot resolve its usage credential.

  </Tab>
</Tabs>

Set `supportsSystemPromptCacheBoundary: true` on a provider registration
only when its `createStreamFn` transport understands the stable/dynamic
system-prompt boundary. Use `splitSystemPromptCacheBoundary` from
`openclaw/plugin-sdk/provider-transport-runtime` to checkpoint the stable
prefix separately, and consume the marker before sending any payload.
Use `stripSystemPromptCacheBoundary` when caching is disabled. By default,
OpenClaw strips the marker before invoking a custom transport.

For custom `createStreamFn` transports that accumulate JSON tool arguments,
use `createToolArgumentPreviewSchedule()` from `openclaw/plugin-sdk/llm`.
Create one schedule per tool call and pass the accumulated raw string's
length to it before calling `parseStreamingJson`. The returned function
admits preview refreshes at geometric growth checkpoints, so intermediate
`arguments` snapshots can remain unchanged while raw fragments arrive.
Keep emitting every raw delta and validate the complete arguments at the
transport's terminal boundary, even when the last preview was not refreshed.

<Accordion title="Common provider hooks">
  OpenClaw calls hooks in roughly this order for model/provider plugins.
  Most providers only use 2-3. This is not the full `ProviderPlugin`
  contract - see [Internals: Provider Runtime
  Hooks](/plugins/architecture-internals#provider-runtime-hooks) for the
  complete, currently-accurate hook list and fallback notes.
  Compatibility-only provider fields that OpenClaw no longer calls, such as
  `ProviderPlugin.capabilities` and `suppressBuiltInModel`, are not listed
  here.

Keep `resolveSyntheticAuth` synchronous and bounded. External process/network login
checks belong in `prepareSyntheticAuth`, which receives the captured config,
environment, and cancellation signal and returns a synthetic auth result or
no result. OpenClaw retains completed availability within that preparation
generation. Read-only workers receive the final provider-ref outcome (including
unavailable), preserving alias precedence without rerunning external checks.
Cancelled preparation must reject after cleanup, not report a missing login.

| Hook                              | When to use                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `catalog`                         | Model catalog or base URL defaults                                                          |
| `applyConfigDefaults`             | Provider-owned global defaults during config materialization                                |
| `normalizeModelId`                | Legacy/preview model-id alias cleanup before lookup                                         |
| `normalizeTransport`              | Provider-family `api` / `baseUrl` cleanup before generic model assembly                     |
| `normalizeConfig`                 | Normalize `models.providers.<id>` config                                                    |
| `applyNativeStreamingUsageCompat` | Native streaming-usage compat rewrites for config providers                                 |
| `resolveConfigApiKey`             | Provider-owned env-marker auth resolution                                                   |
| `resolveSyntheticAuth`            | Local/self-hosted or config-backed synthetic auth                                           |
| `prepareSyntheticAuth`            | Asynchronously verify external auth before synchronous availability reads                   |
| `resolveExternalAuthProfiles`     | Overlay provider-owned external auth profiles for CLI/app-managed credentials               |
| `shouldDeferSyntheticProfileAuth` | Lower synthetic stored-profile placeholders behind env/config auth                          |
| `resolveDynamicModel`             | Accept arbitrary upstream model IDs                                                         |
| `prepareDynamicModel`             | Return an asynchronously discovered model, or warm reusable metadata before sync resolution |
| `normalizeResolvedModel`          | Transport rewrites before the runner                                                        |
| `normalizeToolSchemas`            | Provider-owned tool-schema cleanup before registration                                      |
| `inspectToolSchemas`              | Provider-owned tool-schema diagnostics                                                      |
| `resolveReasoningOutputMode`      | Tagged vs native reasoning-output contract                                                  |
| `prepareExtraParams`              | Default request params                                                                      |
| `createStreamFn`                  | Fully custom StreamFn transport                                                             |
| `wrapStreamFn`                    | Custom headers/body wrappers on the normal stream path                                      |
| `reconcileLocalService`           | Cheap, idempotent managed-service repair after health and before every request              |
| `resolveTransportTurnState`       | Native per-turn headers/metadata and WebSocket headers/cool-down                            |
| `resolveWebSocketSessionPolicy`   | Deprecated WebSocket compatibility hook; use `resolveTransportTurnState`                    |
| `formatApiKey`                    | Custom runtime token shape                                                                  |
| `loginOAuth`                      | Callback-based OAuth login for the session SDK `AuthStorage` API                            |
| `refreshOAuth`                    | Custom OAuth refresh                                                                        |
| `buildAuthDoctorHint`             | Auth repair guidance                                                                        |
| `matchesContextOverflowError`     | Provider-owned overflow detection                                                           |
| `classifyFailoverReason`          | Provider-owned rate-limit/overload classification                                           |
| `isCacheTtlEligible`              | Prompt cache TTL gating                                                                     |
| `buildMissingAuthMessage`         | Custom missing-auth hint                                                                    |
| `augmentModelCatalog`             | Synthetic forward-compat rows (deprecated - prefer `registerModelCatalogProvider`)          |
| `resolveThinkingProfile`          | Model-specific `/think` option set                                                          |
| `isBinaryThinking`                | Binary thinking on/off compatibility (deprecated - prefer `resolveThinkingProfile`)         |
| `supportsXHighThinking`           | `xhigh` reasoning support compatibility (deprecated - prefer `resolveThinkingProfile`)      |
| `resolveDefaultThinkingLevel`     | Default `/think` policy compatibility (deprecated - prefer `resolveThinkingProfile`)        |
| `isModernModelRef`                | Live/smoke model matching                                                                   |
| `prepareRuntimeAuth`              | Token exchange before inference                                                             |
| `resolveUsageAuth`                | Custom usage credential parsing                                                             |
| `fetchUsageSnapshot`              | Custom usage endpoint                                                                       |
| `createEmbeddingProvider`         | Provider-owned embedding adapter for memory/search                                          |
| `buildReplayPolicy`               | Custom transcript replay/compaction policy                                                  |
| `sanitizeReplayHistory`           | Provider-specific replay rewrites after generic cleanup                                     |
| `validateReplayTurns`             | Strict replay-turn validation before the embedded runner                                    |
| `onModelSelected`                 | Post-selection callback (e.g. telemetry)                                                    |

`reconcileLocalService` is called only for a configured local service,
including a healthy process reused by a restarted Gateway. Honor its
abort signal and reject when reconciliation fails; OpenClaw blocks the
provider request and releases the request lease.

Runtime fallback notes:

- Error classification uses the prepared provider owner or already loaded provider hooks. `matchesContextOverflowError` and `classifyFailoverReason` never trigger plugin discovery while handling an error; provider preparation owns loading those hooks.
- `normalizeConfig` resolves one owning plugin per provider id (bundled providers first, then the matched runtime plugin) and calls only that hook - there is no scan across other providers. Google's own `normalizeConfig` hook is what normalizes `google` / `google-vertex` / `google-antigravity` config entries; it is not a separate core fallback.
- `resolveConfigApiKey` uses the provider hook when exposed. Amazon Bedrock keeps AWS env-marker resolution in its provider plugin; runtime auth itself still uses the AWS SDK default chain when configured with `auth: "aws-sdk"`.
- `resolveThinkingProfile(ctx)` receives the selected `provider`, `modelId`, optional merged `reasoning` catalog hint, and optional merged model `compat` facts. Use `compat` only to select the provider's thinking UI/profile.
- `normalizeResolvedModel(ctx)` can set `compactionThinkingDefault` on the returned `ProviderRuntimeModel` when the provider has a preferred embedded-summary effort. This is prepared runtime metadata, not an operator setting or catalog field. Explicit `agents.defaults.compaction.thinkingLevel` takes precedence; otherwise the host uses this preference and then `low`. The chosen effort is still clamped to the actual compaction candidate.
- `resolveSystemPromptContribution` lets a provider inject cache-aware system-prompt guidance for a model family. Prefer it over the legacy plugin-wide `before_prompt_build` hook when the behavior belongs to one provider/model family and should preserve the stable/dynamic cache split.

Bundled and trusted official provider policies can use
`resolveEffortThinkingProfile(compat?.supportedReasoningEfforts)` from the
private `openclaw/plugin-sdk/provider-thinking-runtime` helper. It accepts
exact `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` values,
maps `none` to `off`, and prepends `off` while preserving the first occurrence
of each remaining level. The default preference is `medium`, `high`, `low`,
then `off`. Missing, null, or empty metadata returns `undefined`; a nonempty
list without supported values returns an off-only profile. Keep model-specific
overrides and API fallbacks in the provider policy.

Bundled and trusted official plugins can also export
`resolveToolSearchMode(ctx)` from their lightweight `provider-policy-api`
artifact. The context contains the final `provider`, `modelId`, `api`, and
optional `baseUrl`; its type is exported from
`openclaw/plugin-sdk/provider-model-types`. Return `"tools"` to prefer
structured Tool Search, `false` to veto the managed-local-service default,
or `undefined` to leave that decision to the host. The host records the
result on the resolved runtime model rather than writing configuration.
Explicit `tools.toolSearch` settings take precedence. This hook changes
schema exposure, not tool permissions or availability.

`resolveFastModeSupport(ctx)` can be exported from the same policy artifact
and registered on the provider. Return `false` only for a confirmed no-op
Fast choice, `true` for an applicable local request mapping, or `undefined`
when facts are missing. `ProviderFastModePolicyContext` carries the selected
model, route, auth mode, runtime, request parameters and transport policy;
credentials are not included. Share the policy with request construction.
The host publishes only `supportsFastMode`, preserving unknown behavior
and clearing saved preferences. This describes local applicability, not
upstream entitlement or fulfillment, and does not reject `/fast` commands.

</Accordion>
