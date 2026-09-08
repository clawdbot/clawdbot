import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Local Security Gateway for OpenClaw / Jarvis.
 *
 * Strictly fail-closed security gateway enforcing out-of-LLM security classification,
 * hardened Windows path protection, raw-parameter authorization digests, explicit user approval gates,
 * emergency stop protection, bounded audit logging, and single-consumption request isolation.
 */

export type GatewayClassification = "SAFE" | "APPROVAL_REQUIRED" | "BLOCKED";

export type AuditEventStage =
  | "AUTHORIZATION_DECISION"
  | "EXECUTION_STARTED"
  | "EXECUTION_COMPLETED";

export type AuthorizationResult =
  | "AUTOMATIC"
  | "APPROVAL_GRANTED"
  | "REJECTED_USER"
  | "REJECTED_TIMEOUT"
  | "REJECTED_EMERGENCY_STOP"
  | "BLOCKED_POLICY";

export type ExecutionStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "EXECUTION_SUCCEEDED"
  | "EXECUTION_FAILED";

export type SecurityAuditEvent = {
  eventId: string;
  timestamp: string;
  stage: AuditEventStage;
  runId?: string;
  sessionId?: string;
  toolName: string;
  sanitizedParams: unknown;
  classification: GatewayClassification;
  authorizationResult: AuthorizationResult;
  executionStatus: ExecutionStatus;
  error?: string;
};

export type PendingApprovalRequest = {
  id: string;
  toolName: string;
  params: unknown;
  digest: string;
  createdAt: number;
  expiresAt: number;
  resolve: (result: AuthorizationResult) => void;
  timer: NodeJS.Timeout;
};

export type SecurityGatewayConfig = {
  approvalTimeoutMs: number;
  auditLogger?: (event: SecurityAuditEvent) => void;
  approvalHandler?: (
    request: PendingApprovalRequest,
  ) => Promise<AuthorizationResult> | AuthorizationResult | void;
};

const DEFAULT_CONFIG: SecurityGatewayConfig = {
  approvalTimeoutMs: 30_000,
};

const MAX_AUDIT_LOG_CAPACITY = 1000;

// Global Gateway State
let currentConfig: SecurityGatewayConfig = { ...DEFAULT_CONFIG };
let emergencyStopTriggered = false;
let emergencyStopReason: string | undefined = undefined;
const pendingApprovals = new Map<string, PendingApprovalRequest>();
const pendingApprovalQueue: PendingApprovalRequest[] = [];
const auditLogs: SecurityAuditEvent[] = [];
const registeredAbortControllers = new Set<AbortController>();

// Internal operator bridge registration
let operatorBridgeRegistered = false;

/** Internal configure gateway function. */
function configureLocalSecurityGatewayInternal(config: Partial<SecurityGatewayConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...config,
  };
}

/** Internal reset gateway state function. */
function resetLocalSecurityGatewayInternal(): void {
  currentConfig = { ...DEFAULT_CONFIG };
  emergencyStopTriggered = false;
  emergencyStopReason = undefined;

  for (const [, req] of pendingApprovals) {
    clearTimeout(req.timer);
    req.resolve("REJECTED_EMERGENCY_STOP");
  }
  pendingApprovals.clear();
  pendingApprovalQueue.length = 0;
  auditLogs.length = 0;
  registeredAbortControllers.clear();
  detachStdinController();
}

/** Internal clear emergency stop function. */
function clearEmergencyStopInternal(): void {
  emergencyStopTriggered = false;
  emergencyStopReason = undefined;
}

/** Registers operator handlers with the isolated operator module. */
export function registerOperatorBridge(
  secretSymbol: Symbol,
  binder: {
    bindHandlers: (handlers: {
      configure: (config: Partial<SecurityGatewayConfig>) => void;
      reset: () => void;
      clearEmergencyStop: () => void;
    }) => void;
  },
): void {
  if (operatorBridgeRegistered) {
    return;
  }
  if (typeof secretSymbol !== "symbol" || !secretSymbol.toString().includes("OPERATOR_SECRET")) {
    throw new Error("Unauthorized operator bridge registration attempt.");
  }
  operatorBridgeRegistered = true;
  binder.bindHandlers({
    configure: configureLocalSecurityGatewayInternal,
    reset: resetLocalSecurityGatewayInternal,
    clearEmergencyStop: clearEmergencyStopInternal,
  });
}

