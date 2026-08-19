import type { EnterpriseIdentityProviderAdapter } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Okta enterprise identity plugin", () => {
  it("resolves the confidential client secret through the Gateway config snapshot", async () => {
    vi.stubEnv("OKTA_MEMORY_CLIENT_SECRET", "okta-client-secret");
    const registerEnterpriseIdentityProvider = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "memory-identity-okta",
        name: "Okta Memory Identity",
        config: { secrets: { providers: { default: { source: "env" } } } },
        pluginConfig: {
          issuer: "https://example.okta.com/oauth2/memory",
          clientId: "client-id",
          clientSecret: { source: "env", provider: "default", id: "OKTA_MEMORY_CLIENT_SECRET" },
          redirectUri: "https://gateway.example/memory/oidc/callback",
          groupIdsClaim: "openclaw_group_ids",
          roleGroupIds: ["00g00000000000000001"],
        },
        registerEnterpriseIdentityProvider,
      }),
    );

    const provider = registerEnterpriseIdentityProvider.mock.calls[0]?.[0] as
      | EnterpriseIdentityProviderAdapter
      | undefined;
    await expect(provider?.resolveAuthorizationCodeClientSecret?.()).resolves.toBe(
      "okta-client-secret",
    );
  });
});
