import type { AnyAgentTool } from "../tools/common.js";

type AgentHarnessHostApprovalDecision = "allow-once" | "allow-always" | "deny";

export type AgentHarnessHostCapabilities = Readonly<{
  kind: "agent-harness-host-capability";
  version: 1;
  /** Applies the exact host caller binding to a plugin-built tool surface. */
  bindToolSurface: (tools: AnyAgentTool[]) => AnyAgentTool[];
  /** Runs policy with host-fixed HookContext; callers provide only the native action tuple. */
  runBeforeToolCall: (
    request: Omit<
      Parameters<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>[0],
      "approvalMode" | "ctx"
    > & {
      /** Action-local facts from the native runtime; host authority remains closure-bound. */
      nativeOperation?: Readonly<{ cwd?: string }>;
    },
  ) => ReturnType<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>;
  requestApproval: (request: {
    title: string;
    description: string;
    severity: "info" | "warning";
    toolName: string;
    toolCallId?: string;
    allowedDecisions?: AgentHarnessHostApprovalDecision[];
    timeoutMs: number;
    transportTimeoutMs?: number;
  }) => Promise<{ id?: string; decision?: AgentHarnessHostApprovalDecision | null } | undefined>;
  waitForApproval: (request: {
    approvalId: string;
    timeoutMs: number;
    transportTimeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<AgentHarnessHostApprovalDecision | null | undefined>;
}>;
