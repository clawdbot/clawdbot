// Device pairing runtime commands for gateway and loopback-local fallback operations.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  readConnectPairingRequiredMessage,
  type ConnectPairingRequiredDetails,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  buildGatewayConnectionDetails,
  callGateway,
  formatGatewayTransportErrorJson,
} from "../gateway/call.js";
import {
  ADMIN_SCOPE,
  PAIRING_SCOPE,
  READ_SCOPE,
  type OperatorScope,
} from "../gateway/method-scopes.js";
import { isLoopbackHost } from "../gateway/net.js";
import {
  approveDevicePairing,
  formatDevicePairingForbiddenMessage,
  listDevicePairing,
  summarizeDeviceTokens,
  type PairedDevice as InfraPairedDevice,
} from "../infra/device-pairing.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../runtime.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../shared/device-pairing-access.js";
import { parseNodeList } from "../shared/node-list-parse.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { formatCliCommand } from "./command-format.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";
import { withProgress } from "./progress.js";
import { quoteCliArg } from "./quote-cli-arg.js";

type DevicesRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
  latest?: boolean;
  yes?: boolean;
  pending?: boolean;
  device?: string;
  role?: string;
  scope?: string[];
  name?: string;
};

type DeviceTokenSummary = {
  role: string;
  scopes?: string[];
  revokedAtMs?: number;
};

type PendingDevice = {
  requestId: string;
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  isRepair?: boolean;
  ts?: number;
};

type PairedDevice = {
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  operatorLabel?: string;
  clientId?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceTokenSummary[];
  createdAtMs?: number;
  approvedAtMs?: number;
};

type DevicePairingList = {
  pending?: PendingDevice[];
  paired?: PairedDevice[];
};

type ApprovePairingGatewayContext = {
  originalRequest: PendingDevice | null;
  scopes?: OperatorScope[];
};

type PendingNodeApprovalNotice = {
  node: NodeListNode;
  command: string;
  connectionReminder: string | null;
};

const FALLBACK_NOTICE = "Direct scope access failed; using local fallback.";
const DEFAULT_DEVICES_TIMEOUT_MS = 10_000;
const FALLBACK_STATE_MISMATCH_MESSAGE =
  "Gateway requires device pairing, but local fallback pairing state does not contain the gateway request.";
const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPE_PREFIX = "operator.";
const KNOWN_NON_ADMIN_OPERATOR_SCOPES = new Set<OperatorScope>([
  "operator.approvals",
  "operator.pairing",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
]);

