import type { EnterpriseIdentityProviderAdapter } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Entra enterprise identity plugin", () => {
  it("resolves the confidential client secret through the Gateway config snapshot", async () => {
    vi.stubEnv("ENTRA_MEMORY_CLIENT_SECRET", "entra-client-secret");
    const registerEnterpriseIdentityProvider = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "memory-identity-entra",
        name: "Microsoft Entra ID Memory Identity",
        config: { secrets: { providers: { default: { source: "env" } } } },
        pluginConfig: {
          tenantId: "00000000-0000-0000-0000-000000000010",
          clientId: "00000000-0000-0000-0000-000000000011",
          clientSecret: { source: "env", provider: "default", id: "ENTRA_MEMORY_CLIENT_SECRET" },
          redirectUri: "https://gateway.example/memory/oidc/callback",
          roleGroupIds: ["00000000-0000-0000-0000-000000000012"],
        },
        registerEnterpriseIdentityProvider,
      }),
    );

    const provider = registerEnterpriseIdentityProvider.mock.calls[0]?.[0] as
      | EnterpriseIdentityProviderAdapter
      | undefined;
    await expect(provider?.resolveAuthorizationCodeClientSecret?.()).resolves.toBe(
      "entra-client-secret",
    );
  });
});
