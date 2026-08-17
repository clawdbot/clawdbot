import { initialState, Task, TaskStatus } from "@lit/task";
import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import type { ReactiveControllerHost } from "lit";
import type {
  FsListDirResult,
  ProjectRecord,
  ProjectRecent,
  ProjectsListResult,
  ProjectsRegisterResult,
  ProjectsSearchRemoteResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { BrowserTarget, DraftNode } from "./discovery.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { folderDisplayName, isAbsolutePath, isKnownWorkspacePath } from "./path.ts";
import { projectCloneInput, type DraftRemoteProject } from "./project-chip.ts";
import { recentPlaces, type RecentPlaceSource } from "./recent-places.ts";

const PROJECT_SEARCH_DEBOUNCE_MS = 300;
type DraftPickerKind = "where" | "project" | "detail";

type DraftPlaceBrowserSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  nodes: readonly DraftNode[];
  folder: string;
  execNode: string;
  isAdmin: boolean;
}>;

type DraftProjectSelection =
  | { kind: "local"; id: string }
  | { kind: "remote"; project: DraftRemoteProject }
  | null;

type DraftPlaceBrowserCallbacks = {
  requestUpdate: () => void;
  onProjectMissing: () => void;
  onSelectProject: (projectId: string) => void;
  onApprovedListing: (listing: FsListDirResult) => void;
  querySelector: (selector: string) => Element | null;
  activeElement: () => Element | null;
  body: () => HTMLElement | null;
};

export class DraftPlaceBrowser {
  private projectsValue: ProjectRecord[] = [];
  private projectRecentsValue: ProjectRecent[] | undefined;
  private projectSelection: DraftProjectSelection = null;
  private projectQueryValue = "";
  private debouncedProjectQuery = "";
  private browserLoadingValue = false;
  private browserErrorValue: string | null = null;
  private browserListingValue: FsListDirResult | null = null;
  private browserTargetValue: BrowserTarget | null = null;
  private browserProjectPathValue: string | null = null;
  private browserRegisteringValue = false;
  private openPopoverValue: DraftPickerKind | null = null;
  private hidingPopoverValue: DraftPickerKind | null = null;
  // Live head input; absolute paths stay applicable even without fs.listDir.
  private browserPathDraftValue = "";
  private browserRequestToken = 0;
  private projectSearchTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  private readonly projectsTask: Task<readonly unknown[], ProjectsListResult>;
  private readonly projectSearchTask: Task<readonly unknown[], ProjectsSearchRemoteResult>;

  constructor(
    host: ReactiveControllerHost,
    private readonly gateway: DraftGatewayState,
    private readonly read: () => DraftPlaceBrowserSnapshot,
    private readonly callbacks: DraftPlaceBrowserCallbacks,
  ) {
    this.projectsTask = new Task(host, {
      args: () =>
        [
          this.read().context && this.gateway.connected ? this.gateway.client : null,
          isGatewayMethodAdvertised(
            this.read().context?.gateway.snapshot ?? {},
            "projects.list",
          ) === true,
          this.gateway.connectionEpoch,
        ] as const,
      task: async ([client, advertised]) => {
        if (!client || !advertised) {
          return { projects: [] } as ProjectsListResult;
        }
        return await (
          client as NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>
        ).request<ProjectsListResult>("projects.list", {});
      },
      onComplete: (result) => {
        const projects = result.projects ?? [];
        this.projectsValue = projects;
        this.projectRecentsValue = result.recents;
        if (this.projectId && !projects.some((project) => project.id === this.projectId)) {
          this.callbacks.onProjectMissing();
        }
        this.callbacks.requestUpdate();
      },
      onError: () => {
        this.projectsValue = [];
        this.projectRecentsValue = undefined;
        this.callbacks.onProjectMissing();
        this.callbacks.requestUpdate();
      },
    });
    this.projectSearchTask = new Task(host, {
      args: () =>
        [
          this.read().context && this.gateway.connected ? this.gateway.client : null,
          this.read().context
            ? canCallGatewayMethod(
                this.read().context?.gateway.snapshot,
                "projects.searchRemote",
                "operator.read",
              )
            : false,
          this.debouncedProjectQuery,
          this.gateway.connectionEpoch,
        ] as const,
      task: ([client, advertised, query], { signal }) => {
        if (!client || !advertised || query.length < 2 || projectCloneInput(query)) {
          return initialState;
        }
        return client.request<ProjectsSearchRemoteResult>(
          "projects.searchRemote",
          { query },
          { signal },
        );
      },
    });
  }

  get projects(): readonly ProjectRecord[] {
    return this.projectsValue;
  }

