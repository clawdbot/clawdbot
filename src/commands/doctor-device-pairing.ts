/** Doctor diagnostics for pending, paired, and locally cached device auth state. */
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../packages/terminal-core/src/note.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { callGateway } from "../gateway/call.js";
import { loadDeviceAuthTokens } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import {
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  summarizeDeviceTokens,
  type DeviceAuthTokenSummary,
  type DevicePairingPendingRequest,
  type PairedDevice,
} from "../infra/device-pairing.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

const DEVICE_PAIRING_CHECK_ID = "core/doctor/device-pairing";

type GatewayListedPairedDevice = Omit<PairedDevice, "tokens" | "approvedScopes"> & {
  tokens?: DeviceAuthTokenSummary[];
};

type GatewayDevicePairingPayload = {
  pending: DevicePairingPendingRequest[];
  paired: GatewayListedPairedDevice[];
};

type DoctorPairedDevice = Omit<PairedDevice, "tokens"> & {
  tokenSummaries: DeviceAuthTokenSummary[];
};

type DoctorPairingSnapshot = {
  pending: DevicePairingPendingRequest[];
  paired: DoctorPairedDevice[];
};

type PendingPairingIssue =
  | {
      kind: "first-time";
      pending: DevicePairingPendingRequest;
      deviceLabel: string;
      approveCommand: string;
      inspectCommand: string;
    }
  | {
      kind: "public-key-repair";
      pending: DevicePairingPendingRequest;
      deviceLabel: string;
      approveCommand: string;
      inspectCommand: string;
      removeCommand: string;
    }
  | {
      kind: "role-upgrade";
      pending: DevicePairingPendingRequest;
      deviceLabel: string;
      approveCommand: string;
      inspectCommand: string;
      approvedRoles: string[];
      requestedRoles: string[];
    }
  | {
      kind: "scope-upgrade";
      pending: DevicePairingPendingRequest;
      deviceLabel: string;
      approveCommand: string;
      inspectCommand: string;
      approvedScopes: string[];
      requestedScopes: string[];
    }
  | {
      kind: "repair";
      pending: DevicePairingPendingRequest;
      deviceLabel: string;
      approveCommand: string;
      inspectCommand: string;
    };

type PairedRecordIssue = {
  kind:
    | "missing-operator-scope-baseline"
    | "missing-active-role-token"
    | "token-outside-approved-scope";
  deviceId: string;
  deviceLabel: string;
  role?: string;
  message: string;
  fixHint?: string;
};

type LocalDeviceAuthIssue = {
  kind: "local-role-no-longer-approved" | "local-token-stale" | "local-scopes-mismatch";
  deviceId: string;
  deviceLabel: string;
  role: string;
  message: string;
  fixHint: string;
};

function normalizeGatewayPairedDevice(device: GatewayListedPairedDevice): DoctorPairedDevice {
  return {
    ...device,
    tokenSummaries: device.tokens ?? [],
  };
}

function normalizeLocalPairedDevice(device: PairedDevice): DoctorPairedDevice {
  return {
    ...device,
    tokenSummaries: summarizeDeviceTokens(device.tokens) ?? [],
  };
}

async function loadDoctorPairingSnapshot(params: {
  cfg: OpenClawConfig;
  healthOk: boolean;
}): Promise<DoctorPairingSnapshot | null> {
  if (params.healthOk) {
    try {
      const payload = await callGateway<GatewayDevicePairingPayload>({
        method: "device.pair.list",
        timeoutMs: 5_000,
        config: params.cfg,
      });
      return {
        pending: payload.pending,
        paired: payload.paired.map((device) => normalizeGatewayPairedDevice(device)),
      };
    } catch {
      // Gateway health already reported separately. Fall back to local pairing
      // state when doctor is running against a local gateway.
    }
  }
  if (params.cfg.gateway?.mode === "remote") {
    return null;
  }
  const local = await listDevicePairing();
  return {
    pending: local.pending,
    paired: local.paired.map((device) => normalizeLocalPairedDevice(device)),
  };
}

function resolveApprovedScopes(
  device: Pick<DoctorPairedDevice, "approvedScopes" | "scopes">,
): string[] {
  return normalizeDeviceAuthScopes(device.approvedScopes ?? device.scopes);
}

