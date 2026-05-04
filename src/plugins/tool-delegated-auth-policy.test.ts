import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedPluginsConfig } from "./config-state.js";
import { resolveDelegatedAuthForPlugin } from "./tool-delegated-auth-policy.js";

function createJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

function createPluginsConfig(
  delegatedAccess: NonNullable<
    NormalizedPluginsConfig["entries"][string]["auth"]
  >["delegatedAccess"],
): NormalizedPluginsConfig {
  return {
    enabled: true,
    allow: [],
    deny: [],
    loadPaths: [],
    slots: {},
    entries: {
      demo: {
        auth: { delegatedAccess },
      },
    },
  };
}

describe("plugin delegated auth policy", () => {
  it("does not expose auth without both policy enablement and a turn provider", () => {
    const plugins = createPluginsConfig({ enabled: true });

    expect(
      resolveDelegatedAuthForPlugin({
        auth: undefined,
        chatType: "direct",
        pluginId: "demo",
        plugins,
      }),
    ).toBeUndefined();
    expect(
      resolveDelegatedAuthForPlugin({
        auth: { getDelegatedAccessToken: vi.fn() },
        chatType: "direct",
        pluginId: "other",
        plugins,
      }),
    ).toBeUndefined();
  });

  it("enforces provider, audience, scope, and chat-type allowlists", async () => {
    const getDelegatedAccessToken = vi.fn(async () => ({
      ok: true as const,
      token: createJwt({
        aud: "api://11111111-2222-3333-4444-555555555555",
        scp: "profile.read extra.scope",
      }),
    }));
    const auth = resolveDelegatedAuthForPlugin({
      auth: { getDelegatedAccessToken },
      chatType: "direct",
      pluginId: "demo",
      plugins: createPluginsConfig({
        enabled: true,
        providers: ["msteams"],
        audiences: ["11111111-2222-3333-4444-555555555555"],
        scopes: ["profile.read"],
        chatTypes: ["direct"],
      }),
    });

    await expect(
      auth?.getDelegatedAccessToken({
        provider: "msteams",
        audience: "api://11111111-2222-3333-4444-555555555555",
        scopes: ["profile.read"],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      auth?.getDelegatedAccessToken({
        provider: "other",
        audience: "api://11111111-2222-3333-4444-555555555555",
        scopes: ["profile.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "not_configured" });
    expect(getDelegatedAccessToken).toHaveBeenCalledTimes(1);
  });

  it("normalizes Entra application audiences while rejecting missing requested scopes", async () => {
    const auth = resolveDelegatedAuthForPlugin({
      auth: {
        getDelegatedAccessToken: vi.fn(async () => ({
          ok: true as const,
          token: createJwt({
            aud: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
            scp: "other.scope",
          }),
        })),
      },
      chatType: "direct",
      pluginId: "demo",
      plugins: createPluginsConfig({
        enabled: true,
        audiences: ["api://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
        scopes: ["profile.read"],
      }),
    });

    await expect(
      auth?.getDelegatedAccessToken({
        provider: "msteams",
        audience: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        scopes: ["profile.read"],
      }),
    ).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("rejects delegated auth outside configured chat types", async () => {
    const getDelegatedAccessToken = vi.fn();
    const auth = resolveDelegatedAuthForPlugin({
      auth: { getDelegatedAccessToken },
      chatType: "group",
      pluginId: "demo",
      plugins: createPluginsConfig({
        enabled: true,
        chatTypes: ["direct"],
      }),
    });

    await expect(auth?.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(getDelegatedAccessToken).not.toHaveBeenCalled();
  });
});
