// Anthropic tests cover cli shared plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import {
  CLAUDE_CLI_CLEAR_ENV,
  normalizeClaudeBackendConfig,
  resolveClaudeCliAutoCompactEnv,
  resolveClaudeCliExecutionArgs,
  supportsClaudeDynamicSystemPromptSections,
} from "./cli-shared.js";
import { registerAnthropicPlugin } from "./register.runtime.js";

type ClaudePreparedExecutionWithSecret = {
  env?: Record<string, string>;
  clearEnv?: string[];
  cleanup?: () => Promise<void>;
  secretInput: {
    fd: number;
    fingerprint: string;
    createData: () => Buffer;
  };
};

const CLAUDE_CLI_DISALLOWED_TOOLS =
  "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor";
const CLAUDE_CACHE_FLAG = "--exclude-dynamic-system-prompt-sections";

describe("Claude CLI adapter equivalence", () => {
  const commonArgs = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--setting-sources",
    "user",
    "--allowedTools",
    "mcp__openclaw__*",
    "--disallowedTools",
    CLAUDE_CLI_DISALLOWED_TOOLS,
  ];

  it.each([
    { phase: "fresh", key: "args" as const, expected: commonArgs },
    {
      phase: "resume",
      key: "resumeArgs" as const,
      expected: [...commonArgs, "--resume", "{sessionId}"],
    },
  ])("preserves the legacy $phase command bytes in plugin code", ({ key, expected }) => {
    const backend = buildAnthropicCliBackend();

    expect(backend.config.command).toBe("claude");
    expect(backend.config[key]).toEqual(expected);
    expect(backend.config.env).toBeUndefined();
    expect(backend.config.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
  });

  it("privately acknowledges isolated completion preparation", () => {
    const backend = buildAnthropicCliBackend();
    const prepared = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-8",
      isolatedCompletionPrompt: "TASK: return JSON",
      isolatedCompletionSystemPrompt: "Return JSON.",
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      isolatedCompletionPrompt: string;
      isolatedCompletionSystemPrompt: string;
    }) as { env?: Record<string, string>; isolatedCompletionEnforced?: true };

    expect(prepared).toEqual({ env: {}, isolatedCompletionEnforced: true });
  });

  it("builds Claude Code's native manual compaction command", () => {
    const backend = buildAnthropicCliBackend();
    const manualCompaction = backend.manualCompaction;
    // Redacted fixtures preserve the control fields observed from Claude Code 2.0.76-2.1.226.
    const compactingStatus = { type: "system", subtype: "status", status: "compacting" };
    const compactResult = { compact_result: "success" };
    const compactBoundary = { type: "system", subtype: "compact_boundary" };

    expect(manualCompaction?.buildPrompt()).toBe("/compact");
    expect(manualCompaction?.buildPrompt(" keep operator decisions ")).toBe(
      "/compact keep operator decisions",
    );
    expect(manualCompaction?.input).toBe("arg");
    expect(
      manualCompaction?.validateOutput(
        [compactingStatus, compactResult, compactBoundary]
          .map((event) => JSON.stringify(event))
          .join("\n"),
      ),
    ).toEqual({ ok: true });
    expect(manualCompaction?.validateOutput(`${JSON.stringify(compactResult)}\n`)).toEqual({
      ok: true,
    });
    expect(manualCompaction?.validateOutput(`${JSON.stringify(compactBoundary)}\n`)).toEqual({
      ok: true,
    });
    expect(
      manualCompaction?.validateOutput(
        `${JSON.stringify(compactingStatus)}\n${JSON.stringify({ type: "system", subtype: "local_command" })}\n`,
      ),
    ).toEqual({
      ok: false,
      reason: "Claude CLI did not confirm that native compaction ran.",
    });
  });
});

describe("resolveClaudeCliAutoCompactEnv", () => {
  it("maps the effective OpenClaw context budget into Claude Code compaction", () => {
    expect(resolveClaudeCliAutoCompactEnv(100_000.9)).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
    });
  });

  it.each([undefined, 0, 0.5, Number.NaN])("rejects an invalid context budget: %s", (budget) => {
    expect(resolveClaudeCliAutoCompactEnv(budget)).toBeUndefined();
  });
});

