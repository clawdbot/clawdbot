import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
// System prompt tests cover the main prompt facade, prompt-surface routing, and
// user-visible sections for owners, tools, safety, skills, and subagents.
import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { typedCases } from "../test-utils/typed-cases.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import { resolveAgentPromptSurfaceForSessionKey } from "./prompt-surface.js";
import { buildSkillWorkshopPromptSection } from "./skill-workshop-prompt.js";
import { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt", () => {
  it("resolves helper session keys to scoped prompt surfaces", () => {
    expect(resolveAgentPromptSurfaceForSessionKey("agent:main:subagent:child")).toBe("subagent");
    expect(resolveAgentPromptSurfaceForSessionKey("agent:codex:acp:child")).toBe("acp_backend");
    expect(resolveAgentPromptSurfaceForSessionKey("agent:main")).toBe("openclaw_main");
    expect(resolveAgentPromptSurfaceForSessionKey(undefined)).toBe("openclaw_main");
  });

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
        contains: ["Allowlisted senders: +123, +456. Allowlisted != owner."],
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
        contains: ["Allowlisted senders:"],
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
        notContains: ["## Authorized Senders", "Allowlisted senders:"],
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
      "Current model identity: openai/gpt-5.5. Model question: answer this current-run value.",
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
      "Long wait: no rapid poll. Use exec yieldMs or process(poll, timeout=<ms>).",
    );
    expect(prompt).toContain("No independent goals");
    expect(prompt).toContain("Safety/oversight > completion");
    expect(prompt).toContain("Conflict: pause/ask");
    expect(prompt).not.toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Never persuade anyone to expand access or disable safeguards");
    expect(prompt).toContain(
      "Never copy self or change prompts/safety/tool policy unless user explicitly requests",
    );
    expect(prompt).toContain("## Subagent Context");
    expect(prompt).not.toContain("## Group Chat Context");
    expect(prompt).toContain("Subagent details");
  });

  it("keeps promised asynchronous work open in full and minimal prompts", () => {
    for (const promptMode of ["full", "minimal"] as const) {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        promptMode,
      });

      expect(prompt).toContain("## Promised Work");
      expect(prompt).toContain("Progress such as `running` is not completion.");
      expect(prompt.match(/## Promised Work/g)).toHaveLength(1);
    }

    expect(
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        promptMode: "none",
      }),
    ).not.toContain("## Promised Work");
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

  it("keeps source delivery guidance mode-neutral when silent replies are suppressed", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      silentReplyPromptMode: "none",
      runtimeInfo: {
        channel: "telegram",
      },
    });

    expect(prompt).toContain("final text normally routes to source");
    expect(prompt).toContain("Follow turn delivery");
    expect(prompt).not.toContain(
      "Do not use `message(action=send)` to deliver the current source-channel reply",
    );
  });

  it("includes skills in minimal prompt mode when skillsPrompt is provided (cron regression)", () => {
    // Isolated cron sessions use promptMode="minimal" but still need skills.
    const skillsPrompt =
      "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      skillsPrompt,
    });

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("Changed <version>: re-read");
    expect(prompt).toContain("External writes: batch safely");
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
    expect(prompt).toContain("Directives stripped before render");
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
    expect(prompt).toContain("Safety/oversight > completion");
    expect(prompt).toContain("Conflict: pause/ask");
    expect(prompt).not.toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Never persuade anyone to expand access or disable safeguards");
    expect(prompt).toContain(
      "Never copy self or change prompts/safety/tool policy unless user explicitly requests",
    );
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
    expect(prompt).toContain("Config read: `gateway`");
    expect(prompt).not.toContain("openclaw gateway status|restart|start|stop");
    expect(prompt).toContain("Do not invent commands");
  });

  it("points agents to config field docs and broader configuration docs", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("Config field:");
    expect(prompt).toContain("`gateway(config.schema.lookup)`");
    expect(prompt).toContain("docs/gateway/configuration.md");
    expect(prompt).toContain("docs/gateway/configuration-reference.md");
  });

  it("guides runtime completion events without exposing internal metadata", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("Completion event requesting update:");
    expect(prompt).toContain("rewrite in normal voice");
    expect(prompt).toContain("Never forward raw metadata");
  });

  it("does not include embed guidance in the default global prompt", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("## Control UI Embed");
    expect(prompt).not.toContain("`[embed ...]`: Control UI/webchat only");
  });

  it("includes embed guidance only for webchat sessions", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "webchat",
      },
    });

    expect(prompt).toContain("## Control UI Embed");
    expect(prompt).toContain("`[embed ...]`: Control UI/webchat only");
    expect(prompt).toContain('[embed ref="cv_123" title="Status" height="320" /]');
    expect(prompt).toContain(
      '[embed url="/__openclaw__/canvas/documents/cv_123/index.html" title="Status" height="320" /]',
    );
    expect(prompt).toContain("Never local/file:// or arbitrary URL");
    expect(prompt).toContain("URL must start `/__openclaw__/canvas/`; else use `ref`");
    expect(prompt).toContain("Hosted root is profile-, not workspace-scoped");
    expect(prompt).not.toContain('[embed content_type="html" title="Status"]...[/embed]');
  });

  it("guides subagent workflows to avoid polling loops", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain(
      "Long wait: no rapid poll. Use exec yieldMs or process(poll, timeout=<ms>).",
    );
    expect(prompt).toContain("Large work: `sessions_spawn`; completion push-based.");
    expect(prompt).toContain("Never loop-poll `subagents list`/`sessions_list`");
    expect(prompt).not.toContain("use `sessions_yield` when waiting");
    expect(prompt).toContain(
      "First-class tool exists: use it; never ask user for equivalent CLI/slash.",
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
    expect(withYield).toContain("wait with `sessions_yield`");
  });

  it("limits screen guidance to web/app tool surfaces", () => {
    const withoutScreen = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions"],
    });
    const withScreen = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions", "screen"],
    });

    expect(withoutScreen).not.toContain("web/app turn may drive UI");
    expect(withScreen).toContain("- screen: Drive operator web UI");
    expect(withScreen).toContain(
      "`screen` present: web/app turn may drive UI; messaging turn: don't.",
    );
  });

  it("guides visible terminal work separately from quiet exec", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["exec", "terminal"],
    });

    expect(prompt).toContain(
      "- terminal: Own visible shell. Use for long/interactive jobs user should watch. exec for quiet work",
    );
  });

  it("lists available tools when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["exec", "sessions_list", "sessions_history", "sessions_send"],
    });

    expect(prompt).toContain("Tools policy-filtered.");
    expect(prompt).toContain("sessions_list");
    expect(prompt).toContain("sessions_history");
    expect(prompt).toContain("sessions_send");
  });

  it("uses provider-neutral web_search prompt metadata", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["web_search"],
    });

    expect(prompt).toContain("- web_search: Web search");
    expect(prompt).not.toContain("Brave API");
  });

  it("keeps the OpenClaw empty-tool fallback on the main prompt surface", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: [],
    });

    expect(prompt).toContain("OpenClaw lists the standard tools above");
    expect(prompt).toContain("- sessions_spawn: spawn an isolated sub-agent session");
  });

  it("documents ACP sessions_spawn agent targeting requirements", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
      acpEnabled: true,
    });

    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain("ACP needs agentId unless default");
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
    expect(prompt).toContain('"Do in claude code/cursor/gemini/opencode" = ACP intent');
    expect(prompt).toContain(
      'Discord ACP default: persistent thread (`thread:true`, `mode:"session"`)',
    );
    expect(prompt).toContain("never route ACP via `subagents`/`agents_list`/local PTY");
    expect(prompt).toContain(
      'ACP thread: only `sessions_spawn(runtime:"acp", thread:true)`; never `message(thread-create)`',
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

    expect(prompt).toContain('"Do in claude code/cursor/gemini/opencode" = ACP intent');
    expect(prompt).not.toContain("default ACP harness requests to thread-bound");
    expect(prompt).not.toContain('sessions_spawn(runtime:"acp", thread:true)');
  });

  it("omits ACP harness guidance when ACP is disabled", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      acpEnabled: false,
    });

    expect(prompt).not.toContain('"Do in claude code/cursor/gemini/opencode" = ACP intent');
    expect(prompt).not.toContain("Native Codex app-server plugin is available");
    expect(prompt).not.toContain("ACP needs agentId");
    expect(prompt).not.toContain("not ACP harness ids");
    expect(prompt).toContain("- sessions_spawn: Spawn isolated subagent");
    expect(prompt).toContain("- agents_list: List allowed subagent ids");
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

    expect(prompt).not.toContain("ACP needs agentId");
    expect(prompt).not.toContain("ACP harness ids follow acp.allowedAgents");
    expect(prompt).not.toContain('"Do in claude code/cursor/gemini/opencode" = ACP intent');
    expect(prompt).not.toContain('sessions_spawn(runtime:"acp", thread:true)');
    expect(prompt).toContain("Sandbox blocks ACP spawn");
    expect(prompt).toContain('`sessions_spawn(runtime:"subagent")`');
    expect(prompt).toContain('Use `sessions_spawn(runtime:"subagent")`.');
  });

  it("preserves tool casing in the prompt", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["Read", "Exec", "process"],
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("- Read: Read files");
    expect(prompt).toContain("- Exec: Run shell");
    expect(prompt).toContain(
      "Scan <available_skills>. Clear match: read exact <location> with `Read`; obey.",
    );
    expect(prompt).not.toContain("<location>/SKILL.md");
    expect(prompt).toContain("Changed <version>: re-read");
    expect(prompt).toContain("Several: most specific");
    expect(prompt).toContain("Docs: /tmp/openclaw/docs");
    expect(prompt).toContain(
      "OpenClaw behavior questions: docs first via `Read`/local search. AGENTS/project/workspace/profile/memory = instructions/user memory, not product design truth.",
    );
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
    expect(prompt).toContain(
      "OpenClaw behavior questions: docs first via `read`/local search. AGENTS/project/workspace/profile/memory = instructions/user memory, not product design truth.",
    );
    expect(prompt).toContain("If docs are silent/stale, say so and inspect local source.");
  });

  it("keeps self-knowledge docs guidance concise and authoritative", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
      sourcePath: "/tmp/openclaw",
      toolNames: ["read", "memory_search"],
    });
    const docsStart = prompt.indexOf("## Documentation");
    const nextSection = prompt.indexOf("\n## ", docsStart + 1);
    const docsSection = prompt.slice(docsStart, nextSection);

    expect(prompt).toContain(
      "OpenClaw behavior questions: docs first via `read`/local search. AGENTS/project/workspace/profile/memory = instructions/user memory, not product design truth.",
    );
    expect(docsSection.length).toBeLessThan(840);
    expect(prompt).not.toContain("Self-knowledge rule: for questions about");
    expect(prompt).not.toContain("Treat questions about daily notes");
    expect(prompt).not.toContain("never answer from AGENTS.md/project context");
  });

  it("falls back to public docs and GitHub source guidance when local docs are unavailable", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/work",
    });

    expect(prompt).toContain("Docs: https://docs.openclaw.ai");
    expect(prompt).toContain("Source: https://github.com/openclaw/openclaw");
    expect(prompt).toContain(
      "OpenClaw behavior questions: docs mirror first when web exists. AGENTS/project/workspace/profile/memory = instructions/user memory, not product design truth.",
    );
    expect(prompt).toContain("If docs are silent/stale, say so and inspect GitHub source.");
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
    expect(prompt).toContain("BOOTSTRAP.md below; follow before normal reply.");
    expect(prompt).toContain("Can finish BOOTSTRAP.md here: do it.");
    expect(prompt).toContain("brief blocker");
    expect(prompt).toContain("simplest next step");
    expect(prompt).toContain("Never claim completion early");
    expect(prompt).toContain("First visible reply must follow BOOTSTRAP.md");
    expect(prompt).toContain("## /tmp/openclaw/BOOTSTRAP.md");
    expect(prompt).toContain("Ask who I am.");
    expect(prompt.match(/## \/tmp\/openclaw\/BOOTSTRAP\.md/g)).toHaveLength(1);
    expect(prompt.match(/Ask who I am\./g)).toHaveLength(1);
  });

  it("uses limited bootstrap wording for constrained user-facing runs", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      bootstrapMode: "limited",
    });

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain("cannot safely finish full BOOTSTRAP.md");
    expect(prompt).toContain("Never claim complete");
    expect(prompt).toContain("no generic first greeting");
    expect(prompt).toContain("primary interactive run with normal workspace access");
  });

  it("omits bootstrap instructions when bootstrap is not pending", () => {
    for (const bootstrapMode of ["none", undefined] as const) {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        ...(bootstrapMode ? { bootstrapMode } : {}),
      });

      expect(prompt).not.toContain("## Bootstrap Pending");
    }
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
    expect(prompt).toContain("Need date/time/day");
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
    expect(prompt).toContain("Model override: prefer alias");
    expect(prompt).toContain("- Opus: anthropic/claude-opus-4-5");
  });

  it("keeps gateway guidance read-only", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["gateway", "exec"],
    });

    expect(prompt).toContain(
      "Config read: `gateway` (`config.get|config.schema.lookup`). Write/restart unavailable; ask human.",
    );
    expect(prompt).not.toContain("config.patch");
    expect(prompt).not.toContain("config.apply");
    expect(prompt).not.toContain("`config.schema.lookup|get|patch|apply`, `restart`");
    expect(prompt).not.toContain("update.run");
    expect(prompt).not.toContain("Use config.schema to");
    expect(prompt).not.toContain("config.schema, config.apply");
  });

  it("delegates system changes when openclaw tool is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["openclaw", "sessions_spawn"],
    });

    expect(prompt).toContain(
      "Config, channels, plugins, new agents, model/provider, updates: ask `openclaw`.",
    );
    expect(prompt).toContain("Never write own config; OpenClaw is system expert.");
    expect(prompt).toContain("`visible:true` only web/app user or asked.");
  });

  it("omits openclaw delegation guidance without the tool", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["gateway"],
    });

    expect(prompt).not.toContain("ask `openclaw`");
  });

  it("includes skills guidance when skills prompt is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
    });

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain(
      "Scan <available_skills>. Clear match: read exact <location> with `read`; obey.",
    );
    expect(prompt).not.toContain("<location>/SKILL.md");
    expect(prompt).toContain("Changed <version>: re-read");
    expect(prompt).toContain("Several: most specific");
  });

  it("instructs models to use skill_workshop only when the tool is available", () => {
    const section = buildSkillWorkshopPromptSection();
    expect(section).toEqual([
      "## Skill Workshop",
      "Durable reusable skill/playbook/workflow work: `skill_workshop`; never write proposal/skill files directly.",
      "Generated = pending proposal. Apply/reject/quarantine only explicit user ask.",
      "proposal_content = complete final skill body, never plan/diff; update/revise preserves unchanged content.",
      "",
    ]);

    const withoutTool = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
    });
    expect(withoutTool).not.toContain("## Skill Workshop");
    expect(withoutTool).not.toContain("Durable reusable skill/playbook/workflow work");

    const withTool = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read", "skill_workshop"],
    });
    expect(withTool).toContain("- skill_workshop: Manage reusable-skill proposals");
    expect(withTool).toContain("## Skill Workshop");
    expect(withTool).toContain("Durable reusable skill/playbook/workflow work");
    expect(withTool).toContain("Generated = pending proposal");
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

  it("adds MEMORY guidance when a memory file is present", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        {
          path: "MEMORY.md",
          content: "NEVER use [[tts:...]] or TTS commands; ALWAYS use local Piper.",
        },
      ],
      ttsHint:
        "Voice (TTS) is enabled.\nUse [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
    });

    expect(prompt).toContain(
      "MEMORY.md: durable preferences/behavior; follow all session unless higher priority overrides.",
    );
    expect(prompt.indexOf("NEVER use [[tts:...]]")).toBeGreaterThan(-1);
    expect(prompt.lastIndexOf("## Voice (TTS)")).toBeGreaterThan(
      prompt.indexOf("NEVER use [[tts:...]]"),
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

    expect(prompt).toContain("message: Message/channel actions");
    expect(prompt).toContain("### message tool");
    expect(prompt).toContain("Proactive send/channel action");
    expect(prompt).toContain("`send`: `target` + `message`.");
    expect(prompt).toContain(
      `No source default: proactive send needs \`channel\`; ids: ${channelOptions}.`,
    );
    expect(prompt).toContain(`final ONLY ${SILENT_REPLY_TOKEN}`);
  });

  it("keeps channel choice guidance lean when message sends have a source channel", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
      },
    });

    expect(prompt).toContain("Set `channel` only outside current/default source.");
    expect(prompt).not.toContain("No source default");
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

    expect(messagingPrompt).not.toContain("- Subagents:");
    expect(messagingPrompt).not.toContain("- Subagents: `sessions_spawn`");
    expect(messagingPrompt).not.toContain("subagents(action=list)");

    expect(spawnOnlyPrompt).toContain(
      '- Subagents: `sessions_spawn` with objective/output/write-scope/verification; stable handle needs `taskName`; isolated omits `context`, transcript needs `context:"fork"`.',
    );
    expect(spawnOnlyPrompt).not.toContain("manage already-spawned children");

    expect(orchestrationPrompt).toContain(
      '- Subagents: `sessions_spawn` with objective/output/write-scope/verification; stable handle needs `taskName`; isolated omits `context`, transcript needs `context:"fork"`; `subagents(action=list)` only status/debug.',
    );
    expect(orchestrationWaitPrompt).toContain("wait via `sessions_yield`");
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
    expect(preferPrompt).toContain("You coordinate; children do non-trivial work");
    expect(preferPrompt).toContain("Otherwise use `sessions_spawn`");
    expect(preferPrompt).toContain("objective, output, inputs/files");
    expect(preferPrompt).toContain("lowercase `taskName` (underscores/hyphens)");
    expect(preferPrompt).toContain("Child output = evidence");
    expect(preferPrompt).toContain("`subagents(action=list)` only for requested status");
  });

  it("adds run-scoped Ultra orchestration only when sessions_spawn is callable", () => {
    const base = {
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
      subagentDelegationMode: "prefer",
    } satisfies Parameters<typeof buildAgentSystemPrompt>[0];
    const maxPrompt = buildAgentSystemPrompt(base);
    const ultraPrompt = buildAgentSystemPrompt({
      ...base,
      proactiveSubagentOrchestration: true,
    });
    const deferredUltraPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["tool_search"],
      capabilityToolNames: ["sessions_spawn"],
      proactiveSubagentOrchestration: true,
    });
    const minimalUltraPrompt = buildAgentSystemPrompt({
      ...base,
      promptMode: "minimal",
      proactiveSubagentOrchestration: true,
    });
    const unavailablePrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["subagents"],
      proactiveSubagentOrchestration: true,
    });
    const rawPrompt = buildAgentSystemPrompt({
      ...base,
      promptMode: "none",
      proactiveSubagentOrchestration: true,
    });

    expect(maxPrompt).not.toContain("## Proactive Sub-Agent Orchestration");
    expect(ultraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(ultraPrompt).toContain("Ultra active");
    expect(ultraPrompt).not.toContain("Mode: prefer");
    expect(deferredUltraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(minimalUltraPrompt).toContain("## Proactive Sub-Agent Orchestration");
    expect(unavailablePrompt).not.toContain("## Proactive Sub-Agent Orchestration");
    expect(rawPrompt).not.toContain("## Proactive Sub-Agent Orchestration");
  });

  it("omits prefer delegation guidance when sessions_spawn is unavailable", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["subagents"],
      subagentDelegationMode: "prefer",
    });

    expect(prompt).not.toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("- Subagents:");
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
    // The relocated exec-approval guidance stays suppressed when tool_call_style is
    // provider-overridden, preserving the "override replaces the whole section" contract.
    expect(prompt).not.toContain("If exec returns approval-pending");
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
    expect(prompt).toContain("style primary|success|danger");
  });

  it("does not embed Telegram rich-text authoring guidance in core messaging", () => {
    const telegramPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["richText"],
      },
    });
    const plainTelegramPrompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
      },
    });

    expect(telegramPrompt).not.toContain("Telegram rich ON");
    expect(telegramPrompt).not.toContain("Telegram rich OFF");
    expect(plainTelegramPrompt).not.toContain("Telegram rich ON");
    expect(plainTelegramPrompt).not.toContain("Telegram rich OFF");
    expect(telegramPrompt).toContain("final text normally routes to source");
  });

  it("describes source replies without the message tool", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
      },
    });

    expect(prompt).toContain("final text normally routes to source");
    expect(prompt).toContain("If turn says final private");
    expect(prompt).not.toContain("### message tool");
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

  it.each(["group", "channel"] as const)(
    "describes message-tool-only source delivery for Discord %s without requiring target",
    (chatType) => {
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        toolNames: ["message"],
        sourceReplyDeliveryMode: "message_tool_only",
        runtimeInfo: {
          channel: "discord",
          chatType,
        },
      });

      expect(prompt).toContain("Current source visible reply MUST use `message(action=send)`");
      expect(prompt).toContain("Skip tool = user gets nothing");
      expect(prompt).toContain(
        "Media paths = attachments, not prose. One: `media`; many: `attachments: [{media: ...}]`.",
      );
      expect(prompt).not.toContain("Attach media: `MEDIA:<path-or-url>`");
      expect(prompt).toContain(
        "Group/channel: stale/joke/light ack/low-value chatter => reaction or silence. Needed reply => `message(action=send)`; final text private.",
      );
      expect(prompt).toContain("current source is default target");
      expect(prompt).toContain("never repeat in final");
      expect(prompt).not.toContain("## Silent Replies");
      expect(prompt).not.toContain(SILENT_REPLY_TOKEN);
      expect(prompt).not.toContain(`final ONLY ${SILENT_REPLY_TOKEN}`);
      expect(prompt).not.toContain("`send`: `target` + `message`.");
    },
  );

  it("requires an explicit target for message-tool-only turns when requested", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
      runtimeInfo: {
        channel: "telegram",
        chatType: "group",
      },
    });

    expect(prompt).toContain("`send`: `target` + `message`; target required this turn");
    expect(prompt).toContain(
      "Group/channel: stale/joke/light ack/low-value chatter => reaction or silence. Needed reply => `message(action=send)`; final text private.",
    );
    expect(prompt).not.toContain("current source is default target");
  });

  it("tells automatic source delivery to expose generated media as MEDIA directives", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "telegram",
      },
    });

    expect(prompt).toContain("Media attachment: own line `MEDIA:<path-or-url>` per item");
    expect(prompt).toContain("path is not prose");
  });

  it("keeps group/channel etiquette scoped to message-tool-only delivery", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "discord",
        chatType: "group",
      },
    });

    expect(prompt).not.toContain("Group/channel:");
  });

  it("omits group/channel etiquette for direct message-tool-only delivery", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      sourceReplyDeliveryMode: "message_tool_only",
      runtimeInfo: {
        channel: "discord",
        chatType: "direct",
      },
    });

    expect(prompt).toContain("Current source visible reply MUST use `message(action=send)`");
    expect(prompt).not.toContain("Group/channel:");
  });

  it("suppresses plain chat approval commands when inline approval UI is available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
    });

    expect(prompt).toContain("native card/buttons first");
    expect(prompt).toContain("Plain /approve only when");
  });

  it("suppresses plain chat approval commands for native approval runtimes", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "whatsapp",
        capabilities: ["nativeApprovals"],
      },
    });

    expect(prompt).toContain("native card/buttons first");
    expect(prompt).toContain("Plain /approve only when");
  });

  it("keeps approval slug guidance separate from command previews", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "discord",
      },
    });

    expect(prompt).toContain('copy exact "Reply with:" command');
    expect(prompt).toContain("Keep preview separate from /approve");
    expect(prompt).toContain("never use script as approval id/slug");
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

  it("includes agent and session identity in runtime when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "work",
        sessionKey: "agent:main:main",
        sessionId: "23ae7fce-3c27-4a51-b58e-d800d8ca091f",
        host: "host",
        os: "macOS",
        arch: "arm64",
        node: "v20",
        model: "anthropic/claude",
      },
    });

    expect(prompt).toContain("agent=work");
    expect(prompt).toContain("session=agent:main:main");
    expect(prompt).toContain("sessionId=23ae7fce-3c27-4a51-b58e-d800d8ca091f");
  });

  it("includes reasoning visibility hint", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      reasoningLevel: "off",
    });

    expect(prompt).toContain("Reasoning=off");
    expect(prompt).toContain("/reasoning");
    expect(prompt).toContain("/status shows when enabled");
  });

  it("builds runtime line with agent and channel details", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "work",
        sessionKey: "agent:main:subagent:runtime-check",
        sessionId: "23ae7fce-3c27-4a51-b58e-d800d8ca091f",
        host: "host",
        repoRoot: "/repo",
        os: "macOS",
        arch: "arm64",
        node: "v20",
        model: "anthropic/claude",
        defaultModel: "anthropic/claude-opus-4-5",
        activeNode: "mac-123",
        channel: "telegram",
        capabilities: ["inlineButtons"],
      },
      defaultThinkLevel: "low",
    });

    expect(prompt).toContain("agent=work");
    expect(prompt).toContain("session=agent:main:subagent:runtime-check");
    expect(prompt).toContain("sessionId=23ae7fce-3c27-4a51-b58e-d800d8ca091f");
    expect(prompt).toContain("host=host");
    expect(prompt).toContain("repo=/repo");
    expect(prompt).toContain("os=macOS (arm64)");
    expect(prompt).toContain("node=v20");
    expect(prompt).toContain("model=anthropic/claude");
    expect(prompt).toContain("default_model=anthropic/claude-opus-4-5");
    expect(prompt).toContain("active_node=mac-123");
    expect(prompt).toContain("channel=telegram");
    expect(prompt).toContain("capabilities=inlinebuttons");
    expect(prompt).toContain("thinking=low");
  });

  it("keeps the runtime line cache-stable across isolated cron runs", () => {
    // Isolated cron run-scoped keys carry a fresh per-run id every run (forceNew). Rendering it
    // verbatim re-busts byte-exact prefix caching for the tool catalog after it (#96677 / #43148).
    const buildForRun = (runId: string) =>
      buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        runtimeInfo: {
          agentId: "work",
          sessionKey: `agent:work:cron:nightly-job:run:${runId}`,
          sessionId: runId,
          host: "host",
          os: "linux",
        },
      });
    const promptA = buildForRun("11111111-1111-1111-1111-111111111111");
    const promptB = buildForRun("22222222-2222-2222-2222-222222222222");

    expect(promptA).toContain("session=agent:work:cron:nightly-job");
    expect(promptA).not.toContain(":run:");
    expect(promptA).not.toContain("sessionId=");
    // Two runs of the same job render identical bytes, so the cached prefix is reused.
    expect(promptA).toBe(promptB);
  });

  it("preserves a stable session id that is not the run-scope id", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        agentId: "work",
        sessionKey: "agent:work:cron:nightly-job:run:run-id",
        sessionId: "stable-session-id",
        host: "host",
        os: "linux",
      },
    });

    expect(prompt).toContain("session=agent:work:cron:nightly-job");
    expect(prompt).toContain("sessionId=stable-session-id");
  });

  it("renders extra system prompt exactly once", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      extraSystemPrompt: "Custom runtime context",
    });

    expect(prompt.match(/Custom runtime context/g)).toHaveLength(1);
    expect(prompt.match(/## Conversation Context/g)).toHaveLength(1);
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

    expect(prompt).toContain("Working directory: /workspace");
    expect(prompt).toContain(
      "File tools use host workspace /tmp/openclaw. exec uses container /workspace or relative workdir paths; never host paths.",
    );
    expect(prompt).toContain("Sandbox container workdir: /workspace");
    expect(prompt).toContain(
      "Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): /tmp/sandbox",
    );
    expect(prompt).toContain("Sandbox runtime; tools execute in Docker");
    expect(prompt).toContain("Subagents remain sandboxed");
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
    expect(prompt).toContain("Telegram reactions: MINIMAL.");
  });

  it("keeps exec-approval and authorized-sender guidance below the stable prefix", () => {
    const baseParams = {
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
      ownerNumbers: ["+123"],
      runtimeInfo: {
        channel: "webchat",
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
    } satisfies Parameters<typeof buildAgentSystemPrompt>[0];
    const prompt = buildAgentSystemPrompt(baseParams);

    const projectContextPos = prompt.indexOf("# Project Context");
    const boundaryPos = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const messagingPos = prompt.lastIndexOf("## Messaging");
    const conversationContextPos = prompt.lastIndexOf("## Conversation Context");
    const reactionsPos = prompt.lastIndexOf("## Reactions");
    const voicePos = prompt.lastIndexOf("## Voice (TTS)");
    // These sections vary with approval UI capabilities and owner identity, so
    // both must stay below the stable prefix boundary.
    const approvalPos = prompt.lastIndexOf("native card/buttons first");
    const authorizedSendersPos = prompt.lastIndexOf("## Authorized Senders");

    expect(projectContextPos).toBeGreaterThan(-1);
    expect(boundaryPos).toBeGreaterThan(projectContextPos);
    expect(messagingPos).toBeGreaterThan(boundaryPos);
    expect(conversationContextPos).toBeGreaterThan(boundaryPos);
    expect(reactionsPos).toBeGreaterThan(boundaryPos);
    expect(voicePos).toBeGreaterThan(boundaryPos);
    expect(approvalPos).toBeGreaterThan(boundaryPos);
    expect(authorizedSendersPos).toBeGreaterThan(boundaryPos);

    const stablePrefix = prompt.slice(0, boundaryPos);
    const otherOwnerPrompt = buildAgentSystemPrompt({
      ...baseParams,
      ownerNumbers: ["+456"],
    });
    const manualApprovalPrompt = buildAgentSystemPrompt({
      ...baseParams,
      runtimeInfo: { channel: "webchat", capabilities: [] },
    });
    expect(otherOwnerPrompt).toContain("Allowlisted senders: +456");
    expect(otherOwnerPrompt).not.toContain("Allowlisted senders: +123");
    expect(manualApprovalPrompt).toContain("send exact /approve");
    expect(manualApprovalPrompt).not.toContain("native card/buttons first");
    for (const variant of [otherOwnerPrompt, manualApprovalPrompt]) {
      expect(variant.slice(0, variant.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY))).toBe(stablePrefix);
    }
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
    expect(prompt).toContain("May `sessions_spawn` for parallel/complex work");
    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain('runtime:"acp"');
    expect(prompt).toContain("ACP harness:");
    expect(prompt).toContain("set `agentId` unless default");
    expect(prompt).toContain("Never ask user for slash/CLI");
    expect(prompt).toContain("exec openclaw/acpx");
    expect(prompt).toContain("`agents_list`/`subagents` = OpenClaw runtime=subagent only");
    expect(prompt).toContain("Subagent results auto-announce");
    expect(prompt).toContain("never sessions_list/history, exec sleep, or poll loops");
    expect(prompt).toContain("Need wait: `sessions_yield`");
    expect(prompt).toContain("objective, output, inputs/files, write scope");
    expect(prompt).toContain("Track expected session keys");
    expect(prompt).toContain("Late completion after final: reply ONLY NO_REPLY");
    expect(prompt).toContain("No polling");
    expect(prompt).toContain("spawned by main agent");
    expect(prompt).toContain("auto-reported to main agent");
    expect(prompt).toContain("Truncation notice");
    expect(prompt).toContain("offset/limit");
    expect(prompt).toContain("no full cat");
    expect(prompt).toContain(
      "No external message unless explicitly tasked to message specific recipient/channel",
    );
  });

  it("keeps delegated task text out of the system prompt", () => {
    const task = "line one\n  line two\n  line three";
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task,
      childDepth: 1,
      maxSpawnDepth: 1,
    });

    expect(prompt).toContain("## Your Role");
    expect(prompt).toContain("First visible `[Subagent Task]`");
    expect(prompt).not.toContain("line one");
    expect(prompt).not.toContain("  line two");
    expect(prompt).not.toContain("  line three");
  });

  it("omits ACP spawning guidance when ACP is disabled", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
      acpEnabled: false,
    });

    expect(prompt).not.toContain('runtime:"acp"');
    expect(prompt).not.toContain("ACP harness:");
    expect(prompt).not.toContain("set `agentId` unless default");
    expect(prompt).toContain("May `sessions_spawn`");
  });

  it("renders subagent-scoped native command guidance when ACP is disabled", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
      acpEnabled: false,
      nativeCommandGuidanceLines: ["Subagent-only command guidance."],
    });

    expect(prompt).toContain("Subagent-only command guidance.");
    expect(prompt).not.toContain('runtime:"acp"');
  });

  it("omits ACP spawning guidance by default", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
    });

    expect(prompt).not.toContain('runtime:"acp"');
    expect(prompt).not.toContain("ACP harness:");
    expect(prompt).toContain("May `sessions_spawn`");
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
    expect(prompt).toContain("Leaf worker");
    expect(prompt).toContain("cannot spawn");
    expect(prompt).toContain("spawned by parent orchestrator");
    expect(prompt).toContain("auto-reported to parent orchestrator");
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
      expect(prompt, testCase.name).not.toContain("May `sessions_spawn`");
      if (testCase.expectMainAgentLabel) {
        expect(prompt, testCase.name).toContain("spawned by main agent");
      }
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
