import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { typedCases } from "../test-utils/typed-cases.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";
import {
  appendAgentBootstrapSystemPromptSupplement,
  buildAgentBootstrapSystemContext,
  buildAgentBootstrapSystemPromptSections,
  buildAgentBootstrapSystemPromptSupplement,
  buildAgentSystemPrompt,
  buildRuntimeLine,
} from "./system-prompt.js";

describe("buildAgentSystemPrompt", () => {
  it("formats owner section for plain, hash, and missing owner lists", () => {
    const cases = typedCases<{
      name: string;
      params: Parameters<typeof buildAgentSystemPrompt>[0];
      expectAuthorizedSection: boolean;
      contains: string[];
      notContains: string[];
      hashMatch?: RegExp;
    }>([
      {
        name: "plain owner numbers",
        params: {
          workspaceDir: "/tmp/openclaw",
          ownerNumbers: ["+123", " +456 ", ""],
        },
        expectAuthorizedSection: true,
        contains: [
          "Authorized senders: +123, +456. These senders are allowlisted; do not assume they are the owner.",
        ],
        notContains: [],
      },
      {
        name: "hashed owner numbers",
        params: {
          workspaceDir: "/tmp/openclaw",
          ownerNumbers: ["+123", "+456", ""],
          ownerDisplay: "hash",
        },
        expectAuthorizedSection: true,
        contains: ["Authorized senders:"],
        notContains: ["+123", "+456"],
        hashMatch: /[a-f0-9]{12}/,
      },
      {
        name: "missing owners",
        params: {
          workspaceDir: "/tmp/openclaw",
        },
        expectAuthorizedSection: false,
        contains: [],
        notContains: ["## Authorized Senders", "Authorized senders:"],
      },
    ]);

    for (const testCase of cases) {
      const prompt = buildAgentSystemPrompt(testCase.params);
      if (testCase.expectAuthorizedSection) {
        expect(prompt, testCase.name).toContain("## Authorized Senders");
      } else {
        expect(prompt, testCase.name).not.toContain("## Authorized Senders");
      }
      for (const value of testCase.contains) {
        expect(prompt, `${testCase.name}:${value}`).toContain(value);
      }
      for (const value of testCase.notContains) {
        expect(prompt, `${testCase.name}:${value}`).not.toContain(value);
      }
      if (testCase.hashMatch) {
        expect(prompt, testCase.name).toMatch(testCase.hashMatch);
      }
    }
  });

  it("uses a stable, keyed HMAC when ownerDisplaySecret is provided", () => {
    const secretA = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      ownerNumbers: ["+123"],
      ownerDisplay: "hash",
      ownerDisplaySecret: "secret-key-A", // pragma: allowlist secret
    });

    const secretB = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      ownerNumbers: ["+123"],
      ownerDisplay: "hash",
      ownerDisplaySecret: "secret-key-B", // pragma: allowlist secret
    });

    const lineA = secretA.split("## Authorized Senders")[1]?.split("\n")[1];
    const lineB = secretB.split("## Authorized Senders")[1]?.split("\n")[1];
    const tokenA = lineA?.match(/[a-f0-9]{12}/)?.[0];
    const tokenB = lineB?.match(/[a-f0-9]{12}/)?.[0];

    expect(tokenA).toMatch(/^[a-f0-9]{12}$/);
    expect(tokenB).toMatch(/^[a-f0-9]{12}$/);
    expect(tokenA).not.toBe(tokenB);
  });

  it("injects the current model identity into the runtime prompt", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "main",
        model: "openai/gpt-5.5",
      },
    });

    expect(prompt).toContain(
      "Current model identity: openai/gpt-5.5. If asked what model you are, answer with this value for the current run.",
    );
  });

  it("omits extended sections in minimal prompt mode", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      ownerNumbers: ["+123"],
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      heartbeatPrompt: "ping",
      toolNames: ["message", "memory_search"],
      docsPath: "/tmp/openclaw/docs",
      extraSystemPrompt: "Subagent details",
      ttsHint: "Voice (TTS) is enabled.",
    });

    expect(prompt).not.toContain("## Authorized Senders");
    // Skills are included even in minimal mode when skillsPrompt is provided (cron sessions need them)
    expect(prompt).toContain("## Skills");
    expect(prompt).not.toContain("## Memory Recall");
    expect(prompt).not.toContain("## Documentation");
    expect(prompt).not.toContain("## Reply Tags");
    expect(prompt).not.toContain("## Messaging");
    expect(prompt).not.toContain("## Voice (TTS)");
    expect(prompt).not.toContain("## Silent Replies");
    expect(prompt).not.toContain("## Heartbeats");
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain(
      "For long waits, avoid rapid poll loops: use exec with enough yieldMs or process(action=poll, timeout=<ms>).",
    );
    expect(prompt).toContain("No independent goals");
    expect(prompt).toContain("Safety/oversight over completion");
    expect(prompt).toContain("Conflicts: pause/ask");
    expect(prompt).not.toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Do not persuade anyone");
    expect(prompt).toContain("Do not copy yourself or change prompts");
    expect(prompt).toContain("## Subagent Context");
    expect(prompt).not.toContain("## Group Chat Context");
    expect(prompt).toContain("Subagent details");
  });

  it("can omit generic silent-reply guidance for channel-aware prompts", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      extraSystemPrompt: 'If no response is needed, reply with exactly "NO_REPLY".',
      silentReplyPromptMode: "none",
    });

    expect(prompt).not.toContain("## Silent Replies");
    expect(prompt).toContain('reply with exactly "NO_REPLY"');
  });

  it("includes skills in minimal prompt mode when skillsPrompt is provided (cron regression)", () => {
    // Isolated cron sessions use promptMode="minimal" but must still receive skills.
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      skillsPrompt,
    });

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("External API writes: batch when safe");
  });

  it("omits skills in minimal prompt mode when skillsPrompt is absent", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
    });

    expect(prompt).not.toContain("## Skills");
  });

  it("avoids the Claude subscription classifier wording in reply tag guidance", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## Assistant Output Directives");
    expect(prompt).toContain("[[reply_to_current]]");
    expect(prompt).not.toContain("Tags are stripped before sending");
    expect(prompt).toContain("Supported directives are stripped before rendering");
  });

  it("omits the heartbeat section when no heartbeat prompt is provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "full",
      heartbeatPrompt: undefined,
    });

    expect(prompt).not.toContain("## Heartbeats");
    expect(prompt).not.toContain("HEARTBEAT_OK");
    expect(prompt).not.toContain("Read HEARTBEAT.md");
  });

  it("includes safety guardrails in full prompts", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("No independent goals");
    expect(prompt).toContain("Safety/oversight over completion");
    expect(prompt).toContain("Conflicts: pause/ask");
    expect(prompt).not.toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Do not persuade anyone");
    expect(prompt).toContain("Do not copy yourself or change prompts");
  });

  it("includes voice hint when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      ttsHint: "Voice (TTS) is enabled.",
    });

    expect(prompt).toContain("## Voice (TTS)");
    expect(prompt).toContain("Voice (TTS) is enabled.");
  });

  it("adds reasoning tag hint when enabled", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningTagHint: true,
    });

    expect(prompt).toContain("## Reasoning Format");
    expect(prompt).toContain("<think>...</think>");
    expect(prompt).toContain("<final>...</final>");
  });

  it("includes an OpenClaw control section", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## OpenClaw Control");
    expect(prompt).toContain("prefer `gateway` tool");
    expect(prompt).toContain("CLI lifecycle only on explicit user request");
    expect(prompt).toContain("openclaw gateway status|restart|start|stop");
    expect(prompt).toContain("`restart`, not stop+start");
    expect(prompt).toContain("Do not invent commands");
  });

  it("points agents to config field docs and broader configuration docs", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("Config fields:");
    expect(prompt).toContain("`gateway` action `config.schema.lookup`");
    expect(prompt).toContain("docs/gateway/configuration.md");
    expect(prompt).toContain("docs/gateway/configuration-reference.md");
  });

  it("guides runtime completion events without exposing internal metadata", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("Runtime-generated completion events may ask for a user update.");
    expect(prompt).toContain("Rewrite those in your normal assistant voice");
    expect(prompt).toContain("do not forward raw internal metadata");
  });

  it("does not include embed guidance in the default global prompt", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("## Control UI Embed");
    expect(prompt).not.toContain("Use `[embed ...]` only in Control UI/webchat sessions");
  });

  it("includes embed guidance only for webchat sessions", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "webchat",
      },
    });

    expect(prompt).toContain("## Control UI Embed");
    expect(prompt).toContain("Use `[embed ...]` only in Control UI/webchat sessions");
    expect(prompt).toContain('[embed ref="cv_123" title="Status" height="320" /]');
    expect(prompt).toContain(
      '[embed url="/__openclaw__/canvas/documents/cv_123/index.html" title="Status" height="320" /]',
    );
    expect(prompt).toContain(
      "Never use local filesystem paths or `file://...` URLs in `[embed ...]`.",
    );
    expect(prompt).toContain(
      "The active hosted embed root is profile-scoped, not workspace-scoped.",
    );
    expect(prompt).not.toContain('[embed content_type="html" title="Status"]...[/embed]');
  });

  it("guides subagent workflows to avoid polling loops", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain(
      "For long waits, avoid rapid poll loops: use exec with enough yieldMs or process(action=poll, timeout=<ms>).",
    );
    expect(prompt).toContain("Larger work: use `sessions_spawn`; completion is push-based.");
    expect(prompt).toContain("Do not poll `subagents list` / `sessions_list` in a loop");
    expect(prompt).not.toContain("use `sessions_yield` when waiting");
    expect(prompt).toContain(
      "First-class tool exists: use it; do not ask user to run equivalent CLI/slash command.",
    );
  });

  it("only mentions sessions_yield wait guidance when the tool is available", () => {
    const withoutYield = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });
    const withYield = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "sessions_yield", "subagents"],
    });

    expect(withoutYield).not.toContain("use `sessions_yield` when waiting");
    expect(withYield).toContain("use `sessions_yield` when waiting");
  });

  it("lists available tools when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["exec", "sessions_list", "sessions_history", "sessions_send"],
    });

    expect(prompt).toContain("Available tools are policy-filtered.");
    expect(prompt).toContain("sessions_list");
    expect(prompt).toContain("sessions_history");
    expect(prompt).toContain("sessions_send");
  });

  it("uses provider-neutral web_search prompt metadata", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["web_search"],
    });

    expect(prompt).toContain("- web_search: Search the web using the configured provider");
    expect(prompt).not.toContain("Brave API");
  });

  it("documents ACP sessions_spawn agent targeting requirements", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
      acpEnabled: true,
    });

    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain(
      'runtime="acp" requires `agentId` unless `acp.defaultAgent` is configured',
    );
    expect(prompt).toContain("not agents_list");
  });

  it("guides harness requests to ACP thread-bound spawns", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      nativeCommandGuidanceLines: [
        "Native Codex app-server plugin is available (`/codex ...`). For Codex bind/control/thread/resume/steer/stop requests, prefer `/codex bind`, `/codex threads`, `/codex resume`, `/codex steer`, and `/codex stop` over ACP.",
        "Use ACP for Codex only when the user explicitly asks for ACP/acpx or wants to test the ACP path.",
      ],
      acpEnabled: true,
      runtimeInfo: {
        channel: "discord",
        capabilities: ["threadbound-acp-spawn"],
      },
    });

    expect(prompt).toContain("Native Codex app-server plugin is available");
    expect(prompt).toContain("prefer `/codex bind`, `/codex threads`, `/codex resume`");
    expect(prompt).toContain("Use ACP for Codex only when the user explicitly asks for ACP/acpx");
    expect(prompt).toContain(
      'For requests like "do this in claude code/cursor/gemini/opencode" or similar ACP harnesses, treat it as ACP harness intent',
    );
    expect(prompt).toContain(
      'On Discord, default ACP harness requests to thread-bound persistent sessions (`thread: true`, `mode: "session"`)',
    );
    expect(prompt).toContain(
      "do not route ACP harness requests through `subagents`/`agents_list` or local PTY exec flows",
    );
    expect(prompt).toContain(
      'do not call `message` with `action=thread-create`; use `sessions_spawn` (`runtime: "acp"`, `thread: true`) as the single thread creation path',
    );
  });

  it("omits ACP thread-spawn guidance when the runtime capability is absent", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "exec"],
      acpEnabled: true,
      runtimeInfo: {
        channel: "discord",
        capabilities: [],
      },
    });

    expect(prompt).toContain(
      'For requests like "do this in claude code/cursor/gemini/opencode" or similar ACP harnesses, treat it as ACP harness intent',
    );
    expect(prompt).not.toContain("default ACP harness requests to thread-bound");
    expect(prompt).not.toContain('use `sessions_spawn` (`runtime: "acp"`, `thread: true`)');
  });

  it("omits ACP harness guidance when ACP is disabled", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      acpEnabled: false,
    });

    expect(prompt).not.toContain(
      'For requests like "do this in claude code/cursor/gemini/opencode" or similar ACP harnesses, treat it as ACP harness intent',
    );
    expect(prompt).not.toContain("Native Codex app-server plugin is available");
    expect(prompt).not.toContain('runtime="acp" requires `agentId`');
    expect(prompt).not.toContain("not ACP harness ids");
    expect(prompt).toContain("- sessions_spawn: Spawn an isolated sub-agent session");
    expect(prompt).toContain("- agents_list: List OpenClaw agent ids allowed for sessions_spawn");
  });

  it("omits ACP harness spawn guidance for sandboxed sessions and shows ACP block note", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      acpEnabled: true,
      sandboxInfo: {
        enabled: true,
      },
    });

    expect(prompt).not.toContain('runtime="acp" requires `agentId`');
    expect(prompt).not.toContain("ACP harness ids follow acp.allowedAgents");
    expect(prompt).not.toContain(
      'For requests like "do this in claude code/cursor/gemini/opencode" or similar ACP harnesses, treat it as ACP harness intent',
    );
    expect(prompt).not.toContain(
      'do not call `message` with `action=thread-create`; use `sessions_spawn` (`runtime: "acp"`, `thread: true`) as the single thread creation path',
    );
    expect(prompt).toContain("ACP harness spawns are blocked from sandboxed sessions");
    expect(prompt).toContain('`runtime: "acp"`');
    expect(prompt).toContain('Use `runtime: "subagent"` instead.');
  });

  it("preserves tool casing in the prompt", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["Read", "Exec", "process"],
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("- Read: Read file contents");
    expect(prompt).toContain("- Exec: Run shell commands");
    expect(prompt).toContain(
      "Scan <available_skills>. If one clearly applies, read its SKILL.md at exact <location> with `Read`, then follow it.",
    );
    expect(prompt).toContain("If several apply, choose the most specific.");
    expect(prompt).toContain("Docs: /tmp/openclaw/docs");
    expect(prompt).toContain("OpenClaw behavior/config/architecture: read local docs first.");
  });

  it("includes docs guidance when docsPath is provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
      sourcePath: "/tmp/openclaw",
    });

    expect(prompt).toContain("## Documentation");
    expect(prompt).toContain("Docs: /tmp/openclaw/docs");
    expect(prompt).toContain("Source: /tmp/openclaw");
    expect(prompt).toContain("OpenClaw behavior/config/architecture: read local docs first.");
    expect(prompt).toContain("If docs are stale/incomplete, inspect local source.");
  });

  it("falls back to public docs and GitHub source guidance when local docs are unavailable", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/work",
    });

    expect(prompt).toContain("Docs: https://docs.openclaw.ai");
    expect(prompt).toContain("Source: https://github.com/openclaw/openclaw");
    expect(prompt).toContain("If docs are stale/incomplete, inspect GitHub source.");
  });

  it("includes workspace notes when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      workspaceNotes: ["Reminder: commit your changes in this workspace after edits."],
    });

    expect(prompt).toContain("Reminder: commit your changes in this workspace after edits.");
  });

  it("includes bootstrap instructions in system prompt when bootstrap is pending", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      bootstrapMode: "full",
      contextFiles: [{ path: "/tmp/openclaw/BOOTSTRAP.md", content: "Ask who I am." }],
    });

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(prompt).toContain("must follow BOOTSTRAP.md, not a generic greeting");
    expect(prompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(prompt).toContain("Ask who I am.");
  });

  it("includes bootstrap truncation notice in system prompt without raw diagnostics", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      bootstrapTruncationNotice:
        "[Bootstrap truncation warning]\nSome workspace bootstrap files were truncated before Project Context injection.\nTreat Project Context as partial and read the relevant files directly if details seem missing.",
    });

    expect(prompt).toContain("## Bootstrap Context Notice");
    expect(prompt).toContain("[Bootstrap truncation warning]");
    expect(prompt).toContain("Treat Project Context as partial");
    expect(prompt).not.toContain("raw ->");
    expect(prompt).not.toContain("bootstrapMaxChars");
  });

  it("shows timezone section for 12h, 24h, and timezone-only modes", () => {
    const cases = [
      {
        name: "12-hour",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTime: "Monday, January 5th, 2026 — 3:26 PM",
          userTimeFormat: "12" as const,
        },
      },
      {
        name: "24-hour",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTime: "Monday, January 5th, 2026 — 15:26",
          userTimeFormat: "24" as const,
        },
      },
      {
        name: "timezone-only",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTimeFormat: "24" as const,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const prompt = buildAgentSystemPrompt(testCase.params);
      expect(prompt, testCase.name).toContain("## Current Date & Time");
      expect(prompt, testCase.name).toContain("Time zone: America/Chicago");
    }
  });

  it("hints to use session_status for current date/time", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      userTimezone: "America/Chicago",
    });

    expect(prompt).toContain("session_status");
    expect(prompt).toContain("current date");
  });

  // The system prompt intentionally does NOT include the current date/time.
  // Only the timezone is included, to keep the prompt stable for caching.
  // See: https://github.com/moltbot/moltbot/commit/66eec295b894bce8333886cfbca3b960c57c4946
  // Agents should use session_status or message timestamps to determine the date/time.
  // Related: https://github.com/moltbot/moltbot/issues/1897
  //          https://github.com/moltbot/moltbot/issues/3658
  it("does NOT include a date or time in the system prompt (cache stability)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      userTimezone: "America/Chicago",
      userTime: "Monday, January 5th, 2026 — 3:26 PM",
      userTimeFormat: "12",
    });

    // The prompt should contain the timezone but NOT the formatted date/time string.
    // This is intentional for prompt cache stability — the date/time was removed in
    // commit 66eec295b. If you're here because you want to add it back, please see
    // https://github.com/moltbot/moltbot/issues/3658 for the preferred approach:
    // gateway-level timestamp injection into messages, not the system prompt.
    expect(prompt).toContain("Time zone: America/Chicago");
    expect(prompt).not.toContain("Monday, January 5th, 2026");
    expect(prompt).not.toContain("3:26 PM");
    expect(prompt).not.toContain("15:26");
  });

  it("includes model alias guidance when aliases are provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      modelAliasLines: [
        "- Opus: anthropic/claude-opus-4-5",
        "- Sonnet: anthropic/claude-sonnet-4-6",
      ],
    });

    expect(prompt).toContain("## Model Aliases");
    expect(prompt).toContain("Prefer aliases when specifying model overrides");
    expect(prompt).toContain("- Opus: anthropic/claude-opus-4-5");
  });

  it("adds ClaudeBot self-update guidance when gateway tool is available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["gateway", "exec"],
    });

    expect(prompt).toContain("## OpenClaw Self-Update");
    expect(prompt).toContain("config.schema.lookup");
    expect(prompt).toContain("config.apply");
    expect(prompt).toContain("config.patch");
    expect(prompt).toContain("Config writes hot-reload when possible");
    expect(prompt).toContain("update.run");
    expect(prompt).not.toContain("Use config.schema to");
    expect(prompt).not.toContain("config.schema, config.apply");
  });

  it("includes skills guidance when skills prompt is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
    });

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain(
      "Scan <available_skills>. If one clearly applies, read its SKILL.md at exact <location> with `read`, then follow it.",
    );
    expect(prompt).toContain("If several apply, choose the most specific.");
  });

  it("appends available skills when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
    });

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>demo</name>");
  });

  it("omits skills section when no skills prompt is provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("<available_skills>");
  });

  it("renders project context files when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        { path: "AGENTS.md", content: "Alpha" },
        { path: "IDENTITY.md", content: "Bravo" },
      ],
    });

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("Alpha");
    expect(prompt).toContain("## IDENTITY.md");
    expect(prompt).toContain("Bravo");
  });

  it("ignores context files with missing or blank paths", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        { path: undefined as unknown as string, content: "Missing path" },
        { path: "   ", content: "Blank path" },
        { path: "AGENTS.md", content: "Alpha" },
      ],
    });

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("Alpha");
    expect(prompt).not.toContain("Missing path");
    expect(prompt).not.toContain("Blank path");
  });

  it("adds SOUL guidance when a soul file is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        { path: "./SOUL.md", content: "Persona" },
        { path: "dir\\SOUL.md", content: "Persona Windows" },
      ],
    });

    expect(prompt).toContain(
      "SOUL.md: persona/tone. Follow it unless higher-priority instructions override.",
    );
  });

  it("omits project context when no context files are injected", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [],
    });

    expect(prompt).not.toContain("# Project Context");
  });

  it("summarizes the message tool when available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
    });
    const channelOptions = listDeliverableMessageChannels().join("|");

    expect(prompt).toContain("message: Send messages and channel actions");
    expect(prompt).toContain("### message tool");
    expect(prompt).toContain("Use `message` for proactive sends + channel actions");
    expect(prompt).toContain("For `action=send`, include `target` and `message`.");
    expect(prompt).toContain(
      `No current/default source channel: include \`channel\` for proactive sends; valid ids: ${channelOptions}.`,
    );
    expect(prompt).toContain(`respond with ONLY: ${SILENT_REPLY_TOKEN}`);
  });

  it("keeps channel choice guidance lean when message sends have a source channel", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
      },
    });

    expect(prompt).toContain(
      "Pass `channel` only when sending outside the current/default source channel.",
    );
    expect(prompt).not.toContain("No current/default source channel");
    expect(prompt).not.toContain("valid ids:");
  });

  it("gates sub-agent orchestration guidance on available tools", () => {
    const messagingPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message", "sessions_send"],
    });
    const spawnOnlyPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
    });
    const orchestrationPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });
    const orchestrationWaitPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "sessions_yield", "subagents"],
    });

    expect(messagingPrompt).not.toContain("Sub-agent orchestration");
    expect(messagingPrompt).not.toContain("sessions_spawn(...)");
    expect(messagingPrompt).not.toContain("subagents(action=list|steer|kill)");

    expect(spawnOnlyPrompt).toContain(
      '- Sub-agent orchestration → use `sessions_spawn(...)` to start delegated work; include a clear objective/output/write-scope/verification brief and `taskName` when a stable handle helps; omit `context` for isolated children, set `context:"fork"` only when the child needs the current transcript.',
    );
    expect(spawnOnlyPrompt).not.toContain("manage already-spawned children");

    expect(orchestrationPrompt).toContain(
      '- Sub-agent orchestration → use `sessions_spawn(...)` to start delegated work; include a clear objective/output/write-scope/verification brief and `taskName` when a stable handle helps; omit `context` for isolated children, set `context:"fork"` only when the child needs the current transcript; use `subagents(action=list|steer|kill)` only for on-demand status, debugging, or intervention.',
    );
    expect(orchestrationWaitPrompt).toContain("use `sessions_yield` to wait for completion events");
  });

  it("adds stronger sub-agent delegation guidance in prefer mode", () => {
    const defaultPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });
    const preferPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
      subagentDelegationMode: "prefer",
    });

    expect(defaultPrompt).not.toContain("## Sub-Agent Delegation");
    expect(preferPrompt).toContain("## Sub-Agent Delegation");
    expect(preferPrompt).toContain("Mode: prefer");
    expect(preferPrompt).toContain("responsive coordinator");
    expect(preferPrompt).toContain(
      "Anything requiring more work than a direct reply should go through `sessions_spawn`",
    );
    expect(preferPrompt).toContain("objective, expected output, relevant files/inputs");
    expect(preferPrompt).toContain("Treat child outputs as reports/evidence");
    expect(preferPrompt).toContain(
      "Use `subagents(action=list|steer|kill)` only when explicitly asked for status",
    );
  });

  it("omits prefer delegation guidance when sessions_spawn is unavailable", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["subagents"],
      subagentDelegationMode: "prefer",
    });

    expect(prompt).not.toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Sub-agent orchestration");
  });

  it("reapplies provider prompt contributions", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptContribution: {
        stablePrefix: "## Provider Stable\n\nStable guidance.",
        dynamicSuffix: "## Provider Dynamic\n\nDynamic guidance.",
        sectionOverrides: {
          tool_call_style: "## Tool Call Style\nProvider-specific tool call guidance.",
        },
      },
    });

    expect(prompt).toContain("## Provider Stable\n\nStable guidance.");
    expect(prompt).toContain("## Provider Dynamic\n\nDynamic guidance.");
    expect(prompt).toContain("## Tool Call Style\nProvider-specific tool call guidance.");
    expect(prompt).not.toContain("Default: do not narrate routine, low-risk tool calls");
  });

  it("includes inline button style guidance when runtime supports inline buttons", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
    });

    expect(prompt).toContain("buttons=[[{text,callback_data,style?}]]");
    expect(prompt).toContain("`style` can be `primary`, `success`, or `danger`");
  });

  it("uses Slack interactive reply hints instead of generic inline button config guidance", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "slack",
      },
      messageToolHints: [
        "- Prefer Slack buttons/selects for 2-5 discrete choices or parameter picks instead of asking the user to type one.",
        "- Slack interactive replies: use `[[slack_buttons: Label:value, Other:other]]` to add action buttons that route clicks back as Slack interaction system events.",
      ],
    });

    expect(prompt).toContain("Slack interactive replies");
    expect(prompt).toContain("[[slack_buttons: Label:value, Other:other]]");
    expect(prompt).not.toContain("Inline buttons not enabled for slack");
    expect(prompt).not.toContain("slack.capabilities.inlineButtons");
    expect(prompt).not.toContain("buttons=[[{text,callback_data,style?}]]");
  });

  it("describes message-tool-only source delivery without requiring target", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      sourceReplyDeliveryMode: "message_tool_only",
      runtimeInfo: {
        channel: "discord",
      },
    });

    expect(prompt).toContain("private by default for this source channel");
    expect(prompt).toContain("use `message(action=send)` for visible channel output");
    expect(prompt).toContain("The target defaults to the current source channel");
    expect(prompt).toContain("final answers are private in this mode");
    expect(prompt).not.toContain("## Silent Replies");
    expect(prompt).not.toContain(SILENT_REPLY_TOKEN);
    expect(prompt).not.toContain(
      `respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies)`,
    );
    expect(prompt).not.toContain("For `action=send`, include `target` and `message`.");
  });

  it("suppresses plain chat approval commands when inline approval UI is available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
    });

    expect(prompt).toContain("use native approval card/buttons first");
    expect(prompt).toContain("Include a plain /approve command only when");
  });

  it("suppresses plain chat approval commands for native approval channels", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "slack",
      },
    });

    expect(prompt).toContain("use native approval card/buttons first");
    expect(prompt).toContain("Include a plain /approve command only when");
  });

  it("keeps approval slug guidance separate from command previews", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "discord",
      },
    });

    expect(prompt).toContain('copy the exact command from "Reply with:"');
    expect(prompt).toContain("keep command/script previews separate from the /approve command");
    expect(prompt).toContain(
      "never substitute the shell command/script for the approval id or slug",
    );
  });

  it("includes runtime provider capabilities when present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
    });

    expect(prompt).toContain("channel=telegram");
    expect(prompt).toContain("capabilities=inlinebuttons");
  });

  it("canonicalizes runtime provider capabilities before rendering", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
        capabilities: [" InlineButtons ", "voice", "inlinebuttons", "Voice"],
      },
    });

    expect(prompt).toContain("channel=telegram");
    expect(prompt).toContain("capabilities=inlinebuttons,voice");
    expect(prompt).not.toContain("capabilities= InlineButtons ,voice,inlinebuttons,Voice");
  });

  it("includes agent id in runtime when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "work",
        host: "host",
        os: "macOS",
        arch: "arm64",
        node: "v20",
        model: "anthropic/claude",
      },
    });

    expect(prompt).toContain("agent=work");
  });

  it("includes reasoning visibility hint", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningLevel: "off",
    });

    expect(prompt).toContain("Reasoning: off");
    expect(prompt).toContain("/reasoning");
    expect(prompt).toContain("/status shows Reasoning");
  });

  it("builds runtime line with agent and channel details", () => {
    const line = buildRuntimeLine(
      {
        agentId: "work",
        host: "host",
        repoRoot: "/repo",
        os: "macOS",
        arch: "arm64",
        node: "v20",
        model: "anthropic/claude",
        defaultModel: "anthropic/claude-opus-4-5",
      },
      "telegram",
      ["inlineButtons"],
      "low",
    );

    expect(line).toContain("agent=work");
    expect(line).toContain("host=host");
    expect(line).toContain("repo=/repo");
    expect(line).toContain("os=macOS (arm64)");
    expect(line).toContain("node=v20");
    expect(line).toContain("model=anthropic/claude");
    expect(line).toContain("default_model=anthropic/claude-opus-4-5");
    expect(line).toContain("channel=telegram");
    expect(line).toContain("capabilities=inlinebuttons");
    expect(line).toContain("thinking=low");
  });

  it("renders extra system prompt exactly once", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      extraSystemPrompt: "Custom runtime context",
    });

    expect(prompt.match(/Custom runtime context/g)).toHaveLength(1);
    expect(prompt.match(/## Group Chat Context/g)).toHaveLength(1);
  });

  it("describes sandboxed runtime and elevated when allowed", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      sandboxInfo: {
        enabled: true,
        workspaceDir: "/tmp/sandbox",
        containerWorkspaceDir: "/workspace",
        workspaceAccess: "ro",
        agentWorkspaceMount: "/agent",
        elevated: { allowed: true, defaultLevel: "on", fullAccessAvailable: true },
      },
    });

    expect(prompt).toContain("Your working directory is: /workspace");
    expect(prompt).toContain(
      "For read/write/edit/apply_patch, file paths resolve against host workspace: /tmp/openclaw. For bash/exec commands, use sandbox container paths under /workspace (or relative paths from that workdir), not host paths.",
    );
    expect(prompt).toContain("Sandbox container workdir: /workspace");
    expect(prompt).toContain(
      "Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): /tmp/sandbox",
    );
    expect(prompt).toContain("You are running in a sandboxed runtime");
    expect(prompt).toContain("Sub-agents stay sandboxed");
    expect(prompt).toContain("User can toggle with /elevated on|off|ask|full.");
    expect(prompt).toContain("Current elevated level: on");
  });

  it("does not advertise /elevated full when auto-approved full access is unavailable", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      sandboxInfo: {
        enabled: true,
        workspaceDir: "/tmp/sandbox",
        containerWorkspaceDir: "/workspace",
        workspaceAccess: "ro",
        agentWorkspaceMount: "/agent",
        elevated: {
          allowed: true,
          defaultLevel: "full",
          fullAccessAvailable: false,
          fullAccessBlockedReason: "runtime",
        },
      },
    });

    expect(prompt).toContain("Elevated exec is available for this session.");
    expect(prompt).toContain("User can toggle with /elevated on|off|ask.");
    expect(prompt).not.toContain("User can toggle with /elevated on|off|ask|full.");
    expect(prompt).toContain(
      "Auto-approved /elevated full is unavailable here (runtime constraints).",
    );
    expect(prompt).toContain(
      "Current elevated level: full (full auto-approval unavailable here; use ask/on instead).",
    );
  });

  it("includes reaction guidance when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reactionGuidance: {
        level: "minimal",
        channel: "Telegram",
      },
    });

    expect(prompt).toContain("## Reactions");
    expect(prompt).toContain("Reactions are enabled for Telegram in MINIMAL mode.");
  });

  it("keeps stable project context before volatile channel guidance for prefix-cache reuse", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
      contextFiles: [
        {
          path: "AGENTS.md",
          content: "Project rules mention ## Messaging, ## Group Chat Context, and ## Reactions.",
        },
      ],
      extraSystemPrompt: "Current group-chat facts",
      reactionGuidance: { level: "minimal", channel: "Telegram" },
      ttsHint: "Use short voice-friendly replies.",
    });

    const projectContextPos = prompt.indexOf("# Project Context");
    const boundaryPos = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const messagingPos = prompt.lastIndexOf("## Messaging");
    const groupChatPos = prompt.lastIndexOf("## Group Chat Context");
    const reactionsPos = prompt.lastIndexOf("## Reactions");
    const voicePos = prompt.lastIndexOf("## Voice (TTS)");

    expect(projectContextPos).toBeGreaterThan(-1);
    expect(boundaryPos).toBeGreaterThan(projectContextPos);
    expect(messagingPos).toBeGreaterThan(boundaryPos);
    expect(groupChatPos).toBeGreaterThan(boundaryPos);
    expect(reactionsPos).toBeGreaterThan(boundaryPos);
    expect(voicePos).toBeGreaterThan(boundaryPos);
  });
});

