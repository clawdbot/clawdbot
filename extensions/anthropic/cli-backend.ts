/**
 * Claude CLI backend descriptor. It configures Claude Code process arguments,
 * MCP bundling, session handling, credential transport, and watchdog defaults.
 */
import { createHmac, randomBytes } from "node:crypto";
import type {
  CliBackendPlugin,
  CliBackendPreparedExecution,
} from "openclaw/plugin-sdk/cli-backend";
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

type ClaudeCliAuthCredential =
  | { type: "oauth"; access: string }
  | { type: "token"; token: string }
  | { type: "api_key"; key: string }
  | { type: string };

type ClaudeCliPreparedExecution = CliBackendPreparedExecution & {
  secretInput: {
    fd: 3;
    fingerprint: string;
    createData: () => Buffer;
  };
};

const CLAUDE_CLI_CREDENTIAL_FINGERPRINT_KEY = randomBytes(32);

function createClaudeCliAuthInput(params: {
  envName: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" | "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR";
  value: string;
}): ClaudeCliPreparedExecution | undefined {
  const trimmed = params.value.trim();
  if (!trimmed) {
    return undefined;
  }
  const source = Buffer.from(trimmed, "utf8");
  let destroyed = false;
  return {
    env: { [params.envName]: "3" },
    clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
    secretInput: {
      fd: 3,
      fingerprint: createHmac("sha256", CLAUDE_CLI_CREDENTIAL_FINGERPRINT_KEY)
        .update(source)
        .digest("hex"),
      createData: () => {
        if (destroyed) {
          throw new Error("Claude CLI credential input is no longer available");
        }
        return Buffer.from(source);
      },
    },
    cleanup: async () => {
      destroyed = true;
      source.fill(0);
    },
  };
}

function resolveClaudeCliAuthInput(
  credential: ClaudeCliAuthCredential | undefined,
): ClaudeCliPreparedExecution | undefined {
  if (
    credential?.type === "oauth" &&
    "access" in credential &&
    typeof credential.access === "string"
  ) {
    return createClaudeCliAuthInput({
      envName: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      value: credential.access,
    });
  }
  if (
    credential?.type === "token" &&
    "token" in credential &&
    typeof credential.token === "string"
  ) {
    return createClaudeCliAuthInput({
      envName: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      value: credential.token,
    });
  }
  if (credential?.type === "api_key" && "key" in credential && typeof credential.key === "string") {
    return createClaudeCliAuthInput({
      envName: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      value: credential.key,
    });
  }
  return undefined;
}

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
    toolAvailabilityEnforcement: "execution-args",
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
      sessionArgs: ["--session-id", "{sessionId}"],
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
    authEpochMode: "profile-only",
    prepareExecution: (context) => {
      const credentialContext = context as typeof context & {
        authCredential?: ClaudeCliAuthCredential;
      };
      const authInput = resolveClaudeCliAuthInput(credentialContext.authCredential);
      const env = {
        ...resolveClaudeCliAutoCompactEnv(context.contextTokenBudget),
        ...authInput?.env,
      };
      return Object.keys(env).length > 0
        ? {
            env,
            ...(authInput?.clearEnv ? { clearEnv: authInput.clearEnv } : {}),
            ...(authInput?.secretInput ? { secretInput: authInput.secretInput } : {}),
            ...(authInput?.cleanup ? { cleanup: authInput.cleanup } : {}),
          }
        : undefined;
    },
    resolveExecutionArgs: resolveClaudeCliExecutionArgs,
  };
}
