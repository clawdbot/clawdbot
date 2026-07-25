// Verifies exact-profile provider usage reads stay token-free and fail closed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderAuthProfileMock = vi.fn();
const resolveProviderUsageSnapshotWithPluginMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("./provider-usage.auth.js", () => ({
  resolveProviderAuthProfile: (...args: unknown[]) => resolveProviderAuthProfileMock(...args),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
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
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    fetchMock.mockReset();
    resolveProviderAuthProfileMock.mockResolvedValue({
      provider: "openai",
      token: "private-token",
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
