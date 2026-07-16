import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const discordChannelConfigUiHints = {
  "": {
    label: "Discord",
    help: "Discord channel provider configuration for bot auth, retry policy, streaming, thread bindings, and optional voice capabilities. Keep privileged intents and advanced features disabled unless needed.",
  },
  dmPolicy: {
    label: "Discord DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"].',
  },
  "dm.policy": {
    label: "Discord DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.discord.allowFrom=["*"] (legacy: channels.discord.dm.allowFrom).',
  },
  configWrites: {
    label: "Discord Config Writes",
    help: "Allow Discord to write config in response to channel events/commands (default: true).",
  },
  proxy: {
    label: "Discord Proxy URL",
    help: "Proxy URL for Discord gateway + API requests (app-id lookup and allowlist resolution). Set per account via channels.discord.accounts.<id>.proxy.",
  },
  "commands.native": {
    label: "Discord Native Commands",
    help: 'Override native commands for Discord (bool or "auto").',
  },
  "commands.nativeSkills": {
    label: "Discord Native Skill Commands",
    help: 'Override native skill commands for Discord (bool or "auto").',
  },
  streaming: {
    label: "Discord Streaming Mode",
    help: 'Unified Discord stream preview mode: "off" | "partial" | "block" | "progress". "progress" maps to "partial" on Discord. Legacy boolean/streamMode keys are auto-mapped.',
  },
  "streaming.mode": {
    label: "Discord Streaming Mode",
    help: 'Canonical Discord preview mode: "off" | "partial" | "block" | "progress". "progress" maps to "partial" on Discord.',
  },
  "streaming.chunkMode": {
    label: "Discord Chunk Mode",
    help: 'Chunking mode for outbound Discord text delivery: "length" (default) or "newline".',
  },
  "streaming.block.enabled": {
    label: "Discord Block Streaming Enabled",
    help: 'Enable chunked block-style Discord preview delivery when channels.discord.streaming.mode="block".',
  },
  "streaming.block.coalesce": {
    label: "Discord Block Streaming Coalesce",
    help: "Merge streamed Discord block replies before final delivery.",
  },
  "streaming.preview.chunk.minChars": {
    label: "Discord Draft Chunk Min Chars",
    help: 'Minimum chars before emitting a Discord stream preview update when channels.discord.streaming.mode="block" (default: 200).',
  },
  "streaming.preview.chunk.maxChars": {
    label: "Discord Draft Chunk Max Chars",
    help: 'Target max size for a Discord stream preview chunk when channels.discord.streaming.mode="block" (default: 800; clamped to channels.discord.textChunkLimit).',
  },
  "streaming.preview.chunk.breakPreference": {
    label: "Discord Draft Chunk Break Preference",
    help: "Preferred breakpoints for Discord draft chunks (paragraph | newline | sentence). Default: paragraph.",
  },
  "retry.attempts": {
    label: "Discord Retry Attempts",
    help: "Max retry attempts for outbound Discord API calls (default: 3).",
  },
  "retry.minDelayMs": {
    label: "Discord Retry Min Delay (ms)",
    help: "Minimum retry delay in ms for Discord outbound calls.",
  },
  "retry.maxDelayMs": {
    label: "Discord Retry Max Delay (ms)",
    help: "Maximum retry delay cap in ms for Discord outbound calls.",
  },
  "retry.jitter": {
    label: "Discord Retry Jitter",
    help: "Jitter factor (0-1) applied to Discord retry delays.",
  },
  maxLinesPerMessage: {
    label: "Discord Max Lines Per Message",
    help: "Soft max line count per Discord message (default: 17).",
  },
  "inboundWorker.runTimeoutMs": {
    label: "Discord Inbound Worker Timeout (ms)",
    help: "Optional queued Discord inbound worker timeout in ms. This is separate from Carbon listener timeouts; defaults to 1800000 and can be disabled with 0. Set per account via channels.discord.accounts.<id>.inboundWorker.runTimeoutMs.",
  },
  "eventQueue.listenerTimeout": {
    label: "Discord EventQueue Listener Timeout (ms)",
    help: "Canonical Discord listener timeout control in ms for gateway normalization/enqueue handlers. Default is 120000 in OpenClaw; set per account via channels.discord.accounts.<id>.eventQueue.listenerTimeout.",
  },
  "eventQueue.maxQueueSize": {
    label: "Discord EventQueue Max Queue Size",
    help: "Optional Discord EventQueue capacity override (max queued events before backpressure). Set per account via channels.discord.accounts.<id>.eventQueue.maxQueueSize.",
  },
  "eventQueue.maxConcurrency": {
    label: "Discord EventQueue Max Concurrency",
    help: "Optional Discord EventQueue concurrency override (max concurrent handler executions). Set per account via channels.discord.accounts.<id>.eventQueue.maxConcurrency.",
  },
  "threadBindings.enabled": {
    label: "Discord Thread Binding Enabled",
    help: "Enable Discord thread binding features (/focus, bound-thread routing/delivery, and thread-bound subagent sessions). Overrides session.threadBindings.enabled when set.",
  },
  "threadBindings.idleHours": {
    label: "Discord Thread Binding Idle Timeout (hours)",
    help: "Inactivity window in hours for Discord thread-bound sessions (/focus and spawned thread sessions). Set 0 to disable idle auto-unfocus (default: 24). Overrides session.threadBindings.idleHours when set.",
  },
  "threadBindings.maxAgeHours": {
    label: "Discord Thread Binding Max Age (hours)",
    help: "Optional hard max age in hours for Discord thread-bound sessions. Set 0 to disable hard cap (default: 0). Overrides session.threadBindings.maxAgeHours when set.",
  },
  "threadBindings.spawnSubagentSessions": {
    label: "Discord Thread-Bound Subagent Spawn",
    help: "Allow subagent spawns with thread=true to auto-create and bind Discord threads (default: false; opt-in). Set true to enable thread-bound subagent spawns for this account/channel.",
  },
  "threadBindings.spawnAcpSessions": {
    label: "Discord Thread-Bound ACP Spawn",
    help: "Allow /acp spawn to auto-create and bind Discord threads for ACP sessions (default: false; opt-in). Set true to enable thread-bound ACP spawns for this account/channel.",
  },
  "ui.components.accentColor": {
    label: "Discord Component Accent Color",
    help: "Accent color for Discord component containers (hex). Set per account via channels.discord.accounts.<id>.ui.components.accentColor.",
  },
  "intents.presence": {
    label: "Discord Presence Intent",
    help: "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.",
  },
  "intents.guildMembers": {
    label: "Discord Guild Members Intent",
    help: "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.",
  },
  "voice.enabled": {
    label: "Discord Voice Enabled",
    help: "Enable Discord voice channel conversations (default: true). Omit channels.discord.voice to keep voice support disabled for the account.",
  },
  "voice.autoJoin": {
    label: "Discord Voice Auto-Join",
    help: "Voice channels to auto-join on startup (list of guildId/channelId entries).",
  },
  "voice.daveEncryption": {
    label: "Discord Voice DAVE Encryption",
    help: "Toggle DAVE end-to-end encryption for Discord voice joins (default: true in @discordjs/voice; Discord may require this).",
  },
  "voice.decryptionFailureTolerance": {
    label: "Discord Voice Decrypt Failure Tolerance",
    help: "Consecutive decrypt failures before DAVE attempts session recovery (passed to @discordjs/voice; default: 24).",
  },
  "voice.tts": {
    label: "Discord Voice Text-to-Speech",
    help: "Optional TTS overrides for Discord voice playback (merged with messages.tts).",
  },
  "pluralkit.enabled": {
    label: "Discord PluralKit Enabled",
    help: "Resolve PluralKit proxied messages and treat system members as distinct senders.",
  },
  "pluralkit.token": {
    label: "Discord PluralKit Token",
    help: "Optional PluralKit token for resolving private systems or members.",
  },
  activity: {
    label: "Discord Presence Activity",
    help: "Discord presence activity text (defaults to custom status).",
  },
  status: {
    label: "Discord Presence Status",
    help: "Discord presence status (online, dnd, idle, invisible).",
  },
  "autoPresence.enabled": {
    label: "Discord Auto Presence Enabled",
    help: "Enable automatic Discord bot presence updates based on runtime/model availability signals. When enabled: healthy=>online, degraded/unknown=>idle, exhausted/unavailable=>dnd.",
  },
  "autoPresence.intervalMs": {
    label: "Discord Auto Presence Check Interval (ms)",
    help: "How often to evaluate Discord auto-presence state in milliseconds (default: 30000).",
  },
  "autoPresence.minUpdateIntervalMs": {
    label: "Discord Auto Presence Min Update Interval (ms)",
    help: "Minimum time between actual Discord presence update calls in milliseconds (default: 15000). Prevents status spam on noisy state changes.",
  },
  "autoPresence.healthyText": {
    label: "Discord Auto Presence Healthy Text",
    help: "Optional custom status text while runtime is healthy (online). If omitted, falls back to static channels.discord.activity when set.",
  },
  "autoPresence.degradedText": {
    label: "Discord Auto Presence Degraded Text",
    help: "Optional custom status text while runtime/model availability is degraded or unknown (idle).",
  },
  "autoPresence.exhaustedText": {
    label: "Discord Auto Presence Exhausted Text",
    help: "Optional custom status text while runtime detects exhausted/unavailable model quota (dnd). Supports {reason} template placeholder.",
  },
  activityType: {
    label: "Discord Presence Activity Type",
    help: "Discord presence activity type (0=Playing,1=Streaming,2=Listening,3=Watching,4=Custom,5=Competing).",
  },
  activityUrl: {
    label: "Discord Presence Activity URL",
    help: "Discord presence streaming URL (required for activityType=1).",
  },
  allowBots: {
    label: "Discord Allow Bot Messages",
    help: 'Allow bot-authored messages to trigger Discord replies (default: false). Set "mentions" to only accept bot messages that mention the bot.',
  },
  token: {
    label: "Discord Bot Token",
    help: "Discord bot token used for gateway and REST API authentication for this provider account. Keep this secret out of committed config and rotate immediately after any leak.",
    sensitive: true,
  },
} satisfies Record<string, ChannelConfigUiHint>;
