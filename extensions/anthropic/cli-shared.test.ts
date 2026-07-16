// Anthropic tests cover cli shared plugin behavior.
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import {
  CLAUDE_CLI_CLEAR_ENV,
  normalizeClaudeBackendConfig,
  normalizeClaudePermissionArgs,
  normalizeClaudeSettingSourcesArgs,
  resolveClaudeCliAutoCompactEnv,
  resolveClaudePermissionMode,
  resolveClaudeCliExecutionArgs,
} from "./cli-shared.js";

const CLAUDE_CLI_DISALLOWED_TOOLS =
  "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor";

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

describe("normalizeClaudePermissionArgs", () => {
  it("leaves args alone when they omit permission flags", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
  });

  it("removes legacy skip-permissions without adding bypassPermissions", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--dangerously-skip-permissions", "--verbose"]),
    ).toEqual(["-p", "--verbose"]);
  });

  it("keeps explicit permission-mode overrides", () => {
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode", "acceptEdits"])).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode=acceptEdits"])).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
    ]);
  });

  it("drops malformed permission-mode flags in both split and equals forms", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--permission-mode", "--output-format", "stream-json"]),
    ).toEqual(["-p", "--output-format", "stream-json"]);
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode="])).toEqual(["-p"]);
    expect(normalizeClaudePermissionArgs(["-p", "--permission-mode=--output-format"])).toEqual([
      "-p",
    ]);
  });
});

describe("normalizeClaudeSettingSourcesArgs", () => {
  it("injects user-only setting sources when args omit the flag", () => {
    expect(
      normalizeClaudeSettingSourcesArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "user"]);
  });

  it("forces explicit project or local setting sources back to user-only", () => {
    expect(normalizeClaudeSettingSourcesArgs(["-p", "--setting-sources", "project"])).toEqual([
      "-p",
      "--setting-sources",
      "user",
    ]);
    expect(normalizeClaudeSettingSourcesArgs(["-p", "--setting-sources=local,user"])).toEqual([
      "-p",
      "--setting-sources=user",
    ]);
  });

  it("treats a bare setting-sources flag as malformed and falls back to user-only", () => {
    expect(
      normalizeClaudeSettingSourcesArgs([
        "-p",
        "--setting-sources",
        "--output-format",
        "stream-json",
      ]),
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

  it("leaves non-OpenClaw customization args intact under generic tool availability", () => {
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
          "--plugin-dir",
          "/tmp/plugin",
          "--tools",
          "Bash,Edit",
          "--allowedTools",
          "mcp__openclaw__*",
        ],
        toolAvailability: {
          native: [],
          mcp: ["mcp__openclaw__message"],
        },
      }),
    ).toEqual([
      "-p",
      "--setting-sources",
      "user",
      "--plugin-dir",
      "/tmp/plugin",
      "--tools",
      "",
      "--allowedTools",
      "mcp__openclaw__message",
    ]);
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
    ).toEqual(["-p", "--tools", "", "--disallowedTools", "mcp__*"]);
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
    expect(resolveClaudePermissionMode({ backendId: "claude-cli" })).toEqual({
      mode: "bypassPermissions",
      overrideExisting: false,
    });
    expect(
      resolveClaudePermissionMode({
        backendId: "claude-cli",
        config: { tools: { exec: { security: "allowlist", ask: "on-miss" } } },
      }),
    ).toEqual({ overrideExisting: false });
  });

  it("derives Claude bypass from per-agent OpenClaw exec policy", () => {
    expect(
      resolveClaudePermissionMode({
        backendId: "claude-cli",
        agentId: "safe-agent",
        config: {
          tools: { exec: { security: "full", ask: "off" } },
          agents: {
            list: [
              {
                id: "safe-agent",
                tools: { exec: { security: "allowlist", ask: "on-miss" } },
              },
            ],
          },
        },
      }),
    ).toEqual({ overrideExisting: false });
    expect(
      resolveClaudePermissionMode({
        backendId: "claude-cli",
        agentId: "yolo-agent",
        config: {
          tools: { exec: { security: "allowlist", ask: "on-miss" } },
          agents: {
            list: [
              {
                id: "yolo-agent",
                tools: { exec: { security: "full", ask: "off" } },
              },
            ],
          },
        },
      }),
    ).toEqual({
      mode: "bypassPermissions",
      overrideExisting: false,
    });
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

  it("disables native background Bash and Monitor tools in args and resumeArgs", () => {
    const backend = buildAnthropicCliBackend();

    expectDefaultDisallowedTools(backend.config.args);
    expectDefaultDisallowedTools(backend.config.resumeArgs);
  });
});
