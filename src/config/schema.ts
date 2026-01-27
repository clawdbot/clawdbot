import { CHANNEL_IDS } from "../channels/registry.js";
import { VERSION } from "../version.js";
import { ClawdbotSchema } from "./zod-schema.js";

export type ConfigUiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

export type ConfigSchema = ReturnType<typeof ClawdbotSchema.toJSONSchema>;

type JsonSchemaNode = Record<string, unknown>;

export type ConfigSchemaResponse = {
  schema: ConfigSchema;
  uiHints: ConfigUiHints;
  version: string;
  generatedAt: string;
};

export type PluginUiMetadata = {
  id: string;
  name?: string;
  description?: string;
  configUiHints?: Record<
    string,
    Pick<ConfigUiHint, "label" | "help" | "advanced" | "sensitive" | "placeholder">
  >;
  configSchema?: JsonSchemaNode;
};

export type ChannelUiMetadata = {
  id: string;
  label?: string;
  description?: string;
  configSchema?: JsonSchemaNode;
  configUiHints?: Record<string, ConfigUiHint>;
};

const GROUP_LABELS: Record<string, string> = {
  wizard: "Wizard",
  update: "Update",
  diagnostics: "Diagnostics",
  logging: "Logging",
  gateway: "Gateway",
  nodeHost: "Node Host",
  agents: "Agents",
  tools: "Tools",
  bindings: "Bindings",
  audio: "Audio",
  models: "Models",
  messages: "Messages",
  commands: "Commands",
  session: "Session",
  cron: "Cron",
  hooks: "Hooks",
  ui: "UI",
  browser: "Browser",
  talk: "Talk",
  channels: "Messaging Channels",
  skills: "Skills",
  plugins: "Plugins",
  discovery: "Discovery",
  presence: "Presence",
  voicewake: "Voice Wake",
};

const GROUP_ORDER: Record<string, number> = {
  wizard: 20,
  update: 25,
  diagnostics: 27,
  gateway: 30,
  nodeHost: 35,
  agents: 40,
  tools: 50,
  bindings: 55,
  audio: 60,
  models: 70,
  messages: 80,
  commands: 85,
  session: 90,
  cron: 100,
  hooks: 110,
  ui: 120,
  browser: 130,
  talk: 140,
  channels: 150,
  skills: 200,
  plugins: 205,
  discovery: 210,
  presence: 220,
  voicewake: 230,
  logging: 900,
};

