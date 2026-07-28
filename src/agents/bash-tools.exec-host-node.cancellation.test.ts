import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { createDeferred } from "../test-utils/deferred.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";

type NodeApprovalPolicy = Awaited<
  ReturnType<typeof import("./bash-tools.exec-host-shared.js").resolveExecHostApprovalContext>
>;

const mocks = vi.hoisted(() => ({
  analyzeNodeApprovalRequirement: vi.fn(),
  callGatewayTool: vi.fn(
    async (
      _method: string,
      _options: unknown,
      _params?: { command?: string },
      _extra?: { scopes?: string[]; signal?: AbortSignal },
    ) => ({ payload: { success: true, stdout: "ok", exitCode: 0 } }),
  ),
  invokeNodeSystemRunDirect: vi.fn(),
  registerNodeApproval: vi.fn(async () => undefined),
  requiresExecApproval: vi.fn(),
  resolveExecHostApprovalContext: vi.fn(),
}));

vi.mock("../infra/exec-approvals.js", () => ({
  maxAsk: (left: ExecAsk, right: ExecAsk) => {
    const priority: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
    return priority[left] >= priority[right] ? left : right;
  },
  requiresExecApproval: mocks.requiresExecApproval,
  resolveExecApprovalAllowedDecisions: vi.fn(() => ["allow-once", "allow-always", "deny"]),
  resolveExecApprovalUnavailableDecisions: vi.fn(() => []),
}));

vi.mock("../infra/exec-auto-review.js", () => ({
  defaultExecAutoReviewer: vi.fn(),
  resolveExecAutoReviewDecision: vi.fn(async (reviewer: ExecAutoReviewer, input) =>
    reviewer(input),
  ),
}));

vi.mock("./bash-tools.exec-approval-request.js", () => ({
  buildExecApprovalRequesterContext: vi.fn(() => ({})),
  buildExecApprovalTurnSourceContext: vi.fn(() => ({})),
  registerExecApprovalRequestForHostOrThrow: mocks.registerNodeApproval,
}));

vi.mock("./bash-tools.exec-host-node-phases.js", () => ({
  analyzeNodeApprovalRequirement: mocks.analyzeNodeApprovalRequirement,
  buildNodeSystemRunInvoke: vi.fn(() => ({ command: "system.run" })),
  formatNodeRunToolResult: vi.fn(() => ({
    content: [],
    details: { status: "completed" },
  })),
  invokeNodeSystemRunDirect: mocks.invokeNodeSystemRunDirect,
  prepareNodeSystemRun: vi.fn(async () => ({
    plan: {},
    argv: ["tool", "--version"],
    rawCommand: "tool --version",
    transportRawCommand: "tool --version",
    cwd: "/tmp/work",
    agentId: "agent",
    sessionKey: "agent:main:main",
  })),
  resolveNodeExecutionTarget: vi.fn(async () => ({
    nodeId: "node-1",
    argv: ["tool", "--version"],
    invokeTimeoutMs: 30_000,
    supportsSystemRunPrepare: true,
  })),
  shouldSkipNodeApprovalPrepare: vi.fn(
    (policy: { hostSecurity: ExecSecurity; hostAsk: ExecAsk }) =>
      policy.hostSecurity === "full" && policy.hostAsk === "off",
  ),
}));

vi.mock("./bash-tools.exec-host-shared.js", () => ({
  resolveExecHostApprovalContext: mocks.resolveExecHostApprovalContext,
}));

vi.mock("./bash-process-registry.js", () => ({ tail: vi.fn((text: string) => text) }));

vi.mock("./bash-tools.exec-runtime.js", () => ({
  DEFAULT_NOTIFY_TAIL_CHARS: 1_000,
  createApprovalSlug: vi.fn(() => "approval"),
  normalizeNotifyOutput: vi.fn((text: string) => text),
}));

vi.mock("./embedded-agent-runner/run/abortable.js", () => ({
  abortable: vi.fn(async (_signal: AbortSignal, pending: Promise<unknown>) => pending),
}));

vi.mock("./tools/gateway.js", () => ({ callGatewayTool: mocks.callGatewayTool }));

import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";

