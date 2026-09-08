---
summary: "Manifest model catalog, shorthand family, id normalization, and pricing fields"
read_when:
  - You own a provider plugin and must declare its models
  - You need catalog rows, aliases, or suppressions read before runtime loads
  - You are mapping provider models to a published pricing source
title: "Manifest model fields"
sidebarTitle: "Model fields"
---

Manifest fields that describe the models a provider plugin exposes: which shorthand ids it claims, the catalog rows core can read before runtime loads, model-id cleanup, and hosted pricing policy. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

## modelSupport reference

Use `modelSupport` when OpenClaw should infer your provider plugin from shorthand model ids like `gpt-5.6-sol` or `claude-sonnet-4.6` before plugin runtime loads.

```json
{
  "modelSupport": {
    "modelPrefixes": ["gpt-", "o1", "o3", "o4"],
    "modelPatterns": ["^computer-use-preview"]
  }
}
```

OpenClaw applies this precedence:

- explicit `provider/model` refs use the owning `providers` manifest metadata
- `modelPatterns` beat `modelPrefixes`
- if one non-bundled plugin and one bundled plugin both match, the non-bundled plugin wins
- remaining ambiguity is ignored until the user or config specifies a provider

Fields:

| Field           | Type       | What it means                                                                   |
| --------------- | ---------- | ------------------------------------------------------------------------------- |
| `modelPrefixes` | `string[]` | Prefixes matched with `startsWith` against shorthand model ids.                 |
| `modelPatterns` | `string[]` | Regex sources matched against shorthand model ids after profile suffix removal. |

`modelPatterns` entries are compiled through `compileSafeRegex`, which rejects patterns containing nested repetition (for example `(a+)+$`). Patterns that fail the safety check are silently skipped, the same as syntactically invalid regex. Keep patterns simple and avoid nested quantifiers.

## modelCatalog reference

Use `modelCatalog` when OpenClaw should know provider model metadata before loading plugin runtime. This is the manifest-owned source for fixed catalog rows, publication-time metadata sources, provider aliases, suppression rules, and discovery mode. Runtime refresh still belongs in provider runtime code, but the manifest tells core when runtime is required.

```json
{
  "providers": ["openai"],
  "modelCatalog": {
    "modelsDev": {
      "openai": "openai"
    },
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "api": "openai-responses",
        "models": [
          {
            "id": "gpt-5.4",
            "name": "GPT-5.4",
            "input": ["text", "image"],
            "reasoning": true,
            "contextWindow": 256000,
            "maxTokens": 128000,
            "cost": {
              "input": 1.25,
              "output": 10,
              "cacheRead": 0.125
            },
            "status": "available",
            "tags": ["default"]
          }
        ]
      }
    },
    "aliases": {
      "azure-openai-responses": {
        "provider": "openai",
        "api": "azure-openai-responses"
      }
    },
    "suppressions": [
      {
        "provider": "azure-openai-responses",
        "model": "gpt-5.3-codex-spark",
        "reason": "not available on Azure OpenAI Responses"
      }
    ],
    "discovery": {
      "openai": "static"
    }
  }
}
```

Top-level fields:

| Field            | Type                                                     | What it means                                                                                               |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `modelsDev`      | `Record<string, string>`                                 | Publication-time opt-in mapping from an owned OpenClaw provider id to a models.dev provider id.             |
| `providers`      | `Record<string, object>`                                 | Catalog rows for provider ids owned by this plugin. Keys should also appear in top-level `providers`.       |
| `aliases`        | `Record<string, object>`                                 | Provider aliases that should resolve to an owned provider for catalog or suppression planning.              |
| `suppressions`   | `object[]`                                               | Model rows from another source that this plugin suppresses for a provider-specific reason.                  |
| `discovery`      | `Record<string, "static" \| "refreshable" \| "runtime">` | Whether the provider catalog can be read from manifest metadata, refreshed into cache, or requires runtime. |
| `runtimeAugment` | `boolean`                                                | Set to `true` only when the provider runtime must append catalog rows after manifest/config planning.       |

`modelsDev` opts an owned provider into models.dev metadata hydration when the hosted catalog is published. Declare the upstream provider once per OpenClaw provider, not once per model. Omission means no models.dev hydration; there is no central provider fallback. Keys are normalized as OpenClaw provider ids and source ids are trimmed. Empty or non-string source ids and mappings for unowned providers are ignored; an alias alone does not grant ownership. A mapping does not create catalog provider rows or relax their validation.

