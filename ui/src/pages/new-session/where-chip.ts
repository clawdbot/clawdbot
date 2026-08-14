import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  renderCloudProfileMenuItems,
  renderConnectMachineMenuItem,
  renderSessionMenuItem,
} from "./cloud-target.ts";
import type { DraftCloudProfile, DraftEnvironment, DraftNode } from "./discovery.ts";
import { disambiguate, isPhoneFamily, nodeTooltip } from "./place-labels.ts";
import { resolvePlacePickerSections } from "./place-picker-sections.ts";

type WhereChipState = Readonly<{
  kind: "local" | "node" | "cloud";
  label: string;
  deviceNodes: readonly DraftNode[];
  deviceFacts: ReadonlyMap<string, readonly string[]>;
  cloudProfiles: readonly DraftCloudProfile[];
}>;

export function resolveWhereChip(params: {
  execNodes: readonly DraftNode[];
  environments: readonly DraftEnvironment[] | null;
  cloudProfiles: readonly DraftCloudProfile[];
  cloudProfileId: string;
  execNode: string;
}): WhereChipState {
  const sections = resolvePlacePickerSections(params);
  const node = sections.deviceNodes.find((candidate) => candidate.nodeId === params.execNode);
  const profile = sections.cloudProfiles.find(
    (candidate) => candidate.id === params.cloudProfileId,
  );
  if (params.cloudProfileId) {
    return {
      kind: "cloud",
      label: profile?.id ?? params.cloudProfileId,
      ...sections,
    };
  }
  if (params.execNode) {
    return {
      kind: "node",
      label: node?.displayName ?? params.execNode,
      ...sections,
    };
  }
  return { kind: "local", label: t("newSession.local"), ...sections };
}

export function renderWhereChip(params: {
  state: WhereChipState;
  gatewayName: string;
  cloudProfileId: string;
  execNode: string;
  worktreeAvailable: boolean;
  cloudDisabledReason?: string;
  submitting: boolean;
  pendingCloud: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  isAdmin: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectExecNode: (nodeId: string) => void;
  onSelectCloudProfile: (profileId: string) => void;
  onConnectMachine: () => void;
}) {
  const activeNode = params.state.deviceNodes.find((node) => node.nodeId === params.execNode);
  const icon =
    params.state.kind === "cloud"
      ? icons.server
      : params.state.kind === "node" && isPhoneFamily(activeNode?.deviceFamily)
        ? icons.monitorSmartphone
        : icons.monitor;
  const gatewayTitle = params.gatewayName
    ? t("newSession.gatewayNamed", { name: params.gatewayName })
    : t("newSession.gateway");
  const nodeSuffixes = disambiguate(params.state.deviceNodes, (node) => node.displayName, [
    (node) => node.modelIdentifier,
    (node) => node.remoteIp,
    (node) => node.nodeId.slice(0, 8),
  ]);

  return html`
    <span class="new-session-page__select">
      <button
        id="new-session-where-trigger"
        type="button"
        class="new-session-page__trigger ${params.popoverHiding
          ? "new-session-page__trigger--hiding"
          : ""}"
        title=${t("newSession.where")}
        aria-label="${t("newSession.where")}: ${params.state.label}"
        data-cloud-profile=${params.cloudProfileId || nothing}
        data-exec-node=${params.execNode || nothing}
        aria-haspopup="dialog"
        aria-expanded=${String(params.popoverOpen)}
        ?disabled=${params.submitting || params.pendingCloud}
        @click=${params.onGuardTransition}
      >
        <span class="new-session-page__target-icon" aria-hidden="true">${icon}</span>
        <span class="new-session-page__trigger-label">${params.state.label}</span>
        <span class="new-session-page__trigger-chevron" aria-hidden="true"
          >${icons.chevronDown}</span
        >
      </button>
    </span>
    <wa-popover
      class="new-session-page__select new-session-page__where-popover new-session-page__picker-popover"
      for="new-session-where-trigger"
      placement="bottom-start"
      without-arrow
      @wa-show=${params.onPopoverShow}
      @wa-hide=${params.onPopoverHide}
      @wa-after-hide=${params.onPopoverAfterHide}
    >
      <div class="new-session-page__picker-root">
        ${renderSessionMenuItem(
          {
            value: "gateway",
            label: t("newSession.local"),
            icon: icons.monitor,
            sub: params.gatewayName || undefined,
            checked: !params.execNode && !params.cloudProfileId,
            title: gatewayTitle,
            onSelect: () => params.onSelectExecNode(""),
          },
          params.submitting,
        )}
        ${params.state.deviceNodes.length > 0
          ? html`
              <div class="new-session-page__menu-title">${t("newSession.yourDevices")}</div>
              ${params.state.deviceNodes.map((node, index) =>
                renderSessionMenuItem(
                  {
                    value: `node:${node.nodeId}`,
                    label: node.displayName,
                    icon: isPhoneFamily(node.deviceFamily)
                      ? icons.monitorSmartphone
                      : icons.monitor,
                    sub: nodeSuffixes[index],
                    facts: params.state.deviceFacts.get(node.nodeId),
                    checked: params.execNode === node.nodeId,
                    disabled: !node.connected,
                    title: nodeTooltip(node),
                    onSelect: () => params.onSelectExecNode(node.nodeId),
                  },
                  params.submitting,
                ),
              )}
            `
          : nothing}
        ${params.state.cloudProfiles.length > 0 || params.cloudProfileId
          ? html`
              <div class="new-session-page__menu-title">${t("newSession.cloud")}</div>
              ${renderCloudProfileMenuItems({
                profiles: params.state.cloudProfiles,
                selectedId: params.cloudProfileId,
                submitting: params.submitting,
                icon: icons.server,
                disabled: !params.worktreeAvailable || Boolean(params.cloudDisabledReason),
                disabledReason: params.cloudDisabledReason,
                onSelect: params.onSelectCloudProfile,
              })}
              ${params.cloudProfileId &&
              !params.state.cloudProfiles.some((profile) => profile.id === params.cloudProfileId)
                ? renderSessionMenuItem(
                    {
                      value: `cloud:${params.cloudProfileId}`,
                      label: t("newSession.cloudWorker", { profile: params.cloudProfileId }),
                      icon: icons.server,
                      checked: true,
                      disabled: true,
                      title: t("newSession.catalogUnavailable"),
                      onSelect: () => undefined,
                    },
                    params.submitting,
                  )
                : nothing}
            `
          : nothing}
        ${params.isAdmin
          ? renderConnectMachineMenuItem({
              disabled: params.submitting || params.pendingCloud,
              onSelect: params.onConnectMachine,
            })
          : nothing}
      </div>
    </wa-popover>
  `;
}
