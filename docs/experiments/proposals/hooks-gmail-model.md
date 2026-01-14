---
summary: "Spec for hooks.gmail.model - cheaper model for Gmail PubSub processing"
read_when:
  - Implementing hooks.gmail.model feature
  - Modifying Gmail hook processing
  - Working on hook model selection
---
# hooks.gmail.model: Cheaper Model for Gmail PubSub Processing

## Problem

Gmail PubSub hook processing (`/gmail-pubsub`) currently uses the session's primary model (`agents.defaults.model.primary`), which may be an expensive model like `claude-opus-4-5`. For automated email processing that doesn't require the most capable model, this wastes tokens/cost.

## Solution

Add `hooks.gmail.model` config option to specify an optional cheaper model for Gmail PubSub processing, with intelligent fallback to the primary model on auth/rate-limit/timeout failures.

## Config Structure

```json5
{
  hooks: {
    gmail: {
      account: "user@gmail.com",
      // ... existing gmail config ...

      // NEW: Optional model override for Gmail hook processing
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",

      // NEW: Optional thinking level override
      thinking: "off"
    }
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hooks.gmail.model` | `string` | (none) | Model to use for Gmail hook processing. Accepts `provider/model` refs or aliases from `agents.defaults.models`. |
| `hooks.gmail.thinking` | `string` | (inherited) | Thinking level override (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex models only). If unset, inherits from `agents.defaults.thinkingDefault` or model's default. |

### Alias Support

`hooks.gmail.model` accepts:
- Full refs: `"openrouter/meta-llama/llama-3.3-70b-instruct:free"`
- Aliases from `agents.defaults.models`: `"Opus"`, `"Sonnet"`, `"GLM"`

Resolution uses `buildModelAliasIndex()` from `model-selection.ts`.

## Fallback Behavior

### Fallback Triggers

Auth, rate-limit, and timeout errors trigger fallback:
- `401 Unauthorized`
- `403 Forbidden`
- `429 Too Many Requests`
- Timeouts (provider hangs / network timeouts)

Other errors (500s, content errors) fail in place.

### Fallback Chain

```
hooks.gmail.model (if set)
    ↓ (on auth/rate-limit/timeout)
agents.defaults.model.fallbacks[0..n]
    ↓ (exhausted)
agents.defaults.model.primary
```

### Uncatalogued Model

If `hooks.gmail.model` is set but not found in the model catalog or allowlist:
- **Config load**: Log warning (surfaced in `clawdbot doctor`)
- **Allowlist**: If `agents.defaults.models` is set and the model isn't listed, the hook falls back to primary.

### Cooldown Integration

Uses existing model-failover cooldown from `model-failover.ts`:
- After auth/rate-limit failure, model enters cooldown
- Next hook invocation respects cooldown before retrying
- Integrates with auth profile rotation

## Implementation

### Type Changes

```typescript
// src/config/types.ts
export type HooksGmailConfig = {
  account?: string;
  label?: string;
  // ... existing fields ...

  /** Optional model override for Gmail hook processing (provider/model or alias). */
  model?: string;
  /** Optional thinking level override for Gmail hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};
```

### Model Resolution

New function in `src/cron/isolated-agent.ts` or `src/agents/model-selection.ts`:

```typescript
export function resolveHooksGmailModel(params: {
  cfg: ClawdbotConfig;
  defaultProvider: string;
  defaultModel: string;
}): { provider: string; model: string; isHooksOverride: boolean } | null {
  const hooksModel = params.cfg.hooks?.gmail?.model;
  if (!hooksModel) return null;

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });

  const resolved = resolveModelRefFromString({
    raw: hooksModel,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });

  if (!resolved) return null;
  return {
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isHooksOverride: true,
  };
}
```

### Processing Flow

In `runCronIsolatedAgentTurn()` (or new wrapper for hooks):

```typescript
// Resolve model - prefer hooks.gmail.model for Gmail hooks
const isGmailHook = params.sessionKey.startsWith("hook:gmail:");
const hooksModelRef = isGmailHook
  ? resolveHooksGmailModel({ cfg, defaultProvider, defaultModel })
  : null;

const { provider, model } = hooksModelRef ?? resolveConfiguredModelRef({
  cfg: params.cfg,
  defaultProvider: DEFAULT_PROVIDER,
  defaultModel: DEFAULT_MODEL,
});

// Run with fallback - on auth/rate-limit/timeout, fall through to agents.defaults.model.fallbacks
const fallbackResult = await runWithModelFallback({
  cfg: params.cfg,
  provider,
  model,
  hooksOverride: hooksModelRef?.isHooksOverride,
  run: (providerOverride, modelOverride) => runEmbeddedPiAgent({
    // ... existing params ...
  }),
});
```

