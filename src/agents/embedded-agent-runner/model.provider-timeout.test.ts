// Locks the `models.providers.<id>.timeoutSeconds` -> `requestTimeoutMs` contract
// from config through model resolution. The schema help promises this key raises
// the LLM idle/stream watchdog ceiling, so the field must survive every
// resolution branch and every provider-plugin normalization hook (#113092).
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelAsync } from "./model.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

const AGENT_DIR = "/tmp/agent";
const PROVIDER = "ai-brick";
const MODEL_ID = "ornith-1.0-35b";
const TIMEOUT_SECONDS = 3600;
const EXPECTED_TIMEOUT_MS = 3_600_000;

type RuntimeHooks = ReturnType<typeof createProviderRuntimeTestMock>;

/**
 * Emulates a provider plugin whose `normalizeResolvedModel` hook returns a
 * freshly constructed model instead of spreading the host-resolved one. This is
 * legal for plugins, so any host-owned field stamped before the hook runs is
 * silently dropped.
 */
function createRebuildingRuntimeHooks(): RuntimeHooks {
  const base = createProviderRuntimeTestMock();
  return {
    ...base,
    normalizeProviderResolvedModelWithPlugin: (params: {
      provider: string;
      context: { model: unknown };
    }) => {
      const model = params.context.model as Record<string, unknown>;
      return {
        id: model.id,
        name: model.name,
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      };
    },
  } as RuntimeHooks;
}

function customProviderConfig(
  overrides?: Partial<{ api: string; timeoutSeconds: number }>,
): OpenClawConfig {
  return {
    models: {
      providers: {
        [PROVIDER]: {
          baseUrl: "http://127.0.0.1:8080/v1",
          ...(overrides?.timeoutSeconds !== undefined
            ? { timeoutSeconds: overrides.timeoutSeconds }
            : {}),
          models: [
            {
              id: MODEL_ID,
              name: "Ornith 1.0 35B",
              ...(overrides?.api !== undefined ? { api: overrides.api } : {}),
            },
          ],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function resolveForTest(cfg: OpenClawConfig, runtimeHooks?: RuntimeHooks) {
  const result = await resolveModelAsync(PROVIDER, MODEL_ID, AGENT_DIR, cfg, {
    authStorage: { mocked: true } as never,
    // Empty registry: the model under test is declared inline in config, so
    // resolution must not depend on discovered catalog rows.
    modelRegistry: { find: () => null } as never,
    skipAgentDiscovery: true,
    runtimeHooks: runtimeHooks ?? createProviderRuntimeTestMock(),
  });
  if (!result.model) {
    throw new Error(`expected model resolution to succeed, got error: ${result.error}`);
  }
  return result.model as { requestTimeoutMs?: number };
}

describe("provider timeoutSeconds -> requestTimeoutMs", () => {
  it("stamps requestTimeoutMs for an inline custom provider model", async () => {
    const model = await resolveForTest(
      customProviderConfig({ api: "openai-completions", timeoutSeconds: TIMEOUT_SECONDS }),
    );
    expect(model.requestTimeoutMs).toBe(EXPECTED_TIMEOUT_MS);
  });

  it("stamps requestTimeoutMs for an inline model without an explicit api", async () => {
    const model = await resolveForTest(customProviderConfig({ timeoutSeconds: TIMEOUT_SECONDS }));
    expect(model.requestTimeoutMs).toBe(EXPECTED_TIMEOUT_MS);
  });

  it("omits requestTimeoutMs when the provider sets no timeoutSeconds", async () => {
    const model = await resolveForTest(customProviderConfig({ api: "openai-completions" }));
    expect(model.requestTimeoutMs).toBeUndefined();
  });

  it("keeps requestTimeoutMs when a provider plugin rebuilds the model", async () => {
    const model = await resolveForTest(
      customProviderConfig({ api: "openai-completions", timeoutSeconds: TIMEOUT_SECONDS }),
      createRebuildingRuntimeHooks(),
    );
    expect(model.requestTimeoutMs).toBe(EXPECTED_TIMEOUT_MS);
  });
});
