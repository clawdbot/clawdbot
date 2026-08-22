/** Type contracts for plugin-owned CLI backend integrations. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineHostCapability } from "../context-engine/types.js";

/** Static command adapter owned by a CLI backend plugin registration. */
export type CliBackendConfig = {
  /** CLI command to execute (absolute path or on PATH). */
  command: string;
  /** Base args applied to every invocation. */
  args?: string[];
  /** Output parsing mode (default: json). */
  output?: "json" | "text" | "jsonl";
  /** Output parsing mode when resuming a CLI session. */
  resumeOutput?: "json" | "text" | "jsonl";
  /** JSONL event dialect for CLIs with provider-specific stream formats. */
  jsonlDialect?: "claude-stream-json" | "gemini-stream-json";
  /** Long-lived CLI process mode. */
  liveSession?: "claude-stdio";
  /** Prompt input mode (default: arg). */
  input?: "arg" | "stdin";
  /** Max prompt length for arg mode (if exceeded, stdin is used). */
  maxPromptArgChars?: number;
  /** Extra env vars injected for this CLI. */
  env?: Record<string, string>;
  /** Env vars to remove before launching this CLI. */
  clearEnv?: string[];
  /** Flag used to pass model id (e.g. --model). */
  modelArg?: string;
  /** Model aliases mapping (OpenClaw model id → CLI model id). */
  modelAliases?: Record<string, string>;
  /** Args used to pass a session id (use {sessionId} placeholder). */
  sessionArgs?: string[];
  /** Alternate args to use when resuming a session (use {sessionId} placeholder). */
  resumeArgs?: string[];
  /** Argument appended to one explicitly forked resume invocation. */
  forkArg?: string;
  /** Argument followed by an assistant checkpoint id to bound one resumed fork. */
  resumeAtArg?: string;
  /** When to pass session ids. */
  sessionMode?: "always" | "existing" | "none";
  /** JSON fields to read session id from (in order). */
  sessionIdFields?: string[];
  /** Flag used to pass system prompt. */
  systemPromptArg?: string;
  /** Flag used to pass a system prompt file. */
  systemPromptFileArg?: string;
  /** Config override flag used to pass a system prompt file (e.g. -c). */
  systemPromptFileConfigArg?: string;
  /** Config override key used to pass a system prompt file. */
  systemPromptFileConfigKey?: string;
  /** System prompt behavior (append vs replace). */
  systemPromptMode?: "append" | "replace";
  /** When to send system prompt. */
  systemPromptWhen?: "first" | "always" | "never";
  /** Flag used to pass image paths. */
  imageArg?: string;
  /** How to pass multiple images. */
  imageMode?: "repeat" | "list";
  /** Where staged image files should live before handing them to the CLI. */
  imagePathScope?: "temp" | "workspace";
  /** Serialize runs for this CLI. */
  serialize?: boolean;
  /** Opt in to bounded raw transcript reseed before compaction for safe session resets. */
  reseedFromRawTranscriptWhenUncompacted?: boolean;
  /** Runtime reliability tuning for this backend's process lifecycle. */
  reliability?: {
    /** No-output watchdog tuning (fresh vs resumed runs). */
    watchdog?: {
      /** Fresh/new sessions (non-resume). */
      fresh?: {
        /** Fraction of overall timeout used when fixed timeout is not set. */
        noOutputTimeoutRatio?: number;
        /** Lower bound for computed watchdog timeout. */
        minMs?: number;
        /** Upper bound for computed watchdog timeout. */
        maxMs?: number;
      };
      /** Resume sessions. */
      resume?: {
        /** Fraction of overall timeout used when fixed timeout is not set. */
        noOutputTimeoutRatio?: number;
        /** Lower bound for computed watchdog timeout. */
        minMs?: number;
        /** Upper bound for computed watchdog timeout. */
        maxMs?: number;
      };
    };
  };
};

export type PluginTextReplacement = {
  from: string | RegExp;
  to: string;
};

