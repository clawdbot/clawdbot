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
import { parseClaudeCliJsonlEvent, parseClaudeCliJsonlLifecycleEvent } from "./cli-output.js";
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
  secretInput?: {
    fd: 3;
    fingerprint: string;
    createData: () => Buffer;
    envName?: "ANTHROPIC_AUTH_TOKEN";
  };
};

const CLAUDE_CLI_CREDENTIAL_FINGERPRINT_KEY = randomBytes(32);
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

// Only equivalent bare tools confer general capabilities; Glob and notebook-cell
// edits do not. Bash is foreground-only at launch, so it never grants `process`.
const CLAUDE_NATIVE_TOOL_CAPABILITIES: Readonly<Record<string, string>> = {
  read: "read",
  grep: "read",
  write: "write",
  edit: "edit",
  bash: "exec",
  webfetch: "web_fetch",
  websearch: "web_search",
};

function projectClaudeNativeToolAuthority(nativeTools: readonly string[]): readonly string[] {
  const selected = new Set(nativeTools.map((name) => name.trim().toLowerCase()));
  // Mapping order keeps persisted caps deterministic across native initialization events.
  return [
    ...new Set(
      Object.entries(CLAUDE_NATIVE_TOOL_CAPABILITIES)
        .filter(([name]) => selected.has(name))
        .map(([, capability]) => capability),
    ),
  ];
}

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

function createClaudeCliAuthTokenInput(value: string): ClaudeCliPreparedExecution | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  // Z.AI's documented Claude Code contract is specifically ANTHROPIC_AUTH_TOKEN.
  // Claude's private OAuth descriptor selects Anthropic OAuth semantics instead
  // and Z.AI rejects that request even when the underlying token is valid.
  const source = Buffer.from(trimmed, "utf8");
  let disposed = false;
  return {
    clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
    secretInput: {
      fd: 3,
      envName: "ANTHROPIC_AUTH_TOKEN",
      fingerprint: createHmac("sha256", CLAUDE_CLI_CREDENTIAL_FINGERPRINT_KEY)
        .update(source)
        .digest("hex"),
      createData: () => {
        if (disposed) {
          throw new Error("Claude CLI auth input is no longer available.");
        }
        return Buffer.from(source);
      },
    },
    cleanup: async () => {
      disposed = true;
      source.fill(0);
    },
  };
}

function resolveClaudeCliAuthInput(
  credential: ClaudeCliAuthCredential | undefined,
  options: { apiKeyAsAuthToken?: boolean } = {},
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
    if (options.apiKeyAsAuthToken) {
      return createClaudeCliAuthTokenInput(credential.key);
    }
    return createClaudeCliAuthInput({
      envName: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      value: credential.key,
    });
  }
  return undefined;
}

export type ClaudeAgentSdkCliBackendOptions = {
  /** Stable runtime id; the default is the bundled Anthropic runtime. */
  backendId?: string;
  /** Canonical provider whose configured models this runtime executes. */
  modelProvider?: string;
  /** Model used by the optional live CLI smoke contract. */
  defaultModelRef?: string;
  /** Explicit provider-owned endpoint, applied after inherited routing is cleared. */
  endpoint?: string;
  /** Z.AI's Anthropic-compatible endpoint requires bearer-token authentication. */
  apiKeyAsAuthToken?: boolean;
  /** Z.AI model ids are already literal Claude Code model ids. */
  modelAliases?: Record<string, string>;
  /** Only Anthropic's Claude catalog uses the `[1m]` model selector. */
  supportsOneMillionModelSuffix?: boolean;
  /** Whether subscription credentials must dispatch through this backend. */
  subscriptionAuthDispatch?: boolean;
  ensureDynamicSystemPromptSectionsSupport?: () => Promise<void>;
  supportsDynamicSystemPromptSections?: () => boolean;
};

/**
 * Build a Claude Agent SDK CLI backend for an Anthropic-protocol provider.
 *
 * The execution bridge remains deliberately shared: it owns host-mediated
 * native-tool permissions, AskUserQuestion mediation, warm sessions, and
 * protected descriptor-based credential delivery.
 */
