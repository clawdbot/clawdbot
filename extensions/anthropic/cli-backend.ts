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
  // OpenClaw-owned). Imported native `claude` logins are never forwarded —
  // core runs those as identity-verified passthrough — so an expired token
  // reaching this point is a real fault worth failing loudly, not refreshable
  // state this plugin could repair.
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
    // Claude Code 2.1.206 first shipped per-input lifecycle correlation. The
    // runtime checks the advertised capability so backports and wrappers work.
    liveSessionRequirement: {
      capability: "msg_lifecycle_v1",
      minimumVersion: "2.1.206",
      versionArgs: ["--version"],
      updateCommand: "claude update",
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
      const prepare = () => {
        const credentialContext = context as typeof context & {
          authCredential?: ClaudeCliAuthCredential;
          isolatedCompletionPrompt?: string;
          isolatedCompletionSystemPrompt?: string;
        };
        const authInput = resolveClaudeCliAuthInput(credentialContext.authCredential);
        const isolatedCompletion = credentialContext.isolatedCompletionPrompt !== undefined;
        const env = {
          ...resolveClaudeCliAutoCompactEnv(context.contextTokenBudget),
          ...resolveClaudeCliThinkingEnv(context.thinkingLevel, context.modelId),
          ...authInput?.env,
        };
        return Object.keys(env).length > 0 || isolatedCompletion
          ? {
              env,
              // The paired side-question argv projection disables settings, memory,
              // hooks, session persistence, and tools before process launch.
              ...(isolatedCompletion ? { isolatedCompletionEnforced: true as const } : {}),
              ...(authInput?.clearEnv ? { clearEnv: authInput.clearEnv } : {}),
              ...(authInput?.secretInput ? { secretInput: authInput.secretInput } : {}),
              ...(authInput?.cleanup ? { cleanup: authInput.cleanup } : {}),
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