function expectDefaultDisallowedTools(args: readonly string[] | undefined) {
  const disallowedIndex = args?.indexOf("--disallowedTools") ?? -1;
  expect(disallowedIndex).toBeGreaterThanOrEqual(0);
  expect(args?.[disallowedIndex + 1]).toBe(CLAUDE_CLI_DISALLOWED_TOOLS);
}

function normalizeClaudeArgs(
  args: string[],
  context: Parameters<typeof normalizeClaudeBackendConfig>[1] = {
    backendId: "claude-cli",
    config: { tools: { exec: { mode: "ask" } } },
  },
): string[] | undefined {
  return normalizeClaudeBackendConfig(
    { command: "claude", args, output: "json", input: "arg" },
    context,
  ).args;
}

describe("Claude backend permission args", () => {
  it("removes legacy skip-permissions without adding bypassPermissions", () => {
    expect(normalizeClaudeArgs(["-p", "--dangerously-skip-permissions", "--verbose"])).toEqual([
      "-p",
      "--verbose",
      "--setting-sources",
      "user",
    ]);
  });

  it("keeps explicit permission-mode overrides", () => {
    expect(normalizeClaudeArgs(["-p", "--permission-mode", "acceptEdits"])).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "user",
    ]);
    expect(normalizeClaudeArgs(["-p", "--permission-mode=acceptEdits"])).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
      "--setting-sources",
      "user",
    ]);
  });

  it("drops malformed permission-mode flags in both split and equals forms", () => {
    expect(
      normalizeClaudeArgs(["-p", "--permission-mode", "--output-format", "stream-json"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--setting-sources", "user"]);
    expect(normalizeClaudeArgs(["-p", "--permission-mode="])).toEqual([
      "-p",
      "--setting-sources",
      "user",
    ]);
    expect(normalizeClaudeArgs(["-p", "--permission-mode=--output-format"])).toEqual([
      "-p",
      "--setting-sources",
      "user",
    ]);
  });
});

describe("Claude backend setting sources", () => {
  it("injects user-only setting sources when args omit the flag", () => {
    expect(normalizeClaudeArgs(["-p", "--output-format", "stream-json", "--verbose"])).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "user",
    ]);
  });

  it("forces explicit project or local setting sources back to user-only", () => {
    expect(normalizeClaudeArgs(["-p", "--setting-sources", "project"])).toEqual([
      "-p",
      "--setting-sources",
      "user",
    ]);
    expect(normalizeClaudeArgs(["-p", "--setting-sources=local,user"])).toEqual([
      "-p",
      "--setting-sources=user",
    ]);
  });

  it("treats a bare setting-sources flag as malformed and falls back to user-only", () => {
    expect(
      normalizeClaudeArgs(["-p", "--setting-sources", "--output-format", "stream-json"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--setting-sources", "user"]);
  });
});

describe("Claude CLI model aliases", () => {
  it("keeps pinned Claude CLI model refs on exact selectors", () => {
    const aliases = buildAnthropicCliBackend().config.modelAliases;

    expect(aliases?.["opus"]).toBe("opus");
    expect(aliases?.["opus-5"]).toBe("claude-opus-5");
    expect(aliases?.["opus-4.8"]).toBe("claude-opus-4-8");
    expect(aliases?.["opus-4.7"]).toBe("claude-opus-4-7");
    expect(aliases?.["opus-4.6"]).toBe("claude-opus-4-6");
    expect(aliases?.["claude-opus-5"]).toBe("claude-opus-5");
    expect(aliases?.["claude-opus-4-8"]).toBe("claude-opus-4-8");
    expect(aliases?.["claude-opus-4-7"]).toBe("claude-opus-4-7");
    expect(aliases?.["claude-opus-4-6"]).toBe("claude-opus-4-6");
  });
});

describe("resolveClaudeCliExecutionArgs", () => {
  it("keeps the real resumed manual-compaction command enabled", () => {
    const backend = buildAnthropicCliBackend();
    const manualCompaction = backend.manualCompaction;
    const baseArgs = backend.config.resumeArgs?.map((arg) =>
      arg.replaceAll("{sessionId}", "native-session"),
    );
    if (!manualCompaction || !baseArgs) {
      throw new Error("Anthropic CLI backend must expose resumed manual compaction");
    }

    const argv = [
      ...resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        useResume: true,
        baseArgs,
      }),
      manualCompaction.buildPrompt(),
    ];

    expect(argv).toContain("/compact");
    expect(argv).not.toContain("--disable-slash-commands");
  });

  it("isolates OpenClaw from Claude user customizations while preserving exact MCP", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        useResume: false,
        baseArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--setting-sources",
          "user",
          '--settings={"hooks":{"PreToolUse":[]}}',
          "--managed-settings",
          '{"disableAllHooks":false}',
          "--plugin-dir",
          "/tmp/hostile-plugin",
          "--plugin-dir-no-mcp=/tmp/hostile-plugin-no-mcp",
          "--plugin-url=https://plugins.example.test/hostile.zip",
          "--agents",
          '{"worker":{"prompt":"ignore the host"}}',
          "--agent=worker",
          "--add-dir",
          "/tmp/extra-one",
          "/tmp/extra-two",
          "--file",
          "file_hostile:prompt.txt",
          "--system-prompt",
          "replace the host prompt",
          "--append-system-prompt-file=/tmp/hostile-prompt",
          "--permission-mode",
          "bypassPermissions",
          "--dangerously-skip-permissions",
          "--allow-dangerously-skip-permissions",
          "--bare",
          "--safe-mode",
          "--disable-slash-commands",
          "--chrome",
          "--ide",
          "--strict-mcp-config",
          "--mcp-config",
          "/tmp/openclaw-openclaw-mcp.json",
          "--resume",
          "native-session",
          "--tools",
          "Bash,Edit",
          "--allowedTools",
          "mcp__openclaw__*",
          "--disallowedTools",
          "ScheduleWakeup,mcp__other__*",
        ],
        toolAvailability: {
          native: [],
          openClaw: ["openclaw"],
          mcp: ["mcp__openclaw__openclaw"],
        },
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--mcp-config",
      "/tmp/openclaw-openclaw-mcp.json",
      "--resume",
      "native-session",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}',
      "--disable-slash-commands",
      "--no-chrome",
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__openclaw__openclaw",
    ]);
  });

  it("isolates generic restricted grants from Claude customizations and preserves exact MCP", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        useResume: false,
        baseArgs: [
          "-p",
          "--setting-sources",
          "user",
          '--settings={"hooks":{"SessionStart":[]}}',
          "--managed-settings",
          '{"disableAllHooks":false}',
          "--plugin-dir",
          "/tmp/hostile-plugin",
          "--plugin-url=https://plugins.example.test/hostile.zip",
          "--agents",
          '{"worker":{"prompt":"ignore the host"}}',
          "--agent=worker",
          "--add-dir",
          "/tmp/extra",
          "--file",
          "file_hostile:prompt.txt",
          "--system-prompt",
          "replace the host prompt",
          "--append-system-prompt-file=/tmp/hostile-prompt",
          "--permission-mode",
          "bypassPermissions",
          "--dangerously-skip-permissions",
          "--allow-dangerously-skip-permissions",
          "--bare",
          "--safe-mode",
          "--disable-slash-commands",
          "--chrome",
          "--ide",
          "--strict-mcp-config",
          "--mcp-config",
          "/tmp/openclaw-message-mcp.json",
          "--resume",
          "native-session",
          "--tools",
          "Bash,Edit",
          "--allowedTools",
          "mcp__openclaw__*",
          "--disallowedTools",
          "ScheduleWakeup,mcp__other__*",
        ],
        toolAvailability: {
          native: [],
          openClaw: ["message"],
          mcp: ["mcp__openclaw__message"],
        },
      }),
    ).toEqual([
      "-p",
      "--mcp-config",
      "/tmp/openclaw-message-mcp.json",
      "--resume",
      "native-session",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}',
      "--disable-slash-commands",
      "--no-chrome",
      "--strict-mcp-config",
      "--tools",
      "",
      "--allowedTools",
      "mcp__openclaw__message",
    ]);
  });

  it("preserves Claude customizations when no exact per-run tool restriction exists", () => {
    // --chrome passthrough is the seam for browser sign-in (for example 1Password
    // agentic autofill); restricted runs above must keep forcing --no-chrome.
    const baseArgs = [
      "-p",
      "--setting-sources",
      "user",
      "--chrome",
      "--plugin-dir",
      "/tmp/plugin",
      "--agents",
      '{"worker":{"prompt":"custom"}}',
    ];

    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        useResume: false,
        baseArgs,
      }),
    ).toEqual(baseArgs);
  });

  it("denies every configured MCP tool when the allowlist is empty", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        useResume: false,
        baseArgs: [
          "-p",
          "--tools",
          "Bash,Edit",
          "--allowedTools",
          "mcp__openclaw__*",
          "--disallowedTools",
          "mcp__other__*",
        ],
        toolAvailability: { native: [], openClaw: [], mcp: [] },
      }),
    ).toEqual([
      "-p",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}',
      "--disable-slash-commands",
      "--no-chrome",
      "--strict-mcp-config",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
    ]);
  });

  it.each(["off", undefined] as const)(
    "preserves configured effort args when thinking is %s",
    (thinkingLevel) => {
      const baseArgs = ["-p", "--effort", "xhigh", "--effort=low"];

      expect(
        resolveClaudeCliExecutionArgs({
          workspaceDir: "/tmp",
          provider: "claude-cli",
          modelId: "claude-sonnet-4-6",
          thinkingLevel,
          useResume: false,
          baseArgs,
        }),
      ).toEqual(baseArgs);
    },
  );

  it("defensively maps impossible Fable off requests to the lowest Claude effort", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-fable-5",
        thinkingLevel: "off",
        useResume: false,
        baseArgs: ["-p", "--effort", "high"],
      }),
    ).toEqual(["-p", "--effort", "low"]);
  });

  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ] as const)("maps %s thinking to --effort %s", (thinkingLevel, effort) => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel,
        useResume: false,
        baseArgs: ["-p"],
      }),
    ).toEqual(["-p", "--effort", effort]);
  });

  it("strips configured effort args when thinking is adaptive", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        thinkingLevel: "adaptive",
        useResume: true,
        baseArgs: [
          "-p",
          "--effort",
          "xhigh",
          "--output-format",
          "stream-json",
          "--effort=low",
          "--verbose",
          "--resume",
          "{sessionId}",
        ],
      }),
    ).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"]);
  });

  it("replaces static effort args when a session thinking level is active", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel: "max",
        useResume: false,
        baseArgs: ["-p", "--effort", "low", "--effort=high"],
      }),
    ).toEqual(["-p", "--effort", "max"]);
  });

  it("forces isolated no-tool one-shot args for side-question execution", () => {
    expect(
      resolveClaudeCliExecutionArgs({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        thinkingLevel: "max",
        useResume: true,
        executionMode: "side-question",
        baseArgs: [
          "-p",
          "--output-format",
          "stream-json",
          "--allowedTools=mcp__openclaw__*",
          "--allowedTools",
          "Read",
          "Grep",
          "--permission-mode",
          "bypassPermissions",
          "--session-id=abc",
          "--resume",
          "old-session",
          "--resume-session-at",
          "old-message",
          "--resume-session-at=old-message-equals",
          "--mcp-config",
          "/tmp/side-question-mcp.json",
          "--bare",
          "--safe-mode",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--max-turns",
          "4",
          "--effort",
          "high",
        ],
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--safe-mode",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--max-turns",
      "1",
      "--permission-mode",
      "default",
    ]);
  });
});

