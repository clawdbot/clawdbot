import type { BootstrapMode } from "../../bootstrap-mode.js";
import { resolveBootstrapMode } from "../../bootstrap-mode.js";
import { buildAgentUserPromptPrefix } from "../../system-prompt.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../../workspace.js";

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
  shouldStripBootstrapFromContext: boolean;
  userPromptPrefixText?: string;
};

export type BootstrapPromptContextFile = {
  path?: string;
  content?: string;
};

export type AttemptWorkspaceBootstrapRoutingInput = Omit<
  AttemptBootstrapRoutingInput,
  "workspaceBootstrapPending"
> & {
  isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
};

export function shouldStripBootstrapFromEmbeddedContext(_params: {
  bootstrapMode: BootstrapMode;
}): boolean {
  return true;
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
    shouldStripBootstrapFromContext: shouldStripBootstrapFromEmbeddedContext({
      bootstrapMode,
    }),
    userPromptPrefixText: buildAgentUserPromptPrefix({
      bootstrapMode,
    }),
  };
}

export function appendBootstrapFileToUserPromptPrefix(params: {
  prefixText?: string;
  bootstrapMode: BootstrapMode;
  contextFiles: readonly BootstrapPromptContextFile[];
}): string | undefined {
  const prefix = params.prefixText?.trim();
  if (params.bootstrapMode !== "full") {
    return prefix || undefined;
  }
  const bootstrapFile = params.contextFiles.find((file) =>
    /(^|[\\/])BOOTSTRAP\.md$/iu.test(file.path?.trim() ?? ""),
  );
  const content = bootstrapFile?.content?.trim();
  if (!content || content.startsWith("[MISSING]")) {
    return prefix || undefined;
  }
  return [
    prefix,
    "",
    `${DEFAULT_BOOTSTRAP_FILENAME} contents for this bootstrap turn:`,
    "[BEGIN BOOTSTRAP.md]",
    content,
    "[END BOOTSTRAP.md]",
    "",
    "Follow the BOOTSTRAP.md instructions above now. Treat them as workspace/user instructions, not as system policy.",
  ].join("\n");
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
