import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendNormalizeConfigContext,
  CliBundleMcpMode,
} from "../plugins/types.js";
import {
  __testing as cliBackendsTesting,
  resolveCliBackendConfig,
  resolveCliBackendLiveTest,
} from "./cli-backends.js";

type RuntimeBackendEntry = ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];
type SetupBackendEntry = NonNullable<
  ReturnType<(typeof import("../plugins/setup-registry.js"))["resolvePluginSetupCliBackend"]>
>;

let runtimeBackendEntries: RuntimeBackendEntry[] = [];
let setupBackendEntries: SetupBackendEntry[] = [];

function createBackendEntry(params: {
  pluginId: string;
  id: string;
  config: CliBackendConfig;
  bundleMcp?: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  defaultAuthProfileId?: string;
  authEpochMode?: CliBackendAuthEpochMode;
  prepareExecution?: () => Promise<null>;
  normalizeConfig?: (
    config: CliBackendConfig,
    context?: CliBackendNormalizeConfigContext,
  ) => CliBackendConfig;
}) {
  return {
    pluginId: params.pluginId,
    source: "test",
    backend: {
      id: params.id,
      config: params.config,
      ...(params.bundleMcp ? { bundleMcp: params.bundleMcp } : {}),
      ...(params.bundleMcpMode ? { bundleMcpMode: params.bundleMcpMode } : {}),
      ...(params.defaultAuthProfileId ? { defaultAuthProfileId: params.defaultAuthProfileId } : {}),
      ...(params.authEpochMode ? { authEpochMode: params.authEpochMode } : {}),
      ...(params.prepareExecution ? { prepareExecution: params.prepareExecution } : {}),
      ...(params.normalizeConfig ? { normalizeConfig: params.normalizeConfig } : {}),
      liveTest: {
        defaultModelRef:
          params.id === "claude-cli"
            ? "claude-cli/claude-sonnet-4-6"
            : params.id === "codex-cli"
              ? "codex-cli/gpt-5.5"
              : params.id === "google-gemini-cli"
                ? "google-gemini-cli/gemini-3-flash-preview"
                : undefined,
        defaultImageProbe: true,
        defaultMcpProbe: true,
        docker: {
          npmPackage:
            params.id === "claude-cli"
              ? "@anthropic-ai/claude-code"
              : params.id === "codex-cli"
                ? "@openai/codex@0.124.0"
                : params.id === "google-gemini-cli"
                  ? "@google/gemini-cli"
                  : undefined,
          binaryName:
            params.id === "claude-cli"
              ? "claude"
              : params.id === "codex-cli"
                ? "codex"
                : params.id === "google-gemini-cli"
                  ? "gemini"
                  : undefined,
        },
      },
    },
  };
}

function createRuntimeBackendEntry(params: Parameters<typeof createBackendEntry>[0]) {
  const entry = createBackendEntry(params);
  return {
    ...entry.backend,
    pluginId: entry.pluginId,
  } satisfies RuntimeBackendEntry;
}

function createClaudeCliOverrideConfig(config: CliBackendConfig): OpenClawConfig {
  return {
    agents: {
      defaults: {
        cliBackends: {
          "claude-cli": config,
        },
      },
    },
  } satisfies OpenClawConfig;
}

const NORMALIZED_CLAUDE_FALLBACK_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--setting-sources",
  "user",
];

const NORMALIZED_CLAUDE_FALLBACK_RESUME_ARGS = [
  "-p",
  "--resume",
  "{sessionId}",
  "--setting-sources",
  "user",
];

function isTestYoloConfig(context?: CliBackendNormalizeConfigContext): boolean {
  const agentExec = context?.agentId
    ? context.config?.agents?.list?.find((agent) => agent.id === context.agentId)?.tools?.exec
    : undefined;
  const exec = agentExec ?? context?.config?.tools?.exec;
  return (exec?.security ?? "full") === "full" && (exec?.ask ?? "off") === "off";
}

