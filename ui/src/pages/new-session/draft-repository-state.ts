import type {
  ProjectRecord,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftRepositoryState } from "./discovery.ts";
import type { NewSessionPreference, NewSessionPreferencePatch } from "./preferences.ts";

type DraftRepositorySnapshot = Readonly<{
  execNode: string;
  cloudProfileId: string;
  selectedProject: ProjectRecord | undefined;
  remoteProjectSelected: boolean;
  folder: string;
  workspace: string;
  workspaceGit: boolean;
  gateway: ApplicationContext["gateway"]["snapshot"] | undefined;
}>;

type DraftRepositoryCallbacks = {
  requestUpdate: () => void;
  persistPreference: (patch: NewSessionPreferencePatch) => void;
};

type DraftBaseRefSelection =
  | { kind: "automatic" }
  | { kind: "explicit"; ref: string; repoRoot: string };

export class DraftRepositoryController {
  private worktreeValue = false;
  private worktreeNameValue = "";
  private baseRefSelection: DraftBaseRefSelection = { kind: "automatic" };
  private repositoryValue: DraftRepositoryState = { kind: "idle" };
  private requestToken = 0;
  private baseRefEditGeneration = 0;
  private preferredWorktreeRestore = false;
  private preferredBaseRefRestore: DraftBaseRefSelection = { kind: "automatic" };
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
    return this.baseRefSelection.kind === "explicit" ? this.baseRefSelection.ref : "";
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
    this.preferredBaseRefRestore = preference?.baseRef
      ? { kind: "explicit", ref: preference.baseRef.ref, repoRoot: preference.baseRef.repoRoot }
      : { kind: "automatic" };
    this.baseRefSelection = { kind: "automatic" };
    this.worktreeNameValue = preference?.worktreeName ?? "";
    this.worktreeSelectedByUser = false;
    this.detailsSelectedByUser = false;
  }

  reset() {
    this.requestToken += 1;
    this.baseRefEditGeneration += 1;
    this.worktreeValue = false;
    this.worktreeNameValue = "";
    this.baseRefSelection = { kind: "automatic" };
    this.repositoryValue = { kind: "idle" };
    this.preferredWorktreeRestore = false;
    this.preferredBaseRefRestore = { kind: "automatic" };
    this.worktreeSelectedByUser = false;
    this.detailsSelectedByUser = false;
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
    if (this.read().cloudProfileId) {
      return;
    }
    this.worktreeValue = !this.worktreeValue;
    this.preferredWorktreeRestore = false;
    this.worktreeSelectedByUser = true;
    this.callbacks.persistPreference({
      folder: this.read().folder.trim() || this.read().workspace,
      worktree: this.worktreeValue,
    });
    if (this.worktreeValue && this.repositoryValue.kind !== "git") {
      this.load();
    }
    this.callbacks.requestUpdate();
  }

  setBaseRef(baseRef: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.baseRefEditGeneration += 1;
    this.baseRefSelection = baseRef
      ? { kind: "explicit", ref: baseRef, repoRoot: this.selectedRepoRoot() }
      : { kind: "automatic" };
    this.preferredBaseRefRestore = { kind: "automatic" };
    this.detailsSelectedByUser = true;
    this.callbacks.persistPreference({
      baseRef:
        this.baseRefSelection.kind === "explicit"
          ? { ref: this.baseRefSelection.ref, repoRoot: this.baseRefSelection.repoRoot }
          : null,
    });
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
    if (snapshot.execNode) {
      return false;
    }
    if (snapshot.selectedProject?.repoRoot) {
      return true;
    }
    if (this.repositoryValue.kind === "git") {
      return true;
    }
    return (
      this.repositoryValue.kind === "unavailable" &&
      this.repositoryValue.repoRoot === snapshot.workspace &&
      snapshot.workspaceGit
    );
  }

  matchesCurrentRepo(): boolean {
    if (this.read().execNode || this.repositoryValue.kind === "idle") {
      return false;
    }
    return this.repositoryValue.repoRoot === this.selectedRepoRoot();
  }

  load() {
    const requestId = ++this.requestToken;
    const restoreWorktree = this.preferredWorktreeRestore && !this.worktreeSelectedByUser;
    const restoreBaseRef = this.preferredBaseRefRestore;
    const baseRefEditGeneration = this.baseRefEditGeneration;
    const snapshot = this.read();
    this.repositoryValue = { kind: "idle" };
    if (
      snapshot.remoteProjectSelected ||
      snapshot.execNode ||
      (snapshot.selectedProject && !snapshot.selectedProject.repoRoot)
    ) {
      this.baseRefSelection = { kind: "automatic" };
      this.preferredWorktreeRestore = false;
      return;
    }
    const repoRoot = this.selectedRepoRoot();
    if (this.baseRefSelection.kind === "explicit" && this.baseRefSelection.repoRoot !== repoRoot) {
      this.baseRefSelection = { kind: "automatic" };
    }
    const usesWorkspace = !snapshot.selectedProject && repoRoot === snapshot.workspace;
    if (!repoRoot) {
      this.baseRefSelection = { kind: "automatic" };
      this.preferredWorktreeRestore = false;
      return;
    }
    if (usesWorkspace && !snapshot.workspaceGit) {
      this.baseRefSelection = { kind: "automatic" };
      this.repositoryValue = { kind: "direct", repoRoot };
      const rejectedWorktree = !snapshot.cloudProfileId && (this.worktreeValue || restoreWorktree);
      if (!snapshot.cloudProfileId) {
        this.worktreeValue = false;
      }
      this.preferredWorktreeRestore = false;
      if (rejectedWorktree) {
        this.callbacks.persistPreference({ worktree: false });
      }
      return;
    }
    const client = snapshot.gateway?.client;
    if (snapshot.gateway?.phase !== "connected" || !client) {
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
        if (requestId !== this.requestToken) {
          return;
        }
        if (result?.repositoryStatus !== "git") {
          this.repositoryValue = {
            kind: result?.repositoryStatus === "not_git" ? "direct" : "unavailable",
            repoRoot,
          };
          if (result?.repositoryStatus === "not_git") {
            const rejectedWorktree =
              !this.read().cloudProfileId && (this.worktreeValue || restoreWorktree);
            if (!this.read().cloudProfileId) {
              this.worktreeValue = false;
            }
            if (rejectedWorktree) {
              this.callbacks.persistPreference({ worktree: false });
            }
          } else if (restoreWorktree && !this.worktreeSelectedByUser && this.available()) {
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
        if (restoreWorktree && !this.worktreeSelectedByUser && !this.read().execNode) {
          this.worktreeValue = true;
        }
        this.preferredWorktreeRestore = false;
        if (
          restoreBaseRef.kind === "explicit" &&
          restoreBaseRef.repoRoot === repoRoot &&
          baseRefEditGeneration === this.baseRefEditGeneration
        ) {
          this.baseRefSelection = restoreBaseRef;
          this.preferredBaseRefRestore = { kind: "automatic" };
        }
        this.callbacks.requestUpdate();
      })
      .catch(() => {
        if (requestId !== this.requestToken) {
          return;
        }
        this.repositoryValue = { kind: "unavailable", repoRoot };
        if (restoreWorktree && !this.worktreeSelectedByUser && this.available()) {
          this.worktreeValue = true;
        }
        this.preferredWorktreeRestore = false;
        this.callbacks.requestUpdate();
      });
  }

  private selectedRepoRoot(): string {
    const snapshot = this.read();
    return snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
  }
}
