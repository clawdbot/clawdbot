// Nodes page renders the unified paired-device / node inventory card.
import { html, nothing, type TemplateResult } from "lit";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../../../../src/shared/device-pairing-access.js";
import type { PresenceEntry } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatList, formatRelativeTimestamp, formatTimeAgo } from "../../lib/format.ts";
import type {
  DeviceTokenSummary,
  InventoryRemovalRequest,
  PairedDevice,
  PendingDevice,
} from "../../lib/nodes/index.ts";
import {
  buildNodesInventory,
  findGatewayPresence,
  listStaleInventoryEntries,
  listUnpairedPresence,
  resolveInventoryRemoval,
  type NodesInventoryEntry,
  type NodesInventoryGroup,
} from "../../lib/nodes/inventory.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import type { NodesProps } from "./view.types.ts";

const MAX_CAPABILITY_CHIPS = 16;

function toRemovalRequest(entry: NodesInventoryEntry): InventoryRemovalRequest {
  const removal = resolveInventoryRemoval(entry);
  return { id: entry.id, name: entry.name, ...removal };
}

export function renderNodesInventory(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  const groups = buildNodesInventory({ paired, nodes: props.nodes, presence: props.presence });
  const gatewayPresence = findGatewayPresence(props.presence);
  const unpairedPresence = listUnpairedPresence(props.presence, groups);
  const stale = listStaleInventoryEntries(groups);
  const pairedByDeviceId = new Map(
    paired
      .map((device) => [normalizeOptionalString(device.deviceId), device] as const)
      .filter((entry): entry is [string, PairedDevice] => Boolean(entry[0])),
  );
  const loading = props.loading || props.devicesLoading;
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">${t("nodes.inventory.title")}</div>
          <div class="card-sub">${t("nodes.inventory.subtitle")}</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
          ${stale.length > 0
            ? html`
                <button
                  class="btn btn--sm danger"
                  @click=${() => props.onInventoryCleanup(stale.map(toRemovalRequest))}
                >
                  ${t("nodes.inventory.cleanupStale", { count: String(stale.length) })}
                </button>
              `
            : nothing}
          <button
            class="btn primary"
            title=${props.canPairDevice ? "" : t("nodes.pairing.adminRequired")}
            ?disabled=${!props.canPairDevice}
            @click=${props.onDevicePairSetupOpen}
          >
            ${icons.smartphone} ${t("nodes.pairing.button")}
          </button>
          <button class="btn" ?disabled=${loading} @click=${props.onRefresh}>
            ${loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
      </div>
      ${props.devicesError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.devicesError}</div>`
        : nothing}
      ${props.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.lastError}</div>`
        : nothing}
      <div class="list" style="margin-top: 16px;">
        ${gatewayPresence ? renderGatewayEntry(gatewayPresence) : nothing}
        ${pending.length > 0
          ? html`
              <div class="muted" style="margin-bottom: 8px;">
                ${t("nodes.inventory.pendingApproval")}
              </div>
              ${pending.map((req) =>
                renderPendingDevice(req, props, lookupPairedDevice(pairedByDeviceId, req)),
              )}
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">
                ${t("nodes.inventory.paired")}
              </div>
            `
          : nothing}
        ${groups.length === 0 &&
        pending.length === 0 &&
        !gatewayPresence &&
        unpairedPresence.length === 0
          ? html` <div class="muted">${t("nodes.inventory.empty")}</div> `
          : groups.map((group) => renderInventoryGroup(group, props))}
        ${unpairedPresence.length > 0
          ? html`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">
                ${t("nodes.inventory.connectedWithoutPairing")}
              </div>
              ${unpairedPresence.map((entry) => renderPresenceOnlyEntry(entry))}
            `
          : nothing}
      </div>
    </section>
  `;
}

function renderInventoryGroup(group: NodesInventoryGroup, props: NodesProps) {
  if (group.duplicates.length === 0) {
    return renderInventoryEntry(group.primary, props);
  }
  return html`
    <div class="nodes-group">
      ${renderInventoryEntry(group.primary, props)}
      <details class="nodes-group__dups">
        <summary>
          ${t(
            group.duplicates.length === 1
              ? "nodes.inventory.olderPairing"
              : "nodes.inventory.olderPairings",
            { count: String(group.duplicates.length), name: group.name },
          )}
        </summary>
        ${group.duplicates.map((entry) => renderInventoryEntry(entry, props))}
      </details>
    </div>
  `;
}

function isWindowsPlatform(platform: string | undefined): boolean {
  const normalized = normalizeOptionalString(platform)?.toLowerCase();
  return (
    normalized === "win32" ||
    normalized === "windows" ||
    normalized?.startsWith("windows ") === true
  );
}

function isApprovedNodeEntry(entry: NodesInventoryEntry): boolean {
  const node = entry.node;
  if (!node?.paired) {
    return false;
  }
  return node.approvalState === undefined || node.approvalState === "approved";
}

function resolveNodeCoreVersion(entry: NodesInventoryEntry): string | undefined {
  const coreVersion = normalizeOptionalString(entry.node?.coreVersion);
  if (coreVersion) {
    return coreVersion;
  }
  if (normalizeOptionalString(entry.node?.uiVersion)) {
    return undefined;
  }
  const platform = normalizeOptionalString(entry.node?.platform)?.toLowerCase();
  // Legacy headless desktop nodes reported one version field as their core version.
  const legacyHeadless =
    platform === "darwin" || platform === "linux" || platform === "win32" || platform === "windows";
  return legacyHeadless ? normalizeOptionalString(entry.node?.version) : undefined;
}

function entryStatusChips(
  entry: NodesInventoryEntry,
  gatewayVersion: string | null,
): TemplateResult[] {
  const chips: TemplateResult[] = [];
  for (const role of entry.roles) {
    chips.push(html`<span class="chip">${role}</span>`);
  }
  if (entry.autoApproved) {
    chips.push(html`<span class="chip">${t("nodes.inventory.autoPaired")}</span>`);
  }
  const isApprovedNode = isApprovedNodeEntry(entry);
  const nodeVersion = resolveNodeCoreVersion(entry);
  const normalizedGatewayVersion = normalizeOptionalString(gatewayVersion);
  if (
    isApprovedNode &&
    nodeVersion &&
    normalizedGatewayVersion &&
    nodeVersion !== normalizedGatewayVersion
  ) {
    const title = t("nodes.inventory.versionDriftTitle", {
      nodeVersion,
      gatewayVersion: normalizedGatewayVersion,
    });
    chips.push(
      html`<span class="chip chip-warn" title=${title}>${t("nodes.inventory.versionDrift")}</span>`,
    );
  }
  if (isApprovedNode && !entry.connected && isWindowsPlatform(entry.platform)) {
    const title = t("nodes.inventory.manualWakeTitle");
    chips.push(
      html`<span class="chip chip-warn" title=${title}>${t("nodes.inventory.manualWake")}</span>`,
    );
  }
  const approvalState = entry.node?.approvalState;
  if (approvalState === "pending-approval" || approvalState === "pending-reapproval") {
    chips.push(html`<span class="chip chip-warn">${t("nodes.inventory.approvalNeeded")}</span>`);
  }
  return chips;
}

const PLATFORM_DISPLAY_NAMES: Record<string, string> = {
  macos: "macOS",
  darwin: "macOS",
  win32: "Windows",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  ipados: "iPadOS",
  watchos: "watchOS",
  android: "Android",
  web: "Web",
};

function prettifyPlatform(platform: string): string {
  const [name = "", ...rest] = platform.trim().split(/\s+/u);
  // Mixed-case names ("iOS") are already branded; only capitalize all-lowercase input.
  const fallback =
    name === name.toLowerCase() ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
  const displayName = PLATFORM_DISPLAY_NAMES[name.toLowerCase()] ?? fallback;
  return [displayName, ...rest].join(" ");
}

function formatInputRecency(lastInputSeconds: number): string {
  return t("nodes.inventory.inputAgo", {
    time: formatTimeAgo(lastInputSeconds * 1000, { suffix: false }),
  });
}

function entryMetaLine(entry: NodesInventoryEntry): string {
  const parts: string[] = [];
  if (entry.platform) {
    parts.push(prettifyPlatform(entry.platform));
  }
  if (entry.modelIdentifier) {
    parts.push(entry.modelIdentifier);
  }
  if (entry.version) {
    parts.push(entry.version);
  }
  if (entry.connected && entry.presence?.lastInputSeconds != null) {
    parts.push(formatInputRecency(entry.presence.lastInputSeconds));
  } else if (!entry.connected && entry.lastSeenAtMs) {
    parts.push(t("nodes.inventory.seen", { time: formatRelativeTimestamp(entry.lastSeenAtMs) }));
  } else if (!entry.connected && entry.approvedAtMs) {
    parts.push(
      t("nodes.inventory.approved", { time: formatRelativeTimestamp(entry.approvedAtMs) }),
    );
  }
  return parts.join(" · ");
}

function renderCapabilityChips(label: string, values: string[]) {
  if (values.length === 0) {
    return nothing;
  }
  const visible = values.slice(0, MAX_CAPABILITY_CHIPS);
  const overflow = values.length - visible.length;
  return html`
    <div class="muted" style="margin-top: 8px;">${label}</div>
    <div class="chip-row" style="margin-top: 4px;">
      ${visible.map((value) => html`<span class="chip">${value}</span>`)}
      ${overflow > 0
        ? html`<span class="chip">${t("nodes.inventory.more", { count: String(overflow) })}</span>`
        : nothing}
    </div>
  `;
}

function renderEntryDetails(entry: NodesInventoryEntry, props: NodesProps) {
  const tokens = entry.device?.tokens ?? [];
  const caps = entry.node?.caps ?? [];
  const commands = entry.node?.commands ?? [];
  const scopes = entry.scopes;
  return html`
    <details class="nodes-entry__details">
      <summary>${t("nodes.inventory.details")}</summary>
      <div class="muted" style="margin-top: 8px; word-break: break-all;">
        ${t("nodes.inventory.deviceId", { id: entry.id })}
      </div>
      ${entry.remoteIp
        ? html`<div class="muted" style="margin-top: 8px;">
            ${t("nodes.inventory.remoteIp", { ip: entry.remoteIp })}
          </div>`
        : nothing}
      ${scopes.length > 0
        ? html`<div class="muted" style="margin-top: 8px;">
            ${t("nodes.inventory.scopes", { scopes: formatList(scopes) })}
          </div>`
        : nothing}
      ${tokens.length > 0
        ? html`
            <div class="muted" style="margin-top: 8px;">${t("nodes.inventory.tokens")}</div>
            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
              ${tokens.map((token) => renderTokenRow(entry.id, token, props))}
            </div>
          `
        : nothing}
      ${renderCapabilityChips(t("nodes.inventory.capabilities"), caps)}
      ${renderCapabilityChips(t("nodes.inventory.commands"), commands)}
    </details>
  `;
}

function renderInventoryEntry(entry: NodesInventoryEntry, props: NodesProps) {
  const pendingRequestId =
    entry.node?.approvalState === "pending-approval" ||
    entry.node?.approvalState === "pending-reapproval"
      ? entry.node.pendingRequestId
      : undefined;
  return html`
    <div class="list-item nodes-entry">
      <div class="list-main">
        <div class="nodes-entry__head">
          <span
            class="status-dot ${entry.connected ? "status-dot--connected" : "status-dot--offline"}"
            role="img"
            aria-label=${entry.connected
              ? t("nodes.inventory.connected")
              : t("nodes.inventory.offline")}
            title=${entry.connected ? t("nodes.inventory.connected") : t("nodes.inventory.offline")}
          ></span>
          <span class="list-title">${entry.name}</span>
          ${entryStatusChips(entry, props.gatewayVersion)}
        </div>
        <div class="list-sub">${entryMetaLine(entry)}</div>
        ${renderEntryDetails(entry, props)}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
          ${pendingRequestId
            ? html`
                <button
                  class="btn btn--sm primary"
                  @click=${() => props.onNodeApprove(pendingRequestId)}
                >
                  ${t("nodes.inventory.approve")}
                </button>
                <button class="btn btn--sm" @click=${() => props.onNodeReject(pendingRequestId)}>
                  ${t("nodes.inventory.reject")}
                </button>
              `
            : nothing}
          <button
            class="btn btn--sm danger"
            @click=${() => props.onInventoryRemove(toRemovalRequest(entry))}
          >
            ${t("nodes.inventory.remove")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function presenceMetaParts(entry: PresenceEntry): string[] {
  const parts: string[] = [];
  if (entry.platform) {
    parts.push(prettifyPlatform(entry.platform));
  }
  if (entry.modelIdentifier) {
    parts.push(entry.modelIdentifier);
  }
  if (entry.version) {
    parts.push(entry.version);
  }
  if (entry.lastInputSeconds != null) {
    parts.push(formatInputRecency(entry.lastInputSeconds));
  }
  return parts;
}

function renderGatewayEntry(entry: PresenceEntry) {
  const parts = presenceMetaParts(entry);
  return html`
    <div class="list-item nodes-entry nodes-entry--gateway">
      <div class="list-main">
        <div class="nodes-entry__head">
          <span class="list-title">${entry.host ?? t("nodes.execApprovals.gateway")}</span>
          <span class="chip">${t("nodes.inventory.gateway")}</span>
        </div>
        ${parts.length > 0 ? html`<div class="list-sub">${parts.join(" · ")}</div>` : nothing}
      </div>
    </div>
  `;
}

function renderPresenceOnlyEntry(entry: PresenceEntry) {
  const roles = Array.isArray(entry.roles) ? entry.roles.filter(Boolean) : [];
  const parts = presenceMetaParts(entry);
  return html`
    <div class="list-item nodes-entry">
      <div class="list-main">
        <div class="nodes-entry__head">
          <span
            class="status-dot status-dot--connected"
            role="img"
            aria-label=${t("nodes.inventory.connected")}
            title=${t("nodes.inventory.connected")}
          ></span>
          <span class="list-title">
            ${entry.host ?? entry.mode ?? t("nodes.inventory.unknownClient")}
          </span>
          ${roles.map((role) => html`<span class="chip">${role}</span>`)}
          <span class="chip">${t("nodes.inventory.unpaired")}</span>
        </div>
        ${parts.length > 0 ? html`<div class="list-sub">${parts.join(" · ")}</div>` : nothing}
      </div>
    </div>
  `;
}

function renderTokenRow(deviceId: string, token: DeviceTokenSummary, props: NodesProps) {
  const status = token.revokedAtMs ? t("nodes.inventory.revoked") : t("nodes.inventory.active");
  const scopes = t("nodes.inventory.scopes", { scopes: formatList(token.scopes) });
  const when = formatRelativeTimestamp(
    token.rotatedAtMs ?? token.createdAtMs ?? token.lastUsedAtMs ?? null,
  );
  return html`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${token.role} · ${status} · ${scopes} · ${when}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${() => props.onDeviceRotate(deviceId, token.role, token.scopes)}
        >
          ${t("nodes.inventory.rotate")}
        </button>
        ${token.revokedAtMs
          ? nothing
          : html`
              <button
                class="btn btn--sm danger"
                @click=${() => props.onDeviceRevoke(deviceId, token.role)}
              >
                ${t("nodes.inventory.revoke")}
              </button>
            `}
      </div>
    </div>
  `;
}

function lookupPairedDevice(
  pairedByDeviceId: ReadonlyMap<string, PairedDevice>,
  request: Pick<PendingDevice, "deviceId" | "publicKey">,
): PairedDevice | undefined {
  const deviceId = normalizeOptionalString(request.deviceId);
  if (!deviceId) {
    return undefined;
  }
  const paired = pairedByDeviceId.get(deviceId);
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

function formatAccessSummary(access: DevicePairingAccessSummary | null): string {
  if (!access) {
    return t("nodes.inventory.none");
  }
  return t("nodes.inventory.rolesAndScopes", {
    roles: formatList(access.roles),
    scopes: formatList(access.scopes),
  });
}

function renderPendingApprovalNote(kind: PendingDeviceApprovalKind) {
  switch (kind) {
    case "scope-upgrade":
      return t("nodes.inventory.scopeUpgrade");
    case "role-upgrade":
      return t("nodes.inventory.roleUpgrade");
    case "re-approval":
      return t("nodes.inventory.reapproval");
    case "new-pairing":
      return t("nodes.inventory.newPairing");
  }
  const exhaustiveKind: never = kind;
  void exhaustiveKind;
  throw new Error("unsupported pending approval kind");
}

function renderPendingDevice(req: PendingDevice, props: NodesProps, paired?: PairedDevice) {
  const name = normalizeOptionalString(req.displayName) || req.deviceId;
  const age = typeof req.ts === "number" ? formatRelativeTimestamp(req.ts) : t("common.na");
  const approval = resolvePendingDeviceApprovalState(req, paired);
  const repair = req.isRepair ? ` · ${t("nodes.inventory.repair")}` : "";
  const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub">${req.deviceId}${ip}</div>
        <div class="muted" style="margin-top: 6px;">
          ${t("nodes.inventory.requestedAt", {
            note: renderPendingApprovalNote(approval.kind),
            time: age,
          })}${repair}
        </div>
        <div class="muted" style="margin-top: 6px;">
          ${t("nodes.inventory.requestedAccess", {
            access: formatAccessSummary(approval.requested),
          })}
        </div>
        ${approval.approved
          ? html`
              <div class="muted" style="margin-top: 6px;">
                ${t("nodes.inventory.approvedAccess", {
                  access: formatAccessSummary(approval.approved),
                })}
              </div>
            `
          : nothing}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${() => props.onDeviceApprove(req.requestId)}>
            ${t("nodes.inventory.approve")}
          </button>
          <button class="btn btn--sm" @click=${() => props.onDeviceReject(req.requestId)}>
            ${t("nodes.inventory.reject")}
          </button>
        </div>
      </div>
    </div>
  `;
}