function normalizeTestPermissionMode(context?: CliBackendNormalizeConfigContext): {
  mode?: string;
  overrideExisting: boolean;
} {
  return isTestYoloConfig(context)
    ? { mode: "bypassPermissions", overrideExisting: false }
    : { overrideExisting: false };
}

function normalizeTestClaudeArgs(
  args: string[] | undefined,
  permission: { mode?: string; overrideExisting: boolean },
): string[] | undefined {
  if (!args) {
    return permission.mode ? ["--permission-mode", permission.mode] : args;
  }
  const normalized: string[] = [];
  let hasSettingSources = false;
  let hasPermissionMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dangerously-skip-permissions") {
      continue;
    }
    if (arg === "--setting-sources") {
      const maybeValue = args[i + 1];
      if (maybeValue && !maybeValue.startsWith("-")) {
        hasSettingSources = true;
        normalized.push(arg, "user");
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--setting-sources=")) {
      hasSettingSources = true;
      normalized.push("--setting-sources=user");
      continue;
    }
    if (arg === "--permission-mode") {
      const maybeValue = args[i + 1];
      if (maybeValue && !maybeValue.startsWith("-")) {
        hasPermissionMode = true;
        if (!permission.overrideExisting) {
          normalized.push(arg, maybeValue);
        }
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--permission-mode=")) {
      const maybeValue = arg.slice("--permission-mode=".length).trim();
      if (maybeValue.length > 0 && !maybeValue.startsWith("-")) {
        hasPermissionMode = true;
        if (!permission.overrideExisting) {
          normalized.push(`--permission-mode=${maybeValue}`);
        }
      }
      continue;
    }
    normalized.push(arg);
  }
  if (!hasSettingSources) {
    normalized.push("--setting-sources", "user");
  }
  if (permission.mode && (!hasPermissionMode || permission.overrideExisting)) {
    normalized.push("--permission-mode", permission.mode);
  }
  return normalized;
}

