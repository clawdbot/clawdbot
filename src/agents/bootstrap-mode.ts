// Bootstrap mode resolver for deciding whether a run gets full, limited, or no
// workspace bootstrap files.
export type BootstrapMode = "full" | "limited" | "none";

/** Resolve the bootstrap mode for one agent run. */
export function resolveBootstrapMode(params: {
  bootstrapPending: boolean;
  runKind?: "default" | "heartbeat" | "cron";
  isInteractiveUserFacing: boolean;
  isPrimaryRun: boolean;
  isCanonicalWorkspace: boolean;
  hasBootstrapFileAccess: boolean;
}): BootstrapMode {
  if (!params.bootstrapPending) {
    return "none";
  }
  if (params.runKind === "heartbeat" || params.runKind === "cron") {
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