const callGatewayCli = async (
  method: string,
  opts: DevicesRpcOpts,
  params?: unknown,
  callOpts?: { scopes?: OperatorScope[] },
) =>
  withProgress(
    {
      label: `Devices ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        timeoutMs: parseTimeoutMsWithFallback(opts.timeout, DEFAULT_DEVICES_TIMEOUT_MS),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        scopes: callOpts?.scopes,
      }),
  );

function isPendingNodeApprovalState(
  state: unknown,
): state is "pending-approval" | "pending-reapproval" {
  return state === "pending-approval" || state === "pending-reapproval";
}

function buildNodeApproveCommand(opts: DevicesRpcOpts, requestId: string): string {
  const args = ["openclaw", "nodes", "approve", requestId];
  const timeout = normalizeOptionalString(opts.timeout);
  if (timeout && timeout !== String(DEFAULT_DEVICES_TIMEOUT_MS)) {
    args.push("--timeout", timeout);
  }
  return formatCliCommand(args.map(quoteCliArg).join(" "));
}

function formatNodeConnectionFlagReminder(opts: DevicesRpcOpts): string | null {
  const flags = [
    normalizeOptionalString(opts.url) ? "--url" : null,
    normalizeOptionalString(opts.token) ? "--token" : null,
  ].filter((flag) => flag !== null);
  return flags.length > 0
    ? `Reuse the same connection option${flags.length === 1 ? "" : "s"} when rerunning: ${flags.join(", ")}.`
    : null;
}

async function tryReadPendingNodeApprovals(opts: DevicesRpcOpts): Promise<NodeListNode[]> {
  try {
    return parseNodeList(
      await callGatewayCli("node.list", opts, {}, { scopes: [READ_SCOPE, PAIRING_SCOPE] }),
    ).filter(
      (node) =>
        isPendingNodeApprovalState(node.approvalState) &&
        Boolean(normalizeOptionalString(node.pendingRequestId)),
    );
  } catch {
    return [];
  }
}

function pairedDeviceCanBeNode(device: PairedDevice): boolean {
  return [device.role, ...(device.roles ?? [])].some(
    (role) => normalizeOptionalString(role) === "node",
  );
}

function stringsMatch(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeOptionalString(left);
  const normalizedRight = normalizeOptionalString(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function nodeMatchesPairedDevice(node: NodeListNode, device: PairedDevice): boolean {
  return stringsMatch(node.nodeId, device.deviceId) || stringsMatch(node.remoteIp, device.remoteIp);
}

function nodeMatchesQuery(node: NodeListNode, query: string): boolean {
  return (
    stringsMatch(node.nodeId, query) ||
    stringsMatch(node.remoteIp, query) ||
    stringsMatch(node.pendingRequestId, query)
  );
}

function pairedDeviceMatchesQuery(device: PairedDevice, query: string): boolean {
  return stringsMatch(device.deviceId, query) || stringsMatch(device.remoteIp, query);
}

async function tryReadGatewayPairingList(opts: DevicesRpcOpts): Promise<DevicePairingList | null> {
  try {
    return parseDevicePairingList(
      await callGatewayCli("device.pair.list", opts, {}, { scopes: [PAIRING_SCOPE] }),
    );
  } catch {
    return null;
  }
}

function buildPendingNodeApprovalNoticesForOpts(
  nodes: NodeListNode[],
  opts: DevicesRpcOpts,
): PendingNodeApprovalNotice[] {
  return nodes.flatMap((node) => {
    const requestId = normalizeOptionalString(node.pendingRequestId);
    return requestId
      ? [
          {
            node,
            command: buildNodeApproveCommand(opts, requestId),
            connectionReminder: formatNodeConnectionFlagReminder(opts),
          },
        ]
      : [];
  });
}

function formatNodeApprovalNotice(notice: PendingNodeApprovalNotice): string {
  const action = notice.node.approvalState === "pending-reapproval" ? "reapproval" : "approval";
  const label = sanitizeForLog(
    normalizeOptionalString(notice.node.displayName) ?? notice.node.nodeId,
  );
  const lines = [`Node ${action} pending for ${label}. Run ${sanitizeForLog(notice.command)}`];
  if (notice.connectionReminder) {
    lines.push(notice.connectionReminder);
  }
  return lines.join("\n");
}

async function findPairedDevicePendingNodeApprovalNotices(
  opts: DevicesRpcOpts,
  paired: PairedDevice[] | undefined,
): Promise<PendingNodeApprovalNotice[]> {
  const nodeDevices = (paired ?? []).filter(pairedDeviceCanBeNode);
  if (nodeDevices.length === 0) {
    return [];
  }
  const nodes = await tryReadPendingNodeApprovals(opts);
  return buildPendingNodeApprovalNoticesForOpts(
    nodes.filter((node) => nodeDevices.some((device) => nodeMatchesPairedDevice(node, device))),
    opts,
  );
}

async function findQueryPendingNodeApprovalNotices(
  opts: DevicesRpcOpts,
  query: string,
): Promise<PendingNodeApprovalNotice[]> {
  const nodes = await tryReadPendingNodeApprovals(opts);
  const directMatches = nodes.filter((node) => nodeMatchesQuery(node, query));
  if (directMatches.length > 0) {
    return buildPendingNodeApprovalNoticesForOpts(directMatches, opts);
  }
  const pairingList = await tryReadGatewayPairingList(opts);
  const pairedMatches = (pairingList?.paired ?? []).filter((device) =>
    pairedDeviceMatchesQuery(device, query),
  );
  return buildPendingNodeApprovalNoticesForOpts(
    nodes.filter((node) => pairedMatches.some((device) => nodeMatchesPairedDevice(node, device))),
    opts,
  );
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isDevicePairingApprovalDenied(error: unknown): boolean {
  return normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error)).includes(
    "device pairing approval denied",
  );
}

function isUnknownRequestIdError(error: unknown): boolean {
  const maybeGatewayError =
    typeof error === "object" && error !== null
      ? (error as { gatewayCode?: unknown; message?: unknown })
      : undefined;
  const gatewayCode = maybeGatewayError?.gatewayCode;
  if (gatewayCode !== undefined && gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message =
    typeof maybeGatewayError?.message === "string"
      ? maybeGatewayError.message
      : normalizeErrorMessage(error);
  return normalizeLowercaseStringOrEmpty(message).includes("unknown requestid");
}

function isScopeUpgradePendingApproval(error: unknown): boolean {
  return (
    readConnectPairingRequiredMessage(normalizeErrorMessage(error))?.reason === "scope-upgrade"
  );
}

function resolveLocalPairingFallback(
  opts: DevicesRpcOpts,
  error: unknown,
): { details: ConnectPairingRequiredDetails } | null {
  // Local fallback is only safe for implicit loopback gateway URLs.
  const message = normalizeLowercaseStringOrEmpty(normalizeErrorMessage(error));
  const details = readConnectPairingRequiredMessage(message);
  if (!details) {
    return null;
  }
  if (typeof opts.url === "string" && opts.url.trim().length > 0) {
    // Explicit --url might point at a remote/tunneled gateway; never silently
    // switch to local pairing files in that case.
    return null;
  }
  const connection = buildGatewayConnectionDetails();
  if (connection.urlSource !== "local loopback") {
    return null;
  }
  try {
    return isLoopbackHost(new URL(connection.url).hostname) ? { details } : null;
  } catch {
    return null;
  }
}

function buildFallbackStateMismatchError(details: ConnectPairingRequiredDetails): Error {
  return new Error(
    [
      details.requestId
        ? `${FALLBACK_STATE_MISMATCH_MESSAGE} Missing requestId: ${details.requestId}.`
        : FALLBACK_STATE_MISMATCH_MESSAGE,
      "The running gateway is probably using a different OPENCLAW_PROFILE or OPENCLAW_STATE_DIR than this CLI.",
      "Rerun with the same profile/state-dir as the gateway, or pass --token/--password so the CLI can approve through the gateway.",
    ].join("\n"),
  );
}

function assertLocalFallbackMatchesGatewayRequest(
  details: ConnectPairingRequiredDetails,
  list: DevicePairingList,
) {
  const requestId = normalizeOptionalString(details.requestId);
  if (!requestId) {
    return;
  }
  const hasRequest = (list.pending ?? []).some(
    (request) => normalizeOptionalString(request.requestId) === requestId,
  );
  if (!hasRequest) {
    throw buildFallbackStateMismatchError(details);
  }
}

function redactLocalPairedDevice(device: InfraPairedDevice): PairedDevice {
  const { tokens, ...rest } = device;
  return {
    ...(rest as unknown as PairedDevice),
    tokens: summarizeDeviceTokens(tokens) as DeviceTokenSummary[] | undefined,
  };
}

async function listPairingWithFallback(opts: DevicesRpcOpts): Promise<DevicePairingList> {
  try {
    return parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
  } catch (error) {
    const fallback = resolveLocalPairingFallback(opts, error);
    if (!fallback) {
      throw error;
    }
    const local = await listDevicePairing();
    const list = {
      pending: local.pending as PendingDevice[],
      paired: local.paired.map((device) => redactLocalPairedDevice(device)),
    };
    assertLocalFallbackMatchesGatewayRequest(fallback.details, list);
    if (opts.json !== true) {
      defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
    }
    return list;
  }
}

async function approvePairingWithFallback(
  opts: DevicesRpcOpts,
  requestId: string,
): Promise<Record<string, unknown> | null> {
  const { scopes, originalRequest } = await resolveApprovePairingGatewayContext(opts, requestId);
  try {
    return await callGatewayCli(
      "device.pair.approve",
      opts,
      { requestId },
      scopes ? { scopes } : undefined,
    );
  } catch (error) {
    if (isDevicePairingApprovalDenied(error) && !scopes?.includes(ADMIN_SCOPE)) {
      try {
        return await callGatewayCli(
          "device.pair.approve",
          opts,
          { requestId },
          { scopes: [ADMIN_SCOPE] },
        );
      } catch (adminError) {
        if (isUnknownRequestIdError(adminError)) {
          return null;
        }
        throw adminError;
      }
    }
    const fallback = resolveLocalPairingFallback(opts, error);
    if (!fallback) {
      if (isUnknownRequestIdError(error)) {
        return null;
      }
      throw error;
    }
    const gatewayRequestId = normalizeOptionalString(fallback.details.requestId);
    if (gatewayRequestId && gatewayRequestId !== requestId) {
      const local = await listDevicePairing();
      const localList = {
        pending: local.pending as PendingDevice[],
        paired: local.paired.map((device) => redactLocalPairedDevice(device)),
      };
      const replacement = findSameDeviceReplacementRequest({
        originalRequest,
        originalRequestId: requestId,
        gatewayRequestId,
        pending: localList.pending,
        paired: localList.paired,
      });
      if (replacement) {
        const approved = await approveDevicePairing(replacement.requestId, {
          callerScopes: ["operator.admin"],
        });
        if (!approved) {
          return null;
        }
        if (approved.status === "forbidden") {
          throw new Error(formatDevicePairingForbiddenMessage(approved), { cause: error });
        }
        if (opts.json !== true) {
          defaultRuntime.log(
            theme.warn(
              `Pending request ${sanitizeForLog(requestId)} was replaced by same-device repair ${sanitizeForLog(replacement.requestId)}; approving latest compatible request.`,
            ),
          );
          defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
        }
        return {
          requestId: replacement.requestId,
          resolved: {
            kind: "same-device-replacement",
            requestedRequestId: requestId,
            approvedRequestId: replacement.requestId,
          },
          device: redactLocalPairedDevice(approved.device),
        };
      }
      const hasOriginalPending = Boolean(findPendingRequestById(localList.pending, requestId));
      const hasGatewayPending = Boolean(
        findPendingRequestById(localList.pending, gatewayRequestId),
      );
      if (!hasOriginalPending && !hasGatewayPending) {
        return null;
      }
      throw buildFallbackStateMismatchError(fallback.details);
    }
    const approved = await approveDevicePairing(requestId, {
      // Local CLI fallback already assumes direct machine access; treat it as an
      // explicit admin approval path instead of relying on missing caller scopes.
      callerScopes: ["operator.admin"],
    });
    if (!approved) {
      if (gatewayRequestId && gatewayRequestId === requestId) {
        throw buildFallbackStateMismatchError(fallback.details);
      }
      return null;
    }
    if (approved.status === "forbidden") {
      throw new Error(formatDevicePairingForbiddenMessage(approved), { cause: error });
    }
    if (opts.json !== true) {
      defaultRuntime.log(theme.warn(FALLBACK_NOTICE));
    }
    return {
      requestId,
      device: redactLocalPairedDevice(approved.device),
    };
  }
}

function parseDevicePairingList(value: unknown): DevicePairingList {
  const obj = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    pending: Array.isArray(obj.pending) ? (obj.pending as PendingDevice[]) : [],
    paired: Array.isArray(obj.paired) ? (obj.paired as PairedDevice[]) : [],
  };
}

function normalizeDeviceRoles(request: PendingDevice): string[] {
  const roles = new Set<string>();
  for (const role of request.roles ?? []) {
    const normalized = normalizeOptionalString(role);
    if (normalized) {
      roles.add(normalized);
    }
  }
  const role = normalizeOptionalString(request.role);
  if (role) {
    roles.add(role);
  }
  return [...roles];
}

function normalizeOperatorScopes(scopes: string[] | undefined): string[] {
  return normalizeDeviceAuthScopes(scopes).filter((scope) =>
    scope.startsWith(OPERATOR_SCOPE_PREFIX),
  );
}

function findPendingRequestById(
  pending: PendingDevice[] | undefined,
  requestId: string | null | undefined,
): PendingDevice | null {
  const normalizedRequestId = normalizeOptionalString(requestId);
  if (!normalizedRequestId) {
    return null;
  }
  return (
    pending?.find(
      (request) => normalizeOptionalString(request.requestId) === normalizedRequestId,
    ) ?? null
  );
}

function hasExactRoleMatch(original: PendingDevice, replacement: PendingDevice): boolean {
  const originalRoles = normalizeDeviceRoles(original);
  const replacementRoles = normalizeDeviceRoles(replacement);
  if (originalRoles.length !== replacementRoles.length) {
    return false;
  }
  const replacementRoleSet = new Set(replacementRoles);
  return originalRoles.every((role) => replacementRoleSet.has(role));
}

function hasCompatibleClientMetadata(original: PendingDevice, replacement: PendingDevice): boolean {
  const originalClientId = normalizeOptionalString(original.clientId);
  const replacementClientId = normalizeOptionalString(replacement.clientId);
  if (originalClientId && replacementClientId && originalClientId !== replacementClientId) {
    return false;
  }
  const originalClientMode = normalizeOptionalString(original.clientMode);
  const replacementClientMode = normalizeOptionalString(replacement.clientMode);
  return !(
    originalClientMode &&
    replacementClientMode &&
    originalClientMode !== replacementClientMode
  );
}

function resolveOriginalReplacementScopes(
  original: PendingDevice,
  paired: PairedDevice | undefined,
): string[] {
  const requestedScopes = normalizeDeviceAuthScopes(original.scopes);
  const inferredOperatorScopes = resolvePendingOperatorApprovalScopes(original, paired);
  return uniqueStrings([...requestedScopes, ...inferredOperatorScopes]);
}

function replacementScopesCoverOriginal(
  original: PendingDevice,
  replacement: PendingDevice,
  paired: PairedDevice | undefined,
): boolean {
  const originalScopes = resolveOriginalReplacementScopes(original, paired);
  const replacementScopes = normalizeDeviceAuthScopes(replacement.scopes);
  const replacementScopeSet = new Set(replacementScopes);
  if (!originalScopes.every((scope) => replacementScopeSet.has(scope))) {
    return false;
  }
  // Same-device repair reconnects can supersede a stale request with a combined
  // request that appends the pairing scope required for the repaired session to
  // reconnect and complete approval.
  return replacementScopes.every(
    (scope) => originalScopes.includes(scope) || scope === PAIRING_SCOPE,
  );
}

function findSameDeviceReplacementRequest(params: {
  originalRequest: PendingDevice | null;
  originalRequestId: string;
  gatewayRequestId: string;
  pending: PendingDevice[] | undefined;
  paired: PairedDevice[] | undefined;
}): PendingDevice | null {
  const originalRequestId = normalizeOptionalString(params.originalRequestId);
  if (!params.originalRequest || !originalRequestId) {
    // Without the pre-approve snapshot we cannot prove that the gateway's newer
    // request is the same-device repair contract the operator intended to approve.
    return null;
  }
  if (normalizeOptionalString(params.originalRequest.requestId) !== originalRequestId) {
    return null;
  }
  const replacement = findPendingRequestById(params.pending, params.gatewayRequestId);
  if (!replacement) {
    return null;
  }
  const originalDeviceId = normalizeOptionalString(params.originalRequest.deviceId);
  const replacementDeviceId = normalizeOptionalString(replacement.deviceId);
  if (!originalDeviceId || originalDeviceId !== replacementDeviceId) {
    return null;
  }
  const originalPublicKey = normalizeOptionalString(params.originalRequest.publicKey);
  const replacementPublicKey = normalizeOptionalString(replacement.publicKey);
  if (!originalPublicKey || !replacementPublicKey || originalPublicKey !== replacementPublicKey) {
    return null;
  }
  if (!hasExactRoleMatch(params.originalRequest, replacement)) {
    return null;
  }
  if (!hasCompatibleClientMetadata(params.originalRequest, replacement)) {
    return null;
  }
  const pairedByDeviceId = indexPairedDevices(params.paired);
  const originalPaired = lookupPairedDevice(pairedByDeviceId, params.originalRequest);
  const replacementPaired = lookupPairedDevice(pairedByDeviceId, replacement);
  if (!replacementScopesCoverOriginal(params.originalRequest, replacement, originalPaired)) {
    return null;
  }
  if (replacement.isRepair !== true && (!originalPaired || !replacementPaired)) {
    return null;
  }
  return replacement;
}

function resolvePairedOperatorScopes(paired: PairedDevice | undefined): string[] {
  const operatorToken = paired?.tokens?.find((token) => {
    const role = normalizeOptionalString(token.role);
    return role === OPERATOR_ROLE && !token.revokedAtMs;
  });
  return normalizeOperatorScopes(operatorToken?.scopes ?? paired?.scopes);
}

function resolvePendingOperatorApprovalScopes(
  request: PendingDevice,
  paired: PairedDevice | undefined,
): string[] {
  if (!normalizeDeviceRoles(request).includes(OPERATOR_ROLE)) {
    return [];
  }
  const requestedScopes = normalizeOperatorScopes(request.scopes);
  return requestedScopes.length > 0 ? requestedScopes : resolvePairedOperatorScopes(paired);
}

function isKnownNonAdminOperatorScope(scope: string): scope is OperatorScope {
  return KNOWN_NON_ADMIN_OPERATOR_SCOPES.has(scope as OperatorScope);
}

function resolveApprovePairingScopesForRequest(
  request: PendingDevice,
  paired: PairedDevice | undefined,
): OperatorScope[] | undefined {
  const operatorScopes = resolvePendingOperatorApprovalScopes(request, paired);
  if (operatorScopes.length === 0) {
    return undefined;
  }
  if (operatorScopes.includes(ADMIN_SCOPE)) {
    return [ADMIN_SCOPE];
  }
  const out = new Set<OperatorScope>([PAIRING_SCOPE]);
  for (const scope of operatorScopes) {
    if (!isKnownNonAdminOperatorScope(scope)) {
      return [ADMIN_SCOPE];
    }
    out.add(scope);
  }
  return [...out];
}

async function resolveApprovePairingGatewayContext(
  opts: DevicesRpcOpts,
  requestId: string,
): Promise<ApprovePairingGatewayContext> {
  try {
    const list = await listPairingWithFallback(opts);
    const request = findPendingRequestById(list.pending, requestId);
    if (!request) {
      return { originalRequest: null, scopes: undefined };
    }
    return {
      originalRequest: request,
      scopes: resolveApprovePairingScopesForRequest(
        request,
        lookupPairedDevice(indexPairedDevices(list.paired), request),
      ),
    };
  } catch {
    return { originalRequest: null, scopes: undefined };
  }
}

function selectLatestPendingRequest(pending: PendingDevice[] | undefined) {
  if (!pending?.length) {
    return null;
  }
  return pending.reduce((latest, current) => {
    const latestTs = typeof latest.ts === "number" ? latest.ts : 0;
    const currentTs = typeof current.ts === "number" ? current.ts : 0;
    return currentTs > latestTs ? current : latest;
  });
}

function formatTokenSummary(tokens: DeviceTokenSummary[] | undefined) {
  if (!tokens || tokens.length === 0) {
    return "none";
  }
  const parts = tokens
    .map((t) => `${sanitizeForLog(t.role)}${t.revokedAtMs ? " (revoked)" : ""}`)
    .toSorted((a, b) => a.localeCompare(b));
  return parts.join(", ");
}

function formatPendingDeviceIdentity(request: PendingDevice): string {
  const displayName = normalizeOptionalString(request.displayName);
  if (displayName) {
    return sanitizeForLog(displayName);
  }
  return sanitizeForLog(normalizeOptionalString(request.deviceId) ?? "");
}

function formatAccessSummary(access: DevicePairingAccessSummary | null): string {
  if (!access) {
    return "none";
  }
  const roles =
    access.roles.length > 0 ? access.roles.map((role) => sanitizeForLog(role)).join(", ") : "none";
  const scopes =
    access.scopes.length > 0
      ? access.scopes.map((scope) => sanitizeForLog(scope)).join(", ")
      : "none";
  return `roles: ${roles}; scopes: ${scopes}`;
}

function formatPendingApprovalKind(kind: PendingDeviceApprovalKind): string {
  switch (kind) {
    case "new-pairing":
      return "new pairing";
    case "role-upgrade":
      return "role upgrade";
    case "scope-upgrade":
      return "scope upgrade";
    case "re-approval":
      return "re-approval";
  }
  const exhaustiveKind: never = kind;
  void exhaustiveKind;
  throw new Error("unsupported pending approval kind");
}

function indexPairedDevices(paired: PairedDevice[] | undefined): Map<string, PairedDevice> {
  const out = new Map<string, PairedDevice>();
  for (const device of paired ?? []) {
    const deviceId = normalizeOptionalString(device.deviceId);
    if (deviceId) {
      out.set(deviceId, device);
    }
  }
  return out;
}

function lookupPairedDevice(
  pairedByDeviceId: ReadonlyMap<string, PairedDevice>,
  request: Pick<PendingDevice, "deviceId" | "publicKey">,
): PairedDevice | undefined {
  const normalizedDeviceId = normalizeOptionalString(request.deviceId);
  if (!normalizedDeviceId) {
    return undefined;
  }
  const paired = pairedByDeviceId.get(normalizedDeviceId);
  if (!paired) {
    return undefined;
  }
  const requestPublicKey = normalizeOptionalString(request.publicKey);
  const pairedPublicKey = normalizeOptionalString(paired.publicKey);
  if (requestPublicKey && pairedPublicKey && requestPublicKey !== pairedPublicKey) {
    return undefined;
  }
  return paired;
}

function buildExplicitApproveCommand(opts: DevicesRpcOpts, requestId: string): string {
  const args = ["openclaw", "devices", "approve", requestId];
  const url = normalizeOptionalString(opts.url);
  if (url) {
    args.push("--url", url);
  }
  const timeout = normalizeOptionalString(opts.timeout);
  if (timeout && timeout !== String(DEFAULT_DEVICES_TIMEOUT_MS)) {
    args.push("--timeout", timeout);
  }
  if (opts.json === true) {
    args.push("--json");
  }
  return args.map(quoteCliArg).join(" ");
}

function formatAuthFlagReminder(opts: DevicesRpcOpts): string {
  const flags: string[] = [];
  if (normalizeOptionalString(opts.token)) {
    flags.push("--token");
  }
  if (normalizeOptionalString(opts.password)) {
    flags.push("--password");
  }
  if (flags.length === 0) {
    return "";
  }
  return `Reuse the same ${flags.join("/")} option${flags.length === 1 ? "" : "s"} when rerunning.`;
}

function resolveRequiredDeviceRole(
  opts: DevicesRpcOpts,
): { deviceId: string; role: string } | null {
  const deviceId = normalizeStringifiedOptionalString(opts.device) ?? "";
  const role = normalizeStringifiedOptionalString(opts.role) ?? "";
  if (deviceId && role) {
    return { deviceId, role };
  }
  defaultRuntime.error(
    `--device and --role are required. Run ${formatCliCommand("openclaw devices list")} to choose a paired device.`,
  );
  defaultRuntime.exit(1);
  return null;
}

export async function runDevicesListCommand(opts: DevicesRpcOpts): Promise<void> {
  let list: DevicePairingList;
  try {
    list = await listPairingWithFallback(opts);
  } catch (error) {
    if (opts.json) {
      const payload = formatGatewayTransportErrorJson(error);
      if (payload) {
        defaultRuntime.writeJson(payload);
        defaultRuntime.exit(1);
        return;
      }
    }
    throw error;
  }
  const pairedByDeviceId = indexPairedDevices(list.paired);
  if (opts.json) {
    defaultRuntime.writeJson(list);
    return;
  }
  if (list.pending?.length) {
    const tableWidth = getTerminalTableWidth();
    defaultRuntime.log(`${theme.heading("Pending")} ${theme.muted(`(${list.pending.length})`)}`);
    defaultRuntime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Request", header: "Request", minWidth: 10 },
          { key: "Device", header: "Device", minWidth: 16, flex: true },
          { key: "Requested", header: "Requested", minWidth: 20, flex: true },
          { key: "Approved", header: "Approved", minWidth: 20, flex: true },
          { key: "Age", header: "Age", minWidth: 8 },
          { key: "Status", header: "Status", minWidth: 12 },
        ],
        rows: list.pending.map((req) => {
          const approval = resolvePendingDeviceApprovalState(
            req,
            lookupPairedDevice(pairedByDeviceId, req),
          );
          const statusParts = [formatPendingApprovalKind(approval.kind)];
          if (req.isRepair) {
            statusParts.push("repair");
          }
          return {
            Request: req.requestId,
            Device: `${formatPendingDeviceIdentity(req)}${req.remoteIp ? ` · ${sanitizeForLog(req.remoteIp)}` : ""}`,
            Requested: formatAccessSummary(approval.requested),
            Approved: formatAccessSummary(approval.approved),
            Age: typeof req.ts === "number" ? formatTimeAgo(Date.now() - req.ts) : "",
            Status: statusParts.join(", "),
          };
        }),
      }).trimEnd(),
    );
  }
  if (list.paired?.length) {
    const tableWidth = getTerminalTableWidth();
    defaultRuntime.log(`${theme.heading("Paired")} ${theme.muted(`(${list.paired.length})`)}`);
    defaultRuntime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Device", header: "Device", minWidth: 16, flex: true },
          { key: "Roles", header: "Roles", minWidth: 12, flex: true },
          { key: "Scopes", header: "Scopes", minWidth: 12, flex: true },
          { key: "Tokens", header: "Tokens", minWidth: 12, flex: true },
          { key: "IP", header: "IP", minWidth: 12 },
        ],
        rows: list.paired.map((device) => ({
          Device: sanitizeForLog(
            device.operatorLabel || device.displayName || device.clientId || device.deviceId,
          ),
          Roles: device.roles?.length
            ? device.roles.map((role) => sanitizeForLog(role)).join(", ")
            : "",
          Scopes: device.scopes?.length
            ? device.scopes.map((scope) => sanitizeForLog(scope)).join(", ")
            : "",
          Tokens: formatTokenSummary(device.tokens),
          IP: device.remoteIp ? sanitizeForLog(device.remoteIp) : "",
        })),
      }).trimEnd(),
    );
    const nodeApprovalNotices = await findPairedDevicePendingNodeApprovalNotices(opts, list.paired);
    for (const notice of nodeApprovalNotices) {
      defaultRuntime.log(theme.warn(formatNodeApprovalNotice(notice)));
    }
  }
  if (!list.pending?.length && !list.paired?.length) {
    defaultRuntime.log(theme.muted("No device pairing entries."));
  }
}

export async function runDevicesRemoveCommand(
  deviceId: string,
  opts: DevicesRpcOpts,
): Promise<void> {
  const trimmed = deviceId.trim();
  if (!trimmed) {
    defaultRuntime.error(
      `deviceId is required. Run ${formatCliCommand("openclaw devices list")} to choose a paired device.`,
    );
    defaultRuntime.exit(1);
    return;
  }
  const result = await callGatewayCli("device.pair.remove", opts, { deviceId: trimmed });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(`${theme.warn("Removed")} ${theme.command(trimmed)}`);
}

export async function runDevicesClearCommand(opts: DevicesRpcOpts): Promise<void> {
  if (!opts.yes) {
    defaultRuntime.error("Refusing to clear pairing table without --yes");
    defaultRuntime.exit(1);
    return;
  }
  const list = parseDevicePairingList(await callGatewayCli("device.pair.list", opts, {}));
  const removedDeviceIds: string[] = [];
  const rejectedRequestIds: string[] = [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  for (const device of paired) {
    const deviceId = normalizeOptionalString(device.deviceId) ?? "";
    if (!deviceId) {
      continue;
    }
    await callGatewayCli("device.pair.remove", opts, { deviceId });
    removedDeviceIds.push(deviceId);
  }
  if (opts.pending) {
    const pending = Array.isArray(list.pending) ? list.pending : [];
    for (const req of pending) {
      const requestId = normalizeOptionalString(req.requestId) ?? "";
      if (!requestId) {
        continue;
      }
      await callGatewayCli("device.pair.reject", opts, { requestId });
      rejectedRequestIds.push(requestId);
    }
  }
  if (opts.json) {
    defaultRuntime.writeJson({
      removedDevices: removedDeviceIds,
      rejectedPending: rejectedRequestIds,
    });
    return;
  }
  defaultRuntime.log(
    `${theme.warn("Cleared")} ${removedDeviceIds.length} paired device${removedDeviceIds.length === 1 ? "" : "s"}`,
  );
  if (opts.pending) {
    defaultRuntime.log(
      `${theme.warn("Rejected")} ${rejectedRequestIds.length} pending request${rejectedRequestIds.length === 1 ? "" : "s"}`,
    );
  }
}

export async function runDevicesApproveCommand(
  requestId: string | undefined,
  opts: DevicesRpcOpts,
): Promise<void> {
  let pairingList: DevicePairingList | null = null;
  let resolvedRequestId = requestId?.trim();
  const usingImplicitSelection = !resolvedRequestId || Boolean(opts.latest);
  let selectedRequest: PendingDevice | null = null;
  if (usingImplicitSelection) {
    pairingList = await listPairingWithFallback(opts);
    selectedRequest = selectLatestPendingRequest(pairingList.pending);
    resolvedRequestId = selectedRequest?.requestId?.trim();
  }
  if (!resolvedRequestId) {
    defaultRuntime.error("No pending device pairing requests to approve");
    defaultRuntime.exit(1);
    return;
  }
  if (usingImplicitSelection) {
    // Keep implicit selection preview-only. A second command with the exact
    // requestId binds the approval to the request the operator inspected.
    const req = selectedRequest!;
    const approval = resolvePendingDeviceApprovalState(
      req,
      lookupPairedDevice(indexPairedDevices(pairingList?.paired), req),
    );
    const approveCommand = buildExplicitApproveCommand(opts, req.requestId);
    const authReminder = formatAuthFlagReminder(opts);
    if (opts.json) {
      defaultRuntime.writeJson({
        selected: req,
        approvalState: {
          kind: approval.kind,
          requested: approval.requested,
          approved: approval.approved,
        },
        approveCommand,
        requiresAuthFlags: {
          token: Boolean(normalizeOptionalString(opts.token)),
          password: Boolean(normalizeOptionalString(opts.password)),
        },
      });
      defaultRuntime.exit(1);
      return;
    }
    defaultRuntime.log(
      `${theme.warn("Selected pending device request")} ${theme.command(req.requestId)}`,
    );
    defaultRuntime.log(`  Device: ${formatPendingDeviceIdentity(req)}`);
    defaultRuntime.log(`  Requested: ${formatAccessSummary(approval.requested)}`);
    if (approval.approved) {
      defaultRuntime.log(`  Approved: ${formatAccessSummary(approval.approved)}`);
    }
    if (req.remoteIp) {
      defaultRuntime.log(`  IP:     ${sanitizeForLog(req.remoteIp)}`);
    }
    switch (approval.kind) {
      case "scope-upgrade":
        defaultRuntime.log(
          "  Note:   Already paired. Requested scopes exceed the current approval, so reconnect stays blocked until you approve this upgrade.",
        );
        break;
      case "role-upgrade":
        defaultRuntime.log(
          "  Note:   Already paired. Requested role exceeds the current approval, so reconnect stays blocked until you approve this upgrade.",
        );
        break;
      case "re-approval":
        defaultRuntime.log(
          "  Note:   Already paired. Approval-bound device details changed, so OpenClaw created a fresh request instead of silently reusing the old approval.",
        );
        break;
      case "new-pairing":
        defaultRuntime.log("  Note:   First-time device pairing request.");
        break;
    }
    defaultRuntime.error(`Approve this exact request with: ${approveCommand}`);
    if (authReminder) {
      defaultRuntime.error(authReminder);
    }
    defaultRuntime.exit(1);
    return;
  }
  let result: Record<string, unknown> | null;
  try {
    result = await approvePairingWithFallback(opts, resolvedRequestId);
  } catch (error) {
    if (isScopeUpgradePendingApproval(error)) {
      defaultRuntime.error(
        "This device can't approve its own scope upgrade. Approve it from the Control UI or another authorized device.",
      );
      defaultRuntime.exit(1);
      return;
    }
    throw error;
  }
  if (!result) {
    defaultRuntime.error(
      `No pending device request matches ${sanitizeForLog(resolvedRequestId)}. Run ${formatCliCommand("openclaw devices list")} and retry with the current request ID.`,
    );
    const nodeApprovalNotices = await findQueryPendingNodeApprovalNotices(opts, resolvedRequestId);
    for (const notice of nodeApprovalNotices) {
      defaultRuntime.error(formatNodeApprovalNotice(notice));
    }
    defaultRuntime.exit(1);
    return;
  }
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  const resultRequestId = (result as { requestId?: unknown })?.requestId;
  const approvedRequestId =
    typeof resultRequestId === "string" && resultRequestId.trim().length > 0
      ? resultRequestId
      : resolvedRequestId;
  const deviceId = (result as { device?: { deviceId?: string } })?.device?.deviceId;
  defaultRuntime.log(
    `${theme.success("Approved")} ${theme.command(deviceId ?? "ok")} ${theme.muted(`(${approvedRequestId})`)}`,
  );
}

export async function runDevicesRejectCommand(
  requestId: string,
  opts: DevicesRpcOpts,
): Promise<void> {
  const result = await callGatewayCli("device.pair.reject", opts, { requestId });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  const deviceId = (result as { deviceId?: string })?.deviceId;
  defaultRuntime.log(`${theme.warn("Rejected")} ${theme.command(deviceId ?? "ok")}`);
}

export async function runDevicesRenameCommand(opts: DevicesRpcOpts): Promise<void> {
  const deviceId = normalizeStringifiedOptionalString(opts.device) ?? "";
  const label = normalizeStringifiedOptionalString(opts.name) ?? "";
  if (!deviceId || !label) {
    defaultRuntime.error(
      `--device and --name are required. Run ${formatCliCommand("openclaw devices list")} to choose a paired device.`,
    );
    defaultRuntime.exit(1);
    return;
  }
  const result = await callGatewayCli("device.pair.rename", opts, { deviceId, label });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(
    `${theme.success("Renamed")} ${theme.command(deviceId)} ${theme.muted("→")} ${sanitizeForLog(label)}`,
  );
}

export async function runDevicesRotateCommand(opts: DevicesRpcOpts): Promise<void> {
  const required = resolveRequiredDeviceRole(opts);
  if (!required) {
    return;
  }
  const result = await callGatewayCli("device.token.rotate", opts, {
    deviceId: required.deviceId,
    role: required.role,
    scopes: Array.isArray(opts.scope) ? opts.scope : undefined,
  });
  defaultRuntime.writeJson(result);
}

export async function runDevicesRevokeCommand(opts: DevicesRpcOpts): Promise<void> {
  const required = resolveRequiredDeviceRole(opts);
  if (!required) {
    return;
  }
  const result = await callGatewayCli("device.token.revoke", opts, {
    deviceId: required.deviceId,
    role: required.role,
  });
  defaultRuntime.writeJson(result);
}
