import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

export type SubagentSpawnOwnership = {
  controllerSessionKey: string;
  threadBindingRequesterSessionKey: string;
  completionRequesterSessionKey: string;
  completionRequesterDisplayKey: string;
};

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