const FIELD_LABELS: Record<string, string> = {
  "meta.lastTouchedVersion": "Config Last Touched Version",
  "meta.lastTouchedAt": "Config Last Touched At",
  "update.channel": "Update Channel",
  "update.checkOnStart": "Update Check on Start",
  "diagnostics.enabled": "Diagnostics Enabled",
  "diagnostics.flags": "Diagnostics Flags",
  "diagnostics.otel.enabled": "OpenTelemetry Enabled",
  "diagnostics.otel.endpoint": "OpenTelemetry Endpoint",
  "diagnostics.otel.protocol": "OpenTelemetry Protocol",
  "diagnostics.otel.headers": "OpenTelemetry Headers",
  "diagnostics.otel.serviceName": "OpenTelemetry Service Name",
  "diagnostics.otel.traces": "OpenTelemetry Traces Enabled",
  "diagnostics.otel.metrics": "OpenTelemetry Metrics Enabled",
  "diagnostics.otel.logs": "OpenTelemetry Logs Enabled",
  "diagnostics.otel.sampleRate": "OpenTelemetry Trace Sample Rate",
  "diagnostics.otel.flushIntervalMs": "OpenTelemetry Flush Interval (ms)",
  "diagnostics.cacheTrace.enabled": "Cache Trace Enabled",
  "diagnostics.cacheTrace.filePath": "Cache Trace File Path",
  "diagnostics.cacheTrace.includeMessages": "Cache Trace Include Messages",
  "diagnostics.cacheTrace.includePrompt": "Cache Trace Include Prompt",
  "diagnostics.cacheTrace.includeSystem": "Cache Trace Include System",
  "agents.list.*.identity.avatar": "Identity Avatar",
  "gateway.remote.url": "Remote Gateway URL",
  "gateway.remote.sshTarget": "Remote Gateway SSH Target",
  "gateway.remote.sshIdentity": "Remote Gateway SSH Identity",
  "gateway.remote.token": "Remote Gateway Token",
  "gateway.remote.password": "Remote Gateway Password",
  "gateway.remote.tlsFingerprint": "Remote Gateway TLS Fingerprint",
  "gateway.auth.token": "Gateway Token",
  "gateway.auth.password": "Gateway Password",
  "tools.media.image.enabled": "Enable Image Understanding",
  "tools.media.image.maxBytes": "Image Understanding Max Bytes",
  "tools.media.image.maxChars": "Image Understanding Max Chars",
  "tools.media.image.prompt": "Image Understanding Prompt",
  "tools.media.image.timeoutSeconds": "Image Understanding Timeout (sec)",
  "tools.media.image.attachments": "Image Understanding Attachment Policy",
  "tools.media.image.models": "Image Understanding Models",
  "tools.media.image.scope": "Image Understanding Scope",
  "tools.media.models": "Media Understanding Shared Models",
  "tools.media.concurrency": "Media Understanding Concurrency",
  "tools.media.audio.enabled": "Enable Audio Understanding",
  "tools.media.audio.maxBytes": "Audio Understanding Max Bytes",
  "tools.media.audio.maxChars": "Audio Understanding Max Chars",
  "tools.media.audio.prompt": "Audio Understanding Prompt",
  "tools.media.audio.timeoutSeconds": "Audio Understanding Timeout (sec)",
  "tools.media.audio.language": "Audio Understanding Language",
  "tools.media.audio.attachments": "Audio Understanding Attachment Policy",
  "tools.media.audio.models": "Audio Understanding Models",
  "tools.media.audio.scope": "Audio Understanding Scope",
  "tools.media.video.enabled": "Enable Video Understanding",
  "tools.media.video.maxBytes": "Video Understanding Max Bytes",
  "tools.media.video.maxChars": "Video Understanding Max Chars",
  "tools.media.video.prompt": "Video Understanding Prompt",
  "tools.media.video.timeoutSeconds": "Video Understanding Timeout (sec)",
  "tools.media.video.attachments": "Video Understanding Attachment Policy",
  "tools.media.video.models": "Video Understanding Models",
  "tools.media.video.scope": "Video Understanding Scope",
  "tools.links.enabled": "Enable Link Understanding",
  "tools.links.maxLinks": "Link Understanding Max Links",
  "tools.links.timeoutSeconds": "Link Understanding Timeout (sec)",
  "tools.links.models": "Link Understanding Models",
  "tools.links.scope": "Link Understanding Scope",
  "tools.profile": "Tool Profile",
  "tools.alsoAllow": "Tool Allowlist Additions",
  "agents.list[].tools.profile": "Agent Tool Profile",
  "agents.list[].tools.alsoAllow": "Agent Tool Allowlist Additions",
  "tools.byProvider": "Tool Policy by Provider",
  "agents.list[].tools.byProvider": "Agent Tool Policy by Provider",
  "tools.exec.applyPatch.enabled": "Enable apply_patch",
  "tools.exec.applyPatch.allowModels": "apply_patch Model Allowlist",
  "tools.exec.notifyOnExit": "Exec Notify On Exit",
  "tools.exec.approvalRunningNoticeMs": "Exec Approval Running Notice (ms)",
  "tools.exec.host": "Exec Host",
  "tools.exec.security": "Exec Security",
  "tools.exec.ask": "Exec Ask",
  "tools.exec.node": "Exec Node Binding",
  "tools.exec.pathPrepend": "Exec PATH Prepend",
  "tools.exec.safeBins": "Exec Safe Bins",
  "tools.message.allowCrossContextSend": "Allow Cross-Context Messaging",
  "tools.message.crossContext.allowWithinProvider": "Allow Cross-Context (Same Provider)",
  "tools.message.crossContext.allowAcrossProviders": "Allow Cross-Context (Across Providers)",
  "tools.message.crossContext.marker.enabled": "Cross-Context Marker",
  "tools.message.crossContext.marker.prefix": "Cross-Context Marker Prefix",
  "tools.message.crossContext.marker.suffix": "Cross-Context Marker Suffix",
  "tools.message.broadcast.enabled": "Enable Message Broadcast",
  "tools.web.search.enabled": "Enable Web Search Tool",
  "tools.web.search.provider": "Web Search Provider",
  "tools.web.search.apiKey": "Brave Search API Key",
  "tools.web.search.maxResults": "Web Search Max Results",
  "tools.web.search.timeoutSeconds": "Web Search Timeout (sec)",
  "tools.web.search.cacheTtlMinutes": "Web Search Cache TTL (min)",
  "tools.web.fetch.enabled": "Enable Web Fetch Tool",
  "tools.web.fetch.maxChars": "Web Fetch Max Chars",
  "tools.web.fetch.timeoutSeconds": "Web Fetch Timeout (sec)",
  "tools.web.fetch.cacheTtlMinutes": "Web Fetch Cache TTL (min)",
  "tools.web.fetch.maxRedirects": "Web Fetch Max Redirects",
  "tools.web.fetch.userAgent": "Web Fetch User-Agent",
  "gateway.controlUi.basePath": "Control UI Base Path",
  "gateway.controlUi.allowInsecureAuth": "Allow Insecure Control UI Auth",
  "gateway.controlUi.dangerouslyDisableDeviceAuth": "Dangerously Disable Control UI Device Auth",
  "gateway.http.endpoints.chatCompletions.enabled": "OpenAI Chat Completions Endpoint",
  "gateway.reload.mode": "Config Reload Mode",
  "gateway.reload.debounceMs": "Config Reload Debounce (ms)",
  "gateway.nodes.browser.mode": "Gateway Node Browser Mode",
  "gateway.nodes.browser.node": "Gateway Node Browser Pin",
  "gateway.nodes.allowCommands": "Gateway Node Allowlist (Extra Commands)",
  "gateway.nodes.denyCommands": "Gateway Node Denylist",
  "nodeHost.browserProxy.enabled": "Node Browser Proxy Enabled",
  "nodeHost.browserProxy.allowProfiles": "Node Browser Proxy Allowed Profiles",
  "skills.load.watch": "Watch Skills",
  "skills.load.watchDebounceMs": "Skills Watch Debounce (ms)",
  "agents.defaults.workspace": "Workspace",
  "agents.defaults.repoRoot": "Repo Root",
  "agents.defaults.bootstrapMaxChars": "Bootstrap Max Chars",
  "agents.defaults.envelopeTimezone": "Envelope Timezone",
  "agents.defaults.envelopeTimestamp": "Envelope Timestamp",
  "agents.defaults.envelopeElapsed": "Envelope Elapsed",
  "agents.defaults.memorySearch": "Memory Search",
  "agents.defaults.memorySearch.enabled": "Enable Memory Search",
  "agents.defaults.memorySearch.sources": "Memory Search Sources",
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Memory Search Session Index (Experimental)",
  "agents.defaults.memorySearch.provider": "Memory Search Provider",
  "agents.defaults.memorySearch.remote.baseUrl": "Remote Embedding Base URL",
  "agents.defaults.memorySearch.remote.apiKey": "Remote Embedding API Key",
  "agents.defaults.memorySearch.remote.headers": "Remote Embedding Headers",
  "agents.defaults.memorySearch.remote.batch.concurrency": "Remote Batch Concurrency",
  "agents.defaults.memorySearch.model": "Memory Search Model",
  "agents.defaults.memorySearch.fallback": "Memory Search Fallback",
  "agents.defaults.memorySearch.local.modelPath": "Local Embedding Model Path",
  "agents.defaults.memorySearch.store.path": "Memory Search Index Path",
  "agents.defaults.memorySearch.store.vector.enabled": "Memory Search Vector Index",
  "agents.defaults.memorySearch.store.vector.extensionPath": "Memory Search Vector Extension Path",
  "agents.defaults.memorySearch.chunking.tokens": "Memory Chunk Tokens",
  "agents.defaults.memorySearch.chunking.overlap": "Memory Chunk Overlap Tokens",
  "agents.defaults.memorySearch.sync.onSessionStart": "Index on Session Start",
  "agents.defaults.memorySearch.sync.onSearch": "Index on Search (Lazy)",
  "agents.defaults.memorySearch.sync.watch": "Watch Memory Files",
  "agents.defaults.memorySearch.sync.watchDebounceMs": "Memory Watch Debounce (ms)",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes": "Session Delta Bytes",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages": "Session Delta Messages",
  "agents.defaults.memorySearch.query.maxResults": "Memory Search Max Results",
  "agents.defaults.memorySearch.query.minScore": "Memory Search Min Score",
  "agents.defaults.memorySearch.query.hybrid.enabled": "Memory Search Hybrid",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight": "Memory Search Vector Weight",
  "agents.defaults.memorySearch.query.hybrid.textWeight": "Memory Search Text Weight",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier":
    "Memory Search Hybrid Candidate Multiplier",
  "agents.defaults.memorySearch.cache.enabled": "Memory Search Embedding Cache",
  "agents.defaults.memorySearch.cache.maxEntries": "Memory Search Embedding Cache Max Entries",
  "auth.profiles": "Auth Profiles",
  "auth.order": "Auth Profile Order",
  "auth.cooldowns.billingBackoffHours": "Billing Backoff (hours)",
  "auth.cooldowns.billingBackoffHoursByProvider": "Billing Backoff Overrides",
  "auth.cooldowns.billingMaxHours": "Billing Backoff Cap (hours)",
  "auth.cooldowns.failureWindowHours": "Failover Window (hours)",
  "agents.defaults.models": "Models",
  "agents.defaults.model.primary": "Primary Model",
  "agents.defaults.model.fallbacks": "Model Fallbacks",
  "agents.defaults.imageModel.primary": "Image Model",
  "agents.defaults.imageModel.fallbacks": "Image Model Fallbacks",
  "agents.defaults.humanDelay.mode": "Human Delay Mode",
  "agents.defaults.humanDelay.minMs": "Human Delay Min (ms)",
  "agents.defaults.humanDelay.maxMs": "Human Delay Max (ms)",
  "agents.defaults.cliBackends": "CLI Backends",
  "commands.native": "Native Commands",
  "commands.nativeSkills": "Native Skill Commands",
  "commands.text": "Text Commands",
  "commands.bash": "Allow Bash Chat Command",
  "commands.bashForegroundMs": "Bash Foreground Window (ms)",
  "commands.config": "Allow /config",
  "commands.debug": "Allow /debug",
  "commands.restart": "Allow Restart",
  "commands.useAccessGroups": "Use Access Groups",
  "ui.seamColor": "Accent Color",
  "ui.assistant.name": "Assistant Name",
  "ui.assistant.avatar": "Assistant Avatar",
  "browser.evaluateEnabled": "Browser Evaluate Enabled",
  "browser.snapshotDefaults": "Browser Snapshot Defaults",
  "browser.snapshotDefaults.mode": "Browser Snapshot Mode",
  "browser.remoteCdpTimeoutMs": "Remote CDP Timeout (ms)",
  "browser.remoteCdpHandshakeTimeoutMs": "Remote CDP Handshake Timeout (ms)",
  "session.dmScope": "DM Session Scope",
  "session.agentToAgent.maxPingPongTurns": "Agent-to-Agent Ping-Pong Turns",
  "messages.ackReaction": "Ack Reaction Emoji",
  "messages.ackReactionScope": "Ack Reaction Scope",
  "messages.inbound.debounceMs": "Inbound Message Debounce (ms)",
  "talk.apiKey": "Talk API Key",
  "channels.whatsapp": "WhatsApp",
  "channels.telegram": "Telegram",
  "channels.telegram.customCommands": "Telegram Custom Commands",
  "channels.discord": "Discord",
  "channels.slack": "Slack",
  "channels.mattermost": "Mattermost",
  "channels.signal": "Signal",
  "channels.imessage": "iMessage",
  "channels.bluebubbles": "BlueBubbles",
  "channels.msteams": "MS Teams",
  "channels.telegram.botToken": "Telegram Bot Token",
  "channels.telegram.dmPolicy": "Telegram DM Policy",
  "channels.telegram.streamMode": "Telegram Draft Stream Mode",
  "channels.telegram.draftChunk.minChars": "Telegram Draft Chunk Min Chars",
  "channels.telegram.draftChunk.maxChars": "Telegram Draft Chunk Max Chars",
  "channels.telegram.draftChunk.breakPreference": "Telegram Draft Chunk Break Preference",
  "channels.telegram.retry.attempts": "Telegram Retry Attempts",
  "channels.telegram.retry.minDelayMs": "Telegram Retry Min Delay (ms)",
  "channels.telegram.retry.maxDelayMs": "Telegram Retry Max Delay (ms)",
  "channels.telegram.retry.jitter": "Telegram Retry Jitter",
  "channels.telegram.network.autoSelectFamily": "Telegram autoSelectFamily",
  "channels.telegram.timeoutSeconds": "Telegram API Timeout (seconds)",
  "channels.telegram.capabilities.inlineButtons": "Telegram Inline Buttons",
  "channels.whatsapp.dmPolicy": "WhatsApp DM Policy",
  "channels.whatsapp.selfChatMode": "WhatsApp Self-Phone Mode",
  "channels.whatsapp.debounceMs": "WhatsApp Message Debounce (ms)",
  "channels.signal.dmPolicy": "Signal DM Policy",
  "channels.imessage.dmPolicy": "iMessage DM Policy",
  "channels.bluebubbles.dmPolicy": "BlueBubbles DM Policy",
  "channels.discord.dm.policy": "Discord DM Policy",
  "channels.discord.retry.attempts": "Discord Retry Attempts",
  "channels.discord.retry.minDelayMs": "Discord Retry Min Delay (ms)",
  "channels.discord.retry.maxDelayMs": "Discord Retry Max Delay (ms)",
  "channels.discord.retry.jitter": "Discord Retry Jitter",
  "channels.discord.maxLinesPerMessage": "Discord Max Lines Per Message",
  "channels.discord.intents.presence": "Discord Presence Intent",
  "channels.discord.intents.guildMembers": "Discord Guild Members Intent",
  "channels.slack.dm.policy": "Slack DM Policy",
  "channels.slack.allowBots": "Slack Allow Bot Messages",
  "channels.discord.token": "Discord Bot Token",
  "channels.slack.botToken": "Slack Bot Token",
  "channels.slack.appToken": "Slack App Token",
  "channels.slack.userToken": "Slack User Token",
  "channels.slack.userTokenReadOnly": "Slack User Token Read Only",
  "channels.slack.thread.historyScope": "Slack Thread History Scope",
  "channels.slack.thread.inheritParent": "Slack Thread Parent Inheritance",
  "channels.mattermost.botToken": "Mattermost Bot Token",
  "channels.mattermost.baseUrl": "Mattermost Base URL",
  "channels.mattermost.chatmode": "Mattermost Chat Mode",
  "channels.mattermost.oncharPrefixes": "Mattermost Onchar Prefixes",
  "channels.mattermost.requireMention": "Mattermost Require Mention",
  "channels.signal.account": "Signal Account",
  "channels.imessage.cliPath": "iMessage CLI Path",
  "agents.list[].identity.avatar": "Agent Avatar",
  "discovery.mdns.mode": "mDNS Discovery Mode",
  "plugins.enabled": "Enable Plugins",
  "plugins.allow": "Plugin Allowlist",
  "plugins.deny": "Plugin Denylist",
  "plugins.load.paths": "Plugin Load Paths",
  "plugins.slots": "Plugin Slots",
  "plugins.slots.memory": "Memory Plugin",
  "plugins.entries": "Plugin Entries",
  "plugins.entries.*.enabled": "Plugin Enabled",
  "plugins.entries.*.config": "Plugin Config",
  "plugins.installs": "Plugin Install Records",
  "plugins.installs.*.source": "Plugin Install Source",
  "plugins.installs.*.spec": "Plugin Install Spec",
  "plugins.installs.*.sourcePath": "Plugin Install Source Path",
  "plugins.installs.*.installPath": "Plugin Install Path",
  "plugins.installs.*.version": "Plugin Install Version",
  "plugins.installs.*.installedAt": "Plugin Install Time",
};

