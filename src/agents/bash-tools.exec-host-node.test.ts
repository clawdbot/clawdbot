/**
 * Node-host exec orchestration tests.
 * Covers node target resolution, remote prepare/invoke payloads, approvals,
 * auto-review, and follow-up execution paths.
 */
import crypto from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../packages/gateway-client/src/timeouts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ExecAllowlistEntry } from "../infra/exec-approvals.types.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";

type ExecAutoReviewer = typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
type ExecAutoReviewDecision = Awaited<ReturnType<ExecAutoReviewer>>;
type ExecAsk = import("../infra/exec-approvals.js").ExecAsk;
type ExecSecurity = import("../infra/exec-approvals.js").ExecSecurity;
type MockAllowAlwaysPersistenceInput = Parameters<
  typeof import("../infra/exec-approvals.js").resolveAllowAlwaysPersistenceDecision
>[0];
type MockAllowAlwaysPersistenceDecision =
  import("../infra/exec-approvals.js").AllowAlwaysPersistenceDecision;
type MockExecApprovalDecision = import("../infra/exec-approvals.js").ExecApprovalDecision;
type MockExecApprovalUnavailableDecision =
  import("../infra/exec-approvals.js").ExecApprovalUnavailableDecision;
type MockAllowlistSegment = {
  raw?: string;
  resolution: null;
  argv: string[];
};
type MockAllowlistResult = {
  allowlistMatches: unknown[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: MockAllowlistSegment[];
  segmentAllowlistEntries: unknown[];
  segmentSatisfiedBy?: unknown[];
};
type MockExecAllowlistEntry = {
  pattern: string;
  argPattern?: string;
  source?: "allow-always";
  commandText?: string;
};
type MockRegisteredExecApprovalRequest = {
  approvalId: string;
  approvalSlug: string;
  warningText: string;
  expiresAtMs: number;
  preResolvedDecision: string | null | undefined;
  initiatingSurface: unknown;
  sentApproverDms: boolean;
  unavailableReason: string | null;
};

type MockExecApprovalsResolved = {
  allowlist: MockExecAllowlistEntry[];
  file: { version: 1; agents: Record<string, unknown> };
  agent: {
    security: ExecSecurity;
    ask: ExecAsk;
    askFallback?: "deny";
    autoAllowSkills?: false;
  };
};
type ShellAllowlistMockParams = {
  command?: string;
  allowlist?: unknown[];
  env?: NodeJS.ProcessEnv;
};
type RequiresExecApprovalMockParams = {
  ask?: string;
  security?: string;
  analysisOk?: boolean;
  allowlistSatisfied?: boolean;
  durableApprovalSatisfied?: boolean;
};

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

const preparedPlan = vi.hoisted(() => ({
  argv: ["bun", "./script.ts"],
  cwd: "/tmp/work",
  commandText: "bun ./script.ts",
  commandPreview: "bun ./script.ts",
  agentId: "prepared-agent",
  sessionKey: "prepared-session",
  policySnapshot: {
    security: "full" as const,
    ask: "off" as const,
    askFallback: "deny" as const,
    autoAllowSkills: false,
    allowlistRules: [{ pattern: "/usr/local/bin/bun" }],
  },
  mutableFileOperand: {
    argvIndex: 1,
    path: "/tmp/work/script.ts",
    sha256: "abc123",
  },
}));
const nodeCommandMarker = vi.hoisted(() => "=node-command:test");
const exactCommandMarker = (commandText: string): string =>
  `=command:${crypto.createHash("sha256").update(commandText).digest("hex").slice(0, 16)}`;

const callGatewayToolMock = vi.hoisted(() => vi.fn());
const listNodesMock = vi.hoisted(() => vi.fn());
const parsePreparedSystemRunPayloadMock = vi.hoisted(() => vi.fn());
const commandRequiresSecurityAuditSuppressionApprovalMock = vi.hoisted(() => vi.fn(() => false));
const evaluateShellAllowlistMock = vi.hoisted(() =>
  vi.fn((_raw?: ShellAllowlistMockParams): MockAllowlistResult => ({
    allowlistMatches: [],
    analysisOk: true,
    allowlistSatisfied: false,
    segments: [{ resolution: null, argv: ["bun", "./script.ts"] }],
    segmentAllowlistEntries: [],
    segmentSatisfiedBy: [],
  })),
);
const hasNodeCommandAllowAlwaysMarkerMock = vi.hoisted(() =>
  vi.fn((raw: unknown): boolean =>
    ((raw as { allowlist?: Array<{ pattern?: string }> }).allowlist ?? []).some(
      (entry) => entry.pattern === "=node-command:test",
    ),
  ),
);
const resolveAllowAlwaysPatternCoverageMock = vi.hoisted(() =>
  vi.fn((_raw: unknown): unknown => ({
    complete: true,
    patterns: [{ pattern: "/trusted/bin/tool" }],
  })),
);
const resolveExecApprovalsFromFileMock = vi.hoisted(() =>
  vi.fn((): MockExecApprovalsResolved => ({
    allowlist: [],
    file: { version: 1, agents: {} },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
  })),
);
const requiresExecApprovalMock = vi.hoisted(() =>
  vi.fn((_raw?: RequiresExecApprovalMockParams) => true),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const resolveAllowAlwaysPersistenceDecisionMock = vi.hoisted(() =>
  vi.fn((_raw: MockAllowAlwaysPersistenceInput): MockAllowAlwaysPersistenceDecision => ({
    kind: "patterns",
    patterns: [{ pattern: "/trusted/bin/tool" }],
  })),
);
const resolveExecApprovalAllowedDecisionsMock = vi.hoisted(() =>
  vi.fn(
    (params?: {
      ask?: string | null;
      allowAlwaysPersistence?: { kind: string } | null;
    }): readonly MockExecApprovalDecision[] =>
      params?.ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot"
        ? ["allow-once", "deny"]
        : ["allow-once", "allow-always", "deny"],
  ),
);
const resolveExecApprovalUnavailableDecisionsMock = vi.hoisted(() =>
  vi.fn(
    (params?: {
      ask?: string | null;
      allowAlwaysPersistence?: { kind: string } | null;
    }): readonly MockExecApprovalUnavailableDecision[] =>
      params?.ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot"
        ? ["allow-always"]
        : [],
  ),
);
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    approvals: { allowlist: [] as ExecAllowlistEntry[], file: { version: 1, agents: {} } },
    hostSecurity: "full",
    hostAsk: "off",
    askFallback: "deny",
  })),
);
const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() =>
  vi.fn(
    (
      _params?: unknown,
    ): MockRegisteredExecApprovalRequest | Promise<MockRegisteredExecApprovalRequest> | undefined =>
      undefined,
  ),
);
const runAbortedApprovalError = vi.hoisted(() => new Error("approval owning run aborted"));
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: {
      approvalId: string;
      preResolvedDecision: string | null | undefined;
      onFailure: () => void;
    }): Promise<string | null | undefined> => "allow-once",
  ),
);
const createExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    (): {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
    } => ({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    }),
  ),
);
const shouldResolveExecApprovalUnavailableInlineMock = vi.hoisted(() =>
  vi.fn(
    (_params: {
      unavailableReason: string | null;
      preResolvedDecision: string | null | undefined;
    }) => false,
  ),
);
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn(async (_target: unknown, _resultText: string) => undefined),
);
const enforceStrictInlineEvalApprovalBoundaryMock = vi.hoisted(() =>
  vi.fn(
    (value: {
      baseDecision: { timedOut: boolean };
      approvedByAsk: boolean;
      deniedReason: string | null;
      requiresInlineEvalApproval: boolean;
      requiresAutoReviewHumanApproval?: boolean;
    }) => ({
      approvedByAsk: value.approvedByAsk,
      deniedReason: value.deniedReason,
    }),
  ),
);
const resolveExecApprovalDecisionStateMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      decision: string | null;
      askFallback: ExecSecurity;
      resolveTimedOut?: (state: {
        baseDecision: { timedOut: boolean };
        approvedByAsk: boolean;
        deniedReason: string | null;
      }) =>
        | Promise<{ approvedByAsk: boolean; deniedReason: string | null; context?: unknown }>
        | { approvedByAsk: boolean; deniedReason: string | null; context?: unknown };
      requiresExplicitApproval: boolean | ((context: unknown) => boolean);
      requiresAutoReviewHumanApproval?: boolean;
    }) => {
      const initial = createExecApprovalDecisionStateMock();
      let approvedByAsk = initial.approvedByAsk;
      let deniedReason = initial.deniedReason;
      let timeoutContext: unknown;
      if (initial.baseDecision.timedOut && params.resolveTimedOut) {
        const timedOut = await params.resolveTimedOut(initial);
        approvedByAsk = timedOut.approvedByAsk;
        deniedReason = timedOut.deniedReason;
        timeoutContext = timedOut.context;
      } else if (params.decision === "allow-once" || params.decision === "allow-always") {
        approvedByAsk = true;
      }
      const requiresExplicitApproval =
        typeof params.requiresExplicitApproval === "function"
          ? params.requiresExplicitApproval(timeoutContext)
          : params.requiresExplicitApproval;
      const strict = enforceStrictInlineEvalApprovalBoundaryMock({
        baseDecision: initial.baseDecision,
        approvedByAsk,
        deniedReason,
        requiresInlineEvalApproval: requiresExplicitApproval,
        ...(params.requiresAutoReviewHumanApproval !== undefined
          ? { requiresAutoReviewHumanApproval: params.requiresAutoReviewHumanApproval }
          : {}),
      });
      return { ...initial, ...strict, timeoutContext };
    },
  ),
);
const createExecApprovalRequestRouteMock = vi.hoisted(() =>
  vi.fn(
    async (
      params: Record<string, unknown> & {
        askFallback: ExecSecurity;
        resolveTimedOut?: (state: {
          baseDecision: { timedOut: boolean };
          approvedByAsk: boolean;
          deniedReason: string | null;
        }) =>
          | Promise<{ approvedByAsk: boolean; deniedReason: string | null; context?: unknown }>
          | { approvedByAsk: boolean; deniedReason: string | null; context?: unknown };
        requiresExplicitApproval: boolean | ((context: unknown) => boolean);
        requiresAutoReviewHumanApproval?: boolean;
      },
    ) => {
      const request = await createAndRegisterDefaultExecApprovalRequestMock(params);
      if (!request) {
        throw new Error("missing test approval request");
      }
      const inline = shouldResolveExecApprovalUnavailableInlineMock({
        unavailableReason: request.unavailableReason,
        preResolvedDecision: request.preResolvedDecision,
      });
      if (!inline) {
        return { ...request, kind: "wait" as const };
      }
      const state = await resolveExecApprovalDecisionStateMock({
        ...params,
        decision: request.preResolvedDecision ?? null,
      });
      return { ...request, kind: "inline" as const, preResolvedDecision: null, state };
    },
  ),
);
const resolveExecApprovalWaitOutcomeMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      approvalId: string;
      preResolvedDecision: string | null | undefined;
      signal?: AbortSignal;
      askFallback: ExecSecurity;
      resolveTimedOut?: (state: {
        baseDecision: { timedOut: boolean };
        approvedByAsk: boolean;
        deniedReason: string | null;
      }) =>
        | Promise<{ approvedByAsk: boolean; deniedReason: string | null; context?: unknown }>
        | { approvedByAsk: boolean; deniedReason: string | null; context?: unknown };
      requiresExplicitApproval: boolean | ((context: unknown) => boolean);
      requiresAutoReviewHumanApproval?: boolean;
    }) => {
      let decision: string | null | undefined;
      try {
        decision = await resolveApprovalDecisionOrUndefinedMock({
          approvalId: params.approvalId,
          preResolvedDecision: params.preResolvedDecision,
          onFailure: () => {},
        });
      } catch (error) {
        return error === runAbortedApprovalError
          ? { kind: "run-aborted" as const }
          : { kind: "request-failed" as const };
      }
      if (decision === undefined) {
        return { kind: "request-failed" as const };
      }
      if (params.signal?.aborted) {
        return { kind: "run-aborted" as const };
      }
      const state = await resolveExecApprovalDecisionStateMock({ ...params, decision });
      return params.signal?.aborted
        ? { kind: "run-aborted" as const }
        : { kind: "resolved" as const, decision, state };
    },
  ),
);
const registerExecApprovalRequestForHostOrThrowMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
const detectInterpreterInlineEvalArgvMock = vi.hoisted(() =>
  vi.fn(
    (): {
      executable: string;
      normalizedExecutable: string;
      flag: string;
      argv: string[];
    } | null => null,
  ),
);