export type PluginTextTransforms = {
  /** Rewrites applied to outbound prompt text before provider/CLI transport. */
  input?: PluginTextReplacement[];
  /** Rewrites applied to inbound assistant text before OpenClaw consumes it. */
  output?: PluginTextReplacement[];
};

export type CliBundleMcpMode =
  | "claude-config-file"
  | "codex-config-overrides"
  | "gemini-system-settings";

export type CliBackendPrepareExecutionContext = {
  config?: OpenClawConfig;
  workspaceDir: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  /** Effective OpenClaw context budget selected for this run. */
  contextTokenBudget?: number;
  /** Effective OpenClaw thinking level selected for this run. */
  thinkingLevel?: CliBackendThinkingLevel;
  authProfileId?: string;
  executionMode?: CliBackendExecutionMode;
  /** Exact runtime tool surface the backend must enforce for this run. */
  toolAvailability?: CliBackendToolAvailability;
  /** Core-prepared environment, including any bundled MCP settings path. */
  env?: Readonly<Record<string, string>>;
};

export type CliBackendPreparedExecution = {
  env?: Record<string, string>;
  clearEnv?: string[];
  /**
   * Backend-owned staging that must run after the core CLI queue admits the turn.
   * Use this for mutable per-profile CLI homes that the launched process also owns.
   */
  beforeExecution?: () => Promise<void>;
  cleanup?: () => Promise<void>;
  /** Positive acknowledgement for `prepare-execution` tool enforcement. */
  toolAvailabilityEnforced?: true;
};

export type CliBackendThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export type CliBackendExecutionMode = "agent" | "side-question";

/** Exact backend-native plus canonical OpenClaw tool surface for one CLI run. */
export type CliBackendToolAvailability = {
  native: readonly string[];
  /** Canonical OpenClaw tool names served through the host-isolated transport. */
  openClaw: readonly string[];
  /**
   * @deprecated Compatibility projection for CLI backend plugins built against
   * v2026.7.2-beta.1 through v2026.7.2-beta.3. Use `openClaw` for canonical names.
   */
  mcp: readonly string[];
};

export type CliBackendResolveExecutionArgsContext = {
  config?: OpenClawConfig;
  workspaceDir: string;
  provider: string;
  modelId: string;
  authProfileId?: string;
  thinkingLevel?: CliBackendThinkingLevel;
  executionMode?: CliBackendExecutionMode;
  toolAvailability?: CliBackendToolAvailability;
  useResume: boolean;
  baseArgs: readonly string[];
};

export type CliBackendResolveExecutionArgs = (
  ctx: CliBackendResolveExecutionArgsContext,
) => readonly string[] | null | undefined;

export type CliBackendJsonlUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type CliBackendParsedJsonlEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "toolStart";
      toolCallId: string;
      name: string;
      args?: Record<string, unknown>;
    }
  | {
      kind: "toolResult";
      toolCallId: string;
      name?: string;
      isError?: boolean;
      result?: unknown;
    }
  | {
      kind: "result";
      text?: string;
      sessionId?: string;
      usage?: CliBackendJsonlUsage;
      errorText?: string;
    }
  | { kind: "sessionId"; sessionId: string };

export type CliBackendParseJsonlEventContext = {
  backendId: string;
  backend: Readonly<CliBackendConfig>;
};

export type CliBackendParseJsonlEvent = (
  line: string,
  ctx: CliBackendParseJsonlEventContext,
) => CliBackendParsedJsonlEvent | readonly CliBackendParsedJsonlEvent[] | null | undefined;

export type CliBackendAuthEpochMode = "combined" | "profile-only";

export type CliBackendNativeToolMode = "none" | "always-on" | "selectable";

/** Backend-owned mechanism that enforces exact per-run tool availability. */
export type CliBackendToolAvailabilityEnforcement = "execution-args" | "prepare-execution";

export type CliBackendSideQuestionToolMode = "disabled";

type CliBackendExactToolAvailabilityVersionPolicy = Readonly<{
  /** Inclusive floor for stable package releases. */
  stableMinimum: string;
  /** Inclusive floors keyed by the first SemVer prerelease identifier. */
  prereleaseMinimums?: Readonly<Record<string, string>>;
}>;

