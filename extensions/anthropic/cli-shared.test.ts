// Anthropic tests cover cli shared plugin behavior.
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import {
  CLAUDE_CLI_CLEAR_ENV,
  normalizeClaudeBackendConfig,
  resolveClaudeCliAutoCompactEnv,
  resolveClaudeCliExecutionArgs,
  resolveClaudeCliRuntimeToolAvailability,
} from "./cli-shared.js";

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

  it("preserves the prepared launch environment for the same context budget", () => {
    const backend = buildAnthropicCliBackend();

    expect(
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        contextTokenBudget: 100_000,
      }),
    ).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" } });
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

describe("resolveClaudeCliRuntimeToolAvailability", () => {
  it("routes every restricted tool through the OpenClaw MCP policy boundary", () => {
    expect(
      resolveClaudeCliRuntimeToolAvailability({
        toolsAllow: ["read", "write", "edit", "apply_patch", "exec", "process", "browser", "image"],
      }),
    ).toEqual({
      mcp: [
        "mcp__openclaw__read",
        "mcp__openclaw__write",
        "mcp__openclaw__edit",
        "mcp__openclaw__apply_patch",
        "mcp__openclaw__exec",
        "mcp__openclaw__process",
        "mcp__openclaw__browser",
        "mcp__openclaw__image",
      ],
    });
  });

  it("keeps process-only authority on the exact OpenClaw MCP tool", () => {
    expect(resolveClaudeCliRuntimeToolAvailability({ toolsAllow: ["process"] })).toEqual({
      mcp: ["mcp__openclaw__process"],
    });
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
  it("leaves args alone when they omit permission flags", () => {
    expect(normalizeClaudeArgs(["-p", "--output-format", "stream-json", "--verbose"])).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "user",
    ]);
  });

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
    expect(aliases?.["opus-4.8"]).toBe("claude-opus-4-8");
    expect(aliases?.["opus-4.7"]).toBe("claude-opus-4-7");
    expect(aliases?.["opus-4.6"]).toBe("claude-opus-4-6");
    expect(aliases?.["claude-opus-4-8"]).toBe("claude-opus-4-8");
    expect(aliases?.["claude-opus-4-7"]).toBe("claude-opus-4-7");
    expect(aliases?.["claude-opus-4-6"]).toBe("claude-opus-4-6");
  });
});

describe("resolveClaudeCliExecutionArgs", () => {
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
    const baseArgs = [
      "-p",
      "--setting-sources",
      "user",
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
        toolAvailability: { native: [], mcp: [] },
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
            list: [
              {
                id: "safe-agent",
                tools: { exec: { mode: "ask" } },
              },
            ],
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
            list: [
              {
                id: "yolo-agent",
                tools: { exec: { mode: "full" } },
              },
            ],
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
    expect(backend.resolveExecutionArgs).toBe(resolveClaudeCliExecutionArgs);
    expect(backend.resolveRuntimeToolAvailability).toBe(resolveClaudeCliRuntimeToolAvailability);
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

  it("leaves claude cli subscription-managed, restricts setting sources, and clears inherited env overrides", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.config.env).toBeUndefined();
    expect(backend.config.liveSession).toBe("claude-stdio");
    expect(backend.config.output).toBe("jsonl");
    expect(backend.config.input).toBe("stdin");
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.config.args).toContain("--setting-sources");
    expect(backend.config.args).toContain("user");
    expectDefaultDisallowedTools(backend.config.args);
    expect(backend.config.resumeArgs).toContain("--setting-sources");
    expect(backend.config.resumeArgs).toContain("user");
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
