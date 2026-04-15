import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import {
  CLAUDE_CLI_CLEAR_ENV,
  normalizeClaudeBackendConfig,
  normalizeClaudePermissionArgs,
  normalizeClaudeSettingSourcesArgs,
} from "./cli-shared.js";

describe("normalizeClaudePermissionArgs", () => {
  it("injects bypassPermissions when args omit permission flags", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--output-format", "stream-json", "--verbose"]),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("removes legacy skip-permissions and injects bypassPermissions", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--dangerously-skip-permissions", "--verbose"]),
    ).toEqual(["-p", "--verbose", "--permission-mode", "bypassPermissions"]);
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

  it("treats a bare permission-mode flag as malformed and falls back to bypassPermissions", () => {
    expect(
      normalizeClaudePermissionArgs(["-p", "--permission-mode", "--output-format", "stream-json"]),
    ).toEqual(["-p", "--output-format", "stream-json", "--permission-mode", "bypassPermissions"]);
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
  });

  it("is wired through the anthropic cli backend normalize hook", () => {
    const backend = buildAnthropicCliBackend();
    const normalizeConfig = backend.normalizeConfig;

    expect(normalizeConfig).toBeTypeOf("function");

    const normalized = normalizeConfig?.({
      ...backend.config,
      args: ["-p", "--output-format", "stream-json", "--verbose"],
      resumeArgs: ["-p", "--output-format", "stream-json", "--verbose", "--resume", "{sessionId}"],
    });

    expect(normalized?.args).toContain("--permission-mode");
    expect(normalized?.args).toContain("bypassPermissions");
    expect(normalized?.args).toContain("--setting-sources");
    expect(normalized?.args).toContain("user");
    expect(normalized?.resumeArgs).toContain("--permission-mode");
    expect(normalized?.resumeArgs).toContain("bypassPermissions");
    expect(normalized?.resumeArgs).toContain("--setting-sources");
    expect(normalized?.resumeArgs).toContain("user");
  });

  it("leaves claude cli subscription-managed, restricts setting sources, and clears inherited env overrides", () => {
    const backend = buildAnthropicCliBackend();

    expect(backend.config.env).toBeUndefined();
    expect(backend.config.args).toContain("--setting-sources");
    expect(backend.config.args).toContain("user");
    expect(backend.config.resumeArgs).toContain("--setting-sources");
    expect(backend.config.resumeArgs).toContain("user");
    expect(backend.config.clearEnv).toEqual([...CLAUDE_CLI_CLEAR_ENV]);
    expect(backend.config.clearEnv).toContain("ANTHROPIC_API_TOKEN");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(backend.config.clearEnv).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(backend.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
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
});
