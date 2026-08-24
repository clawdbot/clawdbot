/**
 * Gateway-host exec approval tests.
 * Covers allowlist misses, auto-review, strict inline eval, diagnostics
 * follow-ups, and gateway approval result routing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../infra/diagnostic-events.js";
import type {
  ExecAllowlistEntry,
  ExecApprovalDecision,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecAsk,
  ExecCommandSegment,
  ExecSecurity,
  ExecSegmentSatisfiedBy,
} from "../infra/exec-approvals.js";
import {
  planShellAuthorization,
  type ExecAuthorizationPlan,
} from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import {
  buildHashedArgPatternFromArgv,
  resolvePolicyTargetCandidatePath,
} from "../infra/exec-command-resolution.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import type {
  ExecApprovalFollowupFactory,
  ExecApprovalFollowupOutcome,
} from "./bash-tools.exec-types.js";

type SendExecApprovalFollowupResult =
  typeof import("./bash-tools.exec-host-shared.js").sendExecApprovalFollowupResult;
type BuildExecApprovalFollowupTarget =
  typeof import("./bash-tools.exec-host-shared.js").buildExecApprovalFollowupTarget;
type ExecApprovalFollowupTarget = Parameters<BuildExecApprovalFollowupTarget>[0];
type ExecAutoReviewer = typeof import("../infra/exec-auto-review.js").defaultExecAutoReviewer;
type BuildExecApprovalFollowupTargetMock = (
  value: ExecApprovalFollowupTarget,
) => ExecApprovalFollowupTarget | null;
type MockAllowlistSegment = Omit<ExecCommandSegment, "raw"> & { raw?: string };
type MockAllowlistResult = {
  allowlistMatches: unknown[];
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  segments: MockAllowlistSegment[];
  segmentAllowlistEntries: unknown[];
  segmentSatisfiedBy?: ExecSegmentSatisfiedBy[];
  authorizationPlan?: ExecAuthorizationPlan;
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

type MockExecHostApprovalContext = {
  approvals: {
    allowlist: ExecAllowlistEntry[];
    file: ExecApprovalsFile;
    agent?: Required<ExecApprovalsDefaults>;
  };
  hostSecurity: ExecSecurity;
  hostAsk: ExecAsk;
  askFallback?: ExecSecurity;
};

const INLINE_EVAL_HIT = {
  executable: "python3",
  normalizedExecutable: "python3",
  flag: "-c",
  argv: ["python3", "-c", "print(1)"],
};

function exactCommandMarker(command: string): string {
  return `=command:${crypto.createHash("sha256").update(command.trim()).digest("hex").slice(0, 16)}`;
}

const createAndRegisterDefaultExecApprovalRequestMock = vi.hoisted(() =>
  vi.fn(
    (
      _params?: unknown,
    ): MockRegisteredExecApprovalRequest | Promise<MockRegisteredExecApprovalRequest> | undefined =>
      undefined,
  ),
);
const buildExecApprovalPendingToolResultMock = vi.hoisted(() => vi.fn());
const buildExecApprovalFollowupTargetMock = vi.hoisted(() =>
  vi.fn<BuildExecApprovalFollowupTargetMock>(() => null),
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
      deniedReason: "approval-required",
    }),
  ),
);
const evaluateShellAllowlistWithAuthorizationMock = vi.hoisted(() =>
  vi.fn(
    (): MockAllowlistResult => ({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      segmentSatisfiedBy: [],
    }),
  ),
);
const hasDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => true));
const hasExactCommandDurableExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const requiresExecApprovalMock = vi.hoisted(() => vi.fn(() => false));
const resolveExecApprovalAllowedDecisionsMock = vi.hoisted(() =>
  vi.fn(
    (params?: {
      ask?: string | null;
      allowAlwaysPersistence?: { kind: string } | null;
    }): readonly ExecApprovalDecision[] =>
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
    }): readonly ["allow-always"] | readonly [] =>
      params?.ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot"
        ? ["allow-always"]
        : [],
  ),
);
const buildEnforcedShellCommandMock = vi.hoisted(() =>
  vi.fn((): { ok: boolean; reason?: string; command?: string } => ({
    ok: false,
    reason: "segment execution plan unavailable",
  })),
);
const defaultExecAutoReviewerMock = vi.hoisted(() =>
  vi.fn<ExecAutoReviewer>(async () => ({
    decision: "allow-once",
    risk: "low",
    rationale: "allowed",
  })),
);
const commitExecAuthorizationMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveApprovalDecisionOrUndefinedMock = vi.hoisted(() =>
  vi.fn(
    async (_params?: {
      approvalId: string;
      preResolvedDecision: string | null | undefined;
      onFailure: () => void;
    }): Promise<string | null | undefined> => undefined,
  ),
);
const runAbortedApprovalError = vi.hoisted(() => new Error("run aborted"));
const resolveExecHostApprovalContextMock = vi.hoisted(() =>
  vi.fn(
    (): MockExecHostApprovalContext => ({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    }),
  ),
);
const runExecProcessMock = vi.hoisted(() => vi.fn());
const markBackgroundedMock = vi.hoisted(() => vi.fn());
const sendExecApprovalFollowupResultMock = vi.hoisted(() =>
  vi.fn<SendExecApprovalFollowupResult>(async () => undefined),
);
const shouldResolveExecApprovalUnavailableInlineMock = vi.hoisted(() =>
  vi.fn(
    (_params: {
      unavailableReason: string | null;
      preResolvedDecision: string | null | undefined;
    }) => false,
  ),
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

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  evaluateShellAllowlistWithAuthorization: evaluateShellAllowlistWithAuthorizationMock,
  hasDurableExecApproval: hasDurableExecApprovalMock,
  hasExactCommandDurableExecApproval: hasExactCommandDurableExecApprovalMock,
  buildEnforcedShellCommand: buildEnforcedShellCommandMock,
  requiresExecApproval: requiresExecApprovalMock,
  commitExecAuthorizationLocked: commitExecAuthorizationMock,
  resolveApprovalAuditTrustPath: vi.fn(() => null),
  resolveAllowAlwaysPatterns: vi.fn(() => []),
  resolveExecApprovalAllowedDecisions: resolveExecApprovalAllowedDecisionsMock,
  resolveExecApprovalUnavailableDecisions: resolveExecApprovalUnavailableDecisionsMock,
}));

vi.mock("../infra/exec-auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-auto-review.js")>()),
  defaultExecAutoReviewer: defaultExecAutoReviewerMock,
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: vi.fn(async () => undefined),
  isExecApprovalRunAbortedError: (error: unknown) => error === runAbortedApprovalError,
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: resolveExecHostApprovalContextMock,
  buildDefaultExecApprovalRequestArgs: vi.fn(() => ({})),
  buildHeadlessExecApprovalDeniedMessage: vi.fn(() => "denied"),
  buildExecApprovalFollowupTarget: buildExecApprovalFollowupTargetMock,
  buildExecApprovalPendingToolResult: buildExecApprovalPendingToolResultMock,
  createExecApprovalDecisionState: createExecApprovalDecisionStateMock,
  createAndRegisterDefaultExecApprovalRequest: createAndRegisterDefaultExecApprovalRequestMock,
  createExecApprovalRequestRoute: createExecApprovalRequestRouteMock,
  enforceStrictInlineEvalApprovalBoundary: enforceStrictInlineEvalApprovalBoundaryMock,
  resolveApprovalDecisionOrUndefined: resolveApprovalDecisionOrUndefinedMock,
  resolveExecApprovalDecisionState: resolveExecApprovalDecisionStateMock,
  resolveExecApprovalWaitOutcome: resolveExecApprovalWaitOutcomeMock,
  sendExecApprovalFollowupResult: sendExecApprovalFollowupResultMock,
  shouldResolveExecApprovalUnavailableInline: shouldResolveExecApprovalUnavailableInlineMock,
}));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  createApprovalSlug: vi.fn(() => "slug"),
  normalizeNotifyOutput: vi.fn((value) => value),
  runExecProcess: runExecProcessMock,
}));

vi.mock("./bash-process-registry.js", () => ({
  getActiveBackgroundExecSessionCount: vi.fn(() => 0),
  markBackgrounded: markBackgroundedMock,
  tail: vi.fn((value) => value),
}));

vi.mock("../infra/command-analysis/inline-eval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/command-analysis/inline-eval.js")>()),
  describeInterpreterInlineEval: vi.fn(() => "python -c"),
  detectInterpreterInlineEvalArgv: detectInterpreterInlineEvalArgvMock,
}));

let processGatewayAllowlist: typeof import("./bash-tools.exec-host-gateway.js").processGatewayAllowlist;
type GatewayAllowlistParams = Parameters<typeof processGatewayAllowlist>[0];

function requireBuildFollowupTargetInput(callIndex: number): ExecApprovalFollowupTarget {
  const call = buildExecApprovalFollowupTargetMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected build followup target call ${callIndex}`);
  }
  return call[0];
}

function requireSentFollowupTarget(
  callIndex: number,
): Parameters<SendExecApprovalFollowupResult>[0] {
  const call = sendExecApprovalFollowupResultMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected sent followup call ${callIndex}`);
  }
  return call[0];
}

function requireSentFollowupText(callIndex: number): string {
  const call = sendExecApprovalFollowupResultMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected sent followup call ${callIndex}`);
  }
  return call[1] ?? "";
}

function requireApprovalFollowupInput(
  mock: Mock<ExecApprovalFollowupFactory>,
  callIndex: number,
): Parameters<ExecApprovalFollowupFactory>[0] {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected approval followup call ${callIndex}`);
  }
  return call[0];
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

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

describe("processGatewayAllowlist", () => {
  beforeAll(async () => {
    ({ processGatewayAllowlist } = await import("./bash-tools.exec-host-gateway.js"));
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetDiagnosticEventsForTest();
    buildExecApprovalPendingToolResultMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReset();
    buildExecApprovalFollowupTargetMock.mockReturnValue(null);
    createExecApprovalDecisionStateMock.mockReset();
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "approval-required",
    });
    evaluateShellAllowlistWithAuthorizationMock.mockReset();
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/echo", source: "allow-always" }],
      segmentSatisfiedBy: [],
    });
    hasDurableExecApprovalMock.mockReset();
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReset();
    hasExactCommandDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReset();
    requiresExecApprovalMock.mockReturnValue(false);
    resolveExecApprovalAllowedDecisionsMock.mockClear();
    buildEnforcedShellCommandMock.mockReset();
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: false,
      reason: "segment execution plan unavailable",
    });
    defaultExecAutoReviewerMock.mockReset();
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "allow-once",
      risk: "low",
      rationale: "allowed",
    });
    commitExecAuthorizationMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockReset();
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(undefined);
    shouldResolveExecApprovalUnavailableInlineMock.mockReset();
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(false);
    resolveExecHostApprovalContextMock.mockReset();
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });
    runExecProcessMock.mockReset();
    markBackgroundedMock.mockReset();
    sendExecApprovalFollowupResultMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockReset();
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) => ({
      approvedByAsk: value.approvedByAsk,
      deniedReason: value.deniedReason,
    }));
    detectInterpreterInlineEvalArgvMock.mockReset();
    detectInterpreterInlineEvalArgvMock.mockReturnValue(null);
    resolveExecApprovalUnavailableDecisionsMock.mockClear();
    buildExecApprovalPendingToolResultMock.mockReturnValue({
      details: { status: "approval-pending" },
      content: [],
    });
    createAndRegisterDefaultExecApprovalRequestMock.mockReset();
    createAndRegisterDefaultExecApprovalRequestMock.mockResolvedValue({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      warningText: "",
      expiresAtMs: Date.now() + 60_000,
      preResolvedDecision: null,
      initiatingSurface: "origin",
      sentApproverDms: false,
      unavailableReason: null,
    });
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  function runGatewayAllowlist(
    overrides: Partial<GatewayAllowlistParams> & Pick<GatewayAllowlistParams, "command">,
  ) {
    const { command, ...rest } = overrides;
    return processGatewayAllowlist({
      command,
      workdir: process.cwd(),
      env: process.env as Record<string, string>,
      pty: false,
      defaultTimeoutSec: 30,
      security: "allowlist",
      ask: "off",
      safeBins: new Set(),
      safeBinProfiles: {},
      warnings: [],
      approvalRunningNoticeMs: 0,
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      ...rest,
    });
  }

  function mockApprovedDetachedExec(params: {
    outcome: ExecApprovalFollowupOutcome;
    sessionId?: string;
  }) {
    resolveExecApprovalWaitOutcomeMock.mockResolvedValueOnce({
      kind: "resolved",
      decision: "allow-once",
      state: {
        baseDecision: { timedOut: false },
        approvedByAsk: true,
        deniedReason: null,
        timeoutContext: undefined,
      },
    });
    runExecProcessMock.mockResolvedValue({
      session: { id: params.sessionId ?? "sess-1" },
      promise: Promise.resolve(params.outcome),
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
  }

  function useRealUnavailableApprovalGate() {
    shouldResolveExecApprovalUnavailableInlineMock.mockImplementation(
      ({ unavailableReason, preResolvedDecision }) =>
        unavailableReason === "no-approval-route" && preResolvedDecision === null,
    );
  }

  async function planAllowlistedNodeVersion() {
    const command = "node --version";
    const authorizationPlan = await planShellAuthorization({ command, env: process.env });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((candidate) => candidate.sourceSegment),
    );
    const enforced = buildAuthorizedShellCommandFromPlan({
      plan: authorizationPlan,
      mode: "enforced",
      segmentSatisfiedBy: ["allowlist"],
    });
    expect(enforced.ok).toBe(true);
    if (!enforced.ok) {
      throw new Error(enforced.reason);
    }
    return { command, authorizationPlan, segments, enforcedCommand: enforced.command };
  }

  async function configurePlanBackedCommand(params: {
    command: string;
    env?: NodeJS.ProcessEnv;
    allowlistSatisfied?: boolean;
    requiresApproval?: boolean;
    satisfiedBy?: ExecSegmentSatisfiedBy;
    segmentSatisfiedBy?: ExecSegmentSatisfiedBy[];
    segmentAllowlistEntries?: unknown[];
    hostAsk?: "off" | "on-miss" | "always";
    askFallback?: "deny" | "allowlist" | "full";
  }) {
    const authorizationPlan = await planShellAuthorization({
      command: params.command,
      env: params.env ?? process.env,
    });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((entry) => entry.sourceSegment),
    );
    requiresExecApprovalMock.mockReturnValue(params.requiresApproval ?? true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: params.allowlistSatisfied ?? false,
      segments,
      segmentAllowlistEntries: params.segmentAllowlistEntries ?? [],
      segmentSatisfiedBy:
        params.segmentSatisfiedBy ?? segments.map(() => params.satisfiedBy ?? null),
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: params.hostAsk ?? "on-miss",
      askFallback: params.askFallback ?? "deny",
    });
    const [candidate] = authorizationPlan.groups.flatMap((group) => group.candidates);
    const resolvedPath =
      candidate?.sourceSegment.resolution?.execution.resolvedRealPath ??
      candidate?.sourceSegment.resolution?.execution.resolvedPath;
    return { authorizationPlan, resolvedPath };
  }

  async function runTimedOutStrictInlineEval(params: {
    security: "full" | "allowlist";
    askFallback: "full" | "allowlist";
    approvedByAsk: boolean;
  }) {
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: params.security,
      hostAsk: "always",
      askFallback: params.askFallback,
    });
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: params.approvedByAsk,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });

    return runGatewayAllowlist({
      command: "python3 -c 'print(1)'",
      security: params.security,
      ask: "always",
      strictInlineEval: true,
      sessionKey: "agent:main:main",
    });
  }

  it("denies shell-expansion plan misses immediately when asking is off and fallback denies", async () => {
    const command = "grep -il needle -r /tmp --include=*.md";
    const authorizationPlan = await planShellAuthorization({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((candidate) => candidate.sourceSegment),
    );
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [{ pattern: "/usr/bin/grep" }],
      analysisOk: true,
      allowlistSatisfied: true,
      segments,
      segmentAllowlistEntries: [{ pattern: "/usr/bin/grep" }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({ command });
    } finally {
      captured.stop();
    }

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result!.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("ask-fallback-deny: execution-plan-miss"),
      }),
    );
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "exec.approval.denied",
      outcome: "denied",
      reason: "ask-fallback-deny: execution-plan-miss",
      policy: {
        id: "exec.approval",
        decision: "deny",
        reason: "ask-fallback-deny: execution-plan-miss",
      },
      attributes: {
        security: "allowlist",
        ask: "off",
        segment_count: 1,
      },
    });
  });

  it("still requires approval for unavailable allowlist plans when ask is on-miss", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: "echo ok",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("emits security events for gateway exec approval requests and denials", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("deny");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "user-denied",
    });
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({
        command: "deploy --token raw-secret-value",
        turnSourceChannel: "webchat",
        agentId: "agent-1",
      });
    } finally {
      captured.stop();
    }

    expect(result!.deniedResult?.details.status).toBe("failed");
    expect(captured.events).toHaveLength(2);
    expect(captured.events[0]).toMatchObject({
      action: "exec.approval.requested",
      outcome: "success",
      severity: "low",
      category: "approval",
      actor: { kind: "agent" },
      target: { kind: "tool", name: "system.exec", owner: "gateway" },
      policy: { id: "exec.approval", decision: "ask" },
      control: { id: "exec.approval", family: "approval" },
      attributes: {
        host: "gateway",
        security: "allowlist",
        ask: "off",
        segment_count: 1,
        has_agent_id: true,
      },
    });
    expect(captured.events[1]).toMatchObject({
      action: "exec.approval.denied",
      outcome: "denied",
      severity: "medium",
      reason: "user-denied",
      policy: { id: "exec.approval", decision: "deny", reason: "user-denied" },
      attributes: {
        decision: "deny",
        has_agent_id: true,
      },
    });
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("deploy");
    expect(serialized).not.toContain("raw-secret-value");
    expect(serialized).not.toContain("agent-1");
  });

  it("emits a denied security event for inline unavailable approval denials", async () => {
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(true);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "user-denied",
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "user-denied",
    });
    const captured = captureSecurityEvents();

    try {
      await expect(
        runGatewayAllowlist({
          command: "deploy --token raw-secret-value",
          agentId: "agent-1",
        }),
      ).rejects.toThrow("denied");
    } finally {
      captured.stop();
    }

    expect(captured.events).toHaveLength(2);
    expect(captured.events[1]).toMatchObject({
      action: "exec.approval.denied",
      outcome: "denied",
      severity: "medium",
      reason: "user-denied",
      policy: { id: "exec.approval", decision: "deny", reason: "user-denied" },
      attributes: {
        has_agent_id: true,
      },
    });
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("deploy");
    expect(serialized).not.toContain("raw-secret-value");
    expect(serialized).not.toContain("agent-1");
  });

  it("resolves a triggerless CLI no-route approval through the real gate", async () => {
    useRealUnavailableApprovalGate();
    createAndRegisterDefaultExecApprovalRequestMock.mockResolvedValue({
      approvalId: "approval-cli-no-route",
      approvalSlug: "slug",
      warningText: "",
      expiresAtMs: 0,
      preResolvedDecision: null,
      initiatingSurface: { kind: "unsupported" },
      sentApproverDms: false,
      unavailableReason: "no-approval-route",
    });
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: false,
      deniedReason: "approval-timeout",
    });
    const captured = captureSecurityEvents();

    try {
      await expect(
        runGatewayAllowlist({
          command: "echo askfallback-proof",
          agentId: "agent-1",
          ask: "on-miss",
        }),
      ).rejects.toThrow("denied");
    } finally {
      captured.stop();
    }

    expect(shouldResolveExecApprovalUnavailableInlineMock).toHaveBeenCalledWith({
      unavailableReason: "no-approval-route",
      preResolvedDecision: null,
    });
    expect(shouldResolveExecApprovalUnavailableInlineMock).toHaveReturnedWith(true);
    expect(resolveApprovalDecisionOrUndefinedMock).not.toHaveBeenCalled();
    expect(captured.events.at(-1)).toMatchObject({
      action: "exec.approval.denied",
      outcome: "denied",
    });
  });

  it("preserves a routed approval through the real gate", async () => {
    useRealUnavailableApprovalGate();
    createAndRegisterDefaultExecApprovalRequestMock.mockResolvedValue({
      approvalId: "approval-routed",
      approvalSlug: "slug",
      warningText: "",
      expiresAtMs: Date.now() + 60_000,
      preResolvedDecision: undefined,
      initiatingSurface: { kind: "channel" },
      sentApproverDms: true,
      unavailableReason: null,
    });
    resolveApprovalDecisionOrUndefinedMock.mockImplementation(() => new Promise(() => {}));

    const result = await runGatewayAllowlist({
      command: "echo routed-approval-proof",
      agentId: "agent-1",
      ask: "on-miss",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(shouldResolveExecApprovalUnavailableInlineMock).toHaveBeenCalledWith({
      unavailableReason: null,
      preResolvedDecision: undefined,
    });
    expect(shouldResolveExecApprovalUnavailableInlineMock).toHaveReturnedWith(false);
    expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-routed" }),
    );
  });

  it("emits an approved security event for inline unavailable approval approvals", async () => {
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(true);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockReturnValue({
      approvedByAsk: true,
      deniedReason: null,
    });
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({
        command: "echo ok",
        agentId: "agent-1",
      });
    } finally {
      captured.stop();
    }

    expect(result!).toEqual({
      execCommandOverride: undefined,
      allowWithoutEnforcedCommand: true,
    });
    expect(captured.events).toHaveLength(2);
    expect(captured.events[1]).toMatchObject({
      action: "exec.approval.approved",
      outcome: "success",
      severity: "medium",
      policy: { id: "exec.approval", decision: "allow" },
      attributes: {
        has_agent_id: true,
      },
    });
    expect(JSON.stringify(captured.events)).not.toContain("agent-1");
  });

  it("auto-reviews simple read-only approval misses without prompting", async () => {
    const command = "echo ok";
    const { resolvedPath } = await configurePlanBackedCommand({ command });
    expect(resolvedPath).toBeTruthy();

    const captured = captureSecurityEvents();
    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });
    } finally {
      captured.stop();
    }

    expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `${resolvedPath} ok`,
        argv: ["echo", "ok"],
        resolvedPath,
        host: "gateway",
        reason: "approval-required",
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result!).toEqual({
      execCommandOverride: `${resolvedPath} ok`,
    });
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "exec.approval.approved",
      outcome: "success",
      attributes: { decision: "auto-review" },
    });
    expect(JSON.stringify(captured.events)).not.toContain("allowed");
  });

  it("emits the Guardian review lifecycle on the reviewed exec call", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    let resolveReview!: (decision: Awaited<ReturnType<ExecAutoReviewer>>) => void;
    const autoReviewer = vi.fn<ExecAutoReviewer>(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve;
        }),
    );
    const reviews: Array<Record<string, unknown>> = [];
    const publicationOrder: string[] = [];
    const onApprovalReview = vi.fn((review: { status: string }) => {
      publicationOrder.push(`stored:${review.status}`);
    });
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-review" &&
        event.stream === "tool" &&
        event.data.phase === "review"
      ) {
        publicationOrder.push(`emitted:${String(event.data.approvalReviewOutcome)}`);
        reviews.push(event.data);
      }
    });

    try {
      const pending = runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        runId: "run-review",
        toolCallId: "tool-review",
        onApprovalReview,
      });
      await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledTimes(1));
      expect(reviews).toEqual([
        expect.objectContaining({
          phase: "review",
          toolCallId: "tool-review",
          approvalReviewOutcome: "reviewing",
          review: expect.objectContaining({ label: "Guardian", status: "in_progress" }),
        }),
      ]);
      resolveReview({ decision: "allow-once", risk: "low", rationale: "read-only" });
      await pending;

      expect(reviews).toEqual([
        expect.objectContaining({
          approvalReviewOutcome: "reviewing",
          review: expect.objectContaining({ status: "in_progress" }),
        }),
        expect.objectContaining({
          phase: "review",
          toolCallId: "tool-review",
          approvalReviewOutcome: "approved",
          review: expect.objectContaining({
            label: "Guardian",
            status: "approved",
            riskLevel: "low",
            rationale: "read-only",
          }),
        }),
      ]);
      expect(publicationOrder).toEqual([
        "emitted:reviewing",
        "stored:approved",
        "emitted:approved",
      ]);
      expect(onApprovalReview).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it("does not invent Guardian review identity without a tool call ID", async () => {
    await configurePlanBackedCommand({ command: "echo ok" });
    const onApprovalReview = vi.fn();
    const reviewEvents: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-without-tool-call" && event.data.phase === "review") {
        reviewEvents.push(event.data);
      }
    });
    try {
      await runGatewayAllowlist({
        command: "echo ok",
        ask: "on-miss",
        autoReview: true,
        runId: "run-without-tool-call",
        onApprovalReview,
      });
      expect(defaultExecAutoReviewerMock).toHaveBeenCalledTimes(1);
      expect(onApprovalReview).not.toHaveBeenCalled();
      expect(reviewEvents).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it.runIf(process.platform !== "win32").each(["bash", "sh", "/bin/sh"])(
    "keeps %s login-shell startup outside model auto-review",
    async (shell) => {
      const payload = "echo auto-review-startup-proof";
      const command = `${shell} -lc "${payload}"`;
      await configurePlanBackedCommand({ command });

      const result = await runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
      });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
      expect(result.pendingResult?.details.status).toBe("approval-pending");
    },
  );

  it("does not execute after cancellation wins during auto-review", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    const autoReviewer = vi.fn<ExecAutoReviewer>(() => new Promise(() => {}));
    const abortController = new AbortController();
    const reviewStatuses: string[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (
        event.runId === "run-cancelled-review" &&
        event.stream === "tool" &&
        event.data.phase === "review"
      ) {
        const review = event.data.review as { status?: unknown } | undefined;
        if (typeof review?.status === "string") {
          reviewStatuses.push(review.status);
        }
      }
    });

    try {
      const result = runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
        autoReviewer,
        signal: abortController.signal,
        runId: "run-cancelled-review",
        toolCallId: "tool-cancelled-review",
      });
      await vi.waitFor(() => expect(autoReviewer).toHaveBeenCalledTimes(1));

      abortController.abort(new Error("cancelled during review"));

      await expect(result).rejects.toThrow("cancelled during review");
    } finally {
      unsubscribe();
    }
    expect(reviewStatuses).toEqual(["in_progress", "aborted"]);
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
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
  ])("requests human approval when a gateway reviewer $name", async ({ reviewer }) => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    const autoReviewer = vi.fn<ExecAutoReviewer>(reviewer);
    const warnings: string[] = [];

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
      autoReviewer,
      warnings,
    });

    expect(autoReviewer).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      "Exec auto-review deferred to human approval (risk=unknown): exec reviewer failed: provider\\nfailed",
    ]);
  });

  it("reviews and executes the same PATH-resolved executable", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auto-review-path-"));
    const shadowGit = path.join(tempDir, "git");
    fs.copyFileSync(process.execPath, shadowGit);
    fs.chmodSync(shadowGit, 0o755);
    try {
      const command = "git status";
      const canonicalShadowGit = fs.realpathSync(shadowGit);
      await configurePlanBackedCommand({
        command,
        env: { PATH: tempDir },
      });

      const result = await runGatewayAllowlist({
        command,
        env: { PATH: tempDir },
        ask: "on-miss",
        autoReview: true,
      });

      expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
        expect.objectContaining({ resolvedPath: canonicalShadowGit }),
      );
      expect(result).toMatchObject({ execCommandOverride: `${canonicalShadowGit} status` });
      await expect(result.revalidateBeforeExecution?.()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects contradictory non-low custom reviewer approvals", async () => {
    const command = "echo ok";
    await configurePlanBackedCommand({ command });
    defaultExecAutoReviewerMock.mockResolvedValueOnce({
      decision: "allow-once",
      risk: "high",
      rationale: "contradictory custom decision",
    } as never);

    const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("fails closed before approval when a heredoc command cannot be operand-bound", async () => {
    const command = "python3 - <<'PY'\nprint('ok')\nPY";
    const authorizationPlan = await planShellAuthorization({
      command,
      env: process.env,
    });
    expect(authorizationPlan).toMatchObject({ ok: false, reason: "heredoc" });
    requiresExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("approval cannot safely bind this command"),
      }),
    );
  });

  it("does not activate allowlist fallback for a full-policy heredoc without an approval", async () => {
    const command = "python3 - <<'PY'\nprint('ok')\nPY";
    requiresExecApprovalMock.mockReturnValue(false);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        {
          raw: command,
          resolution: null,
          argv: ["python3", "-", "<<'PY'"],
        },
      ],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: ["allowlist"],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "allowlist",
    });

    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "off",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined });
  });

  it("auto-reviews strict inline-eval commands instead of forcing human approval", async () => {
    const command = "python3 -c 'print(1)'";
    const { resolvedPath } = await configurePlanBackedCommand({
      command,
      allowlistSatisfied: true,
      requiresApproval: false,
      satisfiedBy: "allowlist",
    });
    detectInterpreterInlineEvalArgvMock.mockReturnValue(INLINE_EVAL_HIT);
    const warnings: string[] = [];

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
      strictInlineEval: true,
      warnings,
    });

    expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `${resolvedPath} -c 'print(1)'`,
        argv: ["python3", "-c", "print(1)"],
        host: "gateway",
        reason: "strict-inline-eval",
        analysis: expect.objectContaining({
          inlineEval: true,
        }),
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(warnings[0]).toContain("reviewer or explicit approval");
    expect(result.execCommandOverride).toBe(`${resolvedPath} -c 'print(1)'`);
  });

  it("uses a plan-backed enforced command when the allowlist plan is usable", async () => {
    const command = "head -c 16";
    const authorizationPlan = await planShellAuthorization({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    const execution =
      authorizationPlan.groups[0]?.candidates[0]?.sourceSegment.resolution?.execution;
    const resolvedExecutable = execution?.resolvedRealPath ?? execution?.resolvedPath;
    expect(resolvedExecutable).toBeTruthy();
    requiresExecApprovalMock.mockReturnValue(false);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [{ raw: command, resolution: null, argv: ["head", "-c", "16"] }],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: ["safeBins"],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: {
        allowlist: [],
        agent: {
          security: "allowlist",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        file: { version: 1, agents: {} },
      },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command,
      ask: "off",
    });

    expect(result).toEqual({
      execCommandOverride: `${resolvedExecutable} -c 16`,
    });
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          security: "allowlist",
          ask: "off",
        }),
      }),
    );
  });

  it("does not bind current policy to redundant exact-command trust", async () => {
    const command = "cd .";
    const authorizationPlan = await planShellAuthorization({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    const enforced = buildAuthorizedShellCommandFromPlan({
      plan: authorizationPlan,
      mode: "enforced",
      segmentSatisfiedBy: ["safeBuiltins"],
    });
    expect(enforced.ok).toBe(true);
    if (!enforced.ok) {
      throw new Error(enforced.reason);
    }
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: authorizationPlan.groups.flatMap((group) =>
        group.candidates.map((candidate) => candidate.sourceSegment),
      ),
      segmentAllowlistEntries: [null],
      segmentSatisfiedBy: ["safeBuiltins"],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: {
        allowlist: [{ pattern: exactCommandMarker(command), source: "allow-always" }],
        file: { version: 1, agents: {} },
      },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({ command });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: enforced.command });
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: false,
          requireDurableAllowlistApproval: false,
        }),
      }),
    );
  });

  it("keeps unrenderable allowlist plans on the human approval path", async () => {
    const command = "ls *.ts";
    await configurePlanBackedCommand({
      command,
      allowlistSatisfied: true,
      requiresApproval: false,
      satisfiedBy: "allowlist",
    });

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("rejects unprompted full execution when the locked policy commit sees revocation", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval revoked"));

    await expect(
      runGatewayAllowlist({
        command: "pwd",
        security: "full",
        ask: "off",
      }),
    ).rejects.toThrow("approval revoked");
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          security: "full",
        }),
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("binds auto-review to the evaluated snapshot before the locked policy commit", async () => {
    const command = "echo reviewed";
    await configurePlanBackedCommand({ command });
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval changed"));

    await expect(
      runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
      }),
    ).rejects.toThrow("approval changed");
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "auto-review",
          ask: "on-miss",
          policySnapshot: {
            security: "full",
            ask: "off",
            askFallback: "deny",
            autoAllowSkills: false,
            allowlistRules: [],
          },
        }),
      }),
    );
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("omits allow-always when allowlist execution cannot persist reusable patterns", async () => {
    const command = "ls *.ts";
    const authorizationPlan = await planShellAuthorization({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    requiresExecApprovalMock.mockReturnValue(false);
    hasDurableExecApprovalMock.mockReturnValue(false);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: authorizationPlan.groups.flatMap((group) =>
        group.candidates.map((candidate) => candidate.sourceSegment),
      ),
      segmentAllowlistEntries: [{ pattern: "/usr/bin/ls", source: "allow-always" }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: false,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "on-miss",
      allowAlwaysPersistence: {
        kind: "one-shot",
        reasons: ["no-reusable-pattern"],
      },
    });
    expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "deny"],
      }),
    );
  });

  it("honors durable exact-command trust for unenforceable allowlisted commands", async () => {
    const command = "ls *.ts";
    const authorizationPlan = await planShellAuthorization({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    requiresExecApprovalMock.mockReturnValue(false);
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: authorizationPlan.groups.flatMap((group) =>
        group.candidates.map((candidate) => candidate.sourceSegment),
      ),
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [null],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: {
        allowlist: [{ pattern: exactCommandMarker(command), source: "allow-always" }],
        agent: {
          security: "allowlist",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        file: { version: 1, agents: {} },
      },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: false,
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined });
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: true,
        }),
      }),
    );
  });

  it("binds mixed allowlist authorization to exact trust when it bypasses an unavailable plan", async () => {
    const command = "ls *.ts";
    const authorizationPlan = await planShellAuthorization({
      command,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    const allowlistEntry: ExecAllowlistEntry = {
      pattern: "/usr/bin/ls",
      source: "allow-always",
    };
    requiresExecApprovalMock.mockReturnValue(false);
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [allowlistEntry],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: authorizationPlan.groups.flatMap((group) =>
        group.candidates.map((candidate) => candidate.sourceSegment),
      ),
      segmentAllowlistEntries: [allowlistEntry],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: {
        allowlist: [
          allowlistEntry,
          { pattern: exactCommandMarker(command), source: "allow-always" },
        ],
        file: { version: 1, agents: {} },
      },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("exact-command approval revoked"));

    await expect(
      runGatewayAllowlist({
        command,
        ask: "off",
        autoReview: false,
      }),
    ).rejects.toThrow("exact-command approval revoked");

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: true,
          requireDurableAllowlistApproval: false,
        }),
      }),
    );
  });

  it("offers allow-always for shell-wrapper misses with reusable executable patterns", async () => {
    if (process.platform === "win32") {
      return;
    }

    const command = "sh -c 'git status'";
    const env = { PATH: "/usr/bin:/bin" };
    const authorizationPlan = await planShellAuthorization({ command, env });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    requiresExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: authorizationPlan.groups.flatMap((group) =>
        group.candidates.map((candidate) => candidate.sourceSegment),
      ),
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [null],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-always");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    runExecProcessMock.mockResolvedValue({
      session: { id: "sess-1" },
      promise: Promise.resolve({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        aggregated: "done",
      }),
    });

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      env,
      autoReview: false,
    });
    const expectedGitArgPattern = buildHashedArgPatternFromArgv(["/usr/bin/git", "status"]);

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
      ask: "on-miss",
      allowAlwaysPersistence: {
        kind: "patterns",
        commandText: "sh -c 'git status'",
        patterns: [{ pattern: "/usr/bin/git", argPattern: expectedGitArgPattern }],
      },
    });
    expect(buildExecApprovalPendingToolResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      }),
    );
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ source: "explicit-approval" }),
        allowAlwaysDecision: {
          kind: "patterns",
          commandText: "sh -c 'git status'",
          patterns: [{ pattern: "/usr/bin/git", argPattern: expectedGitArgPattern }],
        },
      }),
    );
  });

  it("requests human approval when auto-review asks on an approval miss", async () => {
    await configurePlanBackedCommand({ command: "echo ok" });
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "ask",
      risk: "medium",
      rationale: "needs a person",
    });
    const warnings: string[] = [];
    const reviewStatuses: string[] = [];
    const onApprovalReview = vi.fn();
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-denied-review" && event.data.phase === "review") {
        reviewStatuses.push(String(event.data.approvalReviewOutcome));
      }
    });
    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({
        command: "echo ok",
        ask: "on-miss",
        autoReview: true,
        runId: "run-denied-review",
        toolCallId: "tool-denied-review",
        onApprovalReview,
        warnings,
      });
    } finally {
      unsubscribe();
    }

    expect(defaultExecAutoReviewerMock).toHaveBeenCalledTimes(1);
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(warnings.join("\n")).toContain("needs a person");
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    expect(reviewStatuses).toEqual(["reviewing", "denied"]);
    expect(onApprovalReview).toHaveBeenCalledWith(
      expect.objectContaining({ id: "guardian:tool-denied-review", status: "denied" }),
    );
  });

  it.runIf(process.platform !== "win32").each([
    { name: "command chain", command: "node --version && node --version" },
    { name: "pipeline", command: "node --version | node --version" },
    {
      name: "safe builtin and external executable",
      command: "true && node --version",
      segmentSatisfiedBy: ["safeBuiltins", null] as ExecSegmentSatisfiedBy[],
    },
  ])(
    "auto-reviews the exact enforced $name without prompting",
    async ({ command, segmentSatisfiedBy }) => {
      const { authorizationPlan } = await configurePlanBackedCommand({
        command,
        segmentSatisfiedBy,
      });
      const candidates = authorizationPlan.groups.flatMap((group) => group.candidates);
      const enforced = buildAuthorizedShellCommandFromPlan({
        plan: authorizationPlan,
        mode: "enforced",
        segmentSatisfiedBy: segmentSatisfiedBy ?? candidates.map(() => null),
      });
      expect(enforced.ok).toBe(true);
      if (!enforced.ok) {
        throw new Error(enforced.reason);
      }

      const result = await runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
      });

      expect(defaultExecAutoReviewerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: enforced.command,
          argv: undefined,
          resolvedPath: undefined,
        }),
      );
      expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
      expect(result.execCommandOverride).toBe(enforced.command);
    },
  );

  it.runIf(process.platform !== "win32")(
    "defers compound plans with more than 64 candidates before Guardian review",
    async () => {
      const command = Array.from({ length: 65 }, () => "node --version").join(" && ");
      await configurePlanBackedCommand({ command });

      const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(result.pendingResult?.details.status).toBe("approval-pending");
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps shell expansion inside a safe-builtin compound plan off auto-review",
    async () => {
      const command = "true *.txt && node --version";
      await configurePlanBackedCommand({
        command,
        segmentSatisfiedBy: ["safeBuiltins", null],
      });

      const result = await runGatewayAllowlist({ command, ask: "on-miss", autoReview: true });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(result.pendingResult?.details.status).toBe("approval-pending");
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps dispatch-wrapper compound plans on the human approval path",
    async () => {
      const command = "timeout 5 node --version && node --version";
      const { authorizationPlan } = await configurePlanBackedCommand({ command });
      const wrapperChain =
        authorizationPlan.groups[0]?.candidates[0]?.sourceSegment.resolution?.wrapperChain;
      expect(wrapperChain).toContain("timeout");

      const result = await runGatewayAllowlist({
        command,
        ask: "on-miss",
        autoReview: true,
      });

      expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
      expect(result.pendingResult?.details.status).toBe("approval-pending");
    },
  );

  it("fails closed before approval when the executable cannot be resolved", async () => {
    const command = "openclaw-definitely-missing-executable --version";
    const { resolvedPath } = await configurePlanBackedCommand({ command });
    expect(resolvedPath).toBeUndefined();

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("requires a resolved executable") }),
    );
  });

  it("does not use fallback-full when auto-review cannot parse the command", async () => {
    requiresExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
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
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await runGatewayAllowlist({
      command: "echo 'unterminated",
      ask: "on-miss",
      autoReview: true,
      turnSourceChannel: "webchat",
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(enforceStrictInlineEvalApprovalBoundaryMock).not.toHaveBeenCalled();
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("approval cannot safely bind this command"),
      }),
    );
  });

  it("does not use fallback-full when auto-review asks for human approval", async () => {
    requiresExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["echo", "ok"] }],
      segmentAllowlistEntries: [],
    });
    defaultExecAutoReviewerMock.mockResolvedValue({
      decision: "ask",
      risk: "medium",
      rationale: "needs a person",
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "full",
    });
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.requiresAutoReviewHumanApproval === true && value.baseDecision.timedOut
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await runGatewayAllowlist({
      command: "echo ok",
      ask: "on-miss",
      autoReview: true,
      turnSourceChannel: "webchat",
    });

    expect(enforceStrictInlineEvalApprovalBoundaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresAutoReviewHumanApproval: true,
      }),
    );
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: "Exec denied (gateway id=req-1, approval-timeout): echo ok",
      }),
    );
  });

  it("requires approval for security audit suppression edits unless yolo mode is active", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("keeps security audit suppression edits off the auto-review path", async () => {
    const warnings: string[] = [];
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
      autoReview: true,
      warnings,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(warnings[0]).toContain("explicit approval");
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("does not require approval for security audit suppression edits in yolo mode", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "off",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("does not require suppression edit approval for read-only suppression inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
      ],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [null],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw config get security.audit.suppressions",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("does not require suppression edit approval for profile-scoped read-only inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        {
          resolution: null,
          argv: ["openclaw", "--profile", "rescue", "config", "get", "security.audit.suppressions"],
        },
      ],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [null],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw --profile rescue config get security.audit.suppressions",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("requires suppression edit approval when a mutating segment follows read-only inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
        {
          resolution: null,
          argv: ["openclaw", "config", "set", "security.audit.suppressions", "[]"],
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command:
        "openclaw config get security.audit.suppressions; openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("requires suppression edit approval when allowlist analysis only returns a read-only prefix", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command:
        "openclaw config get security.audit.suppressions; openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("requires suppression edit approval when a heredoc patch follows read-only inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        {
          raw: "openclaw config get security.audit.suppressions",
          resolution: null,
          argv: ["openclaw", "config", "get", "security.audit.suppressions"],
        },
        {
          raw: "openclaw config patch --stdin <<'EOF'",
          resolution: null,
          argv: ["openclaw", "config", "patch", "--stdin"],
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: `openclaw config get security.audit.suppressions; openclaw config patch --stdin <<'EOF'
{"security":{"audit":{"suppressions":[]}}}
EOF`,
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.pendingResult?.details.status).toBe("approval-pending");
  });

  it("allows durable exact-command trust to bypass the synchronous allowlist miss", async () => {
    const command = "/bin/echo durable";
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["/bin/echo", "durable"] }],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(true);
    hasExactCommandDurableExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: true,
      command,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: {
        allowlist: [{ pattern: exactCommandMarker(command), source: "allow-always" }],
        file: { version: 1, agents: {} },
      },
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({ command });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result).toEqual({ execCommandOverride: undefined });
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "current-policy",
          requireExactCommandApproval: true,
        }),
      }),
    );
  });

  it("keeps denying allowlist misses when durable trust does not match", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: false,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["node", "--version"] }],
      segmentAllowlistEntries: [],
    });
    hasDurableExecApprovalMock.mockReturnValue(false);

    await expect(
      runGatewayAllowlist({
        command: "node --version",
      }),
    ).rejects.toThrow("exec denied: allowlist miss");
  });

  it("uses sessionKey for followups when notifySessionKey is absent", async () => {
    await runGatewayAllowlist({
      command: "echo ok",
      sessionKey: "agent:main:telegram:direct:123",
    });

    expect(requireBuildFollowupTargetInput(0).sessionKey).toBe("agent:main:telegram:direct:123");
  });

  it("keeps webchat diagnostics approvals as direct pasteable followups", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: null,
    });
    const outcome = {
      status: "completed" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 12,
      timedOut: false,
      aggregated: JSON.stringify({
        path: "/tmp/openclaw-diagnostics.zip",
        bytes: 1234,
        manifest: {
          generatedAt: "2026-04-28T20:58:29.311Z",
          openclawVersion: "2026.4.27",
          contents: [
            { path: "diagnostics.json", bytes: 100 },
            { path: "summary.md", bytes: 200 },
          ],
          privacy: {
            payloadFree: true,
            rawLogsIncluded: false,
            notes: ["Logs keep operational summaries."],
          },
        },
      }),
    };
    runExecProcessMock.mockResolvedValue({
      session: { id: "sess-1" },
      promise: Promise.resolve(outcome),
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);

    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(async () =>
      [
        "OpenAI Codex harness:",
        "Codex diagnostics sent to OpenAI servers:",
        "Session 1",
        "Channel: telegram",
        "OpenClaw session id: `session-1`",
        "Codex thread id: `thread-1`",
      ].join("\n"),
    );

    const result = await runGatewayAllowlist({
      command: "openclaw gateway diagnostics export --json",
      trigger: "diagnostics",
      approvalFollowupMode: "direct",
      approvalFollowup,
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    expect(requireBuildFollowupTargetInput(0).direct).toBe(true);

    const followupTarget = requireSentFollowupTarget(0);
    expect(followupTarget?.direct).toBe(true);
    const followupText = requireSentFollowupText(0);
    expect(followupText).toContain("Diagnostics export created.");
    expect(followupText).toContain("Path: /tmp/openclaw-diagnostics.zip");
    expect(followupText).toContain("Contents (2 files):");
    expect(followupText).toContain("OpenAI Codex harness:");
    expect(followupText).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(followupText).toContain("Codex thread id: `thread-1`");
    const approvalInput = requireApprovalFollowupInput(approvalFollowup, 0);
    expect(approvalInput?.approvalId).toBe("req-1");
    expect(approvalInput?.sessionId).toBe("sess-1");
    expect(approvalInput?.trigger).toBe("diagnostics");
    expect(approvalInput?.outcome?.status).toBe("completed");
    expect(approvalInput?.outcome?.exitCode).toBe(0);
  });

  it("uses async agent followups for explicit webchat approval mode", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "deny",
    });
    mockApprovedDetachedExec({
      outcome: {
        status: "completed",
        exitCode: 0,
        timedOut: false,
        aggregated: "done",
      },
    });

    const result = await runGatewayAllowlist({
      command: "openclaw sessions export-trajectory --json",
      approvalFollowupMode: "agent",
      sessionId: "approval-session",
      sessionStore: "/tmp/openclaw-sessions.json",
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    expect(requireBuildFollowupTargetInput(0)).toMatchObject({
      direct: false,
      expectedSessionId: "approval-session",
      sessionStore: "/tmp/openclaw-sessions.json",
    });
    expect(requireSentFollowupTarget(0)?.direct).toBe(false);
    expect(requireSentFollowupText(0)).toContain("done");
  });

  it("keeps a completed detached outcome terminal when agent follow-up registration fails", async () => {
    const unhandledRejections = captureProcessUnhandledRejections();
    const completedOutcome = {
      status: "completed" as const,
      exitCode: 0,
      timedOut: false,
      aggregated: "completed output",
    };
    const approvalFollowup = vi.fn<ExecApprovalFollowupFactory>(() => undefined);
    mockApprovedDetachedExec({ outcome: completedOutcome });
    sendExecApprovalFollowupResultMock.mockRejectedValueOnce(
      new Error("synchronous runtime-handoff registration failure"),
    );

    try {
      const result = await runGatewayAllowlist({
        command: "side-effecting-command",
        approvalFollowupMode: "agent",
        approvalFollowup,
        turnSourceChannel: "webchat",
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => expect(approvalFollowup).toHaveBeenCalledOnce());
      await setImmediate();

      expect(requireApprovalFollowupInput(approvalFollowup, 0).outcome).toEqual(completedOutcome);
      expect(unhandledRejections.reasons).toEqual([]);
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
      expect(requireSentFollowupText(0)).toContain("completed output");
      expect(requireSentFollowupText(0)).not.toContain("Exec denied");
    } finally {
      unhandledRejections.restore();
    }
  });

  it.each([
    {
      name: "request failure",
      outcome: { kind: "request-failed" as const },
      firstFollowupReason: "approval-request-failed",
    },
    {
      name: "denial",
      outcome: {
        kind: "resolved" as const,
        decision: "deny",
        state: {
          baseDecision: { timedOut: false },
          approvedByAsk: false,
          deniedReason: "user-denied",
          timeoutContext: undefined,
        },
      },
      firstFollowupReason: "user-denied",
    },
  ])("consumes rejected detached pre-dispatch $name and fallback follow-ups", async (scenario) => {
    const unhandledRejections = captureProcessUnhandledRejections();
    resolveExecApprovalWaitOutcomeMock.mockResolvedValueOnce(scenario.outcome);
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
    sendExecApprovalFollowupResultMock.mockRejectedValue(
      new Error("pre-dispatch denial follow-up failed"),
    );

    try {
      const result = await runGatewayAllowlist({
        command: "side-effecting-command",
        approvalFollowupMode: "agent",
        turnSourceChannel: "webchat",
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      await vi.waitFor(() => expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(2));
      await setImmediate();

      expect(unhandledRejections.reasons).toEqual([]);
      expect(requireSentFollowupText(0)).toBe(
        `Exec denied (gateway id=req-1, ${scenario.firstFollowupReason}): side-effecting-command`,
      );
      expect(requireSentFollowupText(1)).toBe(
        "Exec denied (gateway id=req-1, approval-request-failed): side-effecting-command",
      );
      expect(runExecProcessMock).not.toHaveBeenCalled();
    } finally {
      unhandledRejections.restore();
    }
  });

  it("keeps multiline gateway approval follow-up output intact", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "deny",
    });
    const aggregated = "first line\r\n\tindented\n\nlast line  \t\n";
    mockApprovedDetachedExec({
      outcome: {
        status: "completed",
        exitCode: 0,
        timedOut: false,
        aggregated,
      },
    });

    const result = await runGatewayAllowlist({
      command: "openclaw sessions export-trajectory --json",
      approvalFollowupMode: "agent",
      sessionId: "approval-session",
      sessionStore: "/tmp/openclaw-sessions.json",
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    const text = requireSentFollowupText(0);
    expect(text).toContain(aggregated);
    // The compact notify formatter would have collapsed every run of whitespace.
    expect(text).not.toContain("first line indented last line");
  });

  it("fails closed when detached approval metadata cannot be persisted", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval lock unavailable"));
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({ command: "echo approved" });
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      captured.stop();
    }

    expect(result!.pendingResult?.details.status).toBe("approval-pending");
    expect(requireSentFollowupText(0)).toContain("approval-state-write-failed");
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(captured.events.at(-1)).toMatchObject({
      action: "exec.approval.denied",
      outcome: "error",
      policy: { reason: "approval-state-write-failed" },
    });
  });

  it("fails closed without spawning when a detached atomic allow-always commit fails", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-always");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval lock unavailable"));
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof runGatewayAllowlist>>;
    try {
      result = await runGatewayAllowlist({ command: "echo approved" });
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      captured.stop();
    }

    expect(result!.pendingResult?.details.status).toBe("approval-pending");
    expect(requireSentFollowupText(0)).toContain("approval-state-write-failed");
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(commitExecAuthorizationMock).toHaveBeenCalledTimes(1);
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ source: "explicit-approval" }),
        allowAlwaysDecision: expect.any(Object),
      }),
    );
    expect(captured.events.at(-1)).toMatchObject({
      action: "exec.approval.denied",
      outcome: "error",
      policy: { reason: "approval-state-write-failed" },
    });
  });

  it("waits inline for webchat approval so the exec tool can return real output to the model", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });

    const result = await runGatewayAllowlist({
      command: "pwd && df -h",
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult).toBeUndefined();
    expect(result.deniedResult).toBeUndefined();
    expect(result.allowWithoutEnforcedCommand).toBe(true);
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(buildExecApprovalFollowupTargetMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it.each([
    { decision: "allow-once", deniedReason: null },
    { decision: "deny", deniedReason: "user-denied" },
  ] as const)("emits inline approval park and clear events for $decision", async (testCase) => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(testCase.decision);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: testCase.decision === "allow-once",
      deniedReason: testCase.deniedReason,
    });
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.runId === "run-inline" && event.stream === "lifecycle") {
        events.push(event.data);
      }
    });

    try {
      await runGatewayAllowlist({
        command: "pwd",
        turnSourceChannel: "webchat",
        runId: "run-inline",
        toolCallId: "tool-inline",
        sessionKey: "agent:main:main",
        sessionId: "session-inline",
      });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      { phase: "waiting-approval", approvalId: "req-1", toolCallId: "tool-inline" },
      { phase: "approval-resolved", approvalId: "req-1", toolCallId: "tool-inline" },
    ]);
  });

  it.each([
    ["telegram"],
    ["slack"],
    ["discord"],
    ["signal"],
    ["whatsapp"],
    ["imessage"],
    ["matrix"],
    ["googlechat"],
    ["qqbot"],
  ])(
    "waits inline for native chat approval (%s) so the exec tool returns real output (issue #93918)",
    async (turnSourceChannel) => {
      resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
      createExecApprovalDecisionStateMock.mockReturnValue({
        baseDecision: { timedOut: false },
        approvedByAsk: true,
        deniedReason: null,
      });

      const result = await runGatewayAllowlist({
        command: "find . -maxdepth 1",
        turnSourceChannel,
      });

      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult).toBeUndefined();
      expect(result.allowWithoutEnforcedCommand).toBe(true);
      expect(runExecProcessMock).not.toHaveBeenCalled();
      expect(buildExecApprovalFollowupTargetMock).not.toHaveBeenCalled();
      expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["telegram"],
    ["slack"],
    ["discord"],
    ["signal"],
    ["whatsapp"],
    ["imessage"],
    ["matrix"],
    ["googlechat"],
    ["qqbot"],
  ])(
    "returns native chat approval denials (%s) as the foreground tool result (issue #93918)",
    async (turnSourceChannel) => {
      resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("deny");
      createExecApprovalDecisionStateMock.mockReturnValue({
        baseDecision: { timedOut: false },
        approvedByAsk: false,
        deniedReason: "user-denied",
      });

      const result = await runGatewayAllowlist({
        command: "find . -maxdepth 1",
        turnSourceChannel,
      });

      expect(result.pendingResult).toBeUndefined();
      expect(result.deniedResult?.details.status).toBe("failed");
      expect(result.deniedResult?.content[0]).toEqual(
        expect.objectContaining({
          text: "Exec denied (gateway id=req-1, user-denied): find . -maxdepth 1",
        }),
      );
      expect(runExecProcessMock).not.toHaveBeenCalled();
      expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
    },
  );

  it("waits outside admission, then atomically hands an approved process to the registry", async () => {
    let resolveApproval: (decision: ExecApprovalDecision) => void = () => {};
    const approval = new Promise<ExecApprovalDecision>((resolve) => {
      resolveApproval = resolve;
    });
    let resolveOutcome: (outcome: ExecApprovalFollowupOutcome) => void = () => {};
    const outcome = new Promise<ExecApprovalFollowupOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let allowSpawn: () => void = () => {};
    const spawnAllowed = new Promise<void>((resolve) => {
      allowSpawn = resolve;
    });
    let announceSpawn: () => void = () => {};
    const spawnStarted = new Promise<void>((resolve) => {
      announceSpawn = resolve;
    });
    resolveApprovalDecisionOrUndefinedMock.mockReturnValue(approval);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    commitExecAuthorizationMock.mockImplementation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });
    runExecProcessMock.mockImplementation(async () => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      announceSpawn();
      await spawnAllowed;
      return { session: { id: "sess-atomic" }, promise: outcome };
    });
    markBackgroundedMock.mockImplementation(() => {
      expect(getActiveGatewayRootWorkCount()).toBe(1);
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
    });
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledOnce();
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    resolveApproval("allow-once");
    await Promise.resolve();
    await Promise.resolve();
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(markBackgroundedMock).not.toHaveBeenCalled();

    suspension?.release();
    await spawnStarted;
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    allowSpawn();
    await vi.waitFor(() => {
      expect(markBackgroundedMock).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(commitExecAuthorizationMock).toHaveBeenCalledOnce();
    expect(runExecProcessMock).toHaveBeenCalledOnce();

    resolveOutcome({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      aggregated: "done",
    });
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { name: "denies drift", mutate: true },
    { name: "runs unchanged bytes", mutate: false },
  ])("re-prompts durable detached gateway script approvals: $name", async ({ mutate }) => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-script-binding-"));
    const script = path.join(workdir, "script.sh");
    const command = "sh script.sh";
    try {
      fs.writeFileSync(script, "#!/bin/sh\necho approved\n");
      evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: false,
        segments: [{ resolution: null, argv: ["sh", "script.sh"] }],
        segmentAllowlistEntries: [],
        segmentSatisfiedBy: [],
      });
      hasDurableExecApprovalMock.mockReturnValue(true);
      hasExactCommandDurableExecApprovalMock.mockReturnValue(true);
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: {
          allowlist: [{ pattern: exactCommandMarker(command), source: "allow-always" }],
          file: { version: 1, agents: {} },
        },
        hostSecurity: "allowlist",
        hostAsk: "off",
        askFallback: "deny",
      });
      createExecApprovalDecisionStateMock.mockReturnValue({
        baseDecision: { timedOut: false },
        approvedByAsk: true,
        deniedReason: null,
      });
      resolveApprovalDecisionOrUndefinedMock.mockImplementation(async () => {
        if (mutate) {
          fs.writeFileSync(script, "#!/bin/sh\necho mutated\n");
        }
        return "allow-once";
      });
      buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
      runExecProcessMock.mockResolvedValue({
        session: { id: "sess-script-binding" },
        promise: Promise.resolve({
          status: "completed",
          exitCode: 0,
          timedOut: false,
          aggregated: "approved",
        }),
      });

      const result = await runGatewayAllowlist({
        command,
        workdir,
        turnSourceChannel: "feishu",
      });

      expect(result.pendingResult?.details.status).toBe("approval-pending");
      expect(resolveExecApprovalAllowedDecisionsMock).toHaveBeenCalledWith({
        ask: "off",
        allowAlwaysPersistence: { kind: "one-shot", reasons: ["no-reusable-pattern"] },
      });
      await vi.waitFor(() => {
        expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
      });
      if (mutate) {
        expect(requireSentFollowupText(0)).toContain(
          "approval script operand changed before execution",
        );
        expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
        expect(runExecProcessMock).not.toHaveBeenCalled();
      } else {
        expect(commitExecAuthorizationMock).toHaveBeenCalledOnce();
        expect(runExecProcessMock).toHaveBeenCalledOnce();
      }
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("denies a detached approved process when restart drain wins admission", async () => {
    let resolveApproval: (decision: ExecApprovalDecision) => void = () => {};
    resolveApprovalDecisionOrUndefinedMock.mockReturnValue(
      new Promise<ExecApprovalDecision>((resolve) => {
        resolveApproval = resolve;
      }),
    );
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
    });
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledOnce();
    });

    markGatewayRestartDraining();
    resolveApproval("allow-once");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.anything(),
        "Exec denied (gateway id=req-1, gateway-draining): find . -maxdepth 1",
      );
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(markBackgroundedMock).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("keeps the fire-and-forget path for channels without native approval clients", async () => {
    mockApprovedDetachedExec({
      outcome: {
        status: "completed",
        exitCode: 0,
        timedOut: false,
        aggregated: "done",
      },
    });

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    expect(runExecProcessMock).toHaveBeenCalledTimes(1);
  });

  it("warns detached approval followups after a supervisor timeout", async () => {
    const outcome = {
      status: "failed" as const,
      exitCode: null,
      exitReason: "overall-timeout" as const,
      timedOut: true,
      aggregated: "",
      reason: "Command timed out.",
    } satisfies ExecApprovalFollowupOutcome;
    mockApprovedDetachedExec({ outcome, sessionId: "sess-timeout" });

    const result = await runGatewayAllowlist({
      command: "side-effecting-command",
      turnSourceChannel: "feishu",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledOnce();
    });
    expect(requireSentFollowupText(0)).toContain(
      "external side effects may already have completed",
    );
    expect(requireSentFollowupText(0)).toContain("Verify the resulting state before retrying");
  });

  it("drops detached execution and follow-up when the owning run is aborted", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockRejectedValue(runAbortedApprovalError);
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
      runId: "run-aborted",
      toolCallId: "tool-aborted",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledOnce();
    });
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("drops an allowed detached execution when abort wins before consumption", async () => {
    let resolveApproval: (decision: ExecApprovalDecision) => void = () => {};
    resolveApprovalDecisionOrUndefinedMock.mockReturnValue(
      new Promise<ExecApprovalDecision>((resolve) => {
        resolveApproval = resolve;
      }),
    );
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    buildExecApprovalFollowupTargetMock.mockImplementation((value) => value);
    const abortController = new AbortController();

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "feishu",
      runId: "run-aborted-after-allow",
      toolCallId: "tool-aborted-after-allow",
      signal: abortController.signal,
    });
    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(resolveApprovalDecisionOrUndefinedMock).toHaveBeenCalledOnce();
    });

    abortController.abort();
    resolveApproval("allow-once");
    await Promise.resolve();
    await Promise.resolve();
    expect(createExecApprovalDecisionStateMock).not.toHaveBeenCalled();
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("keeps the fire-and-forget path for headless cron approval followups", async () => {
    mockApprovedDetachedExec({
      outcome: {
        status: "completed",
        exitCode: 0,
        timedOut: false,
        aggregated: "done",
      },
    });

    const result = await runGatewayAllowlist({
      command: "find . -maxdepth 1",
      turnSourceChannel: "telegram",
      approvalFollowupMode: "agent",
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    });
    expect(requireBuildFollowupTargetInput(0).direct).toBe(false);
  });

  it("returns webchat approval denials as the foreground tool result", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("deny");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: false,
      deniedReason: "user-denied",
    });

    const result = await runGatewayAllowlist({
      command: "pwd && df -h",
      turnSourceChannel: "webchat",
    });

    expect(result.pendingResult).toBeUndefined();
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: "Exec denied (gateway id=req-1, user-denied): pwd && df -h",
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
    expect(sendExecApprovalFollowupResultMock).not.toHaveBeenCalled();
  });

  it("commits an explicit foreground allow-once decision before execution", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });

    await runGatewayAllowlist({
      command: "pwd",
      turnSourceChannel: "webchat",
    });

    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "explicit-approval",
          policySnapshot: expect.any(Object),
        }),
      }),
    );
  });

  it("rejects explicit foreground allow-once when the locked policy snapshot changed", async () => {
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-once");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval changed"));

    await expect(
      runGatewayAllowlist({
        command: "pwd",
        turnSourceChannel: "webchat",
      }),
    ).rejects.toThrow("approval changed");

    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "explicit-approval",
          policySnapshot: expect.any(Object),
        }),
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("binds explicit allow-always persistence to its evaluated policy snapshot", async () => {
    const command = "sh -c 'git status'";
    const env = { PATH: "/usr/bin:/bin" };
    const authorizationPlan = await planShellAuthorization({ command, env });
    expect(authorizationPlan.ok).toBe(true);
    if (!authorizationPlan.ok) {
      throw new Error(authorizationPlan.reason);
    }
    const segments = authorizationPlan.groups.flatMap((group) =>
      group.candidates.map((candidate) => candidate.sourceSegment),
    );
    hasDurableExecApprovalMock.mockReturnValue(false);
    requiresExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments,
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [null],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "allowlist",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue("allow-always");
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: false },
      approvedByAsk: true,
      deniedReason: null,
    });
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval revoked"));

    await expect(
      runGatewayAllowlist({
        command,
        ask: "on-miss",
        env,
        turnSourceChannel: "webchat",
      }),
    ).rejects.toThrow("approval revoked");
    expect(commitExecAuthorizationMock).toHaveBeenCalledTimes(1);
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: {
          source: "explicit-approval",
          security: "allowlist",
          ask: "on-miss",
          allowlistSatisfied: false,
          policySnapshot: {
            security: "full",
            ask: "off",
            askFallback: "deny",
            autoAllowSkills: false,
            allowlistRules: [],
          },
          requireAutoAllowSkills: false,
          requireExactCommandApproval: false,
          requireDurableAllowlistApproval: false,
        },
        allowAlwaysDecision: expect.objectContaining({ kind: "patterns" }),
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("revalidates a timed-out allowlist fallback before foreground execution", async () => {
    const { command, authorizationPlan, segments, enforcedCommand } =
      await planAllowlistedNodeVersion();
    const policyPath = resolvePolicyTargetCandidatePath(segments[0]?.resolution ?? null) ?? "node";
    requiresExecApprovalMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [{ pattern: policyPath }],
      analysisOk: true,
      allowlistSatisfied: true,
      segments,
      segmentAllowlistEntries: [{ pattern: policyPath }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
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
    commitExecAuthorizationMock.mockRejectedValueOnce(new Error("approval revoked"));

    await expect(
      runGatewayAllowlist({
        command,
        ask: "always",
        turnSourceChannel: "webchat",
      }),
    ).rejects.toThrow("approval revoked");
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "ask-fallback",
          allowlistSatisfied: true,
        }),
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("binds a full-policy timeout to the current allowlist fallback plan", async () => {
    const { command, authorizationPlan, segments, enforcedCommand } =
      await planAllowlistedNodeVersion();
    const policyPath = resolvePolicyTargetCandidatePath(segments[0]?.resolution ?? null) ?? "node";
    requiresExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [{ pattern: policyPath }],
      analysisOk: true,
      allowlistSatisfied: true,
      segments,
      segmentAllowlistEntries: [{ pattern: policyPath }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    buildEnforcedShellCommandMock.mockReturnValue({
      ok: true,
      command: enforcedCommand,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "allowlist",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: false,
      deniedReason: null,
    });

    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "always",
      turnSourceChannel: "webchat",
    });

    expect(result.execCommandOverride).toBe(enforcedCommand);
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "ask-fallback",
          security: "allowlist",
          allowlistSatisfied: true,
        }),
      }),
    );
  });

  it("commits a headless allowlist timeout fallback before returning its bound plan", async () => {
    const { command, authorizationPlan, segments, enforcedCommand } =
      await planAllowlistedNodeVersion();
    const policyPath = resolvePolicyTargetCandidatePath(segments[0]?.resolution ?? null) ?? "node";
    requiresExecApprovalMock.mockReturnValue(true);
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(true);
    buildEnforcedShellCommandMock.mockReturnValue({ ok: true, command: enforcedCommand });
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [{ pattern: policyPath }],
      analysisOk: true,
      allowlistSatisfied: true,
      segments,
      segmentAllowlistEntries: [{ pattern: policyPath }],
      segmentSatisfiedBy: ["allowlist"],
      authorizationPlan,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "allowlist",
    });
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: false,
      deniedReason: null,
    });

    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "always",
      trigger: "cron",
    });

    expect(result.execCommandOverride).toBe(enforcedCommand);
    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "ask-fallback",
          security: "allowlist",
          allowlistSatisfied: true,
        }),
      }),
    );
  });

  it("denies allowlist timeout fallback without an enforceable plan", async () => {
    requiresExecApprovalMock.mockReturnValue(true);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [{ pattern: "/usr/bin/rg" }],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [{ resolution: null, argv: ["rg", "needle"] }],
      segmentAllowlistEntries: [{ pattern: "/usr/bin/rg" }],
      segmentSatisfiedBy: ["allowlist"],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "allowlist",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: false,
      deniedReason: null,
    });

    const result = await runGatewayAllowlist({
      command: "rg needle",
      security: "full",
      ask: "always",
      turnSourceChannel: "webchat",
    });

    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("approval-timeout: execution-plan-miss"),
      }),
    );
    expect(commitExecAuthorizationMock).not.toHaveBeenCalled();
  });

  it("revalidates a full timeout fallback without reapplying always-ask", async () => {
    requiresExecApprovalMock.mockReturnValue(true);
    hasDurableExecApprovalMock.mockReturnValue(false);
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [{ resolution: null, argv: ["pwd"] }],
      segmentAllowlistEntries: [],
      segmentSatisfiedBy: [],
    });
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

    await runGatewayAllowlist({
      command: "pwd",
      security: "full",
      ask: "always",
      turnSourceChannel: "webchat",
    });

    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          source: "ask-fallback",
          ask: "always",
          allowlistSatisfied: false,
        }),
      }),
    );
  });

  it("revalidates an unavailable inline timeout fallback", async () => {
    requiresExecApprovalMock.mockReturnValue(true);
    shouldResolveExecApprovalUnavailableInlineMock.mockReturnValue(true);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "always",
      askFallback: "full",
    });

    await runGatewayAllowlist({
      command: "pwd",
      security: "full",
      ask: "always",
      trigger: "cron",
    });

    expect(commitExecAuthorizationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ source: "ask-fallback" }),
      }),
    );
  });

  it("denies timed-out inline-eval requests instead of auto-running them", async () => {
    const result = await runTimedOutStrictInlineEval({
      security: "full",
      askFallback: "full",
      approvedByAsk: true,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "req-1",
          sessionKey: "agent:main:main",
          turnSourceChannel: undefined,
          direct: false,
        }),
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("denies allowlist timeout fallback for strict inline-eval commands", async () => {
    const result = await runTimedOutStrictInlineEval({
      security: "allowlist",
      askFallback: "allowlist",
      approvedByAsk: false,
    });

    expect(result.pendingResult?.details.status).toBe("approval-pending");
    await vi.waitFor(() => {
      expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "req-1",
          sessionKey: "agent:main:main",
          turnSourceChannel: undefined,
          direct: false,
        }),
        "Exec denied (gateway id=req-1, approval-timeout): python3 -c 'print(1)'",
      );
    });
    expect(sendExecApprovalFollowupResultMock).toHaveBeenCalledTimes(1);
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });

  it("denies allowlist timeout fallback when the execution plan cannot be enforced", async () => {
    const command = "ls *.ts";
    await configurePlanBackedCommand({
      command,
      allowlistSatisfied: true,
      requiresApproval: false,
      satisfiedBy: "allowlist",
      segmentAllowlistEntries: [{ pattern: "/usr/bin/ls", source: "allow-always" }],
      hostAsk: "on-miss",
      askFallback: "allowlist",
    });
    resolveApprovalDecisionOrUndefinedMock.mockResolvedValue(null);
    createExecApprovalDecisionStateMock.mockReturnValue({
      baseDecision: { timedOut: true },
      approvedByAsk: true,
      deniedReason: null,
    });
    enforceStrictInlineEvalApprovalBoundaryMock.mockImplementation((value) =>
      value.baseDecision.timedOut && value.requiresAutoReviewHumanApproval
        ? { approvedByAsk: false, deniedReason: "approval-timeout" }
        : { approvedByAsk: value.approvedByAsk, deniedReason: value.deniedReason },
    );

    const result = await runGatewayAllowlist({
      command,
      ask: "on-miss",
      autoReview: false,
      turnSourceChannel: "webchat",
    });

    expect(enforceStrictInlineEvalApprovalBoundaryMock).toHaveBeenCalledWith(
      expect.objectContaining({ requiresAutoReviewHumanApproval: true }),
    );
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: `Exec denied (gateway id=req-1, approval-timeout): ${command}`,
      }),
    );
    expect(runExecProcessMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
