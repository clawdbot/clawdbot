// Verifies OAuth profile refresh failures stay terminal across provider fallback sources.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";

const authProfileMocks = vi.hoisted(() => ({
  resolveApiKeyForProfile: vi.fn(),
}));

vi.mock("./auth-profiles.js", async (importActual) => {
  const actual = await importActual<typeof import("./auth-profiles.js")>();
  return {
    ...actual,
    resolveApiKeyForProfile: authProfileMocks.resolveApiKeyForProfile,
  };
});

const { resolveApiKeyForProvider } = await import("./model-auth.js");

function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  });
}

afterEach(() => {
  authProfileMocks.resolveApiKeyForProfile.mockReset();
});

describe("resolveApiKeyForProvider OAuth refresh failure ordering", () => {
  it("does not fall back to env after a configured OAuth profile refresh fails", async () => {
    const profileId = "openai:oauth-refresh";
    const refreshFailure = new OAuthRefreshFailureError({
      provider: "openai",
      profileId,
      message: "OAuth token refresh failed for openai: expired refresh credential",
    });
    authProfileMocks.resolveApiKeyForProfile.mockRejectedValueOnce(refreshFailure);
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: Date.now() - 60_000,
        },
      },
    };
    const request = vi.fn();

    await withEnv("OPENAI_API_KEY", "fallback-must-not-be-used", async () => {
      await expect(
        (async () => {
          const auth = await resolveApiKeyForProvider({
            provider: "openai",
            cfg: {
              auth: {
                order: {
                  openai: [profileId],
                },
              },
            },
            store,
          });
          await request(auth);
        })(),
      ).rejects.toBe(refreshFailure);
    });
    expect(request).not.toHaveBeenCalled();
    expect(authProfileMocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId }),
    );
  });
});
