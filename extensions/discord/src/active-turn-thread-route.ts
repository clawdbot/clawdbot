type ActiveDiscordTurnThreadRoute = {
  accountId?: string;
  sourceChannelId: string;
  sourceMessageId: string;
  adoptedThreadId?: string;
  onThreadAdopted: (threadId: string) => Promise<void> | void;
  onThreadReplyDelivered?: (threadId: string) => void;
  onThreadAdoptionError?: (error: unknown) => void;
};

const activeRoutes = new Map<string, Set<ActiveDiscordTurnThreadRoute>>();

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function beginDiscordActiveTurnThreadRoute(
  sessionKey: string | undefined,
  route: ActiveDiscordTurnThreadRoute,
): () => void {
  const key = normalizeId(sessionKey);
  if (!key) {
    return () => {};
  }
  const routes = activeRoutes.get(key) ?? new Set<ActiveDiscordTurnThreadRoute>();
  routes.add(route);
  activeRoutes.set(key, routes);
  return () => {
    routes.delete(route);
    if (routes.size === 0 && activeRoutes.get(key) === routes) {
      activeRoutes.delete(key);
    }
  };
}

export async function notifyDiscordActiveTurnThreadCreated(params: {
  sessionKey?: string | null;
  accountId?: string | null;
  sourceChannelId?: string;
  sourceMessageId?: string;
  threadId?: string;
}): Promise<boolean> {
  const key = normalizeId(params.sessionKey ?? undefined);
  const threadId = normalizeId(params.threadId);
  const sourceChannelId = normalizeId(params.sourceChannelId);
  const sourceMessageId = normalizeId(params.sourceMessageId);
  const route = key
    ? Array.from(activeRoutes.get(key) ?? []).find(
        (candidate) =>
          sourceChannelId === candidate.sourceChannelId &&
          sourceMessageId === candidate.sourceMessageId &&
          (!candidate.accountId || !params.accountId || candidate.accountId === params.accountId),
      )
    : undefined;
  if (!route || !threadId) {
    return false;
  }
  route.adoptedThreadId = threadId;
  try {
    await route.onThreadAdopted(threadId);
  } catch (error) {
    route.onThreadAdoptionError?.(error);
  }
  return true;
}

export function notifyDiscordActiveTurnThreadReplyDelivered(params: {
  sessionKey?: string | null;
  accountId?: string | null;
  threadId?: string;
}): boolean {
  const route = findDiscordActiveTurnThreadReplyRoute(params);
  const threadId = normalizeId(params.threadId ?? undefined);
  if (!route || !threadId) {
    return false;
  }
  route.onThreadReplyDelivered?.(threadId);
  return true;
}

function findDiscordActiveTurnThreadReplyRoute(params: {
  sessionKey?: string | null;
  accountId?: string | null;
  threadId?: string;
}): ActiveDiscordTurnThreadRoute | undefined {
  const key = normalizeId(params.sessionKey ?? undefined);
  const threadId = normalizeId(params.threadId);
  if (!key || !threadId) {
    return undefined;
  }
  return Array.from(activeRoutes.get(key) ?? []).find(
    (route) =>
      Boolean(route.adoptedThreadId) &&
      route.adoptedThreadId === threadId &&
      (!route.accountId || !params.accountId || route.accountId === params.accountId),
  );
}
