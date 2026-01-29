# Kilo Gateway Provider Integration Design

## Overview

This document outlines the design for integrating "Kilo Gateway" as a first-class provider in Moltbot, modeled after the existing OpenRouter implementation. Kilo Gateway uses an OpenAI-compatible completions API with a different base URL.

## Design Decisions

### 1. Provider Naming

**Recommendation: `kilocode`**

Rationale:
- Matches the user config example provided (`kilocode` provider key)
- Consistent with existing provider naming patterns (e.g., `openrouter`, `opencode`, `moonshot`)
- Short and memorable
- Avoids confusion with generic "kilo" or "gateway" terms

Alternative considered: `kilo-gateway` - rejected because hyphenated names are less common in the codebase and `kilocode` is more concise.

### 2. Default Model Reference

**Recommendation: `kilocode/anthropic/claude-opus-4.5`**

Rationale:
- Based on user config example
- Claude Opus 4.5 is a capable default model
- Explicit model selection avoids reliance on auto-routing

### 3. Base URL Configuration

**Recommendation: Hardcoded default with config override**

- **Default Base URL:** `https://api.kilo.ai/api/openrouter/`
- **Configurable:** Yes, via `models.providers.kilocode.baseUrl`

This matches the pattern used by other providers like Moonshot, Venice, and Synthetic.

### 4. Model Scanning

**Recommendation: No dedicated model scanning endpoint initially**

Rationale:
- Kilo Gateway proxies to OpenRouter, so models are dynamic
- Users can manually configure models in their config
- If Kilo Gateway exposes a `/models` endpoint in the future, scanning can be added

### 5. Special Handling

**Recommendation: Inherit OpenRouter behavior for Anthropic models**

Since Kilo Gateway proxies to OpenRouter, the same special handling should apply:
- Cache TTL eligibility for `anthropic/*` models
- Extra params (cacheControlTtl) for `anthropic/*` models
- Transcript policy follows OpenRouter patterns

## Files to Modify

### Core Credential Management

#### 1. `src/commands/onboard-auth.credentials.ts`

Add:
```typescript
export const KILOCODE_DEFAULT_MODEL_REF = "kilocode/anthropic/claude-opus-4.5";

export async function setKilocodeApiKey(key: string, agentDir?: string) {
  upsertAuthProfile({
    profileId: "kilocode:default",
    credential: {
      type: "api_key",
      provider: "kilocode",
      key,
    },
    agentDir: resolveAuthAgentDir(agentDir),
  });
}
```

#### 2. `src/agents/model-auth.ts`

Add to `envMap` in `resolveEnvApiKey()`:
```typescript
const envMap: Record<string, string> = {
  // ... existing entries
  kilocode: "KILOCODE_API_KEY",
};
```

#### 3. `src/config/io.ts`

Add to `SHELL_ENV_EXPECTED_KEYS`:
```typescript
const SHELL_ENV_EXPECTED_KEYS = [
  // ... existing entries
  "KILOCODE_API_KEY",
];
```

### Config Application

#### 4. `src/commands/onboard-auth.config-core.ts`

Add new functions:
```typescript
export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/openrouter/";

export function applyKilocodeProviderConfig(cfg: MoltbotConfig): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[KILOCODE_DEFAULT_MODEL_REF] = {
    ...models[KILOCODE_DEFAULT_MODEL_REF],
    alias: models[KILOCODE_DEFAULT_MODEL_REF]?.alias ?? "Kilo Gateway",
  };

  const providers = { ...cfg.models?.providers };
  const existingProvider = providers.kilocode;
  const { apiKey: existingApiKey, ...existingProviderRest } = (existingProvider ?? {}) as Record<
    string,
    unknown
  > as { apiKey?: string };
  const resolvedApiKey = typeof existingApiKey === "string" ? existingApiKey : undefined;
  const normalizedApiKey = resolvedApiKey?.trim();
  
  providers.kilocode = {
    ...existingProviderRest,
    baseUrl: KILOCODE_BASE_URL,
    api: "openai-completions",
    ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
  };

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
      },
    },
    models: {
      mode: cfg.models?.mode ?? "merge",
      providers,
    },
  };
}

export function applyKilocodeConfig(cfg: MoltbotConfig): MoltbotConfig {
  const next = applyKilocodeProviderConfig(cfg);
  const existingModel = next.agents?.defaults?.model;
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model: {
          ...(existingModel && "fallbacks" in (existingModel as Record<string, unknown>)
            ? {
                fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks,
              }
            : undefined),
          primary: KILOCODE_DEFAULT_MODEL_REF,
        },
      },
    },
  };
}
```

### Auth Choice System

#### 5. `src/commands/onboard-types.ts`

Add to `AuthChoice` type:
```typescript
export type AuthChoice =
  // ... existing choices
  | "kilocode-api-key"
  // ...
```

Add to `OnboardOptions`:
```typescript
export type OnboardOptions = {
  // ... existing options
  kilocodeApiKey?: string;
  // ...
};
```

#### 6. `src/commands/auth-choice-options.ts`

