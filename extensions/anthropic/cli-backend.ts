/**
 * Claude CLI backend descriptor. It configures Claude Code process arguments,
 * MCP bundling, session handling, environment scrubbing, and watchdog defaults.
 */
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_CLEAR_ENV,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
  normalizeClaudeBackendConfig,
  resolveClaudeCliAutoCompactEnv,
  resolveClaudeCliExecutionArgs,
} from "./cli-shared.js";

/** Build the Claude CLI backend plugin descriptor. */
export function buildAnthropicCliBackend(): CliBackendPlugin {
  return {
    id: CLAUDE_CLI_BACKEND_ID,
    modelProvider: "anthropic",
    liveTest: {
      defaultModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@anthropic-ai/claude-code",
        binaryName: "claude",
      },
    },
    // Current native builds are self-contained; script distributions keep the
    // complete inference implementation in this published package tree.
    runtimeArtifact: {
      kind: "bundled-package-tree",
      packageName: "@anthropic-ai/claude-code",
      entrypoint: "command",
      nativeExecutableNames: ["claude", "claude.exe"],
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "selectable",
    sideQuestionToolMode: "disabled",
    ownsNativeCompaction: true,
    // Anthropic routes direct anthropic-messages calls on subscription OAuth
    // tokens to metered extra-usage billing (or rejects them without balance);
    // opted-in embedded runs on subscription credentials execute through this
    // backend on plan limits instead.
    subscriptionAuthDispatch: true,
    config: {
      command: "claude",
      args: [
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
        "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
      ],
      resumeArgs: [
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
        "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
        "--resume",
        "{sessionId}",
      ],
      forkArg: "--fork-session",
      output: "jsonl",
      liveSession: "claude-stdio",
      input: "stdin",
      modelArg: "--model",
      modelAliases: CLAUDE_CLI_MODEL_ALIASES,
      imageArg: "@",
      imagePathScope: "workspace",
      sessionArg: "--session-id",
      sessionMode: "always",
      reseedFromRawTranscriptWhenUncompacted: true,
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      systemPromptFileArg: "--append-system-prompt-file",
      systemPromptMode: "append",
      systemPromptWhen: "always",
      clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
    normalizeConfig: normalizeClaudeBackendConfig,
    autoSelectAuthProfile: false,
    prepareExecution: ({ contextTokenBudget }) => {
      const env = resolveClaudeCliAutoCompactEnv(contextTokenBudget);
      return env ? { env } : undefined;
    },
    resolveExecutionArgs: resolveClaudeCliExecutionArgs,
  };
}
