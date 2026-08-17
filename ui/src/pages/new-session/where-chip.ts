import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  renderCloudProfileMenuItems,
  renderCloudMachineMenuItems,
  renderConnectMachineMenuItem,
  renderSessionMenuItem,
} from "./cloud-target.ts";
import type {
  DraftCloudProfile,
  DraftEnvironment,
  DraftMachineOption,
  DraftNode,
} from "./discovery.ts";
import { draftNodeUpdateIssue, isDraftNodeSessionEligible } from "./discovery.ts";
import { disambiguate, isPhoneFamily, nodeTooltip } from "./place-labels.ts";
import { resolvePlacePickerSections } from "./place-picker-sections.ts";

type WhereChipState = Readonly<{
  kind: "local" | "node" | "cloud";
  label: string;
  deviceNodes: readonly DraftNode[];
  deviceFacts: ReadonlyMap<string, readonly string[]>;
  cloudProfiles: readonly DraftCloudProfile[];
  cloudMachines: readonly DraftMachineOption[];
  selectedMachineId: string;
}>;

function nodeUpdateIssueCopy(node: DraftNode): string | undefined {
  const issue = draftNodeUpdateIssue(node);
  return issue
    ? t("newSession.nodeUpdateRequired", {
        updateCommand: issue.updateCommand,
        restartCommand: issue.headlessReconnectCommand,
      })
    : undefined;
}

export function resolveWhereChip(params: {
  execNodes: readonly DraftNode[];
  environments: readonly DraftEnvironment[] | null;
  cloudProfiles: readonly DraftCloudProfile[];
  cloudProfileId: string;
  machineClass?: string;
  execNode: string;
}): WhereChipState {
  const sections = resolvePlacePickerSections(params);
  const node = sections.deviceNodes.find((candidate) => candidate.nodeId === params.execNode);
  const profile = sections.cloudProfiles.find(
    (candidate) => candidate.id === params.cloudProfileId,
  );
  if (params.cloudProfileId) {
    const cloudMachines = profile?.machines ?? [];
    const defaultMachine = cloudMachines.find((machine) => machine.default === true);
    const selectedMachine = params.machineClass
      ? cloudMachines.find((machine) => machine.id === params.machineClass)
      : defaultMachine;
    return {
      kind: "cloud",
      label: params.machineClass
        ? t("newSession.cloudWorkerMachine", {
            profile: profile?.id ?? params.cloudProfileId,
            machine: selectedMachine?.label ?? params.machineClass,
          })
        : (profile?.id ?? params.cloudProfileId),
      cloudMachines,
      selectedMachineId: selectedMachine?.id ?? "",
      ...sections,
    };
  }
  if (params.execNode) {
    return {
      kind: "node",
      label: node?.displayName ?? params.execNode,
      cloudMachines: [],
      selectedMachineId: "",
      ...sections,
    };
  }
  return {
    kind: "local",
    label: t("newSession.local"),
    cloudMachines: [],
    selectedMachineId: "",
    ...sections,
  };
}

export function renderWhereChip(params: {
  state: WhereChipState;
  gatewayName: string;
  cloudProfileId: string;
  machineClass?: string;
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
  onSelectCloudMachine?: (machineId: string) => void;
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
        data-machine-class=${params.machineClass || nothing}
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
              ${params.state.deviceNodes.map((node, index) => {
                const updateIssue = nodeUpdateIssueCopy(node);
                return renderSessionMenuItem(
                  {
                    value: `node:${node.nodeId}`,
                    label: node.displayName,
                    icon: isPhoneFamily(node.deviceFamily)
                      ? icons.monitorSmartphone
                      : icons.monitor,
                    sub: nodeSuffixes[index],
                    facts: updateIssue ? [updateIssue] : params.state.deviceFacts.get(node.nodeId),
                    checked: params.execNode === node.nodeId,
                    disabled: !isDraftNodeSessionEligible(node),
                    title: updateIssue ?? nodeTooltip(node),
                    onSelect: () => params.onSelectExecNode(node.nodeId),
                  },
                  params.submitting,
                );
              })}
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
        ${params.state.kind === "cloud" && params.state.cloudMachines.length > 0
          ? html`
              <div class="new-session-page__menu-title">${t("newSession.machine")}</div>
              ${renderCloudMachineMenuItems({
                machines: params.state.cloudMachines,
                selectedId: params.state.selectedMachineId,
                submitting: params.submitting,
                onSelect: params.onSelectCloudMachine ?? (() => undefined),
              })}
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
