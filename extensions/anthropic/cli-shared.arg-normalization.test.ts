// Covers how the Claude CLI backend normalizes its argv: permission mode,
// setting sources, and the default that keeps Claude Code's own memory
// surfaces out of the agent context OpenClaw composes.
import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { normalizeClaudeBackendConfig, resolveClaudeCliExecutionArgs } from "./cli-shared.js";

// Spelled out rather than imported so a change to the shipped payload has to be
// restated here; this default should not be able to move silently.
const CLAUDE_MEMORY_ISOLATION_SETTINGS =
  '{"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}';
const CLAUDE_RESTRICTED_SETTINGS =
  '{"disableAllHooks":true,"enabledPlugins":{},"autoMemoryEnabled":false,"claudeMdExcludes":["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/rules/**"]}';
const CLAUDE_MEMORY_ISOLATION_ARGS = ["--settings", CLAUDE_MEMORY_ISOLATION_SETTINGS];

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

function readSettingsPayload(args: readonly string[]): string | undefined {
  const index = args.indexOf("--settings");
  return index >= 0 ? args[index + 1] : undefined;
}

describe("Claude backend permission args", () => {
  it("removes legacy skip-permissions without adding bypassPermissions", () => {
    expect(normalizeClaudeArgs(["-p", "--dangerously-skip-permissions", "--verbose"])).toEqual([
      "-p",
      "--verbose",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
  });

  it("keeps explicit permission-mode overrides", () => {
    expect(normalizeClaudeArgs(["-p", "--permission-mode", "acceptEdits"])).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
    expect(normalizeClaudeArgs(["-p", "--permission-mode=acceptEdits"])).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
  });

  it("drops malformed permission-mode flags in both split and equals forms", () => {
    expect(
      normalizeClaudeArgs(["-p", "--permission-mode", "--output-format", "stream-json"]),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
    expect(normalizeClaudeArgs(["-p", "--permission-mode="])).toEqual([
      "-p",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
    expect(normalizeClaudeArgs(["-p", "--permission-mode=--output-format"])).toEqual([
      "-p",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
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
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
  });

  it("forces explicit project or local setting sources back to user-only", () => {
    expect(normalizeClaudeArgs(["-p", "--setting-sources", "project"])).toEqual([
      "-p",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
    expect(normalizeClaudeArgs(["-p", "--setting-sources=local,user"])).toEqual([
      "-p",
      "--setting-sources=user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
  });

  it("treats a bare setting-sources flag as malformed and falls back to user-only", () => {
    expect(
      normalizeClaudeArgs(["-p", "--setting-sources", "--output-format", "stream-json"]),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--setting-sources",
      "user",
      ...CLAUDE_MEMORY_ISOLATION_ARGS,
    ]);
  });
});

describe("Claude backend memory isolation", () => {
  it("keeps Claude Code's own memory surfaces out of an ordinary run", () => {
    // `--setting-sources user` already excludes project *settings files*.
    // CLAUDE.md and auto-memory are separate mechanisms it does not cover, so
    // without this the agent context silently gains instructions addressed to
    // Claude Code as a coding assistant, which OpenClaw never composed.
    expect(readSettingsPayload(normalizeClaudeArgs(["-p", "--verbose"]) ?? [])).toBe(
      CLAUDE_MEMORY_ISOLATION_SETTINGS,
    );
  });

  it("ships the isolation payload on the real backend descriptor, fresh and resumed", () => {
    const normalized = normalizeClaudeBackendConfig(buildAnthropicCliBackend().config, {
      backendId: "claude-cli",
    } as Parameters<typeof normalizeClaudeBackendConfig>[1]);

    expect(readSettingsPayload(normalized.args ?? [])).toBe(CLAUDE_MEMORY_ISOLATION_SETTINGS);
    expect(readSettingsPayload(normalized.resumeArgs ?? [])).toBe(CLAUDE_MEMORY_ISOLATION_SETTINGS);
  });

  it.each([
    { form: "split", args: ["-p", "--settings", '{"autoMemoryEnabled":true}'] },
    { form: "equals", args: ["-p", '--settings={"autoMemoryEnabled":true}'] },
  ])("leaves an operator's own --settings payload alone ($form)", ({ args }) => {
    // An operator who supplies a payload owns it; appending a second --settings
    // would silently override the choice they made.
    const normalized = normalizeClaudeArgs(args) ?? [];

    expect(normalized.filter((arg) => arg.startsWith("--settings"))).toHaveLength(1);
    expect(normalized).not.toContain(CLAUDE_MEMORY_ISOLATION_SETTINGS);
    expect(normalized.join(" ")).toContain('{"autoMemoryEnabled":true}');
  });

  it("still hands restricted runs the stricter profile, not the ordinary one", () => {
    // Restricted runs strip the inherited payload and substitute their own, so
    // the ordinary default must neither leak through nor double up.
    const resolved = resolveClaudeCliExecutionArgs({
      workspaceDir: "/tmp",
      provider: "claude-cli",
      modelId: "claude-opus-4-8",
      useResume: false,
      baseArgs: ["-p", "--settings", CLAUDE_MEMORY_ISOLATION_SETTINGS],
      toolAvailability: { native: [], openClaw: ["openclaw"] },
    });

    expect(resolved.filter((arg) => arg.startsWith("--settings"))).toHaveLength(1);
    expect(readSettingsPayload(resolved)).toBe(CLAUDE_RESTRICTED_SETTINGS);
  });
});
