import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Discord helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const discordChannelConfigUiHints = {
  "": {
    label: "Discord",
    help: "Discord channel provider configuration for bot auth, retry policy, streaming, thread bindings, and optional voice capabilities. Keep privileged intents and advanced features disabled unless needed.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Discord",
    dmPolicy: { channelKey: "discord" },
    configWrites: true,
    mentionPatterns: {
      targetDescription: "Discord channel IDs",
      policyNote: "Native Discord @mentions still trigger even when regex patterns are denied.",
      denyNote: "Native @mentions still trigger.",
    },
  }),
  proxy: {
    label: "Discord Proxy URL",
    help: "Proxy URL for Discord gateway + API requests (app-id lookup and allowlist resolution). Set per account via channels.discord.accounts.<id>.proxy.",
  },
  ...createChannelConfigUiHints({ channelLabel: "Discord", nativeCommands: true }),
  streaming: {
    label: "Discord Streaming Mode",
    help: 'Unified Discord stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery. Legacy boolean/streamMode keys are auto-mapped.',
  },
  "streaming.mode": {
    label: "Discord Streaming Mode",
    help: 'Canonical Discord preview mode: "off" | "partial" | "block" | "progress".',
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
  "streaming.preview.toolProgress": {
    label: "Discord Draft Tool Progress",
    help: "Show tool/progress activity in the live draft preview message (default: true). Set false to hide interim tool updates while the draft preview stays active.",
  },
  "streaming.preview.commandText": {
    label: "Discord Draft Command Text",
    help: 'Command/exec detail in preview tool-progress lines: "raw" preserves released behavior; "status" shows only the tool label.',
  },
  ...createChannelConfigUiHints({
    channelLabel: "Discord",
    progress: { includeCommentary: true },
  }),
  maxLinesPerMessage: {
    label: "Discord Max Lines Per Message",
    help: "Soft max line count per Discord message (default: 17).",
  },
  suppressEmbeds: {
    label: "Discord Suppress Link Embeds",
    help: "Suppress Discord-generated link embeds on outbound messages by default. Explicit embeds still send normally. Default: true.",
  },
  "thread.inheritParent": {
    label: "Discord Thread Parent Inheritance",
    help: "If true, Discord thread sessions inherit the parent channel transcript (default: false).",
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
  "threadBindings.spawnSessions": {
    label: "Discord Thread-Bound Session Spawn",
    help: "Allow sessions_spawn(thread=true) and ACP thread spawns to auto-create and bind Discord threads (default: true). Set false to disable for this account/channel.",
  },
  "threadBindings.defaultSpawnContext": {
    label: "Discord Thread Spawn Context",
    help: 'Default native subagent context for thread-bound spawns. "fork" starts from the requester transcript; "isolated" starts clean. Default: "fork".',
  },
  subagentProgress: {
    label: "Discord Subagent Progress",
    help: "Show active subagent count reactions and typing on the source message. Default: false.",
  },
  "ui.components.accentColor": {
    label: "Discord Component Accent Color",
    help: "Accent color for Discord component containers (hex). Set per account via channels.discord.accounts.<id>.ui.components.accentColor.",
  },
  "agentComponents.ttlMs": {
    label: "Discord Component TTL (ms)",
    help: "How long sent Discord component callbacks remain registered. Default is 1800000 (30 minutes); maximum is 86400000 (24 hours).",
  },
  "intents.presence": {
    label: "Discord Presence Intent",
    help: "Enable the Guild Presences privileged intent. Must also be enabled in the Discord Developer Portal. Allows tracking user activities (e.g. Spotify). Default: false.",
  },
  "intents.guildMembers": {
    label: "Discord Guild Members Intent",
    help: "Enable the Guild Members privileged intent. Must also be enabled in the Discord Developer Portal. Default: false.",
  },
  "intents.voiceStates": {
    label: "Discord Voice States Intent",
    help: "Enable the Guild Voice States intent. Defaults to the effective Discord voice setting; set true only for Discord voice channel conversations.",
  },
  "voice.enabled": {
    label: "Discord Voice Enabled",
    help: "Enable Discord voice channel conversations. Text-only Discord configs leave voice off by default; set true to enable /vc commands and the Guild Voice States intent.",
  },
  "voice.model": {
    label: "Discord Voice Model",
    help: "Optional LLM model override for Discord voice channel responses and realtime agent consults (for example openai/gpt-5.6-sol). Leave unset to inherit the routed agent model.",
  },
  "voice.mode": {
    label: "Discord Voice Mode",
    help: "Conversation mode: agent-proxy (default) uses realtime voice as the microphone/speaker for the routed OpenClaw agent, stt-tts uses batch speech-to-text plus TTS, and bidi lets the realtime provider converse directly with the OpenClaw consult tool.",
  },
  "voice.agentSession": {
    label: "Discord Voice Agent Session",
    help: 'Controls which OpenClaw conversation receives voice turns. Leave unset for the voice channel session, or set mode="target" with a Discord target such as channel:123 to make voice an extension of an existing text channel session.',
  },
  "voice.agentSession.target": {
    label: "Discord Voice Agent Session Target",
    help: 'Discord target used when voice.agentSession.mode="target", for example channel:123.',
  },
  "voice.followUsersEnabled": {
    label: "Discord Voice Follow Users Enabled",
    help: "Toggle Discord voice follow-users behavior without removing the saved voice.followUsers list. Defaults to true when followUsers is configured.",
  },
  "voice.followUsers": {
    label: "Discord Voice Follow Users",
    help: "Discord user IDs to follow into voice channels. The bot joins when a followed user joins or moves, and leaves when that user disconnects.",
  },
  "voice.realtime.provider": {
    label: "Discord Realtime Provider",
    help: "Realtime voice provider for agent-proxy or bidi Discord voice modes, such as openai.",
  },
  "voice.realtime.model": {
    label: "Discord Realtime Model",
    help: "Provider realtime session model, such as gpt-realtime-2.1. This is separate from voice.model, which remains the OpenClaw agent brain model.",
  },
  "voice.realtime.speakerVoice": {
    label: "Discord Realtime Speaker Voice",
    help: "Provider realtime output voice name, such as cedar.",
  },
  "voice.realtime.speakerVoiceId": {
    label: "Discord Realtime Speaker Voice ID",
    help: "Provider realtime output voice id.",
  },
  "voice.realtime.toolPolicy": {
    label: "Discord Realtime Tool Policy",
    help: "Tool policy for the OpenClaw agent consult tool in realtime voice modes: safe-read-only, owner, or none. Default is owner for agent-proxy and safe-read-only for bidi.",
  },
  "voice.realtime.consultPolicy": {
    label: "Discord Realtime Consult Policy",
    help: "Use always to strongly prefer the OpenClaw agent brain for substantive realtime turns. agent-proxy defaults to always.",
  },
  "voice.realtime.requireWakeName": {
    label: "Discord Realtime Require Wake Name",
    help: "Control OpenAI agent-proxy wake-name gating. Unset listens naturally with one human and requires a wake name with two or more; true always requires one and false never does.",
  },
  "voice.realtime.wakeNames": {
    label: "Discord Realtime Wake Names",
    help: "One- or two-word activation names used whenever OpenAI agent-proxy Discord realtime voice has an active wake-name gate.",
  },
  "voice.realtime.bootstrapContextFiles": {
    label: "Discord Realtime Bootstrap Context Files",
    help: "Agent profile bootstrap files included in realtime provider instructions for direct voice identity/persona grounding. Defaults to IDENTITY.md, USER.md, and SOUL.md; set [] to disable.",
  },
  "voice.realtime.bargeIn": {
    label: "Discord Realtime Barge-In",
    help: "Allow Discord speaker-start events to interrupt active realtime playback. Set true to keep manual interruption when provider input-audio interruption is disabled for echo control.",
  },
  "voice.realtime.minBargeInAudioEndMs": {
    label: "Discord Realtime Minimum Barge-In Audio (ms)",
    help: "Minimum assistant playback duration before a Discord barge-in truncates realtime audio. Default: 250; set 0 for immediate interruption in low-echo rooms.",
  },
  "voice.realtime.providers": {
    label: "Discord Realtime Provider Settings",
    help: "Provider-specific realtime voice settings keyed by provider id.",
    advanced: true,
  },
  "voice.autoJoin": {
    label: "Discord Voice Auto-Join",
    help: "Voice channels to auto-join on startup (list of guildId/channelId entries).",
  },
  "voice.allowedChannels": {
    label: "Discord Voice Allowed Channels",
    help: "Optional voice channel residency allowlist. When set, /vc join, auto-join, and bot voice-state moves are restricted to these guildId/channelId entries. Leave unset to allow any voice channel.",
  },
  "voice.daveEncryption": {
    label: "Discord Voice DAVE Encryption",
    help: "Toggle DAVE end-to-end encryption for Discord voice joins (default: true in @discordjs/voice; Discord may require this).",
  },
  "voice.decryptionFailureTolerance": {
    label: "Discord Voice Decrypt Failure Tolerance",
    help: "Consecutive decrypt failures before DAVE attempts session recovery (passed to @discordjs/voice; default: 24).",
  },
  "voice.connectTimeoutMs": {
    label: "Discord Voice Connect Timeout (ms)",
    help: "Initial @discordjs/voice Ready wait before a join is treated as failed. Default: 30000.",
  },
  "voice.reconnectGraceMs": {
    label: "Discord Voice Reconnect Grace (ms)",
    help: "Grace period for a disconnected Discord voice session to enter Signalling or Connecting before OpenClaw destroys it. Default: 15000.",
  },
  "voice.captureSilenceGraceMs": {
    label: "Discord Voice Capture Silence Grace (ms)",
    help: "Silence window after Discord reports a speaker ended before OpenClaw finalizes the audio segment for transcription. Default: 2000.",
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
  "guilds.*.presenceEvents": {
    label: "Discord Online Presence Events",
    help: "Route selected human offline-to-online transitions into the configured guild channel as agent system events. Requires the Guild Presences privileged intent and an enabled agent heartbeat.",
  },
  "guilds.*.presenceEvents.enabled": {
    label: "Discord Online Presence Events Enabled",
    help: "Enable online-presence agent wakes for this guild. Defaults to true when presenceEvents is configured.",
  },
  "guilds.*.presenceEvents.channelId": {
    label: "Discord Online Presence Target Channel",
    help: "Numeric Discord channel ID whose routed agent session receives online-presence events and greeting delivery.",
  },
  "guilds.*.presenceEvents.users": {
    label: "Discord Online Presence User IDs",
    help: "Optional immutable Discord user ID allowlist. Omit to include all human members in the guild.",
  },
  "guilds.*.presenceEvents.reconnectSuppressSeconds": {
    label: "Discord Online Presence Reconnect Suppression",
    help: "Suppress online-presence events for this many seconds after a new Gateway session while guild presence state is rebuilt. Resumed sessions are unaffected. 0 disables. Default: 300.",
  },
  "guilds.*.presenceEvents.burstLimit": {
    label: "Discord Online Presence Burst Limit",
    help: "Maximum successfully queued online-presence events for this guild per burst window; the rest are suppressed and logged once. Default: 8.",
  },
  "guilds.*.presenceEvents.burstWindowSeconds": {
    label: "Discord Online Presence Burst Window",
    help: "Sliding window in seconds used for burst detection. Default: 60.",
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
  botLoopProtection: {
    label: "Discord Bot Loop Protection",
    help: "Sliding-window guard for bot-to-bot Discord loops. Default is enabled whenever allowBots lets bot-authored messages reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Discord Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions", and false when bot messages are ignored.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Discord Bot Pair Events Per Window",
    help: "Maximum messages a single Discord bot pair may exchange in the configured window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Discord Bot Loop Window Seconds",
    help: "Sliding window length in seconds for Discord bot-pair loop budgets. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Discord Bot Loop Cooldown Seconds",
    help: "Seconds to suppress a Discord bot pair after it exceeds the loop budget. Default: 60.",
  },
  mentionAliases: {
    label: "Discord Mention Aliases",
    help: "Map outbound @handle text to stable Discord user IDs before sending. Set per account via channels.discord.accounts.<id>.mentionAliases.",
  },
  token: {
    label: "Discord Bot Token",
    help: "Discord bot token used for gateway and REST API authentication for this provider account. Keep this secret out of committed config and rotate immediately after any leak.",
    sensitive: true,
  },
  applicationId: {
    label: "Discord Application ID",
    help: "Optional Discord application/client ID. Set this when hosted environments cannot reach Discord's application lookup endpoint during startup.",
  },
  activities: {
    label: "Discord Activities",
    help: "Enable Discord Activity widgets for this account. Routes, the agent tool, and the launch handler remain disabled when this block is absent.",
  },
  "activities.clientSecret": {
    label: "Discord Activities Client Secret",
    help: "OAuth2 client secret for the Discord application. DISCORD_CLIENT_SECRET is used when this field is unset.",
    sensitive: true,
  },
  "activities.applicationId": {
    label: "Discord Activities Application ID",
    help: "Optional Activity application ID. Defaults to the bot application ID learned at gateway startup.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
