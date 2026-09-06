import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Devices page renders the unified paired-device / node inventory sections.
import { html, nothing, type TemplateResult } from "lit";
import type { PresenceEntry } from "../../api/types.ts";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { workerCapacityPresentation } from "../../components/worker-capacity.ts";
import { t } from "../../i18n/index.ts";
import {
  formatDurationCompact,
  formatList,
  formatRelativeTimestamp,
  formatTimeAgo,
} from "../../lib/format.ts";
import { macFamilyLabel } from "../../lib/mac-form-factor.ts";
import type { DeviceTokenSummary, InventoryRemovalRequest } from "../../lib/nodes/index.ts";
import {
  buildDeviceInventory,
  findGatewayPresence,
  listStaleInventoryEntries,
  listUnpairedPresence,
  resolveInventoryRemoval,
  type DeviceInventoryEntry,
  type DeviceInventoryGroup,
} from "../../lib/nodes/inventory.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { renderCapabilityChips } from "./capability-chips.ts";
import { deviceDesktopEnvironment, renderDeviceEntryMenu } from "./entry-menu.ts";
import { renderHostStats } from "./host-stats.ts";
import { renderPendingDeviceRows } from "./view-pending-devices.ts";
import { deviceIcon, renderDeviceTile } from "./view-shared.ts";
import type { DevicesProps } from "./view.types.ts";

function toRemovalRequest(entry: DeviceInventoryEntry): InventoryRemovalRequest {
  const removal = resolveInventoryRemoval(entry);
  return { id: entry.id, name: entry.name, ...removal };
}

function inventorySummary(
  groups: DeviceInventoryGroup[],
  pendingCount: number,
  loading: boolean,
): string {
  if (loading && groups.length === 0) {
    return "";
  }
  const connected = groups.filter((group) => group.primary.connected).length;
  const parts = [
    t("devices.inventory.summaryConnected", {
      connected: String(connected),
      total: String(groups.length),
    }),
  ];
  if (pendingCount > 0) {
    parts.push(t("devices.inventory.summaryPending", { count: String(pendingCount) }));
  }
  return parts.join(" · ");
}

export function renderDeviceInventory(props: DevicesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  const groups = buildDeviceInventory({ paired, nodes: props.nodes, presence: props.presence });
  const gatewayPresence = findGatewayPresence(props.presence);
  const unpairedPresence = listUnpairedPresence(props.presence, groups);
  const stale = listStaleInventoryEntries(groups);
  const loading = props.loading || props.devicesLoading;
  const actions = html`
    ${
      stale.length > 0
        ? html`
            <button
              class="btn btn--sm danger"
              title=${props.canManagePairing ? "" : t("devices.readOnly.pairingRequired")}
              ?disabled=${!props.canManagePairing}
              @click=${() => props.onInventoryCleanup(stale.map(toRemovalRequest))}
            >
              ${icons.trash} ${t("devices.inventory.cleanupStale", { count: String(stale.length) })}
            </button>
          `
        : nothing
    }
    <button
      class="btn"
      title=${props.canPairDevice ? "" : t("devices.pairing.adminRequired")}
      ?disabled=${!props.canPairDevice}
      @click=${props.onDevicePairSetupOpen}
    >
      ${icons.plus} ${t("devices.pairing.button")}
    </button>
  `;
  // Pending requests and unpaired presence render in their own sections, so
  // this section's empty state depends only on its own rows.
  const empty = groups.length === 0 && !gatewayPresence;
  const deviceRows = html`
    ${
      gatewayPresence
        ? renderPresenceRow({ kind: "gateway", entry: gatewayPresence }, props)
        : nothing
    }
    ${
      loading && groups.length === 0
        ? renderSettingsLoadingSkeleton()
        : empty
          ? renderSettingsEmpty(t("devices.inventory.empty"))
          : groups.map((group) => renderInventoryGroup(group, props))
    }
  `;
  return html`
    ${props.devicesError ? html`<div class="callout danger">${props.devicesError}</div>` : nothing}
    ${props.lastError ? html`<div class="callout danger">${props.lastError}</div>` : nothing}
    ${
      pending.length > 0
        ? renderSettingsSection(
            { title: t("devices.inventory.pendingApproval"), count: pending.length },
            renderPendingDeviceRows(pending, paired, props),
          )
        : nothing
    }
    ${renderSettingsSection(
      {
        title: t("devices.inventory.title"),
        description: inventorySummary(groups, pending.length, loading),
        actions,
      },
      deviceRows,
    )}
    ${
      unpairedPresence.length > 0
        ? renderSettingsSection(
            { title: t("devices.inventory.connectedWithoutPairing") },
            unpairedPresence.map((entry) => renderPresenceRow({ kind: "unpaired", entry }, props)),
          )
        : nothing
    }
  `;
}