export type CliBackendNormalizeConfigContext = {
  config?: OpenClawConfig;
  backendId: string;
  agentId?: string;
};

/** Backend-owned implementation boundary for script-backed CLI executables. */
export type CliBackendRuntimeArtifactPolicy = Readonly<{
  kind: "bundled-package-tree";
  /** Exact package.json name whose complete installed tree owns inference. */
  packageName: string;
  /** Only the command itself may be the package entrypoint. */
  entrypoint: "command";
  /** Supported package release lines when a run requests exact tool availability. */
  exactToolAvailabilityVersionPolicy?: CliBackendExactToolAvailabilityVersionPolicy;
  /** Canonical basenames allowed when this backend ships a self-contained native build. */
  nativeExecutableNames?: readonly string[];
}>;

/** Provider-owned protocol requirement for a long-lived CLI session. */
export type CliBackendLiveSessionRequirement = Readonly<{
  /** Exact capability the CLI must advertise before streamed output is trusted. */
  capability: string;
  /** First published version known to advertise the capability; runtime still feature-detects. */
  minimumVersion: string;
  /** Arguments used by setup and Doctor to obtain the installed CLI version. */
  versionArgs: readonly string[];
  /** Operator command that installs a compatible CLI version. */
  updateCommand: string;
}>;

/** Complete backend-owned contract for in-place native session compaction. */
type CliBackendManualCompaction = Readonly<{
  /** Builds the exact backend command for the resumed native session. */
  buildPrompt: (customInstructions?: string) => string;
  /** Prompt transport required by the backend control command. */
  input: "arg" | "stdin";
  /** Positively confirms that a successful process exit performed compaction. */
  validateOutput: (rawOutput: string) => { ok: true } | { ok: false; reason: string };
}>;

