import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import { isDraftNodeSessionEligible, readDraftNodes, type DraftNode } from "./discovery.ts";
import { DraftCloudMachineState, type PendingCloudPlace } from "./draft-cloud-machine-state.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { DraftRepositoryController } from "./draft-repository-state.ts";
import { isMissingRestoredFolderError } from "./folder-validation.ts";
import type { NewSessionRouteData } from "./location.ts";
import { newSessionSearch } from "./location.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { isKnownWorkspacePath } from "./path.ts";
import type { NewSessionWhere } from "./preferences.ts";
import type { DraftRemoteProject } from "./project-chip.ts";

type DraftPlaceSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  data: NewSessionRouteData | undefined;
  submitting: boolean;
  pendingCloudSessionKey: string;
}>;

type DraftPlaceCallbacks = {
  requestUpdate: () => void;
  onError: (error: string | null) => void;
  onClearError: (error: string) => void;
};

export class DraftPlaceState {
  private agentIdValue = "";
  private folderValue = "";
  private nodesValue: DraftNode[] = [];
  private execNodeValue = "";
  private cloudProfileIdValue = "";
  readonly cloudMachines = new DraftCloudMachineState();
  private restoredFolderValidation: "none" | "checking" | "failed" = "none";
  private gatewayApprovedWorkspaceRoots: string[] = [];
  private agentsHydratedValue = false;
  private nodesHydrated = false;
  private agentSelectedByUser = false;
  private folderSelectedByUser = false;
  private folderGatewayApproved = false;
  private preferredWhereRestore: NewSessionWhere | null = null;
  private preferredProjectRestore = "";
  private whereSelectedByUser = false;
  private projectSelectedByUser = false;
  private nodesRequestToken = 0;
  private restoredFolderValidationToken = 0;

  readonly modelControl: NewSessionModelControl;
  private readonly repositoryState: DraftRepositoryController;

