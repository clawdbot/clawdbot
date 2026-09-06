import type {
  ProjectRecord,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftRepositoryState } from "./discovery.ts";
import type { NewSessionPreference } from "./preferences.ts";
import type { DraftRemoteProject } from "./project-chip.ts";

type DraftRepositorySnapshot = Readonly<{
  remotePlacement: boolean;
  selectedProject: ProjectRecord | undefined;
  remoteProject: DraftRemoteProject | null;
  folder: string;
  workspace: string;
  workspaceGit: boolean;
  gateway: ApplicationContext["gateway"]["snapshot"] | undefined;
}>;

type DraftRepositoryCallbacks = {
  requestUpdate: () => void;
  persistPreference: (patch: NewSessionPreference) => void;
};

type ResolvedRepository = Exclude<DraftRepositoryState, { kind: "checking" }>;

function initialRepositoryState(snapshot: DraftRepositorySnapshot): DraftRepositoryState {
  if (snapshot.remoteProject) {
    return { kind: "pending-clone", cloneUrl: snapshot.remoteProject.cloneUrl };
  }
  const repoRoot =
    snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
  if (!repoRoot || (snapshot.selectedProject && !snapshot.selectedProject.repoRoot)) {
    return { kind: "idle" };
  }
  return !snapshot.selectedProject && repoRoot === snapshot.workspace && !snapshot.workspaceGit
    ? { kind: "direct", repoRoot }
    : { kind: "checking", repoRoot };
}

export class DraftRepositoryController {
  private worktreeValue = false;
  private worktreeNameValue = "";
  private baseRefOverride: string | undefined;
  private repositoryValue: DraftRepositoryState = { kind: "idle" };
  private requestToken = 0;
  private preferredWorktreeRestore = false;
  private worktreeSelectedByUser = false;
  private detailsSelectedByUser = false;

  constructor(
    private readonly read: () => DraftRepositorySnapshot,
    private readonly callbacks: DraftRepositoryCallbacks,
  ) {}

  get worktree(): boolean {
    return this.worktreeValue;
  }

  get worktreeName(): string {
    return this.worktreeNameValue;
  }

  get baseRef(): string {
    // Discovery supplies defaults; reconnects never rewrite the operator's selection.
    const repository = this.repositoryValue.kind === "git" ? this.repositoryValue : undefined;
    return this.baseRefOverride ?? (repository?.defaultBranch || repository?.headBranch || "");
  }

  get repository(): DraftRepositoryState {
    return this.repositoryValue;
  }

  get preferenceReady(): boolean {
    return !this.preferredWorktreeRestore;
  }

  get hasUserSelection(): boolean {
    return this.worktreeSelectedByUser || this.detailsSelectedByUser;
  }

  adoptPreference(preference: NewSessionPreference | null) {
    if (!this.worktreeSelectedByUser) {
      this.worktreeValue = false;
      this.preferredWorktreeRestore = preference?.worktree === true;
    }
    if (!this.detailsSelectedByUser) {
      this.baseRefOverride = preference?.baseRef || undefined;
      this.worktreeNameValue = preference?.worktreeName ?? "";
    }
    if (!this.matchesCurrentRepo()) {
      // Retire the old folder's RPC before it can consume the new preference.
      this.invalidate();
    } else if (this.repositoryValue.kind !== "checking") {
      this.adoptResolvedRepository(this.repositoryValue);
    }
  }

  reset() {
    this.invalidate();
    this.worktreeValue = false;
    this.clearDetails();
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = false;
  }

  clearDetails(persist = false) {
    this.baseRefOverride = undefined;
    this.worktreeNameValue = "";
    this.detailsSelectedByUser = false;
    if (persist) {
      this.callbacks.persistPreference({ baseRef: "", worktreeName: "" });
    }
  }

  invalidate() {
    this.requestToken += 1;
    this.repositoryValue = { kind: "idle" };
  }

