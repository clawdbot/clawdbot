import type { AnyAgentTool } from "../tools/common.js";

type AgentHarnessHostApprovalDecision = "allow-once" | "allow-always" | "deny";

type AgentHarnessHostApprovalTerminalReason =
  | "user"
  | "timeout"
  | "malformed-verdict"
  | "no-route"
  | "run-aborted"
  | "gateway-restart"
  | "storage-corrupt";

type AgentHarnessHostApprovalResult = Readonly<{
  decision: AgentHarnessHostApprovalDecision | null | undefined;
  terminalReason: AgentHarnessHostApprovalTerminalReason | null | undefined;
}>;

type AgentHarnessPreparedEnvironment = Readonly<{
  credentialScrubEnv: Readonly<Record<string, string>>;
  localIdentityEnv: Readonly<Record<string, string>>;
  /** Local child destination facts; must not be projected into a remote or sandbox process. */
  localProcessEnv?: Readonly<Record<string, string>>;
  /** Non-secret fact used to select the local GitHub identity overlay. */
  managedLocalIdentity: boolean;
}>;

type AgentHarnessToolSurfaceOptions = Omit<
  NonNullable<Parameters<(typeof import("../agent-tools.js"))["createOpenClawCodingTools"]>[0]>,
  "operationalRunInstance"
>;

export type AgentHarnessHostCapabilities = Readonly<{
  kind: "agent-harness-host-capability";
  version: 1;
  /** Fails closed unless this exact admitted run capability remains active. */
  assertActive: () => void;
  /** Reports one completed model call's output tokens to this admitted run's live total. */
  reportOutputTokens?: (outputTokens: number) => void;
  /** Adds native provenance only to this host's exact current admitted prompt. */
  annotateCurrentUserTurn?: (
    annotation: import("../../sessions/user-turn-transcript.types.js").UserTurnTranscriptAnnotation,
  ) => Promise<void>;
  /** Closure-bound event sink backed by the host-owned trajectory recorder. */
  trajectory?: Readonly<{
    recordEvent: (type: string, data?: Record<string, unknown>) => void;
    flush: () => Promise<void>;
  }>;
  /** Closure-bound non-secret maps prepared before harness placement. */
  preparedEnvironment?: () => AgentHarnessPreparedEnvironment;
  /** Applies the exact host caller binding to a plugin-built tool surface. */
  bindToolSurface: (tools: AnyAgentTool[], options?: Readonly<{ cwd?: string }>) => AnyAgentTool[];
  /** Creates and binds core tools without exposing admitted-run correlation to the plugin. */
  createToolSurface?: (
    options: AgentHarnessToolSurfaceOptions,
    bindingOptions?: Readonly<{ cwd?: string }>,
  ) => AnyAgentTool[];
  /** Core-owned byte binding for a native command approval, scoped to this admitted run. */
  prepareMutableFileApproval?: (request: { command: string; cwd?: string }) => Promise<
    | {
        ok: true;
        requiresOneShot: boolean;
        revalidate: () => Promise<{ ok: true } | { ok: false; message: string }>;
      }
    | { ok: false; message: string }
  >;
  /** Runs policy with host-fixed HookContext; callers provide only the native action tuple. */
  runBeforeToolCall: (
    request: Omit<
      Parameters<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>[0],
      "approvalMode" | "ctx"
    > & {
      /** Native relays may defer approval for a correlated app-server callback. */
      approvalMode?: "request" | "defer";
      /** Action-local facts from the native runtime; host authority remains closure-bound. */
      nativeOperation?: Readonly<{ cwd?: string }>;
    },
  ) => ReturnType<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>;
  requestApproval: (request: {
    signal?: AbortSignal;
    title: string;
    description: string;
    severity: "info" | "warning";
    toolName: string;
    toolCallId?: string;
    mcpTool?: { server: string; tool: string };
    /** Persistence-only proof; loss of correlation does not cancel a one-shot approval. */
    isMcpToolApprovalActive?: () => boolean;
    allowedDecisions?: AgentHarnessHostApprovalDecision[];
    timeoutMs: number;
    transportTimeoutMs?: number;
  }) => Promise<{ id?: string; decision?: AgentHarnessHostApprovalDecision | null } | undefined>;
  waitForApproval: (request: {
    approvalId: string;
    timeoutMs: number;
    transportTimeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<AgentHarnessHostApprovalResult | undefined>;
}>;
