import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import {
  buildDraftSessionCreateParams,
  type DraftSessionCreateSelection,
} from "./create-params.ts";
import {
  projectDevicePlacements,
  resolveAutomaticDevicePlacementDisabledReason,
} from "./device-placement.ts";
import { DraftCloudMachineState } from "./draft-cloud-machine-state.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftRepositoryController } from "./draft-repository-state.ts";
import type { PendingPlacementPlace } from "./draft-session-placement.ts";
import { DraftRestoredFolderValidation } from "./folder-validation.ts";
import type { NewSessionRouteData } from "./location.ts";
import { newSessionSearch } from "./location.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { resolveNewSessionWhere, type NewSessionWhere } from "./preferences.ts";
import type { DraftRemoteProject } from "./project-chip.ts";

type DraftPlaceSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  submitting: boolean;
  pendingPlacementSessionKey: string;
}>;

type DraftPlaceCallbacks = {
  requestUpdate: () => void;
  onError: (error: string | null) => void;
  onClearError: (error: string) => void;
};

export class DraftPlaceState {
  terminalHostId = "gateway:local";

  get terminalOnNode(): boolean {
    return this.terminalHostId.startsWith("node:");
  }

  selectTerminalHost(hostId: string) {
    if (this.read().submitting || hostId === this.terminalHostId) {
      return;
    }
    this.terminalHostId = hostId;
    this.folderValidation.cancel();
    this.browser.clearProjectSelection();
    this.repositoryState.reset();
    this.folderValue = this.terminalOnNode ? "" : this.workspacePath();
    this.folderSelectedByUser = true;
    if (!this.terminalOnNode) {
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }
  private agentIdValue = "";
  private folderValue = "";
  private deviceIdValue = "";
  private autoDeviceValue = false;
  private cloudProfileIdValue = "";
  readonly cloudMachines = new DraftCloudMachineState();
  private gatewayApprovedWorkspaceRoots: string[] = [];
  private agentsHydratedValue = false;
  private agentSelectedByUser = false;
  private folderSelectedByUser = false;
  private preferredWhereRestore: NewSessionWhere | null = null;
  private preferredProjectRestore = "";
  private whereSelectedByUser = false;
  private projectSelectedByUser = false;

  readonly modelControl: NewSessionModelControl;
  private readonly repositoryState: DraftRepositoryController;
  private readonly folderValidation: DraftRestoredFolderValidation;

  constructor(
    private readonly gateway: DraftGatewayState,
    readonly browser: DraftPlaceBrowser,
    private readonly read: () => DraftPlaceSnapshot,
    private readonly callbacks: DraftPlaceCallbacks,
  ) {
    this.folderValidation = new DraftRestoredFolderValidation(
      () => ({
        gateway: this.read().context?.gateway.snapshot,
        folder: this.folderValue,
        selectedByUser: this.folderSelectedByUser,
        isAdmin: this.isAdmin(),
      }),
      {
        onApprovedListing: (listing) => this.recordGatewayApprovedListing(listing),
        onVerified: () => {
          this.callbacks.onClearError(t("newSession.browserLoadFailed"));
          this.repositoryState.load();
        },
        onMissing: () => this.restoreWorkspaceFolder(),
        onFailed: () => this.callbacks.onError(t("newSession.browserLoadFailed")),
      },
    );
    this.repositoryState = new DraftRepositoryController(
      () => ({
        remotePlacement: this.remotePlacement,
        selectedProject: this.browser.selectedProject(),
        remoteProject: this.browser.remoteProject,
        folder: this.folderValue,
        workspace: this.workspacePath(),
        workspaceGit: this.selectedAgent()?.workspaceGit === true,
        gateway: this.read().context?.gateway.snapshot,
      }),
      {
        requestUpdate: callbacks.requestUpdate,
        persistPreference: (patch) => this.persistPreference(patch),
      },
    );
    this.modelControl = new NewSessionModelControl(
      callbacks.requestUpdate,
      (selection) => this.persistPreference(selection),
      (catalogId) =>
        this.read().context?.navigate("new-session", {
          search: newSessionSearch(this.agentIdValue, { catalogId }),
        }),
    );
  }

  buildSessionCreateParams(params: DraftSessionCreateSelection): SessionCreateParams {
    return buildDraftSessionCreateParams({
      ...params,
      agentId: this.agentId,
      model: this.modelControl.modelForSubmission(),
      contextWindow: this.modelControl.contextWindow,
      thinkingLevel: this.modelControl.thinkingLevel,
      fastMode: this.modelControl.fastMode,
      projectId: this.browser.remoteProject?.projectId ?? this.browser.projectId,
      projectGitUrl: this.browser.remoteProject?.cloneUrl,
      repository: this.remoteRepository,
      worktree: this.worktree,
      baseRef: this.baseRef,
      worktreeName: this.worktreeName,
      cwd: this.folder,
      workspace: this.workspacePath(),
    });
  }

  get agentId(): string {
    return this.agentIdValue;
  }

  get folder(): string {
    return this.folderValue;
  }

  get worktree(): boolean {
    return this.repositoryState.worktree && !this.remoteRepository;
  }

  get remoteRepository(): SessionCreateParams["repository"] {
    const project = this.browser.remoteProject;
    if (!this.remotePlacement || !project) {
      return undefined;
    }
    const ref = this.baseRef.trim();
    return { url: project.cloneUrl, ...(ref ? { ref } : {}) };
  }

  get worktreeName(): string {
    return this.repositoryState.worktreeName;
  }

  get baseRef(): string {
    return this.repositoryState.baseRef;
  }

  get repository() {
    return this.repositoryState.repository;
  }

  get deviceId(): string {
    return this.deviceIdValue;
  }

  get autoDevice(): boolean {
    return this.autoDeviceValue;
  }

  get remotePlacement(): boolean {
    return Boolean(this.deviceIdValue || this.autoDeviceValue || this.cloudProfileIdValue);
  }

  get cloudProfileId(): string {
    return this.cloudProfileIdValue;
  }

  get machineClass(): string {
    return this.cloudMachines.resolve(this.cloudProfileIdValue);
  }

  get agentsHydrated(): boolean {
    return this.agentsHydratedValue;
  }

  get placementPreferenceReady(): boolean {
    return this.repositoryState.preferenceReady && this.preferredWhereRestore === null;
  }

  canAdoptGroupDefaults(): boolean {
    return (
      !this.folderSelectedByUser &&
      !this.whereSelectedByUser &&
      !this.projectSelectedByUser &&
      !this.repositoryState.hasUserSelection
    );
  }

  adoptGroupDefaults() {
    if (this.read().data?.groupStatus !== "resolved" || !this.canAdoptGroupDefaults()) {
      return;
    }
    this.adoptAgentDefaults({ preserveSelectedAgent: true });
  }

  setAgentsHydrated(value: boolean) {
    this.agentsHydratedValue = value;
  }

  agents() {
    return listSelectableAgents(this.read().context?.agents.state.agentsList?.agents ?? []);
  }

  selectedAgent() {
    const agentId = normalizeAgentId(this.agentIdValue);
    return this.agents().find((agent) => normalizeAgentId(agent.id) === agentId);
  }

  devicePlacementRuntime() {
    return this.modelControl.resolveAgentRuntime({
      agent: this.selectedAgent(),
      context: this.read().context,
    });
  }

  devices() {
    return projectDevicePlacements(
      this.gateway.environments,
      this.devicePlacementRuntime()?.devicePlacement,
      this.gateway.deviceCatalogDisabledReason,
    );
  }

  private findDevice(deviceId: string) {
    return this.devices().find((device) => device.deviceId === deviceId);
  }

  devicePlacementReady(): boolean {
    return this.autoDeviceValue
      ? this.devices().some((device) => device.selectable)
      : !this.deviceIdValue || this.findDevice(this.deviceIdValue)?.selectable === true;
  }

  devicePlacementDisabledReason(): string | undefined {
    if (this.autoDeviceValue) {
      return resolveAutomaticDevicePlacementDisabledReason(
        this.gateway.environments,
        this.devices(),
      );
    }
    if (!this.deviceIdValue) {
      return undefined;
    }
    return this.findDevice(this.deviceIdValue)?.disabledReason ?? t("newSession.nodeUnavailable");
  }

  isAdmin(): boolean {
    return hasOperatorAdminAccess(this.read().context?.gateway.snapshot.hello?.auth ?? null);
  }

  canWrite(): boolean {
    return hasOperatorWriteAccess(this.read().context?.gateway.snapshot.hello?.auth ?? null);
  }

  workspacePath(): string {
    return normalizeOptionalString(this.selectedAgent()?.workspace) ?? "";
  }

  knownWorkspaceRoots(): string[] {
    const configuredWorkspace = this.workspacePath();
    return configuredWorkspace
      ? [configuredWorkspace, ...this.gatewayApprovedWorkspaceRoots]
      : this.gatewayApprovedWorkspaceRoots;
  }

  recordGatewayApprovedListing(listing: FsListDirResult) {
    if (this.isAdmin()) {
      return;
    }
    const roots = new Set(this.gatewayApprovedWorkspaceRoots);
    roots.add(listing.path);
    if (listing.parent) {
      roots.add(listing.parent);
    }
    if (roots.size !== this.gatewayApprovedWorkspaceRoots.length) {
      this.gatewayApprovedWorkspaceRoots = [...roots];
      this.callbacks.requestUpdate();
    }
  }

  folderSubmissionBlocked(): boolean {
    if (this.browser.projectId || this.browser.remoteProject) {
      return !this.browser.remoteProject && !this.browser.selectedProject();
    }
    // Free-typed paths still reach sessions.create so the Gateway can return
    // the authoritative missing-scope error instead of the UI dead-ending.
    return this.folderValidation.blocked;
  }

  adoptAgentDefaults(
    options: { preserveSelectedAgent?: boolean; preserveSelectedFolder?: boolean } = {},
  ) {
    const snapshot = this.read();
    const agents = this.agents();
    const configuredDefault = snapshot.context?.agents.state.agentsList?.defaultId;
    const fallback = agents.some((agent) => agent.id === configuredDefault)
      ? (configuredDefault ?? "")
      : (agents[0]?.id ?? "");
    const keepSelectedAgent =
      options.preserveSelectedAgent && this.agentSelectedByUser && Boolean(this.selectedAgent());
    if (!keepSelectedAgent) {
      this.agentIdValue = catalog.resolveAgentId(snapshot.data, agents, fallback);
      this.agentSelectedByUser = false;
    }
    // Node directories belong to the native host, never Gateway preferences or Git discovery.
    if (catalog.isTarget(snapshot.data) && this.terminalOnNode) {
      this.callbacks.requestUpdate();
      return;
    }
    const preference = this.agentIdValue ? this.gateway.readPreference(this.agentIdValue) : null;
    const keepSelectedFolder = options.preserveSelectedFolder && this.folderSelectedByUser;
    if (!keepSelectedFolder && !snapshot.pendingPlacementSessionKey) {
      const workspace = this.workspacePath();
      const storedFolder = preference?.folder ?? "";
      const storedWorkspaceMoved =
        Boolean(storedFolder) &&
        storedFolder === preference?.workspace &&
        preference.workspace !== workspace;
      const storedFolderUsable = Boolean(storedFolder) && !storedWorkspaceMoved;
      const groupTarget = Boolean(snapshot.data?.group);
      const groupFolder = snapshot.data?.groupCwd ?? "";
      const groupWorktree = snapshot.data?.groupWorktree === true;
      this.folderValue = groupTarget
        ? groupFolder || workspace
        : storedFolderUsable
          ? storedFolder
          : workspace;
      this.folderSelectedByUser = false;
      this.repositoryState.adoptPreference(groupTarget ? { worktree: groupWorktree } : preference);
      const preferredWhere =
        groupTarget || catalog.isTarget(snapshot.data)
          ? { kind: "local" as const }
          : (preference?.where ?? { kind: "local" as const });
      if (!this.whereSelectedByUser) {
        this.preferredWhereRestore = preferredWhere.kind === "local" ? null : preferredWhere;
      }
      this.preferredProjectRestore =
        groupTarget || catalog.isTarget(snapshot.data) ? "" : (preference?.projectId ?? "");
      this.projectSelectedByUser = false;
      if (storedWorkspaceMoved && !groupTarget) {
        this.persistPreference({ folder: workspace });
      }
    }
    if (keepSelectedFolder && !snapshot.pendingPlacementSessionKey && this.agentIdValue) {
      this.persistPreference({ folder: this.folderValue, worktree: this.worktree });
    }
    if (this.remotePlacement) {
      this.repositoryState.forceWorktree(true);
    }
    this.modelControl.load(snapshot.context, this.agentIdValue, !catalog.isTarget(snapshot.data), {
      agent: this.selectedAgent(),
      preference,
    });
    if (this.preferredProjectRestore) {
      this.folderValidation.cancel();
    } else if (
      !this.folderSelectedByUser &&
      this.folderValue !== this.workspacePath() &&
      !snapshot.pendingPlacementSessionKey
    ) {
      this.folderValidation.validate(this.folderValue);
    } else {
      this.folderValidation.cancel();
      if (!this.repositoryState.matchesCurrentRepo()) {
        this.repositoryState.load();
      }
    }
    this.callbacks.requestUpdate();
  }

  private resetPlaceSelection() {
    this.folderSelectedByUser = false;
    this.gatewayApprovedWorkspaceRoots = [];
    this.preferredWhereRestore = null;
    this.preferredProjectRestore = "";
    this.whereSelectedByUser = false;
    this.projectSelectedByUser = false;
    this.deviceIdValue = "";
    this.autoDeviceValue = false;
    this.cloudProfileIdValue = "";
    this.repositoryState.reset();
  }

  resetDraft() {
    this.terminalHostId = "gateway:local";
    this.agentSelectedByUser = false;
    this.folderValue = "";
    this.browser.clearProjectSelection();
    this.resetPlaceSelection();
    this.browser.resetProjectSearch();
    this.folderValidation.cancel();
    this.modelControl.reset();
    this.cloudMachines.clear();
    this.callbacks.requestUpdate();
  }

  invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.repositoryState.invalidate();
    this.agentsHydratedValue = false;
    this.modelControl.invalidate(resetHostSelection);
    this.browser.close();
    this.folderValidation.cancel();
    this.gatewayApprovedWorkspaceRoots = [];
    this.browser.resetProjectSearch();
    this.browser.resetProjects(resetHostSelection);
    if (!resetHostSelection) {
      this.callbacks.requestUpdate();
      return;
    }
    this.agentIdValue = "";
    this.agentSelectedByUser = false;
    this.folderValue = "";
    this.resetPlaceSelection();
    this.cloudMachines.clear();
    this.callbacks.requestUpdate();
  }

