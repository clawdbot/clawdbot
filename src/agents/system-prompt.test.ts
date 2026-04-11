import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { typedCases } from "../test-utils/typed-cases.js";
import { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./system-prompt-cache-boundary.js";
import { buildAgentSystemPrompt, buildRuntimeLine } from "./system-prompt.js";

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

    expect(tokenA).toBeDefined();
    expect(tokenB).toBeDefined();
    expect(tokenA).not.toBe(tokenB);
  });

  it("omits extended sections in minimal prompt mode", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
      ownerNumbers: ["+123"],
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      heartbeatPrompt: "ping",
      toolNames: ["message", "memory_search", "cron"],
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
      'For follow-up at a future time (for example "check back in 10 minutes", reminders, run-later work, or recurring tasks), use cron instead of exec sleep, yieldMs delays, or process polling.',
    );
    expect(prompt).toContain(
      "Use exec/process only for commands that start now and continue running in the background.",
    );
    expect(prompt).toContain(
      "For long-running work that starts now, start it once and rely on automatic completion wake when it is enabled and the command emits output or fails; otherwise use process to confirm completion, and use it for logs, status, input, or intervention.",
    );
    expect(prompt).toContain(
      "Do not emulate scheduling with sleep loops, timeout loops, or repeated polling.",
    );
    expect(prompt).toContain("You have no independent goals");
    expect(prompt).toContain("Prioritize safety and human oversight");
    expect(prompt).toContain("if instructions conflict");
    expect(prompt).toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Do not manipulate or persuade anyone");
    expect(prompt).toContain("Do not copy yourself or change system prompts");
    expect(prompt).toContain("## Subagent Context");
    expect(prompt).not.toContain("## Group Chat Context");
    expect(prompt).toContain("Subagent details");
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

    expect(prompt).toContain("## Skills (mandatory)");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain(
      "When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.",
    );
  });

  it("tells the agent not to execute /approve through exec", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain(
      "Never execute /approve through exec or any other shell/tool path; /approve is a user-facing approval command, not a shell command.",
    );
  });

  it("adds stronger execution-bias guidance for actionable turns", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## Execution Bias");
    expect(prompt).toContain(
      "If the user asks you to do the work, start doing it in the same turn.",
    );
    expect(prompt).toContain(
      "Commentary-only turns are incomplete when tools are available and the next action is clear.",
    );
  });

  it("narrows silent reply guidance to true no-delivery cases", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain(
      `Use ${SILENT_REPLY_TOKEN} ONLY when no user-visible reply is required.`,
    );
    expect(prompt).toContain(
      "Never use it to avoid doing requested work or to end an actionable turn early.",
    );
  });

  it("keeps manual /approve instructions for non-native approval channels", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: { channel: "signal" },
    });

    expect(prompt).toContain(
      "When exec returns approval-pending, include the concrete /approve command from tool output",
    );
    expect(prompt).not.toContain("allow-once|allow-always|deny");
  });

  it("tells native approval channels not to duplicate plain chat /approve instructions", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: { channel: "telegram", capabilities: ["inlineButtons"] },
    });

    expect(prompt).toContain(
      "When exec returns approval-pending on this channel, rely on native approval card/buttons when they appear and do not also send plain chat /approve instructions. Only include the concrete /approve command if the tool result says chat approvals are unavailable or only manual approval is possible.",
    );
    expect(prompt).toContain(
      "Only include the concrete /approve command if the tool result says chat approvals are unavailable or only manual approval is possible.",
    );
    expect(prompt).not.toContain(
      "When exec returns approval-pending, include the concrete /approve command from tool output",
    );
  });

  it("treats webchat as a native approval surface", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: { channel: "webchat" },
    });

    expect(prompt).toContain(
      "When exec returns approval-pending on this channel, rely on native approval card/buttons when they appear",
    );
    expect(prompt).toContain(
      "Only include the concrete /approve command if the tool result says chat approvals are unavailable or only manual approval is possible.",
    );
    expect(prompt).not.toContain(
      "When exec returns approval-pending, include the concrete /approve command from tool output",
    );
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

    expect(prompt).toContain("## Reply Tags");
    expect(prompt).toContain("[[reply_to_current]]");
    expect(prompt).not.toContain("Tags are stripped before sending");
    expect(prompt).toContain("Tags are removed before sending");
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
    expect(prompt).toContain("You have no independent goals");
    expect(prompt).toContain("Prioritize safety and human oversight");
    expect(prompt).toContain("if instructions conflict");
    expect(prompt).toContain("Inspired by Anthropic's constitution");
    expect(prompt).toContain("Do not manipulate or persuade anyone");
    expect(prompt).toContain("Do not copy yourself or change system prompts");
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

  it("includes a CLI quick reference section", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## OpenClaw CLI Quick Reference");
    expect(prompt).toContain("openclaw gateway restart");
    expect(prompt).toContain("Do not invent commands");
  });

  it("guides runtime completion events without exposing internal metadata", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("Runtime-generated completion events may ask for a user update.");
    expect(prompt).toContain("Rewrite those in your normal assistant voice");
    expect(prompt).toContain("do not forward raw internal metadata");
  });

  it("guides subagent workflows to avoid polling loops", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain(
      'For follow-up at a future time (for example "check back in 10 minutes", reminders, run-later work, or recurring tasks), use cron instead of exec sleep, yieldMs delays, or process polling.',
    );
    expect(prompt).toContain(
      "Use exec/process only for commands that start now and continue running in the background.",
    );
    expect(prompt).toContain(
      "For long-running work that starts now, start it once and rely on automatic completion wake when it is enabled and the command emits output or fails; otherwise use process to confirm completion, and use it for logs, status, input, or intervention.",
    );
    expect(prompt).toContain("Completion is push-based: it will auto-announce when done.");
    expect(prompt).toContain("Do not poll `subagents list` / `sessions_list` in a loop");
    expect(prompt).toContain(
      "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
    );
  });

  it("uses structured tool definitions as the source of truth", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["exec", "sessions_list", "sessions_history", "sessions_send"],
    });

    expect(prompt).toContain(
      "Structured tool definitions are the source of truth for tool names, descriptions, and parameters.",
    );
    expect(prompt).toContain(
      "Tool names are case-sensitive. Call tools exactly as listed in the structured tool definitions.",
    );
    expect(prompt).toContain(
      "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    );
    expect(prompt).not.toContain("Tool availability (filtered by policy):");
    expect(prompt).not.toContain("- sessions_list:");
    expect(prompt).not.toContain("- sessions_history:");
    expect(prompt).not.toContain("- sessions_send:");
  });

  it("documents ACP sessions_spawn agent targeting requirements", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn"],
    });

    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain("Set `agentId` explicitly unless `acp.defaultAgent` is configured");
    expect(prompt).toContain("`subagents`/`agents_list`");
  });

  it("guides harness requests to ACP thread-bound spawns", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
    });

    expect(prompt).toContain(
      'For requests like "do this in codex/claude code/cursor/gemini" or similar ACP harnesses, treat it as ACP harness intent',
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

  it("omits ACP harness guidance when ACP is disabled", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      acpEnabled: false,
    });

    expect(prompt).not.toContain(
      'For requests like "do this in codex/claude code/gemini", treat it as ACP harness intent',
    );
    expect(prompt).not.toContain('runtime="acp" requires `agentId`');
    expect(prompt).not.toContain("not ACP harness ids");
    expect(prompt).toContain(
      "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
    );
  });

  it("omits ACP harness spawn guidance for sandboxed sessions and shows ACP block note", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents", "agents_list", "exec"],
      sandboxInfo: {
        enabled: true,
      },
    });

    expect(prompt).not.toContain('runtime="acp" requires `agentId`');
    expect(prompt).not.toContain("ACP harness ids follow acp.allowedAgents");
    expect(prompt).not.toContain(
      'For requests like "do this in codex/claude code/gemini", treat it as ACP harness intent',
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

    expect(prompt).toContain(
      "Tool names are case-sensitive. Call tools exactly as listed in the structured tool definitions.",
    );
    expect(prompt).toContain(
      "For long waits, avoid rapid poll loops: use Exec with enough yieldMs or process(action=poll, timeout=<ms>).",
    );
    expect(prompt).toContain(
      "- If exactly one skill clearly applies: read its SKILL.md at <location> with `Read`, then follow it.",
    );
    expect(prompt).toContain("OpenClaw docs: /tmp/openclaw/docs");
    expect(prompt).toContain(
      "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
    );
  });

  it("adds update_plan guidance only when the tool is available", () => {
    const promptWithPlan = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["exec", "update_plan"],
    });
    const promptWithoutPlan = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["exec"],
    });

    expect(promptWithPlan).toContain(
      "For non-trivial multi-step work, keep a short plan updated with `update_plan`.",
    );
    expect(promptWithPlan).toContain(
      "When you use `update_plan`, keep exactly one step `in_progress` until the work is done.",
    );
    expect(promptWithoutPlan).not.toContain("keep a short plan updated with `update_plan`");
  });

  it("includes docs guidance when docsPath is provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      docsPath: "/tmp/openclaw/docs",
    });

    expect(prompt).toContain("## Documentation");
    expect(prompt).toContain("OpenClaw docs: /tmp/openclaw/docs");
    expect(prompt).toContain(
      "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
    );
  });

  it("includes workspace notes when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      workspaceNotes: ["Reminder: commit your changes in this workspace after edits."],
    });

    expect(prompt).toContain("Reminder: commit your changes in this workspace after edits.");
  });

  it("shows timezone section for 12h, 24h, and timezone-only modes", () => {
    const cases = [
      {
        name: "12-hour",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTime: "Monday, January 5th, 2026 - 3:26 PM",
          userTimeFormat: "12" as const,
        },
      },
      {
        name: "24-hour",
        params: {
          workspaceDir: "/tmp/openclaw",
          userTimezone: "America/Chicago",
          userTime: "Monday, January 5th, 2026 - 15:26",
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
  // Agents should use session_status or message timestamps to determine the date/time.
  it("does NOT include a date or time in the system prompt (cache stability)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      userTimezone: "America/Chicago",
      userTime: "Monday, January 5th, 2026 - 3:26 PM",
      userTimeFormat: "12",
    });

    // The prompt should contain the timezone but NOT the formatted date/time string.
    // This is intentional for prompt cache stability. If you want to add date/time
    // awareness, do it through gateway-level timestamp injection into messages, not
    // the system prompt.
    expect(prompt).toContain("Time zone: America/Chicago");
    expect(prompt).not.toContain("Monday, January 5th, 2026");
    expect(prompt).not.toContain("3:26 PM");
    expect(prompt).not.toContain("15:26");
  });

  it("includes model alias guidance when aliases are provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      modelAliasLines: [
        "- Opus: anthropic/claude-opus-4-6",
        "- Sonnet: anthropic/claude-sonnet-4-6",
      ],
    });

    expect(prompt).toContain("## Model Aliases");
    expect(prompt).toContain("Prefer aliases when specifying model overrides");
    expect(prompt).toContain("- Opus: anthropic/claude-opus-4-6");
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
      "- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.",
    );
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
      "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
    );
  });

  it("omits project context when no context files are injected", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [],
    });

    expect(prompt).not.toContain("# Project Context");
  });

  it("orders stable project context before the cache boundary and moves HEARTBEAT below it", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [
        { path: "HEARTBEAT.md", content: "Check inbox." },
        { path: "MEMORY.md", content: "Long-term notes." },
        { path: "AGENTS.md", content: "Follow repo rules." },
        { path: "SOUL.md", content: "Warm but direct." },
        { path: "TOOLS.md", content: "Prefer rg." },
      ],
    });

    const agentsIndex = prompt.indexOf("## AGENTS.md");
    const soulIndex = prompt.indexOf("## SOUL.md");
    const toolsIndex = prompt.indexOf("## TOOLS.md");
    const memoryIndex = prompt.indexOf("## MEMORY.md");
    const boundaryIndex = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const heartbeatHeadingIndex = prompt.indexOf("# Dynamic Project Context");
    const heartbeatFileIndex = prompt.indexOf("## HEARTBEAT.md");

    expect(agentsIndex).toBeGreaterThan(-1);
    expect(soulIndex).toBeGreaterThan(agentsIndex);
    expect(toolsIndex).toBeGreaterThan(soulIndex);
    expect(memoryIndex).toBeGreaterThan(toolsIndex);
    expect(boundaryIndex).toBeGreaterThan(memoryIndex);
    expect(heartbeatHeadingIndex).toBeGreaterThan(boundaryIndex);
    expect(heartbeatFileIndex).toBeGreaterThan(heartbeatHeadingIndex);
    expect(prompt).toContain(
      "The following frequently-changing project context files are kept below the cache boundary when possible:",
    );
  });

  it("keeps heartbeat-only project context below the cache boundary", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      contextFiles: [{ path: "HEARTBEAT.md", content: "Check inbox." }],
    });

    const boundaryIndex = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const projectContextIndex = prompt.indexOf("# Project Context");
    const heartbeatFileIndex = prompt.indexOf("## HEARTBEAT.md");

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(projectContextIndex).toBeGreaterThan(boundaryIndex);
    expect(heartbeatFileIndex).toBeGreaterThan(projectContextIndex);
    expect(prompt).not.toContain("# Dynamic Project Context");
  });

  it("replaces provider-owned prompt sections without disturbing core ordering", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptContribution: {
        sectionOverrides: {
          interaction_style: "## Interaction Style\n\nCustom interaction guidance.",
          execution_bias: "## Execution Bias\n\nCustom execution guidance.",
        },
      },
    });

    expect(prompt).toContain("## Interaction Style\n\nCustom interaction guidance.");
    expect(prompt).toContain("## Execution Bias\n\nCustom execution guidance.");
    expect(prompt).not.toContain("Bias toward action and momentum.");
  });

  it("places provider stable prefixes above the cache boundary", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptContribution: {
        stablePrefix: "## Provider Stable Block\n\nStable provider guidance.",
      },
    });

    const boundaryIndex = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const stableIndex = prompt.indexOf("## Provider Stable Block");
    const safetyIndex = prompt.indexOf("## Safety");

    expect(stableIndex).toBeGreaterThan(-1);
    expect(boundaryIndex).toBeGreaterThan(stableIndex);
    expect(safetyIndex).toBeGreaterThan(stableIndex);
  });

  it("places provider dynamic suffixes below the cache boundary", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptContribution: {
        dynamicSuffix: "## Provider Dynamic Block\n\nPer-turn provider guidance.",
      },
    });

    const boundaryIndex = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const dynamicIndex = prompt.indexOf("## Provider Dynamic Block");
    const heartbeatIndex = prompt.indexOf("## Heartbeats");

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(dynamicIndex).toBeGreaterThan(boundaryIndex);
    expect(heartbeatIndex).toBe(-1);
  });

  it("summarizes the message tool when available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["message"],
    });

    expect(prompt).toContain("### message tool");
    expect(prompt).toContain("Use `message` for proactive sends + channel actions");
    expect(prompt).toContain(`respond with ONLY: ${SILENT_REPLY_TOKEN}`);
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
        defaultModel: "anthropic/claude-opus-4-6",
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
    expect(line).toContain("default_model=anthropic/claude-opus-4-6");
    expect(line).toContain("channel=telegram");
    expect(line).toContain("capabilities=inlinebuttons");
    expect(line).toContain("thinking=low");
  });

  it("normalizes runtime capability ordering and casing for cache stability", () => {
    const line = buildRuntimeLine(
      {
        agentId: "work",
      },
      "telegram",
      [" React ", "inlineButtons", "react"],
      "low",
    );

    expect(line).toContain("capabilities=inlinebuttons,react");
  });

  it("keeps semantically equivalent structured prompt inputs byte-stable", () => {
    const clean = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
        capabilities: ["inlinebuttons", "react"],
      },
      skillsPrompt:
        "<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>",
      heartbeatPrompt: "ping",
      extraSystemPrompt: "Group chat context\nSecond line",
      workspaceNotes: ["Reminder: keep commits scoped."],
      modelAliasLines: ["- Sonnet: anthropic/claude-sonnet-4-5"],
    });
    const noisy = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      runtimeInfo: {
        channel: "telegram",
        capabilities: [" react ", "inlineButtons", "react"],
      },
      skillsPrompt:
        "<available_skills>\r\n  <skill>  \r\n    <name>demo</name>\t\r\n  </skill>\r\n</available_skills>\r\n",
      heartbeatPrompt: " ping  \r\n",
      extraSystemPrompt: "  Group chat context  \r\nSecond line \t\r\n",
      workspaceNotes: ["  Reminder: keep commits scoped. \t\r\n"],
      modelAliasLines: ["  - Sonnet: anthropic/claude-sonnet-4-5 \t\r\n"],
    });

    expect(noisy).toBe(clean);
    expect(noisy).not.toContain("\r");
    expect(noisy).not.toMatch(/[ \t]+$/m);
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
});

