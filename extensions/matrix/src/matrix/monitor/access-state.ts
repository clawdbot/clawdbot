import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeMatrixAllowList, resolveMatrixAllowListMatch } from "./allowlist.js";

type MatrixMonitorAccessState = {
  effectiveGroupAllowFrom: string[];
  effectiveRoomUsers: string[];
  messageIngress: ResolvedChannelMessageIngress;
  accountId: string;
  senderId: string;
  isRoom: boolean;
};

function normalizeMatrixEntry(raw?: string | null): string | null {
  return normalizeMatrixAllowList([raw ?? ""])[0] ?? null;
}

const matrixIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  normalize: normalizeMatrixEntry,
  matchEntry({ subject, entry }) {
    const senderId = subject.identifiers[0]?.value;
    return (
      entry.value === "*" ||
      resolveMatrixAllowListMatch({
        allowList: [entry.value],
        userId: senderId ?? "",
      }).allowed
    );
  },
});

function resolveMatrixGroupIngress(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  effectiveGroupAllowFrom: string[];
  effectiveRoomUsers: string[];
}): { groupPolicy: "open" | "allowlist" | "disabled"; groupAllowFrom: string[] } {
  if (params.groupPolicy === "disabled") {
    return { groupPolicy: "disabled", groupAllowFrom: [] };
  }
  if (params.effectiveRoomUsers.length > 0) {
    return { groupPolicy: "allowlist", groupAllowFrom: params.effectiveRoomUsers };
  }
  if (params.groupPolicy === "allowlist" && params.effectiveGroupAllowFrom.length > 0) {
    return { groupPolicy: "allowlist", groupAllowFrom: params.effectiveGroupAllowFrom };
  }
  return { groupPolicy: "open", groupAllowFrom: [] };
}

export async function resolveMatrixMonitorAccessState(params: {
  allowFrom: Array<string | number>;
  storeAllowFrom: Array<string | number>;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom: Array<string | number>;
  roomUsers: Array<string | number>;
  senderId: string;
  isRoom: boolean;
  accountId?: string;
  eventKind?: "message" | "reaction";
}): Promise<MatrixMonitorAccessState> {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const groupPolicy = params.groupPolicy ?? "open";
  const effectiveGroupAllowFrom = normalizeMatrixAllowList(params.groupAllowFrom);
  const effectiveRoomUsers = normalizeMatrixAllowList(params.roomUsers);
  const groupIngress = resolveMatrixGroupIngress({
    groupPolicy,
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
  });
  const accountId = params.accountId ?? "default";
  const eventKind = params.eventKind ?? "message";
  const ingress = createChannelIngressResolver({
    channelId: "matrix",
    accountId,
    identity: matrixIngressIdentity,
    readStoreAllowFrom: async () => params.storeAllowFrom,
  });
  const resolved = await ingress.message({
    subject: { stableId: params.senderId },
    conversation: {
      kind: params.isRoom ? "group" : "direct",
      id: params.isRoom ? "matrix-room" : "matrix-dm",
    },
    event: {
      kind: eventKind,
      authMode: "inbound" as const,
      mayPair: params.isRoom ? false : eventKind === "message",
    },
    dmPolicy,
    groupPolicy: params.isRoom ? groupIngress.groupPolicy : "disabled",
    policy: { groupAllowFromFallbackToAllowFrom: false },
    allowFrom: params.allowFrom,
    ...(params.isRoom ? { groupAllowFrom: groupIngress.groupAllowFrom } : {}),
  });

  return {
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
    messageIngress: resolved,
    accountId,
    senderId: params.senderId,
    isRoom: params.isRoom,
  };
}

export async function resolveMatrixMonitorCommandAccess(
  state: MatrixMonitorAccessState,
  params: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
  },
) {
  const commandAllowFrom = state.isRoom ? [] : state.messageIngress.senderAccess.effectiveAllowFrom;
  const commandGroupAllowFrom =
    state.effectiveRoomUsers.length > 0 ? state.effectiveRoomUsers : state.effectiveGroupAllowFrom;
  const resolved = await createChannelIngressResolver({
    channelId: "matrix",
    accountId: state.accountId,
    identity: matrixIngressIdentity,
  }).command({
    subject: { stableId: state.senderId },
    conversation: {
      kind: state.isRoom ? "group" : "direct",
      id: state.isRoom ? "matrix-room" : "matrix-dm",
    },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    policy: { groupAllowFromFallbackToAllowFrom: false },
    allowFrom: commandAllowFrom,
    groupAllowFrom: commandGroupAllowFrom,
    command: {
      useAccessGroups: params.useAccessGroups,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      groupOwnerAllowFrom: "none",
      commandGroupAllowFromFallbackToAllowFrom: false,
    },
  });
  return resolved.commandAccess;
}
