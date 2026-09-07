// Covers gateway waitDecision id binding for native hook relay permission approvals.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool } from "../tools/gateway.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/gateway.js")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  // restoreAllMocks does not clear call history on module-mock vi.fn()s.
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  testing.clearNativeHookRelaysForTests();
});

function mockGatewayApproval(waitResult: { id?: string; decision?: string | null }) {
  mockCallGatewayTool.mockImplementation(async (method: string) => {
    if (method === "plugin.approval.request") {
      return { id: "approval-1", status: "accepted" };
    }
    if (method === "plugin.approval.waitDecision") {
      return waitResult;
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
}

async function invokePermissionRequest(
  relayId: string,
  options: { command?: string; cwd?: string } = {},
) {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      cwd: options.cwd ?? "/repo",
      tool_name: "Bash",
      tool_use_id: "native-binding-call-1",
      tool_input: { command: options.command ?? "printf binding" },
    },
  });
}

describe("native hook relay approval id binding", () => {
  it("accepts a waitDecision reply bound to the requested approval id", async () => {
    mockGatewayApproval({ id: "approval-1", decision: "allow-once" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-binding-match",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokePermissionRequest(relay.relayId);

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("defers when a waitDecision reply carries a different approval id", async () => {
    mockGatewayApproval({ id: "approval-other", decision: "allow-once" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-binding-mismatch",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokePermissionRequest(relay.relayId);

    // A misrouted reply must never release the gate; the relay falls back to
    // the provider's own approval path via the noop response.
    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("denies when a script operand changes during the permission approval", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-hook-drift-"));
    const script = path.join(cwd, "script.sh");
    try {
      await fs.writeFile(script, "#!/bin/sh\necho approved\n");
      mockCallGatewayTool.mockImplementation(async (method: string) => {
        if (method === "plugin.approval.request") {
          return { id: "approval-1", status: "accepted" };
        }
        if (method === "plugin.approval.waitDecision") {
          await fs.writeFile(script, "#!/bin/sh\necho mutated\n");
          return { id: "approval-1", decision: "allow-once" };
        }
        throw new Error(`unexpected gateway method: ${method}`);
      });
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "codex-script-drift",
        sessionId: "session-1",
        runId: "run-1",
      });

      const response = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });

      expect(JSON.parse(response.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
          },
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows an unchanged script operand after permission approval", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-hook-stable-"));
    try {
      await fs.writeFile(path.join(cwd, "script.sh"), "#!/bin/sh\necho approved\n");
      mockGatewayApproval({ id: "approval-1", decision: "allow-once" });
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "codex-script-stable",
        sessionId: "session-1",
        runId: "run-1",
      });

      const response = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });

      expect(JSON.parse(response.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not reuse allow-always after bound script bytes change", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-hook-always-"));
    const script = path.join(cwd, "script.sh");
    try {
      await fs.writeFile(script, "#!/bin/sh\necho approved\n");
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-always",
        decision: "allow-always",
      });
      const relay = registerNativeHookRelay({
        provider: "codex",
        relayId: "codex-script-always",
        sessionId: "session-1",
        runId: "run-1",
      });

      const first = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });
      expect(JSON.parse(first.stdout).hookSpecificOutput.decision).toEqual({ behavior: "allow" });

      await fs.writeFile(script, "#!/bin/sh\necho changed\n");
      mockCallGatewayTool.mockReset();
      mockCallGatewayTool.mockResolvedValueOnce({ id: "approval-changed", decision: "deny" });
      const second = await invokePermissionRequest(relay.relayId, {
        command: "sh script.sh",
        cwd,
      });

      expect(mockCallGatewayTool).toHaveBeenCalledOnce();
      expect(JSON.parse(second.stdout).hookSpecificOutput.decision).toEqual({
        behavior: "deny",
        message: "Denied by user",
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
