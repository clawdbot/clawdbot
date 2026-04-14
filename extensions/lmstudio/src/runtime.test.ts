import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER } from "./defaults.js";
import {
  buildLmstudioAuthHeaders,
  resolveLmstudioConfiguredApiKey,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
} from "./runtime.js";

const resolveApiKeyForProviderMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    resolveApiKeyForProvider: (...args: unknown[]) => resolveApiKeyForProviderMock(...args),
  };
});

function buildLmstudioConfig(overrides?: {
  apiKey?: unknown;
  headers?: unknown;
  auth?: "api-key";
}): OpenClawConfig {
  return {
    models: {
      providers: {
        lmstudio: {
          baseUrl: "http://localhost:1234/v1",
          api: "openai-completions",
          ...(overrides?.auth ? { auth: overrides.auth } : {}),
          ...(overrides?.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
          ...(overrides?.headers !== undefined ? { headers: overrides.headers } : {}),
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

describe("lmstudio-runtime", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockReset();
  });

  it("throws when runtime auth resolves to blank and no configured key exists", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "   ",
      source: "profile:lmstudio:default",
      mode: "api-key",
    });

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({ auth: "api-key" }),
      }),
    ).rejects.toThrow(/LM Studio API key is required/i);
  });

  it("falls back to configured env marker key when profile resolution fails", async () => {
    resolveApiKeyForProviderMock.mockRejectedValueOnce(
      new Error('No API key found for provider "lmstudio". Auth store: /tmp/auth-profiles.json.'),
    );

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({
          auth: "api-key",
          apiKey: "${LM_API_TOKEN}",
        }),
        env: {
          LM_API_TOKEN: "template-lmstudio-key",
        },
      }),
    ).resolves.toBe("template-lmstudio-key");
  });

  it("accepts synthesized lmstudio-local for non-explicit auth mode", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    });

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig(),
      }),
    ).resolves.toBe(LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER);
  });

  it("accepts synthesized lmstudio-local for explicit api-key mode", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    });

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({ auth: "api-key" }),
      }),
    ).resolves.toBe(LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER);
  });

  it("accepts shared synthetic local marker for keyless runtime auth", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    });

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig(),
      }),
    ).resolves.toBe(CUSTOM_LOCAL_AUTH_MARKER);
  });

  it("allows header-only runtime auth when Authorization is configured", async () => {
    resolveApiKeyForProviderMock.mockRejectedValueOnce(
      new Error('No API key found for provider "lmstudio". Auth store: /tmp/auth-profiles.json.'),
    );

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({
          headers: {
            Authorization: "Bearer proxy-token",
          },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("suppresses profile runtime auth when Authorization is configured", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "stale-profile-key",
      source: "profile:lmstudio:default",
      mode: "api-key",
    });

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({
          headers: {
            Authorization: "Bearer proxy-token",
          },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("suppresses env runtime auth when Authorization is configured", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "stale-env-key",
      source: "env:LM_API_TOKEN",
      mode: "api-key",
    });

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({
          headers: {
            Authorization: "Bearer proxy-token",
          },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("suppresses shell env runtime auth when Authorization is configured", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "stale-shell-env-key",
      source: "shell env: LM_API_TOKEN",
      mode: "api-key",
    });

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({
          headers: {
            Authorization: "Bearer proxy-token",
          },
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when explicit api-key mode cannot resolve any key", async () => {
    resolveApiKeyForProviderMock.mockRejectedValue(
      new Error('No API key found for provider "lmstudio". Auth store: /tmp/auth-profiles.json.'),
    );

    await expect(
      resolveLmstudioRuntimeApiKey({
        config: buildLmstudioConfig({ auth: "api-key" }),
      }),
    ).rejects.toThrow(/LM Studio API key is required/i);

    await expect(
      resolveLmstudioConfiguredApiKey({
        config: buildLmstudioConfig({ auth: "api-key" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves SecretRef api key and headers", async () => {
    const headerRef = {
      "X-Proxy-Auth": {
        source: "env" as const,
        provider: "default" as const,
        id: "LMSTUDIO_PROXY_TOKEN",
      },
    };
    await expect(
      resolveLmstudioConfiguredApiKey({
        config: buildLmstudioConfig({
          apiKey: {
            source: "env",
            provider: "default",
            id: "LM_API_TOKEN",
          },
        }),
        env: {
          LM_API_TOKEN: "secretref-lmstudio-key",
        },
      }),
    ).resolves.toBe("secretref-lmstudio-key");

    await expect(
      resolveLmstudioProviderHeaders({
        config: buildLmstudioConfig({ headers: headerRef }),
        env: {
          LMSTUDIO_PROXY_TOKEN: "proxy-token",
        },
        headers: headerRef,
      }),
    ).resolves.toEqual({
      "X-Proxy-Auth": "proxy-token",
    });
  });

  it("resolves env-template api keys from config", async () => {
    await expect(
      resolveLmstudioConfiguredApiKey({
        config: buildLmstudioConfig({
          apiKey: "${LM_API_TOKEN}",
        }),
        env: {
          LM_API_TOKEN: "template-lmstudio-key",
        },
      }),
    ).resolves.toBe("template-lmstudio-key");
  });

  it("throws a path-specific error when a SecretRef header cannot be resolved", async () => {
    const headerRef = {
      "X-Proxy-Auth": {
        source: "env" as const,
        provider: "default" as const,
        id: "LMSTUDIO_PROXY_TOKEN",
      },
    };
    await expect(
      resolveLmstudioProviderHeaders({
        config: buildLmstudioConfig({ headers: headerRef }),
        env: {},
        headers: headerRef,
      }),
    ).rejects.toThrow(/models\.providers\.lmstudio\.headers\.X-Proxy-Auth/i);
  });

  it("builds auth headers with key precedence and json support", () => {
    expect(buildLmstudioAuthHeaders({})).toBeUndefined();
    expect(buildLmstudioAuthHeaders({ apiKey: "  sk-test  " })).toEqual({
      Authorization: "Bearer sk-test",
    });
    expect(buildLmstudioAuthHeaders({ apiKey: "   " })).toBeUndefined();
    expect(
      buildLmstudioAuthHeaders({ apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER }),
    ).toBeUndefined();
    expect(
      buildLmstudioAuthHeaders({
        apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
        headers: {
          Authorization: "Bearer proxy-token",
        },
      }),
    ).toEqual({
      Authorization: "Bearer proxy-token",
    });
    expect(
      buildLmstudioAuthHeaders({
        apiKey: "sk-new",
        json: true,
        headers: {
          authorization: "Bearer sk-old",
          "X-Proxy": "proxy-token",
        },
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "X-Proxy": "proxy-token",
      Authorization: "Bearer sk-new",
    });
  });
});