export function buildClaudeAgentSdkCliBackend(
  options: ClaudeAgentSdkCliBackendOptions = {},
): CliBackendPlugin {
  return {
    id: options.backendId ?? CLAUDE_CLI_BACKEND_ID,
    modelProvider: options.modelProvider ?? "anthropic",
    liveTest: {
      defaultModelRef: options.defaultModelRef ?? CLAUDE_CLI_DEFAULT_MODEL_REF,
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
    projectNativeToolAuthority: projectClaudeNativeToolAuthority,
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
    subscriptionAuthDispatch: options.subscriptionAuthDispatch ?? true,
    config: {
      command: "claude",
      args: [...CLAUDE_CLI_DEFAULT_ARGS],
      resumeArgs: [...CLAUDE_CLI_DEFAULT_ARGS, "--resume", "{sessionId}"],
      forkArg: "--fork-session",
      // Claude Code 2.1.209+ exposes this hidden print-mode flag, and stream-json
      // emits the matching transcript UUID on assistant records.
      resumeAtArg: "--resume-session-at",
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      liveSession: "claude-stdio",
      input: "stdin",
      modelArg: "--model",
      modelAliases: options.modelAliases ?? CLAUDE_CLI_MODEL_ALIASES,
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
    // Bare ids keep the CLI default; an explicit 1M selection must override
    // Claude's settings.json 200K limit. The 200K choice is enforced by env below.
    resolveModelId: ({ modelId, contextWindow }) =>
      options.supportsOneMillionModelSuffix !== false && contextWindow === "1m"
        ? `${modelId}[1m]`
        : modelId,
    authEpochMode: "profile-only",
    autoSelectAuthProfile: false,
    prepareExecution: (context) => {
      const prepare = () => {
        const credentialContext = context as typeof context & {
          authCredential?: ClaudeCliAuthCredential;
          isolatedCompletionPrompt?: string;
          isolatedCompletionSystemPrompt?: string;
        };
        const authInput = resolveClaudeCliAuthInput(credentialContext.authCredential, {
          apiKeyAsAuthToken: options.apiKeyAsAuthToken,
        });
        const isolatedCompletion = credentialContext.isolatedCompletionPrompt !== undefined;
        const cliExecution =
          !isolatedCompletion && context.executionMode === "agent"
            ? {
                async *execute(executionContext: CliBackendExecuteContext) {
                  const { executeClaudeCli } = await import("./cli.runtime.js");
                  executionContext.assertCurrent?.();
                  yield* executeClaudeCli(executionContext, authInput?.secretInput);
                },
              }
            : undefined;
        const env = {
          ...resolveClaudeCliAutoCompactEnv(context.contextTokenBudget),
          ...(context.contextWindow === "200k" ? { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } : {}),
          ...resolveClaudeCliThinkingEnv(context.thinkingLevel, context.modelId),
          ...(options.endpoint ? { ANTHROPIC_BASE_URL: options.endpoint } : {}),
          ...authInput?.env,
        };
        return Object.keys(env).length > 0 || isolatedCompletion || cliExecution
          ? {
              env,
              // The paired side-question argv projection disables settings, memory,
              // hooks, session persistence, and tools before process launch.
              ...(isolatedCompletion ? { isolatedCompletionEnforced: true as const } : {}),
              ...(authInput?.clearEnv ? { clearEnv: authInput.clearEnv } : {}),
              ...(authInput?.secretInput ? { secretInput: authInput.secretInput } : {}),
              ...(authInput?.cleanup ? { cleanup: authInput.cleanup } : {}),
              ...cliExecution,
            }
          : undefined;
      };
      const supportProbe = options.ensureDynamicSystemPromptSectionsSupport?.();
      return supportProbe ? supportProbe.then(prepare) : prepare();
    },
    parseJsonlEvent: parseClaudeCliJsonlEvent,
    parseJsonlLifecycleEvent: parseClaudeCliJsonlLifecycleEvent,
    resolveExecutionArgs: (context) =>
      resolveClaudeCliExecutionArgs(context, {
        excludeDynamicSystemPromptSections: options.supportsDynamicSystemPromptSections?.(),
      }),
  };
}

/** Build the bundled Anthropic Claude CLI backend plugin descriptor. */
export function buildAnthropicCliBackend(
  options: Pick<
    ClaudeAgentSdkCliBackendOptions,
    "ensureDynamicSystemPromptSectionsSupport" | "supportsDynamicSystemPromptSections"
  > = {},
): CliBackendPlugin {
  return buildClaudeAgentSdkCliBackend(options);
}