Hydration adds eligible model ids and fills only undefined metadata. Explicit manifest values remain authoritative, including `false`; models.dev never supplies transport settings or prices. Prices still follow the provider-owned pricing policy. Opt in only when the provider defaults are appropriate for newly imported rows; providers that choose a transport per model should not opt in unless those defaults are safe. Hydration errors fail publication, leaving the last published artifact intact. The publisher hydrates opted-in metadata even without `--pricing`; that flag controls price enrichment only. A dry run performs the same metadata hydration without writing the artifact.

This field is publication-time authoring metadata, not a Gateway discovery hook. It does not add runtime network calls or hot reload; the existing [hosted catalog update lifecycle](/concepts/models#hosted-catalog-updates) is unchanged.

`aliases` participates in provider ownership lookup for model-catalog planning. Alias targets must be top-level providers owned by the same plugin. When a provider-filtered list uses an alias, OpenClaw can read the owning manifest and apply alias API/base URL overrides without loading provider runtime. Aliases do not expand unfiltered catalog listings; broad lists emit the owning canonical provider rows only.

`suppressions` replaces the old provider runtime `suppressBuiltInModel` hook. Suppression entries are honored only when the provider is owned by the plugin or declared as a `modelCatalog.aliases` key that targets an owned provider. Runtime suppression hooks are no longer called during model resolution.

Provider fields:

| Field                 | Type                     | What it means                                                                                                                                                                                                     |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`             | `string`                 | Optional default base URL for models in this provider catalog.                                                                                                                                                    |
| `api`                 | `ModelApi`               | Optional default API adapter for models in this provider catalog.                                                                                                                                                 |
| `headers`             | `Record<string, string>` | Optional static headers that apply to this provider catalog.                                                                                                                                                      |
| `defaultUtilityModel` | `string`                 | Optional provider-recommended small model id for short internal utility tasks (titles, progress narration). Used when `agents.defaults.utilityModel` is unset and this provider serves the agent's primary model. |
| `models`              | `object[]`               | Required model rows. Rows without an `id` are ignored.                                                                                                                                                            |

Model fields:

| Field                  | Type                                                           | What it means                                                                        |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `id`                   | `string`                                                       | Provider-local model id, without the `provider/` prefix.                             |
| `name`                 | `string`                                                       | Optional display name.                                                               |
| `api`                  | `ModelApi`                                                     | Optional per-model API override.                                                     |
| `baseUrl`              | `string`                                                       | Optional per-model base URL override.                                                |
| `headers`              | `Record<string, string>`                                       | Optional per-model static headers.                                                   |
| `input`                | `Array<"text" \| "image" \| "document">`                       | Modalities the model accepts. Other values are silently dropped.                     |
| `reasoning`            | `boolean`                                                      | Whether the model exposes reasoning behavior.                                        |
| `contextWindow`        | `number`                                                       | Native provider context window.                                                      |
| `contextWindows`       | `Array<{ id: string; label: string; contextWindow: number }>`  | Up to 16 selectable windows, normalized in ascending token-count order.              |
| `contextWindowDefault` | `string`                                                       | Default selectable-window id; must name an entry in `contextWindows`.                |
| `contextTokens`        | `number`                                                       | Optional effective runtime context cap when different from `contextWindow`.          |
| `maxTokens`            | `number`                                                       | Maximum output tokens when known.                                                    |
| `thinkingLevelMap`     | `Record<string, string \| null>`                               | Optional per-thinking-level model-id or param overrides.                             |
| `cost`                 | `object`                                                       | Optional USD per million token pricing, including optional `tieredPricing`.          |
| `compat`               | `object`                                                       | Optional compatibility flags matching OpenClaw model config compatibility.           |
| `upstreamModel`        | `string`                                                       | Optional `provider/model` ref of the same upstream model in another bundled catalog. |
| `mediaInput`           | `object`                                                       | Optional per-modality input config, currently image-only.                            |
| `status`               | `"available"` \| `"preview"` \| `"deprecated"` \| `"disabled"` | Listing status. Suppress only when the row must not appear at all.                   |
| `statusReason`         | `string`                                                       | Optional reason shown with non-available status.                                     |
| `replaces`             | `string[]`                                                     | Older provider-local model ids this model supersedes.                                |
| `replacedBy`           | `string`                                                       | Replacement provider-local model id for deprecated rows.                             |
| `tags`                 | `string[]`                                                     | Stable tags used by pickers and filters.                                             |

Suppression fields:

| Field                      | Type       | What it means                                                                                                                                              |
| -------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                 | `string`   | Provider id for the upstream row to suppress. Must be owned by this plugin or declared as an owned alias.                                                  |
| `model`                    | `string`   | Provider-local model id to suppress.                                                                                                                       |
| `reason`                   | `string`   | Optional message shown when the suppressed row is requested directly.                                                                                      |
| `retirement`               | `object`   | Explicit permanent retirement metadata. Enables doctor repair; an empty object means no successor is declared.                                             |
| `retirement.replacedBy`    | `string`   | Documented provider-local successor model id, including any slashes in that id. Doctor preserves applicable account pins and repairs persisted references. |
| `when.baseUrlHosts`        | `string[]` | Optional list of effective provider base URL hosts required before the suppression applies.                                                                |
| `when.providerConfigApiIn` | `string[]` | Optional list of exact provider-config `api` values required before the suppression applies.                                                               |

Declare retirement only from affirmative provider evidence, never from a failed or empty discovery request. Scope account-route retirements with `when.baseUrlHosts`; matching those rules requires a concrete selected endpoint and leaves sibling endpoints untouched. Unconditional retirement rules do not require credentials. Malformed or empty retirement scopes are ignored rather than becoming global rules. Runtime blocks that retired route, while `openclaw doctor --fix` owns persistent replacement or override removal. Ordinary suppression and a model row's `deprecated` listing status do not authorize retirement repair. Manifest changes take effect after Gateway restart or the owning metadata reload.

`upstreamModel` marks a row that serves the same upstream model as a row in another bundled catalog under a different name, for example a subscription endpoint next to the vendor's API endpoint. It is authoring metadata: normalization drops it, and a contract test uses it to keep capability flags such as `compat.codeMode` from drifting between catalogs that ship the same model. Most rows need no marker, because matching ignores a leading vendor namespace and casing: `moonshotai/kimi-k3` and `zai-org/GLM-5.2` already match the first-party `kimi-k3` and `glm-5.2` rows. Reach for `upstreamModel` only when the vendor's own names genuinely differ. See [Code mode](/tools/code-mode#models-shipped-by-more-than-one-provider).

Do not put runtime-only data in `modelCatalog`. Use `static` only when manifest rows are complete enough for provider-filtered list and picker surfaces to skip registry/runtime discovery. Use `refreshable` when manifest rows are useful listable seeds or supplements but a refresh/cache can add more rows later; refreshable rows are not authoritative by themselves. Use `runtime` when OpenClaw must load provider runtime to know the list.

Capabilities belong to the declared API and base URL, not only the provider/model id. When model listing enriches a cached row, it uses manifest capabilities only for a matching route; a custom endpoint must supply its own limits and capabilities.

## modelIdNormalization reference

Use `modelIdNormalization` for cheap provider-owned model-id cleanup that must happen before provider runtime loads. This keeps aliases such as short model names, provider-local legacy ids, and proxy prefix rules in the owning plugin manifest instead of in core model-selection tables.

```json
{
  "providers": ["anthropic", "openrouter"],
  "modelIdNormalization": {
    "providers": {
      "anthropic": {
        "aliases": {
          "sonnet-4.6": "claude-sonnet-4-6"
        }
      },
      "openrouter": {
        "prefixWhenBare": "openrouter"
      }
    }
  }
}
```

Provider fields:

| Field                                | Type                    | What it means                                                                             |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| `aliases`                            | `Record<string,string>` | Case-insensitive exact model-id aliases. Values are returned as written.                  |
| `stripPrefixes`                      | `string[]`              | Prefixes to remove before alias lookup, useful for legacy provider/model duplication.     |
| `prefixWhenBare`                     | `string`                | Prefix to add when the normalized model id does not already contain `/`.                  |
| `prefixWhenBareAfterAliasStartsWith` | `object[]`              | Conditional bare-id prefix rules after alias lookup, keyed by `modelPrefix` and `prefix`. |

## modelPricing reference

Use `modelPricing` when the hosted catalog publisher needs provider-specific pricing-key behavior. The publisher reads this metadata without importing provider runtime code.

```json
{
  "providers": ["ollama", "openrouter"],
  "modelPricing": {
    "providers": {
      "ollama": {
        "external": false
      },
      "openrouter": {
        "openRouter": {
          "passthroughProviderModel": true
        },
        "liteLLM": false
      }
    }
  }
}
```

Provider fields:

| Field        | Type              | What it means                                                                                   |
| ------------ | ----------------- | ----------------------------------------------------------------------------------------------- |
| `cerebras`   | `false \| object` | Explicit mapping to the public Cerebras `/public/v1/models` catalog. Never enabled implicitly.  |
| `chutes`     | `false \| object` | Explicit mapping to the public Chutes `/v1/models` catalog. Never enabled implicitly.           |
| `deepinfra`  | `false \| object` | Explicit mapping to the public DeepInfra `/models/list` catalog. Never enabled implicitly.      |
| `external`   | `boolean`         | Set `false` for local/self-hosted providers that should never use published external pricing.   |
| `openCode`   | `false \| object` | Explicit mapping to the public `models.opencode.ai/api.json` catalog. Never enabled implicitly. |
| `openRouter` | `false \| object` | OpenRouter publication-key mapping. `false` disables OpenRouter matching for this provider.     |
| `liteLLM`    | `false \| object` | LiteLLM publication-key mapping. `false` disables LiteLLM matching for this provider.           |
| `venice`     | `false \| object` | Explicit mapping to the public Venice `/api/v1/models` catalog. Never enabled implicitly.       |

Source fields:

| Field                      | Type               | What it means                                                                                                        |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `provider`                 | `string`           | External catalog provider id when it differs from the OpenClaw provider id, for example `z-ai` for a `zai` provider. |
| `passthroughProviderModel` | `boolean`          | Treat slash-containing model ids as nested provider/model refs, useful for proxy providers such as OpenRouter.       |
| `modelIdTransforms`        | `"version-dots"[]` | Extra external catalog model-id variants. `version-dots` tries dotted version ids like `claude-opus-4.6`.            |

A declared provider policy enables only its declared source mappings. Without a
policy, publication tries OpenRouter, then LiteLLM. Each selected price is a
complete schedule: base rates and context tiers are never combined across sources.
OpenRouter's native prompt-length overrides are supported; time-based overrides
are not represented as static context tiers.

For authoritative native source mappings, use:

```json
{
  "providers": ["opencode", "venice"],
  "modelPricing": {
    "providers": {
      "opencode": { "openCode": { "provider": "opencode" } },
      "venice": { "venice": { "provider": "venice" } }
    }
  }
}
```

The publisher fetches a fixed public endpoint without credentials only when its
source is declared, and publishes native prices only in explicitly mapped owner
namespaces. Cerebras, Chutes, and DeepInfra use the same shape with their respective source
and provider IDs. Lightweight plugin-owned `pricing-api.ts` artifacts share
payload parsing with runtime discovery without importing provider runtimes.

DeepInfra's top-level array uses `model_name` identity. Its numeric discount and
cached-input ratio apply to native cents-per-token prices. Pricing prose,
nonempty tables, scheduled expiry, and undocumented generic cache-write rates
are validated but omitted as unsupported schedules. Priority/flex and explicit
cache-retention multipliers do not change standard costs. Its agent projection
continues to own runtime metadata; the pricing feed does not discover chat models.

An opted-in native source owns the complete provider schedule, including missing
prices: generic sources cannot fill its gaps. A successful feed with no price for
a bundled model preserves that model's metadata, omits its cost, and emits a
publication warning. Missing pricing is not evidence of model retirement or free
usage. Explicit native zero prices remain known-free estimates. Fetch failure,
malformed response bodies or declared prices, and feeds with no usable prices
stop publication, leaving the previous hosted catalog intact. Explicit operator
rates remain unchanged. This authoring metadata adds no operator setting and does
not change the Gateway's existing refresh and restart lifecycle.

### OpenClaw Provider Index

The compiled OpenClaw Provider Index is retired. Model metadata comes from plugin manifests, provider-owned discovery, and the hosted model catalog, with configured overrides applied by model resolution. See [Model listing](/cli/models#list) for catalog sources and refresh behavior.

Provider setup uses installed manifest metadata and the official external plugin catalog. The external catalog supplies install hints and auth-choice labels for plugins that are not installed; installed plugin owners take precedence. Install hints remain in `package.json#openclaw.install`, not in a separate compiled provider index.

`openclaw doctor --fix` migrates a small, closed set of legacy top-level manifest capability keys into `contracts.*`: `speechProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, and `tools`. None of these (or any other capability list) are read as top-level manifest fields anymore; normal manifest loading only recognizes them under `contracts`.