  get projectsReady(): boolean {
    return (
      this.projectsTask.status === TaskStatus.COMPLETE ||
      this.projectsTask.status === TaskStatus.ERROR
    );
  }

  get projectRecents(): readonly ProjectRecent[] | undefined {
    return this.projectRecentsValue;
  }

  get projectId(): string {
    return this.projectSelection?.kind === "local" ? this.projectSelection.id : "";
  }

  get remoteProject(): DraftRemoteProject | null {
    return this.projectSelection?.kind === "remote" ? this.projectSelection.project : null;
  }

  get projectQuery(): string {
    return this.projectQueryValue;
  }

  get projectSearchResult(): ProjectsSearchRemoteResult | null {
    return this.projectSearchTask.status === TaskStatus.COMPLETE &&
      this.debouncedProjectQuery === this.projectQueryValue.trim()
      ? (this.projectSearchTask.value ?? null)
      : null;
  }

  get projectSearchLoading(): boolean {
    return (
      this.debouncedProjectQuery.length >= 2 &&
      this.debouncedProjectQuery === this.projectQueryValue.trim() &&
      this.projectSearchTask.status === TaskStatus.PENDING
    );
  }

  get projectSearchError(): string | null {
    if (
      this.projectSearchTask.status !== TaskStatus.ERROR ||
      this.debouncedProjectQuery !== this.projectQueryValue.trim()
    ) {
      return null;
    }
    const error = this.projectSearchTask.error;
    return formatUiError(error);
  }

  get browserLoading(): boolean {
    return this.browserLoadingValue;
  }

  get browserError(): string | null {
    return this.browserErrorValue;
  }

  get browserListing(): FsListDirResult | null {
    return this.browserListingValue;
  }

  get browserTarget(): BrowserTarget | null {
    return this.browserTargetValue;
  }

  get browserProjectPath(): string | null {
    return this.browserProjectPathValue;
  }

  get browserRegistering(): boolean {
    return this.browserRegisteringValue;
  }

  popoverOpen(kind: DraftPickerKind): boolean {
    return this.openPopoverValue === kind;
  }

  popoverHiding(kind: DraftPickerKind): boolean {
    return this.hidingPopoverValue === kind;
  }

  popoverCallbacks(kind: DraftPickerKind) {
    return {
      popoverOpen: this.popoverOpen(kind),
      popoverHiding: this.popoverHiding(kind),
      onGuardTransition: (event: MouseEvent) => this.guardPopoverTransition(event, kind),
      onPopoverShow: () => this.onPopoverShow(kind),
      onPopoverHide: () => this.onPopoverHide(kind),
      onPopoverAfterHide: () => this.onPopoverAfterHide(kind),
    };
  }

  get browserPathDraft(): string {
    return this.browserPathDraftValue;
  }

  set browserPathDraft(value: string) {
    this.browserPathDraftValue = value;
    this.callbacks.requestUpdate();
  }

  async refreshProjects(): Promise<unknown> {
    const context = this.read().context;
    return await this.projectsTask.run([
      this.gateway.connected ? this.gateway.client : null,
      context
        ? isGatewayMethodAdvertised(context.gateway.snapshot, "projects.list") === true
        : false,
      this.gateway.connectionEpoch,
    ]);
  }

  selectedProject(): ProjectRecord | undefined {
    return this.projectsValue.find((project) => project.id === this.projectId);
  }

  selectProject(selection: Exclude<DraftProjectSelection, null>) {
    this.projectSelection = selection;
  }

  recordRemoteProjectId(cloneUrl: string, projectId: string) {
    const project = this.remoteProject;
    if (project?.cloneUrl === cloneUrl) {
      this.projectSelection = { kind: "remote", project: { ...project, projectId } };
    }
  }

  clearProjectSelection() {
    this.projectSelection = null;
  }

  resolveProjectRecents(params: {
    sessions: readonly RecentPlaceSource[];
    workspace: string;
    workspaceRoots: readonly string[];
    execNodes: readonly DraftNode[];
    isAdmin: boolean;
  }): ProjectRecent[] {
    const allowGatewayFolder = (folder: string) =>
      params.isAdmin || isKnownWorkspacePath(params.workspaceRoots, folder);
    const serverRecents = this.projectRecentsValue?.filter((recent) =>
      recent.kind === "project"
        ? this.projectsValue.some((project) => project.id === recent.projectId)
        : recent.execNode
          ? params.execNodes.some((node) => node.nodeId === recent.execNode)
          : allowGatewayFolder(recent.folder),
    );
    return (
      serverRecents ??
      recentPlaces(params.sessions, {
        workspace: params.workspace,
        execNodes: params.execNodes,
        allowGatewayFolder,
      }).map((recent) => {
        const item: ProjectRecent = {
          kind: "folder",
          folder: recent.folder,
          displayName: folderDisplayName(recent.folder),
        };
        if (recent.execNode) {
          item.execNode = recent.execNode;
        }
        return item;
      })
    );
  }

