// Nodes page renders the unified paired-device / node inventory card.
import { html, nothing, type TemplateResult } from "lit";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../../../../src/shared/device-pairing-access.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatList, formatRelativeTimestamp } from "../../lib/format.ts";
import type {
  DeviceTokenSummary,
  InventoryRemovalRequest,
  PairedDevice,
  PendingDevice,
} from "../../lib/nodes/index.ts";
import {
  buildNodesInventory,
  listStaleInventoryEntries,
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

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

export function renderNodesInventory(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  const groups = buildNodesInventory({ paired, nodes: props.nodes });
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
          <div class="card-title">Nodes & devices</div>
          <div class="card-sub">One entry per paired client: roles, tokens, live links.</div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
          ${stale.length > 0
            ? html`
                <button
                  class="btn btn--sm danger"
                  @click=${() => props.onInventoryCleanup(stale.map(toRemovalRequest))}
                >
                  Clean up ${stale.length} stale
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
        ${pending.length > 0
          ? html`
              <div class="muted" style="margin-bottom: 8px;">Pending approval</div>
              ${pending.map((req) =>
                renderPendingDevice(req, props, lookupPairedDevice(pairedByDeviceId, req)),
              )}
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
            `
          : nothing}
        ${groups.length === 0 && pending.length === 0
          ? html` <div class="muted">No paired nodes or devices.</div> `
          : groups.map((group) => renderInventoryGroup(group, props))}
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
          ${group.duplicates.length} older pairing${group.duplicates.length === 1 ? "" : "s"} of
          ${group.name}
        </summary>
        ${group.duplicates.map((entry) => renderInventoryEntry(entry, props))}
      </details>
    </div>
  `;
}

function entryStatusChips(entry: NodesInventoryEntry): TemplateResult[] {
  const chips: TemplateResult[] = [];
  // Connectivity is known for node-catalog entries and for device records with
  // server-computed connection state; legacy node-only rows without either
  // still report offline, which matches their live-link reality.
  chips.push(
    html`<span class="chip ${entry.connected ? "chip-ok" : "chip-warn"}">
      ${entry.connected ? "connected" : "offline"}
    </span>`,
  );
  for (const role of entry.roles) {
    chips.push(html`<span class="chip">${role}</span>`);
  }
  if (entry.autoApproved) {
    chips.push(html`<span class="chip">auto-paired</span>`);
  }
  const approvalState = entry.node?.approvalState;
  if (approvalState === "pending-approval" || approvalState === "pending-reapproval") {
    chips.push(html`<span class="chip chip-warn">approval needed</span>`);
  }
  return chips;
}

function entryMetaLine(entry: NodesInventoryEntry): string {
  const parts: string[] = [shortId(entry.id)];
  if (entry.platform) {
    parts.push(entry.platform);
  }
  if (entry.version) {
    parts.push(entry.version);
  }
  if (entry.remoteIp) {
    parts.push(entry.remoteIp);
  }
  if (entry.lastSeenAtMs) {
    parts.push(`seen ${formatRelativeTimestamp(entry.lastSeenAtMs)}`);
  } else if (entry.approvedAtMs) {
    parts.push(`approved ${formatRelativeTimestamp(entry.approvedAtMs)}`);
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
      ${overflow > 0 ? html`<span class="chip">+${overflow} more</span>` : nothing}
    </div>
  `;
}

function renderEntryDetails(entry: NodesInventoryEntry, props: NodesProps) {
  const tokens = entry.device?.tokens ?? [];
  const caps = entry.node?.caps ?? [];
  const commands = entry.node?.commands ?? [];
  const scopes = entry.scopes;
  if (tokens.length === 0 && caps.length === 0 && commands.length === 0 && scopes.length === 0) {
    return nothing;
  }
  return html`
    <details class="nodes-entry__details">
      <summary>Tokens & capabilities</summary>
      <div class="muted" style="margin-top: 8px; word-break: break-all;">${entry.id}</div>
      ${scopes.length > 0
        ? html`<div class="muted" style="margin-top: 8px;">scopes: ${formatList(scopes)}</div>`
        : nothing}
      ${tokens.length > 0
        ? html`
            <div class="muted" style="margin-top: 8px;">Tokens</div>
            <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
              ${tokens.map((token) => renderTokenRow(entry.id, token, props))}
            </div>
          `
        : nothing}
      ${renderCapabilityChips("Capabilities", caps)} ${renderCapabilityChips("Commands", commands)}
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
          <span class="list-title">${entry.name}</span>
          ${entryStatusChips(entry)}
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
                  Approve
                </button>
                <button class="btn btn--sm" @click=${() => props.onNodeReject(pendingRequestId)}>
                  Reject
                </button>
              `
            : nothing}
          <button
            class="btn btn--sm danger"
            @click=${() => props.onInventoryRemove(toRemovalRequest(entry))}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderTokenRow(deviceId: string, token: DeviceTokenSummary, props: NodesProps) {
  const status = token.revokedAtMs ? "revoked" : "active";
  const scopes = `scopes: ${formatList(token.scopes)}`;
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
          Rotate
        </button>
        ${token.revokedAtMs
          ? nothing
          : html`
              <button
                class="btn btn--sm danger"
                @click=${() => props.onDeviceRevoke(deviceId, token.role)}
              >
                Revoke
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
    return "none";
  }
  return `roles: ${formatList(access.roles)} · scopes: ${formatList(access.scopes)}`;
}

function renderPendingApprovalNote(kind: PendingDeviceApprovalKind) {
  switch (kind) {
    case "scope-upgrade":
      return "scope upgrade requires approval";
    case "role-upgrade":
      return "role upgrade requires approval";
    case "re-approval":
      return "reconnect details changed; approval required";
    case "new-pairing":
      return "new device pairing request";
  }
  const exhaustiveKind: never = kind;
  void exhaustiveKind;
  throw new Error("unsupported pending approval kind");
}

function renderPendingDevice(req: PendingDevice, props: NodesProps, paired?: PairedDevice) {
  const name = normalizeOptionalString(req.displayName) || req.deviceId;
  const age = typeof req.ts === "number" ? formatRelativeTimestamp(req.ts) : t("common.na");
  const approval = resolvePendingDeviceApprovalState(req, paired);
  const repair = req.isRepair ? " · repair" : "";
  const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub">${req.deviceId}${ip}</div>
        <div class="muted" style="margin-top: 6px;">
          ${renderPendingApprovalNote(approval.kind)} · requested ${age}${repair}
        </div>
        <div class="muted" style="margin-top: 6px;">
          requested: ${formatAccessSummary(approval.requested)}
        </div>
        ${approval.approved
          ? html`
              <div class="muted" style="margin-top: 6px;">
                approved now: ${formatAccessSummary(approval.approved)}
              </div>
            `
          : nothing}
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${() => props.onDeviceApprove(req.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${() => props.onDeviceReject(req.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `;
}
