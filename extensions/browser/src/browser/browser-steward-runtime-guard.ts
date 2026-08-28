import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  classifyCredentialMaterial,
  evaluateBrowserCredentialExposure,
  type BrowserStewardCredentialExposureKind,
  type BrowserStewardCredentialExposureReasonCode,
} from "./browser-steward-credential-detection.js";
import { normalizeBrowserRequestPath } from "./request-policy.js";
export { redactBrowserStewardCredentialMaterial } from "./browser-steward-credential-detection.js";

export type BrowserStewardRuntimeDecision = {
  boundaryDecision: "allow" | "approval_required";
  requestedAction: string;
  affectedBrowserProfile: string;
  affectedSession: string;
  sessionBoundary: BrowserStewardSessionBoundary;
  credentialExposureKind: BrowserStewardCredentialExposureKind;
  credentialExposureReasonCode: BrowserStewardCredentialExposureReasonCode;
  credentialClassesInvolved: string[];
  dataSensitivity: "low" | "medium" | "high" | "critical";
  approvalRequired: boolean;
  safeNextAction: string;
  telemetryEvent: string;
};

type BrowserStewardRuntimeRequest = {
  action: string;
  profile?: string;
  agentSessionKey?: string;
  agentId?: string;
  approved?: boolean;
  delegated?: boolean;
  request?: unknown;
};

export const BROWSER_STEWARD_AGENT_ID = "browser-session-credential-steward";

type BrowserStewardSessionBoundaryKind =
  | "browser_steward"
  | "other_agent"
  | "global"
  | "unscoped"
  | "unknown";

export type BrowserStewardSessionBoundary = {
  kind: BrowserStewardSessionBoundaryKind;
  ownerAgentId: string;
  affectedSession: string;
};

const NON_SECRET_READ_ACTIONS = new Set(["status", "profiles", "doctor"]);
const ACTION_CREDENTIAL_CLASSES: Record<string, string[]> = {
  start: ["browser profile"],
  stop: ["browser profile"],
  open: ["browser session"],
  focus: ["browser session"],
  close: ["browser session"],
  snapshot: ["browser session", "page content"],
  screenshot: ["browser session", "page image"],
  navigate: ["browser session"],
  console: ["browser session", "page content"],
  pdf: ["authenticated export"],
  upload: ["browser session", "local file"],
  dialog: ["browser session"],
  act: ["browser session", "profile mutation"],
  tabs: ["browser session", "tab metadata"],
};

const UNKNOWN_SESSION_BOUNDARY: BrowserStewardSessionBoundary = {
  kind: "unknown",
  ownerAgentId: "UNKNOWN",
  affectedSession: "UNKNOWN",
};
const UNKNOWN_AGENT_SESSION_BOUNDARY = "agent:UNKNOWN:REDACTED";

const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function resolveBrowserStewardSessionBoundary(
  sessionKey: string | undefined,
): BrowserStewardSessionBoundary {
  const normalized = sessionKey?.trim().toLowerCase();
  if (!normalized) {
    return UNKNOWN_SESSION_BOUNDARY;
  }
  if (normalized === "global") {
    return {
      kind: "global",
      ownerAgentId: "UNKNOWN",
      affectedSession: "GLOBAL",
    };
  }
  const parts = normalized.split(":");
  if (parts[0] !== "agent") {
    return {
      kind: "unscoped",
      ownerAgentId: "UNKNOWN",
      affectedSession: "UNSCOPED",
    };
  }
  const ownerAgentId = parts[1]?.trim();
  const hasMalformedEmptyTail =
    parts.length > 2 && !parts.slice(2).some((part) => part.trim().length > 0);
  if (!ownerAgentId || !VALID_AGENT_ID_RE.test(ownerAgentId) || hasMalformedEmptyTail) {
    return UNKNOWN_SESSION_BOUNDARY;
  }
  if (ownerAgentId === BROWSER_STEWARD_AGENT_ID) {
    return {
      kind: "browser_steward",
      ownerAgentId,
      affectedSession: `agent:${BROWSER_STEWARD_AGENT_ID}:REDACTED`,
    };
  }
  return {
    kind: "other_agent",
    ownerAgentId: "UNKNOWN",
    affectedSession: UNKNOWN_AGENT_SESSION_BOUNDARY,
  };
}

function isBrowserStewardSession(sessionKey: string | undefined): boolean {
  return resolveBrowserStewardSessionBoundary(sessionKey).kind === "browser_steward";
}

function isBrowserStewardAgentId(agentId: string | undefined): boolean {
  return agentId?.trim().toLowerCase() === BROWSER_STEWARD_AGENT_ID;
}

export function shouldApplyBrowserStewardRuntimeGuard(params: {
  sessionKey?: string;
  agentId?: string;
}): boolean {
  return isBrowserStewardSession(params.sessionKey) || isBrowserStewardAgentId(params.agentId);
}

function normalizeProxyPath(value: string): string {
  return normalizeBrowserRequestPath(value);
}