function normalizeTestClaudeBackendConfig(
  config: CliBackendConfig,
  context?: CliBackendNormalizeConfigContext,
): CliBackendConfig {
  const permission = normalizeTestPermissionMode(context);
  return {
    ...config,
    args: normalizeTestClaudeArgs(config.args, permission),
    resumeArgs: normalizeTestClaudeArgs(config.resumeArgs, permission),
  };
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

beforeEach(() => {
  runtimeBackendEntries = [
    createRuntimeBackendEntry({
      pluginId: "anthropic",
      id: "claude-cli",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      config: {
        command: "claude",
        args: [
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--setting-sources",
          "user",
          "--allowedTools",
          "mcp__openclaw__*",
        ],
        resumeArgs: [
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--setting-sources",
          "user",
          "--allowedTools",
          "mcp__openclaw__*",
          "--resume",
          "{sessionId}",
        ],
        output: "jsonl",
        input: "stdin",
        imageArg: "@",
        imagePathScope: "workspace",
        clearEnv: [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_API_KEY_OLD",
          "ANTHROPIC_API_TOKEN",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_CUSTOM_HEADERS",
          "ANTHROPIC_OAUTH_TOKEN",
          "ANTHROPIC_UNIX_SOCKET",
          "CLAUDE_CONFIG_DIR",
          "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
          "CLAUDE_CODE_ENTRYPOINT",
          "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
          "CLAUDE_CODE_OAUTH_SCOPES",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
          "CLAUDE_CODE_PLUGIN_CACHE_DIR",
          "CLAUDE_CODE_PLUGIN_SEED_DIR",
          "CLAUDE_CODE_REMOTE",
          "CLAUDE_CODE_USE_COWORK_PLUGINS",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_FOUNDRY",
          "CLAUDE_CODE_USE_VERTEX",
        ],
      },
      normalizeConfig: normalizeTestClaudeBackendConfig,
    }),
    createRuntimeBackendEntry({
      pluginId: "openai",
      id: "codex-cli",
      bundleMcp: true,
      bundleMcpMode: "codex-config-overrides",
      config: {
        command: "codex",
        args: [
          "exec",
          "--json",
          "--color",
          "never",
          "--sandbox",
          "workspace-write",
          "-c",
          'service_tier="fast"',
          "--skip-git-repo-check",
        ],
        resumeArgs: [
          "exec",
          "resume",
          "{sessionId}",
          "-c",
          'sandbox_mode="workspace-write"',
          "-c",
          'service_tier="fast"',
          "--skip-git-repo-check",
        ],
        systemPromptFileConfigArg: "-c",
        systemPromptFileConfigKey: "model_instructions_file",
        systemPromptWhen: "first",
        imagePathScope: "workspace",
        reliability: {
          watchdog: {
            fresh: {
              noOutputTimeoutRatio: 0.8,
              minMs: 60_000,
              maxMs: 180_000,
            },
            resume: {
              noOutputTimeoutRatio: 0.3,
              minMs: 60_000,
              maxMs: 180_000,
            },
          },
        },
      },
    }),
    createRuntimeBackendEntry({
      pluginId: "google",
      id: "google-gemini-cli",
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      config: {
        command: "gemini",
        args: ["--skip-trust", "--output-format", "json", "--prompt", "{prompt}"],
        resumeArgs: [
          "--skip-trust",
          "--resume",
          "{sessionId}",
          "--output-format",
          "json",
          "--prompt",
          "{prompt}",
        ],
        imageArg: "@",
        imagePathScope: "workspace",
        modelArg: "--model",
        sessionMode: "existing",
        sessionIdFields: ["session_id", "sessionId"],
        modelAliases: { pro: "gemini-3.1-pro-preview" },
      },
    }),
  ];
  const claudeBackend = runtimeBackendEntries.find((entry) => entry.id === "claude-cli");
  setupBackendEntries = claudeBackend
    ? [
        {
          pluginId: claudeBackend.pluginId,
          backend: {
            ...claudeBackend,
            config: {
              ...claudeBackend.config,
              sessionArg: "--session-id",
              sessionMode: "always",
              systemPromptArg: "--append-system-prompt",
              systemPromptWhen: "first",
            },
          },
        },
      ]
    : [];
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => runtimeBackendEntries,
    resolvePluginSetupCliBackend: ({ backend }) => {
      return setupBackendEntries.find((entry) => entry.backend.id === backend);
    },
  });
});

describe("resolveCliBackendConfig reliability merge", () => {
  it("defaults codex-cli fresh sandboxing and config-pinned resume sandboxing", () => {
    const resolved = resolveCliBackendConfig("codex-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "-c",
      'service_tier="fast"',
      "--skip-git-repo-check",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'service_tier="fast"',
      "--skip-git-repo-check",
    ]);
  });

  it("deep-merges reliability watchdog overrides for codex", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": {
              command: "codex",
              reliability: {
                watchdog: {
                  resume: {
                    noOutputTimeoutMs: 42_000,
                  },
                },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("codex-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutMs).toBe(42_000);
    // Ensure defaults are retained when only one field is overridden.
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutRatio).toBe(0.3);
    expect(resolved?.config.reliability?.watchdog?.resume?.minMs).toBe(60_000);
    expect(resolved?.config.reliability?.watchdog?.resume?.maxMs).toBe(180_000);
    expect(resolved?.config.reliability?.watchdog?.fresh?.noOutputTimeoutRatio).toBe(0.8);
  });
});

describe("resolveCliBackendLiveTest", () => {
  it("returns plugin-owned live smoke metadata for claude", () => {
    expect(resolveCliBackendLiveTest("claude-cli")).toEqual({
      defaultModelRef: "claude-cli/claude-sonnet-4-6",
      defaultImageProbe: true,
      defaultMcpProbe: true,
      dockerNpmPackage: "@anthropic-ai/claude-code",
      dockerBinaryName: "claude",
    });
  });

  it("returns plugin-owned live smoke metadata for codex", () => {
    expect(resolveCliBackendLiveTest("codex-cli")).toEqual({
      defaultModelRef: "codex-cli/gpt-5.5",
      defaultImageProbe: true,
      defaultMcpProbe: true,
      dockerNpmPackage: "@openai/codex@0.124.0",
      dockerBinaryName: "codex",
    });
  });

  it("returns plugin-owned live smoke metadata for gemini", () => {
    expect(resolveCliBackendLiveTest("google-gemini-cli")).toEqual({
      defaultModelRef: "google-gemini-cli/gemini-3-flash-preview",
      defaultImageProbe: true,
      defaultMcpProbe: true,
      dockerNpmPackage: "@google/gemini-cli",
      dockerBinaryName: "gemini",
    });
  });
});