describe("buildAgentBootstrapSystemContext", () => {
  it("uses friendly full bootstrap wording that is truthful about completion blockers", () => {
    const prompt = buildAgentBootstrapSystemContext({
      bootstrapMode: "full",
      hasBootstrapFileInProjectContext: true,
    }).join("\n");

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(prompt).toContain("If this run can complete the BOOTSTRAP.md workflow, do so.");
    expect(prompt).toContain("explain the blocker briefly");
    expect(prompt).toContain("offer the simplest next step");
    expect(prompt).toContain("Do not pretend bootstrap is complete when it is not.");
    expect(prompt).toContain("must follow BOOTSTRAP.md, not a generic greeting");
  });

  it("uses limited bootstrap wording for constrained user-facing runs", () => {
    const prompt = buildAgentBootstrapSystemContext({ bootstrapMode: "limited" }).join("\n");

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain("cannot safely complete the full BOOTSTRAP.md workflow here");
    expect(prompt).toContain("Do not claim bootstrap is complete");
    expect(prompt).toContain("do not use a generic first greeting");
    expect(prompt).toContain("switching to a primary interactive run with normal workspace access");
  });

  it("returns nothing when bootstrap is not pending", () => {
    expect(buildAgentBootstrapSystemContext({ bootstrapMode: "none" })).toStrictEqual([]);
    expect(buildAgentBootstrapSystemContext({})).toStrictEqual([]);
  });
});

