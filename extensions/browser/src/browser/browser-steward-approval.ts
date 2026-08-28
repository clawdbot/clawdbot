import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BrowserStewardGatewayApprovalClaim } from "openclaw/plugin-sdk/browser-steward-runtime";
import {
  evaluateBrowserStewardRuntimeGuard,
  redactBrowserStewardCredentialMaterial,
  resolveBrowserStewardProxyAction,
  type BrowserStewardSessionBoundary,
} from "./browser-steward-runtime-guard.js";
import { normalizeBrowserRequestPath } from "./request-policy.js";

const BROWSER_STEWARD_GATEWAY_APPROVAL_TTL_MS = 30_000;
const consumedBrowserStewardGatewayAuthorities = new Map<string, number>();
const consumedBrowserStewardGatewayOperationAuthorities = new Map<string, number>();

type BrowserStewardRuntimeApproval = {
  approved: boolean;
  used: boolean;
  rawParams: Record<string, unknown>;
  publicParams: Record<string, unknown>;
  binding: BrowserStewardRuntimeApprovalBinding;
};

export type BrowserStewardRuntimeApprovalBinding = {
  backend: {
    kind: "host" | "sandbox" | "node";
    identity?: string;
  };
  browserNodeSessionLease?: string;
  origin?: string;
  targetRef?: string;
  profile?: string;
};

/** Gateway-issued approval facts carried to a separate browser node. */
type BrowserStewardGatewayApproval = {
  issuer: "gateway.operator.admin";
  command: "browser.proxy" | "browser.proxy.upload.v1";
  action: string;
  profile: string;
  requestFingerprint: string;
  sessionBoundary: BrowserStewardSessionBoundary;
  authorityId: string;
  expiresAtMs: number;
  nodeId: string;
  pairingGeneration: string;
  invocationId: string;
};

/** Opaque authority retained only by one node-host invocation. */
export type BrowserStewardGatewayApprovalAuthority = {
  isActive: () => boolean;
};

function canonicalizeBrowserStewardApprovalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeBrowserStewardApprovalValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  // SAFETY: the guard above excludes null, primitives, and arrays.
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .map((key) => [key, canonicalizeBrowserStewardApprovalValue(record[key])]),
  );
}

function normalizeBrowserStewardApprovalPath(value: string | undefined): string {
  return normalizeBrowserRequestPath(value ?? "");
}

function createBrowserStewardRequestFingerprint(params: {
  command: string;
  method?: string;
  path?: string;
  query?: unknown;
  body?: unknown;
  upload?: unknown;
  profile?: string;
  agentSessionKey?: string;
  agentId?: string;
  nodeId?: string;
  browserNodeSessionLease?: string;
  allowAutomaticHostFallback?: boolean;
}): string {
  const canonical = JSON.stringify(
    canonicalizeBrowserStewardApprovalValue({
      command: params.command,
      method: params.method?.trim().toUpperCase() ?? "GET",
      path: normalizeBrowserStewardApprovalPath(params.path),
      query: params.query,
      body: params.body,
      upload: params.upload,
      profile: params.profile,
      agentSessionKey: params.agentSessionKey,
      agentId: params.agentId,
      nodeId: params.nodeId,
      browserNodeSessionLease: params.browserNodeSessionLease,
      allowAutomaticHostFallback: params.allowAutomaticHostFallback,
    }),
  );
  return createHash("sha256")
    .update(canonical ?? "undefined")
    .digest("hex");
}

type BrowserStewardGatewayApprovalClaimParams = {
  command: string;
  method?: string;
  path?: string;
  query?: unknown;
  body?: unknown;
  upload?: unknown;
  profile?: string;
  agentSessionKey?: string;
  agentId?: string;
  nodeId?: string;
  browserNodeSessionLease?: string;
  allowAutomaticHostFallback?: boolean;
  nowMs?: number;
};

