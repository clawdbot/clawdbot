import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type {
  FsListDirResult,
  ProjectRecord,
  ProjectRecent,
  ProjectsAddResult,
  ProjectsListResult,
  ProjectsRegisterResult,
  ProjectsSearchRemoteResult,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { BrowserTarget, DraftNode } from "./discovery.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { folderDisplayName, isAbsolutePath, isKnownWorkspacePath } from "./path.ts";
import { projectCloneInput } from "./place-picker.ts";
import { recentPlaces, type RecentPlaceSource } from "./recent-places.ts";

const PROJECT_SEARCH_DEBOUNCE_MS = 300;

type DraftPlaceBrowserSnapshot = Readonly<{
  context: ApplicationContext | undefined;
  projectId: string;
  nodes: readonly DraftNode[];
  folder: string;
  execNode: string;
  isAdmin: boolean;
}>;

type DraftPlaceBrowserCallbacks = {
  requestUpdate: () => void;
  onProjectMissing: () => void;
  onSelectProject: (projectId: string) => void;
  onApplyFolder: (folder: string, execNode: string, gatewayApproved: boolean) => void;
  onApprovedListing: (listing: FsListDirResult) => void;
  querySelector: (selector: string) => Element | null;
  activeElement: () => Element | null;
  body: () => HTMLElement | null;
};

export class DraftPlaceBrowser {
  private projectsValue: ProjectRecord[] = [];
  private projectRecentsValue: ProjectRecent[] | undefined;
  private projectQueryValue = "";
  private debouncedProjectQuery = "";
  private projectCloneBusyValue = false;
  private projectCloneErrorValue: string | null = null;
  private browserLoadingValue = false;
  private browserErrorValue: string | null = null;
  private browserListingValue: FsListDirResult | null = null;
  private browserTargetValue: BrowserTarget | null = null;
  private browserProjectPathValue: string | null = null;
  private browserRegisteringValue = false;
  private placePopoverOpenValue = false;
  private placePopoverHidingValue = false;
  // Live head input; absolute paths stay applicable even without fs.listDir.
  private browserPathDraftValue = "";
  private browserRequestToken = 0;
  private projectCloneRequestToken = 0;
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
        if (
          this.read().projectId &&
          !projects.some((project) => project.id === this.read().projectId)
        ) {
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

  get projectRecents(): readonly ProjectRecent[] | undefined {
    return this.projectRecentsValue;
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
    return error instanceof Error ? error.message : String(error);
  }

  get projectCloneBusy(): boolean {
    return this.projectCloneBusyValue;
  }

  get projectCloneError(): string | null {
    return this.projectCloneErrorValue;
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

  get placePopoverOpen(): boolean {
    return this.placePopoverOpenValue;
  }

  get placePopoverHiding(): boolean {
    return this.placePopoverHidingValue;
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

  selectedProject(projectId: string): ProjectRecord | undefined {
    return this.projectsValue.find((project) => project.id === projectId);
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
    this.projectCloneErrorValue = null;
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

  async addRemoteProject(gitUrl: string) {
    const client = this.gateway.client;
    const context = this.read().context;
    if (
      !client ||
      !this.gateway.connected ||
      this.projectCloneBusyValue ||
      !context ||
      !canCallGatewayMethod(context.gateway.snapshot, "projects.add", "operator.write")
    ) {
      return;
    }
    const requestId = ++this.projectCloneRequestToken;
    const connectionEpoch = this.gateway.connectionEpoch;
    this.projectCloneBusyValue = true;
    this.projectCloneErrorValue = null;
    this.callbacks.requestUpdate();
    try {
      const project = await client.request<ProjectsAddResult>(
        "projects.add",
        { gitUrl },
        { timeoutMs: null },
      );
      if (
        requestId !== this.projectCloneRequestToken ||
        client !== this.gateway.client ||
        connectionEpoch !== this.gateway.connectionEpoch
      ) {
        return;
      }
      await this.projectsTask.run([client, true, connectionEpoch]);
      if (
        requestId !== this.projectCloneRequestToken ||
        client !== this.gateway.client ||
        connectionEpoch !== this.gateway.connectionEpoch
      ) {
        return;
      }
      this.callbacks.onSelectProject(project.id);
      this.close();
    } catch (error) {
      if (requestId === this.projectCloneRequestToken && client === this.gateway.client) {
        this.projectCloneErrorValue = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestId === this.projectCloneRequestToken) {
        this.projectCloneBusyValue = false;
        this.callbacks.requestUpdate();
      }
    }
  }

  resetProjectSearch() {
    this.clearProjectSearchTimer();
    this.projectCloneRequestToken += 1;
    this.projectQueryValue = "";
    this.debouncedProjectQuery = "";
    this.projectCloneBusyValue = false;
    this.projectCloneErrorValue = null;
    this.callbacks.requestUpdate();
  }

  resetProjects() {
    this.projectsValue = [];
    this.projectRecentsValue = undefined;
    this.resetProjectSearch();
  }

  close() {
    this.resetBrowser(true);
    const popover = this.callbacks.querySelector(".new-session-page__place-popover") as
      | (HTMLElement & {
          open: boolean;
        })
      | null;
    if (popover) {
      popover.open = false;
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

  loadBrowser(path: string | undefined) {
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
    this.browserErrorValue = null;
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
      .catch(() => {
        if (requestId !== this.browserRequestToken) {
          return;
        }
        if (path) {
          this.loadBrowser(undefined);
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
        this.browserErrorValue = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (requestId === this.browserRequestToken) {
        this.browserRegisteringValue = false;
        this.callbacks.requestUpdate();
      }
    }
  }

  onPopoverShow() {
    this.placePopoverOpenValue = true;
    this.showRoot();
  }

  onPopoverHide() {
    this.placePopoverOpenValue = false;
    this.placePopoverHidingValue = true;
    this.showRoot();
  }

  onPopoverAfterHide() {
    this.placePopoverHidingValue = false;
    this.restorePopoverTrigger("new-session-place-trigger", ".new-session-page__place-popover");
    this.callbacks.requestUpdate();
  }

  guardPopoverTransition(event: Event) {
    if (!this.placePopoverHidingValue) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  clearPopoverHiding() {
    this.placePopoverHidingValue = false;
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
      this.placePopoverOpenValue = false;
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
