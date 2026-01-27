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
  let previousUserProfile: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-test-"));
    process.env.HOME = tempDir;
    // Windows uses USERPROFILE for os.homedir()
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    vi.resetAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-test-bin-"));
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

  it("honors ask=off for elevated gateway exec without prompting", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const calls: string[] = [];
    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      return { ok: true };
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      ask: "off",
      security: "full",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call3", { command: "echo ok", elevated: true });
    expect(result.details.status).toBe("completed");
    expect(calls).not.toContain("exec.approval.request");
  });

  it("requires approval for elevated ask when allowlist misses", async () => {
    const { callGatewayTool } = await import("./tools/gateway.js");
    const calls: string[] = [];
    let resolveApproval: (() => void) | undefined;
    const approvalSeen = new Promise<void>((resolve) => {
      resolveApproval = resolve;
    });

    vi.mocked(callGatewayTool).mockImplementation(async (method) => {
      calls.push(method);
      if (method === "exec.approval.request") {
        resolveApproval?.();
        return { decision: "deny" };
      }
      return { ok: true };
    });

    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({
      ask: "on-miss",
      security: "allowlist",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });

    const result = await tool.execute("call4", { command: "echo ok", elevated: true });
    expect(result.details.status).toBe("approval-pending");
    await approvalSeen;
    expect(calls).toContain("exec.approval.request");
  });
});
