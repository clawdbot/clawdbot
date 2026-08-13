import type {
  ProjectRecord,
  WorktreesBranchesResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { DraftRepositoryState } from "./discovery.ts";
import type { NewSessionPreference } from "./preferences.ts";

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
  persistPreference: (patch: NewSessionPreference) => void;
};

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

  adoptPreference(preference: NewSessionPreference | null) {
    this.preferredWorktreeRestore = preference?.worktree === true;
    this.preferredBaseRefRestore = preference?.baseRef ?? "";
    this.worktreeNameValue = preference?.worktreeName ?? "";
    this.worktreeSelectedByUser = false;
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
    this.baseRefValue = baseRef;
    this.preferredBaseRefRestore = "";
    this.callbacks.persistPreference({ baseRef });
    this.callbacks.requestUpdate();
  }

  setWorktreeName(worktreeName: string, submitting: boolean) {
    if (submitting) {
      return;
    }
    this.worktreeNameValue = worktreeName;
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
    const snapshot = this.read();
    const repoRoot =
      snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
    return this.repositoryValue.repoRoot === repoRoot;
  }

  load() {
    const requestId = ++this.requestToken;
    const restoreWorktree = this.preferredWorktreeRestore && !this.worktreeSelectedByUser;
    const restoreBaseRef = this.preferredBaseRefRestore;
    const baseRefEditGeneration = this.baseRefEditGeneration;
    const snapshot = this.read();
    this.repositoryValue = { kind: "idle" };
    this.baseRefValue = "";
    if (
      snapshot.remoteProjectSelected ||
      snapshot.execNode ||
      (snapshot.selectedProject && !snapshot.selectedProject.repoRoot)
    ) {
      this.preferredWorktreeRestore = false;
      return;
    }
    const repoRoot =
      snapshot.selectedProject?.repoRoot ?? (snapshot.folder.trim() || snapshot.workspace);
    const usesWorkspace = !snapshot.selectedProject && repoRoot === snapshot.workspace;
    if (!repoRoot) {
      this.preferredWorktreeRestore = false;
      return;
    }
    if (usesWorkspace && !snapshot.workspaceGit) {
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
        if (baseRefEditGeneration === this.baseRefEditGeneration) {
          this.baseRefValue = restoreBaseRef || result.defaultBranch || result.headBranch || "";
          if (restoreBaseRef) {
            this.preferredBaseRefRestore = "";
          }
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
}
