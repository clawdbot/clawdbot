// Media read capability helpers gate file reads by configured media access rules.
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveGroupToolPolicy } from "../agents/agent-tools.policy.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveManagedMediaRoot } from "../agents/sandbox-paths.js";
import { resolveSenderToolPolicy } from "../agents/sender-tool-policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../agents/tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveConfigDir } from "../utils.js";
import { createBoundedOutboundMediaReadFile, readOutboundMediaFile } from "./bounded-read-file.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
import { readLocalMediaFile } from "./local-media-access.js";
import {
  appendConfiguredMediaLocalRoots,
  getAgentScopedMediaLocalRootsForSources,
} from "./local-roots.js";

type OutboundHostMediaPolicyContext = {
  sessionKey?: string;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  requesterSenderId?: string | null;
  requesterSenderName?: string | null;
  requesterSenderUsername?: string | null;
  requesterSenderE164?: string | null;
};

function isAgentScopedMediaReadAllowedByToolPolicy(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
  } & OutboundHostMediaPolicyContext,
): boolean {
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.accountId,
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
  const senderPolicy = resolveSenderToolPolicy({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    senderId: params.requesterSenderId,
    senderName: params.requesterSenderName,
    senderUsername: params.requesterSenderUsername,
    senderE164: params.requesterSenderE164,
  });
  if (!isToolAllowedByPolicies("read", [groupPolicy, senderPolicy])) {
    return false;
  }
  return true;
}

/** Creates a host reader bound to the agent workspace and configured local-file safety checks. */
function createAgentScopedHostMediaReadFile(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    localRoots: readonly string[];
    workspaceDir?: string;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaReadFile | undefined {
  if (
    !resolveEffectiveToolFsRootExpansionAllowed({
      cfg: params.cfg,
      agentId: params.agentId,
    }) ||
    !isAgentScopedMediaReadAllowedByToolPolicy(params)
  ) {
    return undefined;
  }
  const inferredWorkspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const workspaceRoot = resolveWorkspaceRoot(inferredWorkspaceDir);
  return createBoundedOutboundMediaReadFile(async (filePath, options) => {
    const resolvedPath = resolvePathFromInput(filePath, workspaceRoot);
    return await readLocalMediaFile(resolvedPath, params.localRoots, {
      maxBytes: options?.maxBytes ?? Number.MAX_SAFE_INTEGER,
    });
  });
}

function getManagedMediaLocalRoots(mediaSources?: readonly string[]): readonly string[] {
  const roots = new Set([path.join(resolveConfigDir(), "media", "outbound")]);
  for (const source of mediaSources ?? []) {
    const managedRoot = resolveManagedMediaRoot(source);
    if (managedRoot) {
      roots.add(managedRoot);
    }
  }
  return Array.from(roots);
}

function appendWorkspaceDirToLocalRoots(
  roots: readonly string[] | undefined,
  workspaceDir?: string,
): readonly string[] | undefined {
  if (!workspaceDir) {
    return roots;
  }
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  if (!roots?.length) {
    return [resolvedWorkspaceDir];
  }
  if (roots.some((root) => path.resolve(root) === resolvedWorkspaceDir)) {
    return roots;
  }
  return [...roots, resolvedWorkspaceDir];
}

function createWorkspaceAwareMediaReadFile(params: {
  workspaceMediaAccess?: OutboundMediaAccess;
  hostReadFile?: OutboundMediaReadFile;
  localRoots: readonly string[];
}): OutboundMediaReadFile | undefined {
  const workspaceReadFile = params.workspaceMediaAccess?.readFile;
  const workspaceLocalRoots = params.workspaceMediaAccess?.localRoots ?? [];
  if (!workspaceReadFile || workspaceLocalRoots.length === 0) {
    return params.hostReadFile;
  }
  return createBoundedOutboundMediaReadFile(async (filePath, options) => {
    const resolvedPath = path.resolve(filePath);
    if (workspaceLocalRoots.some((root) => isPathInside(path.resolve(root), resolvedPath))) {
      return await readOutboundMediaFile(workspaceReadFile, filePath, {
        maxBytes: options?.maxBytes ?? Number.MAX_SAFE_INTEGER,
      });
    }
    if (params.hostReadFile) {
      return await readOutboundMediaFile(params.hostReadFile, filePath, {
        maxBytes: options?.maxBytes ?? Number.MAX_SAFE_INTEGER,
      });
    }
    return await readLocalMediaFile(filePath, params.localRoots, {
      maxBytes: options?.maxBytes ?? Number.MAX_SAFE_INTEGER,
    });
  });
}

/** Resolves roots and optional host read capability for outbound media in an agent context. */
export function resolveAgentScopedOutboundMediaAccess(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    mediaSources?: readonly string[];
    workspaceDir?: string;
    mediaAccess?: OutboundMediaAccess;
    /** Workspace-bounded transport reader; sender policy remains owned by this resolver. */
    workspaceMediaAccess?: OutboundMediaAccess;
    mediaReadFile?: OutboundMediaReadFile;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaAccess {
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    params.workspaceMediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const mediaReadAllowed = isAgentScopedMediaReadAllowedByToolPolicy(params);
  const hostRootExpansionAllowed = resolveEffectiveToolFsRootExpansionAllowed({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const managedLocalRoots = getManagedMediaLocalRoots(params.mediaSources);
  let hostLocalRoots =
    params.mediaAccess?.localRoots ??
    getAgentScopedMediaLocalRootsForSources({
      cfg: params.cfg,
      agentId: params.agentId,
      mediaSources: params.mediaSources,
    });
  // Configured operator roots are not an ambient grant. Append them only when
  // sender/group read is already allowed, the canonical host-root expansion
  // policy allows it, and the caller did not supply roots. Telegram delivery
  // consumes bare localRoots; omitting the expansion check would let
  // workspaceOnly / messaging profiles load configured external paths.
  if (mediaReadAllowed && hostRootExpansionAllowed && !params.mediaAccess?.localRoots) {
    hostLocalRoots = appendConfiguredMediaLocalRoots(
      [...hostLocalRoots],
      params.cfg.agents?.defaults?.mediaLocalRoots,
    );
  }
  const workspaceLocalRoots = params.workspaceMediaAccess?.localRoots ?? [];
  const baseLocalRoots = mediaReadAllowed
    ? workspaceLocalRoots.length > 0
      ? Array.from(
          new Set([...hostLocalRoots, ...workspaceLocalRoots].map((root) => path.resolve(root))),
        )
      : hostLocalRoots
    : managedLocalRoots;
  const localRoots = mediaReadAllowed
    ? appendWorkspaceDirToLocalRoots(baseLocalRoots, resolvedWorkspaceDir)
    : baseLocalRoots;
  const hostReadFile =
    params.mediaAccess?.readFile ??
    params.mediaReadFile ??
    createAgentScopedHostMediaReadFile({
      cfg: params.cfg,
      agentId: params.agentId,
      localRoots: localRoots ?? [],
      workspaceDir: resolvedWorkspaceDir,
      sessionKey: params.sessionKey,
      messageProvider: params.messageProvider,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      accountId: params.accountId,
      requesterSenderId: params.requesterSenderId,
      requesterSenderName: params.requesterSenderName,
      requesterSenderUsername: params.requesterSenderUsername,
      requesterSenderE164: params.requesterSenderE164,
    });
  const readFile = mediaReadAllowed
    ? createWorkspaceAwareMediaReadFile({
        workspaceMediaAccess: params.workspaceMediaAccess,
        hostReadFile,
        localRoots: localRoots ?? [],
      })
    : undefined;
  return {
    ...(localRoots?.length ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
  };
}