Add to `AuthChoiceGroupId`:
```typescript
export type AuthChoiceGroupId =
  // ... existing groups
  | "kilocode"
  // ...
```

Add to `AUTH_CHOICE_GROUP_DEFS`:
```typescript
{
  value: "kilocode",
  label: "Kilo Gateway",
  hint: "API key (OpenRouter-compatible)",
  choices: ["kilocode-api-key"],
},
```

Add to `buildAuthChoiceOptions()`:
```typescript
options.push({
  value: "kilocode-api-key",
  label: "Kilo Gateway API key",
  hint: "OpenRouter-compatible gateway",
});
```

#### 7. `src/commands/auth-choice.preferred-provider.ts`

Add mapping:
```typescript
const PREFERRED_PROVIDER_BY_AUTH_CHOICE: Partial<Record<AuthChoice, string>> = {
  // ... existing mappings
  "kilocode-api-key": "kilocode",
};
```

### Auth Choice Application

#### 8. `src/commands/auth-choice.apply.api-providers.ts`

Add import:
```typescript
import {
  // ... existing imports
  applyKilocodeConfig,
  applyKilocodeProviderConfig,
  KILOCODE_DEFAULT_MODEL_REF,
  setKilocodeApiKey,
} from "./onboard-auth.js";
```

Add handling for `kilocode-api-key`:
```typescript
if (authChoice === "kilocode-api-key") {
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOrder = resolveAuthProfileOrder({
    cfg: nextConfig,
    store,
    provider: "kilocode",
  });
  const existingProfileId = profileOrder.find((profileId) => Boolean(store.profiles[profileId]));
  const existingCred = existingProfileId ? store.profiles[existingProfileId] : undefined;
  let profileId = "kilocode:default";
  let mode: "api_key" | "oauth" | "token" = "api_key";
  let hasCredential = false;

  if (existingProfileId && existingCred?.type) {
    profileId = existingProfileId;
    mode = existingCred.type === "oauth" ? "oauth" : existingCred.type === "token" ? "token" : "api_key";
    hasCredential = true;
  }

  if (!hasCredential && params.opts?.token && params.opts?.tokenProvider === "kilocode") {
    await setKilocodeApiKey(normalizeApiKeyInput(params.opts.token), params.agentDir);
    hasCredential = true;
  }

  if (!hasCredential) {
    const envKey = resolveEnvApiKey("kilocode");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing KILOCODE_API_KEY (${envKey.source}, ${formatApiKeyPreview(envKey.apiKey)})?`,
        initialValue: true,
      });
      if (useExisting) {
        await setKilocodeApiKey(envKey.apiKey, params.agentDir);
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) {
    const key = await params.prompter.text({
      message: "Enter Kilo Gateway API key",
      validate: validateApiKeyInput,
    });
    await setKilocodeApiKey(normalizeApiKeyInput(String(key)), params.agentDir);
    hasCredential = true;
  }

  if (hasCredential) {
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId,
      provider: "kilocode",
      mode,
    });
  }
  {
    const applied = await applyDefaultModelChoice({
      config: nextConfig,
      setDefaultModel: params.setDefaultModel,
      defaultModel: KILOCODE_DEFAULT_MODEL_REF,
      applyDefaultConfig: applyKilocodeConfig,
      applyProviderConfig: applyKilocodeProviderConfig,
      noteDefault: KILOCODE_DEFAULT_MODEL_REF,
      noteAgentModel,
      prompter: params.prompter,
    });
    nextConfig = applied.config;
    agentModelOverride = applied.agentModelOverride ?? agentModelOverride;
  }
  return { config: nextConfig, agentModelOverride };
}
```

Also add tokenProvider mapping at the top of the function:
```typescript
if (params.opts.tokenProvider === "kilocode") {
  authChoice = "kilocode-api-key";
}
```

### CLI Registration

#### 9. `src/cli/program/register.onboard.ts`

Add CLI option:
```typescript
.option("--kilocode-api-key <key>", "Kilo Gateway API key")
```

Add to action handler:
```typescript
kilocodeApiKey: opts.kilocodeApiKey as string | undefined,
```

Update auth-choice help text:
```typescript
.option(
  "--auth-choice <choice>",
  "Auth: setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|kilocode-api-key|ai-gateway-api-key|...",
)
```

### Non-Interactive Onboarding

#### 10. `src/commands/onboard-non-interactive/local/auth-choice.ts`

Add handling for `kilocode-api-key`:
```typescript
if (authChoice === "kilocode-api-key") {
  const resolved = await resolveNonInteractiveApiKey({
    provider: "kilocode",
    cfg: baseConfig,
    flagValue: opts.kilocodeApiKey,
    flagName: "--kilocode-api-key",
    envVar: "KILOCODE_API_KEY",
  });
  await setKilocodeApiKey(resolved.apiKey, agentDir);
  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "kilocode:default",
    provider: "kilocode",
    mode: "api_key",
  });
  // ... apply default model
}
```

### Export Updates

#### 11. `src/commands/onboard-auth.ts`

Add exports:
```typescript
export {
  // ... existing exports
  applyKilocodeConfig,
  applyKilocodeProviderConfig,
  KILOCODE_BASE_URL,
} from "./onboard-auth.config-core.js";

