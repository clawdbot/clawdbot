/**
 * Tests auth profile API-key resolution.
 * Covers token/api-key/OAuth profile compatibility, SecretRefs, and provider
 * runtime formatting behavior.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAuthProfileSecretOwnerId } from "../../secrets/runtime-auth-profile-owner.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { AuthProfileStore } from "./types.js";

vi.hoisted(() => {
  vi.resetModules();
});

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: async (params: { context?: { access?: string } }) =>
    params.context?.access,
  refreshProviderOAuthCredentialWithPlugin: async () => null,
}));

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./runtime-snapshots.js").clearRuntimeAuthProfileStoreSnapshots;
let setRuntimeAuthProfileStoreSnapshot: typeof import("./runtime-snapshots.js").setRuntimeAuthProfileStoreSnapshot;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile } = await import("./oauth.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots, setRuntimeAuthProfileStoreSnapshot } =
    await import("./runtime-snapshots.js"));
}

function cfgFor(profileId: string, provider: string, mode: "api_key" | "token" | "oauth") {
  return {
    auth: {
      profiles: {
        [profileId]: { provider, mode },
      },
    },
  } satisfies OpenClawConfig;
}

function tokenStore(params: {
  profileId: string;
  provider: string;
  token?: string;
  expires?: number;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "token",
        provider: params.provider,
        token: params.token,
        ...(params.expires !== undefined ? { expires: params.expires } : {}),
      },
    },
  };
}

function githubCopilotTokenStore(profileId: string, includeInlineToken = true): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "token",
        provider: "github-copilot",
        ...(includeInlineToken ? { token: "" } : {}),
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
    },
  };
}

async function resolveWithConfig(params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  store: AuthProfileStore;
}) {
  return resolveApiKeyForProfile({
    cfg: cfgFor(params.profileId, params.provider, params.mode),
    store: params.store,
    profileId: params.profileId,
  });
}

async function withEnvVar<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ [key]: value }, run);
}

async function expectResolvedApiKey(params: {
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  store: AuthProfileStore;
  expectedApiKey: string;
}) {
  const result = await resolveApiKeyForProfile({
    cfg: cfgFor(params.profileId, params.provider, params.mode),
    store: params.store,
    profileId: params.profileId,
  });
  expect(result).toEqual({
    apiKey: params.expectedApiKey, // pragma: allowlist secret
    provider: params.provider,
    email: undefined,
  });
}

beforeAll(loadOAuthModuleForTest);

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
  // SecretRef cases consume the materialized store published by runtime activation.
  setRuntimeAuthProfileStoreSnapshot({
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: ["sk", "openai", "ref"].join("-"),
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      "openai:inline-env": {
        type: "api_key",
        provider: "openai",
        key: ["sk", "openai", "inline"].join("-"),
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
      "github-copilot:default": {
        type: "token",
        provider: "github-copilot",
        token: ["gh", "ref", "token"].join("-"),
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
      "github-copilot:no-inline-token": {
        type: "token",
        provider: "github-copilot",
        token: ["gh", "ref", "token"].join("-"),
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
      "github-copilot:inline-env": {
        type: "token",
        provider: "github-copilot",
        token: ["gh", "inline", "token"].join("-"),
        tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
      },
    },
  });
});

afterAll(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.resetModules();
});

function createUsableOAuthExpiry(): number {
  return Date.now() + 30 * 60 * 1000;
}

describe("resolveApiKeyForProfile config compatibility", () => {
  it("accepts token credentials when config mode is oauth", async () => {
    const profileId = "anthropic:token";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "token",
          provider: "anthropic",
          token: "tok-123",
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "oauth"),
      store,
      profileId,
    });
    expect(result).toEqual({
      apiKey: "tok-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("rejects token credentials when config mode is api_key", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "api_key",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });

    expect(result).toBeNull();
  });

  it("rejects credentials when provider does not match config", async () => {
    const profileId = "anthropic:token";
    const result = await resolveWithConfig({
      profileId,
      provider: "openai",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toBeNull();
  });

  it("accepts oauth credentials when config mode is token (bidirectional compat)", async () => {
    const profileId = "anthropic:oauth";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "anthropic",
          access: "access-123",
          refresh: "refresh-123",
          expires: createUsableOAuthExpiry(),
        },
      },
    };

    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "anthropic", "token"),
      store,
      profileId,
    });
    // token ↔ oauth are bidirectionally compatible bearer-token auth paths.
    expect(result).toEqual({
      apiKey: "access-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });
});

describe("resolveApiKeyForProfile token expiry handling", () => {
  it("accepts token credentials when expires is undefined", async () => {
    const profileId = "anthropic:token-no-expiry";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
      }),
    });
    expect(result).toEqual({
      apiKey: "tok-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("accepts token credentials when expires is in the future", async () => {
    const profileId = "anthropic:token-valid-expiry";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
        expires: Date.now() + 60_000,
      }),
    });
    expect(result).toEqual({
      apiKey: "tok-123", // pragma: allowlist secret
      provider: "anthropic",
      email: undefined,
    });
  });

  it("returns null for expired token credentials", async () => {
    const profileId = "anthropic:token-expired";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-expired",
        expires: Date.now() - 1_000,
      }),
    });
    expect(result).toBeNull();
  });

  it("returns null for token credentials when expires is 0", async () => {
    const profileId = "anthropic:token-no-expiry";
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store: tokenStore({
        profileId,
        provider: "anthropic",
        token: "tok-123",
        expires: 0,
      }),
    });
    expect(result).toBeNull();
  });

  it("returns null for token credentials when expires is invalid (NaN)", async () => {
    const profileId = "anthropic:token-invalid-expiry";
    const store = tokenStore({
      profileId,
      provider: "anthropic",
      token: "tok-123",
    });
    store.profiles[profileId] = {
      ...store.profiles[profileId],
      type: "token",
      provider: "anthropic",
      token: "tok-123",
      expires: Number.NaN,
    };
    const result = await resolveWithConfig({
      profileId,
      provider: "anthropic",
      mode: "token",
      store,
    });
    expect(result).toBeNull();
  });

  it("uses current expired metadata before applying degraded owner state", async () => {
    const profileId = "github-copilot:expired-ref";
    const tokenRef = { source: "env" as const, provider: "default", id: "EXPIRED_TOKEN" };
    setRuntimeAuthProfileStoreSnapshot({
      version: 1,
      profiles: {
        [profileId]: {
          type: "token",
          provider: "github-copilot",
          token: "unused",
          tokenRef,
          expires: Date.now() + 60_000,
        },
      },
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: resolveAuthProfileSecretOwnerId({ profileId }),
        state: "unavailable",
        paths: [`auth-profiles.${profileId}.token`],
        refKeys: ["env:default:EXPIRED_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);

    await expect(
      resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "github-copilot", "token"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "github-copilot",
              tokenRef,
              expires: Date.now() - 1,
            },
          },
        },
        profileId,
      }),
    ).resolves.toBeNull();
  });
});

describe("resolveApiKeyForProfile secret refs", () => {
  it("ignores blank api_key credentials", async () => {
    const profileId = "openrouter:default";
    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "openrouter", "api_key"),
      store: {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "openrouter",
            key: "   ",
          },
        },
      },
      profileId,
    });

    expect(result).toBeNull();
  });

  it("resolves api_key keyRef from env", async () => {
    const profileId = "openai:default";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-ref"; // pragma: allowlist secret
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "sk-openai-ref", // pragma: allowlist secret
        provider: "openai",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("normalizes inline api_key values from auth profiles before header use", async () => {
    const profileId = "openrouter:masked";
    const result = await resolveApiKeyForProfile({
      cfg: cfgFor(profileId, "openrouter", "api_key"),
      store: {
        version: 1,
        profiles: {
          [profileId]: {
            type: "api_key",
            provider: "openrouter",
            key: " sk-or-\u202650ec ",
          },
        },
      },
      profileId,
    });

    expect(result).toEqual({
      apiKey: "sk-or-50ec", // pragma: allowlist secret
      provider: "openrouter",
      email: undefined,
    });
  });

  it("resolves token tokenRef from env", async () => {
    const profileId = "github-copilot:default";
    await withEnvVar("GITHUB_TOKEN", "gh-ref-token", async () => {
      await expectResolvedApiKey({
        profileId,
        provider: "github-copilot",
        mode: "token",
        store: githubCopilotTokenStore(profileId),
        expectedApiKey: "gh-ref-token", // pragma: allowlist secret
      });
    });
  });

  it("resolves token tokenRef without inline token when expires is absent", async () => {
    const profileId = "github-copilot:no-inline-token";
    await withEnvVar("GITHUB_TOKEN", "gh-ref-token", async () => {
      await expectResolvedApiKey({
        profileId,
        provider: "github-copilot",
        mode: "token",
        store: githubCopilotTokenStore(profileId, false),
        expectedApiKey: "gh-ref-token", // pragma: allowlist secret
      });
    });
  });

  it("hard-fails when oauth mode is combined with token SecretRef input", async () => {
    const profileId = "anthropic:oauth-secretref-token";
    await expect(
      resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "anthropic", "oauth"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "anthropic",
              tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
            },
          },
        },
        profileId,
      }),
    ).rejects.toThrow(/mode is "oauth"/i);
  });

  it("resolves inline ${ENV} api_key values", async () => {
    const profileId = "openai:inline-env";
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-inline"; // pragma: allowlist secret
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "openai",
              key: "${OPENAI_API_KEY}",
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "sk-openai-inline", // pragma: allowlist secret
        provider: "openai",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  });

  it("resolves inline ${ENV} token values", async () => {
    const profileId = "github-copilot:inline-env";
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "gh-inline-token";
    try {
      const result = await resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "github-copilot", "token"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "github-copilot",
              token: "${GITHUB_TOKEN}",
            },
          },
        },
        profileId,
      });
      expect(result).toEqual({
        apiKey: "gh-inline-token", // pragma: allowlist secret
        provider: "github-copilot",
        email: undefined,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previous;
      }
    }
  });

  it("does not materialize an explicit ref at request time", async () => {
    const profileId = "openai:unpublished";
    await expect(
      resolveApiKeyForProfile({
        cfg: cfgFor(profileId, "openai", "api_key"),
        store: {
          version: 1,
          profiles: {
            [profileId]: {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "UNPUBLISHED_OPENAI_KEY" },
            },
          },
        },
        profileId,
      }),
    ).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "account",
    });
  });
});