/** Creates a short-lived proof for one exact Browser Gateway request. */
export function createBrowserStewardGatewayApprovalClaim(
  params: BrowserStewardGatewayApprovalClaimParams,
): BrowserStewardGatewayApprovalClaim {
  if (!isBrowserStewardProxyCommand(params.command)) {
    throw new Error("unsupported Browser Steward Gateway operation command");
  }
  return {
    authorityId: randomUUID(),
    requestFingerprint: createBrowserStewardRequestFingerprint(params),
    expiresAtMs: (params.nowMs ?? Date.now()) + BROWSER_STEWARD_GATEWAY_APPROVAL_TTL_MS,
  };
}

type BrowserStewardGatewayApprovalClaimValidationParams =
  BrowserStewardGatewayApprovalClaimParams & {
    approval: unknown;
  };

function readBrowserStewardGatewayApprovalClaim(
  value: unknown,
): BrowserStewardGatewayApprovalClaim | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: the object guard permits structural validation of the private claim fields.
  const claim = value as Partial<BrowserStewardGatewayApprovalClaim>;
  return typeof claim.authorityId === "string" &&
    claim.authorityId.trim() &&
    typeof claim.requestFingerprint === "string" &&
    claim.requestFingerprint.trim() &&
    typeof claim.expiresAtMs === "number" &&
    Number.isSafeInteger(claim.expiresAtMs)
    ? {
        authorityId: claim.authorityId,
        requestFingerprint: claim.requestFingerprint,
        expiresAtMs: claim.expiresAtMs,
      }
    : undefined;
}

/** Redeems the private proof exactly once for the exact Browser Gateway request. */
export function consumeBrowserStewardGatewayApprovalClaimAuthority(
  params: BrowserStewardGatewayApprovalClaimValidationParams,
): BrowserStewardGatewayApprovalAuthority | undefined {
  if (!isBrowserStewardProxyCommand(params.command)) {
    return undefined;
  }
  const claim = readBrowserStewardGatewayApprovalClaim(params.approval);
  if (!claim) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  for (const [authorityId, expiresAtMs] of consumedBrowserStewardGatewayOperationAuthorities) {
    if (expiresAtMs <= nowMs) {
      consumedBrowserStewardGatewayOperationAuthorities.delete(authorityId);
    }
  }
  const expectedFingerprint = createBrowserStewardRequestFingerprint(params);
  if (
    claim.expiresAtMs <= nowMs ||
    consumedBrowserStewardGatewayOperationAuthorities.has(claim.authorityId) ||
    claim.requestFingerprint !== expectedFingerprint
  ) {
    return undefined;
  }
  consumedBrowserStewardGatewayOperationAuthorities.set(claim.authorityId, claim.expiresAtMs);
  return Object.freeze({
    isActive: () => {
      const expiresAtMs = consumedBrowserStewardGatewayOperationAuthorities.get(claim.authorityId);
      const active = expiresAtMs !== undefined && expiresAtMs > Date.now();
      if (!active && expiresAtMs !== undefined) {
        consumedBrowserStewardGatewayOperationAuthorities.delete(claim.authorityId);
      }
      return active && expiresAtMs === claim.expiresAtMs;
    },
  });
}

function isBrowserStewardProxyCommand(
  command: string,
): command is BrowserStewardGatewayApproval["command"] {
  return command === "browser.proxy" || command === "browser.proxy.upload.v1";
}

