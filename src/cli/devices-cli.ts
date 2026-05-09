import type { Command } from "commander";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE, PAIRING_SCOPE, type OperatorScope } from "../gateway/method-scopes.js";
import { isLoopbackHost } from "../gateway/net.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import {
  readConnectPairingRequiredMessage,
  type ConnectPairingRequiredDetails,
} from "../gateway/protocol/connect-error-details.js";
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
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";
import { withProgress } from "./progress.js";

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

const devicesCallOpts = (cmd: Command, defaults?: { timeoutMs?: number }) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option(
      "--timeout <ms>",
      "Timeout in ms",
      String(defaults?.timeoutMs ?? DEFAULT_DEVICES_TIMEOUT_MS),
    )
    .option("--json", "Output JSON", false);

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
        timeoutMs: Number(opts.timeout ?? DEFAULT_DEVICES_TIMEOUT_MS),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        scopes: callOpts?.scopes,
      }),
  );

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

function resolveLocalPairingFallback(
  opts: DevicesRpcOpts,
  error: unknown,
): { details: ConnectPairingRequiredDetails } | null {
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
  const scopes = await resolveApprovePairingGatewayScopes(opts, requestId);
  try {
    return await callGatewayCli(
      "device.pair.approve",
      opts,
      { requestId },
      scopes ? { scopes } : undefined,
    );
  } catch (error) {
    if (isDevicePairingApprovalDenied(error) && !scopes?.includes(ADMIN_SCOPE)) {
      return await callGatewayCli(
        "device.pair.approve",
        opts,
        { requestId },
        { scopes: [ADMIN_SCOPE] },
      );
    }
    const fallback = resolveLocalPairingFallback(opts, error);
    if (!fallback) {
      throw error;
    }
    const gatewayRequestId = normalizeOptionalString(fallback.details.requestId);
    if (gatewayRequestId && gatewayRequestId !== requestId) {
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

async function resolveApprovePairingGatewayScopes(
  opts: DevicesRpcOpts,
  requestId: string,
): Promise<OperatorScope[] | undefined> {
  try {
    const list = await listPairingWithFallback(opts);
    const request = list.pending?.find((pending) => pending.requestId === requestId);
    if (!request) {
      return undefined;
    }
    return resolveApprovePairingScopesForRequest(
      request,
      lookupPairedDevice(indexPairedDevices(list.paired), request),
    );
  } catch {
    return undefined;
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

function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
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

export function registerDevicesCli(program: Command) {
  const devices = program.command("devices").description("Device pairing and auth tokens");

  devicesCallOpts(
    devices
      .command("list")
      .description("List pending and paired devices")
      .action(async (opts: DevicesRpcOpts) => {
        const list = await listPairingWithFallback(opts);
        const pairedByDeviceId = indexPairedDevices(list.paired);
        if (opts.json) {
          defaultRuntime.writeJson(list);
          return;
        }
        if (list.pending?.length) {
          const tableWidth = getTerminalTableWidth();
          defaultRuntime.log(
            `${theme.heading("Pending")} ${theme.muted(`(${list.pending.length})`)}`,
          );
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
          defaultRuntime.log(
            `${theme.heading("Paired")} ${theme.muted(`(${list.paired.length})`)}`,
          );
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
                Device: sanitizeForLog(device.displayName || device.deviceId),
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
        }
        if (!list.pending?.length && !list.paired?.length) {
          defaultRuntime.log(theme.muted("No device pairing entries."));
        }
      }),
  );

  devicesCallOpts(
    devices
      .command("remove")
      .description("Remove a paired device entry")
      .argument("<deviceId>", "Paired device id")
      .action(async (deviceId: string, opts: DevicesRpcOpts) => {
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
      }),
  );

  devicesCallOpts(
    devices
      .command("clear")
      .description("Clear paired devices from the gateway table")
      .option("--pending", "Also reject all pending pairing requests", false)
      .option("--yes", "Confirm destructive clear", false)
      .action(async (opts: DevicesRpcOpts) => {
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
      }),
  );

  devicesCallOpts(
    devices
      .command("approve")
      .description("Approve a pending device pairing request")
      .argument("[requestId]", "Pending request id")
      .option("--latest", "Show the most recent pending request to approve explicitly", false)
      .action(async (requestId: string | undefined, opts: DevicesRpcOpts) => {
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
        const result = await approvePairingWithFallback(opts, resolvedRequestId);
        if (!result) {
          defaultRuntime.error("unknown requestId");
          defaultRuntime.exit(1);
          return;
        }
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        const deviceId = (result as { device?: { deviceId?: string } })?.device?.deviceId;
        defaultRuntime.log(
          `${theme.success("Approved")} ${theme.command(deviceId ?? "ok")} ${theme.muted(`(${resolvedRequestId})`)}`,
        );
      }),
  );

  devicesCallOpts(
    devices
      .command("reject")
      .description("Reject a pending device pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: DevicesRpcOpts) => {
        const result = await callGatewayCli("device.pair.reject", opts, { requestId });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        const deviceId = (result as { deviceId?: string })?.deviceId;
        defaultRuntime.log(`${theme.warn("Rejected")} ${theme.command(deviceId ?? "ok")}`);
      }),
  );

  devicesCallOpts(
    devices
      .command("rotate")
      .description("Rotate a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .option("--scope <scope...>", "Scopes to attach to the token (repeatable)")
      .action(async (opts: DevicesRpcOpts) => {
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
      }),
  );

  devicesCallOpts(
    devices
      .command("revoke")
      .description("Revoke a device token for a role")
      .requiredOption("--device <id>", "Device id")
      .requiredOption("--role <role>", "Role name")
      .action(async (opts: DevicesRpcOpts) => {
        const required = resolveRequiredDeviceRole(opts);
        if (!required) {
          return;
        }
        const result = await callGatewayCli("device.token.revoke", opts, {
          deviceId: required.deviceId,
          role: required.role,
        });
        defaultRuntime.writeJson(result);
      }),
  );

  applyParentDefaultHelpAction(devices);
}
