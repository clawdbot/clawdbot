import fs from "node:fs/promises";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  resolveExecApprovalsFromFile,
  type ExecAllowlistEntry,
  type ExecAsk,
  type ExecSecurity,
} from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import type { PreparedRunExecPolicy } from "../infra/system-run-approval-context.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";
import * as execHostShared from "./bash-tools.exec-host-shared.js";

type NodeApprovalPolicy = Awaited<ReturnType<typeof execHostShared.resolveExecHostApprovalContext>>;
type GatewayCallParams = {
  command?: string;
  params?: Parameters<typeof buildSystemRunPreparePayload>[0];
  id?: string;
};
type GatewayCallExtra = Parameters<typeof import("./tools/gateway.js").callGatewayTool>[3];

const callGatewayToolMock = vi.hoisted(() =>
  vi.fn<
    (
      method: string,
      options: unknown,
      params?: GatewayCallParams,
      extra?: GatewayCallExtra,
    ) => Promise<unknown>
  >(),
);

vi.mock("./tools/gateway.js", () => ({ callGatewayTool: callGatewayToolMock }));
vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: async () => [
    {
      nodeId: "node-1",
      connected: true,
      platform: process.platform,
      commands: ["system.run", "system.run.prepare"],
    },
  ],
  resolveNodeIdFromList: () => "node-1",
}));

function createPolicy(security: ExecSecurity, ask: ExecAsk): NodeApprovalPolicy {
  return {
    approvals: resolveExecApprovalsFromFile({
      file: {
        version: 1,
        defaults: { security, ask, askFallback: "deny", autoAllowSkills: false },
        agents: {},
      },
      agentId: "main",
    }),
    hostSecurity: security,
    hostAsk: ask,
    askFallback: "deny",
  };
}

let executable: string;
let workdir: string;
let nodePolicy: PreparedRunExecPolicy;
let nodeAllowlist: ExecAllowlistEntry[];
let resolvePolicy: MockInstance<typeof execHostShared.resolveExecHostApprovalContext>;

function createRequest(overrides: Partial<ExecuteNodeHostCommandParams>) {
  return {
    command: formatExecCommand([executable, "--version"]),
    workdir,
    env: {},
    security: "full",
    ask: "off",
    defaultTimeoutSec: 30,
    approvalRunningNoticeMs: 0,
    warnings: [],
    agentId: "main",
    sessionKey: "agent:main:main",
    ...overrides,
  } satisfies ExecuteNodeHostCommandParams;
}

describe("node-host dispatch cancellation", () => {
  beforeAll(async () => {
    executable = await fs.realpath(process.execPath);
    workdir = await fs.realpath(process.cwd());
  });

  beforeEach(() => {
    nodePolicy = { security: "full", ask: "off" };
    nodeAllowlist = [];
    resolvePolicy = vi.spyOn(execHostShared, "resolveExecHostApprovalContext");
    callGatewayToolMock.mockReset().mockImplementation(async (method, _options, params) => {
      if (method === "exec.approvals.node.get") {
        return {
          file: {
            version: 1,
            defaults: nodePolicy,
            agents: { main: { allowlist: nodeAllowlist } },
          },
        };
      }
      if (method === "exec.approval.request") {
        return { status: "accepted", id: params?.id };
      }
      if (method === "exec.approval.resolve") {
        return { ok: true };
      }
      if (method === "node.invoke" && params?.command === "system.run.prepare") {
        if (!params.params) {
          throw new Error("expected system.run.prepare parameters");
        }
        const prepared = buildSystemRunPreparePayload(params.params);
        return { payload: { ...prepared.payload, execPolicy: nodePolicy } };
      }
      if (method === "node.invoke" && params?.command === "system.run") {
        return { payload: { success: true, stdout: "ok", exitCode: 0 } };
      }
      throw new Error(`unexpected gateway call: ${method} ${params?.command ?? ""}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: "prepared full/off", security: "full", ask: "off", autoReview: false },
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
    nodePolicy = { security: scenario.security, ask: scenario.ask };
    const checkpoint = createDeferred<NodeApprovalPolicy>();
    const policyEntered = createDeferred();
    resolvePolicy.mockResolvedValueOnce(policy).mockImplementationOnce(() => {
      policyEntered.resolve();
      return checkpoint.promise;
    });
    const reviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe command",
    }));

    const result = executeNodeHostCommand(
      createRequest({
        security: scenario.security,
        ask: scenario.ask,
        autoReview: scenario.autoReview,
        autoReviewer: reviewer,
        signal: controller.signal,
      }),
    );
    // Observe early fixture failures immediately and drain blocked work before restoring spies.
    const drained = result.catch(() => undefined);
    try {
      await Promise.race([policyEntered.promise, result]);
      expect(resolvePolicy).toHaveBeenCalledTimes(2);
      controller.abort(reason);
      checkpoint.resolve(policy);

      await expect(result).rejects.toBe(reason);
      expect(
        callGatewayToolMock.mock.calls.some(
          ([method, , params]) => method === "node.invoke" && params?.command === "system.run",
        ),
      ).toBe(false);
      expect(
        callGatewayToolMock.mock.calls.filter(([method]) => method === "exec.approval.request"),
      ).toHaveLength(scenario.autoReview ? 1 : 0);
      expect(reviewer).toHaveBeenCalledTimes(scenario.autoReview ? 1 : 0);
    } finally {
      controller.abort(reason);
      checkpoint.resolve(policy);
      await drained;
    }
  });

  it("forwards cancellation without removing auto-reviewed execution scopes", async () => {
    const controller = new AbortController();
    resolvePolicy.mockResolvedValue(createPolicy("allowlist", "on-miss"));
    nodePolicy = { security: "allowlist", ask: "on-miss" };
    const reviewer: ExecAutoReviewer = async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "safe command",
    });

    const result = await executeNodeHostCommand(
      createRequest({
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
        autoReviewer: reviewer,
        signal: controller.signal,
      }),
    );

    expect(result.details).toMatchObject({ status: "completed", exitCode: 0, aggregated: "ok" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 40_000 },
      expect.objectContaining({ command: "system.run" }),
      { scopes: ["operator.write", "operator.approvals"], signal: controller.signal },
    );
  });

  it("forwards cancellation for prepared commands that need no approval", async () => {
    const controller = new AbortController();
    resolvePolicy.mockResolvedValue(createPolicy("allowlist", "off"));
    nodePolicy = { security: "allowlist", ask: "off" };
    nodeAllowlist = [{ pattern: executable }];

    const result = await executeNodeHostCommand(
      createRequest({
        security: "allowlist",
        ask: "off",
        signal: controller.signal,
      }),
    );

    expect(result.details).toMatchObject({ status: "completed", exitCode: 0, aggregated: "ok" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 40_000 },
      expect.objectContaining({ command: "system.run" }),
      { signal: controller.signal },
    );
    expect(
      callGatewayToolMock.mock.calls.filter(([method]) => method === "exec.approval.request"),
    ).toHaveLength(0);
  });
});
