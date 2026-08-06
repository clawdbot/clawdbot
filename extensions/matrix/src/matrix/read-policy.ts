import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  ToolAuthorizationError,
} from "../runtime-api.js";
import type { CoreConfig } from "../types.js";
import { resolveMatrixBaseConfig } from "./account-config.js";
import { resolveMatrixAccount } from "./accounts.js";
import { withResolvedActionClient } from "./actions/client.js";
import type { MatrixActionClientOpts } from "./actions/types.js";
import {
  hasDirectMatrixMemberFlag,
  isStrictDirectMembership,
  readJoinedMatrixMembers,
} from "./direct-room.js";
import { createMatrixRoomInfoResolver } from "./monitor/room-info.js";
import { resolveMatrixRoomConfig } from "./monitor/rooms.js";
import type { MatrixClient } from "./sdk.js";
import { resolveMatrixRoomId } from "./send/targets.js";
import { normalizeMatrixResolvableTarget } from "./target-ids.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

export type MatrixReadContext = {
  accountId?: string | null;
  currentChannelId?: string | null;
  currentChannelProvider?: string | null;
  currentChatType?: "direct" | "group" | "channel" | null;
  requesterAccountId?: string | null;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
};

function normalizeRoomId(raw?: string | null): string {
  return raw?.trim().replace(/^room:/i, "") ?? "";
}

function isCurrentRoom(params: {
  accountId: string;
  context?: MatrixReadContext;
  roomId: string;
}): boolean {
  return (
    params.context?.currentChannelProvider?.trim().toLowerCase() === "matrix" &&
    params.context.requesterAccountId?.trim() === params.accountId &&
    normalizeRoomId(params.context.currentChannelId) === normalizeRoomId(params.roomId)
  );
}

function includesEntry(entries: Array<string | number> | undefined, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (entries ?? []).some((entry) => {
    const candidate = String(entry)
      .replace(/^matrix:/i, "")
      .trim()
      .toLowerCase();
    return candidate === "*" || candidate === normalized;
  });
}

function hasWildcardEntry(entries: Array<string | number> | undefined): boolean {
  return (entries ?? []).some(
    (entry) =>
      String(entry)
        .replace(/^matrix:/i, "")
        .trim() === "*",
  );
}

type MatrixRoomClassification =
  | { kind: "direct"; remoteUserId: string }
  | { kind: "group" }
  | { kind: "unknown" };

function resolveMatrixReadRoomPolicy(params: {
  account: ReturnType<typeof resolveMatrixAccount>;
  baseConfig: ReturnType<typeof resolveMatrixBaseConfig>;
  roomId: string;
  aliases: string[];
}) {
  const configuredRooms = params.account.config.groups ?? params.account.config.rooms;
  const room = resolveMatrixRoomConfig({
    rooms: configuredRooms,
    roomId: params.roomId,
    aliases: params.aliases,
  });
  const baseRoom = resolveMatrixRoomConfig({
    rooms: params.baseConfig.groups ?? params.baseConfig.rooms,
    roomId: params.roomId,
    aliases: params.aliases,
  });
  const baseRoomAccount = baseRoom.config?.account;
  const explicitlyScopedToAnotherAccount =
    room.config === undefined &&
    baseRoom.matchSource === "direct" &&
    typeof baseRoomAccount === "string" &&
    normalizeAccountId(baseRoomAccount) !== params.account.accountId;
  const accountMatches = !room.config?.account || room.config.account === params.account.accountId;
  const configuredRoomBlocked = room.config !== undefined && (!room.allowed || !accountMatches);
  const blocked = explicitlyScopedToAnotherAccount || configuredRoomBlocked;
  const blockedBeforeProviderAccess =
    explicitlyScopedToAnotherAccount || (room.matchSource === "direct" && configuredRoomBlocked);
  return { blocked, blockedBeforeProviderAccess, room };
}

async function classifyMatrixReadRoom(params: {
  client: MatrixClient;
  roomId: string;
}): Promise<MatrixRoomClassification> {
  const members = await readJoinedMatrixMembers(params.client, params.roomId);
  if (!members) {
    return { kind: "unknown" };
  }
  if (members.length >= 3) {
    return { kind: "group" };
  }
  if (members.length !== 2) {
    return { kind: "unknown" };
  }
  const selfUserId = await params.client.getUserId().catch(() => null);
  if (!selfUserId || !members.includes(selfUserId)) {
    return { kind: "unknown" };
  }
  const remoteUserId = members.find((member) => member !== selfUserId);
  if (
    !isStrictDirectMembership({
      selfUserId,
      remoteUserId,
      joinedMembers: members,
    }) ||
    !remoteUserId
  ) {
    return { kind: "unknown" };
  }
  const memberStateFlag = await hasDirectMatrixMemberFlag(params.client, params.roomId, selfUserId);
  await params.client.dms.update().catch(() => false);
  if (memberStateFlag === true || params.client.dms.isDm(params.roomId)) {
    return { kind: "direct", remoteUserId };
  }
  return memberStateFlag === false ? { kind: "group" } : { kind: "unknown" };
}