/** Creates redacted approval facts after a trusted Gateway/admin decision. */
export function createBrowserStewardGatewayApproval(params: {
  command: string;
  method?: string;
  path?: string;
  query?: unknown;
  body?: unknown;
  upload?: unknown;
  profile?: string;
  agentSessionKey?: string;
  agentId?: string;
  nodeId: string;
  pairingGeneration: string;
  invocationId: string;
  nowMs?: number;
}): BrowserStewardGatewayApproval {
  if (!isBrowserStewardProxyCommand(params.command)) {
    throw new Error("unsupported Browser Steward gateway approval command");
  }
  if (!params.nodeId.trim() || !params.pairingGeneration.trim() || !params.invocationId.trim()) {
    throw new Error("incomplete Browser Steward gateway approval authority");
  }
  const decision = evaluateBrowserStewardRuntimeGuard({
    action: resolveBrowserStewardProxyAction({
      method: params.method,
      path: params.path,
      body: params.body,
    }),
    profile: params.profile,
    agentSessionKey: params.agentSessionKey,
    agentId: params.agentId,
    approved: true,
    request: params.body,
  });
  const nowMs = params.nowMs ?? Date.now();
  return {
    issuer: "gateway.operator.admin",
    command: params.command,
    action: decision.requestedAction,
    profile: decision.affectedBrowserProfile,
    requestFingerprint: createBrowserStewardRequestFingerprint(params),
    sessionBoundary: decision.sessionBoundary,
    authorityId: randomUUID(),
    expiresAtMs: nowMs + BROWSER_STEWARD_GATEWAY_APPROVAL_TTL_MS,
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    invocationId: params.invocationId,
  };
}

type BrowserStewardGatewayApprovalValidationParams = {
  approval: unknown;
  command: string;
  method?: string;
  path?: string;
  query?: unknown;
  body?: unknown;
  upload?: unknown;
  profile?: string;
  agentSessionKey?: string;
  agentId?: string;
  nodeId?: string;
  pairingGeneration?: string;
  invocationId?: string;
  nowMs?: number;
};

function readBrowserStewardGatewayApproval(
  value: unknown,
): BrowserStewardGatewayApproval | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: the object guard permits structural validation of the approval fields below.
  const approval = value as Partial<BrowserStewardGatewayApproval>;
  if (
    approval.issuer !== "gateway.operator.admin" ||
    !isBrowserStewardProxyCommand(approval.command ?? "") ||
    typeof approval.action !== "string" ||
    typeof approval.profile !== "string" ||
    typeof approval.requestFingerprint !== "string" ||
    typeof approval.authorityId !== "string" ||
    !approval.authorityId.trim() ||
    typeof approval.expiresAtMs !== "number" ||
    !Number.isSafeInteger(approval.expiresAtMs) ||
    typeof approval.nodeId !== "string" ||
    !approval.nodeId.trim() ||
    typeof approval.pairingGeneration !== "string" ||
    !approval.pairingGeneration.trim() ||
    typeof approval.invocationId !== "string" ||
    !approval.invocationId.trim() ||
    !approval.sessionBoundary ||
    typeof approval.sessionBoundary !== "object"
  ) {
    return undefined;
  }
  // SAFETY: every required approval field is validated immediately above.
  return approval as BrowserStewardGatewayApproval;
}

/** Validates that node-host approval facts match this exact browser request. */
function isBrowserStewardGatewayApprovalValid(
  params: BrowserStewardGatewayApprovalValidationParams,
): boolean {
  if (!isBrowserStewardProxyCommand(params.command)) {
    return false;
  }
  try {
    const approval = readBrowserStewardGatewayApproval(params.approval);
    if (!approval || approval.command !== params.command) {
      return false;
    }
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: resolveBrowserStewardProxyAction({
        method: params.method,
        path: params.path,
        body: params.body,
      }),
      profile: params.profile,
      agentSessionKey: params.agentSessionKey,
      agentId: params.agentId,
      approved: true,
      request: params.body,
    });
    const expectedFingerprint = createBrowserStewardRequestFingerprint(params);
    if (
      approval.action !== decision.requestedAction ||
      approval.profile !== decision.affectedBrowserProfile ||
      approval.requestFingerprint !== expectedFingerprint ||
      !isDeepStrictEqual(approval.sessionBoundary, decision.sessionBoundary)
    ) {
      return false;
    }
    const nowMs = params.nowMs ?? Date.now();
    if (approval.expiresAtMs <= nowMs) {
      return false;
    }
    for (const [authorityId, expiresAtMs] of consumedBrowserStewardGatewayAuthorities) {
      if (expiresAtMs <= nowMs) {
        consumedBrowserStewardGatewayAuthorities.delete(authorityId);
      }
    }
    if (
      !params.nodeId ||
      !params.pairingGeneration ||
      !params.invocationId ||
      !isDeepStrictEqual(
        [approval.nodeId, approval.pairingGeneration, approval.invocationId],
        [params.nodeId, params.pairingGeneration, params.invocationId],
      )
    ) {
      return false;
    }
    return !consumedBrowserStewardGatewayAuthorities.has(approval.authorityId);
  } catch {
    return false;
  }
}

