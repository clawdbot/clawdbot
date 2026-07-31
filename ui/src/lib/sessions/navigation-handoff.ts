type SessionNavigationHandoff = {
  pathname: string;
  sessionKey: string;
};

const SESSION_NAVIGATION_HANDOFF_TTL_MS = 2_000;
const sessionNavigationHandoffs = new WeakMap<object, SessionNavigationHandoff>();

export function prepareSessionNavigationHandoff(
  owner: object,
  pathname: string,
  sessionKey: string,
): void {
  const handoff = { pathname, sessionKey };
  sessionNavigationHandoffs.set(owner, handoff);
  globalThis.setTimeout(() => {
    if (sessionNavigationHandoffs.get(owner) === handoff) {
      sessionNavigationHandoffs.delete(owner);
    }
  }, SESSION_NAVIGATION_HANDOFF_TTL_MS);
}

export function consumeSessionNavigationHandoff(
  owner: object,
  pathname: string,
): string | undefined {
  const handoff = sessionNavigationHandoffs.get(owner);
  if (!handoff || handoff.pathname !== pathname) {
    return undefined;
  }
  sessionNavigationHandoffs.delete(owner);
  return handoff.sessionKey;
}
