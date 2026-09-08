---
summary: "agents.entries overrides, multiAgent bindings, binding match fields, and access profiles"
read_when:
  - Overriding defaults for one agent
  - Routing a channel or account to a specific agent
  - Writing per-agent tool and sandbox access profiles
title: "Configuration — per-agent entries and multi-agent routing"
---

Per-agent overrides under `agents.entries` and the `multiAgent` bindings that decide which agent answers a message.

<a id="agentsentries-per-agent-overrides" />

## `agents.entries` (per-agent overrides)

Use `agents.entries.*.tts` to give an agent its own TTS provider, voice, model,
style, or auto-TTS mode. The agent block deep-merges over global
`tts`, so shared credentials can stay in one place while individual
agents override only the voice or provider fields they need. The active agent's
override applies to automatic spoken replies, `/tts audio`, `/tts status`, and
the `tts` agent tool. See [Text-to-speech](/tools/tts#per-agent-voice-overrides)
for provider examples and precedence.

```json5
{
  agents: {
    entries: {
      main: {
        name: "Main Agent",
        workspace: "~/.openclaw/workspace",
        agentDir: "~/.openclaw/agents/main/agent",
        model: "anthropic/claude-opus-4-6", // or { primary, fallbacks }
        utilityModel: "openai/gpt-5.4-mini",
        thinkingDefault: "high", // per-agent thinking level override
        reasoningDefault: "on", // per-agent reasoning visibility override
        fastModeDefault: false, // per-agent fast mode override
        params: { cacheRetention: "none" }, // overrides matching defaults.models params by key
        tts: {
          providers: {
            elevenlabs: { speakerVoiceId: "EXAVITQu4vr4xnSDxMaL" },
          },
        },
        skills: ["docs-search"], // replaces agents.defaults.skills when set
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
        groupChat: { mentionPatterns: ["@openclaw"] },
        sandbox: { mode: "off" },
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent", // persistent | oneshot
            cwd: "/workspace/openclaw",
          },
        },
        subagents: { allowAgents: ["*"] },
        tools: {
          profile: "coding",
          allow: ["browser"],
          deny: ["canvas"],
          elevated: { enabled: true },
        },
      },
    },
  },
}
```

- The `agents.entries` object key is the stable agent id.
- `cwd`: optional working directory for reply runs, separate from `workspace`. Overrides `agents.defaults.cwd`; see [Working directory](/gateway/config-agents/workspace-and-bootstrap#agents.defaults.cwd) for precedence and sandbox restrictions.
- `default` is retired. Exactly one configured agent resolves implicitly; multi-agent operations require a binding, surface `agentId` target, scoped session/store owner, or explicit `--agent`/request field.
- `model`: string form sets a strict per-agent primary with no model fallback; object form `{ primary }` is also strict unless you add `fallbacks`. Use `{ primary, fallbacks: [...] }` to opt that agent into fallback, or `{ primary, fallbacks: [] }` to make strict behavior explicit. Cron jobs that only override `primary` still inherit default fallbacks unless you set `fallbacks: []`.
- `utilityModel`: optional per-agent override for short internal tasks such as generated session and thread titles. Falls back to `agents.defaults.utilityModel`, then the effective session provider's declared small-model default. Dashboard titles retry once with the effective regular session model. An empty string skips the alternate utility route for this agent without disabling dashboard title generation.
- `params`: agent-wide stream params merged over shared and agent-specific per-model params. Use this for overrides like `cacheRetention`, `temperature`, or `maxTokens` that should apply across the agent's models.
- `tts`: optional per-agent text-to-speech overrides. The block deep-merges over `tts`, so keep shared provider credentials and fallback policy in `tts` and set only persona-specific values such as provider, voice, model, style, or auto mode here.
- `skills`: optional per-agent skill allowlist. If omitted, the agent inherits `agents.defaults.skills` when set; an explicit list replaces defaults instead of merging, and `[]` means no skills.
- `thinkingDefault`: optional per-agent default thinking level (`off | minimal | low | medium | high | xhigh | adaptive | max`). Overrides `agents.defaults.thinkingDefault` for this agent when no per-message or session override is set. The selected provider/model profile controls which values are valid; for Google Gemini, `adaptive` keeps provider-owned dynamic thinking (`thinkingLevel` omitted on Gemini 3/3.1, `thinkingBudget: -1` on Gemini 2.5).
- `reasoningDefault`: optional per-agent default reasoning visibility (`on | off | stream`). Overrides `agents.defaults.reasoningDefault` for this agent when no per-message or session reasoning override is set.
- `fastModeDefault`: optional per-agent default for fast mode (`"auto" | true | false`). Overrides `agents.defaults.fastModeDefault` for this agent when no per-message or session fast-mode override is set.
- `models`: optional per-agent model settings keyed by full `provider/model` ids. Use `models["provider/model"].params` for model-specific request settings and `models["provider/model"].agentRuntime` for runtime exceptions. `models["provider/model"].codeMode` accepts `true` or `false` and takes precedence over the agent's `tools.codeMode` activation, the shared model override, and the global default. Omit it to inherit; it does not affect Codex native Code Mode.
- `runtime`: optional per-agent runtime descriptor. Use `type: "acp"` with `runtime.acp` defaults (`agent`, `backend`, `mode`, `cwd`) when the agent should default to ACP harness sessions.
- `identity.avatar`: workspace-relative path, `http(s)` URL, or `data:` URI.
- Local workspace-relative `identity.avatar` image files are limited to 2 MB. `http(s)` URLs and `data:` URIs are not checked against the local file-size limit.
- `identity` derives defaults: `ackReaction` from `emoji`, `mentionPatterns` from `name`/`emoji`.
- `subagents.allowAgents`: allowlist of configured agent ids for explicit `sessions_spawn.agentId` targets (`["*"]` = any configured target; default: same agent only). Include the requester id when self-targeted `agentId` calls should be allowed. Stale entries whose agent config was deleted are rejected by `sessions_spawn` and omitted from `agents_list`; run `openclaw doctor --fix` to clean them up, or add a minimal `agents.entries.*` entry if that target should remain spawnable while inheriting defaults.
- Sandbox inheritance guard: if the requester session is sandboxed, `sessions_spawn` rejects targets that would run unsandboxed.
- `subagents.requireAgentId`: when true, block `sessions_spawn` calls that omit `agentId` (forces explicit profile selection; default: false).
- `subagents.maxConcurrent`: max concurrent child-agent runs across subagent execution. Default: `8`.
- `subagents.maxChildrenPerAgent`: max active children a single agent session can spawn. Default: `5`.
- `subagents.maxSpawnDepth`: max nesting depth for sub-agent spawning (`1`-`5`). Default: `5`; set `1` to make direct children leaves.
- `subagents.archiveAfterMinutes`: age before completed subagent state is archived. Default: `60`.

---

## Multi-agent routing

Run multiple isolated agents inside one Gateway. See [Multi-Agent](/concepts/multi-agent).

```json5
{
  agents: {
    ownership: "explicit",
    defaults: { heartbeat: { agentId: "home" }, systemAgent: { agentId: "home" } },
    entries: {
      home: { workspace: "~/.openclaw/workspace-home" },
      work: { workspace: "~/.openclaw/workspace-work" },
    },
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  talk: { agentId: "home" },
}
```

### Binding match fields

- `type` (optional): `route` for normal routing (missing type defaults to route), `acp` for persistent ACP conversation bindings.
- `match.channel` (required)
- `match.accountId` (optional; `*` = any account; omitted = default account)
- `match.peer` (optional; `{ kind: direct|group|channel, id }`)
- `match.guildId` / `match.teamId` (optional; channel-specific)
- `session` (optional; route bindings only): `{ dmScope, groupScope }` overrides session routing for matched peers
- `acp` (optional; only for `type: "acp"`): `{ mode, label, cwd, backend }`

**Deterministic match order:**

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (exact, no peer/guild/team)
5. `match.accountId: "*"` (channel-wide)
6. Sole-agent fallback (only when exactly one agent is configured; explicit multi-agent fleets without a matching binding fail closed)

Within each tier, the first matching `bindings` entry wins.

For `type: "acp"` entries, OpenClaw resolves by exact conversation identity (`match.channel` + account + `match.peer.id`) and does not use the route binding tier order above.

### Per-agent access profiles

<Accordion title="Full access (no sandbox)">

```json5
{
  agents: {
    entries: {
      personal: {
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    },
  },
}
```

</Accordion>

<Accordion title="Read-only tools + workspace">

```json5
{
  agents: {
    entries: {
      family: {
        workspace: "~/.openclaw/workspace-family",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    },
  },
}
```

</Accordion>

<Accordion title="No filesystem access (messaging only)">

```json5
{
  agents: {
    entries: {
      public: {
        workspace: "~/.openclaw/workspace-public",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    },
  },
}
```

</Accordion>

See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence details.
