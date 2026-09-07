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

function sessionRead(agentId = "main") {
  return {
    cfg: {},
    canonicalKey: `agent:${agentId}:main`,
    agentId,
    storePath: "/test/sessions.json",
    store: {},
    storeKeys: [`agent:${agentId}:main`],
    entry: { sessionId: "session-cache-test", updatedAt: 1 },
    legacyKey: undefined,
  };
}

describe("GitHub publication request discovery", () => {
  beforeEach(() => {
    mocks.loadSession.mockReset();
    mocks.loadSession.mockReturnValue(sessionRead());
  });

  it.each([undefined, "research"])(
    "shares store discovery while re-reading publication options live for %s",
    (agentId) => {
      mocks.loadSession.mockReturnValue(sessionRead(agentId));
      const read = prepareGitHubPublicationOptionsRead(createRequest(), {
        sessionKey: "main",
        agentId,
      });

      expect(read.currentSession()).toEqual(read.session);
      expect(mocks.loadSession).toHaveBeenCalledTimes(2);
      const targetDiscoveryCache = mocks.loadSession.mock.calls[0]?.[1]?.targetDiscoveryCache;
      expect(targetDiscoveryCache).toBeInstanceOf(Map);
      expect(mocks.loadSession).toHaveBeenNthCalledWith(1, "main", {
        agentId,
        targetDiscoveryCache,
      });
      expect(mocks.loadSession.mock.calls[1]?.[1]?.targetDiscoveryCache).toBe(targetDiscoveryCache);
      expect(mocks.loadSession).toHaveBeenNthCalledWith(2, `agent:${agentId ?? "main"}:main`, {
        agentId: agentId ?? "main",
        targetDiscoveryCache,
      });
    },
  );

  it.each([undefined, "research"])(
    "shares store discovery across every personal session authority re-read for %s",
    (agentId) => {
      mocks.loadSession.mockReturnValue(sessionRead(agentId));
      const action = preparePersonalGitHubSessionAction(createRequest(), {
        sessionKey: "main",
        agentId,
      });
      action.assertCurrent();

      expect(mocks.loadSession).toHaveBeenCalledTimes(3);
      const targetDiscoveryCache = mocks.loadSession.mock.calls[0]?.[1]?.targetDiscoveryCache;
      expect(targetDiscoveryCache).toBeInstanceOf(Map);
      expect(mocks.loadSession).toHaveBeenNthCalledWith(1, "main", {
        agentId,
        targetDiscoveryCache,
      });
      for (const call of [2, 3]) {
        expect(mocks.loadSession.mock.calls[call - 1]?.[1]?.targetDiscoveryCache).toBe(
          targetDiscoveryCache,
        );
        expect(mocks.loadSession).toHaveBeenNthCalledWith(call, `agent:${agentId ?? "main"}:main`, {
          agentId: agentId ?? "main",
          targetDiscoveryCache,
        });
      }
    },
  );
});
