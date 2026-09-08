import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate SQLite in-memory database for pure tool wrapper testing in test environments
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: vi.fn(() => ({
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({})),
      all: vi.fn(() => []),
      run: vi.fn(() => ({})),
    })),
    close: vi.fn(),
  })),
  requireNodeSqlite: vi.fn(() => ({
    DatabaseSync: class {
      exec() {}
      prepare() {
        return { get: () => ({}), all: () => [], run: () => ({}) };
      }
      close() {}
    },
  })),
}));

import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import {
  operatorConfigureGateway,
  operatorResetGateway,
} from "./local-security-gateway-operator.js";
import {
  calculateActionDigest,
  evaluateLocalSecurityGateway,
  getSecurityAuditLogs,
  isApprovalValidForParams,
  triggerEmergencyStop,
  type PendingApprovalRequest,
} from "./local-security-gateway.js";

function createMockTool(name: string, impl = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] })): AnyAgentTool {
  return {
    name,
    description: `Mock tool for ${name}`,
    execute: impl,
  };
}

describe("Local Security Gateway Real Behavior & Adversarial Tests", () => {
  beforeEach(() => {
    operatorResetGateway();
  });

  afterEach(() => {
    operatorResetGateway();
  });

  it("Test A — Concurrent approval isolation: approving A does NOT approve concurrent B", async () => {
    const pendingRequests: PendingApprovalRequest[] = [];

    operatorConfigureGateway({
      approvalHandler: (request: PendingApprovalRequest) => {
        pendingRequests.push(request);
        // Do not immediately resolve; wait in queue
      },
    });

    const toolA = wrapToolWithBeforeToolCallHook(createMockTool("write_file", vi.fn().mockResolvedValue("A_DONE")));
    const toolB = wrapToolWithBeforeToolCallHook(createMockTool("write_file", vi.fn().mockResolvedValue("B_DONE")));

    const promiseA = toolA.execute("call-A", { path: "a.txt", content: "AAA" });
    const promiseB = toolB.execute("call-B", { path: "b.txt", content: "BBB" });

    // Wait for both to be queued
    await new Promise((r) => setTimeout(r, 50));
    expect(pendingRequests).toHaveLength(2);

    // Approve ONLY request A
    const reqA = pendingRequests.find((r) => (r.params as any).path === "a.txt")!;
    reqA.resolve("APPROVAL_GRANTED");

    const resultA = await promiseA;
    expect(resultA).toBe("A_DONE");

    // Request B must still be pending/unresolved until separately approved or timed out
    const reqB = pendingRequests.find((r) => (r.params as any).path === "b.txt")!;
    reqB.resolve("REJECTED_USER");

    const resultB = (await promiseB) as any;
    expect(resultB.details?.deniedReason).toBe("security-gateway-rejected");
  });

  it("Test B — Parameter mutation post-approval invalidates approval", () => {
    const originalParams = { path: "a.txt", content: "original data" };
    const mutatedParams = { path: "a.txt", content: "MUTATED PAYLOAD" };

    const digest = calculateActionDigest("write_file", originalParams);
    const mockReq: PendingApprovalRequest = {
      id: "req-mut",
      toolName: "write_file",
      params: originalParams,
      digest,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
      resolve: () => {},
      timer: setTimeout(() => {}, 10_000),
    };

    // Digest validation on original parameters passes
    expect(isApprovalValidForParams(mockReq, "write_file", originalParams)).toBe(true);

    // Digest validation on mutated parameters FAILS
    expect(isApprovalValidForParams(mockReq, "write_file", mutatedParams)).toBe(false);

    clearTimeout(mockReq.timer);
  });

  it("Test C — Emergency stop race: approved action with delayed dispatch is BLOCKED when emergency stop triggers", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "should not execute" }] });
    const rawTool = createMockTool("write_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    let resolveApproval!: () => void;
    const approvalWait = new Promise<void>((r) => { resolveApproval = r; });

    operatorConfigureGateway({
      approvalHandler: async (request: PendingApprovalRequest) => {
        await approvalWait;
        return "APPROVAL_GRANTED";
      },
    });

    const execPromise = wrappedTool.execute("call-race", { path: "delay.txt", content: "x" });

    // Grant approval
    resolveApproval();

    // Trigger emergency stop concurrently before dispatch completes
    triggerEmergencyStop("Race test emergency stop");

    const result = (await execPromise) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-rejected");
    expect(result.content[0]?.text).toContain("Emergency stop");
  });

  it("Test D — Expired approval is rejected", async () => {
    operatorConfigureGateway({
      approvalTimeoutMs: 20, // 20ms timeout
      approvalHandler: () => {
        // Leave pending until timeout
      },
    });

    const rawTool = createMockTool("write_file");
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = (await wrappedTool.execute("call-exp", { path: "expired.txt" })) as any;

    expect(result.details?.deniedReason).toBe("security-gateway-rejected");
    expect(result.content[0]?.text).toContain("Action rejected or expired");
  });

  it("Test E — Audit privacy: secrets, sensitive paths, and raw exceptions are redacted from audit logs", async () => {
    const sensitivePath = "C:\\Users\\Administrator\\.ssh\\id_rsa";
    const secretKey = "sk-proj-secret1234567890abcdef1234567890";

    await evaluateLocalSecurityGateway({
      toolName: "read_file",
      params: {
        path: sensitivePath,
        apiKey: secretKey,
        authorization: "Bearer secret-token-xyz",
      },
      runId: "run-privacy",
    });

    const logs = getSecurityAuditLogs();
    const logString = JSON.stringify(logs);

    expect(logString).not.toContain(sensitivePath);
    expect(logString).not.toContain(secretKey);
    expect(logString).not.toContain("secret-token-xyz");
    expect(logs[0]?.error).toBe("Access to a sensitive or prohibited path is blocked.");
  });

  it("Test G — OpenClaw tool wrapper preserves read-only SAFE classification without prompt wait", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "safe data" }] });
    const rawTool = createMockTool("read_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = await wrappedTool.execute("call-safe", { path: "readme.md" });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: [{ type: "text", text: "safe data" }] });
  });
});
