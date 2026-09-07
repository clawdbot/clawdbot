import { html, nothing } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentTargetLabel } from "../../lib/agents/display.ts";
import type { AgentIdentityCapability } from "../../lib/agents/identity.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import { renderCheckoutChip, resolveCheckoutChip } from "./checkout-chip.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { NewSessionRouteData } from "./location.ts";
import "../../components/agent-select-registration.ts";
import { renderProjectChip, resolveProjectChip } from "./project-chip.ts";
import { resolveCloudPlacementDisabledReason } from "./submit-gates.ts";
import { renderNewSessionTerminalHost } from "./terminal-start.ts";
import { renderWhereChip, resolveWhereChip } from "./where-chip.ts";

type DraftAgent = GatewayAgentRow;

export function renderAgentSelect(params: {
  agents: DraftAgent[];
  agentId: string;
  agentIdentity?: AgentIdentityCapability;
  disabled: boolean;
  onSelect: (agentId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const selectedId = normalizeAgentId(params.agentId);
  return html`
    <span class="new-session-page__select new-session-page__select--agent">
      <openclaw-agent-select
        class="agent-select--compact"
        .options=${params.agents.map((agent) => ({
          value: normalizeAgentId(agent.id),
          label: normalizeAgentTargetLabel(agent, params.agentIdentity?.get(agent.id)),
          agent,
        }))}
        .value=${selectedId}
        .accessibleLabel=${t("newSession.agent")}
        .menuLabel=${t("newSession.agents")}
        .disabled=${params.disabled}
        .onSelect=${params.onSelect}
        @wa-show=${() => params.onOpenChange(true)}
        @wa-hide=${() => params.onOpenChange(false)}
      ></openclaw-agent-select>
    </span>
  `;
}

export function renderNewSessionPlaceControls({
  context,
  data,
  gateway,
  place,
  submitting,
  pendingPlacement,
  onConnectMachine,
  requestUpdate,
}: {
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  gateway: DraftGatewayState;
  place: DraftPlaceState;
  submitting: boolean;
  pendingPlacement: boolean;
  onConnectMachine: () => void;
  requestUpdate: () => void;
}) {
  const browser = place.browser;
  const nativeTerminal = catalog.isTarget(data);
  const cloudProfiles = nativeTerminal || !place.isAdmin() ? [] : gateway.cloudProfiles;
  const branches = place.repository.kind === "git" ? place.repository : null;
  const projects = nativeTerminal ? [] : browser.projects;
  const recents = nativeTerminal
    ? []
    : browser.resolveProjectRecents({
        sessions: context?.sessions.state.result?.sessions ?? [],
        workspace: place.workspacePath(),
        workspaceRoots: place.knownWorkspaceRoots(),
        isAdmin: place.isAdmin(),
      });
  const whereState = resolveWhereChip({
    environments: place.canWrite() ? gateway.environments : [],
    cloudProfiles,
    cloudProfileId: place.cloudProfileId,
    machineClass: place.machineClass,
    deviceId: place.deviceId,
    autoDevice: place.autoDevice,
    devicePlacement: place.devicePlacementRuntime()?.devicePlacement,
    deviceDisabledReason:
      place.modelControl.devicePlacementUnsupportedReason() ?? gateway.deviceCatalogDisabledReason,
  });
  const projectState = resolveProjectChip({
    folder: place.folder,
    workspace: place.workspacePath(),
    projectId: browser.projectId,
    selectedRemoteProject: browser.remoteProject,
    projects,
    recents,
    projectQuery: browser.projectQuery,
  });
  const checkoutState = resolveCheckoutChip({
    destination: place.remotePlacement ? "remote" : "local",
    worktree: place.worktree,
    worktreeAvailable: place.worktreeAvailable(),
    headBranch: branches?.headBranch,
    baseRef: place.baseRef,
    repository: Boolean(place.remoteRepository),
  });
  const gatewayLabel = gateway.gatewayName
    ? t("newSession.gatewayNamed", { name: gateway.gatewayName })
    : t("newSession.gateway");
  return html`${
    nativeTerminal
      ? renderNewSessionTerminalHost({
          hosts: data?.terminalHosts ?? [],
          hostId: place.terminalHostId,
          submitting,
          refreshing: gateway.catalogRetrying,
          onSelect: (hostId) => place.selectTerminalHost(hostId),
          onRefresh: gateway.handleCatalogRetry,
        })
      : renderWhereChip({
          state: whereState,
          gatewayName: gateway.gatewayName,
          cloudProfileId: place.cloudProfileId,
          machineClass: place.machineClass,
          deviceId: place.deviceId,
          autoDevice: place.autoDevice,
          autoPlacementMode: place.modelControl.autoPlacementSelectionMode(),
          worktreeAvailable: place.worktreeAvailable(),
          cloudDisabledReason: resolveCloudPlacementDisabledReason(place),
          cloudProfileDisabledReason: (profile) =>
            place.modelControl.cloudRuntimeUnsupportedReason(profile),
          submitting,
          pendingPlacement,
          isAdmin: place.isAdmin(),
          ...browser.popoverCallbacks("where"),
          onSelectDevice: (deviceId) => place.selectDevice(deviceId),
          onSelectAutoDevice: () => place.selectDevice("", true),
          onSelectCloudProfile: (profileId) => place.selectCloudProfile(profileId),
          onSelectCloudMachine: (machineId) =>
            place.cloudMachines.select(
              place.cloudProfileId,
              machineId,
              cloudProfiles,
              submitting || pendingPlacement,
              requestUpdate,
            ),
          onConnectMachine,
        })
  }${
    nativeTerminal && place.terminalOnNode
      ? html`<label class="new-session-page__select new-session-page__menu-field"
          ><span>${t("newSession.terminalNodeFolder")}</span
          ><input
            aria-label=${t("newSession.terminalNodeFolder")}
            .value=${place.folder}
            ?disabled=${submitting}
            @input=${(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement) {
                place.applyFolder(event.currentTarget.value);
              }
            }}
        /></label>`
      : renderProjectChip({
          state: projectState,
          browseAvailable: place.browseAvailable(),
          isAdmin: place.isAdmin(),
          canWrite: place.canWrite(),
          folder: place.folder,
          workspace: place.workspacePath(),
          projects,
          projectQuery: browser.projectQuery,
          projectSearchAvailable:
            !nativeTerminal &&
            canCallGatewayMethod(
              context?.gateway.snapshot,
              "projects.searchRemote",
              "operator.read",
            ),
          projectAddAvailable:
            !nativeTerminal &&
            canCallGatewayMethod(
              context?.gateway.snapshot,
              place.remotePlacement ? "sessions.create" : "projects.add",
              "operator.write",
            ),
          remoteProjects: browser.projectSearchResult?.projects ?? [],
          selectedRemoteProject: browser.remoteProject,
          projectSearchCredentialMissing: browser.projectSearchResult?.credential === "missing",
          projectSearchLoading: browser.projectSearchLoading,
          projectSearchError: browser.projectSearchError,
          projectId: browser.projectId,
          gatewayLabel,
          submitting,
          pendingPlacement,
          ...browser.popoverCallbacks("project"),
          browserOpen: browser.browserOpen,
          browser: browser.browser,
          registerProjectPath: browser.browserProjectPath,
          registeringProject: browser.browserRegistering,
          onSelectProject: (projectId) => place.selectProjectId(projectId),
          onProjectQueryInput: (query) => browser.changeProjectQuery(query),
          onSelectRemoteProject: (project) => place.selectRemoteProject(project),
          onApplyFolder: (folder) => place.applyFolder(folder),
          onBrowse: () =>
            browser.selectGatewayBrowser(place.folder.trim() || place.workspacePath()),
          onBrowserBack: () => browser.showRoot(),
          onRegisterProject: (path) => void browser.registerBrowserProject(path),
          onClose: () => browser.close(),
        })
  }${
    checkoutState && !(nativeTerminal && place.terminalOnNode)
      ? renderCheckoutChip({
          state: checkoutState,
          remotePlacement: place.remotePlacement,
          repository: Boolean(place.remoteRepository),
          folderLabel: projectState.label,
          worktree: place.worktree,
          worktreeAvailable: place.worktreeAvailable(),
          repositoryUnavailable: place.repository.kind === "unavailable",
          branches,
          branchesLoading: place.repository.kind === "checking",
          baseRef: place.baseRef,
          worktreeName: place.worktreeName,
          submitting,
          pendingPlacement,
          ...browser.popoverCallbacks("checkout"),
          onSelectWorktree: (value) => place.selectWorktree(value),
          onBaseRefInput: (baseRef) => place.setBaseRef(baseRef),
          onWorktreeNameInput: (worktreeName) => place.setWorktreeName(worktreeName),
        })
      : nothing
  }`;
}
