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

type RepositoryRestore = { worktree: boolean; baseRef: string; baseRefEditGeneration: number };
type ResolvedRepository = Exclude<DraftRepositoryState, { kind: "checking" }>;

function planRepositoryDiscovery(
  snapshot: DraftRepositorySnapshot,
):
  | { plan: "none" }
  | { plan: "resolved"; state: ResolvedRepository }
  | { plan: "check"; repoRoot: string } {
  if (snapshot.remoteProject) {
    return {
      plan: "resolved",
      state: { kind: "pending-clone", cloneUrl: snapshot.remoteProject.cloneUrl },
    };
  }
  const repoRoot =
    snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
  if (!repoRoot || (snapshot.selectedProject && !snapshot.selectedProject.repoRoot)) {
    return { plan: "none" };
  }
  return !snapshot.selectedProject && repoRoot === snapshot.workspace && !snapshot.workspaceGit
    ? { plan: "resolved", state: { kind: "direct", repoRoot } }
    : { plan: "check", repoRoot };
}

export class DraftRepositoryController {
  private worktreeValue = false;
  private worktreeNameValue = "";
  private baseRefValue = "";
  private repositoryValue: DraftRepositoryState = { kind: "idle" };
  private requestToken = 0;
  private baseRefEditGeneration = 0;
  private preferredWorktreeRestore = false;
  private preferredBaseRefRestore = "";
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
    return this.baseRefValue;
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
    this.preferredWorktreeRestore = preference?.worktree === true;
    this.preferredBaseRefRestore = preference?.baseRef ?? "";
    this.worktreeNameValue = preference?.worktreeName ?? "";
    this.worktreeSelectedByUser = false;
    this.detailsSelectedByUser = false;
  }

  reset() {
    this.requestToken += 1;
    this.baseRefEditGeneration += 1;
    this.worktreeValue = false;
    this.worktreeNameValue = "";
    this.baseRefValue = "";
    this.repositoryValue = { kind: "idle" };
    this.preferredWorktreeRestore = false;
    this.preferredBaseRefRestore = "";
    this.worktreeSelectedByUser = false;
    this.detailsSelectedByUser = false;
  }

  invalidate() {
    this.requestToken += 1;
    this.repositoryValue = { kind: "idle" };
    this.baseRefValue = "";
  }

  selectWorktree(value: boolean, clearName = true) {
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    this.worktreeValue = value;
    if (clearName) {
      this.worktreeNameValue = "";
    }
  }

  forceWorktree(value: boolean) {
    this.worktreeValue = value;
  }

  rejectPreferredWorktree() {
    this.preferredWorktreeRestore = false;
    this.worktreeValue = false;
  }

  toggle() {
    if (this.read().remotePlacement) {
      return;
    }
    this.worktreeValue = !this.worktreeValue;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    this.callbacks.persistPreference({
      folder: this.read().folder.trim() || this.read().workspace,
      worktree: this.worktreeValue,
    });
    if (
      this.worktreeValue &&
      this.repositoryValue.kind !== "git" &&
      this.repositoryValue.kind !== "pending-clone"
    ) {
      this.load();
    }
    this.callbacks.requestUpdate();
  }

  setBaseRef(baseRef: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.baseRefEditGeneration += 1;
    this.baseRefValue = baseRef;
    this.preferredBaseRefRestore = "";
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
    const snapshot = this.read();
    if (snapshot.selectedProject?.repoRoot) {
      return true;
    }
    const state = this.repositoryValue;
    return (
      state.kind === "git" ||
      state.kind === "pending-clone" ||
      (state.kind === "unavailable" &&
        state.repoRoot === snapshot.workspace &&
        snapshot.workspaceGit)
    );
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
    const restore = {
      worktree: this.preferredWorktreeRestore && !this.worktreeSelectedByUser,
      baseRef: this.preferredBaseRefRestore,
      baseRefEditGeneration: this.baseRefEditGeneration,
    };
    const snapshot = this.read();
    this.repositoryValue = { kind: "idle" };
    this.baseRefValue = "";
    const discovery = planRepositoryDiscovery(snapshot);
    if (discovery.plan === "resolved") {
      return this.adoptResolvedRepository(discovery.state, restore);
    }
    const client = snapshot.gateway?.client;
    if (discovery.plan === "none" || snapshot.gateway?.phase !== "connected" || !client) {
      return this.adoptResolvedRepository({ kind: "idle" }, restore);
    }
    const { repoRoot } = discovery;
    this.repositoryValue = { kind: "checking", repoRoot };
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
          restore,
        );
      })
      .catch(() => {
        if (requestId !== this.requestToken) {
          return;
        }
        this.adoptResolvedRepository({ kind: "unavailable", repoRoot }, restore);
      });
  }

  private adoptResolvedRepository(state: ResolvedRepository, restore: RepositoryRestore) {
    // Discovery owns restore/rejection for both immediate and RPC results;
    // placement and user edits may have changed while an RPC was pending.
    this.repositoryValue = state;
    if (state.kind === "direct") {
      if (!this.read().remotePlacement) {
        const rejectedWorktree = this.worktreeValue || restore.worktree;
        this.worktreeValue = false;
        if (rejectedWorktree) {
          this.callbacks.persistPreference({ worktree: false });
        }
      }
    } else if (
      state.kind !== "idle" &&
      restore.worktree &&
      !this.worktreeSelectedByUser &&
      this.available()
    ) {
      this.worktreeValue = true;
    }
    this.preferredWorktreeRestore = false;
    if (state.kind === "git" && restore.baseRefEditGeneration === this.baseRefEditGeneration) {
      this.baseRefValue = restore.baseRef || state.defaultBranch || state.headBranch || "";
      if (restore.baseRef) {
        this.preferredBaseRefRestore = "";
      }
    }
    this.callbacks.requestUpdate();
  }
}
