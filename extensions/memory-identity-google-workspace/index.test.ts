import type { EnterpriseIdentityProviderAdapter } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const getAccessToken = vi.hoisted(() => vi.fn());

vi.mock("google-auth-library", () => ({
  JWT: class {
    getAccessToken = getAccessToken;
  },
}));

import plugin from "./index.js";

const directoryServiceAccount = JSON.stringify({
  client_email: "directory-reader@example.iam.gserviceaccount.com",
  private_key: "test-private-key",
});

afterEach(() => {
  getAccessToken.mockReset();
  vi.unstubAllEnvs();
});

describe("Google Workspace enterprise identity plugin", () => {
  it("resolves env SecretRefs through the plugin entry before code and directory exchanges", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_DIRECTORY_SERVICE_ACCOUNT", directoryServiceAccount);
    vi.stubEnv("GOOGLE_WORKSPACE_CLIENT_SECRET", "workspace-client-secret");
    getAccessToken.mockResolvedValue({ token: "directory-access-token" });
    const registerEnterpriseIdentityProvider = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "memory-identity-google-workspace",
        name: "Google Workspace Memory Identity",
        config: { secrets: { providers: { default: { source: "env" } } } },
        pluginConfig: {
          hostedDomain: "example.com",
          clientId: "client-id",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "GOOGLE_WORKSPACE_CLIENT_SECRET",
          },
          redirectUri: "https://gateway.example/memory/oidc/callback",
          delegatedAdminEmail: "admin@example.com",
          directoryServiceAccount: {
            source: "env",
            provider: "default",
            id: "GOOGLE_WORKSPACE_DIRECTORY_SERVICE_ACCOUNT",
          },
          roleGroupResourceNames: ["groups/writers"],
        },
        registerEnterpriseIdentityProvider,
      }),
    );

    const provider = registerEnterpriseIdentityProvider.mock.calls[0]?.[0] as
      | EnterpriseIdentityProviderAdapter
      | undefined;
    expect(provider).toBeDefined();
    await expect(provider?.resolveAuthorizationCodeClientSecret?.()).resolves.toBe(
      "workspace-client-secret",
    );
    await expect(provider?.acquireDirectoryAccessToken?.()).resolves.toEqual({
      kind: "available",
      accessToken: "directory-access-token",
    });
    expect(getAccessToken).toHaveBeenCalledOnce();
  });
});
