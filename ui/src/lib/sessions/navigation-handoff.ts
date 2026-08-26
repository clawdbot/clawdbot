import type { BoardFace } from "../board/settings.ts";

type SessionNavigationHandoff = {
  pathname: string;
  sessionKey: string;
  client: object | null;
  hello: object | null;
};

type SessionNavigationHandoffOwner = {
  readonly snapshot: {
    readonly client: object | null;
    readonly hello: object | null;
  };
};

const SESSION_NAVIGATION_HANDOFF_TTL_MS = 2_000;
export const SESSION_NAVIGATION_INTENT_EVENT = "openclaw:session-navigation-intent";
export type SessionNavigationIntent = {
  commit: () => boolean;
  face: BoardFace;
  sessionKey: string;
};
type SessionNavigationIntentOwner = {
  readonly isConnected: boolean;
  readonly activeRouteId?: unknown;
  readonly sessionKey?: unknown;
};
const sessionNavigationHandoffs = new WeakMap<
  SessionNavigationHandoffOwner,
  SessionNavigationHandoff
>();
const sessionNavigationIntents = new WeakMap<SessionNavigationIntentOwner, object>();

function announceSessionNavigationIntent(intent: SessionNavigationIntent): boolean {
  const event = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
    cancelable: true,
    detail: intent,
  });
  globalThis.dispatchEvent(event);
  return event.defaultPrevented;
}

export function runSessionNavigationIntent(
  owner: SessionNavigationIntentOwner,
  intent: SessionNavigationIntent,
): void {
  const token = {};
  const activeRouteId = owner.activeRouteId;
  const sourceSessionKey = owner.sessionKey;
  sessionNavigationIntents.set(owner, token);
  const guarded = {
    ...intent,
    commit: () => {
      if (
        !owner.isConnected ||
        owner.activeRouteId !== activeRouteId ||
        owner.sessionKey !== sourceSessionKey ||
        sessionNavigationIntents.get(owner) !== token
      ) {
        return false;
      }
      sessionNavigationIntents.delete(owner);
      return intent.commit();
    },
  };
  if (!announceSessionNavigationIntent(guarded)) {
    guarded.commit();
  }
}

export function prepareSessionNavigationHandoff(
  owner: SessionNavigationHandoffOwner,
  pathname: string,
  sessionKey: string,
): void {
  const { client, hello } = owner.snapshot;
  const handoff = { pathname, sessionKey, client, hello };
  sessionNavigationHandoffs.set(owner, handoff);
  globalThis.setTimeout(() => {
    if (sessionNavigationHandoffs.get(owner) === handoff) {
      sessionNavigationHandoffs.delete(owner);
    }
  }, SESSION_NAVIGATION_HANDOFF_TTL_MS);
}

export function consumeSessionNavigationHandoff(
  owner: SessionNavigationHandoffOwner,
  pathname: string,
): string | undefined {
  const handoff = sessionNavigationHandoffs.get(owner);
  if (!handoff || handoff.pathname !== pathname) {
    return undefined;
  }
  sessionNavigationHandoffs.delete(owner);
  // Browser clients survive transport reconnects, so hello identity must also
  // match before an old connection can bypass authoritative route resolution.
  const { client, hello } = owner.snapshot;
  if (handoff.client !== client || handoff.hello !== hello) {
    return undefined;
  }
  return handoff.sessionKey;
}
