import {
  configureAiTransportHost,
  createApiRegistry,
  createLlmRuntime,
  getAiTransportHost,
  type AiModelTransportEvent,
} from "@openclaw/ai";
import type { Model, StreamFunction } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddedAgentStreamFn } from "./embedded-agent-runner/stream-resolution.js";

const initialHost = getAiTransportHost();

afterEach(() => {
  configureAiTransportHost(initialHost);
});

describe("embedded Azure stream resolution", () => {
  it("selects the accounted managed transport through the production resolver", async () => {
    const registry = createApiRegistry();
    const nativeStreamFn = vi.fn(() => {
      throw new Error("native Azure provider stream should not run");
    }) as unknown as StreamFunction<"azure-openai-responses">;
    registry.registerApiProvider({
      api: "azure-openai-responses",
      stream: nativeStreamFn,
      streamSimple: nativeStreamFn,
    });
    const llmRuntime = createLlmRuntime(registry);
    const registeredStreamFn = registry.getApiProvider("azure-openai-responses")?.streamSimple;
    if (!registeredStreamFn) {
      throw new Error("expected registered Azure Responses stream function");
    }
    const events: AiModelTransportEvent[] = [];
    let dispatchedRequest: Request | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      dispatchedRequest = new Request(input, init);
      const terminal = {
        type: "response.completed",
        response: {
          id: "resp_azure_managed",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      };
      return new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "openai-model": "gpt-5.5",
        },
      });
    });
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: () => undefined,
      },
      buildModelFetchWithDispatchAttestation: (_model, _timeoutMs, options) => ({
        provenance: "dispatch_attested",
        fetch: async (input, init) => {
          const response = fetchMock(input, init);
          options.onFetchDispatch?.();
          return await response;
        },
      }),
      observeModelTransportEvent: (event) => events.push(event),
    });
    const model: Model<"azure-openai-responses"> = {
      api: "azure-openai-responses",
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      name: "Azure GPT-5.5",
      baseUrl: "https://resource.openai.azure.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8192,
    };
    const streamFn = resolveEmbeddedAgentStreamFn({
      llmRuntime,
      currentStreamFn: registeredStreamFn,
      sessionId: "session-azure-accounting",
      model,
      resolvedApiKey: "test-key",
    });

    expect(streamFn).not.toBe(registeredStreamFn);
    const stream = await streamFn(
      model,
      { systemPrompt: "test", messages: [], tools: [] },
      {
        requestId: "call-azure-managed-route",
        maxRetries: 0,
      },
    );
    expect((await stream.result()).api).toBe("azure-openai-responses");
    expect(nativeStreamFn).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dispatchedRequest).toBeDefined();
    const dispatchedUrl = new URL(dispatchedRequest?.url ?? "https://invalid.local");
    expect(dispatchedUrl.pathname).toContain("/responses");
    expect(dispatchedUrl.searchParams.get("api-version")).toBeTruthy();
    expect(dispatchedRequest?.headers.get("api-key")).toBe("test-key");
    expect(dispatchedRequest?.headers.get("authorization")).toBeNull();
    expect(events.filter((event) => event.type === "attempt")).toMatchObject([
      {
        callId: "call-azure-managed-route",
        provider: "azure-openai-responses",
        api: "azure-openai-responses",
        transport: "responses-sdk",
        reason: "initial",
        outcome: "completed",
      },
    ]);
  });
});
