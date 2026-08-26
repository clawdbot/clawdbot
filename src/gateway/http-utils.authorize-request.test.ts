// HTTP authorization utility tests protect gateway request authorization,
// declared operator scopes, origin handling, and failure response routing.
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    gateway: {
      controlUi: {
        allowedOrigins: ["https://control.example.com"],
      },
    },
  })),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: vi.fn(() => ({
    gateway: {
      controlUi: {
        allowedOrigins: ["https://control.example.com"],
      },
    },
  })),
}));

// Export every binding http-auth-utils.js imports from http-common.js so this
// factory stays safe under isolate:false regardless of which paths execute.
vi.mock("./http-common.js", () => ({
  sendGatewayAuthFailure: vi.fn(),
  sendJson: vi.fn(),
  sendMissingScopeForbidden: vi.fn(),
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { getRuntimeConfig } = await import("../config/io.js");
const { sendGatewayAuthFailure } = await import("./http-common.js");
const profileStore = await import("../state/user-profiles.js");
const operatorRoles = await import("./operator-role-policy.js");
const { authorizeGatewayHttpRequestOrReply } = await import("./http-utils.js");

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("authorizeGatewayHttpRequestOrReply", () => {
  beforeEach(() => {
    vi.mocked(authorizeHttpGatewayConnect).mockReset();
    vi.mocked(sendGatewayAuthFailure).mockReset();
  });

  it("marks token-authenticated requests as untrusted for declared HTTP scopes", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "token",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        req: createReq({ authorization: "Bearer secret" }),
        res: {} as ServerResponse,
        auth: { mode: "trusted-proxy", allowTailscale: false, token: "secret" },
        trustedProxies: ["127.0.0.1"],
      }),
    ).resolves.toEqual({
      authMethod: "token",
      trustDeclaredOperatorScopes: false,
    });
  });

  it("keeps trusted-proxy requests eligible for declared HTTP scopes", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "trusted-proxy",
      user: "operator",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        req: createReq({ authorization: "Bearer upstream-idp-token" }),
        res: {} as ServerResponse,
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: { userHeader: "x-user" },
        },
        trustedProxies: ["127.0.0.1"],
      }),
    ).resolves.toEqual({
      authMethod: "trusted-proxy",
      user: "operator",
      trustDeclaredOperatorScopes: true,
    });
  });

  it("binds trusted-proxy requests to their canonical profile and effective role", async () => {
    const role = {
      sessions: { others: "view" as const },
      agents: ["guest"],
      scopes: ["operator.read" as const],
    };
    vi.mocked(getRuntimeConfig).mockReturnValue({
      gateway: {
        roles: { default: "guest", definitions: { guest: role } },
      },
    });
    const ensureProfile = vi.spyOn(profileStore, "ensureProfileForEmail").mockReturnValue({
      id: "profile-guest",
      displayName: "Guest",
      avatarMime: null,
      mergedInto: null,
      createdAt: 1,
      updatedAt: 2,
    });
    const profileDisplay = vi.spyOn(profileStore, "getUserProfileDisplay").mockReturnValue({
      id: "profile-guest",
      displayName: "Guest",
      avatarRevision: "2",
      hasAvatar: false,
    });
    const rolePolicy = vi
      .spyOn(operatorRoles, "resolveOperatorRolePolicyForProfile")
      .mockReturnValue(role);
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "trusted-proxy",
      user: "guest@example.test",
    });

    try {
      await expect(
        authorizeGatewayHttpRequestOrReply({
          req: createReq(),
          res: {} as ServerResponse,
          auth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-user" },
          },
        }),
      ).resolves.toMatchObject({
        user: "guest@example.test",
        authenticatedUserProfile: {
          profileId: "profile-guest",
          displayName: "Guest",
          avatarRevision: "2",
          hasAvatar: false,
          updatedAt: 2,
        },
        operatorRolePolicy: role,
      });
      expect(ensureProfile).toHaveBeenCalledWith("guest@example.test");
    } finally {
      ensureProfile.mockRestore();
      profileDisplay.mockRestore();
      rolePolicy.mockRestore();
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: { controlUi: { allowedOrigins: ["https://control.example.com"] } },
      });
    }
  });

  it("fails closed when a role-enabled trusted identity cannot resolve its profile", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "view" },
              agents: ["guest"],
              scopes: ["operator.read"],
            },
          },
        },
      },
    });
    const ensureProfile = vi.spyOn(profileStore, "ensureProfileForEmail").mockImplementation(() => {
      throw new Error("profile store unavailable");
    });
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "trusted-proxy",
      user: "guest@example.test",
    });
    const response = {} as ServerResponse;

    try {
      await expect(
        authorizeGatewayHttpRequestOrReply({
          req: createReq(),
          res: response,
          auth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-user" },
          },
        }),
      ).resolves.toBeNull();
      expect(sendGatewayAuthFailure).toHaveBeenCalledWith(response, {
        ok: false,
        reason: "user_profile_unavailable",
      });
    } finally {
      ensureProfile.mockRestore();
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: { controlUi: { allowedOrigins: ["https://control.example.com"] } },
      });
    }
  });

  it("rejects unbound device tokens when operator roles require durable identity", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "view" },
              agents: ["guest"],
              scopes: ["operator.read"],
            },
          },
        },
      },
    });
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "device-token",
    });
    const response = {} as ServerResponse;

    try {
      await expect(
        authorizeGatewayHttpRequestOrReply({
          req: createReq(),
          res: response,
          auth: { mode: "token", allowTailscale: false, token: "shared-secret" },
        }),
      ).resolves.toBeNull();
      expect(sendGatewayAuthFailure).toHaveBeenCalledWith(response, {
        ok: false,
        reason: "user_profile_unavailable",
      });
    } finally {
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: { controlUi: { allowedOrigins: ["https://control.example.com"] } },
      });
    }
  });

  it("preserves legacy device-token auth when no operator roles are configured", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "device-token",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        req: createReq(),
        res: {} as ServerResponse,
        auth: { mode: "token", allowTailscale: false, token: "shared-secret" },
      }),
    ).resolves.toEqual({ authMethod: "device-token", trustDeclaredOperatorScopes: true });
  });

  it.each(["trusted-proxy", "tailscale", "bootstrap-token"] as const)(
    "rejects identity-less %s authentication when operator roles require durable identity",
    async (method) => {
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: ["guest"],
                scopes: ["operator.read"],
              },
            },
          },
        },
      });
      vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true, method });
      const response = {} as ServerResponse;

      try {
        await expect(
          authorizeGatewayHttpRequestOrReply({
            req: createReq(),
            res: response,
            auth: { mode: "token", allowTailscale: false, token: "shared-secret" },
          }),
        ).resolves.toBeNull();
        expect(sendGatewayAuthFailure).toHaveBeenCalledWith(response, {
          ok: false,
          reason: "user_profile_unavailable",
        });
      } finally {
        vi.mocked(getRuntimeConfig).mockReturnValue({
          gateway: { controlUi: { allowedOrigins: ["https://control.example.com"] } },
        });
      }
    },
  );

  it("preserves shared-secret owner authentication when operator roles are configured", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              sessions: { others: "none" },
              agents: ["guest"],
              scopes: ["operator.read"],
            },
          },
        },
      },
    });
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true, method: "token" });

    try {
      await expect(
        authorizeGatewayHttpRequestOrReply({
          req: createReq({ authorization: "Bearer shared-secret" }),
          res: {} as ServerResponse,
          auth: { mode: "token", allowTailscale: false, token: "shared-secret" },
        }),
      ).resolves.toEqual({ authMethod: "token", trustDeclaredOperatorScopes: false });
    } finally {
      vi.mocked(getRuntimeConfig).mockReturnValue({
        gateway: { controlUi: { allowedOrigins: ["https://control.example.com"] } },
      });
    }
  });

  it("forwards browser-origin policy into HTTP auth", async () => {
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: true,
      method: "trusted-proxy",
      user: "operator",
    });

    await authorizeGatewayHttpRequestOrReply({
      req: createReq({
        host: "gateway.example.com",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      }),
      res: {} as ServerResponse,
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: { userHeader: "x-user" },
      },
      trustedProxies: ["127.0.0.1"],
    });

    const [authParams] = vi.mocked(authorizeHttpGatewayConnect).mock.calls.at(-1) ?? [];
    if (authParams === undefined) {
      throw new Error("Expected HTTP gateway auth to be called");
    }
    expect(authParams.browserOriginPolicy).toEqual({
      requestHost: "gateway.example.com",
      origin: "https://evil.example",
      fetchSite: "cross-site",
      allowedOrigins: ["https://control.example.com"],
      allowHostHeaderOriginFallback: false,
    });
  });

  it("replies with auth failure and returns null when auth fails", async () => {
    const res = {} as ServerResponse;
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({
      ok: false,
      reason: "unauthorized",
    });

    await expect(
      authorizeGatewayHttpRequestOrReply({
        req: createReq(),
        res,
        auth: { mode: "token", allowTailscale: false, token: "secret" },
      }),
    ).resolves.toBeNull();

    expect(sendGatewayAuthFailure).toHaveBeenCalledWith(res, {
      ok: false,
      reason: "unauthorized",
    });
  });
});