/** Redeems a node-bound Gateway approval and retains its short-lived authority. */
export function consumeBrowserStewardGatewayApprovalAuthority(
  params: BrowserStewardGatewayApprovalValidationParams,
): BrowserStewardGatewayApprovalAuthority | undefined {
  const approval = readBrowserStewardGatewayApproval(params.approval);
  if (
    !approval ||
    !params.nodeId ||
    !params.pairingGeneration ||
    !params.invocationId ||
    !isBrowserStewardGatewayApprovalValid(params)
  ) {
    return undefined;
  }
  consumedBrowserStewardGatewayAuthorities.set(approval.authorityId, approval.expiresAtMs);
  return Object.freeze({
    isActive: () => {
      const nowMs = Date.now();
      const expiresAtMs = consumedBrowserStewardGatewayAuthorities.get(approval.authorityId);
      if (expiresAtMs === undefined || expiresAtMs <= nowMs) {
        if (expiresAtMs !== undefined) {
          consumedBrowserStewardGatewayAuthorities.delete(approval.authorityId);
        }
        return false;
      }
      return expiresAtMs === approval.expiresAtMs;
    },
  });
}

function matchesApprovedPublicParams(
  params: Record<string | symbol, unknown>,
  approval: BrowserStewardRuntimeApproval,
): boolean {
  const candidate = Object.fromEntries(Object.entries(params));
  return isDeepStrictEqual(candidate, approval.publicParams);
}

function cloneBrowserStewardApprovalParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  // SAFETY: params is already the validated string-keyed public approval shape.
  return structuredClone(Object.fromEntries(Object.entries(params))) as Record<string, unknown>;
}

export type BrowserStewardRuntimeApprovalAuthority = {
  approve(params: unknown): void;
  isApproved(params: unknown): boolean;
  getBinding(params: unknown): BrowserStewardRuntimeApprovalBinding | undefined;
  getPromptBinding(params: unknown): BrowserStewardRuntimeApprovalBinding | undefined;
  resolveApprovedParams(params: Record<string, unknown>): Record<string, unknown>;
  resolvePolicyParams(params: unknown): Record<string, unknown>;
  prepare(params: unknown, binding?: BrowserStewardRuntimeApprovalBinding): unknown;
  finalize(params: unknown, preparedParams: unknown): unknown;
};

