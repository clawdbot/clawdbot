/**
 * Resolves bootstrap context targets for one embedded-agent attempt.
 */
import type { BootstrapMode } from "../../bootstrap-mode.js";
import { resolveBootstrapMode } from "../../bootstrap-mode.js";
import { DEFAULT_BOOTSTRAP_FILENAME, type WorkspaceBootstrapFile } from "../../workspace.js";

/** Inputs that decide whether this attempt should inject workspace bootstrap context. */
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

/** Bootstrap placement decision consumed by system/runtime context assembly. */
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
  bootstrapFiles?: readonly WorkspaceBootstrapFile[];
};

/**
 * Maps a resolved bootstrap mode to concrete prompt destinations. Today only
 * full bootstrap enters system context; limited/none intentionally avoid
 * runtime-context injection until that path has a separate contract.
 */
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

export function hasBootstrapFileContent(files?: readonly WorkspaceBootstrapFile[]): boolean {
  return (
    files?.some(
      (file) =>
        file.name === DEFAULT_BOOTSTRAP_FILENAME &&
        !file.missing &&
        typeof file.content === "string" &&
        file.content.trim().length > 0,
    ) ?? false
  );
}

/**
 * Resolves workspace bootstrap routing after checking pending state and
 * hook-provided bootstrap files. Hook content counts as both pending bootstrap
 * and file access so generated bootstrap text follows the same route as disk
 * bootstrap content.
 */
export async function resolveAttemptWorkspaceBootstrapRouting(
  params: AttemptWorkspaceBootstrapRoutingInput,
): Promise<AttemptBootstrapRouting> {
  const workspaceBootstrapPending = await params.isWorkspaceBootstrapPending(
    params.resolvedWorkspace,
  );
  const hasHookBootstrapContent = hasBootstrapFileContent(params.bootstrapFiles);
  return resolveAttemptBootstrapRouting({
    ...params,
    workspaceBootstrapPending: workspaceBootstrapPending || hasHookBootstrapContent,
    hasBootstrapFileAccess: params.hasBootstrapFileAccess || hasHookBootstrapContent,
  });
}