export async function withAuthorizedMatrixReadTarget<T>(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  roomId: string;
  context?: MatrixReadContext;
  opts: MatrixActionClientOpts;
  run: (target: { client: MatrixClient; roomId: string }) => Promise<T>;
}): Promise<T> {
  const account = resolveMatrixAccount({ cfg: params.cfg, accountId: params.accountId });
  const baseConfig = resolveMatrixBaseConfig(params.cfg);
  const preliminaryRoomId = normalizeMatrixResolvableTarget(params.roomId);
  const preliminaryPolicy = resolveMatrixReadRoomPolicy({
    account,
    baseConfig,
    roomId: preliminaryRoomId,
    aliases: [],
  });
  if (preliminaryPolicy.blockedBeforeProviderAccess) {
    throw new ToolAuthorizationError("Matrix read target is not allowed.");
  }
  return await withResolvedActionClient(params.opts, async (client) => {
    const roomId = await resolveMatrixRoomId(client, params.roomId);
    const inputAlias = params.roomId.trim().startsWith("#") ? params.roomId.trim() : undefined;
    const { getRoomInfo } = createMatrixRoomInfoResolver(client);
    const roomInfo = await getRoomInfo(roomId, { includeAliases: true });
    const mutableRoomName =
      account.config.dangerouslyAllowNameMatching === true ? roomInfo.name : undefined;
    const aliases = [
      inputAlias,
      roomInfo.canonicalAlias,
      ...roomInfo.altAliases,
      mutableRoomName,
    ].filter((value): value is string => Boolean(value));
    const finalPolicy = resolveMatrixReadRoomPolicy({
      account,
      baseConfig,
      roomId,
      aliases,
    });
    const room = finalPolicy.room;
    const current = isCurrentRoom({
      accountId: account.accountId,
      context: params.context,
      roomId,
    });
    const currentChatType = params.context?.currentChatType?.trim().toLowerCase();
    const trustedCurrentClassification =
      currentChatType === "direct"
        ? ({ kind: "direct", remoteUserId: "" } as const)
        : currentChatType === "group" || currentChatType === "channel"
          ? ({ kind: "group" } as const)
          : null;
    // Ingress treats an explicitly configured room or alias as a group before
    // Matrix DM heuristics. Otherwise preserve its trusted type for the current room.
    const classification =
      room.matchSource === "direct"
        ? ({ kind: "group" } as const)
        : current && trustedCurrentClassification
          ? trustedCurrentClassification
          : await classifyMatrixReadRoom({ client, roomId });
    const resolvedGroupPolicy = resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: params.cfg.channels?.matrix !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(params.cfg),
    }).groupPolicy;
    const groupPolicy =
      account.config.allowlistOnly && resolvedGroupPolicy === "open"
        ? "allowlist"
        : resolvedGroupPolicy;
    const dmPolicy = account.config.allowlistOnly
      ? account.config.dm?.policy === "disabled"
        ? "disabled"
        : "allowlist"
      : (account.config.dm?.policy ?? "pairing");
    const directOperator = params.context?.conversationReadOrigin === "direct-operator";
    const allowed = finalPolicy.blocked
      ? false
      : directOperator
        ? classification.kind === "direct"
          ? account.config.dm?.enabled !== false && dmPolicy !== "disabled"
          : classification.kind === "group"
            ? groupPolicy !== "disabled"
            : groupPolicy !== "disabled" &&
              dmPolicy !== "disabled" &&
              account.config.dm?.enabled !== false
        : classification.kind === "direct"
          ? account.config.dm?.enabled !== false &&
            dmPolicy !== "disabled" &&
            (current || includesEntry(account.config.dm?.allowFrom, classification.remoteUserId))
          : classification.kind === "group"
            ? groupPolicy !== "disabled" &&
              (current || groupPolicy === "open" || room.config !== undefined)
            : current
              ? groupPolicy !== "disabled" &&
                dmPolicy !== "disabled" &&
                account.config.dm?.enabled !== false
              : groupPolicy === "open" &&
                dmPolicy !== "disabled" &&
                account.config.dm?.enabled !== false &&
                hasWildcardEntry(account.config.dm?.allowFrom);
    if (!allowed) {
      throw new ToolAuthorizationError("Matrix read target is not allowed.");
    }
    return await params.run({ client, roomId });
  });
}
