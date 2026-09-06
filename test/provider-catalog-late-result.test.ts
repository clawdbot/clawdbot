import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../src/agents/auth-profiles/types.js";
import { resolveImplicitProviders } from "../src/agents/models-config.providers.implicit.js";
import type { ModelProviderConfig } from "../src/config/types.models.js";
import type { ProviderCatalogOutcome } from "../src/plugins/provider-catalog.types.js";
import * as providerDiscovery from "../src/plugins/provider-discovery.js";
import * as providerRuntime from "../src/plugins/provider-runtime.runtime.js";
import type { ProviderPlugin } from "../src/plugins/types.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../src/test-utils/openclaw-test-state.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));

vi.mock("../src/plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

const providerId = "catalog-late-fixture";
const profileId = `${providerId}:oauth`;
const peerId = "catalog-peer-fixture";
const model = {
  id: "account-only",
  name: "Account Model",
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
};

describe("provider catalog late-result finalization", () => {
  let state: OpenClawTestState;
  let store: AuthProfileStore;

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "catalog-late-result-", agentEnv: "main" });
    store = {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: providerId,
          access: "expired-fixture-access",
          refresh: "fixture-refresh",
          expires: Date.now() - 60_000,
        },
      },
    };
    await state.writeAuthProfiles(store);
    vi.spyOn(providerRuntime, "buildProviderAuthDoctorHintWithPlugin").mockResolvedValue(undefined);
    vi.spyOn(providerRuntime, "resolveProviderOAuthCredentialWithPlugin").mockRejectedValue(
      new Error("fixture refresh failed"),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    discovery.providers = [];
    await state.cleanup();
  });

  it.each([
    { shape: "provider", timedOut: false },
    { shape: "providers", timedOut: false },
    { shape: "outcomes", timedOut: false },
    { shape: "provider", timedOut: true },
    { shape: "providers", timedOut: true },
    { shape: "outcomes", timedOut: true },
  ] as const)(
    "consumes $shape only for an active owner (late: $timedOut)",
    async ({ shape, timedOut }) => {
      const entered = createDeferredCore();
      const completion = createDeferredCore();
      const catalog = vi.spyOn(providerDiscovery, "runProviderCatalog");
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
      const ready: ProviderCatalogOutcome[] = [{ provider: providerId, status: "ready" }];
      if (shape === "providers") {
        ready.push({ provider: peerId, status: "ready" });
      }
      let reads = 0;
      const readProvider = (): ModelProviderConfig => ({
        baseUrl: "https://catalog.invalid/v1",
        api: "openai-completions",
        models: reads++ === 0 ? [model] : [],
      });
      discovery.providers = [
        {
          id: providerId,
          label: "Catalog Fixture",
          auth: [
            {
              id: "oauth",
              label: "OAuth",
              kind: "oauth",
              run: async () => {
                throw new Error("interactive auth is outside this fixture");
              },
            },
          ],
          catalog: {
            run: async (ctx) => {
              expect(ctx.resolveProviderAuth(providerId).preparationFailed).toBe(true);
              entered.resolve();
              if (timedOut) {
                await completion.promise;
              }
              if (shape === "outcomes") {
                return {
                  providers: {},
                  get outcomes() {
                    return reads++ === 0 ? ready : [];
                  },
                };
              }
              return shape === "provider"
                ? {
                    get provider() {
                      return readProvider();
                    },
                    outcomes: ready,
                  }
                : {
                    get providers() {
                      const provider = readProvider();
                      return { [providerId]: provider, [peerId]: provider };
                    },
                    outcomes: ready,
                  };
            },
          },
        },
      ];
      const outcomes: ProviderCatalogOutcome[] = [];
      const discover = (timeoutMs?: number) =>
        resolveImplicitProviders({
          config: { auth: { order: { [providerId]: [profileId] } } },
          agentDir: state.agentDir(),
          authStore: store,
          env: {},
          providerDiscoveryTimeoutMs: timeoutMs,
          onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
        });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = discover(timedOut ? 25 : undefined);
      try {
        await Promise.race([entered.promise, pending]);
        if (timedOut) {
          await vi.advanceTimersByTimeAsync(25);
          expect(await pending).toEqual({});
        }
      } finally {
        completion.resolve();
        await Promise.allSettled(catalog.mock.results.map((result) => result.value));
      }
      const first = await pending;
      let accepted = first;
      const lateReads = reads;
      if (timedOut) {
        expect(outcomes).toEqual([{ provider: providerId, status: "unavailable" }]);
        outcomes.length = 0;
        accepted = await discover();
      }
      expect({ lateReads, reads }).toEqual({ lateReads: timedOut ? 0 : 1, reads: 1 });
      if (shape === "outcomes") {
        expect(accepted).toEqual({});
      } else {
        expect(accepted?.[providerId]?.models).toEqual([model]);
      }
      if (shape === "providers") {
        expect(accepted?.[peerId]?.models).toEqual([model]);
      }
      expect(outcomes).toEqual(ready);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
