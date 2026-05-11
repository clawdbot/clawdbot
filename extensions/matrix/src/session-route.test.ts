import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";

const tempDirs = new Set<string>();
const currentDmSessionKey = "agent:main:matrix:channel:!dm:example.org";
type MatrixChannelConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["matrix"]>;

const perRoomDmMatrixConfig = {
  dm: {
    sessionScope: "per-room",
  },
} satisfies MatrixChannelConfig;

const defaultAccountPerRoomDmMatrixConfig = {
  defaultAccount: "ops",
  accounts: {
    ops: {
      dm: {
        sessionScope: "per-room",
      },
    },
  },
} satisfies MatrixChannelConfig;

function createTempStore(entries: Record<string, unknown>): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-session-route-"));
  tempDirs.add(tempDir);
  const storePath = path.join(tempDir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries), "utf8");
  return storePath;
}

function createMatrixRouteConfig(
  entries: Record<string, unknown>,
  matrix: MatrixChannelConfig = perRoomDmMatrixConfig,
): OpenClawConfig {
  return {
    session: {
      store: createTempStore(entries),
    },
    channels: {
      matrix,
    },
  } satisfies OpenClawConfig;
}

function createStoredDirectDmSession(
  params: {
    from?: string;
    to?: string;
    accountId?: string | null;
    nativeChannelId?: string;
    nativeDirectUserId?: string;
    lastTo?: string;
    lastAccountId?: string;
  } = {},
): Record<string, unknown> {
  const accountId = params.accountId === null ? undefined : (params.accountId ?? "ops");
  const to = params.to ?? "room:!dm:example.org";
  const accountMetadata = accountId ? { accountId } : {};
  const nativeMetadata = {
    ...(params.nativeChannelId ? { nativeChannelId: params.nativeChannelId } : {}),
    ...(params.nativeDirectUserId ? { nativeDirectUserId: params.nativeDirectUserId } : {}),
  };
  return {
    sessionId: "sess-1",
    updatedAt: Date.now(),
    chatType: "direct",
    origin: {
      chatType: "direct",
      from: params.from ?? "matrix:@alice:example.org",
      to,
      ...nativeMetadata,
      ...accountMetadata,
    },
    deliveryContext: {
      channel: "matrix",
      to,
      ...accountMetadata,
    },
    ...(params.lastTo ? { lastTo: params.lastTo } : {}),
    ...(params.lastAccountId ? { lastAccountId: params.lastAccountId } : {}),
  };
}

function createStoredChannelSession(): Record<string, unknown> {
  return {
    sessionId: "sess-1",
    updatedAt: Date.now(),
    chatType: "channel",
    origin: {
      chatType: "channel",
      from: "matrix:channel:!ops:example.org",
      to: "room:!ops:example.org",
      nativeChannelId: "!ops:example.org",
      nativeDirectUserId: "@alice:example.org",
      accountId: "ops",
    },
    deliveryContext: {
      channel: "matrix",
      to: "room:!ops:example.org",
      accountId: "ops",
    },
    lastTo: "room:!ops:example.org",
    lastAccountId: "ops",
  };
}

function resolveUserRoute(params: { cfg: OpenClawConfig; accountId?: string; target?: string }) {
  const target = params.target ?? "@alice:example.org";
  return resolveMatrixOutboundSessionRoute({
    cfg: params.cfg,
    agentId: "main",
    ...(params.accountId ? { accountId: params.accountId } : {}),
    currentSessionKey: currentDmSessionKey,
    target,
    resolvedTarget: {
      to: target,
      kind: "user",
      source: "normalized",
    },
  });
}

function resolveUserRouteForCurrentSession(params: {
  storedSession: Record<string, unknown>;
  accountId?: string;
  target?: string;
  matrix?: MatrixChannelConfig;
}) {
  return resolveUserRoute({
    cfg: createMatrixRouteConfig(
      {
        [currentDmSessionKey]: params.storedSession,
      },
      params.matrix ?? perRoomDmMatrixConfig,
    ),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.target ? { target: params.target } : {}),
  });
}

function expectCurrentDmRoomRoute(route: ReturnType<typeof resolveMatrixOutboundSessionRoute>) {
  const currentRoute = expectRoute(route);
  expect(currentRoute.sessionKey).toBe(currentDmSessionKey);
  expect(currentRoute.baseSessionKey).toBe(currentDmSessionKey);
  expect(currentRoute.peer.kind).toBe("channel");
  expect(currentRoute.peer.id).toBe("!dm:example.org");
  expect(currentRoute.chatType).toBe("direct");
  expect(currentRoute.from).toBe("matrix:@alice:example.org");
  expect(currentRoute.to).toBe("room:!dm:example.org");
}

function expectFallbackUserRoute(
  route: ReturnType<typeof resolveMatrixOutboundSessionRoute>,
  params?: {
    userId?: string;
  },
) {
  const userId = params?.userId ?? "@alice:example.org";
  const fallbackRoute = expectRoute(route);
  expect(fallbackRoute.sessionKey).toBe("agent:main:main");
  expect(fallbackRoute.baseSessionKey).toBe("agent:main:main");
  expect(fallbackRoute.peer.kind).toBe("direct");
  expect(fallbackRoute.peer.id).toBe(userId);
  expect(fallbackRoute.chatType).toBe("direct");
  expect(fallbackRoute.from).toBe(`matrix:${userId}`);
  expect(fallbackRoute.to).toBe(`room:${userId}`);
}

