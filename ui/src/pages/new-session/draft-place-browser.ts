import { initialState, Task, TaskStatus } from "@lit/task";
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
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import { folderDisplayName, isAbsolutePath, isKnownWorkspacePath } from "./path.ts";
import { PICKER_INPUT_DEBOUNCE_MS, PlaceBrowserState } from "./place-browser-state.ts";
import { projectCloneInput, type DraftRemoteProject } from "./project-chip.ts";
import { recentPlaces, type RecentPlaceSource } from "./recent-places.ts";

type DraftPickerKind = "where" | "project" | "checkout";

type DraftPlaceBrowserSnapshot = Readonly<{
  context: ApplicationContext | undefined;
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
  private browserOpenValue = false;
  private browserProjectPathValue: string | null = null;
  private browserRegistrationId: number | null = null;
  private browserRegistrationCounter = 0;
  private openPopoverValue: DraftPickerKind | null = null;
  // Independent hide animations can overlap; keep every trigger fenced until its own completes.
  private readonly hidingPopovers = new Set<DraftPickerKind>();
  private projectSearchTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  readonly browser: PlaceBrowserState;

  private readonly projectsTask: Task<readonly unknown[], ProjectsListResult>;
  private readonly projectSearchTask: Task<readonly unknown[], ProjectsSearchRemoteResult>;

  constructor(
    host: ReactiveControllerHost,
    private readonly gateway: DraftGatewayState,
    private readonly read: () => DraftPlaceBrowserSnapshot,
    private readonly callbacks: DraftPlaceBrowserCallbacks,
  ) {
    this.browser = new PlaceBrowserState(
      (path) => {
        const snapshot = this.read().context?.gateway.snapshot;
        if (snapshot?.phase !== "connected" || !snapshot.client || !this.browserOpenValue) {
          return Promise.reject(new Error("Folder browser is unavailable"));
        }
        return snapshot.client.request<FsListDirResult>("fs.listDir", path ? { path } : {});
      },
      this.callbacks.requestUpdate,
      (listing) => {
        this.browserProjectPathValue = null;
        this.callbacks.onApprovedListing(listing);
        const snapshot = this.read();
        const client = snapshot.context?.gateway.snapshot.client;
        if (!snapshot.isAdmin || !client) {
          return;
        }
        void client
          .request<WorktreesBranchesResult>("worktrees.branches", {
            repoRoot: listing.path,
            includeRepositoryStatus: true,
          })
          .then((branches) => {
            // Typing keeps this listing valid; replacement or reset retires its probe.
            if (this.browser.listing === listing && branches.repositoryStatus === "git") {
              this.browserProjectPathValue = listing.path;
              this.callbacks.requestUpdate();
            }
          })
          .catch(() => undefined);
      },
    );
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
        // A disconnect has no catalog result and cannot retire the selected project.
        if (!client) {
          return initialState;
        }
        if (!advertised) {
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

  get browserOpen(): boolean {
    return this.browserOpenValue;
  }

  get browserProjectPath(): string | null {
    // The register affordance and fence follow the draft's directory, not just loading state.
    // A shown error (failed navigate or failed registration) leaves the loaded folder valid,
    // so the action stays available for a retry.
    return this.browser.loading || !this.browser.draftInLoadedDirectory()
      ? null
      : this.browserProjectPathValue;
  }

  get browserRegistering(): boolean {
    return this.browserRegistrationId !== null;
  }

  popoverOpen(kind: DraftPickerKind): boolean {
    return this.openPopoverValue === kind;
  }

  popoverHiding(kind: DraftPickerKind): boolean {
    return this.hidingPopovers.has(kind);
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
    isAdmin: boolean;
  }): ProjectRecent[] {
    const allowGatewayFolder = (folder: string) =>
      params.isAdmin || isKnownWorkspacePath(params.workspaceRoots, folder);
    const serverRecents = this.projectRecentsValue?.filter((recent) =>
      recent.kind === "project"
        ? this.projectsValue.some((project) => project.id === recent.projectId)
        : recent.kind === "repository" || (!recent.execNode && allowGatewayFolder(recent.folder)),
    );
    return (
      serverRecents ??
      recentPlaces(params.sessions, {
        workspace: params.workspace,
        allowGatewayFolder,
      }).map((recent) => {
        const item: ProjectRecent = {
          kind: "folder",
          folder: recent.folder,
          displayName: folderDisplayName(recent.folder),
        };
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
    }, PICKER_INPUT_DEBOUNCE_MS);
    this.callbacks.requestUpdate();
  }

  resetProjectSearch() {
    this.clearProjectSearchTimer();
    this.projectQueryValue = "";
    this.debouncedProjectQuery = "";
    this.callbacks.requestUpdate();
  }

  resetProjects(resetSelection = true) {
    // Retire the old request and refetch even when the connection has not changed.
    void this.projectsTask.run([null, false, -1]);
    if (!resetSelection) {
      return;
    }
    this.projectsValue = [];
    this.projectRecentsValue = undefined;
    this.clearProjectSelection();
    this.resetProjectSearch();
  }

  close() {
    this.resetBrowser(true);
    for (const kind of ["where", "project", "checkout"] as const) {
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

  selectGatewayBrowser(path?: string) {
    this.browserOpenValue = true;
    this.loadBrowser(path && isAbsolutePath(path) ? path : undefined);
  }

  loadBrowser(path: string | undefined) {
    const snapshot = this.read().context?.gateway.snapshot;
    if (snapshot?.phase !== "connected" || !snapshot.client || !this.browserOpenValue) {
      return;
    }
    this.browserProjectPathValue = null;
    void this.browser.navigate(path);
  }

  async registerBrowserProject(path: string) {
    const snapshot = this.read();
    const gatewaySnapshot = snapshot.context?.gateway.snapshot;
    const client = gatewaySnapshot?.client;
    if (
      gatewaySnapshot?.phase !== "connected" ||
      !client ||
      !snapshot.isAdmin ||
      this.browserProjectPath !== path ||
      this.browserRegistering
    ) {
      return;
    }
    const connectionEpoch = this.gateway.connectionEpoch;
    const generation = this.browser.listingGeneration;
    const id = ++this.browserRegistrationCounter;
    this.browserRegistrationId = id;
    // Navigation/loading/errors hide the project path; IDs retire reset or superseded work.
    // Plain filtering preserves both, so a valid registration can finish.
    // A replaced listing retires registration even when the same folder is loaded again.
    const isCurrentRegistration = () =>
      this.browserRegistrationId === id &&
      this.browser.listingGeneration === generation &&
      this.browserProjectPath === path &&
      client === this.gateway.client;
    this.browser.error = null;
    this.callbacks.requestUpdate();
    try {
      const project = await client.request<ProjectsRegisterResult>("projects.register", { path });
      if (!isCurrentRegistration()) {
        return;
      }
      await this.projectsTask.run([client, true, connectionEpoch]);
      if (!isCurrentRegistration()) {
        return;
      }
      this.callbacks.onSelectProject(project.id);
      this.close();
    } catch (error) {
      if (isCurrentRegistration()) {
        this.browser.error = formatUiError(error);
      }
    } finally {
      if (this.browserRegistrationId === id) {
        this.browserRegistrationId = null;
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
    this.hidingPopovers.add(kind);
    if (kind === "project") {
      this.showRoot();
    } else {
      this.callbacks.requestUpdate();
    }
  }

  onPopoverAfterHide(kind: DraftPickerKind) {
    this.hidingPopovers.delete(kind);
    this.restorePopoverTrigger(`new-session-${kind}-trigger`, `.new-session-page__${kind}-popover`);
    this.callbacks.requestUpdate();
  }

  guardPopoverTransition(event: Event, kind: DraftPickerKind) {
    if (!this.hidingPopovers.has(kind)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  clearPopoverHiding() {
    this.hidingPopovers.clear();
    this.callbacks.requestUpdate();
  }

  disconnect() {
    this.browser.reset();
    this.clearProjectSearchTimer();
    void this.projectsTask.run([null, false, -1]);
    void this.projectSearchTask.run([null, false, "", -1]);
  }

  private resetBrowser(closePopover: boolean) {
    this.browser.reset();
    this.browserOpenValue = false;
    this.browserProjectPathValue = null;
    this.browserRegistrationId = null;
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
