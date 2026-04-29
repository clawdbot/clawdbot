import { mergeDmAllowFromSources } from "openclaw/plugin-sdk/allow-from";
import { normalizeMatrixAllowList, resolveMatrixAllowListMatch } from "./allowlist.js";

type MatrixCommandAuthorizer = {
  configured: boolean;
  allowed: boolean;
};

type MatrixMonitorAllowListMatch = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: "wildcard" | "id" | "prefixed-id" | "prefixed-user";
};

export type MatrixMonitorAccessState = {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  effectiveRoomUsers: string[];
  groupAllowConfigured: boolean;
  directAllowMatch: MatrixMonitorAllowListMatch;
  roomUserMatch: MatrixMonitorAllowListMatch | null;
  groupAllowMatch: MatrixMonitorAllowListMatch | null;
  commandAuthorizers: [MatrixCommandAuthorizer, MatrixCommandAuthorizer, MatrixCommandAuthorizer];
};

export function resolveMatrixMonitorAccessState(params: {
  allowFrom: Array<string | number>;
  storeAllowFrom: Array<string | number>;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  groupAllowFrom: Array<string | number>;
  roomUsers: Array<string | number>;
  senderId: string;
  isRoom: boolean;
}): MatrixMonitorAccessState {
  const configuredAllowFrom = normalizeMatrixAllowList(params.allowFrom);
  const effectiveAllowFrom = normalizeMatrixAllowList(
    mergeDmAllowFromSources({
      allowFrom: configuredAllowFrom,
      storeAllowFrom: params.storeAllowFrom,
      dmPolicy: params.dmPolicy,
    }),
  );
  const effectiveGroupAllowFrom = normalizeMatrixAllowList(params.groupAllowFrom);
  const effectiveRoomUsers = normalizeMatrixAllowList(params.roomUsers);
  const commandAllowFrom = params.isRoom ? [] : effectiveAllowFrom;

  const directAllowMatch = resolveMatrixAllowListMatch({
    allowList: effectiveAllowFrom,
    userId: params.senderId,
  });
  const roomUserMatch =
    params.isRoom && effectiveRoomUsers.length > 0
      ? resolveMatrixAllowListMatch({
          allowList: effectiveRoomUsers,
          userId: params.senderId,
        })
      : null;
  const groupAllowMatch =
    effectiveGroupAllowFrom.length > 0
      ? resolveMatrixAllowListMatch({
          allowList: effectiveGroupAllowFrom,
          userId: params.senderId,
        })
      : null;
  const commandAllowMatch =
    commandAllowFrom.length > 0
      ? resolveMatrixAllowListMatch({
          allowList: commandAllowFrom,
          userId: params.senderId,
        })
      : null;

  return {
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
    groupAllowConfigured: effectiveGroupAllowFrom.length > 0,
    directAllowMatch,
    roomUserMatch,
    groupAllowMatch,
    commandAuthorizers: [
      {
        configured: commandAllowFrom.length > 0,
        allowed: commandAllowMatch?.allowed ?? false,
      },
      {
        configured: effectiveRoomUsers.length > 0,
        allowed: roomUserMatch?.allowed ?? false,
      },
      {
        configured: effectiveGroupAllowFrom.length > 0,
        allowed: groupAllowMatch?.allowed ?? false,
      },
    ],
  };
}