vi.mock("../infra/exec-approvals.js", () => ({
  countObsoleteGeneratedExecApprovals: vi.fn(() => 0),
  evaluateShellAllowlist: evaluateShellAllowlistMock,
  evaluateShellAllowlistWithAuthorization: evaluateShellAllowlistMock,
  commandRequiresSecurityAuditSuppressionApproval:
    commandRequiresSecurityAuditSuppressionApprovalMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  hasNodeCommandAllowAlwaysMarker: hasNodeCommandAllowAlwaysMarkerMock,
  requiresExecApproval: requiresExecApprovalMock,
  resolveAllowAlwaysPersistenceDecision: resolveAllowAlwaysPersistenceDecisionMock,
  resolveAllowAlwaysPatternCoverage: resolveAllowAlwaysPatternCoverageMock,
  resolveExecApprovalAllowedDecisions: resolveExecApprovalAllowedDecisionsMock,
  resolveExecApprovalUnavailableDecisions: resolveExecApprovalUnavailableDecisionsMock,
  resolveExecApprovalsFromFile: resolveExecApprovalsFromFileMock,
  maxAsk: (a: ExecAsk, b: ExecAsk): ExecAsk => {
    const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
    return order[a] >= order[b] ? a : b;
  },
  minSecurity: (a: ExecSecurity, b: ExecSecurity): ExecSecurity => {
    const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
    return order[a] <= order[b] ? a : b;
  },
}));

