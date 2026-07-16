export type ManagedWorktreeOwnerKind = "manual" | "workboard" | "session";

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
};

export type CreateManagedWorktreeParams = {
  repoRoot: string;
  name?: string;
  baseRef?: string;
  ownerKind?: ManagedWorktreeOwnerKind;
  ownerId?: string;
  // Repository checkout hooks and .openclaw/worktree-setup.sh execute repo-local code, so
  // callers reachable from less-privileged surfaces opt out; admin paths keep them on.
  runSetupScript?: boolean;
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

export type ManagedWorktreeBranchesResult = {
  branches: ManagedWorktreeBranch[];
  defaultBranch?: string;
  headBranch?: string;
};

export type ManagedWorktreeGcResult = {
  removed: string[];
  orphansDeleted: number;
  snapshotsPruned: number;
};
