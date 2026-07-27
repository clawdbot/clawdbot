// Nodes page renders the unified paired-device / node inventory sections.
import { html, nothing, type TemplateResult } from "lit";
import "../../components/modal-dialog.ts";
import type { PresenceEntry } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatList, formatRelativeTimestamp, formatTimeAgo } from "../../lib/format.ts";
import type { DeviceTokenSummary, InventoryRemovalRequest } from "../../lib/nodes/index.ts";
import {
  buildNodesInventory,
  findGatewayPresence,
  listStaleInventoryEntries,
  listUnpairedPresence,
  resolveInventoryRemoval,
  type NodesInventoryEntry,
  type NodesInventoryGroup,
} from "../../lib/nodes/inventory.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { renderPendingDeviceRows } from "./view-pending-devices.ts";
import { deviceIcon, renderDeviceTile } from "./view-shared.ts";
import type { NodesProps } from "./view.types.ts";

function toRemovalRequest(entry: NodesInventoryEntry): InventoryRemovalRequest {
  const removal = resolveInventoryRemoval(entry);
  return { id: entry.id, name: entry.name, ...removal };
}

function inventorySummary(
  groups: NodesInventoryGroup[],
  pendingCount: number,
  loading: boolean,
): string {
  if (loading && groups.length === 0) {
    return t("common.loading");
  }
  const connected = groups.filter((group) => group.primary.connected).length;
  const parts = [
    t("nodes.inventory.summaryConnected", {
      connected: String(connected),
      total: String(groups.length),
    }),
  ];
  if (pendingCount > 0) {
    parts.push(t("nodes.inventory.summaryPending", { count: String(pendingCount) }));
  }
  return parts.join(" · ");
}

export function renderNodesInventory(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  const groups = buildNodesInventory({ paired, nodes: props.nodes, presence: props.presence });
  const gatewayPresence = findGatewayPresence(props.presence);
  const unpairedPresence = listUnpairedPresence(props.presence, groups);
  const stale = listStaleInventoryEntries(groups);
  const loading = props.loading || props.devicesLoading;
  const actions = html`
    ${stale.length > 0
      ? html`
          <button
            class="btn btn--sm danger"
            @click=${() => props.onInventoryCleanup(stale.map(toRemovalRequest))}
          >
            ${icons.trash} ${t("nodes.inventory.cleanupStale", { count: String(stale.length) })}
          </button>
        `
      : nothing}
    <button
      class="btn"
      title=${props.canPairDevice ? "" : t("nodes.pairing.adminRequired")}
      ?disabled=${!props.canPairDevice}
      @click=${props.onDevicePairSetupOpen}
    >
      ${icons.plus} ${t("nodes.pairing.button")}
    </button>
  `;
  // Pending requests and unpaired presence render in their own sections, so
  // this section's empty state depends only on its own rows.
  const empty = groups.length === 0 && !gatewayPresence;
  const deviceRows = html`
    ${gatewayPresence ? renderGatewayEntry(gatewayPresence) : nothing}
    ${empty
      ? renderSettingsEmpty(loading ? t("common.loading") : t("nodes.inventory.empty"))
      : groups.map((group) => renderInventoryGroup(group, props))}
  `;
  return html`
    ${props.devicesError ? html`<div class="callout danger">${props.devicesError}</div>` : nothing}
    ${props.lastError ? html`<div class="callout danger">${props.lastError}</div>` : nothing}
    ${pending.length > 0
      ? renderSettingsSection(
          { title: t("nodes.inventory.pendingApproval"), count: pending.length },
          renderPendingDeviceRows(pending, paired, props),
        )
      : nothing}
    ${renderSettingsSection(
      {
        title: t("nodes.inventory.title"),
        description: inventorySummary(groups, pending.length, loading),
        actions,
      },
      deviceRows,
    )}
    ${unpairedPresence.length > 0
      ? renderSettingsSection(
          { title: t("nodes.inventory.connectedWithoutPairing") },
          unpairedPresence.map((entry) => renderPresenceOnlyEntry(entry)),
        )
      : nothing}
    ${renderRemovalPrompt(props)}
  `;
}

/* In-page confirm instead of window.confirm: hosts without a native dialog
   bridge silently cancel window.confirm, turning removals into no-ops. */