describe("resolveCliBackendConfig claude-cli defaults", () => {
  it("derives bypassPermissions from OpenClaw's default YOLO exec policy", () => {
    const resolved = resolveCliBackendConfig("claude-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.bundleMcp).toBe(true);
    expect(resolved?.bundleMcpMode).toBe("claude-config-file");
    expect(resolved?.config.output).toBe("jsonl");
    expect(resolved?.config.args).toContain("stream-json");
    expect(resolved?.config.args).toContain("--include-partial-messages");
    expect(resolved?.config.args).toContain("--verbose");
    expect(resolved?.config.args).toContain("--setting-sources");
    expect(resolved?.config.args).toContain("user");
    expect(resolved?.config.args).toContain("--allowedTools");
    expect(resolved?.config.args).toContain("mcp__openclaw__*");
    expect(resolved?.config.args).toContain("--permission-mode");
    expect(resolved?.config.args).toContain("bypassPermissions");
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.input).toBe("stdin");
    expect(resolved?.config.imageArg).toBe("@");
    expect(resolved?.config.imagePathScope).toBe("workspace");
    expect(resolved?.config.resumeArgs).toContain("stream-json");
    expect(resolved?.config.resumeArgs).toContain("--include-partial-messages");
    expect(resolved?.config.resumeArgs).toContain("--verbose");
    expect(resolved?.config.resumeArgs).toContain("--setting-sources");
    expect(resolved?.config.resumeArgs).toContain("user");
    expect(resolved?.config.resumeArgs).toContain("--allowedTools");
    expect(resolved?.config.resumeArgs).toContain("mcp__openclaw__*");
    expect(resolved?.config.resumeArgs).toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).toContain("bypassPermissions");
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("keeps Claude permission mode unset when OpenClaw exec policy is not YOLO", () => {
    const resolved = resolveCliBackendConfig("claude-cli", {
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).not.toContain("--permission-mode");
    expect(resolved?.config.args).not.toContain("bypassPermissions");
    expect(resolved?.config.resumeArgs).not.toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).not.toContain("bypassPermissions");
  });

  it("derives Claude permission mode from per-agent exec policy when an agent id is known", () => {
    const cfg = {
      tools: { exec: { security: "full", ask: "off" } },
      agents: {
        list: [
          {
            id: "reviewer",
            tools: { exec: { security: "allowlist", ask: "on-miss" } },
          },
          {
            id: "builder",
            tools: { exec: { security: "full", ask: "off" } },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const reviewer = resolveCliBackendConfig("claude-cli", cfg, { agentId: "reviewer" });
    const builder = resolveCliBackendConfig("claude-cli", cfg, { agentId: "builder" });

    expect(reviewer?.config.args).not.toContain("--permission-mode");
    expect(reviewer?.config.resumeArgs).not.toContain("--permission-mode");
    expect(builder?.config.args).toContain("--permission-mode");
    expect(builder?.config.args).toContain("bypassPermissions");
    expect(builder?.config.resumeArgs).toContain("--permission-mode");
    expect(builder?.config.resumeArgs).toContain("bypassPermissions");
  });

  it("uses existing exec policy and raw Claude args as permission overrides", () => {
    const safe = resolveCliBackendConfig("claude-cli", {
      tools: { exec: { security: "full", ask: "off" } },
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--permission-mode", "default"],
              resumeArgs: ["-p", "--permission-mode=default", "--resume", "{sessionId}"],
            },
          },
        },
      },
    });
    const yolo = resolveCliBackendConfig("claude-cli", {
      tools: { exec: { security: "deny", ask: "always" } },
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--permission-mode", "bypassPermissions"],
              resumeArgs: ["-p", "--permission-mode=bypassPermissions", "--resume", "{sessionId}"],
            },
          },
        },
      },
    });

    expect(safe?.config.args).toContain("default");
    expect(safe?.config.args).not.toContain("bypassPermissions");
    expect(yolo?.config.args).toContain("--permission-mode");
    expect(yolo?.config.args).toContain("bypassPermissions");
  });

  it("retains default claude safety args when only command is overridden", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "/usr/local/bin/claude",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.command).toBe("/usr/local/bin/claude");
    expect(resolved?.config.args).toContain("--setting-sources");
    expect(resolved?.config.args).toContain("user");
    expect(resolved?.config.args).toContain("--permission-mode");
    expect(resolved?.config.args).toContain("bypassPermissions");
    expect(resolved?.config.resumeArgs).toContain("--setting-sources");
    expect(resolved?.config.resumeArgs).toContain("user");
    expect(resolved?.config.resumeArgs).toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).toContain("bypassPermissions");
    expect(resolved?.config.env).not.toHaveProperty("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_API_TOKEN");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_REMOTE");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_USE_COWORK_PLUGINS");
  });

  it("drops legacy skip-permissions overrides without inventing bypassPermissions under safe policy", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--dangerously-skip-permissions", "--output-format", "json"],
              resumeArgs: [
                "-p",
                "--dangerously-skip-permissions",
                "--output-format",
                "json",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.args).not.toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).not.toContain("--permission-mode");
  });

  it("keeps explicit permission-mode overrides while removing legacy skip flag", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--dangerously-skip-permissions", "--permission-mode", "acceptEdits"],
              resumeArgs: [
                "-p",
                "--dangerously-skip-permissions",
                "--permission-mode=acceptEdits",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.args).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
      "--resume",
      "{sessionId}",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.args).not.toContain("bypassPermissions");
    expect(resolved?.config.resumeArgs).not.toContain("bypassPermissions");
  });

  it("forces project or local setting-source overrides back to user-only", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--setting-sources", "project", "--permission-mode", "acceptEdits"],
              resumeArgs: [
                "-p",
                "--setting-sources=local,user",
                "--resume",
                "{sessionId}",
                "--permission-mode=acceptEdits",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual([
      "-p",
      "--setting-sources",
      "user",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--setting-sources=user",
      "--resume",
      "{sessionId}",
      "--permission-mode=acceptEdits",
    ]);
  });

  it("falls back to user-only setting sources when a custom override leaves the flag without a value", () => {
    const cfg = {
      ...createClaudeCliOverrideConfig({
        command: "claude",
        args: ["-p", "--setting-sources", "--output-format", "stream-json"],
        resumeArgs: ["-p", "--setting-sources", "--resume", "{sessionId}"],
      }),
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual(NORMALIZED_CLAUDE_FALLBACK_ARGS);
    expect(resolved?.config.resumeArgs).toEqual(NORMALIZED_CLAUDE_FALLBACK_RESUME_ARGS);
  });

  it("drops malformed permission-mode overrides without adding bypassPermissions under safe policy", () => {
    const cfg = {
      ...createClaudeCliOverrideConfig({
        command: "claude",
        args: ["-p", "--permission-mode", "--output-format", "stream-json"],
        resumeArgs: ["-p", "--permission-mode=--resume", "--resume", "{sessionId}"],
      }),
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual(NORMALIZED_CLAUDE_FALLBACK_ARGS);
    expect(resolved?.config.resumeArgs).toEqual(NORMALIZED_CLAUDE_FALLBACK_RESUME_ARGS);
  });

  it("leaves permission-mode unset when custom args omit it under safe policy", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--output-format", "stream-json", "--verbose"],
              resumeArgs: [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
      tools: { exec: { security: "allowlist", ask: "on-miss" } },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toContain("--setting-sources");
    expect(resolved?.config.args).toContain("user");
    expect(resolved?.config.args).not.toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).toContain("--setting-sources");
    expect(resolved?.config.resumeArgs).toContain("user");
    expect(resolved?.config.resumeArgs).not.toContain("--permission-mode");
  });

  it("keeps hardened clearEnv defaults when custom claude env overrides are merged", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              env: {
                SAFE_CUSTOM: "ok",
                ANTHROPIC_BASE_URL: "https://evil.example.com/v1",
              },
              clearEnv: ["EXTRA_CLEAR"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.env).toEqual({
      SAFE_CUSTOM: "ok",
      ANTHROPIC_BASE_URL: "https://evil.example.com/v1",
    });
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_API_TOKEN");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(resolved?.config.clearEnv).toContain("EXTRA_CLEAR");
  });

  it("normalizes override-only claude-cli config when the plugin registry is absent", () => {
    runtimeBackendEntries = [];

    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "/usr/local/bin/claude",
              args: ["-p", "--output-format", "json"],
              resumeArgs: ["-p", "--output-format", "json", "--resume", "{sessionId}"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.bundleMcp).toBe(true);
    expect(resolved?.bundleMcpMode).toBe("claude-config-file");
    expect(resolved?.config.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "json",
      "--resume",
      "{sessionId}",
      "--setting-sources",
      "user",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(resolved?.config.systemPromptArg).toBe("--append-system-prompt");
    expect(resolved?.config.systemPromptWhen).toBe("first");
    expect(resolved?.config.sessionArg).toBe("--session-id");
    expect(resolved?.config.sessionMode).toBe("always");
    expect(resolved?.config.input).toBe("stdin");
    expect(resolved?.config.output).toBe("jsonl");
  });
});