const FIELD_HELP: Record<string, string> = {
  "meta.lastTouchedVersion": "Auto-set when Clawdbot writes the config.",
  "meta.lastTouchedAt": "ISO timestamp of the last config write (auto-set).",
  "update.channel": 'Update channel for git + npm installs ("stable", "beta", or "dev").',
  "update.checkOnStart": "Check for npm updates when the gateway starts (default: true).",
  "gateway.remote.url": "Remote Gateway WebSocket URL (ws:// or wss://).",
  "gateway.remote.tlsFingerprint":
    "Expected sha256 TLS fingerprint for the remote gateway (pin to avoid MITM).",
  "gateway.remote.sshTarget":
    "Remote gateway over SSH (tunnels the gateway port to localhost). Format: user@host or user@host:port.",
  "gateway.remote.sshIdentity": "Optional SSH identity file path (passed to ssh -i).",
  "agents.list[].identity.avatar":
    "Avatar image path (relative to the agent workspace only) or a remote URL/data URL.",
  "discovery.mdns.mode":
    'mDNS broadcast mode ("minimal" default, "full" includes cliPath/sshPort, "off" disables mDNS).',
  "gateway.auth.token":
    "Required by default for gateway access (unless using Tailscale Serve identity); required for non-loopback binds.",
  "gateway.auth.password": "Required for Tailscale funnel.",
  "gateway.controlUi.basePath":
    "Optional URL prefix where the Control UI is served (e.g. /clawdbot).",
  "gateway.controlUi.allowInsecureAuth":
    "Allow Control UI auth over insecure HTTP (token-only; not recommended).",
  "gateway.controlUi.dangerouslyDisableDeviceAuth":
    "DANGEROUS. Disable Control UI device identity checks (token/password only).",
  "gateway.http.endpoints.chatCompletions.enabled":
    "Enable the OpenAI-compatible `POST /v1/chat/completions` endpoint (default: false).",
  "gateway.reload.mode": 'Hot reload strategy for config changes ("hybrid" recommended).',
  "gateway.reload.debounceMs": "Debounce window (ms) before applying config changes.",
  "gateway.nodes.browser.mode":
    'Node browser routing ("auto" = pick single connected browser node, "manual" = require node param, "off" = disable).',
  "gateway.nodes.browser.node": "Pin browser routing to a specific node id or name (optional).",
  "gateway.nodes.allowCommands":
    "Extra node.invoke commands to allow beyond the gateway defaults (array of command strings).",
  "gateway.nodes.denyCommands":
    "Commands to block even if present in node claims or default allowlist.",
  "nodeHost.browserProxy.enabled": "Expose the local browser control server via node proxy.",
  "nodeHost.browserProxy.allowProfiles":
    "Optional allowlist of browser profile names exposed via the node proxy.",
  "diagnostics.flags":
    'Enable targeted diagnostics logs by flag (e.g. ["telegram.http"]). Supports wildcards like "telegram.*" or "*".',
  "diagnostics.cacheTrace.enabled":
    "Log cache trace snapshots for embedded agent runs (default: false).",
  "diagnostics.cacheTrace.filePath":
    "JSONL output path for cache trace logs (default: $CLAWDBOT_STATE_DIR/logs/cache-trace.jsonl).",
  "diagnostics.cacheTrace.includeMessages":
    "Include full message payloads in trace output (default: true).",
  "diagnostics.cacheTrace.includePrompt": "Include prompt text in trace output (default: true).",
  "diagnostics.cacheTrace.includeSystem": "Include system prompt in trace output (default: true).",
  "tools.exec.applyPatch.enabled":
    "Experimental. Enables apply_patch for OpenAI models when allowed by tool policy.",
  "tools.exec.applyPatch.allowModels":
    'Optional allowlist of model ids (e.g. "gpt-5.2" or "openai/gpt-5.2").',
  "tools.exec.notifyOnExit":
    "When true (default), backgrounded exec sessions enqueue a system event and request a heartbeat on exit.",
  "tools.exec.pathPrepend": "Directories to prepend to PATH for exec runs (gateway/sandbox).",
  "tools.exec.safeBins":
    "Allow stdin-only safe binaries to run without explicit allowlist entries.",
  "tools.message.allowCrossContextSend":
    "Legacy override: allow cross-context sends across all providers.",
  "tools.message.crossContext.allowWithinProvider":
    "Allow sends to other channels within the same provider (default: true).",
  "tools.message.crossContext.allowAcrossProviders":
    "Allow sends across different providers (default: false).",
  "tools.message.crossContext.marker.enabled":
    "Add a visible origin marker when sending cross-context (default: true).",
  "tools.message.crossContext.marker.prefix":
    'Text prefix for cross-context markers (supports "{channel}").',
  "tools.message.crossContext.marker.suffix":
    'Text suffix for cross-context markers (supports "{channel}").',
  "tools.message.broadcast.enabled": "Enable broadcast action (default: true).",
  "tools.web.search.enabled": "Enable the web_search tool (requires a provider API key).",
  "tools.web.search.provider": 'Search provider ("brave" or "perplexity").',
  "tools.web.search.apiKey": "Brave Search API key (fallback: BRAVE_API_KEY env var).",
  "tools.web.search.maxResults": "Default number of results to return (1-10).",
  "tools.web.search.timeoutSeconds": "Timeout in seconds for web_search requests.",
  "tools.web.search.cacheTtlMinutes": "Cache TTL in minutes for web_search results.",
  "tools.web.search.perplexity.apiKey":
    "Perplexity or OpenRouter API key (fallback: PERPLEXITY_API_KEY or OPENROUTER_API_KEY env var).",
  "tools.web.search.perplexity.baseUrl":
    "Perplexity base URL override (default: https://openrouter.ai/api/v1 or https://api.perplexity.ai).",
  "tools.web.search.perplexity.model":
    'Perplexity model override (default: "perplexity/sonar-pro").',
  "tools.web.fetch.enabled": "Enable the web_fetch tool (lightweight HTTP fetch).",
  "tools.web.fetch.maxChars": "Max characters returned by web_fetch (truncated).",
  "tools.web.fetch.timeoutSeconds": "Timeout in seconds for web_fetch requests.",
  "tools.web.fetch.cacheTtlMinutes": "Cache TTL in minutes for web_fetch results.",
  "tools.web.fetch.maxRedirects": "Maximum redirects allowed for web_fetch (default: 3).",
  "tools.web.fetch.userAgent": "Override User-Agent header for web_fetch requests.",
  "tools.web.fetch.readability":
    "Use Readability to extract main content from HTML (fallbacks to basic HTML cleanup).",
  "tools.web.fetch.firecrawl.enabled": "Enable Firecrawl fallback for web_fetch (if configured).",
  "tools.web.fetch.firecrawl.apiKey": "Firecrawl API key (fallback: FIRECRAWL_API_KEY env var).",
  "tools.web.fetch.firecrawl.baseUrl":
    "Firecrawl base URL (e.g. https://api.firecrawl.dev or custom endpoint).",
  "tools.web.fetch.firecrawl.onlyMainContent":
    "When true, Firecrawl returns only the main content (default: true).",
  "tools.web.fetch.firecrawl.maxAgeMs":
    "Firecrawl maxAge (ms) for cached results when supported by the API.",
  "tools.web.fetch.firecrawl.timeoutSeconds": "Timeout in seconds for Firecrawl requests.",
  "channels.slack.allowBots":
    "Allow bot-authored messages to trigger Slack replies (default: false).",
  "channels.slack.thread.historyScope":
    'Scope for Slack thread history context ("thread" isolates per thread; "channel" reuses channel history).',
  "channels.slack.thread.inheritParent":
    "If true, Slack thread sessions inherit the parent channel transcript (default: false).",
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
  "auth.cooldowns.billingBackoffHours":
    "Base backoff (hours) when a profile fails due to billing/insufficient credits (default: 5).",
  "auth.cooldowns.billingBackoffHoursByProvider":
    "Optional per-provider overrides for billing backoff (hours).",
  "auth.cooldowns.billingMaxHours": "Cap (hours) for billing backoff (default: 24).",
  "auth.cooldowns.failureWindowHours": "Failure window (hours) for backoff counters (default: 24).",
  "agents.defaults.bootstrapMaxChars":
    "Max characters of each workspace bootstrap file injected into the system prompt before truncation (default: 20000).",
  "agents.defaults.repoRoot":
    "Optional repository root shown in the system prompt runtime line (overrides auto-detect).",
  "agents.defaults.envelopeTimezone":
    'Timezone for message envelopes ("utc", "local", "user", or an IANA timezone string).',
  "agents.defaults.envelopeTimestamp":
    'Include absolute timestamps in message envelopes ("on" or "off").',
  "agents.defaults.envelopeElapsed": 'Include elapsed time in message envelopes ("on" or "off").',
  "agents.defaults.models": "Configured model catalog (keys are full provider/model IDs).",
  "agents.defaults.memorySearch":
    "Vector search over MEMORY.md and memory/*.md (per-agent overrides supported).",
  "agents.defaults.memorySearch.sources":
    'Sources to index for memory search (default: ["memory"]; add "sessions" to include session transcripts).',
  "agents.defaults.memorySearch.experimental.sessionMemory":
    "Enable experimental session transcript indexing for memory search (default: false).",
  "agents.defaults.memorySearch.provider": 'Embedding provider ("openai", "gemini", or "local").',
  "agents.defaults.memorySearch.remote.baseUrl":
    "Custom base URL for remote embeddings (OpenAI-compatible proxies or Gemini overrides).",
  "agents.defaults.memorySearch.remote.apiKey": "Custom API key for the remote embedding provider.",
  "agents.defaults.memorySearch.remote.headers":
    "Extra headers for remote embeddings (merged; remote overrides OpenAI headers).",
  "agents.defaults.memorySearch.remote.batch.enabled":
    "Enable batch API for memory embeddings (OpenAI/Gemini; default: true).",
  "agents.defaults.memorySearch.remote.batch.wait":
    "Wait for batch completion when indexing (default: true).",
  "agents.defaults.memorySearch.remote.batch.concurrency":
    "Max concurrent embedding batch jobs for memory indexing (default: 2).",
  "agents.defaults.memorySearch.remote.batch.pollIntervalMs":
    "Polling interval in ms for batch status (default: 2000).",
  "agents.defaults.memorySearch.remote.batch.timeoutMinutes":
    "Timeout in minutes for batch indexing (default: 60).",
  "agents.defaults.memorySearch.local.modelPath":
    "Local GGUF model path or hf: URI (node-llama-cpp).",
  "agents.defaults.memorySearch.fallback":
    'Fallback provider when embeddings fail ("openai", "gemini", "local", or "none").',
  "agents.defaults.memorySearch.store.path":
    "SQLite index path (default: ~/.clawdbot/memory/{agentId}.sqlite).",
  "agents.defaults.memorySearch.store.vector.enabled":
    "Enable sqlite-vec extension for vector search (default: true).",
  "agents.defaults.memorySearch.store.vector.extensionPath":
    "Optional override path to sqlite-vec extension library (.dylib/.so/.dll).",
  "agents.defaults.memorySearch.query.hybrid.enabled":
    "Enable hybrid BM25 + vector search for memory (default: true).",
  "agents.defaults.memorySearch.query.hybrid.vectorWeight":
    "Weight for vector similarity when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.textWeight":
    "Weight for BM25 text relevance when merging results (0-1).",
  "agents.defaults.memorySearch.query.hybrid.candidateMultiplier":
    "Multiplier for candidate pool size (default: 4).",
  "agents.defaults.memorySearch.cache.enabled":
    "Cache chunk embeddings in SQLite to speed up reindexing and frequent updates (default: true).",
  "agents.defaults.memorySearch.cache.maxEntries":
    "Optional cap on cached embeddings (best-effort).",
  "agents.defaults.memorySearch.sync.onSearch":
    "Lazy sync: schedule a reindex on search after changes.",
  "agents.defaults.memorySearch.sync.watch": "Watch memory files for changes (chokidar).",
  "agents.defaults.memorySearch.sync.sessions.deltaBytes":
    "Minimum appended bytes before session transcripts trigger reindex (default: 100000).",
  "agents.defaults.memorySearch.sync.sessions.deltaMessages":
    "Minimum appended JSONL lines before session transcripts trigger reindex (default: 50).",
  "plugins.enabled": "Enable plugin/extension loading (default: true).",
  "plugins.allow": "Optional allowlist of plugin ids; when set, only listed plugins load.",
  "plugins.deny": "Optional denylist of plugin ids; deny wins over allowlist.",
  "plugins.load.paths": "Additional plugin files or directories to load.",
  "plugins.slots": "Select which plugins own exclusive slots (memory, etc.).",
  "plugins.slots.memory":
    'Select the active memory plugin by id, or "none" to disable memory plugins.',
  "plugins.entries": "Per-plugin settings keyed by plugin id (enable/disable + config payloads).",
  "plugins.entries.*.enabled": "Overrides plugin enable/disable for this entry (restart required).",
  "plugins.entries.*.config": "Plugin-defined config payload (schema is provided by the plugin).",
  "plugins.installs":
    "CLI-managed install metadata (used by `clawdbot plugins update` to locate install sources).",
  "plugins.installs.*.source": 'Install source ("npm", "archive", or "path").',
  "plugins.installs.*.spec": "Original npm spec used for install (if source is npm).",
  "plugins.installs.*.sourcePath": "Original archive/path used for install (if any).",
  "plugins.installs.*.installPath":
    "Resolved install directory (usually ~/.clawdbot/extensions/<id>).",
  "plugins.installs.*.version": "Version recorded at install time (if available).",
  "plugins.installs.*.installedAt": "ISO timestamp of last install/update.",
  "agents.list.*.identity.avatar":
    "Agent avatar (workspace-relative path, http(s) URL, or data URI).",
  "agents.defaults.model.primary": "Primary model (provider/model).",
  "agents.defaults.model.fallbacks":
    "Ordered fallback models (provider/model). Used when the primary model fails.",
  "agents.defaults.imageModel.primary":
    "Optional image model (provider/model) used when the primary model lacks image input.",
  "agents.defaults.imageModel.fallbacks": "Ordered fallback image models (provider/model).",
  "agents.defaults.cliBackends": "Optional CLI backends for text-only fallback (claude-cli, etc.).",
  "agents.defaults.humanDelay.mode": 'Delay style for block replies ("off", "natural", "custom").',
  "agents.defaults.humanDelay.minMs": "Minimum delay in ms for custom humanDelay (default: 800).",
  "agents.defaults.humanDelay.maxMs": "Maximum delay in ms for custom humanDelay (default: 2500).",
  "commands.native":
    "Register native commands with channels that support it (Discord/Slack/Telegram).",
  "commands.nativeSkills":
    "Register native skill commands (user-invocable skills) with channels that support it.",
  "commands.text": "Allow text command parsing (slash commands only).",
  "commands.bash":
    "Allow bash chat command (`!`; `/bash` alias) to run host shell commands (default: false; requires tools.elevated).",
  "commands.bashForegroundMs":
    "How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately).",
  "commands.config": "Allow /config chat command to read/write config on disk (default: false).",
  "commands.debug": "Allow /debug chat command for runtime-only overrides (default: false).",
  "commands.restart": "Allow /restart and gateway restart tool actions (default: false).",
  "commands.useAccessGroups": "Enforce access-group allowlists/policies for commands.",
  "session.dmScope":
    'DM session scoping: "main" keeps continuity; "per-peer" or "per-channel-peer" isolates DM history (recommended for shared inboxes).',
  "session.identityLinks":
    "Map canonical identities to provider-prefixed peer IDs for DM session linking (example: telegram:123456).",
  "channels.telegram.configWrites":
    "Allow Telegram to write config in response to channel events/commands (default: true).",
  "channels.slack.configWrites":
    "Allow Slack to write config in response to channel events/commands (default: true).",
  "channels.mattermost.configWrites":
    "Allow Mattermost to write config in response to channel events/commands (default: true).",
  "channels.discord.configWrites":
    "Allow Discord to write config in response to channel events/commands (default: true).",
  "channels.whatsapp.configWrites":
    "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  "channels.signal.configWrites":
    "Allow Signal to write config in response to channel events/commands (default: true).",
  "channels.imessage.configWrites":
    "Allow iMessage to write config in response to channel events/commands (default: true).",
  "channels.msteams.configWrites":
    "Allow Microsoft Teams to write config in response to channel events/commands (default: true).",
  "channels.discord.commands.native": 'Override native commands for Discord (bool or "auto").',
  "channels.discord.commands.nativeSkills":
    'Override native skill commands for Discord (bool or "auto").',
  "channels.telegram.commands.native": 'Override native commands for Telegram (bool or "auto").',
  "channels.telegram.commands.nativeSkills":
    'Override native skill commands for Telegram (bool or "auto").',
  "channels.slack.commands.native": 'Override native commands for Slack (bool or "auto").',
  "channels.slack.commands.nativeSkills":
    'Override native skill commands for Slack (bool or "auto").',
  "session.agentToAgent.maxPingPongTurns":
    "Max reply-back turns between requester and target (0–5).",
  "channels.telegram.customCommands":
    "Additional Telegram bot menu commands (merged with native; conflicts ignored).",
  "messages.ackReaction": "Emoji reaction used to acknowledge inbound messages (empty disables).",
  "messages.ackReactionScope":
    'When to send ack reactions ("group-mentions", "group-all", "direct", "all").',
  "messages.inbound.debounceMs":
    "Debounce window (ms) for batching rapid inbound messages from the same sender (0 to disable).",
  "channels.telegram.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.telegram.allowFrom=["*"].',
  "channels.telegram.streamMode":
    "Draft streaming mode for Telegram replies (off | partial | block). Separate from block streaming; requires private topics + sendMessageDraft.",
  "channels.telegram.draftChunk.minChars":
    'Minimum chars before emitting a Telegram draft update when channels.telegram.streamMode="block" (default: 200).',
  "channels.telegram.draftChunk.maxChars":
    'Target max size for a Telegram draft update chunk when channels.telegram.streamMode="block" (default: 800; clamped to channels.telegram.textChunkLimit).',
  "channels.telegram.draftChunk.breakPreference":
    "Preferred breakpoints for Telegram draft chunks (paragraph | newline | sentence). Default: paragraph.",
  "channels.telegram.retry.attempts":
    "Max retry attempts for outbound Telegram API calls (default: 3).",
  "channels.telegram.retry.minDelayMs": "Minimum retry delay in ms for Telegram outbound calls.",
  "channels.telegram.retry.maxDelayMs":
    "Maximum retry delay cap in ms for Telegram outbound calls.",
  "channels.telegram.retry.jitter": "Jitter factor (0-1) applied to Telegram retry delays.",
  "channels.telegram.network.autoSelectFamily":
    "Override Node autoSelectFamily for Telegram (true=enable, false=disable).",
  "channels.telegram.timeoutSeconds":
    "Max seconds before Telegram API requests are aborted (default: 500 per grammY).",
  "channels.whatsapp.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
  "channels.whatsapp.selfChatMode": "Same-phone setup (bot uses your personal WhatsApp number).",
  "channels.whatsapp.debounceMs":
    "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  "channels.signal.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.signal.allowFrom=["*"].',
  "channels.imessage.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.imessage.allowFrom=["*"].',
  "channels.bluebubbles.dmPolicy":
    'Direct message access control ("pairing" recommended). "open" requires channels.bluebubbles.allowFrom=["*"].',
  "channels.discord.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.discord.dm.allowFrom=["*"].',
  "channels.discord.retry.attempts":
    "Max retry attempts for outbound Discord API calls (default: 3).",
  "channels.discord.retry.minDelayMs": "Minimum retry delay in ms for Discord outbound calls.",
  "channels.discord.retry.maxDelayMs": "Maximum retry delay cap in ms for Discord outbound calls.",
  "channels.discord.retry.jitter": "Jitter factor (0-1) applied to Discord retry delays.",
  "channels.discord.maxLinesPerMessage": "Soft max line count per Discord message (default: 17).",
  "channels.discord.intents.presence":
    "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.",
  "channels.discord.intents.guildMembers":
    "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.",
  "channels.slack.dm.policy":
    'Direct message access control ("pairing" recommended). "open" requires channels.slack.dm.allowFrom=["*"].',
};

