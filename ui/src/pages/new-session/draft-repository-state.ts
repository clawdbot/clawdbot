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
    if (!this.worktreeSelectedByUser) {
      this.worktreeValue = false;
      this.preferredWorktreeRestore = preference?.worktree === true;
    }
    if (!this.detailsSelectedByUser) {
      this.preferredBaseRefRestore = preference?.baseRef ?? "";
      this.worktreeNameValue = preference?.worktreeName ?? "";
    }
    if (!this.matchesCurrentRepo()) {
      // Retire the old folder's RPC before it can consume the new preference.
      this.invalidate();
    } else if (this.repositoryValue.kind !== "checking") {
      this.adoptResolvedRepository(
        this.repositoryValue,
        this.detailsSelectedByUser ? undefined : this.baseRefEditGeneration,
      );
    }
  }

  reset() {
    this.invalidate();
    this.baseRefEditGeneration += 1;
    this.worktreeValue = false;
    this.worktreeNameValue = "";
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
    this.selectWorktree(!this.worktreeValue, false);
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
    const baseRefEditGeneration = this.baseRefEditGeneration;
    const snapshot = this.read();
    this.baseRefValue = "";
    const discovery = initialRepositoryState(snapshot);
    if (discovery.kind !== "checking") {
      return this.adoptResolvedRepository(discovery, baseRefEditGeneration);
    }
    const client = snapshot.gateway?.client;
    if (snapshot.gateway?.phase !== "connected" || !client) {
      return this.adoptResolvedRepository({ kind: "idle" }, baseRefEditGeneration);
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
          baseRefEditGeneration,
        );
      })
      .catch(() => {
        if (requestId !== this.requestToken) {
          return;
        }
        this.adoptResolvedRepository({ kind: "unavailable", repoRoot }, baseRefEditGeneration);
      });
  }

  private adoptResolvedRepository(state: ResolvedRepository, baseRefEditGeneration?: number) {
    // Discovery owns restore/rejection for both immediate and RPC results;
    // Read the current preference: group defaults and user edits can arrive
    // while an RPC is pending.
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
    if (state.kind === "git" && baseRefEditGeneration === this.baseRefEditGeneration) {
      this.baseRefValue =
        this.preferredBaseRefRestore || state.defaultBranch || state.headBranch || "";
      this.preferredBaseRefRestore = "";
    }
    this.callbacks.requestUpdate();
  }
}