  applyPendingPlacement(params: PendingPlacementPlace) {
    this.agentIdValue = params.agentId;
    this.deviceIdValue = params.deviceId ?? "";
    this.autoDeviceValue = params.autoDevice === true;
    this.cloudProfileIdValue = params.profileId;
    this.cloudMachines.applyPending(params.profileId, params.machineClass);
    this.repositoryState.forceWorktree(true);
    this.folderValue = params.cwd ?? "";
    if (params.repository) {
      this.browser.selectProject({
        kind: "remote",
        project: { identity: params.repository.url, cloneUrl: params.repository.url },
      });
      this.repositoryState.setBaseRef(params.repository.ref ?? "", false);
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  clearCloudProfile() {
    this.cloudProfileIdValue = "";
    this.browser.close();
    this.callbacks.requestUpdate();
  }

  clearProjectSelection() {
    if (this.browser.projectId || this.browser.remoteProject) {
      this.repositoryState.clearDetails(true);
    }
    this.browser.clearProjectSelection();
    this.repositoryState.load();
    this.callbacks.requestUpdate();
  }

  selectAgentId(agentId: string) {
    const snapshot = this.read();
    if (
      snapshot.submitting ||
      snapshot.pendingPlacementSessionKey ||
      catalog.isTarget(snapshot.data)
    ) {
      return;
    }
    if (normalizeAgentId(agentId) === normalizeAgentId(this.agentIdValue)) {
      return;
    }
    this.agentIdValue = normalizeAgentId(agentId);
    this.folderValidation.cancel();
    this.modelControl.reset();
    this.callbacks.onError(null);
    this.agentSelectedByUser = true;
    this.browser.clearProjectSelection();
    this.resetPlaceSelection();
    this.browser.close();
    this.adoptAgentDefaults({ preserveSelectedAgent: true });
  }

  applyFolder(folder: string) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingPlacementSessionKey) {
      return;
    }
    this.browser.clearProjectSelection();
    this.folderValidation.cancel();
    this.callbacks.onError(null);
    this.folderValue = folder.trim();
    this.folderSelectedByUser = true;
    this.projectSelectedByUser = true;
    this.preferredProjectRestore = "";
    if (catalog.isTarget(snapshot.data) && this.terminalOnNode) {
      this.callbacks.requestUpdate();
      return;
    }
    this.repositoryState.selectWorktree(this.remotePlacement);
    if (this.agentsHydratedValue) {
      this.persistPreference({
        folder: this.folderValue,
        projectId: "",
        worktree: this.worktree,
      });
    }
    this.repositoryState.load();
  }

