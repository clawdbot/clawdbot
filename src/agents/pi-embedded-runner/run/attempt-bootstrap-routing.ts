import type { BootstrapMode } from "../../bootstrap-mode.js";
import { resolveBootstrapMode } from "../../bootstrap-mode.js";

export type AttemptBootstrapRoutingInput = {
  workspaceBootstrapPending: boolean;
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  trigger?: string;
  sessionKey?: string;
  isPrimaryRun: boolean;
  isCanonicalWorkspace?: boolean;
  effectiveWorkspace: string;
  resolvedWorkspace: string;
  hasBootstrapFileAccess: boolean;
};

export type AttemptBootstrapRouting = {
  bootstrapMode: BootstrapMode;
  includeBootstrapInSystemContext: boolean;
  includeBootstrapInRuntimeContext: boolean;
};

export type AttemptWorkspaceBootstrapRoutingInput = Omit<
  AttemptBootstrapRoutingInput,
  "workspaceBootstrapPending"
> & {
  isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
};

export function resolveBootstrapContextTargets(params: {
  bootstrapMode: BootstrapMode;
}): Pick<
  AttemptBootstrapRouting,
  "includeBootstrapInSystemContext" | "includeBootstrapInRuntimeContext"
> {
  return {
    includeBootstrapInSystemContext: params.bootstrapMode === "full",
    includeBootstrapInRuntimeContext: false,
  };
}

function resolveAttemptBootstrapRouting(
  params: AttemptBootstrapRoutingInput,
): AttemptBootstrapRouting {
  const bootstrapMode = resolveBootstrapMode({
    bootstrapPending: params.workspaceBootstrapPending,
    runKind: params.bootstrapContextRunKind ?? "default",
    isInteractiveUserFacing: params.trigger === "user" || params.trigger === "manual",
    isPrimaryRun: params.isPrimaryRun,
    isCanonicalWorkspace:
      (params.isCanonicalWorkspace ?? true) &&
      params.effectiveWorkspace === params.resolvedWorkspace,
    hasBootstrapFileAccess: params.hasBootstrapFileAccess,
  });

  return {
    bootstrapMode,
    ...resolveBootstrapContextTargets({ bootstrapMode }),
  };
}

export async function resolveAttemptWorkspaceBootstrapRouting(
  params: AttemptWorkspaceBootstrapRoutingInput,
): Promise<AttemptBootstrapRouting> {
  const workspaceBootstrapPending = await params.isWorkspaceBootstrapPending(
    params.resolvedWorkspace,
  );
  return resolveAttemptBootstrapRouting({
    ...params,
    workspaceBootstrapPending,
  });
}