export function resolveBrowserStewardProxyAction(params: {
  method?: string;
  path?: string;
  body?: unknown;
}): string {
  const method = (params.method ?? "GET").trim().toUpperCase();
  const path = normalizeProxyPath(params.path ?? "");
  if (method === "GET" && path === "/") {
    return "status";
  }
  if (method === "GET" && path === "/profiles") {
    return "profiles";
  }
  if (method === "GET" && path === "/doctor") {
    return "doctor";
  }
  if (method === "GET" && path === "/tabs") {
    return "tabs";
  }
  if (method === "POST" && path === "/start") {
    return "start";
  }
  if (method === "POST" && path === "/stop") {
    return "stop";
  }
  if (method === "POST" && path === "/tabs/open") {
    return "open";
  }
  if (method === "POST" && path === "/tabs/focus") {
    return "focus";
  }
  if (method === "DELETE" && path.startsWith("/tabs/")) {
    return "close";
  }
  if (method === "POST" && path === "/act") {
    const kind = isRecord(params.body) ? params.body.kind : undefined;
    return kind === "close" ? "close" : "act";
  }
  if (method === "POST" && path === "/navigate") {
    return "navigate";
  }
  if (method === "POST" && path === "/snapshot") {
    return "snapshot";
  }
  if (method === "POST" && path === "/screenshot") {
    return "screenshot";
  }
  if (method === "POST" && path === "/pdf") {
    return "pdf";
  }
  if (method === "POST" && path === "/hooks/file-chooser") {
    return "upload";
  }
  if (method === "POST" && path === "/hooks/dialog") {
    return "dialog";
  }
  return "unknown";
}

function normalizeAction(value: string): string {
  return value.trim().toLowerCase();
}

function safeRequestedAction(action: string): string {
  if (NON_SECRET_READ_ACTIONS.has(action) || ACTION_CREDENTIAL_CLASSES[action]) {
    return action;
  }
  return "unknown";
}

function uniqueCredentialClasses(values: string[]): string[] {
  const unique = new Set(values);
  return values.filter((value) => {
    if (!unique.has(value)) {
      return false;
    }
    unique.delete(value);
    return true;
  });
}

function redactedBrowserProfile(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "UNKNOWN";
  }
  return VALID_AGENT_ID_RE.test(trimmed) && !classifyCredentialMaterial(trimmed)
    ? trimmed
    : "REDACTED";
}

function hasBrowserStewardIdentityMismatch(params: {
  sessionBoundary: BrowserStewardSessionBoundary;
  agentId?: string;
}): boolean {
  const agentId = params.agentId?.trim().toLowerCase() || undefined;
  if (params.sessionBoundary.kind === "browser_steward") {
    return agentId !== undefined && agentId !== BROWSER_STEWARD_AGENT_ID;
  }
  return params.sessionBoundary.kind === "other_agent" && agentId === BROWSER_STEWARD_AGENT_ID;
}

export function evaluateBrowserStewardRuntimeGuard(
  request: BrowserStewardRuntimeRequest,
): BrowserStewardRuntimeDecision {
  const action = normalizeAction(request.action);
  const requestedAction = safeRequestedAction(action);
  const profile = redactedBrowserProfile(request.profile);
  const sessionBoundary = resolveBrowserStewardSessionBoundary(request.agentSessionKey);
  const credentialExposure = evaluateBrowserCredentialExposure(request);
  const identityMismatch = hasBrowserStewardIdentityMismatch({
    sessionBoundary,
    agentId: request.agentId,
  });
  const credentialClasses = uniqueCredentialClasses([
    ...(ACTION_CREDENTIAL_CLASSES[action] ?? ["browser session"]),
    ...credentialExposure.classes,
  ]);
  const readOnlyAllowed = NON_SECRET_READ_ACTIONS.has(action) && !credentialExposure.blocked;
  const approved = request.approved === true || request.delegated === true;
  const allow = !identityMismatch && (readOnlyAllowed || approved);
  return {
    boundaryDecision: allow ? "allow" : "approval_required",
    requestedAction,
    affectedBrowserProfile: profile,
    affectedSession: sessionBoundary.affectedSession,
    sessionBoundary,
    credentialExposureKind: credentialExposure.exposureKind,
    credentialExposureReasonCode: credentialExposure.reasonCode,
    credentialClassesInvolved: credentialClasses,
    dataSensitivity: readOnlyAllowed ? "low" : credentialExposure.blocked ? "critical" : "high",
    approvalRequired: identityMismatch || !allow,
    safeNextAction: identityMismatch
      ? "reject the mismatched Browser Steward session and agent identity"
      : allow
        ? "proceed with redacted Browser Steward runtime guard metadata"
        : credentialExposure.blocked
          ? "block credential exposure and hand off to Control Director for explicit approval or delegation"
          : "block and hand off to Control Director for explicit approval or delegation",
    telemetryEvent: allow
      ? "browser_steward.boundary_decision"
      : credentialExposure.blocked
        ? "browser_steward.blocked_credential_exposure"
        : "browser_steward.approval_gate",
  };
}

export function assertBrowserStewardRuntimeAllowed(
  request: BrowserStewardRuntimeRequest,
): BrowserStewardRuntimeDecision {
  const decision = evaluateBrowserStewardRuntimeGuard(request);
  if (decision.approvalRequired) {
    throw new Error(
      `Browser Steward runtime guard blocked ${decision.requestedAction}: approval_required; telemetry=${decision.telemetryEvent}; safe_next_action=${decision.safeNextAction}`,
    );
  }
  return decision;
}
