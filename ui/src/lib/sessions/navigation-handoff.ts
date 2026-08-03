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
const sessionNavigationHandoffs = new WeakMap<
  SessionNavigationHandoffOwner,
  SessionNavigationHandoff
>();

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