/** Creates Browser-owned approval state that is never stored on globalThis. */
export function createBrowserStewardRuntimeApprovalAuthority(): BrowserStewardRuntimeApprovalAuthority {
  const approvalMarker = Symbol("browser-steward-runtime-approval");
  const approvals = new WeakMap<object, BrowserStewardRuntimeApproval>();

  const readApproval = (params: unknown): BrowserStewardRuntimeApproval | undefined => {
    if (!params || typeof params !== "object") {
      return undefined;
    }
    // SAFETY: params was narrowed to a non-null object before reading the private marker.
    const token = (params as Record<symbol, unknown>)[approvalMarker];
    return token && typeof token === "object" ? approvals.get(token) : undefined;
  };

  const attachApproval = (
    rawParams: Record<string, unknown>,
    publicParams: Record<string, unknown>,
    approved: boolean,
    binding: BrowserStewardRuntimeApprovalBinding,
  ): Record<string, unknown> => {
    const approvedParams = cloneBrowserStewardApprovalParams(publicParams);
    const token = {};
    approvals.set(token, {
      approved,
      used: false,
      rawParams: cloneBrowserStewardApprovalParams(rawParams),
      publicParams: cloneBrowserStewardApprovalParams(publicParams),
      binding: structuredClone(binding),
    });
    Object.defineProperty(approvedParams, approvalMarker, {
      value: token,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    return approvedParams;
  };

  const markPending = (
    rawParams: Record<string, unknown>,
    publicParams: Record<string, unknown>,
    binding: BrowserStewardRuntimeApprovalBinding,
  ) => attachApproval(rawParams, publicParams, false, binding);

  return Object.freeze({
    approve(params: unknown) {
      const approval = readApproval(params);
      if (approval && !approval.used) {
        approval.approved = true;
      }
    },
    isApproved(params: unknown) {
      const approval = readApproval(params);
      return Boolean(
        approval?.approved &&
        !approval.used &&
        params &&
        typeof params === "object" &&
        // SAFETY: params was narrowed to a non-null object before comparing its public fields.
        matchesApprovedPublicParams(params as Record<string | symbol, unknown>, approval),
      );
    },
    getBinding(params: unknown) {
      const approval = readApproval(params);
      if (
        !approval?.approved ||
        approval.used ||
        !params ||
        typeof params !== "object" ||
        // SAFETY: params was narrowed to a non-null object before comparing its public fields.
        !matchesApprovedPublicParams(params as Record<string | symbol, unknown>, approval)
      ) {
        return undefined;
      }
      return structuredClone(approval.binding);
    },
    getPromptBinding(params: unknown) {
      const approval = readApproval(params);
      if (
        !approval ||
        approval.used ||
        !params ||
        typeof params !== "object" ||
        // SAFETY: params was narrowed to a non-null object before comparing its public fields.
        !matchesApprovedPublicParams(params as Record<string | symbol, unknown>, approval)
      ) {
        return undefined;
      }
      return structuredClone(approval.binding);
    },
    resolveApprovedParams(params: Record<string, unknown>) {
      const approval = readApproval(params);
      if (!approval?.approved || approval.used || !matchesApprovedPublicParams(params, approval)) {
        return params;
      }
      approval.used = true;
      return cloneBrowserStewardApprovalParams(approval.rawParams);
    },
    resolvePolicyParams(params: unknown) {
      const approval = readApproval(params);
      return approval &&
        !approval.used &&
        params &&
        typeof params === "object" &&
        // SAFETY: params was narrowed to a non-null object before comparing its public fields.
        matchesApprovedPublicParams(params as Record<string | symbol, unknown>, approval)
        ? cloneBrowserStewardApprovalParams(approval.rawParams)
        : (params as Record<string, unknown>); // SAFETY: the caller contract supplies browser tool params when no private approval exists.
    },
    prepare(params: unknown, binding?: BrowserStewardRuntimeApprovalBinding) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return params;
      }
      // SAFETY: params was narrowed to a non-null, non-array object before reading tool fields.
      const record = params as Record<string, unknown>;
      const publicParams = redactBrowserStewardCredentialMaterial(record);
      return markPending(
        record,
        // SAFETY: redactBrowserStewardCredentialMaterial returns the string-keyed public shape.
        publicParams as Record<string, unknown>,
        binding ?? resolveBrowserStewardRuntimeApprovalBinding(record),
      );
    },
    finalize(params: unknown, preparedParams: unknown) {
      const approval = readApproval(preparedParams);
      if (
        !approval?.approved ||
        approval.used ||
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        // SAFETY: params was narrowed to a non-null, non-array object before comparison.
        !matchesApprovedPublicParams(params as Record<string | symbol, unknown>, approval)
      ) {
        return params;
      }
      approval.used = true;
      return attachApproval(
        approval.rawParams,
        // SAFETY: params was narrowed to a non-null, non-array object before attaching approval.
        params as Record<string, unknown>,
        true,
        approval.binding,
      );
    },
  });
}

const defaultBrowserStewardRuntimeApprovalAuthority =
  createBrowserStewardRuntimeApprovalAuthority();

