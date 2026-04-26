import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import {
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  summarizeDeviceTokens,
  type DeviceAuthTokenSummary,
  type DevicePairingPendingRequest,
  type PairedDevice,
} from "../infra/device-pairing.js";
import { JsonFileReadError } from "../infra/json-files.js";
import type { DeviceAuthStore } from "../shared/device-auth.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { note } from "../terminal/note.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";

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

type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
};

function hasNumberVersion(value: object): value is { version: number } {
  return "version" in value && typeof value.version === "number";
}

function isDeviceAuthStoreTokenEntry(value: unknown): value is DeviceAuthStore["tokens"][string] {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    typeof value.token === "string" &&
    "role" in value &&
    typeof value.role === "string" &&
    "scopes" in value &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === "string") &&
    "updatedAtMs" in value &&
    typeof value.updatedAtMs === "number"
  );
}

function uniqueStrings(...items: Array<string | string[] | undefined>): string[] {
  const values = new Set<string>();
  for (const item of items) {
    if (!item) {
      continue;
    }
    if (Array.isArray(item)) {
      for (const value of item) {
        const trimmed = value.trim();
        if (trimmed) {
          values.add(trimmed);
        }
      }
      continue;
    }
    const trimmed = item.trim();
    if (trimmed) {
      values.add(trimmed);
    }
  }
  return [...values];
}

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

function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
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
  const requestedRoles = uniqueStrings(pending.roles, pending.role);
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

function collectPendingPairingIssues(snapshot: DoctorPairingSnapshot): string[] {
  const pairedByDeviceId = new Map(snapshot.paired.map((device) => [device.deviceId, device]));
  return snapshot.pending.map((pending) =>
    formatPendingPairingIssue(
      resolvePendingPairingIssue(pending, pairedByDeviceId.get(pending.deviceId)),
    ),
  );
}

function collectPairedRecordIssues(snapshot: DoctorPairingSnapshot): string[] {
  const lines: string[] = [];
  for (const device of snapshot.paired) {
    const deviceLabel = describeDevice({
      deviceId: device.deviceId,
      displayName: device.displayName,
      clientId: device.clientId,
    });
    const approvedRoles = listApprovedPairedDeviceRoles(device);
    const approvedScopes = resolveApprovedScopes(device);
    if (approvedRoles.includes("operator") && approvedScopes.length === 0) {
      lines.push(
        `- Paired device ${deviceLabel} is missing its approved operator scope baseline. Scope upgrades can get stuck in pairing-required until the device repairs or is re-approved.`,
      );
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
        lines.push(
          `- Paired device ${deviceLabel} has no active ${role} device token even though the role is approved. This commonly ends in pairing-required or device-token-mismatch. Rotate a fresh token with ${rotateCommand}.`,
        );
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
        lines.push(
          `- Paired device ${deviceLabel} has a ${role} token outside the approved scope baseline [${formatScopes(approvedScopes)}]. Rotate it with ${rotateCommand}.`,
        );
      }
    }
  }
  return lines;
}

