// Msteams tests cover channelirectory plugin behavior.
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import { msteamsPlugin } from "./channel.js";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";

const msteamsDirectoryAdapter = msteamsPlugin.directory;

function requireDirectorySelf(): NonNullable<NonNullable<typeof msteamsDirectoryAdapter>["self"]> {
  const directorySelf = msteamsDirectoryAdapter?.self;
  if (!directorySelf) {
    throw new Error("expected msteams directory.self");
  }
  return directorySelf;
}

describe("msteams directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as RuntimeEnv;
  const directorySelf = requireDirectorySelf();

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("self()", () => {
    it("returns bot identity when credentials are configured", async () => {
      const cfg = {
        channels: {
          msteams: {
            appId: "test-app-id-1234",
            appPassword: "secret",
            tenantId: "tenant-id-5678",
          },
        },
      } as unknown as OpenClawConfig;

      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toEqual({ kind: "user", id: "test-app-id-1234", name: "test-app-id-1234" });
    });

    it("returns null when credentials are not configured", async () => {
      vi.stubEnv("MSTEAMS_APP_ID", "");
      vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
      vi.stubEnv("MSTEAMS_TENANT_ID", "");
      const cfg = { channels: {} } as unknown as OpenClawConfig;
      const result = await directorySelf({ cfg, runtime: runtimeEnv });
      expect(result).toBeNull();
    });

    it("does not use default env credentials for a named default account", async () => {
      vi.stubEnv("MSTEAMS_APP_ID", "env-default-app");
      vi.stubEnv("MSTEAMS_APP_PASSWORD", "env-default-secret");
      vi.stubEnv("MSTEAMS_TENANT_ID", "env-default-tenant");
      const cfg = {
        channels: {
          msteams: {
            defaultAccount: "support",
            accounts: {
              support: {
                appId: "support-app-id",
                tenantId: "support-tenant-id",
                webhook: { port: 3979 },
              },
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expect(directorySelf({ cfg, runtime: runtimeEnv })).resolves.toBeNull();
    });
  });

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["alice", "user:Bob"],
          dms: { carol: {}, bob: {} },
          teams: {
            team1: {
              channels: {
                "conversation:chan1": {},
                chan2: {},
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(msteamsDirectoryAdapter);

    const peers = await directory.listPeers({
      cfg,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(peers).toStrictEqual([
      { kind: "user", id: "user:alice" },
      { kind: "user", id: "user:Bob" },
      { kind: "user", id: "user:carol" },
      { kind: "user", id: "user:bob" },
    ]);

    const groups = await directory.listGroups({
      cfg,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(groups).toStrictEqual([
      { kind: "group", id: "conversation:chan1" },
      { kind: "group", id: "conversation:chan2" },
    ]);
  });

  it("normalizes spaced allowlist and dm entries", async () => {
    const cfg = {
      channels: {
        msteams: {
          allowFrom: ["  user:Bob  ", "  Alice  "],
          dms: { "  Carol  ": {}, "user:Dave": {} },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(msteamsDirectoryAdapter);

    const peers = await directory.listPeers({
      cfg,
      query: undefined,
      limit: undefined,
      runtime: runtimeEnv,
    });
    expect(peers).toStrictEqual([
      { kind: "user", id: "user:Bob" },
      { kind: "user", id: "user:Alice" },
      { kind: "user", id: "user:Carol" },
      { kind: "user", id: "user:Dave" },
    ]);
  });
});

describe("msteams session route", () => {
  it("builds direct routes for explicit user targets", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:user:01234567-89ab-cdef-0123-456789abcdef",
    });

    expect(route?.peer).toEqual({
      kind: "direct",
      id: "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(route?.from).toBe("msteams:01234567-89ab-cdef-0123-456789abcdef");
    expect(route?.to).toBe("user:01234567-89ab-cdef-0123-456789abcdef");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("does not claim display-name user targets as canonical sessions", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:user:Alice Example",
      resolvedTarget: { to: "user:Alice Example", kind: "user", source: "directory" },
    });

    expect(route?.recipientSessionExact).toBe(false);
  });

  it.each(["29:1a2b3c4d5e6f", "8:orgid:2d8c2d2c-1111-2222-3333-444444444444"])(
    "does not claim Bot Framework user id %s as the canonical AAD session",
    (userId) => {
      const route = resolveMSTeamsOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target: `msteams:user:${userId}`,
      });

      expect(route?.recipientSessionExact).toBe(false);
    },
  );

  it("builds channel routes for thread conversations and strips suffix metadata", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "teams:19:abc123@thread.tacv2;messageid=42",
    });

    expect(route?.peer).toEqual({ kind: "channel", id: "19:abc123@thread.tacv2" });
    expect(route?.from).toBe("msteams:channel:19:abc123@thread.tacv2");
    expect(route?.to).toBe("conversation:19:abc123@thread.tacv2");
    expect(route?.sessionKey).toBe("agent:main:msteams:channel:19:abc123@thread.tacv2:thread:42");
    expect(route?.threadId).toBe("42");
    expect(route?.recipientSessionExact).toBe(true);
  });

  it("does not claim an exact channel session without its thread root", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "teams:19:abc123@thread.tacv2",
    });

    expect(route?.sessionKey).toBe("agent:main:msteams:channel:19:abc123@thread.tacv2");
    expect(route?.recipientSessionExact).toBe(false);
  });

  it("returns group routes for non-user, non-channel conversations", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:conversation:19:groupchat",
    });

    expect(route?.peer).toEqual({ kind: "group", id: "19:groupchat" });
    expect(route?.from).toBe("msteams:group:19:groupchat");
    expect(route?.to).toBe("conversation:19:groupchat");
    expect(route?.recipientSessionExact).toBe(false);
  });

  it("returns null when the target cannot be normalized", () => {
    expect(
      resolveMSTeamsOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target: "msteams:",
      }),
    ).toBeNull();
  });
});