function renderInventoryGroup(group: DeviceInventoryGroup, props: DevicesProps) {
  if (group.duplicates.length === 0) {
    return renderInventoryEntry(group.primary, props);
  }
  return html`
    ${renderInventoryEntry(group.primary, props)}
    <details class="device-group__dups">
      <summary>
        ${t(
          group.duplicates.length === 1
            ? "devices.inventory.olderPairing"
            : "devices.inventory.olderPairings",
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

function isApprovedNodeEntry(entry: DeviceInventoryEntry): boolean {
  const node = entry.node;
  if (!node?.paired) {
    return false;
  }
  return node.approvalState === undefined || node.approvalState === "approved";
}

function resolveNodeCoreVersion(entry: DeviceInventoryEntry): string | undefined {
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
  entry: DeviceInventoryEntry,
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
    const title = t("devices.inventory.versionDriftTitle", {
      nodeVersion,
      gatewayVersion: normalizedGatewayVersion,
    });
    statuses.push(
      html`<span title=${title}>
        ${renderSettingsStatus({ kind: "warn", label: t("devices.inventory.versionDrift") })}
      </span>`,
    );
  }
  if (entry.node?.workerBundle?.status === "missing") {
    statuses.push(
      html`<span title=${t("devices.inventory.workerMissingTitle")}>
        ${renderSettingsStatus({ kind: "warn", label: t("devices.inventory.workerMissing") })}
      </span>`,
    );
  }
  if (isApprovedNode && entry.node?.connected === false && isWindowsPlatform(entry.platform)) {
    statuses.push(
      html`<span title=${t("devices.inventory.manualWakeTitle")}>
        ${renderSettingsStatus({ kind: "warn", label: t("devices.inventory.manualWake") })}
      </span>`,
    );
  }
  const approvalState = entry.node?.approvalState;
  if (approvalState === "pending-approval" || approvalState === "pending-reapproval") {
    statuses.push(
      renderSettingsStatus({ kind: "warn", label: t("devices.inventory.approvalNeeded") }),
    );
  }
  return statuses;
}

function formatInputRecency(lastInputSeconds: number): string {
  return t("devices.inventory.inputAgo", {
    time: formatTimeAgo(lastInputSeconds * 1000, { suffix: false }),
  });
}

function entryMetaLine(entry: DeviceInventoryEntry): string {
  const parts: string[] = [];
  if (entry.platform) {
    parts.push(prettifyPlatform(entry.platform));
  }
  if (entry.modelIdentifier) {
    const family = macFamilyLabel(entry.modelIdentifier);
    if (family) {
      parts.push(family);
    }
    parts.push(entry.modelIdentifier);
  }
  if (entry.version) {
    parts.push(entry.version);
  }
  if (entry.node?.workerBundle?.status === "installed") {
    parts.push(t("devices.inventory.workerVersion", { version: entry.node.workerBundle.version }));
  }
  if (entry.connected && entry.presence?.lastInputSeconds != null) {
    parts.push(formatInputRecency(entry.presence.lastInputSeconds));
  } else if (!entry.connected && entry.lastSeenAtMs) {
    parts.push(t("devices.inventory.seen", { time: formatRelativeTimestamp(entry.lastSeenAtMs) }));
  } else if (!entry.connected && entry.approvedAtMs) {
    parts.push(
      t("devices.inventory.approved", { time: formatRelativeTimestamp(entry.approvedAtMs) }),
    );
  }
  for (const role of entry.roles) {
    parts.push(role);
  }
  if (entry.autoApproved) {
    parts.push(t("devices.inventory.autoPaired"));
  }
  return parts.join(" · ");
}

// Node-controlled lists are unbounded input; cap the rendered items so a
// hostile or chatty node cannot bloat the inventory render.
const COMMAND_LINE_LIMIT = 16;

function renderCommandLine(values: string[]) {
  if (values.length === 0) {
    return nothing;
  }
  const visible = values.slice(0, COMMAND_LINE_LIMIT);
  const overflow = values.length - visible.length;
  const suffix = overflow > 0 ? ` +${overflow}` : "";
  return html`<dt class="settings-row__desc">${t("devices.inventory.commands")}</dt>
    <dd class="settings-row__value settings-row__value--mono">${formatList(visible)}${suffix}</dd>`;
}

function renderEntryDetails(entry: DeviceInventoryEntry, props: DevicesProps) {
  const tokens = entry.device?.tokens ?? [];
  const commands = entry.node?.commands ?? [];
  const scopes = entry.scopes;
  return html`
    <details class="device-entry__details">
      <summary>${t("devices.inventory.details")}</summary>
      <dl class="device-entry__facts">
        <dt class="settings-row__desc">${t("devices.inventory.deviceIdLabel")}</dt>
        <dd class="settings-row__value settings-row__value--mono" title=${entry.id}>${entry.id}</dd>
        ${
          entry.remoteIp
            ? html`<dt class="settings-row__desc">${t("devices.inventory.remoteIpLabel")}</dt>
                <dd class="settings-row__value settings-row__value--mono">${entry.remoteIp}</dd>`
            : nothing
        }
        ${
          scopes.length > 0
            ? html`<dt class="settings-row__desc">${t("devices.inventory.scopesLabel")}</dt>
                <dd class="device-entry__scopes">
                  ${scopes.map(
                    (scope) =>
                      html`<span class="device-capability device-capability--scope"
                        >${scope}</span
                      >`,
                  )}
                </dd>`
            : nothing
        }
        ${
          tokens.length > 0
            ? html`<dt class="settings-row__desc">${t("devices.inventory.tokens")}</dt>
                <dd class="device-entry__tokens">
                  <table class="device-token-table" aria-label=${t("devices.inventory.tokens")}>
                    <thead>
                      <tr>
                        <th scope="col">${t("devices.inventory.tokenRole")}</th>
                        <th scope="col">${t("devices.inventory.tokenStatus")}</th>
                        <th scope="col">${t("devices.inventory.scopesLabel")}</th>
                        <th scope="col">${t("devices.inventory.tokenAge")}</th>
                        <th scope="col">${t("devices.inventory.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${tokens.map((token) =>
                        renderTokenRow({ id: entry.id, name: entry.name }, token, props),
                      )}
                    </tbody>
                  </table>
                </dd>`
            : nothing
        }
        ${renderCommandLine(commands)}
      </dl>
    </details>
  `;
}

function renderInventoryEntry(entry: DeviceInventoryEntry, props: DevicesProps) {
  const capacity = workerCapacityPresentation({
    workerSlots: entry.node?.workerSlots,
    capabilities: entry.node?.caps,
    commands: entry.node?.commands,
    unavailable: entry.node?.connected !== true || !isApprovedNodeEntry(entry),
  });
  const pendingRequestId =
    entry.node?.approvalState === "pending-approval" ||
    entry.node?.approvalState === "pending-reapproval"
      ? entry.node.pendingRequestId
      : undefined;
  const desktopEnvironment = deviceDesktopEnvironment(props, `node:${entry.id}`);
  const rowConnected = entry.node?.connected ?? entry.connected;
  const connectionStatus = rowConnected
    ? renderSettingsStatus({ kind: "ok", label: t("devices.inventory.connected") })
    : renderSettingsStatus({ kind: "muted", label: t("devices.inventory.offline") });
  return html`
    <div class="settings-row device-entry" title=${capacity?.title ?? nothing}>
      ${renderDeviceTile(deviceIcon(entry))}
      <div class="device-entry__body">
        <div class="device-entry__heading">
          <span class="settings-row__title">${entry.name}</span>
          <span class="device-entry__status">${connectionStatus}</span>
        </div>
        <span class="settings-row__desc">${entryMetaLine(entry)}</span>
        ${renderHostStats(
          entry.node?.hostStats,
          !rowConnected ? entry.node?.hostStats?.updatedAtMs : undefined,
        )}
        ${renderCapabilityChips(entry.node?.caps ?? [])}
      </div>
      <div class="settings-row__control">
        ${capacity?.meter ?? nothing} ${entryWarnStatuses(entry, props.gatewayVersion)}
        ${renderDesktopControl(props, desktopEnvironment, entry.node?.commands)}
        ${renderDeviceEntryMenu(props, {
          name: entry.name,
          deviceId: entry.id,
          desktopEnvironment,
          pendingRequestId,
          onEditAlias: entry.device
            ? () =>
                props.onDeviceRename({
                  id: entry.id,
                  name: entry.name,
                  operatorLabel: entry.device?.operatorLabel,
                })
            : undefined,
          onRemove: () => props.onInventoryRemove(toRemovalRequest(entry)),
        })}
      </div>
      ${renderEntryDetails(entry, props)}
    </div>
  `;
}

function presenceMetaParts(entry: PresenceEntry): string[] {
  const parts: string[] = [];
  if (entry.platform) {
    parts.push(prettifyPlatform(entry.platform));
  }
  if (entry.modelIdentifier) {
    const family = macFamilyLabel(entry.modelIdentifier);
    if (family) {
      parts.push(family);
    }
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

function renderPresenceRow(
  presence: { kind: "gateway"; entry: PresenceEntry } | { kind: "unpaired"; entry: PresenceEntry },
  props: DevicesProps,
) {
  const { entry } = presence;
  const gateway = presence.kind === "gateway";
  const parts = presenceMetaParts(entry);
  if (gateway && props.gatewaySystemInfo) {
    parts.push(
      t("devices.inventory.uptime", {
        time: formatDurationCompact(props.gatewaySystemInfo.uptimeMs) ?? "",
      }),
    );
  }
  if (!gateway && Array.isArray(entry.roles)) {
    parts.push(...entry.roles.filter(Boolean));
  }
  const icon = gateway
    ? icons.server
    : deviceIcon({
        clientMode: entry.mode ?? undefined,
        platform: entry.platform ?? undefined,
        modelIdentifier: entry.modelIdentifier ?? undefined,
      });
  const title = gateway
    ? (entry.host ?? t("devices.execApprovals.gateway"))
    : (entry.host ?? entry.mode ?? t("devices.inventory.unknownClient"));
  const desktopEnvironment = gateway ? deviceDesktopEnvironment(props, "gateway") : undefined;
  return html`
    <div class="settings-row device-entry">
      ${renderDeviceTile(icon)}
      <div class="device-entry__body">
        <div class="device-entry__heading">
          <span class="settings-row__title">${title}</span>
          <span class="device-entry__status">
            ${
              gateway
                ? renderSettingsStatus({ kind: "accent", label: t("devices.inventory.gateway") })
                : renderSettingsStatus({ kind: "muted", label: t("devices.inventory.unpaired") })
            }
          </span>
        </div>
        ${
          parts.length > 0
            ? html`<span class="settings-row__desc">${parts.join(" · ")}</span>`
            : nothing
        }
        ${gateway ? renderHostStats(props.gatewaySystemInfo) : nothing}
      </div>
      <div class="settings-row__control">
        ${renderDesktopControl(props, desktopEnvironment)}
        ${renderDeviceEntryMenu(props, {
          name: title,
          deviceId: entry.deviceId,
          desktopEnvironment,
        })}
      </div>
    </div>
  `;
}

function renderDesktopControl(
  props: DevicesProps,
  environmentId: string | undefined,
  commands?: string[],
) {
  if (environmentId) {
    // Settings routes suppress the docked Desktop panel, so the row opens the
    // standalone desktop focus window instead of dispatching a panel toggle.
    return html`<button
      class="btn btn--sm device-entry__desktop"
      title=${t("devices.inventory.desktopOpenWindow")}
      @click=${() => openDesktopFocus(props.basePath, environmentId)}
    >
      ${icons.monitor} ${t("devices.inventory.desktop")}
    </button>`;
  }
  return commands?.includes("desktop.stream")
    ? html`<span
        class="device-capability device-capability--disabled"
        aria-disabled="true"
        title=${t("devices.inventory.desktopEnableHint")}
        >${icons.monitor} ${t("devices.inventory.desktop")}</span
      >`
    : nothing;
}

function renderTokenRow(
  device: { id: string; name: string },
  tokenSummary: DeviceTokenSummary,
  props: DevicesProps,
) {
  const status = tokenSummary.revokedAtMs
    ? t("devices.inventory.revoked")
    : t("devices.inventory.active");
  const scopes = formatList(tokenSummary.scopes);
  const when = formatRelativeTimestamp(
    tokenSummary.rotatedAtMs ?? tokenSummary.createdAtMs ?? tokenSummary.lastUsedAtMs ?? null,
  );
  return html`
    <tr>
      <td>${tokenSummary.role}</td>
      <td>${status}</td>
      <td>${scopes}</td>
      <td>${when}</td>
      <td>
        <div class="device-entry__token-actions">
          <button
            class="btn btn--sm"
            ?disabled=${!props.canManagePairing}
            @click=${() => props.onDeviceRotate(device, tokenSummary.role, tokenSummary.scopes)}
          >
            ${t("devices.inventory.rotate")}
          </button>
          ${
            tokenSummary.revokedAtMs
              ? nothing
              : html`
                  <button
                    class="btn btn--sm danger"
                    ?disabled=${!props.canManagePairing}
                    @click=${() => props.onDeviceRevoke(device.id, tokenSummary.role)}
                  >
                    ${t("devices.inventory.revoke")}
                  </button>
                `
          }
        </div>
      </td>
    </tr>
  `;
}