/** Plugin-owned CLI backend defaults used by the text-only CLI runner. */
type CliBackendPluginBase = {
  /** Provider id used in model refs, for example `claude-cli/opus`. */
  id: string;
  /** Canonical model provider whose models this CLI backend can execute. */
  modelProvider?: string;
  /** Static command adapter owned by this plugin. */
  config: CliBackendConfig;
  /**
   * Context-engine host capabilities provided by this backend when it is
   * driven through the generic CLI runner.
   */
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  /**
   * Whether embedded runs opted into `cliBackendDispatch: "subscription-auth"`
   * execute through this backend when the selected credential is
   * subscription-scoped (oauth/token) or unresolvable.
   *
   * Set only when this backend's model provider rejects or meters direct API
   * calls on subscription tokens, so the passthrough would fail or silently
   * bill outside plan limits. API-key credentials always keep the passthrough.
   */
  subscriptionAuthDispatch?: boolean;
  /**
   * Optional live-smoke metadata owned by the backend plugin.
   *
   * Keep provider-specific test wiring here instead of scattering it across
   * Docker wrappers, docs, and gateway live tests.
   */
  liveTest?: {
    defaultModelRef?: string;
    defaultImageProbe?: boolean;
    defaultMcpProbe?: boolean;
    docker?: {
      npmPackage?: string;
      binaryName?: string;
    };
  };
  /** Required whenever this backend can become a verified inference owner. */
  runtimeArtifact?: CliBackendRuntimeArtifactPolicy;
  /** Negotiated protocol capability required by this backend's live-session transport. */
  liveSessionRequirement?: CliBackendLiveSessionRequirement;
  /**
   * Whether OpenClaw should inject bundle MCP config for this backend.
   *
   * Keep this opt-in. Only backends that explicitly consume OpenClaw's bundle
   * MCP bridge should enable it.
   */
  bundleMcp?: boolean;
  /**
   * Provider-owned bundle MCP integration strategy.
   *
   * Different CLIs wire MCP through different surfaces:
   * - Claude: `--strict-mcp-config --mcp-config`
   * - Codex: `-c mcp_servers=...`
   * - Gemini: system-level `settings.json`
   */
  bundleMcpMode?: CliBundleMcpMode;
  /**
   * Optional config normalizer applied to the registered adapter.
   */
  normalizeConfig?: (
    config: CliBackendConfig,
    context?: CliBackendNormalizeConfigContext,
  ) => CliBackendConfig;
  /**
   * Backend-owned final system-prompt transform.
   *
   * Use this for tiny CLI-specific compatibility rewrites without replacing
   * the generic CLI runner or prompt builder.
   */
  transformSystemPrompt?: (ctx: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    modelDisplay: string;
    agentId?: string;
    systemPrompt: string;
  }) => string | null | undefined;
  /**
   * Backend-owned bidirectional text replacements.
   *
   * `input` applies to the system prompt and user prompt passed to the CLI.
   * `output` applies to parsed/streamed assistant text from the CLI.
   */
  textTransforms?: PluginTextTransforms;
  /**
   * Preferred auth-profile id when the caller did not explicitly lock one.
   *
   * Use this when the backend should consume a canonical OpenClaw auth profile
   * rather than ambient host auth by default.
   */
  defaultAuthProfileId?: string;
  /**
   * Session/auth epoch source policy.
   *
   * `combined` keeps the legacy "host credential + auth profile" fingerprint.
   * `profile-only` treats the selected OpenClaw auth profile as the sole auth
   * owner for session invalidation when one is present.
   */
  authEpochMode?: CliBackendAuthEpochMode;
  /**
   * Whether `prepareExecution` may auto-select a configured auth profile.
   *
   * Defaults to true for auth bridges. Set false for environment/config-only
   * hooks that do not consume OpenClaw auth profiles.
   */
  autoSelectAuthProfile?: boolean;
  /**
   * Backend-owned execution bridge.
   *
   * Use this on async run paths when the backend needs a generated auth/config
   * bridge (for example a private CLI home directory) without teaching the core
   * runner about provider-specific file formats.
   */
  prepareExecution?: (
    ctx: CliBackendPrepareExecutionContext,
  ) =>
    | Promise<CliBackendPreparedExecution | null | undefined>
    | CliBackendPreparedExecution
    | null
    | undefined;
  /**
   * Backend-owned per-run argv rewrite.
   *
   * Use this for request-scoped CLI dialect flags that should not be modeled
   * as static config, such as mapping OpenClaw thinking levels to a backend's
   * native effort flag.
   */
  resolveExecutionArgs?: CliBackendResolveExecutionArgs;
  /** How this backend enforces an exact per-run `toolAvailability` contract. */
  toolAvailabilityEnforcement?: CliBackendToolAvailabilityEnforcement;
  /**
   * Backend-owned JSONL line parser for provider-specific stream formats.
   *
   * Tool events report execution already performed by the backend. OpenClaw
   * renders them but does not treat them as host tool execution or delivery evidence.
   */
  parseJsonlEvent?: CliBackendParseJsonlEvent;
  /**
   * Whether this CLI backend can expose native tools outside OpenClaw's tool
   * catalog. Exact restricted runs require `selectable` plus a declared
   * `toolAvailabilityEnforcement`; `always-on` backends fail closed.
   */
  nativeToolMode?: CliBackendNativeToolMode;
  /**
   * Side-question native tool behavior.
   *
   * Set to `disabled` only when `executionMode: "side-question"` reliably
   * launches the CLI without native tools, even if normal agent turns expose
   * backend-owned tools.
   */
  sideQuestionToolMode?: CliBackendSideQuestionToolMode;
};

type CliBackendNativeCompactionContract =
  | {
      /** Backend-owned compaction for a persisted resumable CLI transcript. */
      ownsNativeCompaction: true;
      /** Optional control operation for explicit manual compaction. */
      manualCompaction?: CliBackendManualCompaction;
    }
  | {
      /** Boolean-compatible ownership for existing plugins without manual compaction. */
      ownsNativeCompaction?: boolean;
      manualCompaction?: never;
    };

/** Plugin-owned CLI backend defaults used by the text-only CLI runner. */
export type CliBackendPlugin = CliBackendPluginBase & CliBackendNativeCompactionContract;
