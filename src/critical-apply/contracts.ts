export const CRITICAL_APPLY_CONTRACT_VERSION = "critical_apply.transaction.v1" as const;

export const CRITICAL_APPLY_TERMINALS = ["PASS", "HOLD", "FAIL", "ABORT"] as const;
export type CriticalApplyTerminal = (typeof CRITICAL_APPLY_TERMINALS)[number];

export type CriticalApplySourceAuthority = Readonly<{
  repo: string;
  commit: string;
  tree: string;
  packageName?: string;
  packageVersion?: string;
}>;

export type CriticalApplyTargetAuthority = Readonly<{
  targetRoot: string;
  packageRoot?: string;
  binPath?: string;
  allowedRootSha256?: string;
}>;

export type CriticalApplyRestorePoint = Readonly<{
  path: string;
  sha256: string;
  createdAt: string;
  maxAgeSeconds: number;
}>;

export type CriticalApplyWatcher = Readonly<{
  id: string;
  kind: "independent-check" | "durable-observer";
  expectedAt?: string;
  receiptPath?: string;
}>;

export type CriticalApplySideEffectCounters = Readonly<{
  sourceEdits: number;
  gitCommitPushPrMerge: number;
  packageInstallApplyBuild: number;
  gatewayRestartConfigCronMutation: number;
  systemctlActions: number;
  providerOrLiveSmokeCalls: number;
  productionMutations: number;
}>;

export type CriticalApplyTransaction = Readonly<{
  schema: typeof CRITICAL_APPLY_CONTRACT_VERSION;
  id: string;
  disabledByDefault: true;
  terminal: CriticalApplyTerminal;
  sourceAuthority: CriticalApplySourceAuthority;
  targetAuthority: CriticalApplyTargetAuthority;
  restorePoint: CriticalApplyRestorePoint;
  rollbackPlanPath: string;
  maintenanceLockPath: string;
  precheckReceiptPath: string;
  postcheckReceiptPath: string;
  watcher: CriticalApplyWatcher;
  sideEffects: CriticalApplySideEffectCounters;
}>;

export const ZERO_CRITICAL_APPLY_SIDE_EFFECTS: CriticalApplySideEffectCounters = Object.freeze({
  sourceEdits: 0,
  gitCommitPushPrMerge: 0,
  packageInstallApplyBuild: 0,
  gatewayRestartConfigCronMutation: 0,
  systemctlActions: 0,
  providerOrLiveSmokeCalls: 0,
  productionMutations: 0,
});
