import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import type { AuthProfileStore } from "../src/agents/auth-profiles/types.js";
import { planOpenClawModelsJson } from "../src/agents/models-config.plan.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../src/plugins/provider-catalog.types.js";
import type { ProviderPlugin } from "../src/plugins/types.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));

vi.mock("../src/plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

describe("OpenAI model discovery auth order", () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-profile-order-"));
    discovery.providers = [buildOpenAIProvider()];
  });

  afterEach(async () => {
    clearLiveCatalogCacheForTests();
    vi.restoreAllMocks();
    discovery.providers = [];
    await fs.rm(agentDir, { recursive: true, force: true });
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
});
