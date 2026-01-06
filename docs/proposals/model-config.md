---
summary: "Proposal: model config, auth profiles, and fallback behavior"
read_when:
  - Designing model selection, auth profiles, or fallback behavior
  - Migrating model config schema
---

# Model config proposal

Goals
- Multi OAuth + multi API key per provider
- Model selection via `/model` with sensible fallback
- Global (not per-session) fallback logic
- Keep last-known-good auth profile when switching models
- Profile override only when explicitly requested
- Image routing override only when explicitly configured

Non-goals (v1)
- Auto-discovery of provider capabilities beyond catalog input tags
- Per-model auth profile order (see open questions)

## Proposed config shape

```json
{
  "auth": {
    "profiles": {
      "anthropic:default": {
        "provider": "anthropic",
        "mode": "oauth"
      },
      "anthropic:work": {
        "provider": "anthropic",
        "mode": "api_key"
      },
      "openai:default": {
        "provider": "openai",
        "mode": "oauth"
      }
    },
    "order": {
      "anthropic": ["anthropic:default", "anthropic:work"],
      "openai": ["openai:default"]
    }
  },
  "agent": {
    "models": {
      "anthropic/claude-opus-4-5": {
        "alias": "Opus"
      },
      "openai/gpt-5.2": {
        "alias": "gpt52"
      }
    },
    "model": {
      "primary": "anthropic/claude-opus-4-5",
      "fallbacks": ["openai/gpt-5.2"]
    },
    "imageModel": {
      "primary": "openai/gpt-5.2",
      "fallbacks": ["anthropic/claude-opus-4-5"]
    }
  }
}
```

Notes
- Canonical model keys are full `provider/model`.
- `alias` optional; used by `/model` resolution.
- `auth.profiles` is keyed. Default CLI login creates `provider:default`.
- `auth.order[provider]` controls rotation order for that provider.

## CLI / UX

Login
- `clawdbot login anthropic` → create/replace `anthropic:default`.
- `clawdbot login anthropic --profile work` → create/replace `anthropic:work`.

Model selection
- `/model Opus` → resolve alias to full id.
- `/model anthropic/claude-opus-4-5` → explicit.
- Optional: `/model Opus@anthropic:work` (explicit profile override for session only).

Model listing
- `/model` list shows:
  - model id
  - alias
  - provider
  - auth order (from `auth.order`)
  - auth source for the current provider (auth-profiles.json/env/shell env/models.json)

## Fallback behavior (global)

Fallback list
- Use `agent.model.fallbacks` globally.
- No per-session fallback list; last-known-good is per-session but uses global ordering.

Auth profile rotation
- If provider auth error (401/403/invalid refresh):
  - advance to next profile in `auth.order[provider]`.
  - if all fail, fall back to next model.

Rate limiting
- If rate limit / quota error:
  - rotate auth profile first (same provider)
  - if still failing, fall back to next model.

Model not found / capability mismatch
- immediate model fallback.

## Image routing

Rule
- Only use `agent.imageModel` when explicitly configured.
- If `agent.imageModel` is configured and the current text model lacks image input, use it.

Support detection
- From model catalog `input` tags when available (e.g. `image` in models.json).
- If unknown: treat as text-only and use `agent.imageModel`.

## Migration (doctor + gateway auto-run)

Inputs
- Legacy keys (pre-migration):
  - `agent.model` (string)
  - `agent.modelFallbacks` (string[])
  - `agent.imageModel` (string)
  - `agent.imageModelFallbacks` (string[])
  - `agent.allowedModels` (string[])
  - `agent.modelAliases` (record)

Outputs
- `agent.models` map with keys for all referenced models
- `agent.model.primary/fallbacks`
- `agent.imageModel.primary/fallbacks`
- Auth profile store seeded from current auth-profiles.json/auth.json + oauth.json + env (as `provider:default`)
- `auth.order` seeded with `["provider:default"]` when config is updated

Auto-run
- Gateway start detects legacy keys and runs doctor migration.

## Decisions

- Auth order is per-provider (`auth.order`).
- Doctor migration is required; gateway will auto-run on startup when legacy keys detected.
- `/model Opus@profile` is explicit session override only.
- Image routing override only when `agent.imageModel` is explicitly configured.