/** Register an AbortController associated with active agent runs. */
export function registerAgentAbortController(controller: AbortController): () => void {
  registeredAbortControllers.add(controller);
  return () => {
    registeredAbortControllers.delete(controller);
  };
}

/** Emergency Stop mechanism: Immediately cancels pending approvals and aborts registered runs. */
export function triggerEmergencyStop(reason = "Emergency stop activated by operator"): void {
  emergencyStopTriggered = true;
  emergencyStopReason = reason;

  // Reject all pending approvals immediately
  for (const [id, req] of pendingApprovals) {
    clearTimeout(req.timer);
    req.resolve("REJECTED_EMERGENCY_STOP");
    pendingApprovals.delete(id);
  }
  pendingApprovalQueue.length = 0;
  detachStdinController();

  // Abort all active agent execution signals
  for (const controller of registeredAbortControllers) {
    try {
      controller.abort(new Error(reason));
    } catch {
      // Ignore abort errors
    }
  }
  registeredAbortControllers.clear();
}

/** Check whether emergency stop is currently active. */
export function isEmergencyStopActive(): boolean {
  return emergencyStopTriggered;
}

/** Retrieve active emergency stop reason if active. */
export function getEmergencyStopReason(): string | undefined {
  return emergencyStopTriggered ? emergencyStopReason : undefined;
}

/** Retrieve recorded in-memory security audit logs. */
export function getSecurityAuditLogs(): readonly SecurityAuditEvent[] {
  return [...auditLogs];
}

// Sensitive secret keys / patterns for audit scrubbing
const SECRET_KEY_PATTERNS = [
  /api[-_]?key/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /cookie/i,
  /auth/i,
  /bearer/i,
  /private[-_]?key/i,
  /credential/i,
  /ssn/i,
  /credit[-_]?card/i,
];

/**
 * Cycle-safe, throwing-getter-safe parameter sanitization for audit logs.
 */
export function sanitizeParameters(value: unknown, seen = new WeakSet<object>()): unknown {
  try {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      if (
        /bearer\s+[a-zA-Z0-9._~+/-]+=*/i.test(value) ||
        /sk-[a-zA-Z0-9]{20,}/.test(value) ||
        /key-[a-zA-Z0-9]{20,}/.test(value)
      ) {
        return "[REDACTED_SECRET]";
      }
      return value;
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (typeof value === "function" || typeof value === "symbol") {
      return `[${typeof value}]`;
    }

    if (typeof value !== "object") {
      return value;
    }

    // Circular reference check
    if (seen.has(value as object)) {
      return "[CIRCULAR_REFERENCE]";
    }
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeParameters(item, seen));
    }

    const sanitizedObj: Record<string, unknown> = {};
    const keys = Object.keys(value as object);

    for (const key of keys) {
      try {
        if (SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
          sanitizedObj[key] = "[REDACTED_SECRET]";
        } else {
          const val = (value as Record<string, unknown>)[key];
          sanitizedObj[key] = sanitizeParameters(val, seen);
        }
      } catch {
        sanitizedObj[key] = "[ERROR_READING_PROPERTY]";
      }
    }
    return sanitizedObj;
  } catch {
    return "[UNSANITIZABLE_OBJECT]";
  }
}

/** Log a security audit event with bounded retention. */
export function logSecurityAuditEvent(event: Omit<SecurityAuditEvent, "eventId" | "sanitizedParams"> & { params: unknown }): void {
  const auditEntry: SecurityAuditEvent = {
    eventId: randomUUID(),
    timestamp: event.timestamp,
    stage: event.stage,
    ...(event.runId && { runId: event.runId }),
    ...(event.sessionId && { sessionId: event.sessionId }),
    toolName: event.toolName,
    sanitizedParams: sanitizeParameters(event.params),
    classification: event.classification,
    authorizationResult: event.authorizationResult,
    executionStatus: event.executionStatus,
    ...(event.error && { error: event.error }),
  };

  auditLogs.push(auditEntry);
  if (auditLogs.length > MAX_AUDIT_LOG_CAPACITY) {
    auditLogs.shift();
  }

  if (currentConfig.auditLogger) {
    try {
      currentConfig.auditLogger(auditEntry);
    } catch {
      // Ignore logging callback errors
    }
  }
}

