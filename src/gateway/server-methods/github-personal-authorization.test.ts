import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareGitHubPublicationOptionsRead,
  preparePersonalGitHubSessionAction,
} from "./github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSession: vi.fn<typeof import("../session-utils.js").loadGatewaySessionEntryReadOnly>(),
}));

vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: mocks.loadSession,
}));
vi.mock("../../agents/tools/gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => undefined,
}));
vi.mock("../../state/user-github-connections.js", () => ({
  resolvePersonalGitHubOwner: (profile: string) => profile,
}));
vi.mock("../operator-role-policy.js", () => ({
  resolveOperatorRolePolicy: () => null,
  resolveOperatorRolePolicyForProfile: () => null,
}));
vi.mock("../session-sharing.js", () => ({
  createSessionListEntryFilter: () => undefined,
  resolveSessionMutationAuthorization: () => ({}),
}));

function createRequest() {
  const client: GatewayClient = {
    connId: "github-cache-client",
    authenticatedUserProfile: {
      profileId: "profile-cache-test",
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  const context = {
    getRuntimeConfig: () => ({}),
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(!filter || filter(client) ? ["github-cache-client"] : []),
  } as Partial<GatewayRequestContext> as GatewayRequestContext;
  return { client, context };
}

describe("GitHub publication request discovery", () => {
  beforeEach(() => {
    mocks.loadSession.mockReset();
    mocks.loadSession.mockReturnValue({
      cfg: {},
      canonicalKey: "agent:main:main",
      agentId: "main",
      storePath: "/test/sessions.json",
      store: {},
      storeKeys: ["agent:main:main"],
      entry: { sessionId: "session-cache-test", updatedAt: 1 },
      legacyKey: undefined,
    });
  });

  it("shares store discovery while re-reading publication options live", () => {
    const read = prepareGitHubPublicationOptionsRead(createRequest(), "main");

    expect(read.currentSession()).toEqual(read.session);
    expect(mocks.loadSession).toHaveBeenCalledTimes(2);
    const targetDiscoveryCache = mocks.loadSession.mock.calls[0]?.[1]?.targetDiscoveryCache;
    expect(targetDiscoveryCache).toBeInstanceOf(Map);
    expect(mocks.loadSession.mock.calls[1]?.[1]?.targetDiscoveryCache).toBe(targetDiscoveryCache);
    expect(mocks.loadSession).toHaveBeenNthCalledWith(2, "agent:main:main", {
      agentId: "main",
      targetDiscoveryCache,
    });
  });

  it("shares store discovery across every personal session authority re-read", () => {
    const action = preparePersonalGitHubSessionAction(createRequest(), "main");
    action.assertCurrent();

    expect(mocks.loadSession).toHaveBeenCalledTimes(3);
    const targetDiscoveryCache = mocks.loadSession.mock.calls[0]?.[1]?.targetDiscoveryCache;
    expect(targetDiscoveryCache).toBeInstanceOf(Map);
    for (const call of [2, 3]) {
      expect(mocks.loadSession.mock.calls[call - 1]?.[1]?.targetDiscoveryCache).toBe(
        targetDiscoveryCache,
      );
      expect(mocks.loadSession).toHaveBeenNthCalledWith(call, "agent:main:main", {
        agentId: "main",
        targetDiscoveryCache,
      });
    }
  });
});
