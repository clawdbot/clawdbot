import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  FsListDirResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import * as catalog from "./catalog-target.ts";
import type { DraftNode, DraftRepositoryState } from "./discovery.ts";
import { readDraftNodes } from "./discovery.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceBrowser } from "./draft-place-browser.ts";
import { isMissingRestoredFolderError } from "./folder-validation.ts";
import type { NewSessionRouteData } from "./location.ts";
import { newSessionSearch } from "./location.ts";
import { NewSessionModelControl } from "./model-control.ts";
import { isKnownWorkspacePath } from "./path.ts";

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
  private projectIdValue = "";
  private worktreeValue = false;
  private worktreeNameValue = "";
  private baseRefValue = "";
  private repositoryValue: DraftRepositoryState = { kind: "idle" };
  private nodesValue: DraftNode[] = [];
  private execNodeValue = "";
  private cloudProfileIdValue = "";
  private restoredFolderValidation: "none" | "checking" | "failed" = "none";
  private gatewayApprovedWorkspaceRoots: string[] = [];
  private agentsHydratedValue = false;
  private nodesHydrated = false;
  private agentSelectedByUser = false;
  private folderSelectedByUser = false;
  private folderGatewayApproved = false;
  private preferredWorktreeRestore = false;
  private worktreeSelectedByUser = false;
  private nodesRequestToken = 0;
  private branchesRequestToken = 0;
  private baseRefEditGeneration = 0;
  private restoredFolderValidationToken = 0;

  readonly modelControl: NewSessionModelControl;

  constructor(
    private readonly gateway: DraftGatewayState,
    readonly browser: DraftPlaceBrowser,
    private readonly read: () => DraftPlaceSnapshot,
    private readonly callbacks: DraftPlaceCallbacks,
  ) {
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

  get projectId(): string {
    return this.projectIdValue;
  }

  get worktree(): boolean {
    return this.worktreeValue;
  }

  get worktreeName(): string {
    return this.worktreeNameValue;
  }

  get baseRef(): string {
    return this.baseRefValue;
  }

  get repository(): DraftRepositoryState {
    return this.repositoryValue;
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

  get agentsHydrated(): boolean {
    return this.agentsHydratedValue;
  }

  get worktreePreferenceReady(): boolean {
    return !this.preferredWorktreeRestore;
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

  selectedProject() {
    return this.browser.selectedProject(this.projectIdValue);
  }

  execNodes(): DraftNode[] {
    return this.nodesValue.filter((node) => node.canExec);
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
    if (this.projectIdValue) {
      return !this.selectedProject();
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
      ? (configuredDefault ?? "main")
      : (agents[0]?.id ?? "main");
    const keepSelectedAgent =
      options.preserveSelectedAgent && this.agentSelectedByUser && Boolean(this.selectedAgent());
    if (!keepSelectedAgent) {
      this.agentIdValue = catalog.resolveAgentId(snapshot.data, agents, fallback);
      this.agentSelectedByUser = false;
    }
    const preference = this.gateway.readPreference(this.agentIdValue);
    const keepSelectedFolder = options.preserveSelectedFolder && this.folderSelectedByUser;
    if (!this.execNodeValue && !keepSelectedFolder && !snapshot.pendingCloudSessionKey) {
      const workspace = this.workspacePath();
      const storedFolder = preference?.folder ?? "";
      const storedWorkspaceMoved =
        Boolean(storedFolder) &&
        storedFolder === preference?.workspace &&
        preference.workspace !== workspace;
      const storedFolderUsable = Boolean(storedFolder) && !storedWorkspaceMoved;
      this.folderValue = storedFolderUsable ? storedFolder : workspace;
      this.folderGatewayApproved = false;
      this.folderSelectedByUser = false;
      this.preferredWorktreeRestore = preference?.worktree === true;
      this.worktreeSelectedByUser = false;
      if (storedWorkspaceMoved) {
        this.persistPreference({ folder: workspace });
      }
    }
    if (
      keepSelectedFolder &&
      !this.execNodeValue &&
      !snapshot.pendingCloudSessionKey &&
      this.agentIdValue
    ) {
      this.persistPreference({ folder: this.folderValue, worktree: this.worktreeValue });
    }
    void this.loadNodes();
    this.modelControl.load(snapshot.context, this.agentIdValue, !catalog.isTarget(snapshot.data), {
      agent: this.selectedAgent(),
      preference,
    });
    if (
      !this.folderSelectedByUser &&
      this.folderValue !== this.workspacePath() &&
      !this.execNodeValue &&
      !snapshot.pendingCloudSessionKey
    ) {
      this.validateRestoredFolder(this.folderValue);
    } else {
      this.cancelRestoredFolderValidation();
      this.maybeLoadBranches();
    }
    this.callbacks.requestUpdate();
  }

  resetDraft() {
    this.agentSelectedByUser = false;
    this.folderValue = "";
    this.projectIdValue = "";
    this.browser.resetProjectSearch();
    this.folderSelectedByUser = false;
    this.folderGatewayApproved = false;
    this.gatewayApprovedWorkspaceRoots = [];
    this.cancelRestoredFolderValidation();
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
    this.worktreeValue = false;
    this.worktreeNameValue = "";
    this.baseRefValue = "";
    this.repositoryValue = { kind: "idle" };
    this.execNodeValue = "";
    this.modelControl.reset();
    this.cloudProfileIdValue = "";
    this.callbacks.requestUpdate();
  }

  invalidateGatewayDiscovery(resetHostSelection: boolean) {
    this.nodesRequestToken += 1;
    this.nodesHydrated = false;
    this.branchesRequestToken += 1;
    this.repositoryValue = { kind: "idle" };
    this.baseRefValue = "";
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
    this.projectIdValue = "";
    this.folderSelectedByUser = false;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
    this.worktreeValue = false;
    this.worktreeNameValue = "";
    this.baseRefEditGeneration += 1;
    this.nodesValue = [];
    this.execNodeValue = "";
    this.cloudProfileIdValue = "";
    this.callbacks.requestUpdate();
  }

  applyPendingCloud(params: { agentId: string; profileId: string; cwd?: string }) {
    this.agentIdValue = params.agentId;
    this.cloudProfileIdValue = params.profileId;
    this.worktreeValue = true;
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
    this.projectIdValue = "";
    this.maybeLoadBranches();
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
    this.projectIdValue = "";
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
    this.cloudProfileIdValue = "";
    this.worktreeValue = false;
    this.worktreeNameValue = "";
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
    this.projectIdValue = "";
    this.cancelRestoredFolderValidation();
    if (execNode) {
      this.cloudProfileIdValue = "";
    }
    this.callbacks.onError(null);
    this.folderValue = folder.trim();
    this.folderGatewayApproved = gatewayApproved && !execNode && !this.isAdmin();
    this.folderSelectedByUser = true;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    if (this.execNodeValue || !this.cloudProfileIdValue) {
      this.worktreeValue = false;
    }
    this.worktreeNameValue = "";
    if (!this.execNodeValue && this.agentsHydratedValue) {
      this.persistPreference({ folder: this.folderValue, worktree: this.worktreeValue });
    }
    this.maybeLoadBranches();
  }

  selectProjectId(projectId: string) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingCloudSessionKey) {
      return;
    }
    const project = this.browser.selectedProject(projectId);
    if (!project) {
      return;
    }
    this.cancelRestoredFolderValidation();
    this.browser.resetProjectSearch();
    this.projectIdValue = project.id;
    this.execNodeValue = "";
    this.cloudProfileIdValue = "";
    this.callbacks.onError(null);
    this.folderSelectedByUser = false;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    this.worktreeValue = false;
    this.worktreeNameValue = "";
    this.maybeLoadBranches();
  }

  selectExecNode(execNode: string) {
    const snapshot = this.read();
    if (snapshot.submitting || snapshot.pendingCloudSessionKey) {
      return;
    }
    if (execNode === this.execNodeValue && !this.cloudProfileIdValue) {
      return;
    }
    const keepGatewayFolder = !execNode && !this.execNodeValue;
    this.cancelRestoredFolderValidation();
    const keepWorktree = keepGatewayFolder && this.worktreeValue && this.worktreeAvailable();
    this.execNodeValue = execNode;
    this.cloudProfileIdValue = "";
    if (!keepGatewayFolder) {
      this.folderValue = execNode ? "" : this.workspacePath();
      this.folderSelectedByUser = false;
      this.folderGatewayApproved = false;
      this.projectIdValue = "";
    }
    this.worktreeValue = keepWorktree;
    this.browser.close();
    if (!this.branchesMatchCurrentRepo()) {
      this.maybeLoadBranches();
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
    this.projectIdValue = "";
    this.callbacks.onError(null);
    this.worktreeValue = true;
    this.browser.close();
    if (!this.branchesMatchCurrentRepo()) {
      this.maybeLoadBranches();
    }
    this.callbacks.requestUpdate();
  }

  toggleWorktree() {
    if (this.cloudProfileIdValue) {
      return;
    }
    this.worktreeValue = !this.worktreeValue;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    this.persistPreference({
      folder: this.folderValue.trim() || this.workspacePath(),
      worktree: this.worktreeValue,
    });
    if (this.worktreeValue && this.repositoryValue.kind !== "git") {
      this.maybeLoadBranches();
    }
    this.callbacks.requestUpdate();
  }

  setBaseRef(baseRef: string) {
    if (!this.read().submitting) {
      this.baseRefEditGeneration += 1;
      this.baseRefValue = baseRef;
      this.callbacks.requestUpdate();
    }
  }

  setWorktreeName(worktreeName: string) {
    if (!this.read().submitting) {
      this.worktreeNameValue = worktreeName;
      this.callbacks.requestUpdate();
    }
  }

  browseAvailable(): boolean {
    return this.gateway.connected && (this.isAdmin() || Boolean(this.workspacePath()));
  }

  worktreeAvailable(): boolean {
    if (this.execNodeValue) {
      return false;
    }
    if (this.selectedProject()?.repoRoot) {
      return true;
    }
    if (this.repositoryValue.kind === "git") {
      return true;
    }
    return (
      this.repositoryValue.kind === "unavailable" &&
      this.repositoryValue.repoRoot === this.workspacePath() &&
      this.selectedAgent()?.workspaceGit === true
    );
  }

  private usesCustomFolder(): boolean {
    if (this.projectIdValue) {
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
    this.worktreeValue = false;
    this.preferredWorktreeRestore = false;
    this.persistPreference({ folder: this.folderValue, worktree: false });
    this.maybeLoadBranches();
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
        this.maybeLoadBranches();
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
        !nodes.some((node) => node.nodeId === this.execNodeValue && node.canExec)
      ) {
        this.execNodeValue = "";
        this.folderValue = this.workspacePath();
        this.folderSelectedByUser = false;
        this.folderGatewayApproved = false;
        this.worktreeValue = false;
        this.worktreeNameValue = "";
        this.browser.close();
        this.maybeLoadBranches();
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

  private maybeLoadBranches() {
    const requestId = ++this.branchesRequestToken;
    const restoreWorktree = this.preferredWorktreeRestore && !this.worktreeSelectedByUser;
    const baseRefEditGeneration = this.baseRefEditGeneration;
    this.repositoryValue = { kind: "idle" };
    this.baseRefValue = "";
    const selectedProject = this.selectedProject();
    if (this.execNodeValue) {
      this.preferredWorktreeRestore = false;
      return;
    }
    if (selectedProject && !selectedProject.repoRoot) {
      this.preferredWorktreeRestore = false;
      return;
    }
    const repoRoot = selectedProject?.repoRoot ?? (this.folderValue.trim() || this.workspacePath());
    const agent = this.selectedAgent();
    const usesWorkspace = !selectedProject && repoRoot === this.workspacePath();
    if (!repoRoot) {
      this.preferredWorktreeRestore = false;
      return;
    }
    if (usesWorkspace && agent?.workspaceGit !== true) {
      this.repositoryValue = { kind: "direct", repoRoot };
      const rejectedWorktree = !this.cloudProfileIdValue && (this.worktreeValue || restoreWorktree);
      if (!this.cloudProfileIdValue) {
        this.worktreeValue = false;
      }
      this.preferredWorktreeRestore = false;
      if (rejectedWorktree) {
        this.persistPreference({ worktree: false });
      }
      return;
    }
    const snapshot = this.read().context?.gateway.snapshot;
    const client = snapshot?.client;
    if (snapshot?.phase !== "connected" || !client) {
      this.preferredWorktreeRestore = false;
      return;
    }
    this.repositoryValue = { kind: "checking", repoRoot };
    void client
      .request<WorktreesBranchesResult>("worktrees.branches", {
        repoRoot,
        includeRepositoryStatus: true,
      })
      .then((result) => {
        if (requestId !== this.branchesRequestToken) {
          return;
        }
        if (result?.repositoryStatus !== "git") {
          this.repositoryValue = {
            kind: result?.repositoryStatus === "not_git" ? "direct" : "unavailable",
            repoRoot,
          };
          if (result?.repositoryStatus === "not_git") {
            const rejectedWorktree =
              !this.cloudProfileIdValue && (this.worktreeValue || restoreWorktree);
            if (!this.cloudProfileIdValue) {
              this.worktreeValue = false;
            }
            if (rejectedWorktree) {
              this.persistPreference({ worktree: false });
            }
          } else if (restoreWorktree && !this.worktreeSelectedByUser && this.worktreeAvailable()) {
            this.worktreeValue = true;
          }
          this.preferredWorktreeRestore = false;
          this.callbacks.requestUpdate();
          return;
        }
        this.repositoryValue = {
          kind: "git",
          repoRoot,
          branches: result.branches,
          ...(result.defaultBranch ? { defaultBranch: result.defaultBranch } : {}),
          ...(result.headBranch ? { headBranch: result.headBranch } : {}),
        };
        if (restoreWorktree && !this.worktreeSelectedByUser && !this.execNodeValue) {
          this.worktreeValue = true;
        }
        this.preferredWorktreeRestore = false;
        if (baseRefEditGeneration === this.baseRefEditGeneration) {
          this.baseRefValue = result.defaultBranch ?? result.headBranch ?? "";
        }
        this.callbacks.requestUpdate();
      })
      .catch(() => {
        if (requestId !== this.branchesRequestToken) {
          return;
        }
        this.repositoryValue = { kind: "unavailable", repoRoot };
        if (restoreWorktree && !this.worktreeSelectedByUser && this.worktreeAvailable()) {
          this.worktreeValue = true;
        }
        this.preferredWorktreeRestore = false;
        this.callbacks.requestUpdate();
      });
  }

  private branchesMatchCurrentRepo(): boolean {
    if (this.execNodeValue || this.repositoryValue.kind === "idle") {
      return false;
    }
    const repoRoot = this.folderValue.trim() || this.workspacePath();
    return this.repositoryValue.repoRoot === repoRoot;
  }
}