### Fallback Detection

Extend `runWithModelFallback()` to detect auth/rate-limit:

```typescript
function isAuthRateLimitError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return [401, 403, 429].includes(err.status);
  }
  // Check for common patterns in error messages
  const msg = String(err).toLowerCase();
  return msg.includes("unauthorized")
    || msg.includes("rate limit")
    || msg.includes("quota exceeded");
}
```

## Validation

### Config Load Time

In config validation (for `clawdbot doctor`):

```typescript
if (cfg.hooks?.gmail?.model) {
  const resolved = resolveHooksGmailModel({ cfg, defaultProvider, defaultModel });
  if (!resolved) {
    issues.push({
      path: "hooks.gmail.model",
      message: `Model "${cfg.hooks.gmail.model}" could not be resolved`,
    });
  } else {
    const catalog = await loadModelCatalog({ config: cfg });
    const key = modelKey(resolved.provider, resolved.model);
    const inCatalog = catalog.some(e => modelKey(e.provider, e.id) === key);
    if (!inCatalog) {
      issues.push({
        path: "hooks.gmail.model",
        message: `Model "${key}" not found in agents.defaults.models catalog (will fall back to primary)`,
      });
    }
  }
}
```

### Runtime

At hook invocation time, validate and fall back:
- If model not in catalog → log warning, use primary
- If model auth fails → log warning, enter cooldown, fall back

## Observability

### Log Messages

```
[hooks] Gmail hook: using model openrouter/meta-llama/llama-3.3-70b-instruct:free
[hooks] Gmail hook: model llama auth failed (429), falling back to claude-opus-4-5
```

### Hook Event Summary

Include fallback info in the hook summary sent to session:

```
Hook Gmail (fallback:llama→opus): <summary>
```

## Hot Reload

`hooks.gmail.model` and `hooks.gmail.thinking` are hot-reloadable:
- Changes apply to the next hook invocation
- No gateway restart required
- Hooks config is already in the hot-reload matrix

## Test Plan

### Unit Tests

1. **Model resolution** (`model-selection.test.ts`):
   - `resolveHooksGmailModel()` with valid ref
   - `resolveHooksGmailModel()` with alias
   - `resolveHooksGmailModel()` with invalid input → null

2. **Config validation** (`config.test.ts`):
   - Warning on uncatalogued model
   - No warning on valid model
   - Graceful handling of missing hooks.gmail section

3. **Fallback triggers** (`model-fallback.test.ts`):
   - 401/403/429 → triggers fallback
   - timeouts → triggers fallback
   - 500/content error → no fallback
   - Content error → no fallback

### Integration Tests

1. **Hook processing** (`server.hooks.test.ts`):
   - Gmail hook uses `hooks.gmail.model` when set
   - Fallback to primary on auth failure
   - Thinking level override applied

2. **Hot reload** (`config-reload.test.ts`):
   - Change `hooks.gmail.model` → next hook uses new model

## Documentation

Update `docs/gateway/configuration.md`:

```json5
{
  hooks: {
    gmail: {
      account: "user@gmail.com",
      topic: "projects/my-project/topics/gmail-watch",
      // ... existing config ...

      // Optional: Use a cheaper model for Gmail processing
      // Falls back to agents.defaults.model.primary on auth/rate-limit errors
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",

      // Optional: Override thinking level for Gmail processing
      thinking: "off"
    }
  }
}
```

## Scope Limitation

This PR is Gmail-specific. Future hooks (`hooks.github.model`, etc.) would follow the same pattern but are out of scope.

## Changelog Entry

```
- feat: add hooks.gmail.model for cheaper Gmail PubSub processing (#XXX)
  - Falls back to agents.defaults.model.primary on auth/rate-limit/timeouts (401/403/429)
  - Supports aliases from agents.defaults.models
  - Add hooks.gmail.thinking override
```