export {
  // ... existing exports
  KILOCODE_DEFAULT_MODEL_REF,
  setKilocodeApiKey,
} from "./onboard-auth.credentials.js";
```

### Special Handling (Optional)

#### 12. `src/agents/pi-embedded-runner/cache-ttl.ts`

Add Kilo Gateway support for Anthropic models:
```typescript
export function isCacheTtlEligibleProvider(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedProvider === "anthropic") return true;
  if (normalizedProvider === "openrouter" && normalizedModelId.startsWith("anthropic/")) return true;
  if (normalizedProvider === "kilocode" && normalizedModelId.startsWith("anthropic/")) return true;
  return false;
}
```

#### 13. `src/agents/pi-embedded-runner/extra-params.ts`

Add Kilo Gateway support:
```typescript
function resolveCacheControlTtl(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
  modelId: string,
): CacheControlTtl | undefined {
  const raw = extraParams?.cacheControlTtl;
  if (raw !== "5m" && raw !== "1h") return undefined;
  if (provider === "anthropic") return raw;
  if (provider === "openrouter" && modelId.startsWith("anthropic/")) return raw;
  if (provider === "kilocode" && modelId.startsWith("anthropic/")) return raw;
  return undefined;
}
```

#### 14. `src/agents/transcript-policy.ts`

Add Kilo Gateway handling (similar to OpenRouter):
```typescript
const isKilocodeGemini =
  provider === "kilocode" && modelId.toLowerCase().includes("gemini");

// Include in needsNonImageSanitize check
const needsNonImageSanitize = isGoogle || isAnthropic || isMistral || isOpenRouterGemini || isKilocodeGemini;
```

## Configuration Structure

### User Config Example

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "kilocode": {
        "baseUrl": "https://api.kilo.ai/api/openrouter/",
        "apiKey": "xxxxx",
        "api": "openai-completions",
        "models": [
          { "id": "anthropic/claude-opus-4.5", "name": "Anthropic: Claude Opus 4.5" },
          { "id": "minimax/minimax-m2.1:free", "name": "Minimax: Minimax M2.1" }
        ]
      }
    }
  }
}
```

### Auth Profile Structure

```json
{
  "profiles": {
    "kilocode:default": {
      "type": "api_key",
      "provider": "kilocode",
      "key": "xxxxx"
    }
  }
}
```

## Testing Considerations

1. **Unit Tests:**
   - Test `setKilocodeApiKey()` writes correct profile
   - Test `applyKilocodeConfig()` sets correct defaults
   - Test `resolveEnvApiKey("kilocode")` returns correct env var

2. **Integration Tests:**
   - Test onboarding flow with `--auth-choice kilocode-api-key`
   - Test non-interactive onboarding with `--kilocode-api-key`
   - Test model selection with `kilocode/` prefix

3. **E2E Tests:**
   - Test actual API calls through Kilo Gateway (live tests)

## Migration Notes

- No migration needed for existing users
- New users can immediately use `kilocode-api-key` auth choice
- Existing manual config with `kilocode` provider will continue to work

## Future Considerations

1. **Model Catalog:** If Kilo Gateway exposes a `/models` endpoint, add scanning support similar to `scanOpenRouterModels()`

2. **OAuth Support:** If Kilo Gateway adds OAuth, extend the auth system accordingly

3. **Rate Limiting:** Consider adding rate limit handling specific to Kilo Gateway if needed

4. **Documentation:** Add docs at `docs/providers/kilo-gateway.md` explaining setup and usage

## Summary of Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `src/commands/onboard-auth.credentials.ts` | Add | `KILOCODE_DEFAULT_MODEL_REF`, `setKilocodeApiKey()` |
| `src/agents/model-auth.ts` | Modify | Add `kilocode` to `envMap` |
| `src/config/io.ts` | Modify | Add `KILOCODE_API_KEY` to shell env keys |
| `src/commands/onboard-auth.config-core.ts` | Add | `applyKilocodeProviderConfig()`, `applyKilocodeConfig()` |
| `src/commands/onboard-types.ts` | Modify | Add `kilocode-api-key` to `AuthChoice`, add `kilocodeApiKey` to options |
| `src/commands/auth-choice-options.ts` | Modify | Add `kilocode` group and option |
| `src/commands/auth-choice.preferred-provider.ts` | Modify | Add `kilocode-api-key` mapping |
| `src/commands/auth-choice.apply.api-providers.ts` | Modify | Add `kilocode-api-key` handling |
| `src/cli/program/register.onboard.ts` | Modify | Add `--kilocode-api-key` option |
| `src/commands/onboard-non-interactive/local/auth-choice.ts` | Modify | Add non-interactive handling |
| `src/commands/onboard-auth.ts` | Modify | Export new functions |
| `src/agents/pi-embedded-runner/cache-ttl.ts` | Modify | Add kilocode support |
| `src/agents/pi-embedded-runner/extra-params.ts` | Modify | Add kilocode support |
| `src/agents/transcript-policy.ts` | Modify | Add kilocode Gemini handling |
