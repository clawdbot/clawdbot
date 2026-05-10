import { describe, expect, it } from "vitest";
import type { ConfiguredProviderRequest } from "../config/types.provider-request.js";
import type { SecretRef } from "../config/types.secrets.js";
import {
  buildProviderRequestDispatcherPolicy,
  mergeModelProviderRequestOverrides,
  mergeProviderRequestOverrides,
  resolveProviderRequestPolicyConfig,
  resolveProviderRequestConfig,
  resolveProviderRequestHeaders,
  sanitizeConfiguredModelProviderRequest,
  sanitizeConfiguredProviderRequest,
  sanitizeRuntimeProviderRequestOverrides,
} from "./provider-request-config.js";

describe("provider request config", () => {
  it("merges discovered, provider, and model headers in precedence order", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "custom-openai",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      discoveredHeaders: {
        "X-Discovered": "1",
        "X-Shared": "discovered",
      },
      providerHeaders: {
        "X-Provider": "2",
        "X-Shared": "provider",
      },
      modelHeaders: {
        "X-Model": "3",
        "X-Shared": "model",
      },
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.headers).toEqual({
      "X-Discovered": "1",
      "X-Provider": "2",
      "X-Model": "3",
      "X-Shared": "model",
    });
  });

  it("surfaces authHeader intent without mutating headers yet", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      authHeader: true,
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.auth).toEqual({
      configured: false,
      mode: "authorization-bearer",
      injectAuthorizationHeader: true,
    });
    expect(resolved.headers).toBeUndefined();
  });

  it("keeps future proxy and tls slots stable for current callers", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "openrouter",
      api: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.proxy).toEqual({ configured: false });
    expect(resolved.tls).toEqual({ configured: false });
    expect(resolved.policy.endpointClass).toBe("openrouter");
    expect(resolved.policy.attributionProvider).toBe("openrouter");
    expect(resolved.extraHeaders).toEqual({
      configured: false,
      headers: undefined,
    });
  });

  it("normalizes transport overrides into auth, extra headers, proxy, and tls slots", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "custom-openai",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      request: {
        headers: {
          "X-Tenant": "acme",
        },
        auth: {
          mode: "header",
          headerName: "api-key",
          value: "secret",
        },
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
          tls: {
            ca: "proxy-ca",
          },
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
          serverName: "gateway.internal",
        },
      },
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.extraHeaders).toEqual({
      configured: true,
      headers: {
        "X-Tenant": "acme",
        "api-key": "secret",
      },
    });
    expect(resolved.auth).toEqual({
      configured: true,
      mode: "header",
      headerName: "api-key",
      value: "secret",
      injectAuthorizationHeader: false,
    });
    expect(resolved.proxy).toEqual({
      configured: true,
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.internal:8443",
      tls: {
        configured: true,
        ca: "proxy-ca",
      },
    });
    expect(resolved.tls).toEqual({
      configured: true,
      cert: "client-cert",
      key: "client-key",
      serverName: "gateway.internal",
    });
  });

  it("drops legacy Authorization when a custom auth header override is configured", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "custom-openai",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      providerHeaders: {
        Authorization: "Bearer stale-token",
        "X-Tenant": "acme",
      },
      request: {
        auth: {
          mode: "header",
          headerName: "api-key",
          value: "secret",
        },
      },
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.headers).toEqual({
      "X-Tenant": "acme",
      "api-key": "secret",
    });
  });

  it("builds explicit proxy dispatcher policy from normalized transport config", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "custom-openai",
      baseUrl: "https://proxy.example.com/v1",
      request: {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
          tls: {
            ca: "proxy-ca",
          },
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
        },
      },
    });

    expect(buildProviderRequestDispatcherPolicy(resolved)).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.internal:8443",
      proxyTls: {
        ca: "proxy-ca",
      },
    });
  });

  it("does not copy target TLS into env proxy TLS", () => {
    const resolved = resolveProviderRequestConfig({
      provider: "custom-openai",
      baseUrl: "https://proxy.example.com/v1",
      request: {
        proxy: {
          mode: "env-proxy",
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
          serverName: "gateway.internal",
        },
      },
    });

    expect(buildProviderRequestDispatcherPolicy(resolved)).toEqual({
      mode: "env-proxy",
      connect: {
        cert: "client-cert",
        key: "client-key",
        servername: "gateway.internal",
      },
    });
  });

  it("rejects insecure TLS transport overrides", () => {
    expect(() =>
      resolveProviderRequestConfig({
        provider: "custom-openai",
        baseUrl: "https://proxy.example.com/v1",
        request: {
          tls: {
            insecureSkipVerify: true,
          },
        },
      }),
    ).toThrow(/insecureskipverify/i);
  });

  it("rejects proxy and tls runtime auth overrides", () => {
    expect(() =>
      sanitizeRuntimeProviderRequestOverrides({
        headers: {
          "X-Tenant": "acme",
        },
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      }),
    ).toThrow(/runtime auth request overrides do not allow proxy or tls/i);
  });

  it("sanitizes configured request overrides into runtime transport overrides", () => {
    expect(
      sanitizeConfiguredProviderRequest({
        headers: {
          "X-Tenant": "acme",
        },
        auth: {
          mode: "authorization-bearer",
          token: "secret",
        },
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
          tls: {
            ca: "proxy-ca",
          },
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
          serverName: "gateway.internal",
        },
      }),
    ).toEqual({
      headers: {
        "X-Tenant": "acme",
      },
      auth: {
        mode: "authorization-bearer",
        token: "secret",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.internal:8443",
        tls: {
          ca: "proxy-ca",
        },
      },
      tls: {
        cert: "client-cert",
        key: "client-key",
        serverName: "gateway.internal",
      },
    });
  });

  it("fails fast when configured request overrides still contain unresolved SecretRefs", () => {
    const tenantRef: SecretRef = {
      source: "env",
      provider: "default",
      id: "MEDIA_AUDIO_TENANT",
    };
    const tokenRef: SecretRef = {
      source: "env",
      provider: "default",
      id: "MEDIA_AUDIO_TOKEN",
    };
    const certRef: SecretRef = {
      source: "env",
      provider: "default",
      id: "MEDIA_AUDIO_CERT",
    };
    expect(() =>
      sanitizeConfiguredProviderRequest({
        headers: {
          "X-Tenant": tenantRef,
        },
        auth: {
          mode: "authorization-bearer",
          token: tokenRef,
        },
        tls: {
          cert: certRef,
        },
      }),
    ).toThrow(/request\.(headers\.X-Tenant|auth\.token|tls\.cert): unresolved SecretRef/i);
  });

  it("keeps model-provider transport overrides once the llm path can carry them", () => {
    expect(
      sanitizeConfiguredModelProviderRequest({
        headers: {
          "X-Tenant": "acme",
        },
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
        },
      }),
    ).toEqual({
      headers: {
        "X-Tenant": "acme",
      },
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.internal:8443",
      },
    });
  });

  it("preserves request.allowPrivateNetwork for operator-trusted LAN/overlay model bases", () => {
    expect(sanitizeConfiguredModelProviderRequest({ allowPrivateNetwork: true })).toEqual({
      allowPrivateNetwork: true,
    });
    expect(sanitizeConfiguredModelProviderRequest({ allowPrivateNetwork: false })).toEqual({
      allowPrivateNetwork: false,
    });
    expect(
      sanitizeConfiguredProviderRequest({
        allowPrivateNetwork: true,
      } as ConfiguredProviderRequest),
    ).toBeUndefined();
  });

  it("merges allowPrivateNetwork with later override winning", () => {
    expect(
      mergeModelProviderRequestOverrides(
        { allowPrivateNetwork: true },
        { allowPrivateNetwork: false },
      ),
    ).toEqual({ allowPrivateNetwork: false });
    expect(
      mergeModelProviderRequestOverrides(
        { allowPrivateNetwork: false },
        { allowPrivateNetwork: true },
      ),
    ).toEqual({ allowPrivateNetwork: true });
  });

  it("merges configured request overrides with later entries winning", () => {
    expect(
      mergeProviderRequestOverrides(
        {
          headers: {
            "X-Provider": "1",
            "X-Shared": "provider",
          },
          auth: {
            mode: "authorization-bearer",
            token: "provider-token",
          },
        },
        {
          headers: {
            "X-Entry": "2",
            "X-Shared": "entry",
          },
          auth: {
            mode: "header",
            headerName: "api-key",
            value: "entry-key",
          },
        },
      ),
    ).toEqual({
      headers: {
        "X-Provider": "1",
        "X-Shared": "entry",
        "X-Entry": "2",
      },
      auth: {
        mode: "header",
        headerName: "api-key",
        value: "entry-key",
      },
    });
  });

  it("lets defaults override caller headers when requested", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      capability: "llm",
      transport: "stream",
      callerHeaders: {
        originator: "spoofed",
        "User-Agent": "spoofed/0.0.0",
        "X-Custom": "1",
      },
      precedence: "defaults-win",
    });

    expect(resolved?.originator).toBe("openclaw");
    expect(typeof resolved?.version).toBe("string");
    expect(resolved?.["User-Agent"]).toMatch(/^openclaw\//);
    expect(resolved?.["X-Custom"]).toBe("1");
  });

  it("lets caller headers override defaults when requested", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "openrouter",
      api: "openai-completions",
      capability: "llm",
      transport: "stream",
      callerHeaders: {
        "HTTP-Referer": "https://example.com",
        "X-Custom": "1",
      },
      precedence: "caller-wins",
    });

    expect(resolved).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories":
        "cli-agent,cloud-agent,programming-app,creative-writing,writing-assistant,general-chat,personal-agent",
      "X-Custom": "1",
    });
  });

  it("merges header names case-insensitively", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      capability: "llm",
      transport: "stream",
      callerHeaders: {
        "user-agent": "custom-agent/1.0",
      },
      precedence: "caller-wins",
    });

    expect(
      Object.keys(resolved ?? {}).filter((key) => key.toLowerCase() === "user-agent"),
    ).toHaveLength(1);
    expect(resolved?.["User-Agent"]).toMatch(/^openclaw\//);
  });

  it("drops forbidden header keys while merging", () => {
    const resolved = resolveProviderRequestHeaders({
      provider: "custom-openai",
      callerHeaders: {
        __proto__: "polluted",
        constructor: "polluted",
        "X-Custom": "1",
      } as Record<string, string>,
      defaultHeaders: {
        prototype: "polluted",
      } as Record<string, string>,
    });

    expect(resolved).toEqual({
      "X-Custom": "1",
    });
    expect(Object.getPrototypeOf(resolved ?? {})).toBeNull();
  });

  it("unifies policy, capabilities, headers, base URL, and private-network posture", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1/",
      defaultBaseUrl: "https://fallback.example/v1/",
      callerHeaders: {
        "User-Agent": "custom-agent/1.0",
        "X-Custom": "1",
      },
      providerHeaders: {
        authorization: "Bearer test-key",
      },
      compat: {
        supportsStore: true,
      },
      capability: "llm",
      transport: "stream",
      precedence: "defaults-win",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.policy.endpointClass).toBe("openai-public");
    expect(resolved.capabilities.allowsResponsesStore).toBe(true);
    expect(resolved.headers?.authorization).toBe("Bearer test-key");
    expect(resolved.headers?.originator).toBe("openclaw");
    expect(typeof resolved.headers?.version).toBe("string");
    expect(resolved.headers?.["User-Agent"]).toMatch(/^openclaw\//);
    expect(resolved.headers?.["X-Custom"]).toBe("1");
  });

  it("auto-allows loopback model-provider stream requests", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      provider: "local-agent-proxy",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:3000/v1",
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.allowPrivateNetwork).toBe(true);
  });

  it("keeps explicit private-network denial for loopback model requests", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      provider: "local-agent-proxy",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:3000/v1",
      capability: "llm",
      transport: "stream",
      request: { allowPrivateNetwork: false },
    });

    expect(resolved.allowPrivateNetwork).toBe(false);
  });

  it("does not auto-allow non-loopback private model-provider hosts", () => {
    const resolved = resolveProviderRequestPolicyConfig({
      provider: "local-agent-proxy",
      api: "openai-completions",
      baseUrl: "http://192.168.1.20:3000/v1",
      capability: "llm",
      transport: "stream",
    });

    expect(resolved.allowPrivateNetwork).toBe(false);
  });
});
