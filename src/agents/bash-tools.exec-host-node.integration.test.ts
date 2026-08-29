import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { readExecApprovalsSnapshot, saveExecApprovals } from "../infra/exec-approvals.js";
import { handleInvoke } from "../node-host/invoke.js";
import type { Deferred } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: rpc }));
vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: async () => [
    {
      nodeId: "node-1",
      connected: true,
      platform: "darwin",
      commands: ["system.run", "system.run.prepare"],
    },
  ],
  resolveNodeIdFromList: () => "node-1",
}));

let state: OpenClawTestState;
let invokeCount: number;
let afterPrepare: () => Promise<void>;
let request: ExecuteNodeHostCommandParams & { workdir: string };
let resolveDecision: (result: { decision: string }) => void;
let decisionEntered: Deferred;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "node-exec-policy" });
  await state.writeConfig({});
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
  invokeCount = 0;
  afterPrepare = async () => {};
  request = {
    command: "/usr/bin/printf node-policy-proof",
    workdir: await fs.realpath(state.root),
    env: {},
    sessionKey: "agent:main:node-proof",
    agentId: "main",
    security: "full",
    ask: "off",
    defaultTimeoutSec: 5,
    approvalRunningNoticeMs: 1000,
    warnings: [],
    turnSourceChannel: "webchat",
  };
  const decision = new Promise<{ decision: string }>((resolve) => {
    resolveDecision = resolve;
  });
  decisionEntered = createDeferred();
  rpc.mockReset().mockImplementation(async (method, _options, params) => {
    if (method === "exec.approvals.node.get") {
      return readExecApprovalsSnapshot();
    }
    if (method === "exec.approval.request") {
      return { id: params.id, expiresAtMs: Date.now() + 60000 };
    }
    if (method === "exec.approval.waitDecision") {
      decisionEntered.resolve();
      return await decision;
    }
    if (method !== "node.invoke") {
      throw new Error(`Unexpected RPC: ${method}`);
    }
    if (params.command === "system.run") {
      invokeCount += 1;
    }
    let response:
      | { ok: boolean; payloadJSON?: string; error?: { code?: string; message?: string } }
      | undefined;
    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: params.command,
        paramsJSON: JSON.stringify(params.params),
      },
      {
        async request<T>(name: string, value?: unknown): Promise<T> {
          if (name === "node.invoke.result") {
            response = value as typeof response;
          }
          return {} as T;
        },
      },
      { current: async () => [] },
    );
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error?.message ?? "Node rejected invocation"), {
        details: { nodeError: response?.error },
      });
    }
    if (params.command === "system.run.prepare") {
      await afterPrepare();
    }
    return { payload: JSON.parse(response.payloadJSON ?? "{}") };
  });
});
afterEach(async () => {
  await state.cleanup();
});

it("denies caller allowlist/off misses before dispatch to a permissive node", async () => {
  await expect(executeNodeHostCommand({ ...request, security: "allowlist" })).rejects.toThrow(
    "allowlist",
  );
  expect(invokeCount).toBe(0);
});

it.each(["allow-once", "allow-always"])(
  "keeps node approval %s inside the originating tool lifetime",
  async (decision) => {
    let completed = false;
    const result = executeNodeHostCommand({
      ...request,
      ask: "on-miss",
      security: "allowlist",
    }).finally(() => {
      completed = true;
    });
    await Promise.race([decisionEntered.promise, result]);
    expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
    expect(completed).toBe(false);
    resolveDecision({ decision });
    expect((await result).details).toMatchObject({
      status: "completed",
      aggregated: "node-policy-proof",
    });
    expect(invokeCount).toBe(1);
  },
);

it("prompts for target ask=always even when the caller is full/off", async () => {
  setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "always" } } });
  const result = executeNodeHostCommand(request);
  await Promise.race([decisionEntered.promise, result]);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
  expect(invokeCount).toBe(0);
  resolveDecision({ decision: "allow-once" });
  expect((await result).details.status).toBe("completed");
});

it("reports target policy denial as not executed", async () => {
  setRuntimeConfigSnapshot({ tools: { exec: { security: "deny", ask: "off" } } });
  const { dispatchNodeSystemRun, buildNodeSystemRunInvoke, resolveNodeExecutionTarget } =
    await import("./bash-tools.exec-host-node-phases.js");
  const target = await resolveNodeExecutionTarget(request);
  const result = await dispatchNodeSystemRun({
    request,
    target,
    invoke: buildNodeSystemRunInvoke({
      target,
      command: target.argv,
      rawCommand: request.command,
      cwd: request.workdir,
      agentId: request.agentId,
      sessionKey: request.sessionKey,
    }),
  });
  expect(result.details).toMatchObject({ status: "failed", failureKind: "policy-denied" });
  expect(result.content).toEqual([
    expect.objectContaining({
      text: expect.not.stringMatching(/may have executed|request approval/),
    }),
  ]);
});

it("does not dispatch a late approval after cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("originating turn closed");
  const execution = executeNodeHostCommand({
    ...request,
    security: "allowlist",
    ask: "on-miss",
    signal: controller.signal,
  });
  const drained = execution.catch(() => undefined);
  try {
    await Promise.race([decisionEntered.promise, execution]);
    expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
    controller.abort(reason);
    resolveDecision({ decision: "allow-once" });
    await expect(execution).rejects.toBe(reason);
    expect(invokeCount).toBe(0);
  } finally {
    controller.abort(reason);
    resolveDecision({ decision: "deny" });
    await drained;
  }
});