// Sensitive Windows & System path patterns supporting both \ and / and case variations
const SENSITIVE_PATH_PATTERNS = [
  /([/\\]|^)\.ssh([/\\]|$)/i,
  /([/\\]|^)\.aws([/\\]|$)/i,
  /([/\\]|^)\.gnupg([/\\]|$)/i,
  /([/\\]|^)\.env($|\.|[/\\])/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials(\.json|\.xml|\.ini|$)/i,
  /shadow$/i,
  /SAM$/i,
  /SYSTEM$/i,
  /SECURITY$/i,
  /SOFTWARE$/i,
  /Chrome[/\\]User Data/i,
  /Firefox[/\\]Profiles/i,
  /AppData[/\\]Local[/\\]Google[/\\]Chrome/i,
  /AppData[/\\]Roaming[/\\]Mozilla/i,
  /\.config[/\\]google-chrome/i,
  /system32[/\\]config/i,
];

/**
 * Hardened Windows-aware path check.
 */
export function isSensitivePath(targetPath: string): boolean {
  if (!targetPath || typeof targetPath !== "string") {
    return false;
  }

  const raw = targetPath.trim();

  // Null byte injection attempt -> FAIL CLOSED
  if (raw.includes("\0") || raw.includes("%00")) {
    return true;
  }

  // Windows Device paths (e.g. \\.\PhysicalDrive0, \\?\C:\...) -> FAIL CLOSED
  if (raw.startsWith("\\\\.\\") || raw.startsWith("\\\\?\\") || raw.startsWith("//./") || raw.startsWith("//?/")) {
    return true;
  }

  // UNC Network Paths (e.g. \\remote-server\share) -> FAIL CLOSED
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    return true;
  }

  // Safe percent decoding with bounded passes; FAIL CLOSED on malformed encoding
  let decoded = raw;
  const maxDecodePasses = 2;
  for (let pass = 0; pass < maxDecodePasses; pass++) {
    if (!decoded.includes("%")) {
      break;
    }
    try {
      const nextDecoded = decodeURIComponent(decoded);
      if (nextDecoded === decoded) {
        break;
      }
      decoded = nextDecoded;
    } catch {
      // Malformed URI encoding -> FAIL CLOSED
      return true;
    }
  }

  // Re-check null bytes after decoding
  if (decoded.includes("\0")) {
    return true;
  }

  // Path traversal check
  if (decoded.includes("..") || raw.includes("..")) {
    return true;
  }

  const normalizedSlash = decoded.replace(/\//g, "\\");
  const normalizedPath = path.normalize(normalizedSlash);

  // Check normalized path against sensitive patterns
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(normalizedPath) || pattern.test(decoded) || pattern.test(raw)) {
      return true;
    }
  }

  return false;
}

// Known OpenClaw filesystem tools
const FS_CAPABLE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "list_files",
  "ls",
  "fs_write",
  "fs_delete",
  "fs_move",
  "create_directory",
  "view_image",
]);

/**
 * Extracts path parameters based on tool capability or heuristic search.
 */
export function extractPathsFromParams(toolName: string, params: unknown): string[] {
  const paths: string[] = [];
  if (!params || typeof params !== "object") {
    return paths;
  }

  const normalizedTool = toolName.toLowerCase().trim();
  const isFsTool = FS_CAPABLE_TOOLS.has(normalizedTool);

  function search(obj: unknown) {
    if (!obj || typeof obj !== "object") return;
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof val === "string") {
        const isPathKey = /path|file|dir|cwd|target|source|dest|folder|filename/i.test(key);
        if (isPathKey || isFsTool) {
          paths.push(val);
        }
      } else if (typeof val === "object" && val !== null) {
        search(val);
      }
    }
  }

  search(params);
  return paths;
}

// Shell / Arbitrary subprocess execution tools (Blocked initially per requirement 6)
const BLOCKED_SHELL_TOOLS = new Set([
  "exec",
  "bash",
  "powershell",
  "cmd",
  "terminal",
  "spawn",
  "shell",
  "exec_script",
  "process_spawn",
  "process_send_keys",
  "run_command",
  "system_run",
]);

// Read-only inspection tools
const SAFE_READONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "ls",
  "view_image",
  "web_search",
  "describe_image",
  "get_status",
  "read_memory",
  "search_memory",
  "time",
]);