const FIELD_PLACEHOLDERS: Record<string, string> = {
  "gateway.remote.url": "ws://host:18789",
  "gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
  "gateway.remote.sshTarget": "user@host",
  "gateway.controlUi.basePath": "/clawdbot",
  "channels.mattermost.baseUrl": "https://chat.example.com",
  "agents.list[].identity.avatar": "avatars/clawd.png",
};

const SENSITIVE_PATTERNS = [/token/i, /password/i, /secret/i, /api.?key/i];

function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
};

function cloneSchema<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonSchemaObject;
}

function isObjectSchema(schema: JsonSchemaObject): boolean {
  const type = schema.type;
  if (type === "object") return true;
  if (Array.isArray(type) && type.includes("object")) return true;
  return Boolean(schema.properties || schema.additionalProperties);
}

function mergeObjectSchema(base: JsonSchemaObject, extension: JsonSchemaObject): JsonSchemaObject {
  const mergedRequired = new Set<string>([...(base.required ?? []), ...(extension.required ?? [])]);
  const merged: JsonSchemaObject = {
    ...base,
    ...extension,
    properties: {
      ...base.properties,
      ...extension.properties,
    },
  };
  if (mergedRequired.size > 0) {
    merged.required = Array.from(mergedRequired);
  }
  const additional = extension.additionalProperties ?? base.additionalProperties;
  if (additional !== undefined) merged.additionalProperties = additional;
  return merged;
}