function formatScopes(scopes: string[]): string {
  return scopes.length > 0 ? scopes.join(", ") : "none";
}

function formatRoles(roles: string[]): string {
  return roles.length > 0 ? roles.join(", ") : "none";
}

function formatCliArgs(args: string[]): string {
  return formatCliCommand(args.map(quoteCliArg).join(" "));
}

function describeDevice(params: {
  deviceId: string;
  displayName?: string;
  clientId?: string;
}): string {
  const label =
    sanitizeTerminalText(params.displayName?.trim() || "") ||
    sanitizeTerminalText(params.clientId?.trim() || "");
  return label ? `${label} (${params.deviceId})` : params.deviceId;
}

function findTokenSummary(
  device: DoctorPairedDevice,
  role: string,
): DeviceAuthTokenSummary | undefined {
  const normalizedRole = role.trim();
  return device.tokenSummaries.find((entry) => entry.role === normalizedRole && !entry.revokedAtMs);
}

function hasPendingScopeUpgrade(params: {
  requestedRoles: string[];
  pendingScopes: string[];
  approvedRoles: string[];
  approvedScopes: string[];
}): boolean {
  for (const role of params.requestedRoles) {
    if (!params.approvedRoles.includes(role)) {
      continue;
    }
    const requestedForRole = params.pendingScopes.filter((scope) =>
      role === "operator" ? scope.startsWith("operator.") : !scope.startsWith("operator."),
    );
    if (requestedForRole.length === 0) {
      continue;
    }
    if (
      !roleScopesAllow({
        role,
        requestedScopes: requestedForRole,
        allowedScopes: params.approvedScopes,
      })
    ) {
      return true;
    }
  }
  return false;
}

function resolvePendingPairingIssue(
  pending: DevicePairingPendingRequest,
  paired: DoctorPairedDevice | undefined,
): PendingPairingIssue {
  const deviceLabel = describeDevice({
    deviceId: pending.deviceId,
    displayName: pending.displayName,
    clientId: pending.clientId,
  });
  const approveCommand = formatCliArgs(["openclaw", "devices", "approve", pending.requestId]);
  const inspectCommand = formatCliArgs(["openclaw", "devices", "list"]);
  if (!paired) {
    return {
      kind: "first-time",
      pending,
      deviceLabel,
      approveCommand,
      inspectCommand,
    };
  }
  if (paired.publicKey !== pending.publicKey) {
    return {
      kind: "public-key-repair",
      pending,
      deviceLabel,
      approveCommand,
      inspectCommand,
      removeCommand: formatCliArgs(["openclaw", "devices", "remove", pending.deviceId]),
    };
  }
  const requestedRoles = normalizeUniqueSingleOrTrimmedStringList(
    [pending.roles, pending.role].flat(),
  );
  const approvedRoles = listApprovedPairedDeviceRoles(paired);
  if (requestedRoles.some((role) => !approvedRoles.includes(role))) {
    return {
      kind: "role-upgrade",
      pending,
      deviceLabel,
      approveCommand,
      inspectCommand,
      approvedRoles,
      requestedRoles,
    };
  }
  const approvedScopes = resolveApprovedScopes(paired);
  const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
  if (
    hasPendingScopeUpgrade({
      requestedRoles,
      pendingScopes: requestedScopes,
      approvedRoles,
      approvedScopes,
    })
  ) {
    return {
      kind: "scope-upgrade",
      pending,
      deviceLabel,
      approveCommand,
      inspectCommand,
      approvedScopes,
      requestedScopes,
    };
  }
  return {
    kind: "repair",
    pending,
    deviceLabel,
    approveCommand,
    inspectCommand,
  };
}

