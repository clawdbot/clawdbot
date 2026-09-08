---
summary: "Manifest generation, media-understanding, endpoint, and request provider metadata"
read_when:
  - You own an image, video, music, or media-understanding provider
  - You need core to classify a provider endpoint before runtime loads
  - You are declaring cheap availability signals instead of importing runtime
title: "Manifest provider fields"
sidebarTitle: "Provider fields"
---

Manifest fields that tell core what a provider can do, and how to reach it, without importing the provider runtime. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

## Generation provider metadata reference

The generation provider metadata fields describe static auth signals for providers declared in the matching `contracts.*GenerationProviders` list. OpenClaw reads these fields before provider runtime loads so core tools can decide whether a generation provider is available without importing every provider plugin.

Use these fields only for cheap, declarative facts. Transport, request transforms, token refresh, credential validation, and actual generation behavior stay in the plugin runtime.

```json
{
  "contracts": {
    "imageGenerationProviders": ["example-image"]
  },
  "imageGenerationProviderMetadata": {
    "example-image": {
      "aliases": ["example-image-oauth"],
      "authProviders": ["example-image"],
      "configSignals": [
        {
          "rootPath": "plugins.entries.example-image.config",
          "overlayPath": "image",
          "mode": {
            "path": "mode",
            "default": "local",
            "allowed": ["local"]
          },
          "requiredAny": ["workflow", "workflowPath"],
          "required": ["promptNodeId"]
        }
      ],
      "authSignals": [
        {
          "provider": "example-image"
        },
        {
          "provider": "example-image-oauth",
          "providerBaseUrl": {
            "provider": "example-image",
            "defaultBaseUrl": "https://api.example.com/v1",
            "allowedBaseUrls": ["https://api.example.com/v1"]
          }
        }
      ]
    }
  }
}
```

Each metadata entry supports:

| Field                  | Required | Type       | What it means                                                                                                                                       |
| ---------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aliases`              | No       | `string[]` | Additional provider ids that should count as static auth aliases for the generation provider.                                                       |
| `authProviders`        | No       | `string[]` | Provider ids whose configured auth profiles should count as auth for this generation provider.                                                      |
| `configSignals`        | No       | `object[]` | Cheap config-only availability signals for local or self-hosted providers that can be configured without auth profiles or env vars.                 |
| `authSignals`          | No       | `object[]` | Explicit auth signals. When present, these replace the default signal set from the provider id, `aliases`, and `authProviders`.                     |
| `referenceAudioInputs` | No       | `boolean`  | Video-generation only. Set to `true` when the provider accepts reference audio assets; otherwise `video_generate` hides audio reference parameters. |

Each `configSignals` entry supports:

| Field            | Required | Type       | What it means                                                                                                                                                                             |
| ---------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rootPath`       | Yes      | `string`   | Dot path to the plugin-owned config object to inspect, for example `plugins.entries.example.config`.                                                                                      |
| `overlayPath`    | No       | `string`   | Dot path inside the root config whose object should overlay the root object before evaluating the signal. Use this for capability-specific config such as `image`, `video`, or `music`.   |
| `overlayMapPath` | No       | `string`   | Dot path inside the root config whose object values should each overlay the root object. Use this for named account maps such as `accounts`, where any configured account should qualify. |
| `required`       | No       | `string[]` | Dot paths inside the effective config that must have configured values. Strings must be non-empty; objects and arrays must not be empty.                                                  |
| `requiredAny`    | No       | `string[]` | Dot paths inside the effective config where at least one must have a configured value.                                                                                                    |
| `mode`           | No       | `object`   | Optional string mode guard inside the effective config. Use this when config-only availability applies only to one mode.                                                                  |

Each `mode` guard supports:

| Field        | Required | Type       | What it means                                                                      |
| ------------ | -------- | ---------- | ---------------------------------------------------------------------------------- |
| `path`       | No       | `string`   | Dot path inside the effective config. Defaults to `mode`.                          |
| `default`    | No       | `string`   | Mode value to use when the config omits the path.                                  |
| `allowed`    | No       | `string[]` | If present, the signal passes only when the effective mode is one of these values. |
| `disallowed` | No       | `string[]` | If present, the signal fails when the effective mode is one of these values.       |

Each `authSignals` entry supports:

| Field             | Required | Type     | What it means                                                                                                                                                                 |
| ----------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | Yes      | `string` | Provider id to check in configured auth profiles.                                                                                                                             |
| `providerBaseUrl` | No       | `object` | Optional guard that makes the signal count only when the referenced configured provider uses an allowed base URL. Use this when an auth alias is valid only for certain APIs. |