/** Activate only the pending marker attached by the Browser Steward policy. */
export function approveBrowserStewardRuntimeParams(
  params: unknown,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): void {
  authority.approve(params);
}

/** True only for params marked by the trusted Browser plugin policy. */
export function isBrowserStewardRuntimeApproved(
  params: unknown,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): boolean {
  return authority.isApproved(params);
}

/** Reads the private destination binding without exposing it through JSON. */
export function getBrowserStewardRuntimeApprovalBinding(
  params: unknown,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): BrowserStewardRuntimeApprovalBinding | undefined {
  return authority.getBinding(params);
}

/** Reads the prepared destination binding while approval is still pending. */
export function getBrowserStewardRuntimeApprovalPromptBinding(
  params: unknown,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): BrowserStewardRuntimeApprovalBinding | undefined {
  return authority.getPromptBinding(params);
}

/** Restores private params after the generic diagnostic wrapper has captured only redacted input. */
export function resolveBrowserStewardRuntimeApprovedParams(
  params: Record<string, unknown>,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): Record<string, unknown> {
  return authority.resolveApprovedParams(params);
}

/** Reads raw params only for the trusted Browser policy/guard, never for diagnostics or hooks. */
export function resolveBrowserStewardRuntimePolicyParams(
  params: unknown,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): Record<string, unknown> {
  return authority.resolvePolicyParams(params);
}

export function resolveBrowserStewardRuntimeApprovalBinding(
  params: Record<string, unknown>,
): BrowserStewardRuntimeApprovalBinding {
  const target = typeof params.target === "string" ? params.target.trim().toLowerCase() : "";
  const requestedNode = typeof params.node === "string" ? params.node.trim() : "";
  const backendKind =
    target === "sandbox" ? "sandbox" : target === "node" || requestedNode ? "node" : "host";
  return {
    backend: {
      kind: backendKind,
      ...(backendKind === "node" && requestedNode ? { identity: requestedNode } : {}),
    },
    ...(typeof params.browserNodeSessionLease === "string" && params.browserNodeSessionLease.trim()
      ? { browserNodeSessionLease: params.browserNodeSessionLease.trim() }
      : {}),
    ...(typeof params.origin === "string" && params.origin.trim()
      ? { origin: params.origin.trim() }
      : {}),
    ...(typeof params.targetRef === "string" && params.targetRef.trim()
      ? { targetRef: params.targetRef.trim() }
      : {}),
    ...(typeof params.profile === "string" && params.profile.trim()
      ? { profile: params.profile.trim() }
      : {}),
  };
}

/** Checks every destination fact that the approval captured; omitted facts stay unknown. */
export function matchesBrowserStewardRuntimeApprovalBindingAtExecution(
  approved: BrowserStewardRuntimeApprovalBinding,
  actual: BrowserStewardRuntimeApprovalBinding,
): boolean {
  return (
    approved.backend.kind === actual.backend.kind &&
    (approved.backend.identity === undefined ||
      approved.backend.identity === actual.backend.identity) &&
    (approved.origin === undefined || approved.origin === actual.origin) &&
    (approved.browserNodeSessionLease === undefined ||
      approved.browserNodeSessionLease === actual.browserNodeSessionLease) &&
    (approved.targetRef === undefined || approved.targetRef === actual.targetRef) &&
    (approved.profile === undefined || approved.profile === actual.profile)
  );
}

/** Prepare a Browser call with an unforgeable, exact-argument approval slot. */
export function prepareBrowserStewardRuntimeParams(
  params: unknown,
  binding?: BrowserStewardRuntimeApprovalBinding,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): unknown {
  return authority.prepare(params, binding);
}

/** Transfer a resolved approval only when the final hook output is unchanged. */
export function finalizeBrowserStewardRuntimeParams(
  params: unknown,
  preparedParams: unknown,
  authority: BrowserStewardRuntimeApprovalAuthority = defaultBrowserStewardRuntimeApprovalAuthority,
): unknown {
  return authority.finalize(params, preparedParams);
}