function formatPendingPairingIssue(issue: PendingPairingIssue): string {
  switch (issue.kind) {
    case "first-time":
      return `- Pending device pairing request ${issue.pending.requestId} for ${issue.deviceLabel}. Review with ${issue.inspectCommand}, then approve with ${issue.approveCommand}.`;
    case "public-key-repair":
      return `- Pending device repair ${issue.pending.requestId} for ${issue.deviceLabel}: the current device identity no longer matches the approved pairing record. This commonly loops on pairing-required for an already paired device. Remove the stale record with ${issue.removeCommand}, then rerun ${issue.inspectCommand} and approve with ${issue.approveCommand}.`;
    case "role-upgrade":
      return `- Pending role upgrade ${issue.pending.requestId} for ${issue.deviceLabel}: approved roles [${formatRoles(issue.approvedRoles)}], requested roles [${formatRoles(issue.requestedRoles)}]. Review with ${issue.inspectCommand}, then approve with ${issue.approveCommand}.`;
    case "scope-upgrade":
      return `- Pending scope upgrade ${issue.pending.requestId} for ${issue.deviceLabel}: approved scopes [${formatScopes(issue.approvedScopes)}], requested scopes [${formatScopes(issue.requestedScopes)}]. Review with ${issue.inspectCommand}, then approve with ${issue.approveCommand}.`;
    case "repair":
      return `- Pending device repair ${issue.pending.requestId} for ${issue.deviceLabel}: the device is already paired, but a new approval is still required before the requested auth can be used. Review with ${issue.inspectCommand}, then approve with ${issue.approveCommand}.`;
  }
  throw new Error("Unsupported pending pairing issue");
}

function collectPendingPairingIssues(snapshot: DoctorPairingSnapshot): PendingPairingIssue[] {
  const pairedByDeviceId = new Map(snapshot.paired.map((device) => [device.deviceId, device]));
  return snapshot.pending.map((pending) =>
    resolvePendingPairingIssue(pending, pairedByDeviceId.get(pending.deviceId)),
  );
}

function collectPairedRecordIssues(snapshot: DoctorPairingSnapshot): PairedRecordIssue[] {
  const issues: PairedRecordIssue[] = [];
  for (const device of snapshot.paired) {
    const deviceLabel = describeDevice({
      deviceId: device.deviceId,
      displayName: device.displayName,
      clientId: device.clientId,
    });
    const approvedRoles = listApprovedPairedDeviceRoles(device);
    const approvedScopes = resolveApprovedScopes(device);
    if (approvedRoles.includes("operator") && approvedScopes.length === 0) {
      issues.push({
        kind: "missing-operator-scope-baseline",
        deviceId: device.deviceId,
        deviceLabel,
        message: `Paired device ${deviceLabel} is missing its approved operator scope baseline. Scope upgrades can get stuck in pairing-required until the device repairs or is re-approved.`,
      });
    }
    for (const role of approvedRoles) {
      const token = findTokenSummary(device, role);
      const rotateCommand = formatCliArgs([
        "openclaw",
        "devices",
        "rotate",
        "--device",
        device.deviceId,
        "--role",
        role,
      ]);
      if (!token) {
        issues.push({
          kind: "missing-active-role-token",
          deviceId: device.deviceId,
          deviceLabel,
          role,
          message: `Paired device ${deviceLabel} has no active ${role} device token even though the role is approved. This commonly ends in pairing-required or device-token-mismatch. Rotate a fresh token with ${rotateCommand}.`,
          fixHint: `Rotate a fresh token with ${rotateCommand}.`,
        });
        continue;
      }
      if (
        token.scopes.length > 0 &&
        !roleScopesAllow({
          role,
          requestedScopes: token.scopes,
          allowedScopes: approvedScopes,
        })
      ) {
        issues.push({
          kind: "token-outside-approved-scope",
          deviceId: device.deviceId,
          deviceLabel,
          role,
          message: `Paired device ${deviceLabel} has a ${role} token outside the approved scope baseline [${formatScopes(approvedScopes)}]. Rotate it with ${rotateCommand}.`,
          fixHint: `Rotate it with ${rotateCommand}.`,
        });
      }
    }
  }
  return issues;
}

function formatPairedRecordIssue(issue: PairedRecordIssue): string {
  return `- ${issue.message}`;
}

function readLocalIdentity(env: NodeJS.ProcessEnv = process.env): { deviceId: string } | null {
  try {
    return loadDeviceIdentityIfPresent({ env });
  } catch {
    return null;
  }
}

function readLocalDeviceAuthTokens(deviceId: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    return loadDeviceAuthTokens({ deviceId, env });
  } catch {
    return [];
  }
}

