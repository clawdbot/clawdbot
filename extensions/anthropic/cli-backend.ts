/**
 * Claude CLI backend descriptor. It configures Claude Code process arguments,
 * MCP bundling, session handling, and credential transport.
 */
import { createHmac, randomBytes } from "node:crypto";
import type {
  CliBackendExecuteContext,
  CliBackendPlugin,
  CliBackendPreparedExecution,
} from "openclaw/plugin-sdk/cli-backend";
import { resolveClaudeCliContextWindowModelId } from "./cli-catalog.js";
import { parseClaudeCliJsonlEvent } from "./cli-output.js";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_CLEAR_ENV,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
  normalizeClaudeBackendConfig,
  resolveClaudeCliAutoCompactEnv,
  resolveClaudeCliExecutionArgs,
  resolveClaudeCliThinkingEnv,
} from "./cli-shared.js";
import anthropicPluginPackage from "./package.json" with { type: "json" };

type ClaudeCliAuthCredential =
  | { type: "oauth"; access: string; expires: number }
  | { type: "token"; token: string }
  | { type: "api_key"; key: string }
  | { type: string };

type ClaudeCliPreparedExecution = CliBackendPreparedExecution & {
  isolatedCompletionEnforced?: true;
  secretInput: {
    fd: 3;
    fingerprint: string;
    createData: () => Buffer;
  };
};

const CLAUDE_CLI_CREDENTIAL_FINGERPRINT_KEY = randomBytes(32);
// SDK import and query() set these in process.env. Seed them before core
// fingerprints the child env so the first resumed turn keeps its warm query.
const CLAUDE_AGENT_SDK_ENV = {
  CLAUDE_AGENT_SDK_VERSION: anthropicPluginPackage.dependencies["@anthropic-ai/claude-agent-sdk"],
  NoDefaultCurrentDirectoryInExePath: "1",
};
const CLAUDE_CLI_DEFAULT_ARGS = [
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
] as const;

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
  // Forwarded OAuth here is OpenClaw-managed material (its refresh path is
  // OpenClaw-owned). Native `claude` logins are never forwarded; the current
  // Claude process reads its own config directory. An expired token here is
  // therefore OpenClaw-managed state that must fail loudly.
  if (credential?.type === "oauth" && "access" in credential) {
    const expires = "expires" in credential ? credential.expires : undefined;
    if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= Date.now()) {
      throw new Error(
        "Selected Claude CLI OAuth credential is expired or invalid. Re-authenticate the selected profile and retry. OpenClaw did not start the run.",
      );
    }
    if (typeof credential.access !== "string") {
      return undefined;
    }
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
export function buildAnthropicCliBackend(
  options: {
    ensureDynamicSystemPromptSectionsSupport?: () => Promise<void>;
    supportsDynamicSystemPromptSections?: () => boolean;
  } = {},
): CliBackendPlugin {
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
    manualCompaction: {
      buildPrompt: (customInstructions) => {
        const instructions = customInstructions?.trim();
        return instructions ? `/compact ${instructions}` : "/compact";
      },
      input: "arg",
      validateOutput: (rawOutput) => {
        for (const line of rawOutput.split("\n")) {
          try {
            const event = JSON.parse(line) as {
              compact_result?: unknown;
              type?: unknown;
              subtype?: unknown;
            };
            // Claude Code 2.0.76, 2.1.225, and 2.1.226 emit these terminal
            // records; system/status with status=compacting is progress only.
            if (
              event.compact_result === "success" ||
              (event.type === "system" && event.subtype === "compact_boundary")
            ) {
              return { ok: true };
            }
          } catch {
            // Ignore non-JSON process noise; the positive acknowledgement is authoritative.
          }
        }
        return {
          ok: false,
          reason: "Claude CLI did not confirm that native compaction ran.",
        };
      },
    },
    // Anthropic routes direct anthropic-messages calls on subscription OAuth
    // tokens to metered extra-usage billing (or rejects them without balance);
    // opted-in embedded runs on subscription credentials execute through this
    // backend on plan limits instead.
    subscriptionAuthDispatch: true,
    config: {
      command: "claude",
      args: [...CLAUDE_CLI_DEFAULT_ARGS],
      resumeArgs: [...CLAUDE_CLI_DEFAULT_ARGS, "--resume", "{sessionId}"],
      forkArg: "--fork-session",
      // Claude Code 2.1.209+ exposes this hidden print-mode flag, and stream-json
      // emits the matching transcript UUID on assistant records.
      resumeAtArg: "--resume-session-at",
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
      freshSessionRecovery: "invalidated-only",
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      systemPromptFileArg: "--append-system-prompt-file",
      systemPromptMode: "append",
      systemPromptWhen: "always",
      clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
      serialize: true,
    },
    normalizeConfig: normalizeClaudeBackendConfig,
    resolveModelId: ({ modelId, contextWindow }) =>
      resolveClaudeCliContextWindowModelId(modelId, contextWindow),
    authEpochMode: "profile-only",
    prepareExecution: (context) => {
      const prepare = () => {
        const credentialContext = context as typeof context & {
          authCredential?: ClaudeCliAuthCredential;
          isolatedCompletionPrompt?: string;
          isolatedCompletionSystemPrompt?: string;
        };
        const authInput = resolveClaudeCliAuthInput(credentialContext.authCredential);
        const isolatedCompletion = credentialContext.isolatedCompletionPrompt !== undefined;
        const agentSdkExecution =
          !isolatedCompletion && context.executionMode === "agent"
            ? {
                async *execute(executionContext: CliBackendExecuteContext) {
                  const { executeClaudeAgentSdk } = await import("./agent-sdk.runtime.js");
                  yield* executeClaudeAgentSdk(executionContext, authInput?.secretInput);
                },
              }
            : undefined;
        const env = {
          ...(agentSdkExecution ? CLAUDE_AGENT_SDK_ENV : {}),
          ...resolveClaudeCliAutoCompactEnv(context.contextTokenBudget),
          ...(context.contextWindow === "200k" ? { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } : {}),
          ...resolveClaudeCliThinkingEnv(context.thinkingLevel, context.modelId),
          ...authInput?.env,
        };
        return Object.keys(env).length > 0 || isolatedCompletion || agentSdkExecution
          ? {
              env,
              // The paired side-question argv projection disables settings, memory,
              // hooks, session persistence, and tools before process launch.
              ...(isolatedCompletion ? { isolatedCompletionEnforced: true as const } : {}),
              ...(authInput?.clearEnv ? { clearEnv: authInput.clearEnv } : {}),
              ...(authInput?.secretInput ? { secretInput: authInput.secretInput } : {}),
              ...(authInput?.cleanup ? { cleanup: authInput.cleanup } : {}),
              ...agentSdkExecution,
            }
          : undefined;
      };
      const supportProbe = options.ensureDynamicSystemPromptSectionsSupport?.();
      return supportProbe ? supportProbe.then(prepare) : prepare();
    },
    parseJsonlEvent: parseClaudeCliJsonlEvent,
    resolveExecutionArgs: (context) =>
      resolveClaudeCliExecutionArgs(context, {
        excludeDynamicSystemPromptSections: options.supportsDynamicSystemPromptSections?.(),
      }),
  };
}