function buildBaseHints(): ConfigUiHints {
  const hints: ConfigUiHints = {};
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    hints[group] = {
      label,
      group: label,
      order: GROUP_ORDER[group],
    };
  }
  for (const [path, label] of Object.entries(FIELD_LABELS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, label } : { label };
  }
  for (const [path, help] of Object.entries(FIELD_HELP)) {
    const current = hints[path];
    hints[path] = current ? { ...current, help } : { help };
  }
  for (const [path, placeholder] of Object.entries(FIELD_PLACEHOLDERS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, placeholder } : { placeholder };
  }
  return hints;
}

function applySensitiveHints(hints: ConfigUiHints): ConfigUiHints {
  const next = { ...hints };
  for (const key of Object.keys(next)) {
    if (isSensitivePath(key)) {
      next[key] = { ...next[key], sensitive: true };
    }
  }
  return next;
}

function applyPluginHints(hints: ConfigUiHints, plugins: PluginUiMetadata[]): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  for (const plugin of plugins) {
    const id = plugin.id.trim();
    if (!id) continue;
    const name = (plugin.name ?? id).trim() || id;
    const basePath = `plugins.entries.${id}`;

    next[basePath] = {
      ...next[basePath],
      label: name,
      help: plugin.description
        ? `${plugin.description} (plugin: ${id})`
        : `Plugin entry for ${id}.`,
    };
    next[`${basePath}.enabled`] = {
      ...next[`${basePath}.enabled`],
      label: `Enable ${name}`,
    };
    next[`${basePath}.config`] = {
      ...next[`${basePath}.config`],
      label: `${name} Config`,
      help: `Plugin-defined config payload for ${id}.`,
    };

    const uiHints = plugin.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) continue;
      const key = `${basePath}.config.${relPath}`;
      next[key] = {
        ...next[key],
        ...hint,
      };
    }
  }
  return next;
}