function renderRemovalPrompt(props: NodesProps) {
  const prompt = props.inventoryRemovalPrompt;
  if (!prompt) {
    return nothing;
  }
  const title =
    prompt.kind === "entry"
      ? t("nodes.inventory.removePromptTitle", { name: prompt.entry.name })
      : t(
          prompt.entries.length === 1
            ? "nodes.inventory.removeStalePromptTitleOne"
            : "nodes.inventory.removeStalePromptTitle",
          { count: String(prompt.entries.length) },
        );
  const body =
    prompt.kind === "entry"
      ? t("nodes.inventory.removePromptBody")
      : t("nodes.inventory.removeStalePromptBody");
  return html`
    <openclaw-modal-dialog
      label=${title}
      description=${body}
      @modal-cancel=${props.onInventoryRemovalCancel}
    >
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${body}</div>
          </div>
        </div>
        ${prompt.kind === "entry"
          ? html`<div class="exec-approval-command mono">
              ${t("nodes.inventory.deviceId", { id: prompt.entry.id })}
            </div>`
          : nothing}
        <div class="exec-approval-actions">
          <button class="btn danger" @click=${props.onInventoryRemovalConfirm}>
            ${t("nodes.inventory.remove")}
          </button>
          <button class="btn" autofocus @click=${props.onInventoryRemovalCancel}>
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderInventoryGroup(group: NodesInventoryGroup, props: NodesProps) {
  if (group.duplicates.length === 0) {
    return renderInventoryEntry(group.primary, props);
  }
  return html`
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

/** Warn statuses (dot + text) replacing the former warning chips. */
function entryWarnStatuses(
  entry: NodesInventoryEntry,
  gatewayVersion: string | null,
): TemplateResult[] {
  const statuses: TemplateResult[] = [];
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
    statuses.push(
      html`<span title=${title}>
        ${renderSettingsStatus({ kind: "warn", label: t("nodes.inventory.versionDrift") })}
      </span>`,
    );
  }
  if (isApprovedNode && !entry.connected && isWindowsPlatform(entry.platform)) {
    statuses.push(
      html`<span title=${t("nodes.inventory.manualWakeTitle")}>
        ${renderSettingsStatus({ kind: "warn", label: t("nodes.inventory.manualWake") })}
      </span>`,
    );
  }
  const approvalState = entry.node?.approvalState;
  if (approvalState === "pending-approval" || approvalState === "pending-reapproval") {
    statuses.push(
      renderSettingsStatus({ kind: "warn", label: t("nodes.inventory.approvalNeeded") }),
    );
  }
  return statuses;
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
  for (const role of entry.roles) {
    parts.push(role);
  }
  if (entry.autoApproved) {
    parts.push(t("nodes.inventory.autoPaired"));
  }
  return parts.join(" · ");
}

// Node-controlled lists are unbounded input; cap the rendered items so a
// hostile or chatty node cannot bloat the inventory render.
const CAPABILITY_LINE_LIMIT = 16;

function renderCapabilityLine(label: string, values: string[]) {
  if (values.length === 0) {
    return nothing;
  }
  const visible = values.slice(0, CAPABILITY_LINE_LIMIT);
  const overflow = values.length - visible.length;
  const suffix = overflow > 0 ? ` +${overflow}` : "";
  return html`<div class="muted">${label}: ${formatList(visible)}${suffix}</div>`;
}

function renderEntryDetails(entry: NodesInventoryEntry, props: NodesProps) {
  const tokens = entry.device?.tokens ?? [];
  const caps = entry.node?.caps ?? [];
  const commands = entry.node?.commands ?? [];
  const scopes = entry.scopes;
  return html`
    <details class="nodes-entry__details">
      <summary>${t("nodes.inventory.details")}</summary>
      <div class="muted">${t("nodes.inventory.deviceId", { id: entry.id })}</div>
      ${entry.remoteIp
        ? html`<div class="muted">${t("nodes.inventory.remoteIp", { ip: entry.remoteIp })}</div>`
        : nothing}
      ${scopes.length > 0
        ? html`<div class="muted">
            ${t("nodes.inventory.scopes", { scopes: formatList(scopes) })}
          </div>`
        : nothing}
      ${tokens.length > 0
        ? html`
            <div class="muted">${t("nodes.inventory.tokens")}</div>
            ${tokens.map((token) => renderTokenRow(entry.id, token, props))}
          `
        : nothing}
      ${renderCapabilityLine(t("nodes.inventory.capabilities"), caps)}
      ${renderCapabilityLine(t("nodes.inventory.commands"), commands)}
    </details>
  `;
}