function collectLocalDeviceAuthIssues(snapshot: DoctorPairingSnapshot): LocalDeviceAuthIssue[] {
  const identity = readLocalIdentity();
  if (!identity) {
    return [];
  }
  const localTokens = readLocalDeviceAuthTokens(identity.deviceId);
  const paired = snapshot.paired.find((device) => device.deviceId === identity.deviceId);
  if (!paired) {
    return [];
  }
  const deviceLabel = describeDevice({
    deviceId: paired.deviceId,
    displayName: paired.displayName,
    clientId: paired.clientId,
  });
  const issues: LocalDeviceAuthIssue[] = [];
  const approvedRoles = new Set(listApprovedPairedDeviceRoles(paired));
  for (const entry of localTokens) {
    const role = entry.role.trim();
    if (!role) {
      continue;
    }
    const pairedToken = findTokenSummary(paired, role);
    if (!pairedToken) {
      if (approvedRoles.has(role)) {
        continue;
      }
      issues.push({
        kind: "local-role-no-longer-approved",
        deviceId: paired.deviceId,
        deviceLabel,
        role,
        message: `Local cached ${role} device auth for ${deviceLabel} no longer has a matching active gateway token, and that role is no longer approved for this device. Reconnect with shared gateway auth to refresh local auth, or remove the stale cached ${role} auth entry.`,
        fixHint: `Reconnect with shared gateway auth to refresh local auth, or remove the stale cached ${role} auth entry.`,
      });
      continue;
    }
    const rotateCommand = formatCliArgs([
      "openclaw",
      "devices",
      "rotate",
      "--device",
      paired.deviceId,
      "--role",
      role,
    ]);
    const gatewayIssuedAtMs = pairedToken.rotatedAtMs ?? pairedToken.createdAtMs;
    // Local device auth survives gateway restarts; compare timestamps to catch stale cached tokens.
    if (entry.updatedAtMs < gatewayIssuedAtMs) {
      issues.push({
        kind: "local-token-stale",
        deviceId: paired.deviceId,
        deviceLabel,
        role,
        message: `Local cached ${role} device token for ${deviceLabel} predates the gateway rotation. This is a stale device-token pattern and can fail with device token mismatch. Reconnect with shared gateway auth to refresh it, or rotate again with ${rotateCommand}.`,
        fixHint: `Reconnect with shared gateway auth to refresh it, or rotate again with ${rotateCommand}.`,
      });
      continue;
    }
    const cachedScopes = normalizeDeviceAuthScopes(entry.scopes);
    const pairedScopes = normalizeDeviceAuthScopes(pairedToken.scopes);
    if (cachedScopes.join("\n") !== pairedScopes.join("\n")) {
      issues.push({
        kind: "local-scopes-mismatch",
        deviceId: paired.deviceId,
        deviceLabel,
        role,
        message: `Local cached ${role} device scopes for ${deviceLabel} differ from the gateway record. Cached scopes [${formatScopes(cachedScopes)}], gateway scopes [${formatScopes(pairedScopes)}]. Reconnect with shared gateway auth to refresh it, or rotate with ${rotateCommand}.`,
        fixHint: `Reconnect with shared gateway auth to refresh it, or rotate with ${rotateCommand}.`,
      });
    }
  }
  return issues;
}

function formatLocalDeviceAuthIssue(issue: LocalDeviceAuthIssue): string {
  return `- ${issue.message}`;
}

function formatLegacyPairingStoreIssue(filePath: string): string {
  return `- Legacy device pairing store ${filePath} has not been imported into the SQLite state store yet. The gateway imports and archives it at startup, so restart the gateway. If the file persists across restarts it is likely unreadable; OpenClaw refused to treat it as empty to avoid dropping approved pairings, so fix or move it aside, then restart.`;
}

/** Warn about legacy devices/*.json files the startup SQLite import has not archived. */
async function collectLegacyPairingStoreIssues(cfg: OpenClawConfig): Promise<string[]> {
  if (cfg.gateway?.mode === "remote") {
    return [];
  }
  // Lazy import keeps the migration module a startup-only boundary.
  const { listLegacyDevicePairingStoreFiles } =
    await import("../infra/device-pairing-migration.js");
  return (await listLegacyDevicePairingStoreFiles()).map(formatLegacyPairingStoreIssue);
}