// Dangerous tools requiring explicit user approval
const APPROVAL_REQUIRED_TOOLS = new Set([
  "write_file",
  "fs_write",
  "edit_file",
  "apply_patch",
  "delete_file",
  "fs_delete",
  "fs_move",
  "create_directory",
  "web_fetch",
  "http_request",
  "curl",
  "send_message",
  "conversations_send",
  "email_send",
  "post_data",
  "upload",
  "computer",
  "mouse_click",
  "keyboard_type",
  "window_action",
  "desktop_control",
  "mobile_ui",
  "install_software",
  "npm_install",
  "system_change",
  "portal",
  "automations",
  "gateway",
]);

/**
 * Classifies an action based strictly on tool name and structured parameters.
 */
export function classifyAction(
  toolName: string,
  params: unknown,
): { classification: GatewayClassification; reason: string } {
  const normalizedToolName = toolName.toLowerCase().trim();

  // 1. Emergency stop active
  if (emergencyStopTriggered) {
    return {
      classification: "BLOCKED",
      reason: `Emergency stop active: Execution halted by operator.`,
    };
  }

  // 2. Shell / Subprocess execution tools are BLOCKED initially
  if (BLOCKED_SHELL_TOOLS.has(normalizedToolName)) {
    return {
      classification: "BLOCKED",
      reason: `Arbitrary shell execution is blocked by security gateway policy.`,
    };
  }

  // 3. Path Protection check (NO raw path strings in reason!)
  const extractedPaths = extractPathsFromParams(toolName, params);
  for (const p of extractedPaths) {
    if (isSensitivePath(p)) {
      return {
        classification: "BLOCKED",
        reason: `Access to a sensitive or prohibited path is blocked.`,
      };
    }
  }

  // 4. Safe Read-Only tools
  if (SAFE_READONLY_TOOLS.has(normalizedToolName)) {
    return {
      classification: "SAFE",
      reason: `Tool is classified as a safe read-only action.`,
    };
  }

  // 5. Actions requiring explicit approval
  if (APPROVAL_REQUIRED_TOOLS.has(normalizedToolName)) {
    return {
      classification: "APPROVAL_REQUIRED",
      reason: `Action requires explicit user approval.`,
    };
  }

  // 6. Unknown tools / Plugins / Skills default to APPROVAL_REQUIRED (fail-closed)
  return {
    classification: "APPROVAL_REQUIRED",
    reason: `Unclassified action requiring explicit user approval.`,
  };
}

/**
 * Recursively produces a deterministic canonical representation of an object.
 */
function canonicalizeObject(obj: unknown, seen = new WeakSet<object>()): unknown {
  if (obj === null || typeof obj !== "object") {
    if (typeof obj === "bigint") {
      return `bigint:${obj.toString()}`;
    }
    return obj;
  }

  if (seen.has(obj as object)) {
    throw new Error("Circular parameter reference detected");
  }
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    return obj.map((item) => canonicalizeObject(item, seen));
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const canonicalObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    canonicalObj[key] = canonicalizeObject((obj as Record<string, unknown>)[key], seen);
  }
  return canonicalObj;
}

/**
 * Calculates a deterministic authorization digest using ORIGINAL RAW parameters.
 */
export function calculateActionDigest(toolName: string, params: unknown): string {
  try {
    const canonical = canonicalizeObject(params);
    const json = JSON.stringify({
      toolName: toolName.toLowerCase().trim(),
      params: canonical,
    });
    if (!json) {
      throw new Error("Failed to JSON.stringify canonical parameters");
    }
    return createHash("sha256").update(json).digest("hex");
  } catch {
    return `INVALID_DIGEST_ERROR_${randomUUID()}`;
  }
}

/** Verify if an approval digest matches a target request digest. */
export function isApprovalValidForParams(
  pendingRequest: PendingApprovalRequest,
  requestedToolName: string,
  requestedParams: unknown,
): boolean {
  if (Date.now() > pendingRequest.expiresAt) {
    return false;
  }
  const currentDigest = calculateActionDigest(requestedToolName, requestedParams);
  if (currentDigest.startsWith("INVALID_DIGEST_ERROR_")) {
    return false;
  }
  return pendingRequest.digest === currentDigest;
}

// Single-consumption Stdin Queue Controller
let activeDataHandler: ((data: Buffer) => void) | undefined = undefined;