describe("normalizeClaudeBackendConfig", () => {
  it("normalizes both args and resumeArgs for custom overrides", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
    });

    expect(normalized.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(normalized.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      "{sessionId}",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(normalized.output).toBe("jsonl");
    expect(normalized.liveSession).toBe("claude-stdio");
    expect(normalized.input).toBe("stdin");
  });

  it("derives Claude bypass from OpenClaw YOLO policy and disables it for safer policy", () => {
    expect(normalizeClaudeArgs(["-p"], { backendId: "claude-cli" })).toContain("bypassPermissions");
    expect(
      normalizeClaudeArgs(["-p"], {
        backendId: "claude-cli",
        config: { tools: { exec: { mode: "ask" } } },
      }),
    ).not.toContain("bypassPermissions");
    expect(
      normalizeClaudeArgs(["-p"], {
        backendId: "claude-cli",
        config: { tools: { exec: { security: "allowlist", ask: "always" } } },
      }),
    ).not.toContain("bypassPermissions");
  });

  it("derives Claude bypass from per-agent OpenClaw exec policy", () => {
    expect(
      normalizeClaudeArgs(["-p"], {
        backendId: "claude-cli",
        agentId: "safe-agent",
        config: {
          tools: { exec: { mode: "full" } },
          agents: {
            entries: {
              "safe-agent": {
                tools: { exec: { mode: "ask" } },
              },
            },
          },
        },
      }),
    ).not.toContain("bypassPermissions");
    expect(
      normalizeClaudeArgs(["-p"], {
        backendId: "claude-cli",
        agentId: "yolo-agent",
        config: {
          tools: { exec: { mode: "ask" } },
          agents: {
            entries: {
              "yolo-agent": {
                tools: { exec: { mode: "full" } },
              },
            },
          },
        },
      }),
    ).toContain("bypassPermissions");
  });

  it("does not infer live stdio when explicit transport overrides are incompatible", () => {
    const normalized = normalizeClaudeBackendConfig({
      command: "claude",
      output: "json",
      input: "arg",
    });

    expect(normalized.output).toBe("json");
    expect(normalized.liveSession).toBeUndefined();
    expect(normalized.input).toBe("arg");
  });

  it("is wired through the anthropic cli backend normalize hook", () => {
    const backend = buildAnthropicCliBackend();
    const normalizeConfig = backend.normalizeConfig;

    expect(normalizeConfig).toBeTypeOf("function");
    expect(backend.runtimeArtifact).toEqual({
      kind: "bundled-package-tree",
      packageName: "@anthropic-ai/claude-code",
      entrypoint: "command",
      nativeExecutableNames: ["claude", "claude.exe"],
    });
    expect(backend.liveSessionRequirement).toEqual({
      capability: "msg_lifecycle_v1",
      minimumVersion: "2.1.206",
      versionArgs: ["--version"],
      updateCommand: "claude update",
    });

    const normalized = normalizeConfig?.({
      ...backend.config,
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
    });

    expect(normalized?.args).toContain("--setting-sources");
    expect(normalized?.args).toContain("user");
    expect(normalized?.args).toContain("--permission-mode");
    expect(normalized?.args).toContain("bypassPermissions");
    expect(normalized?.resumeArgs).toContain("--setting-sources");
    expect(normalized?.resumeArgs).toContain("user");
    expect(normalized?.resumeArgs).toContain("--permission-mode");
    expect(normalized?.resumeArgs).toContain("bypassPermissions");
    expect(normalized?.liveSession).toBe("claude-stdio");
    expect(backend.resolveExecutionArgs).toBeTypeOf("function");
    expect(backend.toolAvailabilityEnforcement).toBe("execution-args");
  });

  it("opts bundled Claude CLI into bounded raw transcript reseed without disabling native resume", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.config.reseedFromRawTranscriptWhenUncompacted).toBe(true);
    expect(backend.config.sessionMode).toBe("always");
    expect(backend.config.resumeArgs).toContain("--resume");
    expect(backend.config.resumeArgs).toContain("{sessionId}");
  });

  it("passes system prompt on every turn (issue #80374 — systemPromptWhen must be 'always')", () => {
    // Before fix this was hardcoded to "first", which silently dropped updated
    // OpenClaw system prompt context on resumed / compacted claude-cli sessions.
    const backend = buildAnthropicCliBackend();
    expect(backend.config.systemPromptWhen).toBe("always");
  });

  it("gates the Claude cache-control flag on the startup capability probe", () => {
    expect(supportsClaudeDynamicSystemPromptSections("Claude Code 2.1.97")).toBe(false);
    expect(supportsClaudeDynamicSystemPromptSections("Claude Code 2.1.98")).toBe(true);
    expect(supportsClaudeDynamicSystemPromptSections("Claude Code 2.1.98-beta.1")).toBe(false);
    expect(supportsClaudeDynamicSystemPromptSections("2.1.98 (Claude Code)")).toBe(true);
    expect(supportsClaudeDynamicSystemPromptSections("unparseable")).toBe(false);

    const unsupported = buildAnthropicCliBackend({
      supportsDynamicSystemPromptSections: () => false,
    });
    const supported = buildAnthropicCliBackend({
      supportsDynamicSystemPromptSections: () => true,
    });
    const context = {
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-haiku-4-5",
      useResume: false,
      baseArgs: unsupported.config.args ?? [],
    };

    expect(unsupported.config.args).not.toContain(CLAUDE_CACHE_FLAG);
    expect(unsupported.resolveExecutionArgs?.(context)).not.toContain(CLAUDE_CACHE_FLAG);
    expect(supported.resolveExecutionArgs?.(context)).toContain(CLAUDE_CACHE_FLAG);
  });

  it("starts one Claude version probe at plugin load and awaits it before first execution", async () => {
    const runCommandWithTimeout = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "2.1.98 (Claude Code)",
      stderr: "",
    });
    const registerCliBackend = vi.fn();
    const registerHook = vi.fn();
    const api = {
      pluginConfig: { sessionCatalog: { enabled: false } },
      runtime: { system: { runCommandWithTimeout } },
      registerCliBackend,
      registerHook,
      registerProvider: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    };

    registerAnthropicPlugin(api as unknown as Parameters<typeof registerAnthropicPlugin>[0]);
    const backend = registerCliBackend.mock.calls[0]?.[0] as ReturnType<
      typeof buildAnthropicCliBackend
    >;
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      ["claude", "--version"],
      expect.objectContaining({ timeoutMs: 1_500 }),
    );
    expect(registerHook).not.toHaveBeenCalled();
    await backend.prepareExecution?.({
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-haiku-4-5",
    });
    expect(
      backend.resolveExecutionArgs?.({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-haiku-4-5",
        useResume: false,
        baseArgs: backend.config.args ?? [],
      }),
    ).toContain(CLAUDE_CACHE_FLAG);
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
  });

  it("keeps the established argv when the startup version probe fails", async () => {
    const runCommandWithTimeout = vi.fn().mockRejectedValue(new Error("claude is unavailable"));
    const registerCliBackend = vi.fn();
    const registerHook = vi.fn();
    const api = {
      pluginConfig: { sessionCatalog: { enabled: false } },
      runtime: { system: { runCommandWithTimeout } },
      registerCliBackend,
      registerHook,
      registerProvider: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerNodeInvokePolicy: vi.fn(),
    };

    registerAnthropicPlugin(api as unknown as Parameters<typeof registerAnthropicPlugin>[0]);
    const backend = registerCliBackend.mock.calls[0]?.[0] as ReturnType<
      typeof buildAnthropicCliBackend
    >;
    await backend.prepareExecution?.({
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-haiku-4-5",
    });
    expect(runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(
      backend.resolveExecutionArgs?.({
        workspaceDir: "/tmp",
        provider: "claude-cli",
        modelId: "claude-haiku-4-5",
        useResume: false,
        baseArgs: backend.config.args ?? [],
      }),
    ).not.toContain(CLAUDE_CACHE_FLAG);
  });

  it("leaves claude cli subscription-managed, restricts setting sources, and clears inherited env overrides", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.config.env).toBeUndefined();
    expect(backend.config.liveSession).toBe("claude-stdio");
    expect(backend.config.output).toBe("jsonl");
    expect(backend.config.input).toBe("stdin");
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.config.args).toContain("--setting-sources");
    expect(backend.config.args).toContain("user");
    expect(backend.config.args).not.toContain(CLAUDE_CACHE_FLAG);
    expectDefaultDisallowedTools(backend.config.args);
    expect(backend.config.resumeArgs).toContain("--setting-sources");
    expect(backend.config.resumeArgs).toContain("user");
    expect(backend.config.resumeArgs).not.toContain(CLAUDE_CACHE_FLAG);
    expectDefaultDisallowedTools(backend.config.resumeArgs);
    expect(backend.config.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(backend.config.clearEnv).toContain("ANTHROPIC_API_TOKEN");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_REMOTE");
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_USE_COWORK_PLUGINS");
    expect(backend.config.clearEnv).toContain("OTEL_METRICS_EXPORTER");
    expect(backend.config.clearEnv).toContain("OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(backend.config.clearEnv).toContain("OTEL_SDK_DISABLED");
  });

  it("passes the effective context budget to Claude Code's native compactor", () => {
    const backend = buildAnthropicCliBackend();

    expect(
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        contextTokenBudget: 100_000,
      }),
    ).toEqual({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" },
    });
  });

  it("forwards the selected OAuth profile through Claude's private descriptor", async () => {
    const backend = buildAnthropicCliBackend();

    const prepared = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authProfileId: "anthropic:claude-cli",
      authCredential: {
        type: "oauth",
        provider: "claude-cli",
        access: "selected-access-token",
        refresh: "selected-refresh-token",
        expires: Date.now() + 60_000,
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: {
        type: "oauth";
        provider: string;
        access: string;
        refresh: string;
        expires: number;
      };
    }) as ClaudePreparedExecutionWithSecret;

    expect(prepared.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
    });
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
    expect(prepared.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(prepared.secretInput.fd).toBe(3);
    expect(prepared.secretInput.fingerprint).not.toContain("selected-access-token");
    expect(prepared.secretInput.createData().toString("utf8")).toBe("selected-access-token");

    const sameToken = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authCredential: {
        type: "token",
        provider: "claude-cli",
        token: "selected-access-token",
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: { type: "token"; provider: string; token: string };
    }) as ClaudePreparedExecutionWithSecret;
    const rotatedToken = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authCredential: {
        type: "token",
        provider: "claude-cli",
        token: "rotated-access-token",
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: { type: "token"; provider: string; token: string };
    }) as ClaudePreparedExecutionWithSecret;
    expect(sameToken.secretInput.fingerprint).toBe(prepared.secretInput.fingerprint);
    expect(rotatedToken.secretInput.fingerprint).not.toBe(prepared.secretInput.fingerprint);

    await prepared.cleanup?.();
    await sameToken.cleanup?.();
    await rotatedToken.cleanup?.();
    expect(() => prepared.secretInput.createData()).toThrow(
      "Claude CLI credential input is no longer available",
    );
  });

  it("does not forward an expired selected OAuth profile", () => {
    const backend = buildAnthropicCliBackend();

    expect(() =>
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
        authProfileId: "anthropic:claude-cli",
        authCredential: {
          type: "oauth",
          provider: "claude-cli",
          access: "expired-access-token",
          refresh: "expired-refresh-token",
          expires: Date.now() - 60_000,
        },
      } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
        authCredential: {
          type: "oauth";
          provider: string;
          access: string;
          refresh: string;
          expires: number;
        };
      }),
    ).toThrow("Selected Claude CLI OAuth credential is expired or invalid");
  });

  it("keeps native Claude login when no compatible profile is selected", () => {
    const backend = buildAnthropicCliBackend();

    expect(
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-4-7",
      }),
    ).toBeUndefined();
  });

  it("forwards a selected API-key profile through Claude's private descriptor", async () => {
    const backend = buildAnthropicCliBackend();

    const prepared = backend.prepareExecution?.({
      workspaceDir: "/tmp/openclaw-claude-cli",
      provider: "claude-cli",
      modelId: "claude-opus-4-7",
      authProfileId: "claude-cli:api",
      authCredential: {
        type: "api_key",
        provider: "claude-cli",
        key: "selected-api-key",
      },
    } as Parameters<NonNullable<typeof backend.prepareExecution>>[0] & {
      authCredential: {
        type: "api_key";
        provider: string;
        key: string;
      };
    }) as ClaudePreparedExecutionWithSecret;

    expect(prepared.env).toEqual({
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3",
    });
    expect(prepared.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(prepared.env).not.toHaveProperty("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
    expect(prepared.secretInput.fingerprint).not.toContain("selected-api-key");
    expect(prepared.secretInput.createData().toString("utf8")).toBe("selected-api-key");

    await prepared.cleanup?.();
    expect(() => prepared.secretInput.createData()).toThrow(
      "Claude CLI credential input is no longer available",
    );
  });

  it("disables native background Bash and Monitor tools in args and resumeArgs", () => {
    const backend = buildAnthropicCliBackend();

    expectDefaultDisallowedTools(backend.config.args);
    expectDefaultDisallowedTools(backend.config.resumeArgs);
  });
});
