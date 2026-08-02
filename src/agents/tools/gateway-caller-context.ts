// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import { copyPluginToolMeta } from "../../plugins/tools.js";
import { copyBeforeToolCallHookMarker } from "../before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "../channel-tools.js";
import { copyToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";

export type GatewayToolCallerIdentity = {
  agentId: string;
  sessionKey: string;
  // Trusted run context, carried separately from model-authored tool arguments.
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  messageActionTurnCapability?: string;
  messageActionTurnCapabilityConflict?: boolean;
};

type GatewayToolCallerSource = {
  agentSessionKey?: string;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
  messageActionTurnCapability?: string;
};

export type GatewayToolCallerMessageActionCapabilityResolution =
  | { ok: true; token?: string }
  | { ok: false; reason: "token_conflict" };

type GatewayToolCallerContext = GatewayToolCallerIdentity & {
  messageActionTurnCapabilityBoundary?: boolean;
};

const gatewayToolCallerStorage = new AsyncLocalStorage<GatewayToolCallerContext | undefined>();

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

export function resolveGatewayToolCallerMessageActionCapability(
  explicitToken: string | undefined,
): GatewayToolCallerMessageActionCapabilityResolution {
  const identity = gatewayToolCallerStorage.getStore();
  if (identity?.messageActionTurnCapabilityConflict) {
    return { ok: false, reason: "token_conflict" };
  }
  const explicit = explicitToken?.trim();
  const active = identity?.messageActionTurnCapability?.trim();
  if (explicit && active && explicit !== active) {
    return { ok: false, reason: "token_conflict" };
  }
  return { ok: true, token: explicit || active };
}

function normalizeGatewayToolCallerIdentity(
  identity: GatewayToolCallerIdentity,
): GatewayToolCallerIdentity | undefined {
  const agentId = identity.agentId?.trim();
  const sessionKey = identity.sessionKey?.trim();
  if (!agentId || !sessionKey) {
    return undefined;
  }
  return {
    agentId,
    sessionKey,
    ...(identity.turnSourceChannel?.trim()
      ? { turnSourceChannel: identity.turnSourceChannel.trim() }
      : {}),
    ...(identity.turnSourceTo?.trim() ? { turnSourceTo: identity.turnSourceTo.trim() } : {}),
    ...(identity.turnSourceAccountId?.trim()
      ? { turnSourceAccountId: identity.turnSourceAccountId.trim() }
      : {}),
    ...(identity.turnSourceThreadId !== undefined
      ? { turnSourceThreadId: identity.turnSourceThreadId }
      : {}),
    ...(identity.messageActionTurnCapability?.trim()
      ? { messageActionTurnCapability: identity.messageActionTurnCapability.trim() }
      : {}),
    ...(identity.messageActionTurnCapabilityConflict
      ? { messageActionTurnCapabilityConflict: true }
      : {}),
  };
}

/** Establish a fresh attempt boundary, explicitly clearing inherited authority when absent. */
export async function runWithGatewayToolCallerRequestContext<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const normalized = identity ? normalizeGatewayToolCallerIdentity(identity) : undefined;
  return await gatewayToolCallerStorage.run(
    normalized ? { ...normalized, messageActionTurnCapabilityBoundary: true } : undefined,
    run,
  );
}

export async function withGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  const normalized = identity ? normalizeGatewayToolCallerIdentity(identity) : undefined;
  if (!normalized) {
    return await gatewayToolCallerStorage.run(undefined, run);
  }
  const active = gatewayToolCallerStorage.getStore();
  const sameIdentity =
    active?.agentId === normalized.agentId && active.sessionKey === normalized.sessionKey;
  const boundaryIdentityConflict =
    active?.messageActionTurnCapabilityBoundary === true && !sameIdentity;
  const explicit = normalized.messageActionTurnCapability;
  const inherited = sameIdentity ? active?.messageActionTurnCapability : undefined;
  const conflict =
    normalized.messageActionTurnCapabilityConflict === true ||
    boundaryIdentityConflict ||
    (sameIdentity && active?.messageActionTurnCapabilityConflict === true) ||
    (sameIdentity &&
      active?.messageActionTurnCapabilityBoundary === true &&
      !inherited &&
      Boolean(explicit)) ||
    Boolean(explicit && inherited && explicit !== inherited);
  const contextIdentity = boundaryIdentityConflict ? active : normalized;
  const {
    messageActionTurnCapability: _discardedCapability,
    messageActionTurnCapabilityConflict: _discardedConflict,
    ...contextWithoutAuthority
  } = contextIdentity;
  return await gatewayToolCallerStorage.run(
    {
      ...contextWithoutAuthority,
      ...(!conflict && (explicit || inherited)
        ? { messageActionTurnCapability: explicit || inherited }
        : {}),
      ...(conflict ? { messageActionTurnCapabilityConflict: true } : {}),
      ...((sameIdentity || boundaryIdentityConflict) && active?.messageActionTurnCapabilityBoundary
        ? { messageActionTurnCapabilityBoundary: true }
        : {}),
    },
    run,
  );
}

export function wrapToolWithGatewayCallerIdentity(
  tool: AnyAgentTool,
  identity: GatewayToolCallerIdentity | undefined,
): AnyAgentTool {
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim() || !tool.execute) {
    return tool;
  }
  const wrapped: AnyAgentTool = {
    ...tool,
    execute: async (...args) =>
      await withGatewayToolCallerIdentity(identity, async () => await tool.execute?.(...args)),
  };
  copyPluginToolMeta(tool, wrapped);
  copyChannelAgentToolMeta(tool as never, wrapped as never);
  copyBeforeToolCallHookMarker(tool, wrapped);
  copyToolTerminalPresentation(tool, wrapped);
  return wrapped;
}

export function createGatewayToolCallerWrapper(
  agentId: string | undefined,
  source: GatewayToolCallerSource | undefined,
): (tool: AnyAgentTool) => AnyAgentTool {
  const identity =
    agentId && source?.agentSessionKey?.trim()
      ? {
          agentId,
          sessionKey: source.agentSessionKey.trim(),
          turnSourceChannel: source.agentChannel,
          turnSourceTo: source.currentMessagingTarget ?? source.currentChannelId ?? source.agentTo,
          turnSourceAccountId: source.agentAccountId,
          turnSourceThreadId: source.currentThreadTs ?? source.agentThreadId,
          messageActionTurnCapability: source.messageActionTurnCapability,
        }
      : undefined;
  return (tool) => wrapToolWithGatewayCallerIdentity(tool, identity);
}