  constructor(
    private readonly gateway: DraftGatewayState,
    readonly browser: DraftPlaceBrowser,
    private readonly read: () => DraftPlaceSnapshot,
    private readonly callbacks: DraftPlaceCallbacks,
  ) {
    this.repositoryState = new DraftRepositoryController(
      () => ({
        execNode: this.execNodeValue,
        cloudProfileId: this.cloudProfileIdValue,
        selectedProject: this.browser.selectedProject(),
        remoteProjectSelected: Boolean(this.browser.remoteProject),
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

  get agentId(): string {
    return this.agentIdValue;
  }

  get folder(): string {
    return this.folderValue;
  }

  get worktree(): boolean {
    return this.repositoryState.worktree;
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

  get nodes(): readonly DraftNode[] {
    return this.nodesValue;
  }

  get execNode(): string {
    return this.execNodeValue;
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

  get worktreePreferenceReady(): boolean {
    return this.repositoryState.preferenceReady;
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

  executionNodes(): DraftNode[] {
    return this.nodesValue.filter((node) => node.canExec);
  }

  execNodes(): DraftNode[] {
    return this.executionNodes().filter(isDraftNodeSessionEligible);
  }

  execNodeReady(): boolean {
    return (
      !this.execNodeValue ||
      (this.nodesHydrated && this.execNodes().some((node) => node.nodeId === this.execNodeValue))
    );
  }

  refreshNodes() {
    return this.loadNodes({ quiet: true });
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
    if (this.restoredFolderValidation !== "none") {
      return true;
    }
    if (
      !this.usesCustomFolder() ||
      this.isAdmin() ||
      this.folderGatewayApproved ||
      isKnownWorkspacePath(this.knownWorkspaceRoots(), this.folderValue)
    ) {
      return false;
    }
    // Free-typed paths still reach sessions.create so the Gateway can return
    // the authoritative missing-scope error instead of the UI dead-ending.
    return false;
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
    const preference = this.agentIdValue ? this.gateway.readPreference(this.agentIdValue) : null;
    const keepSelectedFolder = options.preserveSelectedFolder && this.folderSelectedByUser;
    if (!this.execNodeValue && !keepSelectedFolder && !snapshot.pendingCloudSessionKey) {
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
      this.folderGatewayApproved = false;
      this.folderSelectedByUser = false;
      this.repositoryState.adoptPreference(groupTarget ? { worktree: groupWorktree } : preference);
      if (groupTarget) {
        // Group defaults own the initial local/worktree choice. Repository
        // discovery still rejects worktrees when the selected folder is not Git.
        this.repositoryState.forceWorktree(groupWorktree);
      }
      const preferredWhere = groupTarget
        ? { kind: "local" as const }
        : (preference?.where ?? { kind: "local" as const });
      this.preferredWhereRestore = preferredWhere.kind === "local" ? null : preferredWhere;
      this.preferredProjectRestore = groupTarget ? "" : (preference?.projectId ?? "");
      this.whereSelectedByUser = false;
      this.projectSelectedByUser = false;
      if (storedWorkspaceMoved && !groupTarget) {
        this.persistPreference({ folder: workspace });
      }
    }
    if (
      keepSelectedFolder &&
      !this.execNodeValue &&
      !snapshot.pendingCloudSessionKey &&
      this.agentIdValue
    ) {
      this.persistPreference({ folder: this.folderValue, worktree: this.worktree });
    }
    void this.loadNodes();
    this.modelControl.load(snapshot.context, this.agentIdValue, !catalog.isTarget(snapshot.data), {
      agent: this.selectedAgent(),
      preference,
    });
    if (this.preferredProjectRestore) {
      this.cancelRestoredFolderValidation();
    } else if (
      !this.folderSelectedByUser &&
      this.folderValue !== this.workspacePath() &&
      !this.execNodeValue &&
      !snapshot.pendingCloudSessionKey
    ) {
      this.validateRestoredFolder(this.folderValue);
    } else {
      this.cancelRestoredFolderValidation();
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  resetDraft() {
    this.agentSelectedByUser = false;
    this.folderValue = "";
    this.browser.clearProjectSelection();
    this.browser.resetProjectSearch();
    this.folderSelectedByUser = false;
    this.folderGatewayApproved = false;
    this.gatewayApprovedWorkspaceRoots = [];
    this.cancelRestoredFolderValidation();
    this.preferredWhereRestore = null;
    this.preferredProjectRestore = "";
    this.whereSelectedByUser = false;
    this.projectSelectedByUser = false;
    this.repositoryState.reset();
    this.execNodeValue = "";
    this.modelControl.reset();
    this.cloudProfileIdValue = "";
    this.cloudMachines.clear();
    this.callbacks.requestUpdate();
  }

  invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.nodesRequestToken += 1;
    this.nodesHydrated = false;
    this.repositoryState.invalidate();
    this.agentsHydratedValue = false;
    this.modelControl.invalidate(resetHostSelection);
    this.browser.close();
    this.cancelRestoredFolderValidation();
    this.gatewayApprovedWorkspaceRoots = [];
    this.folderGatewayApproved = false;
    this.browser.resetProjectSearch();
    if (!resetHostSelection) {
      this.callbacks.requestUpdate();
      return;
    }
    this.agentIdValue = "";
    this.agentSelectedByUser = false;
    this.folderValue = "";
    this.browser.resetProjects();
    this.folderSelectedByUser = false;
    this.preferredWhereRestore = null;
    this.preferredProjectRestore = "";
    this.whereSelectedByUser = false;
    this.projectSelectedByUser = false;
    this.repositoryState.reset();
    this.nodesValue = [];
    this.execNodeValue = "";
    this.cloudProfileIdValue = "";
    this.cloudMachines.clear();
    this.callbacks.requestUpdate();
  }

  applyPendingCloud(params: PendingCloudPlace) {
    this.agentIdValue = params.agentId;
    this.cloudProfileIdValue = params.profileId;
    this.cloudMachines.applyPending(params.profileId, params.machineClass);
    this.repositoryState.forceWorktree(true);
    this.folderValue = params.cwd ?? "";
    this.folderGatewayApproved = false;
    this.callbacks.requestUpdate();
  }

  clearCloudProfile() {
    this.cloudProfileIdValue = "";
    this.browser.close();
    this.callbacks.requestUpdate();
  }

  clearProjectSelection() {
    this.browser.clearProjectSelection();
    this.repositoryState.load();
    this.callbacks.requestUpdate();
  }

  selectAgentId(agentId: string) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingCloudSessionKey || catalog.isTarget(snapshot.data)) {
      return;
    }
    if (normalizeAgentId(agentId) === normalizeAgentId(this.agentIdValue)) {
      return;
    }
    this.agentIdValue = normalizeAgentId(agentId);
    this.cancelRestoredFolderValidation();
    this.modelControl.reset();
    this.callbacks.onError(null);
    this.agentSelectedByUser = true;
    this.folderSelectedByUser = false;
    this.folderGatewayApproved = false;
    this.gatewayApprovedWorkspaceRoots = [];
    this.browser.clearProjectSelection();
    this.preferredWhereRestore = null;
    this.preferredProjectRestore = "";
    this.whereSelectedByUser = false;
    this.projectSelectedByUser = false;
    this.cloudProfileIdValue = "";
    this.repositoryState.reset();
    this.browser.close();
    if (this.execNodeValue) {
      this.folderValue = "";
    }
    this.adoptAgentDefaults({ preserveSelectedAgent: true });
  }

  applyFolder(folder: string, execNode = this.execNodeValue, gatewayApproved = false) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingCloudSessionKey) {
      return;
    }
    this.execNodeValue = execNode;
    this.browser.clearProjectSelection();
    this.cancelRestoredFolderValidation();
    if (execNode) {
      this.cloudProfileIdValue = "";
    }
    this.callbacks.onError(null);
    this.folderValue = folder.trim();
    this.folderGatewayApproved = gatewayApproved && !execNode && !this.isAdmin();
    this.folderSelectedByUser = true;
    this.projectSelectedByUser = true;
    this.preferredProjectRestore = "";
    this.repositoryState.selectWorktree(!this.execNodeValue && Boolean(this.cloudProfileIdValue));
    if (!this.execNodeValue && this.agentsHydratedValue) {
      this.persistPreference({
        folder: this.folderValue,
        projectId: "",
        worktree: this.worktree,
      });
    } else if (this.execNodeValue && this.agentsHydratedValue) {
      this.persistPreference({
        folder: this.folderValue,
        projectId: "",
        where: { kind: "node", id: this.execNodeValue },
        worktree: false,
      });
    }
    this.repositoryState.load();
  }

  selectProjectId(projectId: string) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingCloudSessionKey) {
      return;
    }
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
    if (snapshot.submitting || snapshot.pendingCloudSessionKey) {
      return;
    }
    this.browser.selectProject(selection);
    this.cancelRestoredFolderValidation();
    this.browser.resetProjectSearch();
    this.execNodeValue = "";
    this.callbacks.onError(null);
    this.folderSelectedByUser = false;
    this.projectSelectedByUser = true;
    this.preferredProjectRestore = "";
    this.repositoryState.selectWorktree(Boolean(this.cloudProfileIdValue));
    if (selection.kind === "local") {
      this.persistPreference({
        projectId: selection.id,
        where: this.cloudProfileIdValue
          ? { kind: "cloud", id: this.cloudProfileIdValue }
          : { kind: "local" },
        worktree: this.worktree,
        worktreeName: "",
      });
    }
    this.repositoryState.load();
    this.browser.close();
  }

  selectExecNode(execNode: string) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingCloudSessionKey) {
      return;
    }
    if (
      execNode &&
      !this.nodesValue.some((node) => node.nodeId === execNode && isDraftNodeSessionEligible(node))
    ) {
      return;
    }
    if (execNode === this.execNodeValue && !this.cloudProfileIdValue) {
      return;
    }
    const keepGatewayFolder = !execNode && !this.execNodeValue;
    this.cancelRestoredFolderValidation();
    const keepWorktree = keepGatewayFolder && this.worktree && this.worktreeAvailable();
    this.execNodeValue = execNode;
    this.cloudProfileIdValue = "";
    this.whereSelectedByUser = true;
    this.preferredWhereRestore = null;
    if (!keepGatewayFolder) {
      this.folderValue = execNode ? "" : this.workspacePath();
      this.folderSelectedByUser = false;
      this.folderGatewayApproved = false;
      this.browser.clearProjectSelection();
      this.projectSelectedByUser = true;
    }
    this.repositoryState.selectWorktree(keepWorktree, false);
    this.persistPreference({
      where: execNode ? { kind: "node", id: execNode } : { kind: "local" },
      projectId: this.browser.projectId,
      folder: this.folderValue,
      worktree: this.worktree,
    });
    this.browser.close();
    if (!this.repositoryState.matchesCurrentRepo()) {
      this.repositoryState.load();
    }
    this.callbacks.requestUpdate();
  }

