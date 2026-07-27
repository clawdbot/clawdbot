/**
 * Subagent spawn ownership resolver.
 *
 * Resolves which session controls spawn state, thread binding, and completion delivery.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

type SubagentSpawnOwnership = {
  controllerSessionKey: string;
  threadBindingRequesterSessionKey: string;
  completionRequesterSessionKey: string;
  completionRequesterDisplayKey: string;
};

/** Normalizes requester/completion owner aliases into internal and display session keys. */
export function resolveSubagentSpawnOwnership(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  completionOwnerKey?: string;
}): SubagentSpawnOwnership {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const controllerSessionKey = params.agentSessionKey
    ? resolveInternalSessionKey({
        key: params.agentSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const completionOwnerKey = params.completionOwnerKey?.trim();
  const completionRequesterSessionKey = completionOwnerKey
    ? resolveInternalSessionKey({
        key: completionOwnerKey,
        alias,
        mainKey,
      })
    : controllerSessionKey;
  // Completion ownership can differ from control ownership when a parent proxies the spawn.
  const completionRequesterDisplayKey = resolveDisplaySessionKey({
    key: completionRequesterSessionKey,
    alias,
    mainKey,
  });

  return {
    controllerSessionKey,
    threadBindingRequesterSessionKey: controllerSessionKey,
    completionRequesterSessionKey,
    completionRequesterDisplayKey,
  };
}