function createPolicy(security: ExecSecurity, ask: ExecAsk): NodeApprovalPolicy {
  return {
    approvals: {
      path: "",
      socketPath: "",
      token: "",
      defaults: { security, ask, askFallback: "deny", autoAllowSkills: false },
      agent: { security, ask, askFallback: "deny", autoAllowSkills: false },
      agentSources: { security: null, ask: null, askFallback: null },
      allowlist: [],
      file: { version: 1, agents: {} },
    },
    hostSecurity: security,
    hostAsk: ask,
    askFallback: "deny",
  };
}

function createRequest(overrides: Partial<ExecuteNodeHostCommandParams>) {
  return {
    command: "tool --version",
    workdir: "/tmp/work",
    env: {},
    security: "full",
    ask: "off",
    defaultTimeoutSec: 30,
    approvalRunningNoticeMs: 0,
    warnings: [],
    agentId: "agent",
    sessionKey: "agent:main:main",
    ...overrides,
  } satisfies ExecuteNodeHostCommandParams;
}

describe("node-host dispatch cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveExecHostApprovalContext.mockReset();
    mocks.requiresExecApproval.mockImplementation(({ ask }: { ask: ExecAsk }) => ask !== "off");
    mocks.analyzeNodeApprovalRequirement.mockResolvedValue({
      analysisOk: true,
      allowlistSatisfied: false,
      durableApprovalSatisfied: false,
      nodeApprovalPolicyKnown: true,
      nodeSecurity: "allowlist",
      nodeAsk: "on-miss",
      inlineEvalHit: null,
      requiresSecurityAuditSuppressionApproval: false,
      autoReviewArgv: ["tool", "--version"],
      allowAlwaysPersistence: { kind: "patterns", patterns: [] },
    });
    mocks.invokeNodeSystemRunDirect.mockResolvedValue({
      content: [],
      details: { status: "completed" },
    });
  });

  it.each([
    { name: "direct full/off", security: "full", ask: "off", autoReview: false },
    {
      name: "auto-reviewed allowlist",
      security: "allowlist",
      ask: "on-miss",
      autoReview: true,
    },
  ] as const)("never dispatches $name after cancellation during final policy", async (scenario) => {
    const controller = new AbortController();
    const reason = new Error("cancelled during final node dispatch policy");
    const policy = createPolicy(scenario.security, scenario.ask);
    const checkpoint = createDeferred<NodeApprovalPolicy>();
    mocks.resolveExecHostApprovalContext
      .mockResolvedValueOnce(policy)
      .mockReturnValueOnce(checkpoint.promise);
    const reviewer: ExecAutoReviewer = async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe command",
    });

    const result = executeNodeHostCommand(
      createRequest({
        security: scenario.security,
        ask: scenario.ask,
        autoReview: scenario.autoReview,
        autoReviewer: reviewer,
        signal: controller.signal,
      }),
    );

    await vi.waitFor(() => expect(mocks.resolveExecHostApprovalContext).toHaveBeenCalledTimes(2));
    controller.abort(reason);
    checkpoint.resolve(policy);

    await expect(result).rejects.toBe(reason);
    expect(mocks.invokeNodeSystemRunDirect).not.toHaveBeenCalled();
    expect(
      mocks.callGatewayTool.mock.calls.some(
        ([method, , params]) => method === "node.invoke" && params?.command === "system.run",
      ),
    ).toBe(false);
    expect(mocks.registerNodeApproval).toHaveBeenCalledTimes(scenario.autoReview ? 1 : 0);
  });

  it("forwards cancellation without removing auto-reviewed execution scopes", async () => {
    const controller = new AbortController();
    mocks.resolveExecHostApprovalContext.mockResolvedValue(createPolicy("allowlist", "on-miss"));
    const reviewer: ExecAutoReviewer = async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe command",
    });

    await executeNodeHostCommand(
      createRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer: reviewer,
        signal: controller.signal,
      }),
    );

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 30_000 },
      expect.objectContaining({ command: "system.run" }),
      { scopes: ["operator.write", "operator.approvals"], signal: controller.signal },
    );
  });

  it("forwards cancellation for prepared commands that need no approval", async () => {
    const controller = new AbortController();
    mocks.resolveExecHostApprovalContext.mockResolvedValue(createPolicy("allowlist", "off"));

    await executeNodeHostCommand(
      createRequest({
        security: "allowlist",
        ask: "off",
        signal: controller.signal,
      }),
    );

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 30_000 },
      expect.objectContaining({ command: "system.run" }),
      { signal: controller.signal },
    );
    expect(mocks.registerNodeApproval).not.toHaveBeenCalled();
  });
});
