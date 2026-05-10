import { beforeAll, describe, expect, it, vi } from "vitest";

let NON_ENV_SECRETREF_MARKER: typeof import("./model-auth-markers.js").NON_ENV_SECRETREF_MARKER;
let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;

async function loadModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../plugins/provider-runtime.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  const [markersModule, secretsModule] = await Promise.all([
    import("./model-auth-markers.js"),
    import("./models-config.providers.secrets.js"),
  ]);
  NON_ENV_SECRETREF_MARKER = markersModule.NON_ENV_SECRETREF_MARKER;
  createProviderAuthResolver = secretsModule.createProviderAuthResolver;
}

beforeAll(loadModules);

describe("vercel-ai-gateway provider resolution", () => {
  it("resolves AI_GATEWAY_API_KEY through provider auth lookup", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        AI_GATEWAY_API_KEY: "vercel-gateway-test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    const auth = resolveAuth("vercel-ai-gateway");
    expect(auth.apiKey).toBe("AI_GATEWAY_API_KEY");
    expect(auth.mode).toBe("api_key");
    expect(auth.source).toBe("env");
  });

  it("prefers env keyRef markers over runtime plaintext in auth profiles", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "vercel-ai-gateway:default": {
          type: "api_key",
          provider: "vercel-ai-gateway",
          key: "sk-runtime-vercel",
          keyRef: { source: "env", provider: "default", id: "AI_GATEWAY_API_KEY" },
        },
      },
    });

    const auth = resolveAuth("vercel-ai-gateway");
    expect(auth.apiKey).toBe("AI_GATEWAY_API_KEY");
    expect(auth.mode).toBe("api_key");
    expect(auth.source).toBe("profile");
    expect(auth.profileId).toBe("vercel-ai-gateway:default");
  });

  it("uses non-env markers for non-env keyRef vercel profiles", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "vercel-ai-gateway:default": {
          type: "api_key",
          provider: "vercel-ai-gateway",
          key: "sk-runtime-vercel",
          keyRef: { source: "file", provider: "vault", id: "/vercel/ai-gateway/api-key" },
        },
      },
    });

    const auth = resolveAuth("vercel-ai-gateway");
    expect(auth.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(auth.mode).toBe("api_key");
    expect(auth.source).toBe("profile");
    expect(auth.profileId).toBe("vercel-ai-gateway:default");
  });
});
