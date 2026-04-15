import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveGroupToolPolicy } from "../agents/pi-tools.policy.js";
import { resolveEffectiveToolFsRootExpansionAllowed } from "../agents/tool-fs-policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import type { OpenClawConfig } from "../config/types.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
import {
  getAgentScopedMediaLocalRoots,
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

function isAgentScopedHostMediaReadAllowed(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
  } & OutboundHostMediaPolicyContext,
): boolean {
  if (
    !resolveEffectiveToolFsRootExpansionAllowed({
      cfg: params.cfg,
      agentId: params.agentId,
    })
  ) {
    return false;
  }
  const groupPolicy = resolveGroupToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    messageProvider: params.messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.accountId,
    senderId: normalizeOptionalString(params.requesterSenderId),
    senderName: normalizeOptionalString(params.requesterSenderName),
    senderUsername: normalizeOptionalString(params.requesterSenderUsername),
    senderE164: normalizeOptionalString(params.requesterSenderE164),
  });
  // Sender/group policy only applies when a concrete group override exists.
  if (groupPolicy && !isToolAllowedByPolicies("read", [groupPolicy])) {
    return false;
  }
  return true;
}

export function createAgentScopedHostMediaReadFile(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    workspaceDir?: string;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaReadFile | undefined {
  if (!isAgentScopedHostMediaReadAllowed(params)) {
    return undefined;
  }
  const inferredWorkspaceDir =
    params.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const workspaceRoot = resolveWorkspaceRoot(inferredWorkspaceDir);
  return async (filePath: string) => {
    const resolvedPath = resolvePathFromInput(filePath, workspaceRoot);
    return (await readLocalFileSafely({ filePath: resolvedPath })).buffer;
  };
}

export function resolveAgentScopedOutboundMediaAccess(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    mediaSources?: readonly string[];
    workspaceDir?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaReadFile?: OutboundMediaReadFile;
  } & OutboundHostMediaPolicyContext,
): OutboundMediaAccess {
  const hostMediaReadAllowed = isAgentScopedHostMediaReadAllowed(params);
  const localRoots =
    params.mediaAccess?.localRoots ??
    (hostMediaReadAllowed
      ? getAgentScopedMediaLocalRootsForSources({
          cfg: params.cfg,
          agentId: params.agentId,
          mediaSources: params.mediaSources,
        })
      : getAgentScopedMediaLocalRoots(params.cfg, params.agentId));
  const resolvedWorkspaceDir =
    params.workspaceDir ??
    params.mediaAccess?.workspaceDir ??
    (params.agentId ? resolveAgentWorkspaceDir(params.cfg, params.agentId) : undefined);
  const readFile =
    params.mediaAccess?.readFile ??
    params.mediaReadFile ??
    (hostMediaReadAllowed
      ? createAgentScopedHostMediaReadFile({
          cfg: params.cfg,
          agentId: params.agentId,
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
        })
      : undefined);
  return {
    ...(localRoots?.length ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
  };
}