  selectWorktree(value: boolean, clearName = true) {
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    this.worktreeValue = value;
    if (clearName) {
      this.clearDetails(true);
    }
  }

  forceWorktree(value: boolean) {
    this.worktreeValue = value;
  }

  rejectPreferredWorktree() {
    this.preferredWorktreeRestore = false;
    this.worktreeValue = false;
    this.clearDetails(true);
  }

  select(value: boolean) {
    if (this.worktreeValue === value || this.read().remotePlacement) {
      return;
    }
    this.selectWorktree(value, false);
    this.callbacks.persistPreference({
      folder: this.read().folder.trim() || this.read().workspace,
      worktree: this.worktreeValue,
    });
    if (this.worktreeValue && !this.available()) {
      this.load();
    }
    this.callbacks.requestUpdate();
  }

  setBaseRef(baseRef: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.baseRefOverride = baseRef;
    this.detailsSelectedByUser = true;
    this.callbacks.persistPreference({ baseRef });
    this.callbacks.requestUpdate();
  }

  setWorktreeName(worktreeName: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.worktreeNameValue = worktreeName;
    this.detailsSelectedByUser = true;
    this.callbacks.persistPreference({ worktreeName });
    this.callbacks.requestUpdate();
  }

  available(): boolean {
    const state = this.repositoryValue;
    // A saved path or .git marker cannot prove that Git has a usable HEAD.
    return state.kind === "git" || state.kind === "pending-clone";
  }

  matchesCurrentRepo(): boolean {
    const snapshot = this.read();
    const state = this.repositoryValue;
    if (state.kind === "pending-clone") {
      return snapshot.remoteProject?.cloneUrl === state.cloneUrl;
    }
    if (state.kind === "idle" || snapshot.remoteProject) {
      return false;
    }
    const repoRoot =
      snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
    return state.repoRoot === repoRoot;
  }

  load() {
    const requestId = ++this.requestToken;
    const snapshot = this.read();
    const discovery = initialRepositoryState(snapshot);
    if (discovery.kind !== "checking") {
      return this.adoptResolvedRepository(discovery);
    }
    const client = snapshot.gateway?.client;
    if (snapshot.gateway?.phase !== "connected" || !client) {
      return this.adoptResolvedRepository({ kind: "idle" });
    }
    const { repoRoot } = discovery;
    this.repositoryValue = discovery;
    void client
      .request<WorktreesBranchesResult>("worktrees.branches", {
        repoRoot,
        includeRepositoryStatus: true,
      })
      .then((result) => {
        if (requestId !== this.requestToken) {
          return;
        }
        this.adoptResolvedRepository(
          result?.repositoryStatus === "git"
            ? {
                kind: "git",
                repoRoot,
                branches: result.branches,
                ...(result.defaultBranch ? { defaultBranch: result.defaultBranch } : {}),
                ...(result.headBranch ? { headBranch: result.headBranch } : {}),
              }
            : { kind: result?.repositoryStatus === "not_git" ? "direct" : "unavailable", repoRoot },
        );
      })
      .catch(() => {
        if (requestId !== this.requestToken) {
          return;
        }
        this.adoptResolvedRepository({ kind: "unavailable", repoRoot });
      });
  }

  private adoptResolvedRepository(state: ResolvedRepository) {
    // Worktree preferences can arrive while discovery is pending.
    this.repositoryValue = state;
    if (state.kind === "direct") {
      if (!this.read().remotePlacement) {
        const rejectedWorktree = this.worktreeValue || this.preferredWorktreeRestore;
        this.worktreeValue = false;
        if (rejectedWorktree) {
          this.callbacks.persistPreference({ worktree: false });
        }
      }
    } else if (this.preferredWorktreeRestore && !this.worktreeSelectedByUser && this.available()) {
      this.worktreeValue = true;
    }
    this.preferredWorktreeRestore = false;
    this.callbacks.requestUpdate();
  }
}
