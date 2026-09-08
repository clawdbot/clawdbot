---
summary: "Embedding, image and video generation, web fetch, and web search provider capabilities"
read_when:
  - You are registering an embedding provider for memory or search
  - You are adding image, video, or music generation to a provider plugin
  - You are wiring a web fetch or web search provider
title: "Provider media and search"
sidebarTitle: "Media and search"
---

Embedding, generation, and web capabilities a provider plugin can register
alongside text inference. Register each one inside `register(api)` next to
your existing `api.registerProvider(...)` call. Part of the [Building provider
plugins](/plugins/sdk-provider-plugins) guide.

## Media and search capabilities

<Tabs>
  <Tab title="Embeddings">
    ```typescript
    api.registerEmbeddingProvider({
      id: "acme-ai",
      defaultModel: "acme-embed",
      transport: "remote",
      authProviderId: "acme-ai",
      create: async ({ model }) => ({
        provider: {
          id: "acme-ai",
          model,
          dimensions: 1536,
          embed: async (input) => {
            const text = typeof input === "string" ? input : input.text;
            return fetchAcmeEmbedding(text);
          },
          embedBatch: async (inputs) =>
            Promise.all(
              inputs.map((input) =>
                fetchAcmeEmbedding(typeof input === "string" ? input : input.text),
              ),
            ),
        },
      }),
    });
    ```

    Declare the same id in `contracts.embeddingProviders`. This is the
    general embedding contract for reusable vector generation, including
    memory search. The retired memory-specific registrar and manifest
    contract are no longer accepted.

    OpenAI-compatible endpoints can use `createRemoteEmbeddingProvider`
    from `openclaw/plugin-sdk/memory-core-host-engine-embeddings`. Its optional
    `buildRequestFields(kind)` callback returns extra JSON fields for
    `"query"` or `"document"` requests, such as `dimensions` or `input_type`.
    The shared factory always supplies the client's `model` and the original
    `input` array after those fields, preserving response-count validation.

    Providers that accept model aliases can expose
    `normalizeModel(options): string`. Memory uses this synchronous hook for
    both creation options and cold index identity checks. Keep it configuration-only:
    do not authenticate or access the network. Make normalization idempotent and
    reuse it in `create`, which may receive an already-normalized model or be
    called outside memory. Return an empty string only when the
    model remains unknown until discovery; do not turn an invalid explicit
    model into an omitted selection. For an exact pre-initialization identity,
    `resolveIndexIdentity(options)` additionally supplies the required
    `cacheKeyData` and any equivalent persisted aliases.

  </Tab>
  <Tab title="Image and video generation">
    Image and video capabilities use a **mode-aware** shape. Image
    providers declare required `generate` and `edit` capability blocks;
    video providers declare `generate`, `imageToVideo`, and
    `videoToVideo`. Flat aggregate fields like `maxInputImages` /
    `maxInputVideos` / `maxDurationSeconds` are not enough to advertise
    transform-mode support or disabled modes cleanly. Music generation
    follows the same `generate` / `edit` pattern.

    ```typescript
    api.registerImageGenerationProvider({
      id: "acme-ai",
      label: "Acme Images",
      capabilities: {
        generate: { maxCount: 4, supportsSize: true },
        edit: { enabled: false },
      },
      generateImage: async (req) => ({
        images: [
          {
            buffer: await generateAcmeImageBytes(req),
            mimeType: "image/png",
            fileName: "acme-image.png",
          },
        ],
      }),
    });

    api.registerVideoGenerationProvider({
      id: "acme-ai",
      label: "Acme Video",
      defaultTimeoutMs: 600_000,
      models: ["acme-video", "acme-image-video"],
      capabilities: {
        generate: { maxVideos: 1, maxDurationSeconds: 10, supportsResolution: true },
        imageToVideo: {
          enabled: true,
          maxVideos: 1,
          maxInputImages: 1,
          maxInputImagesByModel: { "acme/reference-to-video": 9 },
          maxDurationSeconds: 5,
        },
        videoToVideo: { enabled: false },
      },
      catalogByModel: {
        "acme-image-video": {
          modes: ["imageToVideo"],
          capabilities: {
            imageToVideo: {
              enabled: true,
              maxVideos: 1,
              maxInputImages: 1,
              resolutions: ["480P", "720P", "1080P"],
              supportsResolution: true,
            },
            videoToVideo: { enabled: false },
          },
        },
      },
      generateVideo: async (req) => ({
        videos: [
          {
            url: await generateAcmeVideoUrl(req),
            mimeType: "video/mp4",
          },
        ],
      }),
    });
    ```

    The illustrative helpers stand in for provider calls: the image helper
    returns non-empty encoded bytes, while the video helper returns a hosted
    media URL. Video providers may return non-empty encoded bytes instead,
    or both when the URL is a delivery fallback. Empty result arrays and
    empty buffers are candidate failures, except that a video asset with a
    usable URL ignores an empty buffer and continues with the URL.

    `capabilities` is required on both provider types; `edit` and the
    video transform blocks (`imageToVideo`, `videoToVideo`) always need an
    explicit `enabled` flag.

    Use `catalogByModel` when a listed model's static modes or capabilities
    differ from the provider defaults. This metadata keeps
    `video_generate action=list` and model catalogs accurate without
    invoking provider code. Request-time capability lookup and enforcement
    still belong in `resolveModelCapabilities` and `generateVideo`; reuse
    the same capability constant for both paths when possible.

  </Tab>
  <Tab title="Web fetch and search">
    ```typescript
    api.registerWebFetchProvider({
      id: "acme-ai-fetch",
      label: "Acme Fetch",
      hint: "Fetch pages through Acme's rendering backend.",
      envVars: ["ACME_FETCH_API_KEY"],
      placeholder: "acme-...",
      signupUrl: "https://acme.example.com/fetch",
      credentialPath: "plugins.entries.acme.config.webFetch.apiKey",
      getCredentialValue: (fetchConfig) => fetchConfig?.acme?.apiKey,
      setCredentialValue: (fetchConfigTarget, value) => {
        const acme = (fetchConfigTarget.acme ??= {});
        acme.apiKey = value;
      },
      createTool: () => ({
        description: "Fetch a page through Acme Fetch.",
        parameters: {},
        execute: async (args) => ({ content: [] }),
      }),
    });

    api.registerWebSearchProvider({
      id: "acme-ai-search",
      label: "Acme Search",
      hint: "Search the web through Acme's search backend.",
      envVars: ["ACME_SEARCH_API_KEY"],
      placeholder: "acme-...",
      signupUrl: "https://acme.example.com/search",
      credentialPath: "plugins.entries.acme.config.webSearch.apiKey",
      getCredentialValue: (searchConfig) => searchConfig?.acme?.apiKey,
      setCredentialValue: (searchConfigTarget, value) => {
        const acme = (searchConfigTarget.acme ??= {});
        acme.apiKey = value;
      },
      createTool: () => ({
        description: "Search the web through Acme Search.",
        parameters: {},
        execute: async (args) => ({ content: [] }),
      }),
    });
    ```

    Both provider types share the same credential-wiring shape:
    `hint`, `envVars`, `placeholder`, `signupUrl`, `credentialPath`,
    `getCredentialValue`, `setCredentialValue`, and `createTool` are all
    required.

    Search providers using `openclaw/plugin-sdk/provider-web-search` should
    resolve `resolveSearchCacheTtlMs(searchConfig)` once per execution and
    pass that value to both `readCachedSearchPayload(cacheKey, ttlMs)` and
    `writeCachedSearchPayload(cacheKey, payload, ttlMs)`. A zero TTL bypasses
    reads and writes; a positive TTL bounds entry age without extending its
    original expiry. Reads return a payload marked `cached: true`, or
    `undefined` on a miss. The reader's `ttlMs` argument is optional:
    existing one-argument calls continue to use the stored expiry alone.

    Both tool definitions accept `execute(args, context?)`, where the optional
    context carries `signal?: AbortSignal`. Forward that signal to network
    requests and check cancellation after asynchronous work. Existing
    one-argument implementations remain valid; OpenClaw rejects late fetch
    results after cancellation before publishing them to its fetch cache.

  </Tab>
</Tabs>
