import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    { nodeId: "node-1", commands: ["system.run"], platform: "darwin" },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

describe("exec approvals", () => {
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HOME;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    vi.resetAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  });

  it("reuses approval id as the node runId", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    let invokeParams: unknown;
    let resolveInvoke: (() => void) | undefined;
    const invokeSeen = new Promise<void>((resolve) => {
      resolveInvoke = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
      if (method === "exec.approval.request") {
        return { decision: "allow-once" };
      }
      if (method === "node.invoke") {
        invokeParams = params;
        resolveInvoke?.();
        return { ok: true };
      }
      return { ok: true };
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "node",
      ask: "always",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call1", { command: "ls -la" });
    expect(result.details.status).toBe("approval-pending");
    const approvalId = (result.details as { approvalId: string }).approvalId;

    await invokeSeen;

    const runId = (invokeParams as { params?: { runId?: string } } | undefined)?.params?.runId;
    expect(runId).toBe(approvalId);
  });

  it("skips approval when node allowlist is satisfied", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-test-bin-"));
    const binDir = path.join(tempDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const exeName = process.platform === "win32" ? "tool.cmd" : "tool";
    const exePath = path.join(binDir, exeName);
    await fs.writeFile(exePath, "");
    if (process.platform !== "win32") {
      await fs.chmod(exePath, 0o755);
    }
    const approvalsFile = {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
      agents: {
        main: {
          allowlist: [{ pattern: exePath }],
        },
      },
    };

    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      if (method === "exec.approvals.node.get") {
        return { file: approvalsFile };
      }
      if (method === "node.invoke") {
        return { payload: { success: true, stdout: "ok" } };
      }
      if (method === "exec.approval.request") {
        return { decision: "allow-once" };
      }
      return { ok: true };
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      host: "node",
      ask: "on-miss",
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call2", {
      command: `"${exePath}" --help`,
    });
    expect(result.details.status).toBe("completed");
    expect(calls).toContain("exec.approvals.node.get");
    expect(calls).toContain("node.invoke");
    expect(calls).not.toContain("exec.approval.request");
  });
});