it("preserves a target deny introduced while approval was pending", async () => {
  const execution = executeNodeHostCommand({
    ...request,
    security: "allowlist",
    ask: "on-miss",
  });
  await Promise.race([decisionEntered.promise, execution]);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
  setRuntimeConfigSnapshot({ tools: { exec: { security: "deny", ask: "off" } } });
  resolveDecision({ decision: "allow-once" });
  expect((await execution).details).toMatchObject({
    status: "failed",
    failureKind: "policy-denied",
  });
});

it("executes full/off through a symlink cwd using the prepared canonical directory", async () => {
  const targetDir = path.join(request.workdir, "target");
  const otherDir = path.join(request.workdir, "other");
  const link = path.join(request.workdir, "link");
  await fs.mkdir(targetDir);
  await fs.mkdir(otherDir);
  await fs.symlink(targetDir, link, "dir");
  afterPrepare = async () => {
    await fs.unlink(link);
    await fs.symlink(otherDir, link, "dir");
  };
  const result = await executeNodeHostCommand({
    ...request,
    command: "/bin/pwd -P",
    workdir: link,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: `${targetDir}\n` });
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.request")).toBe(false);
});

it.skipIf(process.platform !== "darwin")(
  "executes full/off in the actual macOS /tmp alias",
  async () => {
    const result = await executeNodeHostCommand({
      ...request,
      command: "/bin/pwd -P",
      workdir: "/tmp",
    });
    expect(result.details).toMatchObject({
      status: "completed",
      aggregated: `${await fs.realpath("/tmp")}\n`,
    });
  },
);

it("executes full/off inline Node without approval script preflight", async () => {
  const result = await executeNodeHostCommand({
    ...request,
    command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("inline-proof")'`,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: "inline-proof" });
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.request")).toBe(false);
});

it("does not bind a full/off script to approval-time contents", async () => {
  const script = path.join(request.workdir, "script.cjs");
  await fs.writeFile(script, 'process.stdout.write("before")');
  afterPrepare = async () => {
    await fs.writeFile(script, 'process.stdout.write("after")');
  };
  const result = await executeNodeHostCommand({
    ...request,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: "after" });
});

it.each([
  { runtime: "Node", command: [process.execPath, "-e", 'process.stdout.write("inline")'] },
  { runtime: "Python", command: ["python3", "-c", 'print("inline")'] },
])("prepares direct inline $runtime only without approval binding", async ({ command }) => {
  const params = { command, cwd: request.workdir, security: "full", ask: "off" };
  const prepare = (ask = "off") =>
    rpc("node.invoke", {}, { command: "system.run.prepare", params: { ...params, ask } });
  const result = await prepare();
  expect(result.payload.plan.argv).toEqual(command);
  expect(result.payload.plan.mutableFileOperand).toBeUndefined();
  await expect(prepare("always")).rejects.toThrow("cannot safely bind");
  setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "always" } } });
  await expect(prepare()).rejects.toThrow("cannot safely bind");
  expect(invokeCount).toBe(0);
});

it.each(["caller", "node", "approvals"] as const)(
  "keeps approval cwd binding for restrictive %s policy",
  async (owner) => {
    const link = path.join(request.workdir, "approval-link");
    await fs.symlink(request.workdir, link, "dir");
    if (owner === "node") {
      setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "always" } } });
    } else if (owner === "approvals") {
      saveExecApprovals({ version: 1, defaults: { security: "full", ask: "always" } });
    }
    await expect(
      executeNodeHostCommand({
        ...request,
        workdir: link,
        ...(owner === "caller" ? { ask: "always" as const } : {}),
      }),
    ).rejects.toThrow("canonical cwd");
    expect(invokeCount).toBe(0);
  },
);

it.each(["deny", "ask"] as const)(
  "refuses %s tightening after ordinary preparation",
  async (policy) => {
    afterPrepare = async () => {
      setRuntimeConfigSnapshot({
        tools: {
          exec: {
            security: policy === "deny" ? "deny" : "full",
            ask: policy === "ask" ? "always" : "off",
          },
        },
      });
    };
    const result = await executeNodeHostCommand(request);
    expect(result.details).toMatchObject({ status: "failed", failureKind: "policy-denied" });
  },
);

it("refuses a cwd replaced by a symlink after approval preparation", async () => {
  const approved = path.join(request.workdir, "approved");
  const moved = path.join(request.workdir, "moved");
  await fs.mkdir(approved);
  const execution = executeNodeHostCommand({ ...request, workdir: approved, ask: "always" });
  await Promise.race([decisionEntered.promise, execution]);
  expect(rpc.mock.calls.some(([method]) => method === "exec.approval.waitDecision")).toBe(true);
  await fs.rename(approved, moved);
  await fs.symlink(moved, approved, "dir");
  resolveDecision({ decision: "allow-once" });
  const result = await execution;
  expect(result.details).toMatchObject({ status: "failed", failureKind: "policy-denied" });
  expect(result.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("canonical cwd") }),
  ]);
});