function readJsonFile(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readLocalIdentity(env: NodeJS.ProcessEnv = process.env): StoredDeviceIdentity | null {
  const filePath = path.join(resolveStateDir(env), "identity", "device.json");
  const identity = readJsonFile(filePath);
  if (
    !identity ||
    typeof identity !== "object" ||
    !hasNumberVersion(identity) ||
    identity.version !== 1 ||
    !("deviceId" in identity) ||
    typeof identity.deviceId !== "string" ||
    !identity.deviceId.trim()
  ) {
    return null;
  }
  return {
    version: 1,
    deviceId: identity.deviceId,
  };
}

function readLocalDeviceAuthStore(env: NodeJS.ProcessEnv = process.env): DeviceAuthStore | null {
  const filePath = path.join(resolveStateDir(env), "identity", "device-auth.json");
  const store = readJsonFile(filePath);
  if (
    !store ||
    typeof store !== "object" ||
    !hasNumberVersion(store) ||
    store.version !== 1 ||
    !("deviceId" in store) ||
    typeof store.deviceId !== "string" ||
    !store.deviceId.trim() ||
    !("tokens" in store) ||
    typeof store.tokens !== "object" ||
    store.tokens === null
  ) {
    return null;
  }
  const tokens: DeviceAuthStore["tokens"] = {};
  for (const [role, entry] of Object.entries(store.tokens)) {
    if (!isDeviceAuthStoreTokenEntry(entry)) {
      return null;
    }
    tokens[role] = entry;
  }
  return {
    version: 1,
    deviceId: store.deviceId,
    tokens,
  };
}

function collectLocalDeviceAuthIssues(snapshot: DoctorPairingSnapshot): string[] {
  const identity = readLocalIdentity();
  const store = readLocalDeviceAuthStore();
  if (!identity || !store || store.deviceId !== identity.deviceId) {
    return [];
  }
  const paired = snapshot.paired.find((device) => device.deviceId === identity.deviceId);
  if (!paired) {
    return [];
  }
  const deviceLabel = describeDevice({
    deviceId: paired.deviceId,
    displayName: paired.displayName,
    clientId: paired.clientId,
  });
  const lines: string[] = [];
  const approvedRoles = new Set(listApprovedPairedDeviceRoles(paired));
  for (const entry of Object.values(store.tokens)) {
    const role = entry.role.trim();
    if (!role) {
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
    const pairedToken = findTokenSummary(paired, role);
    if (!pairedToken) {
      if (approvedRoles.has(role)) {
        continue;
      }
      lines.push(
        `- Local cached ${role} device auth for ${deviceLabel} no longer has a matching active gateway token. Reconnect with shared gateway auth to refresh it, or rotate with ${rotateCommand}.`,
      );
      continue;
    }
    const gatewayIssuedAtMs = pairedToken.rotatedAtMs ?? pairedToken.createdAtMs;
    if (entry.updatedAtMs < gatewayIssuedAtMs) {
      lines.push(
        `- Local cached ${role} device token for ${deviceLabel} predates the gateway rotation. This is a stale device-token pattern and can fail with device token mismatch. Reconnect with shared gateway auth to refresh it, or rotate again with ${rotateCommand}.`,
      );
      continue;
    }
    const cachedScopes = normalizeDeviceAuthScopes(entry.scopes);
    const pairedScopes = normalizeDeviceAuthScopes(pairedToken.scopes);
    if (cachedScopes.join("\n") !== pairedScopes.join("\n")) {
      lines.push(
        `- Local cached ${role} device scopes for ${deviceLabel} differ from the gateway record. Cached scopes [${formatScopes(cachedScopes)}], gateway scopes [${formatScopes(pairedScopes)}]. Reconnect with shared gateway auth to refresh it, or rotate with ${rotateCommand}.`,
      );
    }
  }
  return lines;
}

function formatPairingStoreReadIssue(error: JsonFileReadError): string {
  const problem = error.reason === "parse" ? "contains invalid JSON" : "could not be read";
  return `- Device pairing store ${error.filePath} ${problem}. OpenClaw refused to treat it as empty to avoid overwriting approved pairings. Fix the JSON or file permissions, or move it aside and re-pair devices.`;
}

export async function noteDevicePairingHealth(params: {
  cfg: OpenClawConfig;
  healthOk: boolean;
}): Promise<void> {
  let snapshot: DoctorPairingSnapshot | null;
  try {
    snapshot = await loadDoctorPairingSnapshot(params);
  } catch (error) {
    if (error instanceof JsonFileReadError) {
      note(formatPairingStoreReadIssue(error), "Device pairing");
      return;
    }
    throw error;
  }
  if (!snapshot) {
    return;
  }
  const lines = [
    ...collectPendingPairingIssues(snapshot),
    ...collectPairedRecordIssues(snapshot),
    ...collectLocalDeviceAuthIssues(snapshot),
  ];
  if (lines.length === 0) {
    return;
  }
  note(lines.join("\n"), "Device pairing");
}
