// Defines user-facing config field help text for docs and UI surfaces.
export const MODEL_FIELD_HELP: Record<string, string> = {
  models:
    "Model catalog root for provider definitions, merge/replace behavior, and optional Bedrock discovery integration. Keep provider definitions explicit and validated before relying on production failover paths.",
  "models.mode":
    'Controls provider catalog behavior: "merge" keeps built-ins and overlays your custom providers, while "replace" uses only your configured providers. In "merge", matching provider IDs preserve non-empty agent models.json baseUrl values, while apiKey values are preserved only when the provider is not SecretRef-managed in current config/auth-profile context; SecretRef-managed providers refresh apiKey from current source markers, and matching model contextWindow/maxTokens use the higher value between explicit and implicit entries.',
  "models.providers":
    "Provider map keyed by provider ID containing connection/auth settings and concrete model definitions. Built-in providers may be tuned with provider-level overlays; custom providers must include baseUrl and models. Use stable provider keys so references from agents and tooling remain portable across environments.",
  "models.pricing":
    "Controls the optional background model-pricing bootstrap that fetches remote per-token cost catalogs.",
  "models.pricing.enabled":
    "Enable the background model-pricing bootstrap. Set to false to skip OpenRouter and LiteLLM catalog fetches during Gateway startup; changing this value requires a Gateway restart.",
  "models.providers.*.baseUrl":
    "Base URL for the provider endpoint used to serve model requests for that provider entry. Use HTTPS endpoints and keep URLs environment-specific through config templating where needed.",
  "models.providers.*.apiKey":
    "Provider credential used for API-key based authentication when the provider requires direct key auth. Use secret/env substitution and avoid storing real keys in committed config files.",
  "models.providers.*.auth":
    'Selects provider auth style: "api-key" for API key auth, "token" for bearer token auth, "oauth" for OAuth credentials, and "aws-sdk" for AWS credential resolution. Match this to your provider requirements.',
  "models.providers.*.api":
    "Provider API adapter selection controlling request/response compatibility handling for model calls. Use the adapter that matches your upstream provider protocol to avoid feature mismatch.",
  "models.providers.*.contextWindow":
    "Default native context window applied to models under this provider when a model entry does not set contextWindow. Use model-level contextWindow for per-model overrides.",
  "models.providers.*.contextTokens":
    "Default effective runtime context cap applied to models under this provider when a model entry does not set contextTokens. Use this when runtime should budget below the native contextWindow.",
  "models.providers.*.maxTokens":
    "Default maximum output token budget applied to models under this provider when a model entry does not set maxTokens.",
  "models.providers.*.timeoutSeconds":
    "Optional per-provider model request timeout in seconds. Provider-level request settings affect explicit provider-owned model rows; they do not create implicit models. For custom providers, set it alongside the provider baseUrl and models. Applies to provider HTTP fetches, including connect, headers, body, and total request abort handling, and also raises the LLM idle/stream watchdog ceiling for this provider above the implicit ~120s default. Use this for slow local or self-hosted model servers, or for cloud providers that buffer reasoning tokens silently on the wire (Gemini preview, large-tool-payload Claude/Opus), instead of changing global agent timeouts.",
  "models.providers.*.region":
    "Optional provider deployment/API region interpreted by providers that expose regional endpoints. Use provider docs for supported values; baseUrl overrides usually take precedence when both are set.",
  "models.providers.*.injectNumCtxForOpenAICompat":
    "Controls whether OpenClaw injects `options.num_ctx` for Ollama providers configured with the OpenAI-compatible adapter (`openai-completions`). Default is true. Set false only if your proxy/upstream rejects unknown `options` payload fields.",
  "models.providers.*.params":
    "Provider-specific runtime parameters interpreted by provider plugins. Keep keys documented by the provider, and prefer explicit provider docs over ad hoc shared assumptions.",
  "models.providers.*.headers":
    "Static HTTP headers merged into provider requests for tenant routing, proxy auth, or custom gateway requirements. Use this sparingly and keep sensitive header values in secrets.",
  "models.providers.*.authHeader":
    "When true, credentials are sent via the HTTP Authorization header even if alternate auth is possible. Use this only when your provider or proxy explicitly requires Authorization forwarding.",
  "models.providers.*.agentRuntime":
    "Optional low-level agent runtime policy for this provider. Use provider/model runtime policy instead of agent-wide runtime pins; omitted/default lets OpenClaw choose the runtime for the selected provider.",
  "models.providers.*.agentRuntime.id":
    'Provider agent runtime id: "openclaw", "auto", a registered plugin harness id such as "codex", or a supported CLI backend alias such as "claude-cli". OpenAI on the official endpoint defaults to the Codex harness when omitted.',
  "models.providers.*.localService":
    "Optional on-demand local model server process for this provider. OpenClaw probes healthUrl, starts the command when needed, waits for readiness, and then sends the model request.",
  "models.providers.*.localService.command":
    "Absolute executable path for the local model server process. Keep this path explicit so provider startup is deterministic and does not depend on shell PATH lookup.",
  "models.providers.*.localService.args":
    "Argument list passed to the local model server command without shell expansion.",
  "models.providers.*.localService.cwd": "Working directory for the local model server process.",
  "models.providers.*.localService.env":
    "Additional environment variables for the local model server process. Values that look secret are redacted from config snapshots.",
  "models.providers.*.localService.healthUrl":
    "Readiness URL probed before model requests. If omitted, OpenClaw uses the provider baseUrl with /models appended.",
  "models.providers.*.localService.readyTimeoutMs":
    "Maximum milliseconds to wait for the local model server readiness probe after starting the process.",
  "models.providers.*.localService.idleStopMs":
    "Milliseconds to keep an OpenClaw-started local model server alive after the last request finishes. Set 0 to keep it alive until OpenClaw exits.",
  "models.providers.*.request":
    "Optional request overrides for model-provider requests, including extra headers, auth overrides, proxy routing, TLS client settings, and optional allowPrivateNetwork for trusted self-hosted endpoints. Use these only when your upstream or enterprise network path requires transport customization.",
  "models.providers.*.request.headers":
    "Extra headers merged into provider requests after default attribution and auth resolution.",
  "models.providers.*.request.auth":
    "Override provider request authentication behavior for this provider.",
  "models.providers.*.request.auth.mode":
    'Auth override mode: "provider-default", "authorization-bearer", or "header".',
  "models.providers.*.request.auth.token":
    "Bearer token used when auth mode is authorization-bearer.",
  "models.providers.*.request.auth.headerName":
    "Custom auth header name used when auth mode is header.",
  "models.providers.*.request.auth.value":
    "Custom auth header value used when auth mode is header.",
  "models.providers.*.request.auth.prefix":
    "Optional prefix prepended to request.auth.value when auth mode is header.",
  "models.providers.*.request.proxy":
    'Optional proxy override for model-provider requests. Use "env-proxy" to honor environment proxy settings or "explicit-proxy" to route through a specific proxy URL.',
  "models.providers.*.request.proxy.mode":
    'Proxy override mode for model-provider requests: "env-proxy" or "explicit-proxy".',
  "models.providers.*.request.proxy.url":
    "Explicit proxy URL used when request.proxy.mode is explicit-proxy. Credentials embedded in the URL are treated as sensitive and redacted from snapshots.",
  "models.providers.*.request.proxy.tls":
    "Optional TLS settings used when connecting to the configured proxy.",
  "models.providers.*.request.proxy.tls.ca":
    "Custom CA bundle used to verify the proxy TLS certificate chain.",
  "models.providers.*.request.proxy.tls.cert":
    "Client TLS certificate presented to the proxy when mutual TLS is required.",
  "models.providers.*.request.proxy.tls.key":
    "Private key paired with request.proxy.tls.cert for proxy mutual TLS.",
  "models.providers.*.request.proxy.tls.passphrase":
    "Optional passphrase used to decrypt request.proxy.tls.key.",
  "models.providers.*.request.proxy.tls.serverName":
    "Optional SNI/server-name override used when establishing TLS to the proxy.",
  "models.providers.*.request.proxy.tls.insecureSkipVerify":
    "Skips proxy TLS certificate verification. Use only for controlled development environments.",
  proxy:
    "Operator-managed forward proxy routing for OpenClaw runtime HTTP, HTTPS, WebSocket, and supported raw-egress paths. Use this when central egress control is part of the deployment boundary.",
  "proxy.enabled":
    "Enables operator-managed proxy routing. When enabled, OpenClaw fails startup if no managed proxy URL is configured.",
  "proxy.proxyUrl":
    "Managed forward proxy URL. Use http:// for a plain CONNECT proxy or https:// when the connection to the proxy endpoint itself must use TLS.",
  "proxy.tls":
    "TLS settings used when connecting to the managed proxy endpoint. These settings apply to proxy TLS, not destination TLS after CONNECT.",
  "proxy.tls.caFile":
    "Filesystem path to a custom CA bundle used to verify an HTTPS managed proxy endpoint certificate.",
  "proxy.loopbackMode":
    'Controls Gateway loopback control-plane routing while managed proxy mode is active: "gateway-only", "proxy", or "block".',
  "models.providers.*.request.tls":
    "Optional TLS settings used when connecting directly to the upstream model endpoint.",
  "models.providers.*.request.tls.ca":
    "Custom CA bundle used to verify the upstream TLS certificate chain.",
  "models.providers.*.request.tls.cert":
    "Client TLS certificate presented to the upstream endpoint when mutual TLS is required.",
  "models.providers.*.request.tls.key":
    "Private key paired with request.tls.cert for upstream mutual TLS.",
  "models.providers.*.request.tls.passphrase":
    "Optional passphrase used to decrypt request.tls.key.",
  "models.providers.*.request.tls.serverName":
    "Optional SNI/server-name override used when establishing upstream TLS.",
  "models.providers.*.request.tls.insecureSkipVerify":
    "Skips upstream TLS certificate verification. Use only for controlled development environments.",
  "models.providers.*.request.allowPrivateNetwork":
    "When true, allow model-provider HTTP requests to private, CGNAT, or similar ranges through the provider HTTP fetch guard (fetchWithSsrFGuard). Custom/local provider base URLs already trust the exact configured origin, except metadata/link-local origins; set this to false to opt out of that trust. OpenAI Responses WebSocket reuses request for headers/TLS but does not use that fetch SSRF path. Use true only for operator-controlled self-hosted endpoints that must reach private origins outside the configured baseUrl origin.",
  "models.providers.*.models":
    "Declared model list for a provider including identifiers, metadata, provider-specific params, and optional compatibility/cost hints. Keep IDs exact to provider catalog values so selection and fallback resolve correctly.",
  "models.providers.*.models[].agentRuntime":
    "Optional low-level agent runtime policy for this specific model. Model runtime policy overrides the provider runtime policy.",
  "models.providers.*.models[].agentRuntime.id":
    'Model agent runtime id: "openclaw", "auto", a registered plugin harness id such as "codex", or a supported CLI backend alias such as "claude-cli".',
  "models.providers.*.models[].mediaInput":
    "Optional model media capability metadata used by tools to choose conservative image compression defaults.",
  "models.providers.*.models[].mediaInput.image":
    "Optional image input limits for this model, such as maximum side length, maximum pixels, and preferred compression side.",
  "models.providers.*.models[].mediaInput.image.maxBytes":
    "Maximum encoded image payload size accepted by the provider for this model.",
  "models.providers.*.models[].mediaInput.image.maxPixels":
    "Maximum image pixel count accepted by the provider for this model.",
  "models.providers.*.models[].mediaInput.image.maxSidePx":
    "Maximum image width or height accepted by the provider for this model.",
  "models.providers.*.models[].mediaInput.image.preferredSidePx":
    "Preferred image resize side for balanced compression. Leave unset to use OpenClaw's conservative default.",
  "models.providers.*.models[].mediaInput.image.tokenMode":
    'Provider image token accounting style: "tile", "detail", or "provider".',
  auth: "Authentication profile root used for multi-profile provider credentials and cooldown-based failover ordering. Keep profiles minimal and explicit so automatic failover behavior stays auditable.",
  "channels.googlechat.botLoopProtection":
    "Sliding-window guard for accepted Google Chat bot-to-bot loops. Defaults to the shared bot loop protection budget when allowBots lets bot-authored messages reach dispatch.",
  "channels.mattermost.botToken":
    "Bot token from Mattermost System Console -> Integrations -> Bot Accounts.",
  "channels.mattermost.baseUrl":
    "Base URL for your Mattermost server (e.g., https://chat.example.com).",
  "channels.mattermost.chatmode":
    'Reply to channel messages on mention ("oncall"), on trigger chars (">" or "!") ("onchar"), or on every message ("onmessage").',
  "channels.mattermost.oncharPrefixes": 'Trigger prefixes for onchar mode (default: [">", "!"]).',
  "channels.mattermost.requireMention":
    "Require @mention in channels before responding (default: true).",
  "auth.profiles": "Named auth profiles (provider + mode + optional email).",
  "auth.order": "Ordered auth profile IDs per provider (used for automatic failover).",
  "agents.defaults.workspace":
    "Default workspace path exposed to agent runtime tools for filesystem context and repo-aware behavior. Set this explicitly when running from wrappers so path resolution stays deterministic.",
  "agents.defaults.skipOptionalBootstrapFiles":
    "Optional bootstrap files that should not be created in agent workspaces. Valid values: SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md.",
  "agents.defaults.contextInjection":
    'Controls when workspace bootstrap files are injected into the system prompt: "always" (default) or "continuation-skip" for safe continuation turns after a completed assistant response.',
  "agents.defaults.bootstrapMaxChars":
    "Max characters of each workspace bootstrap file injected into the system prompt before truncation (default: 20000).",
  "agents.defaults.bootstrapTotalMaxChars":
    "Max total characters across all injected workspace bootstrap files (default: 60000).",
  "agents.defaults.experimental":
    "Experimental agent-default flags. Keep these off unless you are intentionally testing a preview surface.",
  "agents.defaults.experimental.localModelLean":
    "Experimental local-model prompt trim. When enabled, OpenClaw drops heavyweight default tools like browser, cron, and message for weaker or smaller local-model backends.",
  "agents.defaults.bootstrapPromptTruncationWarning":
    'Inject agent-visible warning text when bootstrap files are truncated: "off", "once", or "always" (default).',
  "agents.defaults.startupContext":
    'Runtime-owned first-turn prelude for bare "/new" and "/reset". Use this to control whether recent daily memory files are preloaded into the first prompt instead of asking the model to decide what to read.',
  "agents.defaults.startupContext.enabled":
    "Enable the startup-context prelude for bare session resets (default: true). Disable this to fall back to prompt-only behavior with no runtime-loaded daily memory.",
  "agents.defaults.startupContext.applyOn":
    'Chooses which bare reset commands get startup context: include "new", "reset", or both (default: ["new","reset"]).',
  "agents.defaults.startupContext.dailyMemoryDays":
    "Number of dated memory files to load counting backward from today in the configured user timezone (default: 2 for today + yesterday).",
  "agents.defaults.startupContext.maxFileBytes":
    "Maximum bytes allowed per daily memory file when building startup context (default: 16384). Files over this boundary-safe read limit are skipped.",
  "agents.defaults.startupContext.maxFileChars":
    "Maximum characters retained from each loaded daily memory file in the startup prelude (default: 1200).",
  "agents.defaults.startupContext.maxTotalChars":
    "Maximum total characters retained across all loaded daily memory files in the startup prelude (default: 2800). Additional files are truncated from the prelude once this cap is reached.",
  "agents.defaults.repoRoot":
    "Optional repository root shown in the system prompt runtime line (overrides auto-detect).",
  "agents.defaults.promptOverlays":
    "Provider-independent prompt overlays applied by model family before provider-specific prompt hooks.",
  "agents.defaults.promptOverlays.gpt5":
    "Shared GPT-5-family prompt overlay applied to matching model ids across providers such as OpenAI, OpenRouter, OpenCode, Codex, and compatible gateways.",
  "agents.defaults.promptOverlays.gpt5.personality":
    'Friendly interaction-style layer for GPT-5-family models ("friendly" or "on" enables it; "off" disables only that layer). The tagged behavior contract remains enabled for matching GPT-5 models.',
  "agents.defaults.envelopeTimezone":
    'Timezone for message envelopes ("utc", "local", "user", or an IANA timezone string).',
  "agents.defaults.envelopeTimestamp":
    'Include absolute timestamps in message envelopes, direct agent prompt prefixes, and embedded model-input prefixes ("on" or "off").',
  "agents.defaults.envelopeElapsed": 'Include elapsed time in message envelopes ("on" or "off").',
  "agents.defaults.models":
    "Configured model catalog and per-model settings. Entries provide aliases, params, and runtime metadata; they do not restrict model overrides.",
  "agents.defaults.modelPolicy":
    "Explicit policy for model overrides. Omit it or leave allow empty to permit any model.",
  "agents.defaults.modelPolicy.allow":
    'Allowed model override refs. Accepts aliases, full "provider/model" refs, and provider wildcards such as "openai/*". Empty permits any model.',
  "agents.defaults.models.*.agentRuntime":
    "Optional per-model runtime policy for the default agent. Use this for model-specific runtime exceptions instead of setting a whole-agent runtime.",
  "agents.defaults.models.*.agentRuntime.id":
    'Default-agent model runtime id: "openclaw", "auto", a registered plugin harness id such as "codex", or a supported CLI backend alias such as "claude-cli".',
  "agents.defaults.memorySearch":
    "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).",
  "agents.defaults.memorySearch.enabled":
    "Master toggle for memory search indexing and retrieval behavior on this agent profile. Keep enabled for semantic recall, and disable when you want fully stateless responses.",
  "agents.defaults.memorySearch.rememberAcrossConversations":
    'Use relevant context from this agent\'s other private conversations through protected transcript recall. Defaults on only when global session.dmScope is unset or "main" and no binding overrides DM scope; any configured DM isolation defaults it off. An explicit true or false always wins.',
  "agents.defaults.memorySearch.sources":
    'Chooses which sources are indexed: "memory" reads MEMORY.md + memory files, and "sessions" includes transcript history. Keep ["memory"] unless you need recall from prior chat transcripts.',
  "agents.defaults.memorySearch.extraPaths":
    "Adds extra directories or .md files to the memory index beyond default memory files. Use this when key reference docs live elsewhere in your repo; when multimodal memory is enabled, matching image/audio files under these paths are also eligible for indexing.",
  "agents.defaults.memorySearch.qmd":
    "Use this when one agent should query another agent's transcript collections; QMD-specific extra collections let you opt into cross-agent memory search without flattening everything into one shared namespace.",
  "agents.defaults.memorySearch.qmd.extraCollections":
    "Use this when you need directional transcript search across agents; add collections here to scope QMD recalls without creating a shared global transcript namespace.",
  "agents.defaults.memorySearch.qmd.extraCollections.path":
    "Use an absolute or workspace-relative filesystem path for the extra QMD collection; keep it pointed at the transcript directory or note folder you actually want this agent to search.",
  "agents.defaults.memorySearch.qmd.extraCollections.name":
    "Preserves the configured collection label only when the path points outside the agent workspace; paths inside the workspace stay agent-scoped even if a name is provided. Use this for shared cross-agent transcript roots that live outside the workspace.",
  "agents.defaults.memorySearch.qmd.extraCollections.pattern":
    "Use a glob pattern to restrict which files inside the collection are indexed; keep the default `**/*.md` unless you need a narrower subset.",
  "agents.defaults.memorySearch.multimodal":
    'Optional multimodal memory settings for indexing image and audio files from configured extra paths. Keep this off unless your embedding model explicitly supports cross-modal embeddings, and set `memorySearch.fallback` to "none" while it is enabled. Matching files are uploaded to the configured remote embedding provider during indexing.',
  "agents.defaults.memorySearch.multimodal.enabled":
    "Enables image/audio memory indexing from extraPaths. This currently requires Gemini embedding-2, keeps the default memory roots Markdown-only, disables memory-search fallback providers, and uploads matching binary content to the configured remote embedding provider.",
  "agents.defaults.memorySearch.multimodal.modalities":
    'Selects which multimodal file types are indexed from extraPaths: "image", "audio", or "all". Keep this narrow to avoid indexing large binary corpora unintentionally.',
  "agents.defaults.memorySearch.multimodal.maxFileBytes":
    "Sets the maximum bytes allowed per multimodal file before it is skipped during memory indexing. Use this to cap upload cost and indexing latency, or raise it for short high-quality audio clips.",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Indexes session transcripts into memory search so responses can reference prior chat turns. Keep this off unless transcript recall is needed, because indexing cost and storage usage both increase.",
  "agents.defaults.memorySearch.provider":
    'Selects the embedding backend used to build/query memory vectors. Defaults to "openai"; set "openai-compatible", "gemini", "voyage", "mistral", "bedrock", "deepinfra", "github-copilot", "lmstudio", "ollama", or "local" when you want a different backend.',
  "agents.defaults.memorySearch.model":
    "Embedding model override used by the selected memory provider when a non-default model is required. Set this only when you need explicit recall quality/cost tuning beyond provider defaults.",
  "agents.defaults.memorySearch.inputType":
    "Use this optional provider-specific `input_type` value only when the same label should apply to both query and document embedding requests. For asymmetric providers, prefer queryInputType and documentInputType.",
  "agents.defaults.memorySearch.queryInputType":
    "Optional provider-specific `input_type` value for query-time memory embeddings. Use this with OpenAI-compatible asymmetric embedding endpoints that require a query label.",
  "agents.defaults.memorySearch.documentInputType":
    "Optional provider-specific `input_type` value for document and indexing memory embeddings. Use this with OpenAI-compatible asymmetric embedding endpoints that require a passage or document label.",
  "agents.defaults.memorySearch.outputDimensionality":
    "Provider-specific output vector size override for memory embeddings. Gemini embedding-2 supports 768, 1536, or 3072; Bedrock families such as Titan V2, Cohere V4, and Nova expose their own allowed sizes. Expect a full reindex when you change it because stored vector dimensions must stay consistent.",
  "agents.defaults.memorySearch.remote.baseUrl":
    "Overrides the embedding API endpoint, such as an OpenAI-compatible proxy or custom Gemini base URL. Use this only when routing through your own gateway or vendor endpoint; keep provider defaults otherwise.",
  "agents.defaults.memorySearch.remote.apiKey":
    "Supplies a dedicated API key for remote embedding calls used by memory indexing and query-time embeddings. Use this when memory embeddings should use different credentials than global defaults or environment variables.",
  "agents.defaults.memorySearch.remote.headers":
    "Adds custom HTTP headers to remote embedding requests, merged with provider defaults. Use this for proxy auth and tenant routing headers, and keep values minimal to avoid leaking sensitive metadata.",
  "agents.defaults.memorySearch.remote.nonBatchConcurrency":
    "Controls concurrent inline embedding requests during non-batch memory indexing. Use a low value for local or small self-hosted providers such as Ollama; batch embedding concurrency is configured separately under remote.batch.",
  "agents.defaults.memorySearch.remote.batch.enabled":
    "Enables provider batch APIs for embedding jobs when supported (OpenAI/Gemini), improving throughput on larger index runs. Keep this enabled unless debugging provider batch failures or running very small workloads.",
  "agents.defaults.memorySearch.remote.batch.wait":
    "Waits for batch embedding jobs to fully finish before the indexing operation completes. Keep this enabled for deterministic indexing state; disable only if you accept delayed consistency.",
  "agents.defaults.memorySearch.remote.batch.concurrency":
    "Limits how many embedding batch jobs run at the same time during indexing (default: 2). Increase carefully for faster bulk indexing, but watch provider rate limits and queue errors.",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs":
    "Controls how often the system polls provider APIs for batch job status in milliseconds (default: 2000). Use longer intervals to reduce API chatter, or shorter intervals for faster completion detection.",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes":
    "Sets the maximum wait time for a full embedding batch operation in minutes (default: 60). Increase for very large corpora or slower providers, and lower it to fail fast in automation-heavy flows.",
  "agents.defaults.memorySearch.local.modelPath":
    "Specifies the local embedding model source for local memory search, such as a GGUF file path or `hf:` URI. Use this only when provider is `local`, and verify model compatibility before large index rebuilds.",
  "agents.defaults.memorySearch.local.contextSize":
    'Context window size passed to node-llama-cpp when creating the embedding context (default: 4096). 4096 safely covers typical memory-search chunks (128\u2013512 tokens) while keeping non-weight VRAM bounded. Lower to 1024\u20132048 on resource-constrained hosts. Set to "auto" to let node-llama-cpp use the model\'s trained maximum \u2014 not recommended for large models (e.g. Qwen3-Embedding-8B trained on 40\u202f960 tokens can push VRAM from ~8.8\u202fGB to ~32\u202fGB).',
  "agents.defaults.memorySearch.fallback":
    'Backup provider used when primary embeddings fail: "openai", "gemini", "voyage", "mistral", "bedrock", "lmstudio", "ollama", "local", or "none". Set a real fallback for production reliability; use "none" only if you prefer explicit failures.',
  "agents.defaults.memorySearch.store.vector.enabled":
    "Enables the sqlite-vec extension used for vector similarity queries in memory search (default: true). Keep this enabled for normal semantic recall; disable only for debugging or fallback-only operation.",
  "agents.defaults.memorySearch.store.vector.extensionPath":
    "Overrides the auto-discovered sqlite-vec extension library path (`.dylib`, `.so`, or `.dll`). Use this when your runtime cannot find sqlite-vec automatically or you pin a known-good build.",
  "agents.defaults.memorySearch.query.maxResults":
    "Maximum number of memory hits returned from search before downstream reranking and prompt injection. Raise for broader recall, or lower for tighter prompts and faster responses.",
  "agents.defaults.memorySearch.query.minScore":
    "Minimum relevance score threshold for including memory results in final recall output. Increase to reduce weak/noisy matches, or lower when you need more permissive retrieval.",
  "agents.defaults.memorySearch.query.hybrid.enabled":
    "Combines BM25 keyword matching with vector similarity for better recall on mixed exact + semantic queries. Keep enabled unless you are isolating ranking behavior for troubleshooting.",
  "agents.defaults.memorySearch.query.hybrid.mmr.enabled":
    "Adds MMR reranking to diversify results and reduce near-duplicate snippets in a single answer window. Enable when recall looks repetitive; keep off for strict score ordering.",
  "agents.defaults.memorySearch.query.hybrid.temporalDecay.enabled":
    "Applies recency decay so newer memory can outrank older memory when scores are close. Enable when timeliness matters; keep off for timeless reference knowledge.",
  "agents.defaults.memorySearch.cache.enabled":
    "Caches computed chunk embeddings in SQLite so reindexing and incremental updates run faster (default: true). Keep this enabled unless investigating cache correctness or minimizing disk usage.",
  memory: "Memory backend configuration (global).",
  "memory.backend":
    'Selects the global memory engine: "builtin" uses OpenClaw memory internals, while "qmd" uses the QMD sidecar pipeline. Keep "builtin" unless you intentionally operate QMD.',
  "memory.citations":
    'Controls citation visibility in replies: "auto" shows citations when useful, "on" always shows them, and "off" hides them. Keep "auto" for a balanced signal-to-noise default.',
  "memory.qmd.command":
    "Sets the executable path for the `qmd` binary used by the QMD backend (default: resolved from PATH). Use an explicit absolute path when multiple qmd installs exist or PATH differs across environments.",
  "memory.qmd.mcporter":
    "Routes QMD work through mcporter (MCP runtime) instead of spawning `qmd` for each call. Use this when cold starts are expensive on large models; keep direct process mode for simpler local setups.",
  "memory.qmd.mcporter.enabled":
    "Routes QMD through an mcporter daemon instead of spawning qmd per request, reducing cold-start overhead for larger models. Keep disabled unless mcporter is installed and configured.",
  "memory.qmd.mcporter.serverName":
    "Names the mcporter server target used for QMD calls (default: qmd). Change only when your mcporter setup uses a custom server name for qmd mcp keep-alive.",
  "memory.qmd.mcporter.startDaemon":
    "Automatically starts the mcporter daemon when mcporter-backed QMD mode is enabled (default: true). Keep enabled unless process lifecycle is managed externally by your service supervisor.",
  "memory.qmd.searchMode":
    'Selects the QMD retrieval path: "query" uses standard query flow, "search" uses search-oriented retrieval, and "vsearch" emphasizes vector retrieval. Keep default unless tuning relevance quality.',
  "memory.qmd.rerank":
    'Controls QMD query reranking. Set to false with searchMode "query" and QMD 2.1+ to skip QMD reranking for faster hybrid results; leave unset for QMD defaults.',
  "memory.qmd.searchTool":
    "Overrides the exact mcporter tool name used for QMD searches while preserving `searchMode` as the semantic retrieval mode. Use this only when your QMD MCP server exposes a custom tool such as `hybrid_search` and keep it unset for the normal built-in tool mapping.",
  "memory.qmd.includeDefaultMemory":
    "Automatically indexes default memory files (MEMORY.md and memory/**/*.md) into QMD collections. Keep enabled unless you want indexing controlled only through explicit custom paths.",
  "memory.qmd.paths":
    "Adds custom directories or files to include in QMD indexing, each with an optional name and glob pattern. Use this for project-specific knowledge locations that are outside default memory paths.",
  "memory.qmd.paths.path":
    "Defines the root location QMD should scan, using an absolute path or `~`-relative path. Use stable directories so collection identity does not drift across environments.",
  "memory.qmd.paths.pattern":
    "Filters files under each indexed root using a glob pattern, with default `**/*.md`. Use narrower patterns to reduce noise and indexing cost when directories contain mixed file types.",
  "memory.qmd.paths.name":
    "Sets a stable collection name for an indexed path instead of deriving it from filesystem location. Use this when paths vary across machines but you want consistent collection identity.",
  "memory.qmd.sessions.enabled":
    "Indexes session transcripts into QMD so recall can include prior conversation content (experimental, default: false). Enable only when transcript memory is required and you accept larger index churn.",
  "memory.qmd.sessions.exportDir":
    "Overrides where sanitized session exports are written before QMD indexing. Use this when default state storage is constrained or when exports must land on a managed volume.",
  "memory.qmd.sessions.retentionDays":
    "Defines how long exported session files are kept before automatic pruning, in days (default: unlimited). Set a finite value for storage hygiene or compliance retention policies.",
  "memory.qmd.update.interval":
    "Sets how often QMD refreshes indexes from source content (duration string, default: 5m). Shorter intervals improve freshness but increase background CPU and I/O.",
  "memory.qmd.update.debounceMs":
    "Sets the minimum delay between consecutive QMD refresh attempts in milliseconds (default: 15000). Increase this if frequent file changes cause update thrash or unnecessary background load.",
  "memory.qmd.update.onBoot":
    "Runs an initial QMD update when the long-lived QMD manager opens (default: true). Set false to skip manager-start boot updates while keeping configured interval/embed maintenance.",
  "memory.qmd.update.startup":
    "Controls whether Gateway startup initializes QMD before memory is first used (`off`, `idle`, or `immediate`; default: off). With onBoot disabled, startup only arms configured interval/embed maintenance.",
  "memory.qmd.update.startupDelayMs":
    'Sets the idle delay before an opt-in `memory.qmd.update.startup: "idle"` refresh runs (default: 120000). Increase to keep cold-start CPU available for channels and providers.',
  "memory.qmd.update.waitForBootSync":
    "Blocks QMD manager opening until its initial manager-start update finishes (default: false). Startup refreshes remain opt-in through `memory.qmd.update.startup`.",
  "memory.qmd.update.embedInterval":
    "Sets how often QMD recomputes embeddings (duration string, default: 60m; set 0 to disable periodic embeds). Lower intervals improve freshness but increase embedding workload and cost.",
  "memory.qmd.update.commandTimeoutMs":
    "Sets timeout for QMD maintenance commands such as collection list/add in milliseconds (default: 30000). Increase when running on slower disks or remote filesystems that delay command completion.",
  "memory.qmd.update.updateTimeoutMs":
    "Sets maximum runtime for each `qmd update` cycle in milliseconds (default: 120000). Raise this for larger collections; lower it when you want quicker failure detection in automation.",
  "memory.qmd.update.embedTimeoutMs":
    "Sets maximum runtime for each `qmd embed` cycle in milliseconds (default: 120000). Increase for heavier embedding workloads or slower hardware, and lower to fail fast under tight SLAs.",
  "memory.qmd.limits.maxResults":
    "Limits how many QMD hits are returned into the agent loop for each recall request (default: 6). Increase for broader recall context, or lower to keep prompts tighter and faster.",
  "memory.qmd.limits.maxSnippetChars":
    "Caps per-result snippet length extracted from QMD hits in characters (default: 700). Lower this when prompts bloat quickly, and raise only if answers consistently miss key details.",
  "memory.qmd.limits.maxInjectedChars":
    "Caps how much QMD text can be injected into one turn across all hits. Use lower values to control prompt bloat and latency; raise only when context is consistently truncated.",
  "memory.qmd.limits.timeoutMs":
    "Sets per-query QMD search timeout in milliseconds (default: 4000). Increase for larger indexes or slower environments, and lower to keep request latency bounded.",
  "memory.qmd.scope":
    "Defines which sessions/channels are eligible for QMD recall using session.sendPolicy-style rules. Keep default direct-only scope unless you intentionally want cross-chat memory sharing.",
  "agents.defaults.memorySearch.sync.onSessionStart":
    "Triggers a memory index sync when a session starts so early turns see fresh memory content. Keep enabled when startup freshness matters more than initial turn latency.",
  "agents.defaults.memorySearch.sync.onSearch":
    "Uses lazy sync by scheduling reindex on search after content changes are detected. Keep enabled for lower idle overhead, or disable if you require pre-synced indexes before any query.",
  "agents.defaults.memorySearch.sync.watch":
    "Watches memory files and schedules index updates from file-change events (chokidar). Enable for near-real-time freshness; disable on very large workspaces if watch churn is too noisy.",
  "agents.defaults.memorySearch.sync.embeddingBatchTimeoutSeconds":
    "Overrides the timeout for inline embedding batches during memory indexing. Leave unset to use provider defaults: 600 seconds for local/self-hosted providers such as local, Ollama, and LM Studio, and 120 seconds for hosted providers.",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes":
    "Requires at least this many newly appended bytes before session transcript changes trigger reindex (default: 100000). Increase to reduce frequent small reindexes, or lower for faster transcript freshness.",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages":
    "Requires at least this many appended transcript messages before reindex is triggered (default: 50). Lower this for near-real-time transcript recall, or raise it to reduce indexing churn.",
  "agents.defaults.memorySearch.sync.sessions.postCompactionForce":
    "Forces a session memory-search reindex after compaction-triggered transcript updates (default: true). Keep enabled when compacted summaries must be immediately searchable, or disable to reduce write-time indexing pressure.",
};
