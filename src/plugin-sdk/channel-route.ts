import { normalizeOptionalAccountId } from "../routing/account-id.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "../shared/string-coerce.js";

export type ChannelRouteChatType = "direct" | "group" | "channel";

export type ChannelRouteThreadKind = "topic" | "thread" | "reply";

export type ChannelRouteThreadSource = "explicit" | "target" | "session" | "turn";

export type ChannelRouteRef = {
  channel?: string;
  accountId?: string;
  target?: {
    to: string;
    rawTo?: string;
    chatType?: ChannelRouteChatType;
  };
  thread?: {
    id: string | number;
    kind?: ChannelRouteThreadKind;
    source?: ChannelRouteThreadSource;
  };
};

export type ChannelRouteRefInput = {
  channel?: unknown;
  accountId?: unknown;
  to?: unknown;
  rawTo?: unknown;
  chatType?: ChannelRouteChatType;
  threadId?: unknown;
  threadKind?: ChannelRouteThreadKind;
  threadSource?: ChannelRouteThreadSource;
};

export type ChannelRouteTargetInput = Pick<
  ChannelRouteRefInput,
  "channel" | "accountId" | "to" | "rawTo" | "chatType" | "threadId"
>;

export type ChannelRouteKeyInput = ChannelRouteRef | ChannelRouteTargetInput;

export type ChannelRouteExplicitTarget = {
  to: string;
  threadId?: string | number;
  chatType?: ChannelRouteChatType;
};

export type ChannelRouteExplicitTargetParser = (
  channel: string,
  rawTarget: string,
) => ChannelRouteExplicitTarget | null;

export function normalizeRouteThreadId(value: unknown): string | number | undefined {
  return normalizeOptionalThreadValue(value);
}

export function stringifyRouteThreadId(value: unknown): string | undefined {
  const normalized = normalizeRouteThreadId(value);
  return normalized == null ? undefined : String(normalized);
}

export function normalizeChannelRouteRef(
  input?: ChannelRouteRefInput,
): ChannelRouteRef | undefined {
  if (!input) {
    return undefined;
  }
  const channel = normalizeLowercaseStringOrEmpty(input.channel);
  const accountId =
    typeof input.accountId === "string" ? normalizeOptionalAccountId(input.accountId) : undefined;
  const to = normalizeOptionalString(input.to);
  const rawTo = normalizeOptionalString(input.rawTo);
  const threadId = normalizeRouteThreadId(input.threadId);
  if (!channel && !to && !accountId && threadId == null) {
    return undefined;
  }
  return {
    ...(channel ? { channel } : {}),
    ...(accountId ? { accountId } : {}),
    ...(to
      ? {
          target: {
            to,
            ...(rawTo && rawTo !== to ? { rawTo } : {}),
            ...(input.chatType ? { chatType: input.chatType } : {}),
          },
        }
      : {}),
    ...(threadId != null
      ? {
          thread: {
            id: threadId,
            ...(input.threadKind ? { kind: input.threadKind } : {}),
            ...(input.threadSource ? { source: input.threadSource } : {}),
          },
        }
      : {}),
  };
}

export function channelRouteTarget(route?: ChannelRouteRef): string | undefined {
  return route?.target?.to;
}

export function channelRouteThreadId(route?: ChannelRouteRef): string | number | undefined {
  return route?.thread?.id;
}

export function normalizeChannelRouteTarget(
  input?: ChannelRouteTargetInput | null,
): ChannelRouteRef | undefined {
  return input ? normalizeChannelRouteRef(input) : undefined;
}

export type ChannelRouteParsedTarget = ChannelRouteTargetInput & {
  channel: string;
  rawTo: string;
  to: string;
  threadId?: string | number;
  chatType?: ChannelRouteChatType;
};

export function resolveChannelRouteTargetWithParser(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
  parseExplicitTarget: ChannelRouteExplicitTargetParser;
}): ChannelRouteParsedTarget | null {
  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  const rawTo = normalizeOptionalString(params.rawTarget);
  if (!channel || !rawTo) {
    return null;
  }
  const parsed = params.parseExplicitTarget(channel, rawTo);
  const fallbackThreadId = normalizeOptionalThreadValue(params.fallbackThreadId);
  return {
    channel,
    rawTo,
    to: parsed?.to ?? rawTo,
    threadId: normalizeOptionalThreadValue(parsed?.threadId ?? fallbackThreadId),
    chatType: parsed?.chatType,
  };
}