function applyChannelHints(hints: ConfigUiHints, channels: ChannelUiMetadata[]): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  for (const channel of channels) {
    const id = channel.id.trim();
    if (!id) continue;
    const basePath = `channels.${id}`;
    const current = next[basePath] ?? {};
    const label = channel.label?.trim();
    const help = channel.description?.trim();
    next[basePath] = {
      ...current,
      ...(label ? { label } : {}),
      ...(help ? { help } : {}),
    };

    const uiHints = channel.configUiHints ?? {};
    for (const [relPathRaw, hint] of Object.entries(uiHints)) {
      const relPath = relPathRaw.trim().replace(/^\./, "");
      if (!relPath) continue;
      const key = `${basePath}.${relPath}`;
      next[key] = {
        ...next[key],
        ...hint,
      };
    }
  }
  return next;
}

function listHeartbeatTargetChannels(channels: ChannelUiMetadata[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of CHANNEL_IDS) {
    const normalized = id.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  for (const channel of channels) {
    const normalized = channel.id.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function applyHeartbeatTargetHints(
  hints: ConfigUiHints,
  channels: ChannelUiMetadata[],
): ConfigUiHints {
  const next: ConfigUiHints = { ...hints };
  const channelList = listHeartbeatTargetChannels(channels);
  const channelHelp = channelList.length ? ` Known channels: ${channelList.join(", ")}.` : "";
  const help = `Delivery target ("last", "none", or a channel id).${channelHelp}`;
  const paths = ["agents.defaults.heartbeat.target", "agents.list.*.heartbeat.target"];
  for (const path of paths) {
    const current = next[path] ?? {};
    next[path] = {
      ...current,
      help: current.help ?? help,
      placeholder: current.placeholder ?? "last",
    };
  }
  return next;
}

function applyPluginSchemas(schema: ConfigSchema, plugins: PluginUiMetadata[]): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  const pluginsNode = asSchemaObject(root?.properties?.plugins);
  const entriesNode = asSchemaObject(pluginsNode?.properties?.entries);
  if (!entriesNode) return next;

  const entryBase = asSchemaObject(entriesNode.additionalProperties);
  const entryProperties = entriesNode.properties ?? {};
  entriesNode.properties = entryProperties;

  for (const plugin of plugins) {
    if (!plugin.configSchema) continue;
    const entrySchema = entryBase
      ? cloneSchema(entryBase)
      : ({ type: "object" } as JsonSchemaObject);
    const entryObject = asSchemaObject(entrySchema) ?? ({ type: "object" } as JsonSchemaObject);
    const baseConfigSchema = asSchemaObject(entryObject.properties?.config);
    const pluginSchema = asSchemaObject(plugin.configSchema);
    const nextConfigSchema =
      baseConfigSchema &&
      pluginSchema &&
      isObjectSchema(baseConfigSchema) &&
      isObjectSchema(pluginSchema)
        ? mergeObjectSchema(baseConfigSchema, pluginSchema)
        : cloneSchema(plugin.configSchema);

    entryObject.properties = {
      ...entryObject.properties,
      config: nextConfigSchema,
    };
    entryProperties[plugin.id] = entryObject;
  }

  return next;
}

function applyChannelSchemas(schema: ConfigSchema, channels: ChannelUiMetadata[]): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  const channelsNode = asSchemaObject(root?.properties?.channels);
  if (!channelsNode) return next;
  const channelProps = channelsNode.properties ?? {};
  channelsNode.properties = channelProps;

  for (const channel of channels) {
    if (!channel.configSchema) continue;
    const existing = asSchemaObject(channelProps[channel.id]);
    const incoming = asSchemaObject(channel.configSchema);
    if (existing && incoming && isObjectSchema(existing) && isObjectSchema(incoming)) {
      channelProps[channel.id] = mergeObjectSchema(existing, incoming);
    } else {
      channelProps[channel.id] = cloneSchema(channel.configSchema);
    }
  }

  return next;
}

let cachedBase: ConfigSchemaResponse | null = null;

function stripChannelSchema(schema: ConfigSchema): ConfigSchema {
  const next = cloneSchema(schema);
  const root = asSchemaObject(next);
  if (!root || !root.properties) return next;
  const channelsNode = asSchemaObject(root.properties.channels);
  if (channelsNode) {
    channelsNode.properties = {};
    channelsNode.required = [];
    channelsNode.additionalProperties = true;
  }
  return next;
}

function buildBaseConfigSchema(): ConfigSchemaResponse {
  if (cachedBase) return cachedBase;
  const schema = ClawdbotSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  });
  schema.title = "ClawdbotConfig";
  const hints = applySensitiveHints(buildBaseHints());
  const next = {
    schema: stripChannelSchema(schema),
    uiHints: hints,
    version: VERSION,
    generatedAt: new Date().toISOString(),
  };
  cachedBase = next;
  return next;
}

export function buildConfigSchema(params?: {
  plugins?: PluginUiMetadata[];
  channels?: ChannelUiMetadata[];
}): ConfigSchemaResponse {
  const base = buildBaseConfigSchema();
  const plugins = params?.plugins ?? [];
  const channels = params?.channels ?? [];
  if (plugins.length === 0 && channels.length === 0) return base;
  const mergedHints = applySensitiveHints(
    applyHeartbeatTargetHints(
      applyChannelHints(applyPluginHints(base.uiHints, plugins), channels),
      channels,
    ),
  );
  const mergedSchema = applyChannelSchemas(applyPluginSchemas(base.schema, plugins), channels);
  return {
    ...base,
    schema: mergedSchema,
    uiHints: mergedHints,
  };
}