vi.mock("../infra/command-analysis/inline-eval.js", () => ({
  describeInterpreterInlineEval: vi.fn(() => "inline-eval"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

vi.mock("../infra/node-shell.js", () => ({
  buildNodeShellCommand: vi.fn(() => ["/bin/sh", "-lc", "bun ./script.ts"]),
}));

vi.mock("../infra/system-run-approval-context.js", () => ({
  parsePreparedSystemRunPayload: parsePreparedSystemRunPayloadMock,
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  isExecApprovalRunAbortedError: (error: unknown) => error === runAbortedApprovalError,
  registerExecApprovalRequestForHostOrThrow: registerExecApprovalRequestForHostOrThrowMock,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  createExecApprovalRequestRoute: createExecApprovalRequestRouteMock,
  shouldResolveExecApprovalUnavailableInline: shouldResolveExecApprovalUnavailableInlineMock,
  buildExecApprovalFollowupTarget: vi.fn((value) => value),
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  resolveExecApprovalDecisionState: resolveExecApprovalDecisionStateMock,
  resolveExecApprovalWaitOutcome: resolveExecApprovalWaitOutcomeMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  createApprovalSlug: vi.fn(() => "slug"),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

const resolveNodeIdFromListMock = vi.hoisted(() =>
  vi.fn((nodes: Array<{ nodeId: string; displayName?: string }>, query?: string) => {
    if (!query) {
      if (nodes.length === 1) {
        return expectDefined(nodes[0], "nodes[0] test invariant").nodeId;
      }
      throw new Error("node required");
    }
    const byId = nodes.find((n) => n.nodeId === query);
    if (byId) {
      return byId.nodeId;
    }
    const byName = nodes.find((n) => n.displayName === query);
    if (byName) {
      return byName.nodeId;
    }
    if (query.length >= 6) {
      const byPrefix = nodes.find((n) => n.nodeId.startsWith(query));
      if (byPrefix) {
        return byPrefix.nodeId;
      }
    }
    throw new Error(`unknown node: ${query}`);
  }),
);

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: listNodesMock,
  resolveNodeIdFromList: resolveNodeIdFromListMock,
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
}));

let executeNodeHostCommand: typeof import("./bash-tools.exec-host-node.js").executeNodeHostCommand;

function createNodeHostRequest(
  overrides: Partial<ExecuteNodeHostCommandParams> = {},
): ExecuteNodeHostCommandParams {
  return {
    command: "bun ./script.ts",
    workdir: "/tmp/work",
    env: {},
    security: "full",
    ask: "off",
    defaultTimeoutSec: 30,
    approvalRunningNoticeMs: 0,
    warnings: [],
    agentId: "requested-agent",
    sessionKey: "requested-session",
    ...overrides,
  };
}

type MockNodeInvokeParams = {
  command?: string;
  timeoutMs?: number;
  params?: Record<string, unknown>;
};

type GatewayToolCall = {
  method: string;
  options: { timeoutMs?: number };
  params?: MockNodeInvokeParams;
  callOptions?: unknown;
};

function requireGatewayCommand(command: string): GatewayToolCall {
  const call = callGatewayToolMock.mock.calls.find(
    ([method, , params]) =>
      method === "node.invoke" && (params as MockNodeInvokeParams | undefined)?.command === command,
  );
  if (!call) {
    throw new Error(`expected gateway command ${command}`);
  }
  const [method, options, params, callOptions] = call as [
    string,
    { timeoutMs?: number },
    MockNodeInvokeParams | undefined,
    unknown,
  ];
  return { method, options, params, callOptions };
}

function requireRunParams(call: GatewayToolCall): Record<string, unknown> {
  expect(call.method).toBe("node.invoke");
  expect(call.params?.command).toBe("system.run");
  const params = call.params?.params;
  if (!params) {
    throw new Error("expected system.run params");
  }

  return params;
}

function createNodeInvokeFailure(params: {
  code: string;
  nodeCommandDispatched?: boolean;
  message?: string;
}): Error {
  return Object.assign(new Error(params.message ?? "node invoke failed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "UNAVAILABLE",
    details: {
      nodeError: {
        code: params.code,
        message: params.message ?? "node invoke failed",
      },
      ...(params.nodeCommandDispatched !== undefined
        ? { nodeCommandDispatched: params.nodeCommandDispatched }
        : {}),
    },
  });
}

function requireRegisteredApprovalRequest(): Record<string, unknown> {
  const calls = registerExecApprovalRequestForHostOrThrowMock.mock.calls as unknown as [
    Record<string, unknown>,
  ][];
  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error("expected approval request registration");
  }
  return firstCall[0];
}

function expectSystemRunInvoke(params: {
  invokeDeadlineMs: number;
  invokeWaitMs: number;
  runTimeoutMs: number;
}) {
  const call = requireGatewayCommand("system.run");
  // Three ordered budgets: node program runtime < Gateway invocation deadline <
  // caller wait, so the Gateway deadline answer wins over a caller giving up.
  expect(requireRunParams(call).timeoutMs).toBe(params.runTimeoutMs);
  expect(call.params?.timeoutMs).toBe(params.invokeDeadlineMs);
  expect(call.options.timeoutMs).toBe(params.invokeWaitMs);
  expect(params.runTimeoutMs).toBeLessThanOrEqual(params.invokeDeadlineMs);
  expect(params.invokeDeadlineMs).toBeLessThanOrEqual(params.invokeWaitMs);
  expect(params.invokeDeadlineMs).toBeGreaterThan(0);
  expect(Number.isFinite(params.invokeWaitMs)).toBe(true);
}

function createNodeGatewayHandler(params: {
  approvals: Record<string, unknown> | Error;
  allowApprovalResolve?: boolean;
  execPolicy?: { security: string; ask: string };
  stderr?: string;
  stdout?: string;
}) {
  return async (method: string, _options: unknown, invoke: MockNodeInvokeParams | undefined) => {
    if (method === "exec.approvals.node.get") {
      if (params.approvals instanceof Error) {
        throw params.approvals;
      }
      return { file: params.approvals };
    }
    if (method === "exec.approval.resolve" && params.allowApprovalResolve) {
      return { payload: {} };
    }
    if (method !== "node.invoke") {
      throw new Error(`unexpected gateway method: ${method}`);
    }
    if (invoke?.command === "system.run.prepare") {
      return {
        payload: {
          plan: preparedPlan,
          ...(params.execPolicy ? { execPolicy: params.execPolicy } : {}),
        },
      };
    }
    if (invoke?.command === "system.run") {
      return {
        payload: {
          success: true,
          stdout: params.stdout ?? "ok",
          stderr: params.stderr ?? "",
          exitCode: 0,
          timedOut: false,
        },
      };
    }
    throw new Error(`unexpected node invoke command: ${String(invoke?.command)}`);
  };
}

function mockGatewayInvokesWithNodeApprovals(file: Record<string, unknown>) {
  callGatewayToolMock.mockImplementation(createNodeGatewayHandler({ approvals: file }));
}

function usePolicyApprovalRequirementMock() {
  requiresExecApprovalMock.mockImplementation((raw: unknown) => {
    const params = raw as {
      ask: string;
      security: string;
      analysisOk: boolean;
      allowlistSatisfied: boolean;
      durableApprovalSatisfied: boolean;
    };
    return (
      params.ask === "always" ||
      (params.ask === "on-miss" &&
        params.security === "allowlist" &&
        (!params.analysisOk || !params.allowlistSatisfied) &&
        !params.durableApprovalSatisfied)
    );
  });
}

function buildAllowlistEvalResult(params?: {
  allowlistSatisfied?: boolean;
  segmentAllowlistEntry?: { pattern: string } | null;
}) {
  return {
    allowlistMatches:
      params?.allowlistSatisfied && params.segmentAllowlistEntry
        ? [params.segmentAllowlistEntry]
        : [],
    analysisOk: true,
    allowlistSatisfied: params?.allowlistSatisfied === true,
    segments: [{ resolution: null, argv: ["tool", "--version"] }],
    segmentAllowlistEntries:
      params?.allowlistSatisfied && params.segmentAllowlistEntry
        ? [params.segmentAllowlistEntry]
        : [null],
    segmentSatisfiedBy: [params?.allowlistSatisfied ? "allowlist" : null],
  };
}

function captureProcessUnhandledRejections() {
  const reasons: unknown[] = [];
  const originalProcessEmit = process.emit.bind(process);
  const processEmit = vi.spyOn(process, "emit").mockImplementation((event, ...args) => {
    if (event === "unhandledRejection") {
      reasons.push(args[0]);
      return true;
    }
    return originalProcessEmit(event, ...args);
  });
  return { reasons, restore: () => processEmit.mockRestore() };
}

describe("executeNodeHostCommand", () => {
  beforeAll(async () => {
    ({ executeNodeHostCommand } = await import("./bash-tools.exec-host-node.js"));
  });

  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({
        approvals: { version: 1, agents: {} },
        allowApprovalResolve: true,
      }),
    );
    listNodesMock.mockReset();
    listNodesMock.mockResolvedValue([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
    ]);
    parsePreparedSystemRunPayloadMock.mockReset();
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: { security: "full", ask: "off" },
    });

    commandRequiresSecurityAuditSuppressionApprovalMock.mockReset();
    commandRequiresSecurityAuditSuppressionApprovalMock.mockReturnValue(false);
    evaluateShellAllowlistMock.mockReset();
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["bun", "./script.ts"] }],
      segmentAllowlistEntries: [],
    });
    hasNodeCommandAllowAlwaysMarkerMock.mockClear();
    resolveAllowAlwaysPatternCoverageMock.mockReset();
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({
      complete: true,
      patterns: [{ pattern: "/trusted/bin/tool" }],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(false);
    resolveExecApprovalsFromFileMock.mockReset();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [],
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    requiresExecApprovalMock.mockReset();
    usePolicyApprovalRequirementMock();
    resolveAllowAlwaysPersistenceDecisionMock.mockReset();
    resolveAllowAlwaysPersistenceDecisionMock.mockReturnValue({
      kind: "patterns",
      patterns: [{ pattern: "/trusted/bin/tool" }],
    });
    resolveExecApprovalAllowedDecisionsMock.mockClear();
    resolveExecApprovalUnavailableDecisionsMock.mockClear();
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockImplementation(async (args?: unknown) => {
      const register =
        args && typeof args === "object" && "register" in args
          ? (args as { register?: (approvalId: string) => Promise<void> }).register
          : undefined;
      await register?.("approval-1");
      return {
        approvalId: "approval-1",
        approvalSlug: "slug-1",
        warningText: "",
        expiresAtMs: Date.now() + 60_000,
        preResolvedDecision: null,
        initiatingSurface: "origin",
        sentApproverDms: false,
        unavailableReason: null,
      };
    });
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    });
    shouldResolveExecApprovalUnavailableInlineMock.mockReset();
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(false);
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      content: [],
      details: { status: "approval-pending" },
    });
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) => ({
      approvedByAsk: value.approvedByAsk,
      deniedReason: value.deniedReason,
    }));
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    registerExecApprovalRequestForHostOrThrowMock.mockReset();
  });

  it("returns outcome-unknown after an inline auto-approved node disconnect", async () => {
    const defaultImplementation = callGatewayToolMock.getMockImplementation();
    callGatewayToolMock.mockImplementation(
      async (method: string, options: unknown, callParams: MockNodeInvokeParams | undefined) => {
        if (method === "node.invoke" && callParams?.command === "system.run") {
          throw createNodeInvokeFailure({
            code: "DISCONNECTED",
            nodeCommandDispatched: true,
            message: "node disconnected",
          });
        }
        if (!defaultImplementation) {
          throw new Error("missing default gateway mock");
        }
        return await defaultImplementation(method, options, callParams);
      },
    );
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe read",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    requiresExecApprovalMock.mockImplementation(
      (value?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
        value?.allowlistSatisfied !== true && value?.durableApprovalSatisfied !== true,
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details).toMatchObject({
      status: "failed",
      reason: "outcome-unknown",
      nodeInvokeFailure: {
        failureCode: "DISCONNECTED",
        nodeCommandDispatched: true,
      },
    });
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).toHaveBeenCalledTimes(4);
  });

  it("denies non-interactive approval requests without creating operator events", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });
    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        ask: "always",
        nonInteractiveApproval: true,
        agentId: "collector",
        sessionKey: "agent:collector:subagent:child",
      }),
    );

    expect(result.details).toMatchObject({
      status: "failed",
      failureKind: "approval_required",
    });
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an already-rejected approval", delayed: false },
    { name: "an approval cancelled after the pending result", delayed: true },
  ])("drops detached node execution without an unhandled rejection for $name", async (scenario) => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      const pendingDecision = createDeferred<string | null | undefined>();
      if (scenario.delayed) {
        resolveApprovalDecisionOrUndefinedMock.mockReturnValueOnce(pendingDecision.promise);
      } else {
        resolveApprovalDecisionOrUndefinedMock.mockRejectedValueOnce(runAbortedApprovalError);
      }
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "deny",
      });

      const result = await executeNodeHostCommand(createNodeHostRequest({}));

      expect(result.details?.status).toBe("approval-pending");
      expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledOnce();
      if (scenario.delayed) {
        pendingDecision.reject(runAbortedApprovalError);
      }
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
      expect(
        callGatewayToolMock.mock.calls.some(
          ([method, , params]) =>
            method === "node.invoke" &&
            (params as MockNodeInvokeParams | undefined)?.command === "system.run",
        ),
      ).toBe(false);
    } finally {
      unhandledRejections.restore();
    }
  });

  it("consumes rejected detached node approval recovery and fallback follow-ups", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      resolveExecApprovalWaitOutcomeMock.mockResolvedValueOnce({ kind: "request-failed" });
      sendExecApprovalFollowupResultMock.mockRejectedValue(
        new Error("approval failure follow-up unavailable"),
      );
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "deny",
      });

      const result = await executeNodeHostCommand(createNodeHostRequest({}));

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(2));
      await setImmediate();
      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, approval-request-failed): bun ./script.ts",
      );
      expect(sendExecApprovalFollowupResultMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, approval-request-failed): bun ./script.ts",
      );
      expect(
        callGatewayToolMock.mock.calls.some(
          ([method, , params]) =>
            method === "node.invoke" &&
            (params as MockNodeInvokeParams | undefined)?.command === "system.run",
        ),
      ).toBe(false);
    } finally {
      unhandledRejections.restore();
    }
  });

  it("reports outcome-unknown after an approved detached node timeout", async () => {
    const defaultImplementation = callGatewayToolMock.getMockImplementation();
    callGatewayToolMock.mockImplementation(
      async (method: string, options: unknown, callParams: MockNodeInvokeParams | undefined) => {
        if (method === "node.invoke" && callParams?.command === "system.run") {
          throw createNodeInvokeFailure({
            code: "TIMEOUT",
            nodeCommandDispatched: true,
            message: "node invoke timed out",
          });
        }
        if (!defaultImplementation) {
          throw new Error("missing default gateway mock");
        }
        return await defaultImplementation(method, options, callParams);
      },
    );
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(createNodeHostRequest({ ask: "always" }));

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        expect.stringContaining(
          "Exec outcome unknown (node=node-1 id=approval-1, outcome-unknown)",
        ),
      );
    });
    const followup = sendExecApprovalFollowupResultMock.mock.calls[0]?.[1];
    expect(followup).toContain("The command may have executed. Do not rerun it automatically.");
    expect(followup).not.toContain("Exec denied");
  });

  it("never replaces a detached outcome-unknown result with denial when delivery fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    const defaultImplementation = callGatewayToolMock.getMockImplementation();

    try {
      callGatewayToolMock.mockImplementation(
        async (method: string, options: unknown, callParams: MockNodeInvokeParams | undefined) => {
          if (method === "node.invoke" && callParams?.command === "system.run") {
            throw createNodeInvokeFailure({
              code: "DISCONNECTED",
              nodeCommandDispatched: true,
              message: "node disconnected",
            });
          }
          if (!defaultImplementation) {
            throw new Error("missing default gateway mock");
          }
          return await defaultImplementation(method, options, callParams);
        },
      );
      sendExecApprovalFollowupResultMock.mockRejectedValueOnce(
        new Error("outcome-unknown follow-up unavailable"),
      );
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "deny",
      });

      const result = await executeNodeHostCommand(createNodeHostRequest({ ask: "always" }));

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalled();
      });
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        expect.stringContaining(
          "Exec outcome unknown (node=node-1 id=approval-1, outcome-unknown)",
        ),
      );
    } finally {
      unhandledRejections.restore();
    }
  });

  it("does not report a failed detached approval after its owning run is aborted", async () => {
    const abortController = new AbortController();
    resolveApprovalDecisionOrUndefinedMock.mockImplementationOnce(async (params) => {
      abortController.abort(new Error("run aborted before approval failure delivery"));
      params?.onFailure();
      return undefined;
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        signal: abortController.signal,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await setImmediate();
    expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledOnce();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("never reports a completed detached node command as denied when delivery fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      sendExecApprovalFollowupResultMock.mockRejectedValueOnce(
        new Error("completion follow-up unavailable"),
      );
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "deny",
      });

      const result = await executeNodeHostCommand(createNodeHostRequest({}));

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalled();
      });
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec finished (node=node-1 id=approval-1, code 0)\nok",
      );
      expect(requireGatewayCommand("system.run")).toBeDefined();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("drops a detached node approval when cancellation wins before consumption", async () => {
    const pendingDecision = createDeferred<string | null | undefined>();
    const abortController = new AbortController();
    resolveApprovalDecisionOrUndefinedMock.mockReturnValueOnce(pendingDecision.promise);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        signal: abortController.signal,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledOnce();
    abortController.abort();
    pendingDecision.resolve("allow-once");
    await setImmediate();

    expect(createExecApprovalDecisionStateMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("drops a detached node approval cancelled during final policy revalidation", async () => {
    const abortController = new AbortController();
    const policy = {
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full" as const,
      hostAsk: "always" as const,
      askFallback: "deny" as const,
    };
    const policyCheckpoint = createDeferred<typeof policy>();
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce(policy)
      .mockImplementationOnce(
        () =>
          policyCheckpoint.promise as unknown as ReturnType<
            typeof resolveExecHostApprovalContextMock
          >,
      );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        signal: abortController.signal,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    });
    abortController.abort();
    policyCheckpoint.resolve(policy);
    await setImmediate();

    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("disposes 32 concurrent detached node approval cancellations without rejections", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      const pendingDecision = createDeferred<string | null | undefined>();
      resolveApprovalDecisionOrUndefinedMock.mockReturnValue(pendingDecision.promise);
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "deny",
      });

      const results = await Promise.all(
        Array.from({ length: 32 }, () => executeNodeHostCommand(createNodeHostRequest({}))),
      );

      expect(results.every((result) => result.details?.status === "approval-pending")).toBe(true);
      expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledTimes(32);
      pendingDecision.reject(runAbortedApprovalError);
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
      expect(
        callGatewayToolMock.mock.calls.some(
          ([method, , params]) =>
            method === "node.invoke" &&
            (params as MockNodeInvokeParams | undefined)?.command === "system.run",
        ),
      ).toBe(false);
    } finally {
      unhandledRejections.restore();
    }
  });

  it("forwards prepared systemRunPlan within the native turn after approval", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        toolCallId: "tool-node",
        turnSourceChannel: "telegram",
        turnSourceTo: "telegram:12345",
        turnSourceAccountId: "work",
        turnSourceThreadId: "42",
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(requireRegisteredApprovalRequest()).toMatchObject({
      systemRunPlan: preparedPlan,
      toolCallId: "tool-node",
    });

    await vi.waitFor(() => {
      expect(callGatewayToolMock).toHaveBeenCalledTimes(3);
    });

    const call = requireGatewayCommand("system.run");
    expect(call.options.timeoutMs).toBe(40_000);
    expect(call.params?.timeoutMs).toBe(35_000);
    expect(call.callOptions).toEqual({ scopes: ["operator.write", "operator.approvals"] });
    const runParams = requireRunParams(call);
    expect(runParams.approved).toBe(true);
    expect(runParams.approvalDecision).toBe("allow-once");
    expect(runParams.approvalSource).toBeUndefined();
    expect(runParams.systemRunPlan).toEqual(preparedPlan);
    expect(runParams.timeoutMs).toBe(30_000);
    expect(runParams.turnSourceChannel).toBe("telegram");
    expect(runParams.turnSourceTo).toBe("telegram:12345");
    expect(runParams.turnSourceAccountId).toBe("work");
    expect(runParams.turnSourceThreadId).toBe("42");
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
  });

  it("forwards cancellation without removing detached node approval scopes", async () => {
    const abortController = new AbortController();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        signal: abortController.signal,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(requireGatewayCommand("system.run").callOptions).toEqual({
        scopes: ["operator.write", "operator.approvals"],
        signal: abortController.signal,
      });
    });
  });

  it("silently drops a detached node invocation cancelled during gateway dispatch", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();

    try {
      const abortController = new AbortController();
      const pendingInvocation = createDeferred<{
        payload: { success: boolean; stdout: string; exitCode: number };
      }>();
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "deny",
      });
      callGatewayToolMock.mockImplementation(
        async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
          if (method === "exec.approvals.node.get") {
            return { file: { version: 1, agents: {} } };
          }
          if (method === "node.invoke" && params?.command === "system.run.prepare") {
            return { payload: { plan: preparedPlan } };
          }
          if (method === "node.invoke" && params?.command === "system.run") {
            return pendingInvocation.promise;
          }
          throw new Error(`unexpected gateway method: ${method}`);
        },
      );

      const result = await executeNodeHostCommand(
        createNodeHostRequest({
          signal: abortController.signal,
        }),
      );

      expect(result.details?.status).toBe("approval-pending");
      await vi.waitFor(() => {
        expect(requireGatewayCommand("system.run").callOptions).toEqual({
          scopes: ["operator.write", "operator.approvals"],
          signal: abortController.signal,
        });
      });
      abortController.abort(new Error("run aborted during node invocation"));
      pendingInvocation.reject(abortController.signal.reason);
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("does not dispatch an async human approval after gateway policy revocation", async () => {
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "deny",
      })
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "deny",
        hostAsk: "always",
        askFallback: "deny",
      });

    const result = await executeNodeHostCommand(createNodeHostRequest({}));

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, invoke-failed): bun ./script.ts",
      );
    });
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , callParams]) =>
          method === "node.invoke" &&
          (callParams as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("does not dispatch an auto-reviewed command after gateway policy requires a human", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe command",
    }));
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "allowlist",
        hostAsk: "on-miss",
        askFallback: "deny",
      })
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "allowlist",
        hostAsk: "always",
        askFallback: "deny",
      });

    await expect(
      executeNodeHostCommand(
        createNodeHostRequest({
          security: "allowlist",
          ask: "on-miss",
          autoReview: true,
          autoReviewer,
        }),
      ),
    ).rejects.toThrow("ask=always requires human approval");

    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , callParams]) =>
          method === "node.invoke" &&
          (callParams as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("does not dispatch an auto-reviewed command after gateway policy changes to deny", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe command",
    }));
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "allowlist",
        hostAsk: "on-miss",
        askFallback: "deny",
      })
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "deny",
        hostAsk: "off",
        askFallback: "deny",
      });

    await expect(
      executeNodeHostCommand(
        createNodeHostRequest({
          security: "allowlist",
          ask: "on-miss",
          autoReview: true,
          autoReviewer,
        }),
      ),
    ).rejects.toThrow("security=deny");

    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , callParams]) =>
          method === "node.invoke" &&
          (callParams as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("tags timeout fallback before invoking the node", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "full",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        ask: "always",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(requireRunParams(requireGatewayCommand("system.run")).approvalSource).toBe(
        "ask-fallback",
      );
    });
    const runParams = requireRunParams(requireGatewayCommand("system.run"));
    expect(runParams.approved).toBeUndefined();
    expect(runParams.approvalDecision).toBeUndefined();
  });

  it("promotes a timed-out allowlist fallback and tags its provenance", async () => {
    const entry = { pattern: "/trusted/bin/tool" };
    evaluateShellAllowlistMock.mockReturnValue(
      buildAllowlistEvalResult({ allowlistSatisfied: true, segmentAllowlistEntry: entry }),
    );
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [entry],
      file: { version: 1, agents: {} },
      agent: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "allowlist",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: false,
      deniedReason: null,
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "tool --version",
        security: "allowlist",
        ask: "always",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(requireRunParams(requireGatewayCommand("system.run"))).toEqual(
        expect.objectContaining({
          approvalSource: "ask-fallback",
        }),
      );
    });
    const runParams = requireRunParams(requireGatewayCommand("system.run"));
    expect(runParams.approved).toBeUndefined();
    expect(runParams.approvalDecision).toBeUndefined();
  });

  it("tags headless inline fallback before invoking the node", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "full",
    });
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(true);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        ask: "always",
        trigger: "cron",
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(requireRunParams(requireGatewayCommand("system.run"))).toEqual(
      expect.objectContaining({
        approvalSource: "ask-fallback",
      }),
    );
    const runParams = requireRunParams(requireGatewayCommand("system.run"));
    expect(runParams.approved).toBeUndefined();
    expect(runParams.approvalDecision).toBeUndefined();
  });

  it("denies a headless timeout when the current node-host policy was revoked", async () => {
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "full",
      })
      .mockImplementationOnce(() => {
        throw new Error("exec denied: host=node security=deny");
      });
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(true);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });

    await expect(
      executeNodeHostCommand(
        createNodeHostRequest({
          ask: "always",
          trigger: "cron",
        }),
      ),
    ).rejects.toThrow("denied");

    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , callParams]) =>
          method === "node.invoke" &&
          (callParams as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("denies an async timeout when the current node-host policy was revoked", async () => {
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "always",
        askFallback: "full",
      })
      .mockImplementationOnce(() => {
        throw new Error("exec denied: host=node security=deny");
      });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        ask: "always",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, approval-timeout: policy-unavailable): bun ./script.ts",
      );
    });
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , callParams]) =>
          method === "node.invoke" &&
          (callParams as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("does not dispatch an async timeout after fallback revalidation is revoked", async () => {
    const fallbackPolicy = {
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full" as const,
      hostAsk: "always" as const,
      askFallback: "full" as const,
    };
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce(fallbackPolicy)
      .mockReturnValueOnce(fallbackPolicy)
      .mockImplementationOnce(() => {
        throw new Error("exec denied: host=node security=deny");
      });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        ask: "always",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "approval-1" }),
        "Exec denied (node=node-1 id=approval-1, invoke-failed): bun ./script.ts",
      );
    });
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(3);
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , callParams]) =>
          method === "node.invoke" &&
          (callParams as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("accepts a current exact-command durable grant for allowlist timeout fallback", async () => {
    const commandText = preparedPlan.commandText;
    const exactEntry = {
      pattern: exactCommandMarker(commandText),
      source: "allow-always" as const,
      commandText,
    };
    evaluateShellAllowlistMock.mockReturnValue(buildAllowlistEvalResult());
    hasDurableExecApprovalMock.mockReturnValue(true);
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [exactEntry],
      file: { version: 1, agents: {} },
      agent: {
        security: "allowlist",
        ask: "always",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "allowlist",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: false,
      deniedReason: null,
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: commandText,
        security: "allowlist",
        ask: "always",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(requireRunParams(requireGatewayCommand("system.run"))).toEqual(
        expect.objectContaining({ approvalSource: "ask-fallback" }),
      );
    });
    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(3);
  });

  it("keeps async node approval follow-up output on a UTF-16 boundary", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });
    const prefix = "a".repeat(50);
    const tailHead = "b".repeat(999);
    const stdout = `${prefix}🎉${tailHead}`;
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({ approvals: { version: 1, agents: {} }, stdout }),
    );

    const result = await executeNodeHostCommand(createNodeHostRequest({}));

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalled();
    });
    const message = sendExecApprovalFollowupResultMock.mock.calls[0]?.[1];
    if (typeof message !== "string") {
      throw new Error("expected follow-up message");
    }
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
    expect(message).not.toMatch(loneSurrogate);
    expect(message).not.toContain("�");
    // Under the continuation budget the payload survives whole, so the leading `prefix`
    // is no longer dropped by the old compact tail.
    expect(message).toContain(`Exec finished (node=node-1 id=approval-1, code 0)\n${stdout}`);
    expect(message).toContain(prefix);
    expect(message).toContain(tailHead);
  });

  it("keeps multiline async node approval follow-up output intact", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });
    const stdout = "first line\r\n\tindented\n\nlast line  \t\n";
    const stderr = "warning: something\n";
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({ approvals: { version: 1, agents: {} }, stdout, stderr }),
    );

    const result = await executeNodeHostCommand(createNodeHostRequest({}));

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalled();
    });
    const message = sendExecApprovalFollowupResultMock.mock.calls[0]?.[1];
    if (typeof message !== "string") {
      throw new Error("expected follow-up message");
    }
    expect(message).toContain(`[stdout]\n${stdout}`);
    expect(message).toContain(`[stderr]\n${stderr}`);
    // The compact notify formatter would have collapsed every run of whitespace.
    expect(message).not.toContain("first line indented last line");
  });

  it("does not build a human approval prompt for node auto-review allows", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe read",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    requiresExecApprovalMock.mockImplementation(
      (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
        params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "bun ./script.ts",
        argv: ["bun", "./script.ts"],
        host: "node",
        reason: "allowlist-miss",
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "node",
        requireDeliveryRoute: false,
        suppressDelivery: true,
      }),
    );
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "exec.approval.resolve",
      { timeoutMs: 15_000 },
      { id: expect.any(String), decision: "allow-once" },
      { scopes: ["operator.approvals"], requireAgentRuntimeIdentity: true },
    );
  });

  it("does not invoke the node after cancellation wins during auto-review", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => new Promise(() => {}));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    requiresExecApprovalMock.mockImplementation(
      (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
        params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
    );
    const abortController = new AbortController();
    const result = executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        signal: abortController.signal,
      }),
    );
    await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledTimes(1));
    const gatewayCallsBeforeResolution = callGatewayToolMock.mock.calls.length;

    abortController.abort(new Error("cancelled during review"));

    await expect(result).rejects.toThrow("cancelled during review");
    expect(callGatewayToolMock.mock.calls).toHaveLength(gatewayCallsBeforeResolution);
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "throws synchronously",
      reviewer: () => {
        throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
      },
    },
    {
      name: "rejects asynchronously",
      reviewer: async () => {
        throw new Error("provider\n\u001b[31mfailed\u001b[0m\u202e");
      },
    },
  ])("requests human approval when a node reviewer $name", async ({ reviewer }) => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(reviewer);
    const warnings: string[] = [];
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        warnings,
      }),
    );

    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(result.details?.status).toBe("approval-pending");
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1", host: "node" }),
    );
    expect(callGatewayToolMock.mock.calls).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          "node.invoke",
          expect.anything(),
          expect.objectContaining({ command: "system.run" }),
        ]),
      ]),
    );
    expect(warnings).toEqual([
      "Exec auto-review deferred to human approval (risk=unknown): exec reviewer failed: provider\\nfailed",
    ]);
  });

  it("reviews the prepared node plan before suppressing human approval", async () => {
    const divergentPlan = {
      argv: ["rm", "-rf", "/tmp/work"],
      cwd: "/tmp/work",
      commandText: "rm -rf /tmp/work",
      commandPreview: "./scripts/check_mail.sh --limit 5",
      agentId: "prepared-agent",
      sessionKey: "prepared-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: divergentPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    const nodeAllowlist = [{ pattern: "./scripts/check_mail.sh" }];
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: nodeAllowlist,
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    evaluateShellAllowlistMock.mockImplementation(
      (params?: { command?: string; allowlist?: unknown[] }) => {
        const command = params?.command ?? "";
        const hasNodeAllowlist = Array.isArray(params?.allowlist) && params.allowlist.length > 0;
        const previewMatch = command === "./scripts/check_mail.sh --limit 5";
        return {
          allowlistMatches: previewMatch && hasNodeAllowlist ? [{}] : [],
          analysisOk: true,
          allowlistSatisfied: previewMatch && hasNodeAllowlist,
          segments: [
            previewMatch
              ? {
                  resolution: null,
                  argv: ["./scripts/check_mail.sh", "--limit", "5"],
                  raw: "./scripts/check_mail.sh --limit 5",
                }
              : {
                  resolution: null,
                  argv: ["rm", "-rf", "/tmp/work"],
                  raw: "rm -rf /tmp/work",
                },
          ],
          segmentAllowlistEntries: previewMatch && hasNodeAllowlist ? [{}] : [],
        };
      },
    );
    const autoReviewer = vi.fn<ExecAutoReviewer>(async (input) =>
      input.command.includes("rm -rf")
        ? {
            decision: "ask",
            risk: "high",
            rationale: "destructive prepared plan",
          }
        : {
            decision: "allow-once",
            risk: "low",
            rationale: "safe requested text",
          },
    );
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    requiresExecApprovalMock.mockImplementation(
      (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
        params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "echo SAFE",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "rm -rf /tmp/work",
        argv: ["rm", "-rf", "/tmp/work"],
        agent: {
          id: "prepared-agent",
          sessionKey: "prepared-session",
        },
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalled();
    expect(callGatewayToolMock).not.toHaveBeenCalledWith(
      "exec.approval.resolve",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("honors node allowlist matches on prepared POSIX shell payloads", async () => {
    const wrapperPlan = {
      argv: ["/bin/sh", "-lc", "./scripts/check_mail.sh --limit 5"],
      cwd: "/tmp/work",
      commandText: `/bin/sh -lc "./scripts/check_mail.sh --limit 5"`,
      commandPreview: "./scripts/check_mail.sh --limit 5",
      agentId: "prepared-agent",
      sessionKey: "prepared-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: wrapperPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    const nodeAllowlist = [{ pattern: "./scripts/check_mail.sh" }];
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: nodeAllowlist,
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    evaluateShellAllowlistMock.mockImplementation(
      (params?: { command?: string; allowlist?: unknown[] }) => {
        const command = params?.command ?? "";
        const hasNodeAllowlist = Array.isArray(params?.allowlist) && params.allowlist.length > 0;
        const semanticMatch = command === "./scripts/check_mail.sh --limit 5";
        return {
          allowlistMatches: semanticMatch && hasNodeAllowlist ? [{}] : [],
          analysisOk: true,
          allowlistSatisfied: semanticMatch && hasNodeAllowlist,
          segments: [
            command.startsWith("/bin/sh")
              ? {
                  resolution: null,
                  argv: ["/bin/sh", "-lc", "./scripts/check_mail.sh --limit 5"],
                  raw: `/bin/sh -lc "./scripts/check_mail.sh --limit 5"`,
                }
              : {
                  resolution: null,
                  argv: ["./scripts/check_mail.sh", "--limit", "5"],
                  raw: "./scripts/check_mail.sh --limit 5",
                },
          ],
          segmentAllowlistEntries: semanticMatch && hasNodeAllowlist ? [{}] : [],
        };
      },
    );
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "medium",
      rationale: "should not be needed",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    requiresExecApprovalMock.mockImplementation(
      (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
        params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "./scripts/check_mail.sh --limit 5",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(resolveExecApprovalsFromFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "prepared-agent" }),
    );
    expectSystemRunInvoke({ invokeDeadlineMs: 35_000, invokeWaitMs: 40_000, runTimeoutMs: 30_000 });
  });

  it("does not let transport wrapper allowlist matches approve shell payloads", async () => {
    const wrapperPlan = {
      argv: ["/bin/sh", "-lc", "./scripts/untrusted.sh"],
      cwd: "/tmp/work",
      commandText: `/bin/sh -lc "./scripts/untrusted.sh"`,
      commandPreview: "./scripts/untrusted.sh",
      agentId: "prepared-agent",
      sessionKey: "prepared-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: wrapperPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    const nodeAllowlist = [{ pattern: "/bin/sh" }];
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: nodeAllowlist,
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    evaluateShellAllowlistMock.mockImplementation(
      (params?: { command?: string; allowlist?: unknown[] }) => {
        const command = params?.command ?? "";
        const hasNodeAllowlist = Array.isArray(params?.allowlist) && params.allowlist.length > 0;
        const wrapperMatch = command.startsWith("/bin/sh") && hasNodeAllowlist;
        return {
          allowlistMatches: wrapperMatch ? [{}] : [],
          analysisOk: true,
          allowlistSatisfied: wrapperMatch,
          segments: [
            command.startsWith("/bin/sh")
              ? {
                  resolution: null,
                  argv: ["/bin/sh", "-lc", "./scripts/untrusted.sh"],
                  raw: `/bin/sh -lc "./scripts/untrusted.sh"`,
                }
              : {
                  resolution: null,
                  argv: ["./scripts/untrusted.sh"],
                  raw: "./scripts/untrusted.sh",
                },
          ],
          segmentAllowlistEntries: wrapperMatch ? [{}] : [],
        };
      },
    );
    requiresExecApprovalMock.mockImplementation(
      (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
        params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
    );
    hasDurableExecApprovalMock.mockImplementation(
      (params?: { segmentAllowlistEntries?: unknown[] }) =>
        Array.isArray(params?.segmentAllowlistEntries) && params.segmentAllowlistEntries.length > 0,
    );
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "medium",
      rationale: "inner payload is not allowlisted",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "./scripts/untrusted.sh",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `/bin/sh -lc "./scripts/untrusted.sh"`,
        argv: ["./scripts/untrusted.sh"],
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalled();
  });

  it("reuses exact durable approvals for prepared shell wrappers", async () => {
    const wrapperPlan = {
      argv: ["/bin/sh", "-lc", "cd ."],
      cwd: "/tmp/work",
      commandText: `/bin/sh -lc "cd ."`,
      commandPreview: "cd .",
      agentId: "prepared-agent",
      sessionKey: "prepared-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: wrapperPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [
        {
          pattern: exactCommandMarker(wrapperPlan.commandText),
          source: "allow-always",
          commandText: wrapperPlan.commandText,
        },
      ],
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    evaluateShellAllowlistMock.mockImplementation((params?: { command?: string }) => {
      const command = params?.command ?? "";
      return {
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: false,
        segments: [
          command.startsWith("/bin/sh")
            ? {
                resolution: null,
                argv: ["/bin/sh", "-lc", "cd ."],
                raw: `/bin/sh -lc "cd ."`,
              }
            : {
                resolution: null,
                argv: ["cd", "."],
                raw: "cd .",
              },
        ],
        segmentAllowlistEntries: [],
      };
    });
    hasDurableExecApprovalMock.mockImplementation(
      (params?: { commandText?: string | null }) => params?.commandText === wrapperPlan.commandText,
    );
    requiresExecApprovalMock.mockImplementation(
      (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
        params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
    );
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "cd .",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expectSystemRunInvoke({ invokeDeadlineMs: 35_000, invokeWaitMs: 40_000, runTimeoutMs: 30_000 });
  });

  it.each(["bash", "sh", "/bin/sh"])(
    "keeps non-transport %s login shells outside model auto-review",
    async (shell) => {
      const payload = "./scripts/check_mail.sh --limit 5";
      const loginCommand = `${shell} -lc "${payload}"`;
      const loginPlan = {
        argv: ["/bin/sh", "-lc", loginCommand],
        cwd: "/tmp/work",
        commandText: `/bin/sh -lc "${loginCommand.replaceAll('"', '\\"')}"`,
        commandPreview: loginCommand,
        agentId: "prepared-agent",
        sessionKey: "prepared-session",
      };
      parsePreparedSystemRunPayloadMock.mockReturnValue({
        plan: loginPlan,
        execPolicy: { security: "full", ask: "off" },
      });
      resolveExecApprovalsFromFileMock.mockReturnValue({
        allowlist: [],
        file: { version: 1, agents: {} },
        agent: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
      });
      evaluateShellAllowlistMock.mockImplementation((params?: { command?: string }) => {
        const command = params?.command ?? "";
        return {
          allowlistMatches: [],
          analysisOk: true,
          allowlistSatisfied: false,
          segments: [
            command === loginPlan.commandText
              ? {
                  resolution: null,
                  argv: ["/bin/sh", "-lc", loginCommand],
                  raw: loginPlan.commandText,
                }
              : command === loginCommand
                ? {
                    resolution: null,
                    argv: [shell, "-lc", payload],
                    raw: loginCommand,
                  }
                : {
                    resolution: null,
                    argv: ["./scripts/check_mail.sh", "--limit", "5"],
                    raw: payload,
                  },
          ],
          segmentAllowlistEntries: [],
        };
      });
      requiresExecApprovalMock.mockImplementation(
        (params?: { allowlistSatisfied?: boolean; durableApprovalSatisfied?: boolean }) =>
          params?.allowlistSatisfied !== true && params?.durableApprovalSatisfied !== true,
      );
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "unsafe startup wrapper must not reach the reviewer",
      }));
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "allowlist",
        hostAsk: "on-miss",
        askFallback: "deny",
      });

      const result = await executeNodeHostCommand(
        createNodeHostRequest({
          command: loginCommand,
          security: "allowlist",
          ask: "on-miss",
          autoReview: true,
          autoReviewer,
        }),
      );

      expect(result.details?.status).toBe("approval-pending");
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalled();
    },
  );

  it("requires human approval when prepared shell payload has multiple commands", async () => {
    const chainPlan = {
      argv: ["/bin/sh", "-lc", "openclaw status; id"],
      cwd: "/tmp/work",
      commandText: `/bin/sh -lc "openclaw status; id"`,
      commandPreview: "openclaw status; id",
      agentId: "prepared-agent",
      sessionKey: "prepared-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: chainPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    evaluateShellAllowlistMock.mockImplementation((params?: { command?: string }) => {
      const command = params?.command ?? "";
      return {
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: false,
        segments: command.startsWith("/bin/sh")
          ? [
              {
                resolution: null,
                argv: ["/bin/sh", "-lc", "openclaw status; id"],
                raw: `/bin/sh -lc "openclaw status; id"`,
              },
            ]
          : [
              {
                resolution: null,
                argv: ["openclaw", "status"],
                raw: "openclaw status",
              },
              {
                resolution: null,
                argv: ["id"],
                raw: "id",
              },
            ],
        segmentAllowlistEntries: [],
      };
    });
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "openclaw status; id",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalled();
  });

  it("does not treat read-only suppression inspections as wrapper writes", async () => {
    const wrapperPlan = {
      argv: ["/bin/sh", "-lc", "openclaw config get security.audit.suppressions"],
      cwd: "/tmp/work",
      commandText: `/bin/sh -lc "openclaw config get security.audit.suppressions"`,
      commandPreview: "openclaw config get security.audit.suppressions",
      agentId: "prepared-agent",
      sessionKey: "prepared-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: wrapperPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    evaluateShellAllowlistMock.mockImplementation((params?: { command?: string }) => {
      const command = params?.command ?? "";
      return {
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: true,
        segments: [
          command.startsWith("/bin/sh")
            ? {
                resolution: null,
                argv: ["/bin/sh", "-lc", "openclaw config get security.audit.suppressions"],
                raw: `/bin/sh -lc "openclaw config get security.audit.suppressions"`,
              }
            : {
                resolution: null,
                argv: ["openclaw", "config", "get", "security.audit.suppressions"],
                raw: "openclaw config get security.audit.suppressions",
              },
        ],
        segmentAllowlistEntries: [],
      };
    });
    commandRequiresSecurityAuditSuppressionApprovalMock.mockImplementation(
      (params?: { command?: string }) => params?.command?.startsWith("/bin/sh") === true,
    );
    requiresExecApprovalMock.mockReturnValue(false);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "openclaw config get security.audit.suppressions",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expectSystemRunInvoke({ invokeDeadlineMs: 35_000, invokeWaitMs: 40_000, runTimeoutMs: 30_000 });
  });

  it("requests human approval when node auto-review asks on an approval miss", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "ask",
      risk: "medium",
      rationale: "needs a person",
    }));
    const warnings: string[] = [];
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        warnings,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(warnings.join("\n")).toContain("needs a person");
  });

  it.each([
    {
      name: "ask always",
      nodeSecurity: "full",
      nodeAsk: "always",
    },
    {
      name: "deny security",
      nodeSecurity: "deny",
      nodeAsk: "off",
    },
  ] as const)("preserves node policy with a $name floor", async ({ nodeSecurity, nodeAsk }) => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: { security: nodeSecurity, ask: nodeAsk },
    });
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [],
      file: { version: 1, agents: {} },
      agent: {
        security: nodeSecurity,
        ask: nodeAsk,
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({
        approvals: { version: 1, agents: {} },
        allowApprovalResolve: true,
        execPolicy: { security: nodeSecurity, ask: nodeAsk },
      }),
    );

    const execution = executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    if (nodeSecurity === "deny") {
      await expect(execution).rejects.toThrow("security=deny");
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
      return;
    }
    const result = await execution;
    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(
      callGatewayToolMock.mock.calls.some(([method]) => method === "exec.approval.resolve"),
    ).toBe(false);
  });

  it("requests human approval when node approval policy is unavailable", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({
        approvals: new Error("node approvals unavailable"),
        allowApprovalResolve: true,
      }),
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(
      callGatewayToolMock.mock.calls.some(([method]) => method === "exec.approval.resolve"),
    ).toBe(false);
  });

  it("does not use fallback-full when node approval policy is unavailable", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "full",
    });
    callGatewayToolMock.mockImplementation(
      createNodeGatewayHandler({
        approvals: new Error("node approvals unavailable"),
        stdout: "should-not-run",
      }),
    );
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "approval-1",
          sessionKey: "requested-session",
        }),
        "Exec denied (node=node-1 id=approval-1, approval-timeout): bun ./script.ts",
      );
    });
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("auto-reviews strict inline-eval commands before asking a human", async () => {
    const inlinePlan = {
      argv: ["/bin/sh", "-lc", "python3 -c 'print(1)'"],
      cwd: "/tmp/work",
      commandText: `/bin/sh -lc "python3 -c 'print(1)'"`,
      commandPreview: "python3 -c 'print(1)'",
      agentId: "requested-agent",
      sessionKey: "requested-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: inlinePlan,
      execPolicy: { security: "full", ask: "off" },
    });
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe inline eval",
    }));
    detectInterpreterInlineEvalArgvMock.mockImplementation((argv?: unknown) =>
      Array.isArray(argv) && argv[0] === "python3" ? INLINE_EVAL_HIT : null,
    );
    evaluateShellAllowlistMock.mockImplementation((params?: { command?: string }) => {
      const command = params?.command ?? "";
      const segment = command.startsWith("/bin/sh")
        ? {
            resolution: null,
            argv: ["/bin/sh", "-lc", "python3 -c 'print(1)'"],
            raw: `/bin/sh -lc "python3 -c 'print(1)'"`,
          }
        : {
            resolution: null,
            argv: ["python3", "-c", "print(1)"],
            raw: "python3 -c 'print(1)'",
          };
      return {
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: false,
        segments: [segment],
        segmentAllowlistEntries: [],
      };
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    const warnings: string[] = [];

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "python3 -c 'print(1)'",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        strictInlineEval: true,
        warnings,
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `/bin/sh -lc "python3 -c 'print(1)'"`,
        argv: ["python3", "-c", "print(1)"],
        host: "node",
        reason: "strict-inline-eval",
        analysis: expect.objectContaining({
          inlineEval: true,
        }),
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(warnings[0]).toContain("requires reviewer or explicit approval");
  });

  it("keeps security audit suppression edits off the auto-review path", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    const warnings: string[] = [];
    commandRequiresSecurityAuditSuppressionApprovalMock.mockReturnValue(true);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "openclaw config set security.audit.suppressions '[]'",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        warnings,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(warnings).toContain(
      "Warning: security audit suppression changes require explicit approval unless exec is running in yolo mode.",
    );
  });

  it("requests human approval when node auto-review cannot bind a single parsed command", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { raw: "echo ok", resolution: null, argv: ["echo", "ok"] },
        { raw: "pwd", resolution: null, argv: ["pwd"] },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "echo ok; pwd",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
  });

  it("requests human approval when node runtime policy requires ask always", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: { security: "full", ask: "always" },
    });
    resolveExecApprovalsFromFileMock.mockReturnValue({
      allowlist: [],
      file: { version: 1, agents: {} },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "always",
      allowAlwaysPersistence: {
        kind: "patterns",
        patterns: [{ pattern: "/trusted/bin/tool" }],
      },
    });
    expect(requireRegisteredApprovalRequest().unavailableDecisions).toEqual(["allow-always"]);
    expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "deny"],
      }),
    );
  });

  it("omits allow-always from node approval prompts when node runtime policy is missing", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: preparedPlan,
      execPolicy: undefined,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "always",
      allowAlwaysPersistence: {
        kind: "patterns",
        patterns: [{ pattern: "/trusted/bin/tool" }],
      },
    });
    expect(requireRegisteredApprovalRequest().unavailableDecisions).toEqual(["allow-always"]);
  });

  it("offers allow-always for prepared node commands with complete node coverage", async () => {
    const preparedWrapperPlan = {
      ...preparedPlan,
      argv: ["/bin/sh", "-lc", "git status"],
      commandText: '/bin/sh -lc "git status"',
      commandPreview: "git status",
    };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    parsePreparedSystemRunPayloadMock.mockReturnValueOnce({
      plan: preparedWrapperPlan,
      execPolicy: { security: "full", ask: "off" },
      allowAlwaysCoverage: {
        complete: true,
        patterns: [{ pattern: "/node/bin/git" }],
      },
    });
    resolveAllowAlwaysPersistenceDecisionMock.mockImplementationOnce((params) => {
      const commandText = params.commandText?.trim();
      return params.preparedCoverage?.complete === true && params.preparedCoverage.patterns.length
        ? {
            kind: "patterns",
            ...(commandText ? { commandText } : {}),
            patterns: params.preparedCoverage.patterns,
          }
        : {
            kind: "one-shot",
            reasons: ["no-reusable-pattern"],
          };
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "git status",
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(resolveAllowAlwaysPersistenceDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: '/bin/sh -lc "git status"',
        preparedCoverage: {
          complete: true,
          patterns: [{ pattern: "/node/bin/git" }],
        },
      }),
    );
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "on-miss",
      allowAlwaysPersistence: {
        kind: "patterns",
        commandText: '/bin/sh -lc "git status"',
        patterns: [{ pattern: "/node/bin/git" }],
      },
    });
    expect(requireRegisteredApprovalRequest().unavailableDecisions).toBeUndefined();
  });

  it("does not use fallback-full when node auto-review cannot parse the command", async () => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "test reviewer would allow it",
    }));
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "full",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "echo 'unterminated",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(autoReviewer).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "approval-1",
          sessionKey: "requested-session",
        }),
        "Exec denied (node=node-1 id=approval-1, approval-timeout): echo 'unterminated",
      );
    });
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "asks for human approval",
      decision: { decision: "ask", risk: "medium", rationale: "needs a person" },
    },
    {
      name: "returns a non-low allow decision",
      decision: { decision: "allow-once", risk: "high", rationale: "risk too high" },
    },
  ] as const)("does not use fallback-full when node auto-review $name", async ({ decision }) => {
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => {
      // Exercise the runtime boundary against a contradictory custom reviewer response.
      return decision as unknown as ExecAutoReviewDecision;
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "full",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const warnings: string[] = [];
    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        warnings,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(warnings.join("\n")).toContain(decision.rationale);
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "approval-1",
          sessionKey: "requested-session",
        }),
        "Exec denied (node=node-1 id=approval-1, approval-timeout): bun ./script.ts",
      );
    });
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , params]) =>
          method === "node.invoke" &&
          (params as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("rejects approval when the node omits prepare", async () => {
    listNodesMock.mockResolvedValueOnce([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.which", "system.notify"],
        connected: true,
        platform: "darwin",
      },
    ]);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "deny",
    });

    await expect(executeNodeHostCommand(createNodeHostRequest({}))).rejects.toThrow(
      "node approval requires system.run.prepare support",
    );
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
  });

  it("requires approval when node allowlist matching would depend on gateway PATH", async () => {
    const allowlistEntry = { pattern: "/trusted/bin/tool" };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [allowlistEntry],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockImplementation((raw: unknown) => {
      const params = raw as ShellAllowlistMockParams;
      const hasNodeAllowlist = (params.allowlist ?? []).length > 0;
      const gatewayPathWouldMatch = params.env?.PATH?.includes("/trusted/bin") === true;
      return buildAllowlistEvalResult({
        allowlistSatisfied: hasNodeAllowlist && gatewayPathWouldMatch,
        segmentAllowlistEntry: allowlistEntry,
      });
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "tool --version",
        env: { PATH: "/trusted/bin:/usr/bin" },
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
    expect(requireRegisteredApprovalRequest().env).toBeUndefined();
    const evalEnvs = evaluateShellAllowlistMock.mock.calls.map(
      ([raw]) => (raw as ShellAllowlistMockParams).env,
    );
    expect(evalEnvs.length).toBeGreaterThanOrEqual(2);
    expect(evalEnvs.every((env) => env?.PATH === "" && env?.Path === "")).toBe(true);
    await vi.waitFor(() => {
      expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledTimes(1);
    });
  });

  it("reuses exact node allow-always command entries for prechecks", async () => {
    const allowlistEntry = {
      pattern: "/trusted/bin/tool",
      source: "allow-always" as const,
    };
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [commandMarker, allowlistEntry],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockImplementation((raw: unknown) => {
      const params = raw as ShellAllowlistMockParams;
      expect(params.env?.PATH).toBe("");
      expect(params.env?.Path).toBe("");
      return {
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: false,
        segments: [{ resolution: null, argv: ["/trusted/bin/tool", "--version"] }],
        segmentAllowlistEntries: [null],
      };
    });
    resolveAllowAlwaysPatternCoverageMock.mockImplementation((raw: unknown) => {
      const params = raw as { segments?: MockAllowlistSegment[]; env?: NodeJS.ProcessEnv };
      expect(params.env?.PATH).toBe("");
      expect(params.env?.Path).toBe("");
      expect(params.segments?.[0]?.argv[0]).toBe("/trusted/bin/tool");
      return {
        complete: true,
        patterns: [{ pattern: "/trusted/bin/tool" }],
      };
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "/trusted/bin/tool --version",
        env: { PATH: "/gateway/bin:/usr/bin" },
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        analysisOk: true,
        allowlistSatisfied: false,
        durableApprovalSatisfied: true,
      }),
    );
    expect(requireRunParams(requireGatewayCommand("system.run")).env).toBeUndefined();
  });

  it("omits allow-always from node approval prompts when persistence is one-shot", async () => {
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveAllowAlwaysPersistenceDecisionMock.mockReturnValue({
      kind: "one-shot",
      reasons: ["unplanned"],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(resolveAllowAlwaysPersistenceDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandText: "bun ./script.ts",
        platform: process.platform,
        runtimePayload: false,
      }),
    );
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "on-miss",
      allowAlwaysPersistence: { kind: "one-shot", reasons: ["unplanned"] },
    });
    expect(requireRegisteredApprovalRequest().unavailableDecisions).toEqual(["allow-always"]);
    expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "deny"],
      }),
    );
  });

  it("reuses de-duplicated node allow-always metadata for repeated command segments", async () => {
    const allowlistEntry = {
      pattern: "/trusted/bin/tool",
      source: "allow-always" as const,
    };
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [commandMarker, allowlistEntry],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["/trusted/bin/tool", "a"] },
        { resolution: null, argv: ["/trusted/bin/tool", "b"] },
      ],
      segmentAllowlistEntries: [null, null],
    });
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({
      complete: true,
      patterns: [{ pattern: "/trusted/bin/tool" }],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "/trusted/bin/tool a && /trusted/bin/tool b",
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowlistSatisfied: false,
        durableApprovalSatisfied: true,
      }),
    );
  });

  it("does not reuse partial node allow-always metadata for compound commands", async () => {
    const allowlistEntry = {
      pattern: "/trusted/bin/foo",
      source: "allow-always" as const,
    };
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [commandMarker, allowlistEntry],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["foo"] },
        { resolution: null, argv: ["bar"] },
      ],
      segmentAllowlistEntries: [null, null],
    });
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({
      complete: true,
      patterns: [{ pattern: "/trusted/bin/foo" }, { pattern: "/trusted/bin/bar" }],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "foo && bar",
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowlistSatisfied: false,
        durableApprovalSatisfied: false,
      }),
    );
  });

  it("does not reuse a node command marker when concrete allow-always coverage is empty", async () => {
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [commandMarker],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["tool", "--version"] }],
      segmentAllowlistEntries: [null],
    });
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({
      complete: false,
      patterns: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "tool --version",
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowlistSatisfied: false,
        durableApprovalSatisfied: false,
      }),
    );
  });

  it("reuses current node-reported coverage when gateway analysis cannot resolve node paths", async () => {
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    const allowlistEntry = {
      pattern: "/node/bin/tool",
      source: "allow-always" as const,
    };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    parsePreparedSystemRunPayloadMock.mockReturnValueOnce({
      plan: preparedPlan,
      execPolicy: { security: "full", ask: "off" },
      allowAlwaysCoverage: {
        complete: true,
        patterns: [{ pattern: "/node/bin/tool" }],
      },
    });
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [commandMarker, allowlistEntry],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["tool", "--version"] }],
      segmentAllowlistEntries: [null],
    });
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({
      complete: false,
      patterns: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "tool --version",
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowlistSatisfied: false,
        durableApprovalSatisfied: true,
      }),
    );
  });

  it("does not reuse last-used node metadata without an exact command marker", async () => {
    const allowlistEntries = [
      {
        pattern: "/trusted/bin/foo",
        argPattern: "^a\x00$",
        source: "allow-always" as const,
        lastUsedCommand: preparedPlan.commandText,
      },
      {
        pattern: "/trusted/bin/foo",
        argPattern: "^b\x00$",
        source: "allow-always" as const,
        lastUsedCommand: preparedPlan.commandText,
      },
    ];
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: allowlistEntries,
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["foo", "a"] },
        { resolution: null, argv: ["foo", "b"] },
        { resolution: null, argv: ["missingcmd"] },
      ],
      segmentAllowlistEntries: [null, null, null],
    });
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({ complete: false, patterns: [] });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "foo a && foo b && missingcmd",
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowlistSatisfied: false,
        durableApprovalSatisfied: false,
      }),
    );
  });

  it("does not reuse node allow-always metadata when only representable segments match", async () => {
    const allowlistEntries = [
      {
        pattern: "/bin/echo",
        source: "allow-always" as const,
      },
      {
        pattern: "/bin/date",
        source: "allow-always" as const,
      },
    ];
    const commandMarker = { pattern: nodeCommandMarker, source: "allow-always" as const };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [commandMarker, ...allowlistEntries],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["sh", "-c", "/bin/echo ok && /bin/date"] },
        { resolution: null, argv: ["missingcmd"] },
      ],
      segmentAllowlistEntries: [null, null],
    });
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({
      complete: false,
      patterns: [{ pattern: "/bin/echo" }, { pattern: "/bin/date" }],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: 'sh -c "/bin/echo ok && /bin/date" && missingcmd',
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowlistSatisfied: false,
        durableApprovalSatisfied: false,
      }),
    );
  });

  it("does not use unresolved node allow-always fallback for shell wrappers", async () => {
    const allowlistEntry = {
      pattern: "/trusted/bin/foo",
      source: "allow-always" as const,
    };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [allowlistEntry],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["bash", "-lc", "foo && missingcmd"] }],
      segmentAllowlistEntries: [null],
    });
    resolveAllowAlwaysPatternCoverageMock.mockReturnValue({ complete: false, patterns: [] });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: 'bash -lc "foo && missingcmd"',
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    expect(registerExecApprovalRequestForHostOrThrowMock).toHaveBeenCalledTimes(1);
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowlistSatisfied: false,
        durableApprovalSatisfied: false,
      }),
    );
  });

  it("uses forwarded node env overrides for node approval prechecks", async () => {
    const allowlistEntry = { pattern: "/trusted/bin/tool" };
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    usePolicyApprovalRequirementMock();
    resolveExecApprovalsFromFileMock.mockReturnValue({
      agent: { security: "allowlist", ask: "on-miss" },
      allowlist: [allowlistEntry],
      file: { version: 1, agents: {} },
    });
    evaluateShellAllowlistMock.mockImplementation((raw: unknown) => {
      const params = raw as ShellAllowlistMockParams;
      const hasNodeAllowlist = (params.allowlist ?? []).length > 0;
      return buildAllowlistEvalResult({
        allowlistSatisfied:
          hasNodeAllowlist &&
          params.env != null &&
          params.env.FOO === "bar" &&
          params.env.PATH === "",
        segmentAllowlistEntry: allowlistEntry,
      });
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "tool --version",
        env: { PATH: "/gateway/bin:/usr/bin" },
        requestedEnv: { FOO: "bar" },
        security: "allowlist",
        ask: "on-miss",
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(registerExecApprovalRequestForHostOrThrowMock).not.toHaveBeenCalled();
    expect(requiresExecApprovalMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        analysisOk: true,
        allowlistSatisfied: true,
        durableApprovalSatisfied: false,
      }),
    );
    expect(requireGatewayCommand("system.run.prepare").params?.params?.env).toEqual({
      FOO: "bar",
    });
    expect(requireGatewayCommand("system.run.prepare").params?.params?.cwd).toBe("/tmp/work");
    const runParams = requireRunParams(requireGatewayCommand("system.run"));
    expect(runParams.env).toEqual({ FOO: "bar" });
    expect(runParams.cwd).toBe("/tmp/work");
    const evalEnvs = evaluateShellAllowlistMock.mock.calls.map(
      ([raw]) => (raw as ShellAllowlistMockParams).env,
    );
    expect(evalEnvs.length).toBeGreaterThanOrEqual(2);
    expect(evalEnvs.every((env) => env != null && env.FOO === "bar" && env.PATH === "")).toBe(true);
  });

  it("prepares target policy even in full/off mode", async () => {
    await executeNodeHostCommand(
      createNodeHostRequest({
        notifyOnExit: false,
      }),
    );

    expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    const call = requireGatewayCommand("system.run");
    expect(call.options.timeoutMs).toBe(40_000);
    expect(call.params?.timeoutMs).toBe(35_000);
    const runParams = requireRunParams(call);
    expect(runParams.command).toEqual(preparedPlan.argv);
    expect(runParams.rawCommand).toBe("bun ./script.ts");
    expect(runParams.cwd).toBe("/tmp/work");
    expect(typeof runParams.runId).toBe("string");
    expect(runParams.suppressNotifyOnExit).toBe(true);
    expect(runParams.timeoutMs).toBe(30_000);
    expect(runParams.systemRunPlan).toEqual(preparedPlan);
  });

  it("bypasses host approval floors for an explicit full session", async () => {
    await executeNodeHostCommand(createNodeHostRequest({ bypassHostApprovalFloors: true }));

    expect(resolveExecHostApprovalContextMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
    expect(requireRunParams(requireGatewayCommand("system.run")).systemRunPlan).toEqual(
      preparedPlan,
    );
  });

  it("does not dispatch a direct full/off command after gateway policy revocation", async () => {
    resolveExecHostApprovalContextMock
      .mockReturnValueOnce({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "off",
        askFallback: "deny",
      })
      .mockImplementationOnce(() => {
        throw new Error("exec denied: host=node security=deny");
      });

    await expect(executeNodeHostCommand(createNodeHostRequest({}))).rejects.toThrow(
      "security=deny",
    );

    expect(resolveExecHostApprovalContextMock).toHaveBeenCalledTimes(2);
    expect(
      callGatewayToolMock.mock.calls.some(
        ([method, , callParams]) =>
          method === "node.invoke" &&
          (callParams as MockNodeInvokeParams | undefined)?.command === "system.run",
      ),
    ).toBe(false);
  });

  it("uses the prepared cwd when no workdir was requested", async () => {
    await executeNodeHostCommand(
      createNodeHostRequest({
        workdir: undefined,
      }),
    );

    const runParams = requireRunParams(requireGatewayCommand("system.run"));
    expect(runParams.cwd).toBe(preparedPlan.cwd);
  });

  it("rejects disconnected node targets before invoking system.run", async () => {
    listNodesMock.mockResolvedValueOnce([
      {
        nodeId: "node-1",
        commands: ["system.run", "system.run.prepare"],
        connected: false,
        platform: process.platform,
      },
    ]);

    await expect(
      executeNodeHostCommand(
        createNodeHostRequest({
          command: "git log --oneline -5",
          security: "allowlist",
          requestedNode: "node-1",
        }),
      ),
    ).rejects.toThrow(
      "exec host=node requires a connected node that supports system.run (node-1 is not eligible; eligible node ids: none)",
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });

  it("returns a non-empty placeholder for silent node exec results", async () => {
    callGatewayToolMock.mockImplementation(
      async (method: string, _options: unknown, params: MockNodeInvokeParams | undefined) => {
        if (method === "node.invoke" && params?.command === "system.run") {
          return {
            payload: {
              success: true,
              stdout: "",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
          };
        }
        return createNodeGatewayHandler({ approvals: { version: 1, agents: {} } })(
          method,
          _options,
          params,
        );
      },
    );

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "mkdir /tmp/quiet",
      }),
    );

    expect(result.content).toEqual([{ type: "text", text: "Node: node-1\n(no output)" }]);
    const details = result.details;
    expect(details?.status).toBe("completed");
    if (details?.status !== "completed") {
      throw new Error(`expected completed details, got ${details?.status ?? "missing"}`);
    }
    expect(details.exitCode).toBe(0);
    expect(details.aggregated).toBe("");
    expect(details.cwd).toBe("/tmp/work");
  });

  it("forwards explicit timeouts to node system.run", async () => {
    await executeNodeHostCommand(
      createNodeHostRequest({
        timeoutSec: 12,
      }),
    );

    expectSystemRunInvoke({ invokeDeadlineMs: 17_000, invokeWaitMs: 22_000, runTimeoutMs: 12_000 });
  });

  it("normalizes unsafe explicit timeouts before invoking node system.run", async () => {
    await executeNodeHostCommand(
      createNodeHostRequest({
        timeoutSec: Number.POSITIVE_INFINITY,
      }),
    );

    expectSystemRunInvoke({ invokeDeadlineMs: 35_000, invokeWaitMs: 40_000, runTimeoutMs: 30_000 });

    callGatewayToolMock.mockClear();

    await executeNodeHostCommand(
      createNodeHostRequest({
        timeoutSec: 3_000_000,
      }),
    );

    expectSystemRunInvoke({
      invokeDeadlineMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      invokeWaitMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      runTimeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS,
    });

    callGatewayToolMock.mockClear();

    await executeNodeHostCommand(
      createNodeHostRequest({
        timeoutSec: Number.MAX_VALUE,
      }),
    );

    expectSystemRunInvoke({
      invokeDeadlineMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      invokeWaitMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      runTimeoutMs: MAX_SAFE_TIMEOUT_DELAY_MS,
    });
  });

  it("forwards timeout zero to node system.run and keeps the invoke wait bounded", async () => {
    await executeNodeHostCommand(
      createNodeHostRequest({
        timeoutSec: 0,
      }),
    );

    expectSystemRunInvoke({ invokeDeadlineMs: 35_000, invokeWaitMs: 40_000, runTimeoutMs: 0 });
    const call = requireGatewayCommand("system.run");
    // Zero means "no program-runtime timer" on the node and must never be
    // rewritten into a finite process timeout, but the Gateway deadline and the
    // caller wait still have to stay positive and finite.
    expect(requireRunParams(call).timeoutMs).toBe(0);
    expect(call.params?.timeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(call.params?.timeoutMs)).toBe(true);
  });

  it("arms the gateway invocation deadline for a budget longer than the 30s registry fallback", async () => {
    await executeNodeHostCommand(
      createNodeHostRequest({
        timeoutSec: 120,
      }),
    );

    // A 120s program budget must not be cut short by the registry's fixed 30s
    // pending-invoke fallback in resolveTimerTimeoutMs(params.timeoutMs, 30_000, 0).
    expectSystemRunInvoke({
      invokeDeadlineMs: 125_000,
      invokeWaitMs: 130_000,
      runTimeoutMs: 120_000,
    });
  });

  it("leaves system.run.prepare without a gateway invocation deadline", async () => {
    mockGatewayInvokesWithNodeApprovals({ version: 1, agents: {} });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    await executeNodeHostCommand(
      createNodeHostRequest({
        security: "allowlist",
        ask: "on-miss",
        timeoutSec: 120,
      }),
    ).catch(() => undefined);

    // The short prepare round-trip keeps the registry default; only the actual
    // system.run dispatch carries the command budget.
    const prepare = requireGatewayCommand("system.run.prepare");
    expect(prepare.params?.timeoutMs).toBeUndefined();
    expect(prepare.options.timeoutMs).toBe(15_000);
  });

  it("allows exec when requestedNode is display name matching boundNode's device", async () => {
    listNodesMock.mockResolvedValue([
      {
        nodeId: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        displayName: "home-wsl-debian",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
    ]);
    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "echo hello",
        agentId: "test-agent",
        sessionKey: "test-session",
        boundNode: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        requestedNode: "home-wsl-debian",
      }),
    );
    expect(result.details?.status).toBeDefined();
  });

  it("allows exec when requestedNode is partial ID matching boundNode's device", async () => {
    listNodesMock.mockResolvedValue([
      {
        nodeId: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        displayName: "home-wsl-debian",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
    ]);
    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "echo hello",
        agentId: "test-agent",
        sessionKey: "test-session",
        boundNode: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        requestedNode: "f2396b588d391d",
      }),
    );
    expect(result.details?.status).toBeDefined();
  });

  it("rejects exec when requestedNode resolves to a different node than boundNode", async () => {
    listNodesMock.mockResolvedValue([
      {
        nodeId: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        displayName: "home-wsl-debian",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
      {
        nodeId: "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaa7777bbb88889999",
        displayName: "other-node",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
    ]);
    await expect(
      executeNodeHostCommand(
        createNodeHostRequest({
          command: "echo hello",
          agentId: "test-agent",
          sessionKey: "test-session",
          boundNode: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
          requestedNode: "other-node",
        }),
      ),
    ).rejects.toThrow("exec node not allowed (bound to f2396b588d391d30");
  });

  it("preserves original error when requestedNode matches no known node", async () => {
    listNodesMock.mockResolvedValue([
      {
        nodeId: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        displayName: "home-wsl-debian",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
    ]);
    await expect(
      executeNodeHostCommand(
        createNodeHostRequest({
          command: "echo hello",
          agentId: "test-agent",
          sessionKey: "test-session",
          requestedNode: "nonexistent-node",
        }),
      ),
    ).rejects.toThrow(
      "requested node not found: nonexistent-node (unknown node: nonexistent-node)",
    );
  });

  it("allows exec when boundNode is a display name matching the same device as requestedNode", async () => {
    listNodesMock.mockResolvedValue([
      {
        nodeId: "f2396b588d391d30a79d300e196a17cf197f34969b5e2485d2734c953567f44e",
        displayName: "home-wsl-debian",
        commands: ["system.run", "system.run.prepare"],
        connected: true,
        platform: process.platform,
      },
    ]);
    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "echo hello",
        agentId: "test-agent",
        sessionKey: "test-session",
        boundNode: "home-wsl-debian",
        requestedNode: "home-wsl-debian",
      }),
    );
    expect(result.details?.status).toBeDefined();
  });

  it("auto-reviews strict inline-eval commands with full/off host policy when node policy is available", async () => {
    const inlinePlan = {
      argv: ["python3", "-c", "print(1)"],
      cwd: "/tmp/work",
      commandText: "python3 -c 'print(1)'",
      commandPreview: null,
      agentId: "requested-agent",
      sessionKey: "requested-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: inlinePlan,
      execPolicy: { security: "full", ask: "off" },
    });
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe inline eval",
    }));
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    evaluateShellAllowlistMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        {
          resolution: null,
          argv: ["python3", "-c", "print(1)"],
          raw: "python3 -c 'print(1)'",
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "python3 -c 'print(1)'",
        autoReview: true,
        autoReviewer,
        strictInlineEval: true,
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "python3 -c 'print(1)'",
        argv: ["python3", "-c", "print(1)"],
        host: "node",
        reason: "strict-inline-eval",
      }),
    );
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "exec.approvals.node.get",
      { timeoutMs: 10_000 },
      { nodeId: "node-1" },
    );
  });

  it("denies timed-out inline-eval requests instead of invoking the node", async () => {
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "full",
    });

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "python3 -c 'print(1)'",
        strictInlineEval: true,
      }),
    );

    expect(result.details?.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "approval-1",
          sessionKey: "requested-session",
        }),
        "Exec denied (node=node-1 id=approval-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
