// Verifies exact-profile provider usage reads stay token-free and fail closed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderAuthProfileMock = vi.fn();
const resolveProviderUsageAuthWithPluginMock = vi.fn();
const resolveProviderUsageSnapshotWithPluginMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("./provider-usage.auth.js", () => ({
  resolveProviderAuthProfile: (...args: unknown[]) => resolveProviderAuthProfileMock(...args),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderUsageAuthWithPlugin: (...args: unknown[]) =>
    resolveProviderUsageAuthWithPluginMock(...args),
  resolveProviderUsageSnapshotWithPlugin: (...args: unknown[]) =>
    resolveProviderUsageSnapshotWithPluginMock(...args),
}));

vi.mock("./fetch.js", () => ({
  resolveFetch: () => fetchMock,
}));

vi.mock("./net/proxy-fetch.js", () => ({
  resolveProxyFetchFromEnv: () => undefined,
}));

import { readProviderUsageProfile } from "./provider-usage.profile.js";

describe("readProviderUsageProfile", () => {
  beforeEach(() => {
    resolveProviderAuthProfileMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(undefined);
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    fetchMock.mockReset();
    resolveProviderAuthProfileMock.mockResolvedValue({
      provider: "openai",
      token: "private-token",
      credentialType: "oauth",
      authProfileId: "openai:work",
      accountId: "account-1",
      email: "private@example.com",
    });
  });

  it("reads one exact profile through the provider fetch hook and strips identity", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue({
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 25 }],
      accountEmail: "private@example.com",
      token: "must-not-escape",
    });

    const result = await readProviderUsageProfile({
      providerId: "openai",
      authProfileId: "openai:work",
      includeIdentity: false,
      refreshCredentials: false,
      timeoutMs: 5_000,
    });

    expect(resolveProviderAuthProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        authProfileId: "openai:work",
      }),
    );
    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        context: expect.objectContaining({
          provider: "openai",
          token: "private-token",
          authProfileId: "openai:work",
          exactProfileRead: true,
          accountId: "account-1",
          email: "private@example.com",
          timeoutMs: 5_000,
        }),
      }),
    );
    expect(result).toMatchObject({
      provider: "openai",
      authProfileId: "openai:work",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 25 }],
    });
    expect(result.capturedAt).toEqual(expect.any(Number));
    expect(result).not.toHaveProperty("accountEmail");
    expect(result).not.toHaveProperty("token");
  });

  it("routes the exact OAuth profile through provider auth policy before fetching", async () => {
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(async (rawParams) => {
      const params = rawParams as {
        context: {
          env: NodeJS.ProcessEnv;
          resolveApiKeyFromConfigAndStore: (request?: {
            providerIds?: string[];
          }) => string | undefined;
          resolveApiKeyCandidatesFromConfigAndStore: (request?: {
            providerIds?: string[];
          }) => Promise<string[]>;
          resolveOAuthToken: () => Promise<{
            token: string;
            accountId?: string;
            email?: string;
          } | null>;
        };
      };
      expect(params.context.env).toEqual({});
      expect(params.context.resolveApiKeyFromConfigAndStore()).toBeUndefined();
      await expect(params.context.resolveApiKeyCandidatesFromConfigAndStore()).resolves.toEqual([]);
      await expect(params.context.resolveOAuthToken()).resolves.toEqual({
        token: "private-token",
        accountId: "account-1",
        email: "private@example.com",
      });
      return { token: "provider-policy-token", accountId: "policy-account" };
    });
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue({
      provider: "openai",
      displayName: "OpenAI",
      windows: [],
    });

    await readProviderUsageProfile(
      {
        providerId: "openai",
        authProfileId: "openai:work",
        includeIdentity: false,
        refreshCredentials: false,
      },
      { env: { OPENAI_ADMIN_KEY: "ambient-admin-key" } },
    );

    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        context: expect.objectContaining({
          token: "provider-policy-token",
          accountId: "policy-account",
        }),
      }),
    );
  });

  it("stops when provider policy rejects the exact API-key profile", async () => {
    resolveProviderAuthProfileMock.mockResolvedValueOnce({
      provider: "openai",
      token: "inference-key",
      credentialType: "api_key",
      authProfileId: "openai:work",
    });
    resolveProviderUsageAuthWithPluginMock.mockImplementationOnce(async (rawParams) => {
      const params = rawParams as {
        context: {
          env: NodeJS.ProcessEnv;
          resolveApiKeyFromConfigAndStore: (request?: {
            providerIds?: string[];
          }) => string | undefined;
          resolveApiKeyCandidatesFromConfigAndStore: (request?: {
            providerIds?: string[];
          }) => Promise<string[]>;
          resolveOAuthToken: () => Promise<unknown>;
        };
      };
      expect(params.context.env).toEqual({});
      expect(params.context.resolveApiKeyFromConfigAndStore()).toBe("inference-key");
      expect(
        params.context.resolveApiKeyFromConfigAndStore({ providerIds: ["anthropic"] }),
      ).toBeUndefined();
      expect(params.context.resolveApiKeyFromConfigAndStore({ providerIds: ["openai"] })).toBe(
        "inference-key",
      );
      await expect(params.context.resolveApiKeyCandidatesFromConfigAndStore()).resolves.toEqual([
        "inference-key",
      ]);
      await expect(
        params.context.resolveApiKeyCandidatesFromConfigAndStore({ providerIds: ["anthropic"] }),
      ).resolves.toEqual([]);
      await expect(params.context.resolveOAuthToken()).resolves.toBeNull();
      return { handled: true };
    });

    await expect(
      readProviderUsageProfile(
        {
          providerId: "openai",
          authProfileId: "openai:work",
          includeIdentity: false,
          refreshCredentials: false,
        },
        { env: { OPENAI_ADMIN_KEY: "ambient-admin-key" } },
      ),
    ).resolves.toMatchObject({
      provider: "openai",
      authProfileId: "openai:work",
      windows: [],
      error: "Provider usage auth unavailable",
    });
    expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
  });

  it("fails closed when the exact auth profile cannot be resolved", async () => {
    resolveProviderAuthProfileMock.mockResolvedValue(null);

    await expect(
      readProviderUsageProfile({
        providerId: "openai",
        authProfileId: "openai:missing",
        includeIdentity: false,
        refreshCredentials: false,
      }),
    ).rejects.toThrow(/auth profile unavailable/i);
    expect(resolveProviderUsageSnapshotWithPluginMock).not.toHaveBeenCalled();
  });

  it.each([
    { requestedProvider: "claude-cli", canonicalProvider: "anthropic" },
    { requestedProvider: "minimax-portal", canonicalProvider: "minimax" },
  ])(
    "normalizes $requestedProvider to the canonical $canonicalProvider usage owner",
    async ({ requestedProvider, canonicalProvider }) => {
      resolveProviderAuthProfileMock.mockResolvedValueOnce({
        provider: canonicalProvider,
        token: "profile-token",
        credentialType: "oauth",
        authProfileId: `${requestedProvider}:work`,
      });
      resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
        provider: canonicalProvider,
        displayName: canonicalProvider,
        windows: [],
      });

      await expect(
        readProviderUsageProfile({
          providerId: requestedProvider,
          authProfileId: `${requestedProvider}:work`,
          includeIdentity: false,
          refreshCredentials: false,
        }),
      ).resolves.toMatchObject({
        provider: canonicalProvider,
        authProfileId: `${requestedProvider}:work`,
      });
      expect(resolveProviderAuthProfileMock).toHaveBeenCalledWith(
        expect.objectContaining({ provider: canonicalProvider }),
      );
      expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: canonicalProvider,
          context: expect.objectContaining({ provider: canonicalProvider }),
        }),
      );
    },
  );

  it("rejects provider-mismatched snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue({
      provider: "anthropic",
      displayName: "Anthropic",
      windows: [],
    });

    await expect(
      readProviderUsageProfile({
        providerId: "openai",
        authProfileId: "openai:work",
        includeIdentity: false,
        refreshCredentials: false,
      }),
    ).rejects.toThrow(/provider mismatch/i);
  });

  it("rejects identity inclusion and credential refresh requests", async () => {
    for (const includeIdentity of [true, "false", 1]) {
      await expect(
        readProviderUsageProfile({
          providerId: "openai",
          authProfileId: "openai:work",
          includeIdentity,
          refreshCredentials: false,
        } as never),
      ).rejects.toThrow(/identity/i);
    }
    for (const refreshCredentials of [true, "false", 1]) {
      await expect(
        readProviderUsageProfile({
          providerId: "openai",
          authProfileId: "openai:work",
          includeIdentity: false,
          refreshCredentials,
        } as never),
      ).rejects.toThrow(/refresh/i);
    }
    expect(resolveProviderAuthProfileMock).not.toHaveBeenCalled();
  });
});
