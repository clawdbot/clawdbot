// Matrix plugin module implements group mentions behavior.
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
} from "openclaw/plugin-sdk/channel-policy";
import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { buildMatrixRoomScopeTree, resolveMatrixRoomScopePath } from "./matrix/monitor/rooms.js";
import { normalizeMatrixResolvableTarget } from "./matrix/target-ids.js";
import type { ChannelGroupContext } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

function resolveMatrixGroupScope(params: ChannelGroupContext) {
  const matrixConfig = resolveMatrixAccountConfig({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  const tree = buildMatrixRoomScopeTree(matrixConfig.groups ?? matrixConfig.rooms);
  const roomId = normalizeMatrixResolvableTarget(params.groupId?.trim() ?? "");
  const groupChannel = normalizeMatrixResolvableTarget(params.groupChannel?.trim() ?? "");
  return {
    tree,
    path: resolveMatrixRoomScopePath({ tree, roomId, aliases: groupChannel ? [groupChannel] : [] }),
  };
}

export function resolveMatrixGroupRequireMention(params: ChannelGroupContext): boolean {
  return resolveScopeRequireMention(resolveMatrixGroupScope(params));
}

export function resolveMatrixGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveScopeToolsPolicy(resolveMatrixGroupScope(params));
}
