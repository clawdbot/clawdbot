// Defines user-facing config field help text for docs and UI surfaces.
export const AGENT_FIELD_HELP: Record<string, string> = {
  ui: "UI presentation settings for accenting and assistant identity shown in control surfaces. Use this for branding and readability customization without changing runtime behavior.",
  "ui.seamColor":
    "Primary accent color used by UI surfaces for emphasis, badges, and visual identity cues. Use high-contrast values that remain readable across light/dark themes.",
  "ui.assistant":
    "Assistant display identity settings for name and avatar shown in UI surfaces. Keep these values aligned with your operator-facing persona and support expectations.",
  "ui.assistant.name":
    "Display name shown for the assistant in UI views, chat chrome, and status contexts. Keep this stable so operators can reliably identify which assistant persona is active.",
  "ui.assistant.avatar":
    "Assistant avatar image source used in UI surfaces (URL, path, or data URI depending on runtime support). Use trusted assets and consistent branding dimensions for clean rendering.",
  tui: "Terminal UI display settings. Use this section for terminal-only presentation preferences without changing Gateway or other UI behavior.",
  "tui.footer":
    "Terminal UI footer display settings. Keep optional context compact so session, model, goal, and token information stay readable.",
  plugins:
    "Plugin system controls for enabling extensions, constraining load scope, configuring entries, and tracking installs. Keep plugin policy explicit and least-privilege in production environments.",
  "plugins.enabled":
    "Enable or disable plugin/extension loading globally during startup and config reload (default: true). Keep enabled only when extension capabilities are required by your deployment.",
  "plugins.allow":
    "Optional allowlist of plugin IDs; when set, only listed plugins are eligible to load. Configured bundled chat channels can still activate their bundled plugin when the channel is explicitly enabled in config. Use this to enforce approved extension inventories in controlled environments.",
  "plugins.deny":
    "Optional denylist of plugin IDs that are blocked even if allowlists or paths include them. Use deny rules for emergency rollback and hard blocks on risky plugins.",
  "plugins.load":
    "Plugin loader configuration group for specifying filesystem paths where plugins are discovered. Keep load paths explicit and reviewed to avoid accidental untrusted extension loading.",
  "plugins.load.paths":
    "Additional plugin files or directories scanned by the loader beyond built-in defaults. Use dedicated extension directories and avoid broad paths with unrelated executable content.",
  "plugins.slots":
    "Selects which plugins own exclusive runtime slots such as memory so only one plugin provides that capability. Use explicit slot ownership to avoid overlapping providers with conflicting behavior.",
  "plugins.slots.memory":
    'Select the active memory plugin by id, or "none" to disable memory plugins.',
  "plugins.slots.contextEngine":
    "Selects the active context engine plugin by id so one plugin provides context orchestration behavior.",
  "plugins.entries":
    "Per-plugin settings keyed by plugin ID including enablement and plugin-specific runtime configuration payloads. Use this for scoped plugin tuning without changing global loader policy.",
  "plugins.entries.*.enabled":
    "Per-plugin enablement override for a specific entry, applied on top of global plugin policy (restart required). Use this to stage plugin rollout gradually across environments.",
  "plugins.entries.*.hooks":
    "Per-plugin typed hook policy controls for core-enforced safety gates. Use this to constrain high-impact hook categories without disabling the entire plugin.",
  "plugins.entries.*.hooks.allowPromptInjection":
    "Controls whether this plugin may mutate prompts through typed hooks. Set false to block `before_prompt_build`.",
  "plugins.entries.*.hooks.allowConversationAccess":
    "Controls whether this plugin may read raw conversation content from typed hooks such as `before_agent_run`, `before_model_resolve`, `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`, and `agent_end`. Non-bundled plugins must opt in explicitly.",
  "plugins.entries.*.hooks.timeoutMs":
    "Default timeout in milliseconds for this plugin's typed hooks, capped at 600000. Use this to bound slow plugin hooks without changing plugin code; per-hook values in hooks.timeouts take precedence.",
  "plugins.entries.*.hooks.timeouts":
    "Per-hook timeout overrides in milliseconds keyed by typed hook name, capped at 600000. Use narrow overrides for known slow hooks such as before_prompt_build or agent_end instead of raising every hook timeout.",
  "plugins.entries.*.subagent":
    "Per-plugin subagent runtime controls for model override trust and allowlists. Keep this unset unless a plugin must explicitly steer subagent model selection.",
  "plugins.entries.*.subagent.allowModelOverride":
    "Explicitly allows this plugin to request provider/model overrides in background subagent runs. Keep false unless the plugin is trusted to steer model selection.",
  "plugins.entries.*.subagent.allowedModels":
    'Allowed override targets for trusted plugin subagent runs as canonical "provider/model" refs. Use "*" only when you intentionally allow any model.',
  "plugins.entries.*.llm":
    "Per-plugin api.runtime.llm.complete controls for model and agent override trust. Keep this unset unless a plugin must explicitly steer host-owned completion calls.",
  "plugins.entries.*.llm.allowModelOverride":
    "Explicitly allows this plugin to request model overrides in api.runtime.llm.complete. Keep false unless the plugin is trusted to steer model selection.",
  "plugins.entries.*.llm.allowedModels":
    'Allowed override targets for trusted plugin LLM completions as canonical "provider/model" refs. Use "*" only when you intentionally allow any model.',
  "plugins.entries.*.llm.allowAgentIdOverride":
    "Explicitly allows this plugin to request api.runtime.llm.complete against a non-default agent id. Keep false unless the plugin is trusted for cross-agent model access.",
  "plugins.entries.*.apiKey":
    "Optional API key field consumed by plugins that accept direct key configuration in entry settings. Use secret/env substitution and avoid committing real credentials into config files.",
  "plugins.entries.*.env":
    "Per-plugin environment variable map injected for that plugin runtime context only. Use this to scope provider credentials to one plugin instead of sharing global process environment.",
  "plugins.entries.*.config":
    "Plugin-defined configuration payload interpreted by that plugin's own schema and validation rules. Use only documented fields from the plugin to prevent ignored or invalid settings.",
  "agents.entries.*.identity.avatar":
    "Agent avatar (workspace-relative path, http(s) URL, or data URI).",
  "agents.defaults.model.primary": "Primary model (provider/model).",
  "agents.defaults.model.fallbacks":
    "Ordered fallback models (provider/model). Used when the primary model fails.",
  "agents.defaults.utilityModel":
    "Optional lower-cost model (provider/model or alias) for short internal tasks such as generated titles and progress narration. Unset derives the primary provider's declared small model when available (otherwise the primary model); set to an empty string to disable utility routing.",
  "agents.entries.*.utilityModel":
    "Optional per-agent utility model override for short internal tasks. Overrides agents.defaults.utilityModel.",
  "agents.entries.*.models": "Per-agent model catalog overrides keyed by full provider/model IDs.",
  "agents.entries.*.modelPolicy":
    "Per-agent model override policy. An explicit allow list replaces the default policy for this agent.",
  "agents.entries.*.modelPolicy.allow":
    'Allowed model override refs for this agent. Accepts aliases, full "provider/model" refs, and trailing prefix wildcards such as "provider/*" or "provider/namespace/*"; empty permits any model.',
  "agents.entries.*.models.*.agentRuntime":
    "Optional per-model runtime policy for this agent. Use this for agent-specific model exceptions instead of setting a whole-agent runtime.",
  "agents.entries.*.models.*.agentRuntime.id":
    'Per-agent model runtime id: "openclaw", "auto", a registered plugin harness id such as "codex", or a supported CLI backend alias such as "claude-cli".',
  "agents.defaults.imageModel.primary":
    "Optional image model (provider/model) used when the primary model lacks image input.",
  "agents.defaults.imageModel.fallbacks": "Ordered fallback image models (provider/model).",
  "agents.defaults.mediaModels.image.primary":
    "Optional image-generation model (provider/model) used by the shared image generation capability.",
  "agents.defaults.mediaModels.image.fallbacks":
    "Ordered fallback image-generation models (provider/model).",
  "agents.defaults.mediaModels.image.timeoutMs":
    "Default provider request timeout in milliseconds for image_generate calls. Per-call timeoutMs overrides this.",
  "agents.defaults.mediaModels.video.primary":
    "Optional video-generation model (provider/model) used by the shared video generation capability.",
  "agents.defaults.mediaModels.video.timeoutMs":
    "Default provider request timeout in milliseconds for video_generate calls. Per-call timeoutMs overrides this, and this value overrides provider-authored defaults.",
  "agents.defaults.mediaModels.video.fallbacks":
    "Ordered fallback video-generation models (provider/model).",
  "agents.defaults.mediaModels.music.primary":
    "Optional music-generation model (provider/model) used by the shared music generation capability.",
  "agents.defaults.mediaModels.music.fallbacks":
    "Ordered fallback music-generation models (provider/model).",
  "agents.defaults.voiceModel.primary":
    "Optional voice model (provider/model) used by speech, transcription, and realtime voice capabilities.",
  "agents.defaults.voiceModel.fallbacks": "Ordered fallback voice models (provider/model).",
  "agents.defaults.voiceModel.timeoutMs":
    "Default provider request timeout in milliseconds for voice model operations when the caller supports timeouts.",
  "agents.defaults.pdfModel.primary":
    "Optional PDF model (provider/model) for the PDF analysis tool. Defaults to imageModel, then session model.",
  "agents.defaults.pdfModel.fallbacks": "Ordered fallback PDF models (provider/model).",
  "agents.defaults.pdfMaxMb": "Maximum PDF file size in megabytes for the PDF tool (default: 10).",
  "agents.defaults.pdfMaxPages":
    "Maximum number of PDF pages to process for the PDF tool (default: 20).",
  "agents.defaults.imageMaxDimensionPx":
    "Max image side length in pixels when sanitizing transcript/tool-result image payloads (default: 1200).",
  "agents.defaults.imageQuality":
    'Image-tool media compression preference: "auto" adapts to provider/model limits and image count, "efficient" saves tokens and bytes, "balanced" keeps the current middle ground, and "high" preserves more detail for screenshots and document images.',
  "agents.defaults.compaction":
    "Compaction behavior for when context nears token limits, including strategy and pre-compaction memory flush behavior. Use this when long-running sessions need stable continuity under tight context windows.",
  "agents.defaults.compaction.mode":
    'Compaction strategy mode: "default" uses baseline behavior, while "safeguard" applies stricter guardrails to preserve recent context. Keep "default" unless you observe aggressive history loss near limit boundaries.',
  "agents.defaults.compaction.provider":
    "Id of a registered compaction provider plugin used for summarization. When set and the provider is registered, its summarize() method is called instead of the built-in summarizeInStages pipeline. Falls back to built-in on provider failure. Leave unset to use the default built-in summarization.",
  "agents.defaults.compaction.thinkingLevel":
    'Optional thinking level used only for embedded OpenClaw compaction summaries: "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", or "ultra". It overrides the session level and is clamped to the actual compaction model/runtime; leave unset to inherit the session level. Native Codex app-server compaction ignores this setting because its compact request has no per-operation thinking override, and OpenClaw logs a warning.',
  "agents.defaults.compaction.keepRecentTokens":
    "Minimum token budget preserved from the most recent conversation window during compaction. Use higher values to protect immediate context continuity and lower values to keep more long-tail history.",
  "agents.defaults.compaction.identifierPolicy":
    'Identifier-preservation policy for compaction summaries: "strict" prepends built-in opaque-identifier retention guidance (default), while "off" disables this prefix.',
  "agents.defaults.compaction.recentTurnsPreserve":
    "Number of most recent user/assistant turns kept verbatim outside safeguard summarization (default: 3). Raise this to preserve exact recent dialogue context, or lower it to maximize compaction savings.",
  "agents.defaults.compaction.qualityGuard":
    "Quality-audit retry settings for safeguard compaction summaries. Safeguard mode enables this by default; set enabled: false to skip summary audits and regeneration.",
  "agents.defaults.compaction.qualityGuard.enabled":
    "Enables summary quality audits and regeneration retries for safeguard compaction. Default: true in safeguard mode.",
  "agents.defaults.compaction.qualityGuard.maxRetries":
    "Maximum number of regeneration retries after a failed safeguard summary quality audit. Use small values to bound extra latency and token cost.",
  "agents.defaults.compaction.midTurnPrecheck":
    "Optional embedded OpenClaw tool-loop precheck that detects context pressure after a tool result is appended and before the next model call. When enabled, OpenClaw reuses existing precheck recovery to truncate tool results or compact before retrying.",
  "agents.defaults.compaction.midTurnPrecheck.enabled":
    "Enable structured mid-turn context pressure checks for embedded OpenClaw tool loops. Default: false. Keep disabled unless long tool-heavy sessions hit context overflow before normal turn-end compaction can run.",
  "agents.defaults.compaction.postIndexSync":
    'Controls post-compaction session memory reindex mode: "off", "async", or "await" (default: "async"). Use "await" for strongest freshness, "async" for lower compaction latency, and "off" only when session-memory sync is handled elsewhere.',
  "agents.defaults.compaction.postCompactionSections":
    'Opt-in AGENTS.md H2/H3 section names re-injected after compaction. Leave unset or set [] to disable reinjection. Explicitly set ["Session Startup", "Red Lines"] to enable the legacy default pair.',
  "agents.defaults.compaction.timeoutSeconds":
    "Maximum time in seconds allowed for a single compaction operation before it is aborted (default: 180). Increase this for very large sessions that need more time to summarize, or decrease it to fail faster on unresponsive models.",
  "agents.defaults.compaction.model":
    "Optional provider/model or configured bare alias used only for compaction summarization. Bare aliases resolve before dispatch; a configured literal model ID wins if it collides with an alias. Leave unset to keep using the primary agent model.",
  "agents.defaults.compaction.truncateAfterCompaction":
    "When enabled, rotates the active session transcript after compaction so future turns load only the summary and unsummarized tail while the previous full transcript remains archived. Prevents unbounded active transcript growth in long-running sessions. Default: false.",
  "agents.defaults.compaction.maxActiveTranscriptBytes":
    'Triggers normal local compaction when the active session transcript reaches this size (bytes or strings like "20mb"). Requires truncateAfterCompaction so successful compaction can rotate to a smaller successor transcript; set to 0 or leave unset to disable. This never splits raw transcript bytes.',
  "agents.defaults.compaction.notifyUser":
    "When enabled, sends brief context-maintenance notices to the user: when compaction starts and completes (for example, '🧹 Compacting context...' and '🧹 Compaction complete'), and when a pre-compaction memory flush is exhausted so the reply continues in a degraded state (for example, '⚠️ Memory maintenance temporarily failed; continuing your reply.'). Disabled by default to keep context maintenance silent and non-intrusive.",
  "agents.defaults.compaction.memoryFlush":
    "Pre-compaction memory flush settings that run an agentic memory write before heavy compaction. Keep enabled for long sessions so salient context is persisted before aggressive trimming.",
  "agents.defaults.compaction.memoryFlush.enabled":
    "Enables pre-compaction memory flush before the runtime performs stronger history reduction near token limits. Keep enabled unless you intentionally disable memory side effects in constrained environments.",
  "agents.defaults.compaction.memoryFlush.model":
    "Optional provider/model override used only for pre-compaction memory flush turns. Set this to a local model such as ollama/qwen3:8b when durable memory extraction should avoid the active session's paid model. The override is exact and does not inherit the active model fallback chain.",
  "agents.defaults.compaction.memoryFlush.softThresholdTokens":
    "Threshold distance to compaction (in tokens) that triggers pre-compaction memory flush execution. Use earlier thresholds for safer persistence, or tighter thresholds for lower flush frequency.",
  "agents.defaults.compaction.memoryFlush.forceFlushTranscriptBytes":
    'Forces pre-compaction memory flush when active transcript size reaches this threshold (bytes or strings like "2mb"). Use this to prevent long-session hangs even when token counters are stale; set to 0 to disable.',
  "agents.defaults.embeddedAgent":
    "Embedded OpenClaw runner hardening controls for how workspace-local agent settings are trusted and applied in OpenClaw sessions.",
  "agents.defaults.embeddedAgent.projectSettingsPolicy":
    'How embedded OpenClaw handles workspace-local `.openclaw/settings.json`: "sanitize" (default) strips shellPath/shellCommandPrefix, "ignore" disables project settings entirely, and "trusted" applies project settings as-is.',
  "agents.defaults.embeddedAgent.executionContract":
    'Embedded OpenClaw execution contract: "default" keeps the standard runner behavior, while "strict-agentic" enables structured plan tracking and non-visible turn recovery for supported OpenAI/OpenAI Codex GPT-5-family runs.',
  "agents.entries.*.embeddedAgent":
    "Optional per-agent embedded OpenClaw overrides. Use this to opt specific agents into stricter GPT-5 execution behavior without changing the global default.",
  "agents.entries.*.embeddedAgent.executionContract":
    'Optional per-agent embedded OpenClaw execution contract override. Set "strict-agentic" to enable structured plan tracking and non-visible turn recovery for that agent on supported OpenAI/OpenAI Codex GPT-5-family runs, or "default" to inherit the standard runner behavior.',
  "agents.defaults.humanDelay.mode": 'Delay style for block replies ("off", "natural", "custom").',
  "agents.defaults.humanDelay.minMs": "Minimum delay in ms for custom humanDelay (default: 800).",
  "agents.defaults.humanDelay.maxMs": "Maximum delay in ms for custom humanDelay (default: 2500).",
  "agents.defaults.typingMode":
    'Controls when typing starts for agents: "never", "instant", "thinking", or "message". Per-agent typingMode overrides this default.',
  "agents.defaults.typingIntervalSeconds":
    "Controls typing-indicator keepalive cadence in seconds. Per-agent typingIntervalSeconds overrides this default.",
  "agents.entries.*.typingMode":
    "Overrides the default typing start policy for one agent without changing other agents.",
  "agents.entries.*.typingIntervalSeconds":
    "Overrides the default typing-indicator keepalive cadence for one agent. Use this when one agent needs a different refresh interval from the shared default.",
  commands:
    "Controls chat command surfaces, owner gating, and elevated command access behavior across providers. Keep defaults unless you need stricter operator controls or broader command availability.",
  "commands.native":
    "Registers native slash/menu commands with channels that support command registration (Discord, Slack, Telegram). Keep enabled for discoverability unless you intentionally run text-only command workflows.",
  "commands.nativeSkills":
    "Registers native skill commands so users can invoke skills directly from provider command menus where supported. Keep aligned with your skill policy so exposed commands match what operators expect.",
  "commands.text":
    "Enables text-command parsing in chat input in addition to native command surfaces where available. Keep this enabled for compatibility across channels that do not support native command registration.",
  "commands.bash":
    "Allow bash chat command (`!`; `/bash` alias) to run host shell commands (default: false; requires tools.elevated).",
  "commands.bashForegroundMs":
    "How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately).",
  "commands.config": "Allow /config chat command to read/write config on disk (default: false).",
  "commands.mcp":
    "Allow /mcp chat command to manage OpenClaw MCP server config under mcp.servers (default: false).",
  "commands.plugins":
    "Allow /plugins chat command to list discovered plugins and toggle plugin enablement in config (default: false).",
  "commands.debug": "Allow /debug chat command for runtime-only overrides (default: false).",
  "commands.restart": "Allow /restart and external SIGUSR1 restart requests (default: true).",
  "commands.ownerAllowFrom":
    "Explicit owner allowlist for owner-scoped commands. Use channel-native IDs (optionally prefixed like \"whatsapp:+15551234567\"). '*' is ignored.",
  "commands.allowFrom":
    "Defines elevated command allow rules by channel and sender for owner-level command surfaces. Use narrow provider-specific identities so privileged commands are not exposed to broad chat audiences.",
  mcp: "Global MCP server definitions managed by OpenClaw. Embedded OpenClaw and other runtime adapters can consume these servers without storing them inside runtime-owned project settings.",
  "mcp.servers":
    "Named MCP server definitions. OpenClaw stores them in its own config and runtime adapters decide which transports are supported at execution time.",
  "mcp.servers.*.codex":
    "OpenClaw projection metadata for Codex app-server threads only. It does not affect ACP sessions or generic Codex harness config. Omit this block to keep the server available to every Codex app-server agent with Codex's default MCP approval behavior.",
  "mcp.servers.*.toolFilter":
    "Per-server MCP tool selection. Use include to expose only selected MCP tool names, or exclude to hide selected MCP tool names. Entries accept exact names and simple '*' globs.",
  "mcp.servers.*.toolFilter.include":
    "Exact MCP tool names or simple '*' globs to expose from this server. When omitted, all server tools remain eligible unless excluded.",
  "mcp.servers.*.toolFilter.exclude":
    "Exact MCP tool names or simple '*' globs to hide from this server.",
  "mcp.servers.*.oauth.authProfileId":
    "Refresh-capable auth profile id used to inject the current bearer token into this remote MCP server. When set, OpenClaw resolves and refreshes the profile at runtime and does not project refresh material downstream.",
  "mcp.servers.*.codex.agents":
    "Optional non-empty OpenClaw agent ids that should receive this MCP server in Codex app-server thread config. Empty, blank, or invalid lists fail closed; when omitted, the server is projected for all Codex app-server agents.",
  "mcp.servers.*.codex.defaultToolsApprovalMode":
    'Optional Codex MCP tool approval mode for this server: "auto", "prompt", or "approve". Use only for MCP servers you intentionally trust.',
  "mcp.servers.*.codex.default_tools_approval_mode":
    "Codex-native spelling for the same per-server MCP tool approval mode. Prefer defaultToolsApprovalMode in OpenClaw config.",
};
