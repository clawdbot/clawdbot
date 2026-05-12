import type {
  ExecApprovalCommandSpan,
  ExecAsk,
  ExecSecurity,
  SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
import { normalizeExecutableToken } from "../infra/exec-wrapper-tokens.js";
import {
  isShellWrapperExecutable,
  POSIX_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../infra/shell-wrapper-resolution.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "./bash-tools.exec-runtime.js";
import { callGatewayTool } from "./tools/gateway.js";

type ExecApprovalCommandSpansRuntime =
  typeof import("./bash-tools.exec-approval-request.runtime.js");

let execApprovalCommandSpansRuntimePromise: Promise<ExecApprovalCommandSpansRuntime> | null = null;
const POSIX_COMMAND_HIGHLIGHT_SHELLS: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;

function loadExecApprovalCommandSpansRuntime(): Promise<ExecApprovalCommandSpansRuntime> {
  execApprovalCommandSpansRuntimePromise ??=
    import("./bash-tools.exec-approval-request.runtime.js");
  return execApprovalCommandSpansRuntimePromise;
}

export type RequestExecApprovalDecisionParams = {
  id: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  cwd: string | undefined;
  nodeId?: string;
  host: "gateway" | "node";
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type ExecApprovalRequestToolParams = RequestExecApprovalDecisionParams & {
  timeoutMs: number;
  twoPhase: true;
};

function buildExecApprovalRequestToolParams(
  params: RequestExecApprovalDecisionParams,
): ExecApprovalRequestToolParams {
  return {
    id: params.id,
    ...(params.command ? { command: params.command } : {}),
    ...(params.commandArgv ? { commandArgv: params.commandArgv } : {}),
    systemRunPlan: params.systemRunPlan,
    env: params.env,
    cwd: params.cwd,
    nodeId: params.nodeId,
    host: params.host,
    security: params.security,
    ask: params.ask,
    warningText: params.warningText,
    commandSpans: params.commandSpans,
    agentId: params.agentId,
    resolvedPath: params.resolvedPath,
    sessionKey: params.sessionKey,
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    twoPhase: true,
  };
}

type ParsedDecision = { present: boolean; value: string | null };

function parseDecision(value: unknown): ParsedDecision {
  if (!value || typeof value !== "object") {
    return { present: false, value: null };
  }
  // Distinguish "field missing" from "field present but null/invalid".
  // Registration responses intentionally omit `decision`; decision waits can include it.
  if (!Object.hasOwn(value, "decision")) {
    return { present: false, value: null };
  }
  const decision = (value as { decision?: unknown }).decision;
  return { present: true, value: typeof decision === "string" ? decision : null };
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseExpiresAtMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type ExecApprovalRegistration = {
  id: string;
  expiresAtMs: number;
  finalDecision?: string | null;
};

export async function registerExecApprovalRequest(
  params: RequestExecApprovalDecisionParams,
): Promise<ExecApprovalRegistration> {
  // Two-phase registration is critical: the ID must be registered server-side
  // before exec returns `approval-pending`, otherwise `/approve` can race and orphan.
  const registrationResult = await callGatewayTool(
    "exec.approval.request",
    { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
    buildExecApprovalRequestToolParams(params),
    { expectFinal: false },
  );
  const decision = parseDecision(registrationResult);
  const id = parseString(registrationResult?.id) ?? params.id;
  const expiresAtMs =
    parseExpiresAtMs(registrationResult?.expiresAtMs) ?? Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
  if (decision.present) {
    return { id, expiresAtMs, finalDecision: decision.value };
  }
  return { id, expiresAtMs };
}

export async function waitForExecApprovalDecision(id: string): Promise<string | null> {
  try {
    const decisionResult = await callGatewayTool<{ decision: string }>(
      "exec.approval.waitDecision",
      { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
      { id },
    );
    return parseDecision(decisionResult).value;
  } catch (err) {
    // Timeout/cleanup path: treat missing/expired as no decision so askFallback applies.
    const message = normalizeLowercaseStringOrEmpty(String(err));
    if (message.includes("approval expired or not found")) {
      return null;
    }
    throw err;
  }
}

export async function resolveRegisteredExecApprovalDecision(params: {
  approvalId: string;
  preResolvedDecision: string | null | undefined;
}): Promise<string | null> {
  if (params.preResolvedDecision !== undefined) {
    return params.preResolvedDecision ?? null;
  }
  return await waitForExecApprovalDecision(params.approvalId);
}

export async function requestExecApprovalDecision(
  params: RequestExecApprovalDecisionParams,
): Promise<string | null> {
  const registration = await registerExecApprovalRequest(params);
  if (Object.hasOwn(registration, "finalDecision")) {
    return registration.finalDecision ?? null;
  }
  return await waitForExecApprovalDecision(registration.id);
}

type HostExecApprovalParams = {
  approvalId: string;
  command?: string;
  commandArgv?: string[];
  systemRunPlan?: SystemRunApprovalPlan;
  env?: Record<string, string>;
  workdir: string | undefined;
  host: "gateway" | "node";
  nodeId?: string;
  security: ExecSecurity;
  ask: ExecAsk;
  warningText?: string;
  commandSpans?: ExecApprovalCommandSpan[];
  commandHighlighting?: boolean;
  agentId?: string;
  resolvedPath?: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type ExecApprovalRequesterContext = {
  agentId?: string;
  sessionKey?: string;
};

export function buildExecApprovalRequesterContext(params: ExecApprovalRequesterContext): {
  agentId?: string;
  sessionKey?: string;
} {
  return {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  };
}

type ExecApprovalTurnSourceContext = {
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

export function buildExecApprovalTurnSourceContext(
  params: ExecApprovalTurnSourceContext,
): ExecApprovalTurnSourceContext {
  return {
    turnSourceChannel: params.turnSourceChannel,
    turnSourceTo: params.turnSourceTo,
    turnSourceAccountId: params.turnSourceAccountId,
    turnSourceThreadId: params.turnSourceThreadId,
  };
}

async function resolveCommandSpans(
  command: string | undefined,
): Promise<ExecApprovalCommandSpan[] | undefined> {
  if (!command) {
    return undefined;
  }
  try {
    const { resolveExecApprovalCommandSpans } = await loadExecApprovalCommandSpansRuntime();
    return await resolveExecApprovalCommandSpans(command);
  } catch {
    return undefined;
  }
}

function hasUnsupportedShellArgv(argv: readonly string[] | undefined): boolean {
  if (!argv?.length) {
    return false;
  }
  const shellWrapperArgv = resolveShellWrapperTransportArgv([...argv]) ?? argv;
  const executable = shellWrapperArgv[0];
  if (!executable) {
    return false;
  }
  const normalizedExecutable = normalizeExecutableToken(executable);
  return (
    isShellWrapperExecutable(normalizedExecutable) &&
    !POSIX_COMMAND_HIGHLIGHT_SHELLS.has(normalizedExecutable)
  );
}

function shouldSkipGeneratedCommandSpans(params: HostExecApprovalParams): boolean {
  if (params.host === "gateway" && process.platform === "win32") {
    return true;
  }
  const argv = params.commandArgv?.length ? params.commandArgv : params.systemRunPlan?.argv;
  return hasUnsupportedShellArgv(argv);
}

async function buildHostApprovalDecisionParams(
  params: HostExecApprovalParams,
): Promise<RequestExecApprovalDecisionParams> {
  const commandSpans =
    params.commandHighlighting === true
      ? (params.commandSpans ??
        (shouldSkipGeneratedCommandSpans(params)
          ? undefined
          : await resolveCommandSpans(params.command ?? params.systemRunPlan?.commandText)))
      : undefined;
  return {
    id: params.approvalId,
    command: params.command,
    commandArgv: params.commandArgv,
    systemRunPlan: params.systemRunPlan,
    env: params.env,
    cwd: params.workdir,
    nodeId: params.nodeId,
    host: params.host,
    security: params.security,
    ask: params.ask,
    warningText: params.warningText,
    commandSpans,
    ...buildExecApprovalRequesterContext({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }),
    resolvedPath: params.resolvedPath,
    ...buildExecApprovalTurnSourceContext(params),
  };
}

export async function requestExecApprovalDecisionForHost(
  params: HostExecApprovalParams,
): Promise<string | null> {
  return await requestExecApprovalDecision(await buildHostApprovalDecisionParams(params));
}

export async function registerExecApprovalRequestForHost(
  params: HostExecApprovalParams,
): Promise<ExecApprovalRegistration> {
  return await registerExecApprovalRequest(await buildHostApprovalDecisionParams(params));
}

export async function registerExecApprovalRequestForHostOrThrow(
  params: HostExecApprovalParams,
): Promise<ExecApprovalRegistration> {
  try {
    return await registerExecApprovalRequestForHost(params);
  } catch (err) {
    throw new Error(`Exec approval registration failed: ${String(err)}`, { cause: err });
  }
}