function detachStdinController() {
  if (activeDataHandler) {
    try {
      process.stdin.off("data", activeDataHandler);
      if (process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // Ignore terminal mode errors
    }
    activeDataHandler = undefined;
  }
}

/**
 * Default local CLI interactive approval handler.
 * Controls:
 * - ENTER (\r or \n) = approve EXACTLY ONE pending request
 * - 's' or 'S' = show details
 * - ESC (\x1b) = reject
 */
export async function defaultLocalApprovalHandler(
  request: PendingApprovalRequest,
): Promise<AuthorizationResult> {
  const sanitizedParams = sanitizeParameters(request.params);
  console.log(`\n================ SECURITY GATEWAY APPROVAL REQUIRED ================`);
  console.log(`Tool:        ${request.toolName}`);
  console.log(`Request ID:  ${request.id}`);
  console.log(`Summary:     ${JSON.stringify(sanitizedParams).slice(0, 100)}...`);
  console.log(`Controls:    [ENTER] = Approve | [S] = Show Details | [ESC] = Reject`);
  console.log(`Expires in:  ${Math.round((request.expiresAt - Date.now()) / 1000)} seconds`);
  console.log(`====================================================================\n`);

  if (!process.stdin.isTTY) {
    return "REJECTED_TIMEOUT";
  }

  return new Promise<AuthorizationResult>((resolve) => {
    detachStdinController();

    const onData = (data: Buffer) => {
      const str = data.toString("utf-8");

      // ENTER (\r or \n) ONLY - Consumes EXACTLY this request
      if (str === "\r" || str === "\n") {
        detachStdinController();
        console.log(`[Security Gateway] Action APPROVAL_GRANTED for request ${request.id} (ENTER).`);
        resolve("APPROVAL_GRANTED");
        return;
      }

      // ESC (\x1b) ONLY
      if (str === "\x1b") {
        detachStdinController();
        console.log(`[Security Gateway] Action REJECTED_USER for request ${request.id} (ESC).`);
        resolve("REJECTED_USER");
        return;
      }

      // 's' or 'S' = show details
      if (str.toLowerCase() === "s") {
        console.log(`\n--- Detailed Action Parameters ---`);
        console.log(JSON.stringify(sanitizedParams, null, 2));
        console.log(`----------------------------------\n`);
        return;
      }
    };

    activeDataHandler = onData;

    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
    } catch {
      detachStdinController();
      resolve("REJECTED_TIMEOUT");
    }
  });
}

/**
 * Main evaluation entrypoint for the Local Security Gateway.
 * Strictly fail-closed.
 */
