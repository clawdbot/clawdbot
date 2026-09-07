import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import {
  operatorConfigureGateway,
  operatorResetGateway,
} from "./local-security-gateway-operator.js";
import {
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

describe("Local Security Gateway Tool Pipeline Integration", () => {
  beforeEach(() => {
    operatorResetGateway();
  });

  afterEach(() => {
    operatorResetGateway();
  });

  it("SAFE action (read_file) automatically executes through tool wrapper", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file content" }] });
    const rawTool = createMockTool("read_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = await wrappedTool.execute("call-1", { path: "hello.txt" });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: [{ type: "text", text: "file content" }] });
  });

  it("APPROVAL_REQUIRED action (write_file) waits for approval and executes when ENTER/approved", async () => {
    const mockExecute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "written" }] });
    const rawTool = createMockTool("write_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    operatorConfigureGateway({
      approvalHandler: (request: PendingApprovalRequest) => {
        expect(request.toolName).toBe("write_file");
        return "APPROVAL_GRANTED";
      },
    });

    const result = await wrappedTool.execute("call-2", { path: "output.txt", content: "hello" });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: [{ type: "text", text: "written" }] });
  });

  it("APPROVAL_REQUIRED action (delete_file) is blocked when ESC/rejected", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("delete_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    operatorConfigureGateway({
      approvalHandler: () => "REJECTED_USER",
    });

    const result = (await wrappedTool.execute("call-3", { path: "output.txt" })) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-rejected");
    expect(result.content[0]?.text).toContain("Action rejected or expired");
  });

  it("BLOCKED arbitrary shell execution (exec / powershell / cmd) NEVER executes the underlying tool", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("exec", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = (await wrappedTool.execute("call-4", { command: "Get-Process" })) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-blocked");
    expect(result.content[0]?.text).toContain("Arbitrary shell execution is blocked");
  });

  it("BLOCKED PowerShell tool call NEVER executes", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("powershell", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = (await wrappedTool.execute("call-5", { command: "dir" })) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-blocked");
    expect(result.content[0]?.text).toContain("Arbitrary shell execution is blocked");
  });

  it("Attempted sensitive path access (e.g. .ssh/id_rsa) is BLOCKED and never executes", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("read_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = (await wrappedTool.execute("call-6", { path: "~/.ssh/id_rsa" })) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-blocked");
    expect(result.content[0]?.text).toContain("Access to a sensitive or prohibited path is blocked.");
  });

  it("Emergency Stop cancels active pending approval and halts execution", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("computer", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    operatorConfigureGateway({
      approvalTimeoutMs: 5_000,
      approvalHandler: () => {
        // Pending...
      },
    });

    const executionPromise = wrappedTool.execute("call-7", { action: "click" });

    // Trigger emergency stop while waiting
    setTimeout(() => {
      triggerEmergencyStop("User Emergency Stop Hotkey");
    }, 20);

    const result = (await executionPromise) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-rejected");
    expect(result.content[0]?.text).toContain("Action cancelled by Emergency stop");
  });
});