function stripListMarker(message: string): string {
  return message.startsWith("- ") ? message.slice(2) : message;
}

function pendingPairingIssueToHealthFinding(issue: PendingPairingIssue): HealthFinding {
  const fixHint =
    issue.kind === "public-key-repair"
      ? `Remove the stale record with ${issue.removeCommand}, then rerun ${issue.inspectCommand} and approve with ${issue.approveCommand}.`
      : `Review with ${issue.inspectCommand}, then approve with ${issue.approveCommand}.`;
  return {
    checkId: DEVICE_PAIRING_CHECK_ID,
    severity: "warning",
    message: stripListMarker(formatPendingPairingIssue(issue)),
    path: "devices.pending",
    target: `${issue.pending.deviceId}:${issue.pending.requestId}`,
    requirement: issue.kind,
    fixHint,
  };
}

function pairedRecordIssueToHealthFinding(issue: PairedRecordIssue): HealthFinding {
  return {
    checkId: DEVICE_PAIRING_CHECK_ID,
    severity: "warning",
    message: issue.message,
    path: "devices.paired",
    target: issue.role ? `${issue.deviceId}:${issue.role}` : issue.deviceId,
    requirement: issue.kind,
    ...(issue.fixHint ? { fixHint: issue.fixHint } : {}),
  };
}

function localDeviceAuthIssueToHealthFinding(issue: LocalDeviceAuthIssue): HealthFinding {
  return {
    checkId: DEVICE_PAIRING_CHECK_ID,
    severity: "warning",
    message: issue.message,
    path: "identity.device-auth",
    target: `${issue.deviceId}:${issue.role}`,
    requirement: issue.kind,
    fixHint: issue.fixHint,
  };
}

function legacyPairingStoreIssueToHealthFinding(message: string): HealthFinding {
  return {
    checkId: DEVICE_PAIRING_CHECK_ID,
    severity: "warning",
    message: stripListMarker(message),
    path: "devices.legacy-store",
    requirement: "pairing-store-legacy-file",
    fixHint:
      "Restart the gateway so it imports the legacy store; if the file persists, fix or move it aside first.",
  };
}

export async function collectDevicePairingHealthFindings(params: {
  cfg: OpenClawConfig;
  healthOk?: boolean;
}): Promise<HealthFinding[]> {
  const legacyStoreFindings = (await collectLegacyPairingStoreIssues(params.cfg)).map(
    legacyPairingStoreIssueToHealthFinding,
  );
  const snapshot = await loadDoctorPairingSnapshot({
    cfg: params.cfg,
    healthOk: params.healthOk ?? false,
  });
  if (!snapshot) {
    return legacyStoreFindings;
  }
  return [
    ...legacyStoreFindings,
    ...collectPendingPairingIssues(snapshot).map(pendingPairingIssueToHealthFinding),
    ...collectPairedRecordIssues(snapshot).map(pairedRecordIssueToHealthFinding),
    ...collectLocalDeviceAuthIssues(snapshot).map(localDeviceAuthIssueToHealthFinding),
  ];
}

/**
 * Emits device pairing repair guidance from live gateway state or the local pairing store.
 *
 * Remote gateways only report through the gateway API; local gateways can fall back to the
 * local SQLite pairing state when the gateway is down.
 */
export async function noteDevicePairingHealth(params: {
  cfg: OpenClawConfig;
  healthOk: boolean;
}): Promise<void> {
  const legacyStoreLines = await collectLegacyPairingStoreIssues(params.cfg);
  const snapshot = await loadDoctorPairingSnapshot(params);
  const lines = [
    ...legacyStoreLines,
    ...(snapshot
      ? [
          ...collectPendingPairingIssues(snapshot).map(formatPendingPairingIssue),
          ...collectPairedRecordIssues(snapshot).map(formatPairedRecordIssue),
          ...collectLocalDeviceAuthIssues(snapshot).map(formatLocalDeviceAuthIssue),
        ]
      : []),
  ];
  if (lines.length === 0) {
    return;
  }
  note(lines.join("\n"), "Device pairing");
}