describe("buildAgentBootstrapSystemPromptSupplement", () => {
  it("can render bootstrap guidance without duplicating Project Context", () => {
    const sections = buildAgentBootstrapSystemPromptSections({
      bootstrapMode: "full",
      bootstrapTruncationNotice: "Bootstrap context was truncated.",
      contextFiles: [{ path: "/tmp/openclaw/BOOTSTRAP.md", content: "Ask who I am." }],
      includeProjectContext: false,
    }).join("\n");

    expect(sections).toContain("## Bootstrap Pending");
    expect(sections).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(sections).toContain("## Bootstrap Context Notice");
    expect(sections).toContain("Bootstrap context was truncated.");
    expect(sections).not.toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(sections).not.toContain("Ask who I am.");
  });

  it("adds pending bootstrap guidance and BOOTSTRAP.md contents for override prompts", () => {
    const supplement = buildAgentBootstrapSystemPromptSupplement({
      bootstrapMode: "full",
      contextFiles: [{ path: "/tmp/openclaw/BOOTSTRAP.md", content: "Ask who I am." }],
    });

    expect(supplement).toContain("## Bootstrap Pending");
    expect(supplement).toContain("BOOTSTRAP.md is included below in Project Context");
    expect(supplement).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(supplement).toContain("Ask who I am.");
  });

  it("appends bootstrap supplement to configured system prompt overrides", () => {
    const prompt = appendAgentBootstrapSystemPromptSupplement({
      systemPrompt: "Custom override prompt.",
      bootstrapMode: "full",
      bootstrapTruncationNotice:
        "[Bootstrap truncation warning]\nSome workspace bootstrap files were truncated before Project Context injection.\nTreat Project Context as partial and read the relevant files directly if details seem missing.",
      contextFiles: [{ path: "/tmp/openclaw/BOOTSTRAP.md", content: "Ask who I am." }],
    });

    expect(prompt).toContain("Custom override prompt.");
    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain("Ask who I am.");
    expect(prompt).toContain("## Bootstrap Context Notice");
    expect(prompt).toContain("[Bootstrap truncation warning]");
  });
});