export function channelRouteDedupeKey(input?: ChannelRouteTargetInput | null): string {
  const route = normalizeChannelRouteTarget(input);
  return JSON.stringify([
    route?.channel ?? "",
    route?.target?.to ?? "",
    route?.accountId ?? "",
    stringifyRouteThreadId(route?.thread?.id) ?? "",
  ]);
}

/** @deprecated Use `channelRouteDedupeKey`. */
export function channelRouteIdentityKey(input?: ChannelRouteTargetInput | null): string {
  return channelRouteDedupeKey(input);
}

function threadIdsEqual(left?: string | number, right?: string | number): boolean {
  const normalizedLeft = stringifyRouteThreadId(left);
  const normalizedRight = stringifyRouteThreadId(right);
  return normalizedLeft === normalizedRight;
}

function accountsCompatible(left?: string, right?: string): boolean {
  return !left || !right || left === right;
}

function accountsEqual(left?: string, right?: string): boolean {
  return (left ?? "") === (right ?? "");
}

export function channelRoutesMatchExact(params: {
  left?: ChannelRouteRef | null;
  right?: ChannelRouteRef | null;
}): boolean {
  const { left, right } = params;
  if (!left || !right) {
    return false;
  }
  return (
    left.channel === right.channel &&
    left.target?.to === right.target?.to &&
    accountsEqual(left.accountId, right.accountId) &&
    threadIdsEqual(left.thread?.id, right.thread?.id)
  );
}

export function channelRoutesShareConversation(params: {
  left?: ChannelRouteRef | null;
  right?: ChannelRouteRef | null;
}): boolean {
  const { left, right } = params;
  if (!left || !right) {
    return false;
  }
  if (
    left.channel !== right.channel ||
    left.target?.to !== right.target?.to ||
    !accountsCompatible(left.accountId, right.accountId)
  ) {
    return false;
  }
  if (left.thread?.id == null || right.thread?.id == null) {
    return true;
  }
  return threadIdsEqual(left.thread.id, right.thread.id);
}

export function channelRouteTargetsMatchExact(params: {
  left?: ChannelRouteTargetInput | null;
  right?: ChannelRouteTargetInput | null;
}): boolean {
  return channelRoutesMatchExact({
    left: normalizeChannelRouteTarget(params.left),
    right: normalizeChannelRouteTarget(params.right),
  });
}

export function channelRouteTargetsShareConversation(params: {
  left?: ChannelRouteTargetInput | null;
  right?: ChannelRouteTargetInput | null;
}): boolean {
  return channelRoutesShareConversation({
    left: normalizeChannelRouteTarget(params.left),
    right: normalizeChannelRouteTarget(params.right),
  });
}

function isChannelRouteRef(route: ChannelRouteKeyInput): route is ChannelRouteRef {
  return "target" in route || "thread" in route;
}

function normalizeChannelRouteKeyInput(
  route?: ChannelRouteKeyInput | null,
): ChannelRouteRef | undefined {
  if (!route) {
    return undefined;
  }
  return isChannelRouteRef(route)
    ? normalizeChannelRouteRef({
        channel: route.channel,
        to: route.target?.to,
        accountId: route.accountId,
        threadId: route.thread?.id,
      })
    : normalizeChannelRouteTarget(route);
}

export function channelRouteCompactKey(route?: ChannelRouteKeyInput | null): string | undefined {
  const normalized = normalizeChannelRouteKeyInput(route);
  if (!normalized?.channel || !normalized.target?.to) {
    return undefined;
  }
  return [
    normalized.channel,
    normalized.target.to,
    normalized.accountId ?? "",
    stringifyRouteThreadId(normalized.thread?.id) ?? "",
  ].join("|");
}

/** @deprecated Use `channelRouteCompactKey`. */
export function channelRouteKey(route?: ChannelRouteRef): string | undefined {
  return channelRouteCompactKey(route);
}