export async function evaluateLocalSecurityGateway(args: {
  toolName: string;
  params: unknown;
  runId?: string;
  sessionId?: string;
}): Promise<{
  allowed: boolean;
  classification: GatewayClassification;
  authorizationResult: AuthorizationResult;
  reason: string;
}> {
  const timestamp = new Date().toISOString();
  const { toolName, params, runId, sessionId } = args;

  // 1. Classify action
  const { classification, reason } = classifyAction(toolName, params);

  // 2. Handle BLOCKED classification
  if (classification === "BLOCKED") {
    const authorizationResult: AuthorizationResult = emergencyStopTriggered
      ? "REJECTED_EMERGENCY_STOP"
      : "BLOCKED_POLICY";

    logSecurityAuditEvent({
      timestamp,
      stage: "AUTHORIZATION_DECISION",
      runId,
      sessionId,
      toolName,
      params,
      classification,
      authorizationResult,
      executionStatus: "NOT_STARTED",
      error: reason,
    });

    return {
      allowed: false,
      classification,
      authorizationResult,
      reason,
    };
  }

  // 3. Handle SAFE classification
  if (classification === "SAFE") {
    const authorizationResult: AuthorizationResult = "AUTOMATIC";
    logSecurityAuditEvent({
      timestamp,
      stage: "AUTHORIZATION_DECISION",
      runId,
      sessionId,
      toolName,
      params,
      classification,
      authorizationResult,
      executionStatus: "NOT_STARTED",
    });

    return {
      allowed: true,
      classification,
      authorizationResult,
      reason,
    };
  }

  // 4. Handle APPROVAL_REQUIRED classification
  const reqId = randomUUID();
  const digest = calculateActionDigest(toolName, params);

  // If digest calculation failed (e.g. non-serializable circular object), fail closed!
  if (digest.startsWith("INVALID_DIGEST_ERROR_")) {
    const authorizationResult: AuthorizationResult = "BLOCKED_POLICY";
    const blockReason = "Invalid or non-canonicalizable parameters (fail-closed)";
    logSecurityAuditEvent({
      timestamp,
      stage: "AUTHORIZATION_DECISION",
      runId,
      sessionId,
      toolName,
      params,
      classification: "BLOCKED",
      authorizationResult,
      executionStatus: "NOT_STARTED",
      error: blockReason,
    });
    return {
      allowed: false,
      classification: "BLOCKED",
      authorizationResult,
      reason: blockReason,
    };
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + currentConfig.approvalTimeoutMs;

  let approvalPromiseResolver!: (result: AuthorizationResult) => void;
  const approvalPromise = new Promise<AuthorizationResult>((res) => {
    approvalPromiseResolver = res;
  });

  const timer = setTimeout(() => {
    if (pendingApprovals.has(reqId)) {
      pendingApprovals.delete(reqId);
      const index = pendingApprovalQueue.findIndex((item) => item.id === reqId);
      if (index !== -1) {
        pendingApprovalQueue.splice(index, 1);
      }
      approvalPromiseResolver("REJECTED_TIMEOUT");
    }
  }, currentConfig.approvalTimeoutMs);

  const pendingRequest: PendingApprovalRequest = {
    id: reqId,
    toolName,
    params,
    digest,
    createdAt,
    expiresAt,
    resolve: approvalPromiseResolver,
    timer,
  };

  pendingApprovals.set(reqId, pendingRequest);
  pendingApprovalQueue.push(pendingRequest);

  const handler = currentConfig.approvalHandler || defaultLocalApprovalHandler;

  Promise.resolve(handler(pendingRequest))
    .then((result) => {
      if (result && pendingApprovals.has(reqId)) {
        clearTimeout(timer);
        pendingApprovals.delete(reqId);
        const index = pendingApprovalQueue.findIndex((item) => item.id === reqId);
        if (index !== -1) {
          pendingApprovalQueue.splice(index, 1);
        }
        approvalPromiseResolver(result);
      }
    })
    .catch(() => {
      if (pendingApprovals.has(reqId)) {
        clearTimeout(timer);
        pendingApprovals.delete(reqId);
        const index = pendingApprovalQueue.findIndex((item) => item.id === reqId);
        if (index !== -1) {
          pendingApprovalQueue.splice(index, 1);
        }
        approvalPromiseResolver("REJECTED_TIMEOUT");
      }
    });

  const authorizationResult = await approvalPromise;
  const allowed = authorizationResult === "APPROVAL_GRANTED";

  logSecurityAuditEvent({
    timestamp,
    stage: "AUTHORIZATION_DECISION",
    runId,
    sessionId,
    toolName,
    params,
    classification,
    authorizationResult,
    executionStatus: "NOT_STARTED",
    ...(allowed ? {} : { error: `Authorization result: ${authorizationResult}` }),
  });

  return {
    allowed,
    classification,
    authorizationResult,
    reason: allowed
      ? "Action approved by operator."
      : authorizationResult === "REJECTED_EMERGENCY_STOP"
      ? "Action cancelled by Emergency stop."
      : `Action rejected or expired (${authorizationResult}).`,
  };
}

/** Log tool execution start event inheriting actual decision metadata. */
export function logToolExecutionStarted(args: {
  toolName: string;
  params: unknown;
  runId?: string;
  sessionId?: string;
  classification: GatewayClassification;
  authorizationResult: AuthorizationResult;
}): void {
  logSecurityAuditEvent({
    timestamp: new Date().toISOString(),
    stage: "EXECUTION_STARTED",
    toolName: args.toolName,
    params: args.params,
    runId: args.runId,
    sessionId: args.sessionId,
    classification: args.classification,
    authorizationResult: args.authorizationResult,
    executionStatus: "RUNNING",
  });
}

/** Log tool execution completed event inheriting actual decision metadata. */
export function logToolExecutionCompleted(args: {
  toolName: string;
  params: unknown;
  runId?: string;
  sessionId?: string;
  classification: GatewayClassification;
  authorizationResult: AuthorizationResult;
  success: boolean;
  error?: string;
}): void {
  logSecurityAuditEvent({
    timestamp: new Date().toISOString(),
    stage: "EXECUTION_COMPLETED",
    toolName: args.toolName,
    params: args.params,
    runId: args.runId,
    sessionId: args.sessionId,
    classification: args.classification,
    authorizationResult: args.authorizationResult,
    executionStatus: args.success ? "EXECUTION_SUCCEEDED" : "EXECUTION_FAILED",
    ...(args.error && { error: args.error }),
  });
}
