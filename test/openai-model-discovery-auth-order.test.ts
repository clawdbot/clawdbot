import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import type { AuthProfileStore } from "../src/agents/auth-profiles/types.js";
import { planOpenClawModelsJson } from "../src/agents/models-config.plan.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../src/plugins/provider-catalog.types.js";
import type { ProviderPlugin } from "../src/plugins/types.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

type ResolveProviderApiKey =
  (typeof import("../src/plugin-sdk/provider-auth-runtime.js"))["resolveApiKeyForProvider"];

const discovery = vi.hoisted(() => ({
  providers: new Array<ProviderPlugin>(),
  rejectedRuntimeProfiles: new Set<string>(),
  resolveProviderApiKey: vi.fn(),
  originalResolveProviderApiKey: undefined as unknown as ResolveProviderApiKey,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../src/plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/plugin-sdk/provider-auth-runtime.js")>();
  discovery.originalResolveProviderApiKey = original.resolveApiKeyForProvider;
  return {
    ...original,
    resolveApiKeyForProvider: discovery.resolveProviderApiKey,
  };
});

function configureRuntimeAuthMock() {
  discovery.resolveProviderApiKey
    .mockReset()
    .mockImplementation(async (params: { profileId?: string }) => {
      if (params.profileId && discovery.rejectedRuntimeProfiles.has(params.profileId)) {
        throw new Error(`rejected runtime profile: ${params.profileId}`);
      }
      return discovery.originalResolveProviderApiKey(params as never);
    });
}

describe("OpenAI model discovery auth order", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = tempDirs.make("openai-profile-order-");
    discovery.providers = [buildOpenAIProvider()];
    configureRuntimeAuthMock();
  });

  afterEach(() => {
    clearLiveCatalogCacheForTests();
    vi.restoreAllMocks();
    discovery.providers = [];
    discovery.rejectedRuntimeProfiles.clear();
  });

  it("publishes only the configured first profile's account catalog", async () => {
    const profileA = "openai:profile-a";
    const profileB = "openai:profile-b";
    const keyA = "rejected-profile-a";
    const keyB = "selected-profile-b";
    const config: OpenClawConfig = {
      auth: {
        order: {
          openai: [profileB, profileA],
        },
      },
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileA]: { type: "api_key", provider: "openai", key: keyA },
        [profileB]: { type: "api_key", provider: "openai", key: keyB },
      },
    };
    const requests: string[] = [];
    const outcomes: ProviderCatalogOutcome[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      requests.push(authorization);
      if (authorization === `Bearer ${keyA}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (authorization === `Bearer ${keyB}`) {
        return Response.json({ data: [{ id: "gpt-5.5", object: "model" }] });
      }
      throw new Error("unexpected OpenAI catalog authorization");
    });

    const plan = await planOpenClawModelsJson({
      context: {
        cfg: config,
        discoveryAuthConfig: config,
        sourceConfigForSecrets: config,
        agentDir,
        env: {},
        envFingerprint: {},
        providerDiscoveryProviderIds: ["openai"],
        onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
      },
      authStore: store,
      existingRaw: "",
      existingParsed: null,
    });

    expect(requests).toEqual([`Bearer ${keyB}`]);
    expect(outcomes).toEqual([{ provider: "openai", profileId: profileB, status: "ready" }]);
    expect(plan.action).toBe("write");
    const providers =
      plan.action === "write"
        ? (
            JSON.parse(plan.contents) as {
              providers?: Record<string, { models?: Array<{ id?: string }> }>;
            }
          ).providers
        : undefined;
    expect(providers?.openai?.models?.map((model) => model.id)).toContain("gpt-5.5");
    expect(plan.action === "write" ? plan.contents : "").not.toContain(keyA);
  });

  it("continues from failed OAuth to the next configured API-key profile", async () => {
    const profileA = "openai:oauth-a";
    const profileB = "openai:api-key-b";
    const keyB = "selected-profile-b";
    discovery.rejectedRuntimeProfiles.add(profileA);
    const config: OpenClawConfig = {
      auth: {
        order: {
          openai: [profileA, profileB],
        },
      },
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileA]: {
          type: "oauth",
          provider: "openai",
          access: "rejected-oauth-a",
          refresh: "refresh-a",
          expires: Date.now() + 60_000,
        },
        [profileB]: {
          type: "api_key",
          provider: "openai",
          key: keyB,
        },
      },
    };
    const requests: string[] = [];
    const outcomes: ProviderCatalogOutcome[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json({ data: [{ id: "gpt-5.5", object: "model" }] });
    });

    const plan = await planOpenClawModelsJson({
      context: {
        cfg: config,
        discoveryAuthConfig: config,
        sourceConfigForSecrets: config,
        agentDir,
        env: {},
        envFingerprint: {},
        providerDiscoveryProviderIds: ["openai"],
        onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
      },
      authStore: store,
      existingRaw: "",
      existingParsed: null,
    });

    expect({
      runtimeProfiles: discovery.resolveProviderApiKey.mock.calls.map(
        ([params]) => params.profileId,
      ),
      requests,
      outcomes,
      action: plan.action,
    }).toEqual({
      runtimeProfiles: [profileB],
      requests: [`Bearer ${keyB}`],
      outcomes: [{ provider: "openai", profileId: profileB, status: "ready" }],
      action: "write",
    });
    expect(plan.action === "write" ? plan.contents : "").not.toContain("rejected-oauth-a");
  });
});