function expectRoute(route: ReturnType<typeof resolveMatrixOutboundSessionRoute>) {
  if (!route) {
    throw new Error("Expected Matrix route");
  }
  return route;
}

afterEach(() => {
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("resolveMatrixOutboundSessionRoute", () => {
  it("reuses the current DM room session for same-user sends when Matrix DMs are per-room", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession(),
      accountId: "ops",
    });

    expectCurrentDmRoomRoute(route);
  });

  it("falls back to user-scoped routing when the current session is for another DM peer", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession({ from: "matrix:@bob:example.org" }),
      accountId: "ops",
    });

    expectFallbackUserRoute(route);
  });

  it("falls back to user-scoped routing when the current session belongs to another Matrix account", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession(),
      accountId: "support",
    });

    expectFallbackUserRoute(route);
  });

  it("reuses the canonical DM room after user-target outbound metadata overwrites latest to fields", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession({
        from: "matrix:@bob:example.org",
        to: "room:@bob:example.org",
        nativeChannelId: "!dm:example.org",
        nativeDirectUserId: "@alice:example.org",
        lastTo: "room:@bob:example.org",
        lastAccountId: "ops",
      }),
      accountId: "ops",
    });

    expectCurrentDmRoomRoute(route);
  });

  it("does not reuse the canonical DM room for a different Matrix user after latest metadata drift", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession({
        from: "matrix:@bob:example.org",
        to: "room:@bob:example.org",
        nativeChannelId: "!dm:example.org",
        nativeDirectUserId: "@alice:example.org",
        lastTo: "room:@bob:example.org",
        lastAccountId: "ops",
      }),
      accountId: "ops",
      target: "@bob:example.org",
    });

    expectFallbackUserRoute(route, { userId: "@bob:example.org" });
  });

  it("does not reuse a room after the session metadata was overwritten by a non-DM Matrix send", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredChannelSession(),
      accountId: "ops",
    });

    expectFallbackUserRoute(route);
  });

  it("uses the effective default Matrix account when accountId is omitted", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession(),
      matrix: defaultAccountPerRoomDmMatrixConfig,
    });

    expectCurrentDmRoomRoute(route);
  });

  it("reuses the current DM room when stored account metadata is missing", () => {
    const route = resolveUserRouteForCurrentSession({
      storedSession: createStoredDirectDmSession({ accountId: null }),
      matrix: defaultAccountPerRoomDmMatrixConfig,
    });

    expectCurrentDmRoomRoute(route);
  });

  it("recovers channel thread routes from currentSessionKey and preserves Matrix event-id case", () => {
    const route = resolveMatrixOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "room:!Ops:Example.Org",
      currentSessionKey: "agent:main:matrix:channel:!ops:example.org:thread:$RootEvent:Example.Org",
    });

    const channelRoute = expectRoute(route);
    expect(channelRoute.sessionKey).toBe(
      "agent:main:matrix:channel:!ops:example.org:thread:$RootEvent:Example.Org",
    );
    expect(channelRoute.baseSessionKey).toBe("agent:main:matrix:channel:!ops:example.org");
    expect(channelRoute.threadId).toBe("$RootEvent:Example.Org");
  });

  it("resolves per-room DM metadata from the base key when currentSessionKey has a thread suffix", () => {
    const storedSession = createStoredDirectDmSession();
    const route = resolveUserRoute({
      cfg: createMatrixRouteConfig({
        [currentDmSessionKey]: storedSession,
      }),
      accountId: "ops",
      target: "@alice:example.org",
    });
    const threadedRoute = resolveMatrixOutboundSessionRoute({
      cfg: createMatrixRouteConfig({
        [route?.baseSessionKey ?? currentDmSessionKey]: storedSession,
      }),
      agentId: "main",
      accountId: "ops",
      target: "@alice:example.org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
      currentSessionKey: `${route?.baseSessionKey}:thread:$DmRoot:Example.Org`,
    });

    const dmThreadRoute = expectRoute(threadedRoute);
    expect(dmThreadRoute.sessionKey).toBe(`${route?.baseSessionKey}:thread:$DmRoot:Example.Org`);
    expect(dmThreadRoute.baseSessionKey).toBe(route?.baseSessionKey);
    expect(dmThreadRoute.to).toBe("room:!dm:example.org");
    expect(dmThreadRoute.threadId).toBe("$DmRoot:Example.Org");
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', () => {
    const route = resolveMatrixOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "@alice:example.org",
      currentSessionKey: "agent:main:main:thread:$DmRoot:Example.Org",
      resolvedTarget: {
        to: "@alice:example.org",
        kind: "user",
        source: "normalized",
      },
    });

    const dmRoute = expectRoute(route);
    expect(dmRoute.sessionKey).toBe("agent:main:main");
    expect(dmRoute.baseSessionKey).toBe("agent:main:main");
    expect(dmRoute.threadId).toBeUndefined();
  });
});
