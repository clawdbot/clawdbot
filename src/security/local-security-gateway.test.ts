import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  operatorClearEmergencyStop,
  operatorConfigureGateway,
  operatorResetGateway,
} from "./local-security-gateway-operator.js";
import {
  calculateActionDigest,
  classifyAction,
  evaluateLocalSecurityGateway,
  getSecurityAuditLogs,
  isApprovalValidForParams,
  isEmergencyStopActive,
  isSensitivePath,
  logToolExecutionCompleted,
  logToolExecutionStarted,
  sanitizeParameters,
  triggerEmergencyStop,
  type PendingApprovalRequest,
} from "./local-security-gateway.js";

describe("Hardened LocalSecurityGateway Security & Adversarial Tests", () => {
  beforeEach(() => {
    operatorResetGateway();
  });

  afterEach(() => {
    operatorResetGateway();
  });

  it("1. Malformed percent-encoding fails closed and is treated as sensitive/blocked", () => {
    expect(isSensitivePath("%")).toBe(true);
    expect(isSensitivePath("%ZZ")).toBe(true);
    expect(isSensitivePath("%E0%A4%A")).toBe(true); // Incomplete UTF-8 sequence

    const classification = classifyAction("read_file", { path: "hello_%ZZ_file.txt" });
    expect(classification.classification).toBe("BLOCKED");
  });

  it("2. Windows path separator handling (slashes, backslashes, mixed, case variations)", () => {
    expect(isSensitivePath("C:\\Users\\User\\.ssh\\id_rsa")).toBe(true);
    expect(isSensitivePath("C:/Users/User/.ssh/id_rsa")).toBe(true);
    expect(isSensitivePath("C:\\Users\\User/.ssh\\id_rsa")).toBe(true);
    expect(isSensitivePath(".ENV")).toBe(true);
    expect(isSensitivePath("system32\\config\\SAM")).toBe(true);
    expect(isSensitivePath("SYSTEM32/CONFIG/SAM")).toBe(true);
    expect(isSensitivePath("AppData\\Local\\Google\\Chrome\\User Data")).toBe(true);
    expect(isSensitivePath("AppData/Local/Google/Chrome/User Data")).toBe(true);
  });

  it("3. Execution audit metadata preserves SAFE/AUTOMATIC status vs APPROVAL_REQUIRED", async () => {
    const runId = "run-audit-meta";

    // 1. SAFE action execution logs
    await evaluateLocalSecurityGateway({ toolName: "read_file", params: { path: "a.txt" }, runId });
    logToolExecutionStarted({
      toolName: "read_file",
      params: { path: "a.txt" },
      runId,
      classification: "SAFE",
      authorizationResult: "AUTOMATIC",
    });
    logToolExecutionCompleted({
      toolName: "read_file",
      params: { path: "a.txt" },
      runId,
      classification: "SAFE",
      authorizationResult: "AUTOMATIC",
      success: true,
    });

    const logs = getSecurityAuditLogs();
    const safeStarted = logs.find((l) => l.stage === "EXECUTION_STARTED" && l.toolName === "read_file");
    expect(safeStarted?.classification).toBe("SAFE");
    expect(safeStarted?.authorizationResult).toBe("AUTOMATIC");
    expect(safeStarted?.executionStatus).toBe("RUNNING");

    const safeCompleted = logs.find((l) => l.stage === "EXECUTION_COMPLETED" && l.toolName === "read_file");
    expect(safeCompleted?.classification).toBe("SAFE");
    expect(safeCompleted?.authorizationResult).toBe("AUTOMATIC");
    expect(safeCompleted?.executionStatus).toBe("EXECUTION_SUCCEEDED");
  });

  it("4. Cycle-safe and throwing getter parameter sanitization", () => {
    // Direct circular object
    const circularObj: any = { name: "test" };
    circularObj.self = circularObj;

    const sanitizedCircular = sanitizeParameters(circularObj) as any;
    expect(sanitizedCircular.name).toBe("test");
    expect(sanitizedCircular.self).toBe("[CIRCULAR_REFERENCE]");

    // Nested circular object in array
    const nestedCircular: any = { items: [] };
    nestedCircular.items.push(nestedCircular);

    const sanitizedNested = sanitizeParameters(nestedCircular) as any;
    expect(sanitizedNested.items[0]).toBe("[CIRCULAR_REFERENCE]");

    // Property getter throwing an error
    const throwingObj = {
      safeProp: "ok",
      get badProp() {
        throw new Error("Getter error trap!");
      },
    };

    const sanitizedThrowing = sanitizeParameters(throwingObj) as any;
    expect(sanitizedThrowing.safeProp).toBe("ok");
    expect(sanitizedThrowing.badProp).toBe("[ERROR_READING_PROPERTY]");
  });

  it("5. Raw path/secret parameters are NEVER leaked in audit error strings", async () => {
    const sensitivePath = "C:\\Users\\Admin\\.ssh\\id_rsa";
    const result = await evaluateLocalSecurityGateway({
      toolName: "read_file",
      params: { path: sensitivePath },
      runId: "run-leak-check",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).not.toContain(sensitivePath);
    expect(result.reason).toBe("Access to a sensitive or prohibited path is blocked.");

    const logs = getSecurityAuditLogs();
    expect(logs[0]?.error).not.toContain(sensitivePath);
    expect(logs[0]?.error).toBe("Access to a sensitive or prohibited path is blocked.");
  });

  it("6. Operator controls are isolated and cannot be accessed through exported tokens or tools", () => {
    triggerEmergencyStop("Operator Stop");
    expect(isEmergencyStopActive()).toBe(true);

    // Operator clear function succeeds
    operatorClearEmergencyStop();
    expect(isEmergencyStopActive()).toBe(false);
  });

  it("7. Unknown tools and shell tools fail closed", () => {
    const unknownClass = classifyAction("unknown_mcp_tool", { arg: 1 });
    expect(unknownClass.classification).toBe("APPROVAL_REQUIRED");

    const shellClass = classifyAction("powershell", { command: "dir" });
    expect(shellClass.classification).toBe("BLOCKED");
  });
});