  changeProjectQuery(query: string) {
    this.projectQueryValue = query;
    this.clearProjectSearchTimer();
    this.debouncedProjectQuery = "";
    void this.projectSearchTask.run([null, false, "", this.gateway.connectionEpoch]);
    const normalized = query.trim();
    const context = this.read().context;
    if (
      normalized.length < 2 ||
      projectCloneInput(normalized) ||
      !this.gateway.connected ||
      !this.gateway.client ||
      !context ||
      !canCallGatewayMethod(context.gateway.snapshot, "projects.searchRemote", "operator.read")
    ) {
      this.callbacks.requestUpdate();
      return;
    }
    const client = this.gateway.client;
    const connectionEpoch = this.gateway.connectionEpoch;
    this.projectSearchTimer = globalThis.setTimeout(() => {
      this.projectSearchTimer = undefined;
      if (client !== this.gateway.client || connectionEpoch !== this.gateway.connectionEpoch) {
        return;
      }
      this.debouncedProjectQuery = normalized;
      void this.projectSearchTask.run([client, true, normalized, connectionEpoch]);
      this.callbacks.requestUpdate();
    }, PROJECT_SEARCH_DEBOUNCE_MS);
    this.callbacks.requestUpdate();
  }

  resetProjectSearch() {
    this.clearProjectSearchTimer();
    this.projectQueryValue = "";
    this.debouncedProjectQuery = "";
    this.callbacks.requestUpdate();
  }

  resetProjects() {
    this.projectsValue = [];
    this.projectRecentsValue = undefined;
    this.clearProjectSelection();
    this.resetProjectSearch();
  }

  close() {
    this.resetBrowser(true);
    for (const kind of ["where", "project", "detail"] as const) {
      const popover = this.callbacks.querySelector(`.new-session-page__${kind}-popover`) as
        | (HTMLElement & { open: boolean })
        | null;
      if (popover) {
        popover.open = false;
      }
    }
  }

  showRoot() {
    this.resetBrowser(false);
  }

  usableBrowserPath(): string | null {
    const draft = this.browserPathDraftValue.trim();
    if (draft.length === 0) {
      return "";
    }
    return isAbsolutePath(draft) ? draft : null;
  }

  selectBrowserTarget(target: BrowserTarget) {
    const snapshot = this.read();
    const folder = snapshot.folder.trim();
    const matchesCurrentTarget = target.nodeId === snapshot.execNode;
    const path = matchesCurrentTarget && isAbsolutePath(folder) ? folder : undefined;
    this.browserTargetValue = target;
    this.loadBrowser(path);
  }

  loadBrowser(path: string | undefined, retainedError: string | null = null) {
    const snapshot = this.read();
    const gatewaySnapshot = snapshot.context?.gateway.snapshot;
    const client = gatewaySnapshot?.client;
    const target = this.browserTargetValue;
    if (gatewaySnapshot?.phase !== "connected" || !client || !target) {
      return;
    }
    const targetNode = snapshot.nodes.find((node) => node.nodeId === target.nodeId);
    if (targetNode?.canExec && !targetNode.canBrowse) {
      this.showRoot();
      this.browserTargetValue = target;
      this.browserPathDraftValue = path ?? "";
      this.callbacks.requestUpdate();
      return;
    }
    const requestId = ++this.browserRequestToken;
    this.browserLoadingValue = true;
    this.browserErrorValue = retainedError;
    this.browserProjectPathValue = null;
    this.browserListingValue = null;
    this.browserPathDraftValue = path ?? "";
    const draftAtRequest = this.browserPathDraftValue;
    this.callbacks.requestUpdate();
    void client
      .request<FsListDirResult>("fs.listDir", {
        ...(path ? { path } : {}),
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
      })
      .then((result) => {
        if (requestId !== this.browserRequestToken) {
          return;
        }
        this.browserListingValue = result ?? null;
        if (result) {
          this.callbacks.onApprovedListing(result);
        }
        if (result?.path && this.browserPathDraftValue === draftAtRequest) {
          this.browserPathDraftValue = result.path;
        }
        if (result?.path && !target.nodeId && snapshot.isAdmin) {
          void client
            .request<WorktreesBranchesResult>("worktrees.branches", {
              repoRoot: result.path,
              includeRepositoryStatus: true,
            })
            .then((branches) => {
              if (
                requestId === this.browserRequestToken &&
                this.browserListingValue?.path === result.path &&
                branches.repositoryStatus === "git"
              ) {
                this.browserProjectPathValue = result.path;
                this.callbacks.requestUpdate();
              }
            })
            .catch(() => undefined);
        }
        this.callbacks.requestUpdate();
      })
      .catch((error: unknown) => {
        if (requestId !== this.browserRequestToken) {
          return;
        }
        if (path) {
          this.loadBrowser(
            undefined,
            !target.nodeId && readMissingScopeError(error)?.missingScope === "operator.admin"
              ? t("newSession.browseRequiresAdmin")
              : t("newSession.browserLoadFailed"),
          );
          return;
        }
        this.browserErrorValue = t("newSession.browserLoadFailed");
        this.callbacks.requestUpdate();
      })
      .finally(() => {
        if (requestId === this.browserRequestToken) {
          this.browserLoadingValue = false;
          this.callbacks.requestUpdate();
        }
      });
  }

