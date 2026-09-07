import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clawrouter from "../../extensions/clawrouter/index.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../../src/agents/embedded-agent-runner/model.js";
import type { ProviderRuntimeHooks } from "../../src/agents/embedded-agent-runner/model.provider-hooks.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";

const auth = vi.hoisted(() => ({ resolveApiKeyForProvider: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => auth);

describe("ClawRouter Responses discovery to dispatch", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "clawrouter-responses" });
    clearLiveCatalogCacheForTests();
    auth.resolveApiKeyForProvider.mockReset();
    auth.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "synthetic-catalog-key" });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    clearLiveCatalogCacheForTests();
    await state.cleanup();
  });

  it.each([
    { efforts: ["low", "high"], reasoning: true, role: "developer" },
    { efforts: undefined, reasoning: false, role: "system" },
  ])(
    "uses $role for a discovered reasoning=$reasoning model",
    async ({ efforts, reasoning, role }) => {
      const baseUrl = "https://broker.example.test/private";
      const config: OpenClawConfig = {
        models: {
          providers: { clawrouter: { baseUrl, agentRuntime: { id: "openclaw" }, models: [] } },
        },
      };
      const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = request.url;
        if (url === `${baseUrl}/v1/catalog`) {
          expect(request.headers.get("authorization")).toBe("Bearer synthetic-catalog-key");
          return Response.json({
            providers: [
              {
                id: "private",
                displayName: "Synthetic provider",
                openaiCompatible: true,
                nativeBaseUrl: "/v1/native/private",
                routes: [],
                models: [
                  {
                    id: "synthetic-opaque",
                    displayName: "Synthetic name",
                    upstream: "synthetic-opaque",
                    capabilities: ["llm.responses"],
                    ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
                  },
                ],
              },
            ],
          });
        }
        expect(url).toBe(`${baseUrl}/v1/responses`);
        requests.push({ url, body: await request.json() });
        return new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_synthetic",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const provider = await registerSingleProviderPlugin(clawrouter);
      const runtimeHooks: ProviderRuntimeHooks = {
        prepareProviderDynamicModel: async ({ context }) => {
          await provider.prepareDynamicModel?.(context);
        },
        runProviderDynamicModel: ({ context }) => provider.resolveDynamicModel?.(context),
        shouldPreferProviderRuntimeResolvedModel: ({ context }) =>
          provider.preferRuntimeResolvedModel?.(context) ?? false,
        normalizeProviderResolvedModelWithPlugin: ({ context }) =>
          provider.normalizeResolvedModel?.(context),
        buildProviderUnknownModelHintWithPlugin: () => undefined,
        normalizeProviderTransportWithPlugin: () => undefined,
      };
      const resolved = await resolveModelAsync(
        "clawrouter",
        "synthetic-opaque",
        state.agentDir(),
        config,
        {
          ...createEmptyAgentDiscoveryStores(),
          workspaceDir: state.workspaceDir,
          authProfileId: "clawrouter:synthetic",
          authProfileMode: "api_key",
          runtimeHooks,
          skipAgentDiscovery: true,
        },
      );
      expect(resolved.error).toBeUndefined();
      expect(resolved.model).toMatchObject({
        id: "synthetic-opaque",
        name: "Synthetic name",
        api: "openai-responses",
        reasoning,
      });
      expect(auth.resolveApiKeyForProvider).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "clawrouter:synthetic", lockedProfile: true }),
      );
      if (!resolved.model) {
        throw new Error("discovered model missing");
      }
      const stream = provider.wrapStreamFn?.({
        config,
        provider: "clawrouter",
        modelId: resolved.model.id,
        streamFn: createOpenAIResponsesTransportStreamFn(),
      });
      if (!stream) {
        throw new Error("provider stream missing");
      }
      const responseStream = await stream(
        resolved.model,
        {
          systemPrompt: "Synthetic instructions",
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        },
        { apiKey: "synthetic-catalog-key" },
      );
      const result = await responseStream.result();
      expect(result.stopReason).not.toBe("error");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toMatchObject({
        model: "synthetic-opaque",
        input: [
          {
            type: "message",
            role,
            content: [{ type: "input_text", text: "Synthetic instructions" }],
          },
          { type: "message", role: "user" },
        ],
      });
    },
  );
});
