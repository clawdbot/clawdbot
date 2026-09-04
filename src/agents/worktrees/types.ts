export type ManagedWorktreeOwnerKind = "manual" | "workboard" | "session";

export type ManagedWorktreeRunEndCleanupOutcome =
  | "removed-lossless"
  | "retained-busy"
  | "retained-dirty"
  | "retained-unpushed"
  | "retained-provisioned-drift"
  | "failed";

export type ManagedWorktreeRunEndCleanup = {
  outcome: ManagedWorktreeRunEndCleanupOutcome;
  at: number;
  reason?: string;
};

export type ProvisionedFileState = {
  path: string;
  mode: number | null;
  chunks: number;
};

export type ManagedWorktreeRecord = {
  id: string;
  name: string;
  repoFingerprint: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  ownerKind: ManagedWorktreeOwnerKind;
  ownerId?: string;
  snapshotRef?: string;
  createdAt: number;
  lastActiveAt: number;
  removedAt?: number;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
};

export type CreateManagedWorktreeParams = {
  repoRoot: string;
  name?: string;
  /** Derived default name; collisions receive a stable numeric suffix. */
  suggestedName?: string;
  baseRef?: string;
  ownerKind?: ManagedWorktreeOwnerKind;
  ownerId?: string;
  // Repository Git hooks are always disabled; only the setup script runs repo-local code.
  runSetupScript?: boolean;
  signal?: AbortSignal;
  onProgress?: (phase: "checkout" | "setup") => void;
  /** Synchronous caller-authority guard checked at allocation commit boundaries. */
  commitGuard?: () => void;
};

export type RemoveManagedWorktreeResult = {
  removed: boolean;
  snapshotRef?: string;
  snapshotError?: string;
};

export type ManagedWorktreeBranch = {
  name: string;
  kind: "local" | "remote";
};

type ManagedWorktreeRepositoryStatus = "git" | "not_git" | "unavailable";

export type ManagedWorktreeBranchesResult = {
  branches: ManagedWorktreeBranch[];
  defaultBranch?: string;
  headBranch?: string;
  repositoryStatus?: ManagedWorktreeRepositoryStatus;
};

export type ManagedWorktreeGcResult = {
  removed: string[];
  orphansDeleted: number;
  snapshotsPruned: number;
};