function renderInventoryEntry(entry: NodesInventoryEntry, props: NodesProps) {
  const pendingRequestId =
    entry.node?.approvalState === "pending-approval" ||
    entry.node?.approvalState === "pending-reapproval"
      ? entry.node.pendingRequestId
      : undefined;
  const connectionStatus = entry.connected
    ? renderSettingsStatus({ kind: "ok", label: t("nodes.inventory.connected") })
    : renderSettingsStatus({ kind: "muted", label: t("nodes.inventory.offline") });
  return html`
    <div class="settings-row nodes-entry">
      ${renderDeviceTile(deviceIcon(entry))}
      <div class="settings-row__text">
        <span class="settings-row__title">${entry.name}</span>
        <span class="settings-row__desc">${entryMetaLine(entry)}</span>
        ${renderEntryDetails(entry, props)}
      </div>
      <div class="settings-row__control">
        ${connectionStatus} ${entryWarnStatuses(entry, props.gatewayVersion)}
        ${pendingRequestId
          ? html`
              <button class="btn btn--sm" @click=${() => props.onNodeApprove(pendingRequestId)}>
                ${t("nodes.inventory.approve")}
              </button>
              <button class="btn btn--sm" @click=${() => props.onNodeReject(pendingRequestId)}>
                ${t("nodes.inventory.reject")}
              </button>
            `
          : nothing}
        <button
          class="btn btn--sm danger"
          aria-label=${t("nodes.inventory.removeName", { name: entry.name })}
          title=${t("nodes.inventory.remove")}
          @click=${() => props.onInventoryRemove(toRemovalRequest(entry))}
        >
          ${icons.x}
        </button>
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
    <div class="settings-row nodes-entry">
      ${renderDeviceTile(icons.server)}
      <div class="settings-row__text">
        <span class="settings-row__title">${entry.host ?? t("nodes.execApprovals.gateway")}</span>
        ${parts.length > 0
          ? html`<span class="settings-row__desc">${parts.join(" · ")}</span>`
          : nothing}
      </div>
      <div class="settings-row__control">
        ${renderSettingsStatus({ kind: "ok", label: t("nodes.inventory.connected") })}
        ${renderSettingsStatus({ kind: "accent", label: t("nodes.inventory.gateway") })}
      </div>
    </div>
  `;
}

function renderPresenceOnlyEntry(entry: PresenceEntry) {
  const roles = Array.isArray(entry.roles) ? entry.roles.filter(Boolean) : [];
  const parts = [...presenceMetaParts(entry), ...roles];
  return html`
    <div class="settings-row nodes-entry">
      ${renderDeviceTile(
        deviceIcon({ clientMode: entry.mode ?? undefined, platform: entry.platform ?? undefined }),
      )}
      <div class="settings-row__text">
        <span class="settings-row__title">
          ${entry.host ?? entry.mode ?? t("nodes.inventory.unknownClient")}
        </span>
        ${parts.length > 0
          ? html`<span class="settings-row__desc">${parts.join(" · ")}</span>`
          : nothing}
      </div>
      <div class="settings-row__control">
        ${renderSettingsStatus({ kind: "ok", label: t("nodes.inventory.connected") })}
        ${renderSettingsStatus({ kind: "muted", label: t("nodes.inventory.unpaired") })}
      </div>
    </div>
  `;
}

function renderTokenRow(deviceId: string, tokenSummary: DeviceTokenSummary, props: NodesProps) {
  const status = tokenSummary.revokedAtMs
    ? t("nodes.inventory.revoked")
    : t("nodes.inventory.active");
  const scopes = t("nodes.inventory.scopes", { scopes: formatList(tokenSummary.scopes) });
  const when = formatRelativeTimestamp(
    tokenSummary.rotatedAtMs ?? tokenSummary.createdAtMs ?? tokenSummary.lastUsedAtMs ?? null,
  );
  return html`
    <div class="nodes-entry__token">
      <span class="muted">${tokenSummary.role} · ${status} · ${scopes} · ${when}</span>
      <span class="nodes-entry__token-actions">
        <button
          class="btn btn--sm"
          @click=${() => props.onDeviceRotate(deviceId, tokenSummary.role, tokenSummary.scopes)}
        >
          ${t("nodes.inventory.rotate")}
        </button>
        ${tokenSummary.revokedAtMs
          ? nothing
          : html`
              <button
                class="btn btn--sm danger"
                @click=${() => props.onDeviceRevoke(deviceId, tokenSummary.role)}
              >
                ${t("nodes.inventory.revoke")}
              </button>
            `}
      </span>
    </div>
  `;
}