describe("buildSubagentSystemPrompt", () => {
  it("renders depth-1 orchestrator guidance, labels, and recovery notes", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
      acpEnabled: true,
    });

    expect(prompt).toContain("## Sub-Agent Spawning");
    expect(prompt).toContain(
      "You CAN spawn your own sub-agents for parallel or complex work using `sessions_spawn`.",
    );
    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain('runtime: "acp"');
    expect(prompt).toContain("For ACP harness sessions (claudecode/gemini/opencode");
    expect(prompt).toContain("set `agentId` unless `acp.defaultAgent` is configured");
    expect(prompt).toContain("Do not ask users to run slash commands or CLI");
    expect(prompt).toContain("Do not use `exec` (`openclaw ...`, `acpx ...`)");
    expect(prompt).toContain("Use `subagents` only for OpenClaw subagents");
    expect(prompt).toContain("Subagent results auto-announce back to you");
    expect(prompt).toContain(
      "After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool.",
    );
    expect(prompt).toContain(
      "If required completions have not arrived yet and `sessions_yield` is available",
    );
    expect(prompt).toContain("If it is not available, do not invent polling loops");
    expect(prompt).toContain("expected output, relevant files/inputs, write scope");
    expect(prompt).toContain(
      "Track expected child session keys and only send your final answer after completion events for ALL expected children arrive.",
    );
    expect(prompt).toContain(
      "If a child completion event arrives AFTER you already sent your final answer, reply ONLY with NO_REPLY.",
    );
    expect(prompt).toContain("Avoid polling loops");
    expect(prompt).toContain("spawned by the main agent");
    expect(prompt).toContain("reported to the main agent");
    expect(prompt).toContain("[... N more characters truncated]");
    expect(prompt).toContain("offset/limit");
    expect(prompt).toContain("instead of full-file `cat`");
  });

  it("keeps multiline and indented task text verbatim in the system prompt (#72019)", () => {
    const task = "line one\n  line two\n  line three";
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task,
      childDepth: 1,
      maxSpawnDepth: 1,
    });

    expect(prompt).toContain("```");
    expect(prompt).toContain("line one");
    expect(prompt).toContain("  line two");
    expect(prompt).toContain("  line three");
    expect(prompt).not.toContain("line one line two");
  });

  it("omits ACP spawning guidance when ACP is disabled", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
      acpEnabled: false,
    });

    expect(prompt).not.toContain('runtime: "acp"');
    expect(prompt).not.toContain("For ACP harness sessions (claudecode/gemini/opencode");
    expect(prompt).not.toContain("set `agentId` unless `acp.defaultAgent` is configured");
    expect(prompt).toContain("You CAN spawn your own sub-agents");
  });

  it("omits ACP spawning guidance by default", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
    });

    expect(prompt).not.toContain('runtime: "acp"');
    expect(prompt).not.toContain("For ACP harness sessions (claudecode/gemini/opencode");
    expect(prompt).toContain("You CAN spawn your own sub-agents");
  });

  it("prefers native Codex commands over Codex ACP when available", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
      nativeCommandGuidanceLines: [
        "Native Codex app-server plugin is available (`/codex ...`). Prefer that path for Codex bind/control/thread/resume/steer/stop requests; use Codex ACP only when explicitly requested.",
      ],
      acpEnabled: true,
    });

    expect(prompt).toContain("Native Codex app-server plugin is available");
    expect(prompt).toContain("use Codex ACP only when explicitly requested");
  });

  it("renders depth-2 leaf guidance with parent orchestrator labels", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc:subagent:def",
      task: "leaf task",
      childDepth: 2,
      maxSpawnDepth: 2,
    });

    expect(prompt).toContain("## Sub-Agent Spawning");
    expect(prompt).toContain("leaf worker");
    expect(prompt).toContain("CANNOT spawn further sub-agents");
    expect(prompt).toContain("spawned by the parent orchestrator");
    expect(prompt).toContain("reported to the parent orchestrator");
  });

  it("omits spawning guidance for depth-1 leaf agents", () => {
    const leafCases = [
      {
        name: "explicit maxSpawnDepth 1",
        input: {
          childSessionKey: "agent:main:subagent:abc",
          task: "research task",
          childDepth: 1,
          maxSpawnDepth: 1,
        },
        expectMainAgentLabel: false,
      },
      {
        name: "implicit default depth/maxSpawnDepth",
        input: {
          childSessionKey: "agent:main:subagent:abc",
          task: "basic task",
        },
        expectMainAgentLabel: true,
      },
    ] as const;

    for (const testCase of leafCases) {
      const prompt = buildSubagentSystemPrompt(testCase.input);
      expect(prompt, testCase.name).not.toContain("## Sub-Agent Spawning");
      expect(prompt, testCase.name).not.toContain("You CAN spawn");
      if (testCase.expectMainAgentLabel) {
        expect(prompt, testCase.name).toContain("spawned by the main agent");
      }
    }
  });
});