  async registerBrowserProject(path: string) {
    const snapshot = this.read();
    const gatewaySnapshot = snapshot.context?.gateway.snapshot;
    const client = gatewaySnapshot?.client;
    if (
      gatewaySnapshot?.phase !== "connected" ||
      !client ||
      !snapshot.isAdmin ||
      this.browserTargetValue?.nodeId ||
      this.browserProjectPathValue !== path ||
      this.browserRegisteringValue
    ) {
      return;
    }
    const requestId = this.browserRequestToken;
    const connectionEpoch = this.gateway.connectionEpoch;
    this.browserRegisteringValue = true;
    this.browserErrorValue = null;
    this.callbacks.requestUpdate();
    try {
      const project = await client.request<ProjectsRegisterResult>("projects.register", { path });
      if (requestId !== this.browserRequestToken || client !== this.gateway.client) {
        return;
      }
      await this.projectsTask.run([client, true, connectionEpoch]);
      if (requestId !== this.browserRequestToken || client !== this.gateway.client) {
        return;
      }
      this.callbacks.onSelectProject(project.id);
      this.close();
    } catch (error) {
      if (requestId === this.browserRequestToken && client === this.gateway.client) {
        this.browserErrorValue = formatUiError(error);
      }
    } finally {
      if (requestId === this.browserRequestToken) {
        this.browserRegisteringValue = false;
        this.callbacks.requestUpdate();
      }
    }
  }

  onPopoverShow(kind: DraftPickerKind) {
    this.openPopoverValue = kind;
    if (kind === "project") {
      this.showRoot();
    } else {
      this.callbacks.requestUpdate();
    }
  }

  onPopoverHide(kind: DraftPickerKind) {
    if (this.openPopoverValue === kind) {
      this.openPopoverValue = null;
    }
    this.hidingPopoverValue = kind;
    if (kind === "project") {
      this.showRoot();
    } else {
      this.callbacks.requestUpdate();
    }
  }

  onPopoverAfterHide(kind: DraftPickerKind) {
    if (this.hidingPopoverValue === kind) {
      this.hidingPopoverValue = null;
    }
    this.restorePopoverTrigger(`new-session-${kind}-trigger`, `.new-session-page__${kind}-popover`);
    this.callbacks.requestUpdate();
  }

  guardPopoverTransition(event: Event, kind: DraftPickerKind) {
    if (this.hidingPopoverValue !== kind) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  clearPopoverHiding() {
    this.hidingPopoverValue = null;
    this.callbacks.requestUpdate();
  }

  disconnect() {
    this.clearProjectSearchTimer();
    void this.projectsTask.run([null, false, -1]);
    void this.projectSearchTask.run([null, false, "", -1]);
  }

  private resetBrowser(closePopover: boolean) {
    this.browserRequestToken += 1;
    this.browserLoadingValue = false;
    this.browserErrorValue = null;
    this.browserListingValue = null;
    this.browserTargetValue = null;
    this.browserProjectPathValue = null;
    this.browserRegisteringValue = false;
    this.browserPathDraftValue = "";
    if (closePopover) {
      this.openPopoverValue = null;
    }
    this.callbacks.requestUpdate();
  }

  private clearProjectSearchTimer() {
    globalThis.clearTimeout(this.projectSearchTimer);
    this.projectSearchTimer = undefined;
  }

  private restorePopoverTrigger(id: string, popoverSelector: string) {
    const active = this.callbacks.activeElement();
    const popover = this.callbacks.querySelector(popoverSelector);
    const body = this.callbacks.body();
    if (active && active !== body && !popover?.contains(active)) {
      return;
    }
    (this.callbacks.querySelector(`#${id}`) as HTMLButtonElement | null)?.focus();
  }
}