  selectProjectId(projectId: string) {
    const project = this.browser.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return;
    }
    this.selectProject({ kind: "local", id: project.id });
  }

  selectRemoteProject(project: DraftRemoteProject) {
    this.selectProject({ kind: "remote", project });
  }

  private selectProject(selection: Parameters<DraftPlaceBrowser["selectProject"]>[0]) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingPlacementSessionKey) {
      return;
    }
    this.browser.selectProject(selection);
    this.folderValidation.cancel();
    this.browser.resetProjectSearch();
    this.callbacks.onError(null);
    this.folderSelectedByUser = false;
    this.projectSelectedByUser = true;
    this.preferredProjectRestore = "";
    this.repositoryState.selectWorktree(this.remotePlacement);
    if (selection.kind === "local") {
      this.persistPreference({
        projectId: selection.id,
        where: resolveNewSessionWhere({
          cloudProfileId: this.cloudProfileIdValue,
          deviceId: this.deviceIdValue,
          autoDevice: this.autoDeviceValue,
        }),
        worktree: this.worktree,
        worktreeName: "",
      });
    }
    this.repositoryState.load();
    this.browser.close();
  }

  selectDevice(deviceId: string, autoDevice = false) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingPlacementSessionKey) {
      return;
    }
    if (
      (deviceId && this.findDevice(deviceId)?.selectable !== true) ||
      (autoDevice && !this.devices().some((device) => device.selectable))
    ) {
      return;
    }
    if (
      deviceId === this.deviceIdValue &&
      autoDevice === this.autoDeviceValue &&
      !this.cloudProfileIdValue
    ) {
      return;
    }
    this.folderValidation.cancel();
    this.deviceIdValue = deviceId;
    this.autoDeviceValue = autoDevice;
    this.cloudProfileIdValue = "";
    this.whereSelectedByUser = true;
    this.preferredWhereRestore = null;
    if ((deviceId || autoDevice) && !this.worktreeAvailable()) {
      if (this.folderValue !== this.workspacePath() || this.browser.projectId) {
        this.repositoryState.clearDetails(true);
      }
      this.folderValue = this.workspacePath();
      this.folderSelectedByUser = false;
      this.browser.clearProjectSelection();
      this.projectSelectedByUser = true;
    }
    this.repositoryState.forceWorktree(Boolean(deviceId || autoDevice));
    this.persistPreference({
      where: resolveNewSessionWhere({ cloudProfileId: "", deviceId, autoDevice }),
      projectId: this.browser.projectId,
      folder: this.folderValue,
      worktree: Boolean(deviceId || autoDevice) || this.worktree,
    });
    this.browser.close();
    if (!this.repositoryState.matchesCurrentRepo()) {
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  selectCloudProfile(profileId: string) {
    const snapshot = this.read();
    const profile = this.gateway.cloudProfiles.find((candidate) => candidate.id === profileId);
    if (
      snapshot.submitting ||
      snapshot.pendingPlacementSessionKey ||
      !this.isAdmin() ||
      !this.worktreeAvailable() ||
      !profile ||
      Boolean(this.modelControl.cloudRuntimeUnsupportedReason(profile))
    ) {
      return;
    }
    this.cloudProfileIdValue = profileId;
    this.deviceIdValue = "";
    this.autoDeviceValue = false;
    this.whereSelectedByUser = true;
    this.preferredWhereRestore = null;
    this.callbacks.onError(null);
    this.repositoryState.forceWorktree(true);
    this.persistPreference({
      where: { kind: "cloud", id: profileId },
      projectId: this.browser.projectId,
      worktree: true,
    });
    this.browser.close();
    if (!this.repositoryState.matchesCurrentRepo()) {
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  selectWorktree(value: boolean) {
    this.repositoryState.select(value);
  }

  setBaseRef(baseRef: string) {
    this.repositoryState.setBaseRef(baseRef, this.read().submitting);
  }

  setWorktreeName(worktreeName: string) {
    this.repositoryState.setWorktreeName(worktreeName, this.read().submitting);
  }

  restorePreferenceSelections() {
    let changed = false;
    const preferredWhere = this.whereSelectedByUser ? null : this.preferredWhereRestore;
    let preferredProject = this.projectSelectedByUser ? "" : this.preferredProjectRestore;

    if (
      preferredWhere?.kind !== "device" &&
      preferredWhere?.kind !== "auto-device" &&
      preferredProject
    ) {
      const project = this.browser.projects.find((candidate) => candidate.id === preferredProject);
      if (project) {
        this.browser.selectProject({ kind: "local", id: project.id });
        this.folderSelectedByUser = false;
        this.preferredProjectRestore = "";
        changed = true;
      } else if (this.browser.projectsReady) {
        this.preferredProjectRestore = "";
        preferredProject = "";
        changed = true;
      }
    }

    if (
      (preferredWhere?.kind === "device" || preferredWhere?.kind === "auto-device") &&
      this.gateway.cloudProfilesReady
    ) {
      const automatic = preferredWhere.kind === "auto-device";
      this.autoDeviceValue = automatic;
      this.deviceIdValue = preferredWhere.kind === "device" ? preferredWhere.id : "";
      this.cloudProfileIdValue = "";
      this.repositoryState.forceWorktree(this.remotePlacement);
      this.preferredWhereRestore = null;
      changed = true;
    } else if (preferredWhere?.kind === "cloud" && this.gateway.cloudProfilesReady) {
      const preferredProfile = this.gateway.cloudProfiles.find(
        (profile) => profile.id === preferredWhere.id,
      );
      const profileAvailable = Boolean(
        this.isAdmin() &&
        preferredProfile &&
        !this.modelControl.cloudRuntimeUnsupportedReason(preferredProfile),
      );
      const repositoryReady =
        (!preferredProject || this.browser.projectId === preferredProject) &&
        this.repositoryState.matchesCurrentRepo() &&
        this.repository.kind !== "checking";
      if (profileAvailable && repositoryReady && this.worktreeAvailable()) {
        this.deviceIdValue = "";
        this.autoDeviceValue = false;
        this.cloudProfileIdValue = preferredWhere.id;
        this.repositoryState.forceWorktree(true);
        this.preferredWhereRestore = null;
        changed = true;
      } else if (!profileAvailable || repositoryReady) {
        this.cloudProfileIdValue = "";
        changed = true;
        this.preferredWhereRestore = null;
        // A failed Git probe drops this draft's restore, not the saved destination.
        if (!profileAvailable || this.repository.kind === "direct") {
          this.persistPreference({ where: { kind: "local" } });
        }
      }
    }

    if (!changed) {
      return;
    }
    if (!this.repositoryState.matchesCurrentRepo()) {
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  browseAvailable(): boolean {
    return this.gateway.connected && (this.isAdmin() || Boolean(this.workspacePath()));
  }

  worktreeAvailable(): boolean {
    return this.repositoryState.available();
  }

  private persistPreference(patch: Parameters<DraftGatewayState["persistPreference"]>[2]) {
    this.gateway.persistPreference(this.agentIdValue, this.workspacePath(), patch);
  }

  private restoreWorkspaceFolder() {
    this.callbacks.onClearError(t("newSession.browserLoadFailed"));
    this.folderValue = this.workspacePath();
    this.repositoryState.rejectPreferredWorktree();
    this.persistPreference({ folder: this.folderValue, worktree: false });
    this.repositoryState.load();
  }
}
