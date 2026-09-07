import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateActionDigest,
  classifyAction,
  clearEmergencyStop,
  configureLocalSecurityGateway,
  evaluateLocalSecurityGateway,
  getSecurityAuditLogs,
  isApprovalValidForParams,
  isEmergencyStopActive,
  isSensitivePath,
  logToolExecutionCompleted,
  logToolExecutionStarted,
  resetLocalSecurityGateway,
  triggerEmergencyStop,
  TRUSTED_OPERATOR_TOKEN,
  type PendingApprovalRequest,
} from "./local-security-gateway.js";

describe("Hardened LocalSecurityGateway Unit & Security Tests", () => {
  beforeEach(() => {
    resetLocalSecurityGateway(TRUSTED_OPERATOR_TOKEN);
  });

  afterEach(() => {
    resetLocalSecurityGateway(TRUSTED_OPERATOR_TOKEN);
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

  it("4. Fail-closed digest generation handles BigInt and circular objects safely", () => {
    // BigInt parameters generate valid deterministic digests
    const digest1 = calculateActionDigest("write_file", { id: 100n, content: "test" });
    const digest2 = calculateActionDigest("write_file", { id: 100n, content: "test" });
    expect(digest1).toBe(digest2);

    // Circular objects return an invalid digest that fails closed
    const circularObj: any = { name: "test" };
    circularObj.self = circularObj;

    const circularDigest = calculateActionDigest("write_file", circularObj);
    expect(circularDigest.startsWith("INVALID_DIGEST_ERROR_")).toBe(true);

    const mockReq: PendingApprovalRequest = {
      id: "req-circ",
      toolName: "write_file",
      params: circularObj,
      digest: circularDigest,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
      resolve: () => {},
      timer: setTimeout(() => {}, 10_000),
    };

    expect(isApprovalValidForParams(mockReq, "write_file", circularObj)).toBe(false);
    clearTimeout(mockReq.timer);
  });

  it("5. Operator controls (configure, reset, clearEmergencyStop) require TRUSTED_OPERATOR_TOKEN", () => {
    triggerEmergencyStop("Operator Stop");
    expect(isEmergencyStopActive()).toBe(true);

    // Model tools / unauthenticated calls cannot clear emergency stop
    expect(() => (clearEmergencyStop as any)()).toThrow("Unauthorized attempt to clear Emergency Stop");
    expect(() => (configureLocalSecurityGateway as any)({ approvalTimeoutMs: 1000 })).toThrow("Unauthorized attempt to configure Security Gateway");
    expect(() => (resetLocalSecurityGateway as any)()).toThrow("Unauthorized attempt to reset Security Gateway");

    expect(isEmergencyStopActive()).toBe(true);

    // Trusted operator call succeeds
    clearEmergencyStop(TRUSTED_OPERATOR_TOKEN);
    expect(isEmergencyStopActive()).toBe(false);
  });

  it("6. Unknown tools and shell tools fail closed", () => {
    const unknownClass = classifyAction("unknown_mcp_tool", { arg: 1 });
    expect(unknownClass.classification).toBe("APPROVAL_REQUIRED");

    const shellClass = classifyAction("powershell", { command: "dir" });
    expect(shellClass.classification).toBe("BLOCKED");
  });
});