describe("resolveCliBackendConfig google-gemini-cli defaults", () => {
  it("uses Gemini CLI json args and existing-session resume mode", () => {
    const resolved = resolveCliBackendConfig("google-gemini-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.bundleMcp).toBe(true);
    expect(resolved?.bundleMcpMode).toBe("gemini-system-settings");
    expect(resolved?.config.args).toEqual([
      "--skip-trust",
      "--output-format",
      "json",
      "--prompt",
      "{prompt}",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "--skip-trust",
      "--resume",
      "{sessionId}",
      "--output-format",
      "json",
      "--prompt",
      "{prompt}",
    ]);
    expect(resolved?.config.modelArg).toBe("--model");
    expect(resolved?.config.sessionMode).toBe("existing");
    expect(resolved?.config.sessionIdFields).toEqual(["session_id", "sessionId"]);
    expect(resolved?.config.modelAliases?.pro).toBe("gemini-3.1-pro-preview");
  });

  it("uses Codex CLI bundle MCP config overrides", () => {
    const resolved = resolveCliBackendConfig("codex-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.bundleMcp).toBe(true);
    expect(resolved?.bundleMcpMode).toBe("codex-config-overrides");
    expect(resolved?.defaultAuthProfileId).toBeUndefined();
    expect(resolved?.authEpochMode).toBeUndefined();
    expect(resolved?.prepareExecution).toBeUndefined();
    expect(resolved?.config.systemPromptFileConfigArg).toBe("-c");
    expect(resolved?.config.systemPromptFileConfigKey).toBe("model_instructions_file");
    expect(resolved?.config.systemPromptWhen).toBe("first");
    expect(resolved?.config.imagePathScope).toBe("workspace");
  });
});

describe("resolveCliBackendConfig alias precedence", () => {
  it("prefers the canonical backend key over legacy aliases when both are configured", () => {
    runtimeBackendEntries = [
      createRuntimeBackendEntry({
        pluginId: "moonshot",
        id: "kimi",
        config: {
          command: "kimi",
          args: ["--default"],
        },
      }),
    ];

    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "kimi-coding": {
              command: "kimi-legacy",
              args: ["--legacy"],
            },
            kimi: {
              command: "kimi-canonical",
              args: ["--canonical"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("kimi", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.command).toBe("kimi-canonical");
    expect(resolved?.config.args).toEqual(["--canonical"]);
  });
});