  selectCloudProfile(profileId: string) {
    const snapshot = this.read();
    if (
      snapshot.submitting ||
      snapshot.pendingCloudSessionKey ||
      !this.worktreeAvailable() ||
      !this.gateway.cloudProfiles.some((profile) => profile.id === profileId)
    ) {
      return;
    }
    this.cloudProfileIdValue = profileId;
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

  toggleWorktree() {
    this.repositoryState.toggle();
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

    if (preferredWhere?.kind !== "node" && preferredProject) {
      const project = this.browser.projects.find((candidate) => candidate.id === preferredProject);
      if (project) {
        this.browser.selectProject({ kind: "local", id: project.id });
        this.execNodeValue = "";
        this.folderSelectedByUser = false;
        this.preferredProjectRestore = "";
        changed = true;
      } else if (this.browser.projectsReady) {
        this.preferredProjectRestore = "";
        preferredProject = "";
        changed = true;
      }
    }

    if (preferredWhere?.kind === "node" && this.nodesHydrated) {
      const nodeAvailable = this.execNodes().some((node) => node.nodeId === preferredWhere.id);
      this.execNodeValue = nodeAvailable ? preferredWhere.id : "";
      this.cloudProfileIdValue = "";
      this.browser.clearProjectSelection();
      this.repositoryState.forceWorktree(false);
      this.preferredWhereRestore = null;
      this.preferredProjectRestore = "";
      changed = true;
    } else if (preferredWhere?.kind === "cloud" && this.gateway.cloudProfilesReady) {
      const profileAvailable = this.gateway.cloudProfiles.some(
        (profile) => profile.id === preferredWhere.id,
      );
      const projectReady = !preferredProject || this.browser.projectId === preferredProject;
      if (profileAvailable && projectReady && this.worktreeAvailable()) {
        this.execNodeValue = "";
        this.cloudProfileIdValue = preferredWhere.id;
        this.repositoryState.forceWorktree(true);
        this.preferredWhereRestore = null;
        changed = true;
      } else if (!profileAvailable) {
        if (this.cloudProfileIdValue !== preferredWhere.id) {
          this.cloudProfileIdValue = "";
          changed = true;
        }
        this.preferredWhereRestore = null;
      }
    }

    if (!changed) {
      return;
    }
    this.repositoryState.load();
    this.callbacks.requestUpdate();
  }

  browseAvailable(): boolean {
    return this.gateway.connected && (this.isAdmin() || Boolean(this.workspacePath()));
  }

  worktreeAvailable(): boolean {
    return this.repositoryState.available();
  }

  private usesCustomFolder(): boolean {
    if (this.browser.projectId || this.browser.remoteProject) {
      return false;
    }
    const folder = this.folderValue.trim();
    return Boolean(folder) && folder !== this.workspacePath();
  }

  private persistPreference(patch: Parameters<DraftGatewayState["persistPreference"]>[2]) {
    this.gateway.persistPreference(this.agentIdValue, this.workspacePath(), patch);
  }

  private cancelRestoredFolderValidation() {
    this.restoredFolderValidationToken += 1;
    this.restoredFolderValidation = "none";
  }

  private restoreWorkspaceFolder() {
    this.restoredFolderValidation = "none";
    this.folderGatewayApproved = false;
    this.callbacks.onClearError(t("newSession.browserLoadFailed"));
    this.folderValue = this.workspacePath();
    this.repositoryState.rejectPreferredWorktree();
    this.persistPreference({ folder: this.folderValue, worktree: false });
    this.repositoryState.load();
  }

  private validateRestoredFolder(folder: string) {
    const snapshot = this.read().context?.gateway.snapshot;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client) {
      this.restoreWorkspaceFolder();
      return;
    }
    const requestId = ++this.restoredFolderValidationToken;
    this.restoredFolderValidation = "checking";
    void client
      .request<FsListDirResult>("fs.listDir", { path: folder })
      .then((result) => {
        if (
          requestId !== this.restoredFolderValidationToken ||
          this.folderSelectedByUser ||
          this.folderValue !== folder
        ) {
          return;
        }
        this.recordGatewayApprovedListing(result);
        this.folderGatewayApproved = !this.isAdmin();
        this.restoredFolderValidation = "none";
        this.callbacks.onClearError(t("newSession.browserLoadFailed"));
        this.repositoryState.load();
      })
      .catch((error: unknown) => {
        if (
          requestId !== this.restoredFolderValidationToken ||
          this.folderSelectedByUser ||
          this.folderValue !== folder
        ) {
          return;
        }
        if (!this.isAdmin() || isMissingRestoredFolderError(error)) {
          this.restoreWorkspaceFolder();
          return;
        }
        this.restoredFolderValidation = "failed";
        this.callbacks.onError(t("newSession.browserLoadFailed"));
      });
  }