Each `providerBaseUrl` guard supports:

| Field             | Required | Type       | What it means                                                                                                                                        |
| ----------------- | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`        | Yes      | `string`   | Provider config id whose `baseUrl` should be checked.                                                                                                |
| `defaultBaseUrl`  | No       | `string`   | Base URL to assume when the provider config omits `baseUrl`.                                                                                         |
| `allowedBaseUrls` | Yes      | `string[]` | Allowed base URLs for this auth signal. The signal is ignored when the configured or default base URL does not match one of these normalized values. |

## mediaUnderstandingProviderMetadata reference

Use `mediaUnderstandingProviderMetadata` when a media-understanding provider has default models, auto-auth fallback priority, or native document support that generic core helpers need before runtime loads. Keys must also be declared in `contracts.mediaUnderstandingProviders`.

```json
{
  "contracts": {
    "mediaUnderstandingProviders": ["example"]
  },
  "mediaUnderstandingProviderMetadata": {
    "example": {
      "capabilities": ["image", "audio"],
      "defaultModels": {
        "image": "example-vision-latest",
        "audio": "example-transcribe-latest"
      },
      "autoPriority": {
        "image": 40
      },
      "nativeDocumentInputs": ["pdf"],
      "documentModels": {
        "pdf": {
          "textExtraction": "example-doc-text-latest",
          "image": "example-doc-vision-latest"
        }
      }
    }
  }
}
```

Each provider entry can include:

| Field                  | Type                                                             | What it means                                                                                                   |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `capabilities`         | `("image" \| "audio" \| "video")[]`                              | Media capabilities exposed by this provider.                                                                    |
| `defaultModels`        | `Record<string, string>`                                         | Capability-to-model defaults used when config does not specify a model.                                         |
| `autoPriority`         | `Record<string, number>`                                         | Lower numbers sort earlier for automatic credential-based provider fallback.                                    |
| `nativeDocumentInputs` | `"pdf"[]`                                                        | Native document inputs supported by the provider.                                                               |
| `documentModels`       | `{ pdf?: { textExtraction?: string; image?: string \| false } }` | Per-document-type model overrides. Set `image: false` to disable image-based extraction for that document type. |

## providerEndpoints reference

Use `providerEndpoints` for endpoint classification that generic request policy must know before provider runtime loads. Core still owns the meaning of each `endpointClass`; plugin manifests own the host and base URL metadata.

Officially externalized provider plugins are excluded from the core dist, so
their manifests are invisible until installed. Their `providerEndpoints` must
also be mirrored in `scripts/lib/official-external-provider-catalog.json` so
endpoint classification keeps working without the plugin; a contract test
enforces the mirror.

Endpoint fields:

| Field                          | Type       | What it means                                                                                  |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| `endpointClass`                | `string`   | Known core endpoint class, such as `openrouter`, `moonshot-native`, or `google-vertex`.        |
| `hosts`                        | `string[]` | Exact hostnames that map to the endpoint class.                                                |
| `hostSuffixes`                 | `string[]` | Host suffixes that map to the endpoint class. Prefix with `.` for domain suffix-only matching. |
| `baseUrls`                     | `string[]` | Exact normalized HTTP(S) base URLs that map to the endpoint class.                             |
| `googleVertexRegion`           | `string`   | Static Google Vertex region for exact global hosts.                                            |
| `googleVertexRegionHostSuffix` | `string`   | Suffix to strip from matching hosts to expose the Google Vertex region prefix.                 |

## providerRequest reference

Use `providerRequest` for cheap request-compatibility metadata that generic request policy needs without loading provider runtime. Keep behavior-specific payload rewriting in provider runtime hooks or shared provider-family helpers.

```json
{
  "providerRequest": {
    "providers": {
      "vllm": {
        "family": "vllm",
        "openAICompletions": {
          "supportsStreamingUsage": true
        }
      }
    }
  }
}
```

Provider fields:

| Field                 | Type         | What it means                                                                          |
| --------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `family`              | `string`     | Provider family label used by generic request compatibility decisions and diagnostics. |
| `compatibilityFamily` | `"moonshot"` | Optional provider-family compatibility bucket for shared request helpers.              |
| `openAICompletions`   | `object`     | OpenAI-compatible completions request flags, currently `supportsStreamingUsage`.       |
