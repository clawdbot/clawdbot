// Bootstrap mode resolver for deciding whether a run gets full, limited, or no
// workspace bootstrap files.
export type BootstrapMode = "full" | "limited" | "none";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron" | "commitment-only";

export function isHeartbeatLifecycleRunKind(runKind: BootstrapContextRunKind | undefined): boolean {
  return runKind === "heartbeat" || runKind === "commitment-only";
}

/** Resolve the bootstrap mode for one agent run. */
export function resolveBootstrapMode(params: {
  bootstrapPending: boolean;
  runKind?: BootstrapContextRunKind;
  isInteractiveUserFacing: boolean;
  isPrimaryRun: boolean;
  isCanonicalWorkspace: boolean;
  hasBootstrapFileAccess: boolean;
}): BootstrapMode {
  if (!params.bootstrapPending) {
    return "none";
  }
  if (isHeartbeatLifecycleRunKind(params.runKind) || params.runKind === "cron") {
    // Background maintenance turns should not consume or mutate bootstrap state.
    return "none";
  }
  if (!params.isPrimaryRun || !params.isInteractiveUserFacing) {
    return "none";
  }
  if (!params.hasBootstrapFileAccess) {
    return "limited";
  }
  return params.isCanonicalWorkspace ? "full" : "limited";
}