describe("buildSubagentSystemPrompt", () => {
  it("renders depth-1 orchestrator guidance, labels, and recovery notes", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
    });

    expect(prompt).toContain("## Sub-Agent Spawning");
    expect(prompt).toContain(
      "You CAN spawn your own sub-agents for parallel or complex work using `sessions_spawn`.",
    );
    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain('runtime: "acp"');
    expect(prompt).toContain("For ACP harness sessions (codex/claudecode/gemini)");
    expect(prompt).toContain("set `agentId` unless `acp.defaultAgent` is configured");
    expect(prompt).toContain("Do not ask users to run slash commands or CLI");
    expect(prompt).toContain("Do not use `exec` (`openclaw ...`, `acpx ...`)");
    expect(prompt).toContain("Use `subagents` only for OpenClaw subagents");
    expect(prompt).toContain("Subagent results auto-announce back to you");
    expect(prompt).toContain(
      "After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool.",
    );
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

  it("omits ACP spawning guidance when ACP is disabled", () => {
    const prompt = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:abc",
      task: "research task",
      childDepth: 1,
      maxSpawnDepth: 2,
      acpEnabled: false,
    });

    expect(prompt).not.toContain('runtime: "acp"');
    expect(prompt).not.toContain("For ACP harness sessions (codex/claudecode/gemini)");
    expect(prompt).not.toContain("set `agentId` unless `acp.defaultAgent` is configured");
    expect(prompt).toContain("You CAN spawn your own sub-agents");
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
