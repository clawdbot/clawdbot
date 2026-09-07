import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "../agents/agent-tools.types.js";
import {
  configureLocalSecurityGateway,
  resetLocalSecurityGateway,
  triggerEmergencyStop,
  TRUSTED_OPERATOR_TOKEN,
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
    resetLocalSecurityGateway(TRUSTED_OPERATOR_TOKEN);
  });

  afterEach(() => {
    resetLocalSecurityGateway(TRUSTED_OPERATOR_TOKEN);
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

    configureLocalSecurityGateway(
      {
        approvalHandler: (request: PendingApprovalRequest) => {
          expect(request.toolName).toBe("write_file");
          return "APPROVAL_GRANTED";
        },
      },
      TRUSTED_OPERATOR_TOKEN,
    );

    const result = await wrappedTool.execute("call-2", { path: "output.txt", content: "hello" });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ content: [{ type: "text", text: "written" }] });
  });

  it("APPROVAL_REQUIRED action (delete_file) is blocked when ESC/rejected", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("delete_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    configureLocalSecurityGateway(
      {
        approvalHandler: () => "REJECTED_USER",
      },
      TRUSTED_OPERATOR_TOKEN,
    );

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
    expect(result.content[0]?.text).toContain("Arbitrary shell execution via 'exec' is blocked");
  });

  it("BLOCKED PowerShell tool call NEVER executes", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("powershell", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = (await wrappedTool.execute("call-5", { command: "dir" })) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-blocked");
    expect(result.content[0]?.text).toContain("Arbitrary shell execution via 'powershell' is blocked");
  });

  it("Attempted sensitive path access (e.g. .ssh/id_rsa) is BLOCKED and never executes", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("read_file", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    const result = (await wrappedTool.execute("call-6", { path: "~/.ssh/id_rsa" })) as any;

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.details?.deniedReason).toBe("security-gateway-blocked");
    expect(result.content[0]?.text).toContain("Access to sensitive or prohibited path");
  });

  it("Emergency Stop cancels active pending approval and halts execution", async () => {
    const mockExecute = vi.fn();
    const rawTool = createMockTool("computer", mockExecute);
    const wrappedTool = wrapToolWithBeforeToolCallHook(rawTool);

    configureLocalSecurityGateway(
      {
        approvalTimeoutMs: 5_000,
        approvalHandler: () => {
          // Pending...
        },
      },
      TRUSTED_OPERATOR_TOKEN,
    );

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