  private async loadNodes(options: { quiet?: boolean } = {}) {
    const requestId = ++this.nodesRequestToken;
    if (!options.quiet) {
      this.nodesHydrated = false;
    }
    const snapshot = this.read().context?.gateway.snapshot;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client || !this.isAdmin()) {
      this.nodesValue = [];
      this.nodesHydrated = true;
      this.callbacks.requestUpdate();
      return;
    }
    try {
      const result = await client.request<{ nodes?: unknown }>("node.list", {});
      if (requestId !== this.nodesRequestToken) {
        return;
      }
      const nodes = readDraftNodes(result?.nodes);
      this.nodesValue = nodes;
      this.nodesHydrated = true;
      if (
        this.execNodeValue &&
        !nodes.some(
          (node) => node.nodeId === this.execNodeValue && isDraftNodeSessionEligible(node),
        )
      ) {
        this.execNodeValue = "";
        this.folderValue = this.workspacePath();
        this.folderSelectedByUser = false;
        this.folderGatewayApproved = false;
        this.repositoryState.selectWorktree(false);
        this.browser.close();
        this.repositoryState.load();
      }
      this.callbacks.requestUpdate();
    } catch {
      if (requestId === this.nodesRequestToken && !options.quiet) {
        this.nodesValue = [];
        this.nodesHydrated = true;
        this.callbacks.requestUpdate();
      }
    }
  }
}
