// Ollama tests cover provider models plugin behavior.
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaProvider,
  buildOllamaModelDefinition,
  capLocalOllamaProviderContext,
  enrichOllamaModelsWithContext,
  isOllamaCloudModel,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
  resolveOllamaApiBase,
  type OllamaTagModel,
} from "./provider-models.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("ollama provider models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips /v1 when resolving the Ollama API base", () => {
    expect(resolveOllamaApiBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaApiBase("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
  });

  it("caps local discovered runtime context while preserving native metadata", () => {
    const provider = capLocalOllamaProviderContext({
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [
        buildOllamaModelDefinition("qwen3.5:4b", 262_144),
        buildOllamaModelDefinition("small", 16_384),
        buildOllamaModelDefinition("glm-5.2:cloud", 1_000_000),
        buildOllamaModelDefinition("gpt-oss:120b-cloud", 131_072),
        buildOllamaModelDefinition("local-cloud", 65_536),
      ],
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ contextWindow: 262_144, contextTokens: 32_768 }),
      expect.objectContaining({ contextWindow: 16_384, contextTokens: 16_384 }),
      expect.objectContaining({ id: "glm-5.2:cloud", contextWindow: 1_000_000 }),
      expect.objectContaining({ id: "gpt-oss:120b-cloud", contextWindow: 131_072 }),
      expect.objectContaining({ id: "local-cloud", contextTokens: 32_768 }),
    ]);
    expect(provider.models?.[2]).not.toHaveProperty("contextTokens");
    expect(provider.models?.[3]).not.toHaveProperty("contextTokens");
  });

  it.each([
    ["glm-5.2:cloud", true],
    ["gpt-oss:120b-cloud", true],
    ["local-cloud", false],
    ["invalid:cloud-cloud", false],
    ["invalid:local:cloud", false],
    ["invalid:local-cloud", false],
    ["invalid:cloud:local", false],
  ])("classifies Ollama model source %s", (modelId, expected) => {
    expect(isOllamaCloudModel(modelId)).toBe(expected);
  });

  it("sets discovered models with context windows from /api/show", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3:8b" }, { name: "deepseek-r1:14b" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "llama3:8b") {
        return jsonResponse({ model_info: { "llama.context_length": 65536 } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      { name: "llama3:8b", contextWindow: 65536, capabilities: undefined },
      { name: "deepseek-r1:14b", contextWindow: undefined, capabilities: undefined },
    ]);
    const fallbackModel = expectDefined(enriched[1], "fallback Ollama model");
    expect(
      buildOllamaModelDefinition(
        fallbackModel.name,
        fallbackModel.contextWindow,
        fallbackModel.capabilities,
      ).compat?.supportsTools,
    ).toBe(true);
  });

  it("forwards remote auth to model listing and show probes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer cloud-key");
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "glm-5.2:cloud" }] });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({
          model_info: { "glm5.2.context_length": 1_000_000 },
          capabilities: ["completion", "thinking", "tools"],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = await buildOllamaProvider("https://ollama.com", {
      apiKey: "cloud-key",
    });

    expect(provider.models).toEqual([
      expect.objectContaining({
        id: "glm-5.2:cloud",
        contextWindow: 1_000_000,
        maxTokens: 8_192,
        reasoning: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("scopes cached show metadata by credential", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "private-model", digest: "stable" }] });
      }
      const apiKey = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        model_info: {
          "private.context_length": apiKey === "Bearer account-a" ? 16_000 : 32_000,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await buildOllamaProvider("https://ollama.example.com", {
      apiKey: "account-a",
    });
    const second = await buildOllamaProvider("https://ollama.example.com", {
      apiKey: "account-b",
    });

    expect(first.models?.[0]?.contextWindow).toBe(16_000);
    expect(second.models?.[0]?.contextWindow).toBe(32_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recognizes the static Ollama Cloud GLM-5.2 model as reasoning-capable", () => {
    expect(buildOllamaModelDefinition("glm-5.2:cloud")).toEqual(
      expect.objectContaining({
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 8192,
      }),
    );
  });

  it("uses Modelfile num_ctx when it expands the discovered context window", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3-32k:latest" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "llama.context_length": 8192 },
        parameters: 'stop "<|eot_id|>"\nnum_ctx 32768\nnum_keep 5',
        capabilities: ["completion"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      {
        name: "llama3-32k:latest",
        contextWindow: 32768,
        capabilities: ["completion"],
      },
    ]);
  });

  it("keeps the larger native context window when Modelfile num_ctx is smaller", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3.2:latest" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "llama.context_length": 131072 },
        parameters: "num_ctx 4096",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0]?.contextWindow).toBe(131072);
  });

  it("uses positive num_ctx when /api/show omits model context metadata", async () => {
    const models: OllamaTagModel[] = [{ name: "custom-model:latest" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: {},
        parameters: "num_ctx 16384",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0]?.contextWindow).toBe(16384);
  });

  it("sets models with vision capability from /api/show capabilities", async () => {
    const models: OllamaTagModel[] = [{ name: "kimi-k2.5:cloud" }, { name: "glm-5.1:cloud" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "kimi-k2.5:cloud") {
        return jsonResponse({
          model_info: { "kimi-k2.context_length": 262144 },
          capabilities: ["vision", "thinking", "completion", "tools"],
        });
      }
      if (body.name === "glm-5.1:cloud") {
        return jsonResponse({
          model_info: { "glm5.context_length": 202752 },
          capabilities: ["thinking", "completion", "tools"],
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      {
        name: "kimi-k2.5:cloud",
        contextWindow: 262144,
        capabilities: ["vision", "thinking", "completion", "tools"],
      },
      {
        name: "glm-5.1:cloud",
        contextWindow: 202752,
        capabilities: ["thinking", "completion", "tools"],
      },
    ]);
  });

  it("reuses cached /api/show metadata when the model digest is unchanged", async () => {
    const models: OllamaTagModel[] = [
      { name: "qwen3:32b", digest: "sha256:abc123", modified_at: "2026-04-11T00:00:00Z" },
    ];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "qwen3.context_length": 131072 },
        capabilities: ["thinking", "tools"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached /api/show metadata when the model digest changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 131072 },
          capabilities: ["thinking", "tools"],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 262144 },
          capabilities: ["vision", "thinking", "tools"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [
      { name: "qwen3:32b", digest: "sha256:refresh-old" },
    ]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [
      { name: "qwen3:32b", digest: "sha256:refresh-new" },
    ]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:refresh-old",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:refresh-new",
        contextWindow: 262144,
        capabilities: ["vision", "thinking", "tools"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries /api/show after an empty result for the same digest", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 131072 },
          capabilities: ["thinking", "tools"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:retry-empty" };
    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:retry-empty",
        contextWindow: undefined,
        capabilities: undefined,
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:retry-empty",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes /v1 base URLs before fetching and reuses the same cache entry", async () => {
    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:normalized-base" };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("http://127.0.0.1:11434/api/show");
      expect(JSON.parse(requestBodyText(init?.body))).toEqual({ name: "qwen3:32b" });
      return jsonResponse({
        model_info: { "qwen3.context_length": 131072 },
        capabilities: ["thinking", "tools"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434/v1/", [model]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("buildOllamaModelDefinition sets input to text+image when vision capability is present", () => {
    const visionModel = buildOllamaModelDefinition("kimi-k2.5:cloud", 262144, [
      "vision",
      "completion",
      "tools",
      "thinking",
    ]);
    expect(visionModel.input).toEqual(["text", "image"]);
    expect(visionModel.reasoning).toBe(true);
    expect(visionModel.compat?.supportsTools).toBe(true);
    expect(visionModel.compat?.supportsUsageInStreaming).toBe(true);
    expect(visionModel.compat?.supportsJsonSchemaResponseFormat).toBe(false);

    const textModel = buildOllamaModelDefinition("glm-5.1:cloud", 202752, ["completion", "tools"]);
    expect(textModel.input).toEqual(["text"]);
    expect(textModel.reasoning).toBe(false);
    expect(textModel.compat?.supportsTools).toBe(true);
    expect(textModel.compat?.supportsUsageInStreaming).toBe(true);

    const deepseekCloudModel = buildOllamaModelDefinition("deepseek-v4-pro:cloud", 1048576, [
      "completion",
      "tools",
    ]);
    expect(deepseekCloudModel.reasoning).toBe(true);
    expect(deepseekCloudModel.compat?.supportsTools).toBe(true);

    const deepseekCloudModelWithoutCapabilities = buildOllamaModelDefinition(
      "deepseek-v4-flash:cloud",
      1048576,
    );
    expect(deepseekCloudModelWithoutCapabilities.reasoning).toBe(true);

    const noCapabilities = buildOllamaModelDefinition("unknown-model", 65536);
    expect(noCapabilities.input).toEqual(["text"]);
    expect(noCapabilities.compat?.supportsTools).toBe(true);
    expect(noCapabilities.compat?.supportsUsageInStreaming).toBe(true);
    expect(noCapabilities.compat?.supportsJsonSchemaResponseFormat).toBe(true);
  });

  it("disables tool support when Ollama capabilities omit tools", () => {
    const model = buildOllamaModelDefinition("embeddinggemma:latest", 2048, ["embedding"]);

    expect(model.reasoning).toBe(false);
    expect(model.compat?.supportsTools).toBe(false);
    expect(model.compat?.supportsUsageInStreaming).toBe(true);
  });

  it.each([
    { parameters: "num_ctx 8192\nnum_ctx 32768", expected: 32768 },
    { parameters: "temperature 0.8\nnum_ctx -1\nnum_ctx 0", expected: undefined },
    { parameters: 'stop "<|eot_id|>"', expected: undefined },
    { parameters: { num_ctx: 8192 }, expected: undefined },
  ])("reads Modelfile num_ctx through the model show query", async ({ parameters, expected }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ model_info: {}, parameters })),
    );

    const info = await queryOllamaModelShowInfo("http://127.0.0.1:11434", "test-model");

    expect(info.contextWindow).toBe(expected);
  });

  it("cancels non-OK discovery response bodies before fallback results", async () => {
    const tagsResponse = cancelTrackedResponse("ollama unavailable", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tagsResponse.response),
    );

    await expect(fetchOllamaModels("http://127.0.0.1:11434")).resolves.toEqual({
      reachable: true,
      models: [],
    });
    expect(tagsResponse.wasCanceled()).toBe(true);

    const showResponse = cancelTrackedResponse("model unavailable", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => showResponse.response),
    );

    await expect(queryOllamaModelShowInfo("http://127.0.0.1:11434", "llama3:8b")).resolves.toEqual(
      {},
    );
    expect(showResponse.wasCanceled()).toBe(true);
  });

  it("closes real failed discovery sockets while preserving successful discovery", async () => {
    const sockets = new Set<Socket>();
    const socketClosures = new Map<string, Promise<void>>();
    let mode: "failure" | "success" = "failure";

    const server = createServer((request, response) => {
      const path = request.url;
      if (path !== "/api/tags" && path !== "/api/show") {
        response.writeHead(404);
        response.end();
        return;
      }

      if (mode === "failure") {
        socketClosures.set(
          path,
          new Promise<void>((resolve) => {
            request.socket.once("close", () => resolve());
          }),
        );
        response.writeHead(503, { "content-type": "text/plain" });
        // Leave the body open so only real client cancellation can close its socket.
        response.write("ollama unavailable");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      if (path === "/api/tags") {
        response.end(JSON.stringify({ models: [{ name: "llama3:8b" }] }));
        return;
      }
      response.end(
        JSON.stringify({
          model_info: { "llama.context_length": 32768 },
          capabilities: ["completion", "tools"],
        }),
      );
    });

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    const waitForSocketClose = async (path: string): Promise<void> => {
      const closed = socketClosures.get(path);
      if (!closed) {
        throw new Error(`No failed discovery socket was recorded for ${path}`);
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(`Failed discovery socket was not closed for ${path}`));
            }, 2_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    };

    const listening = once(server, "listening");
    try {
      server.listen(0, "127.0.0.1");
      await listening;

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Ollama test server did not expose a TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [],
      });
      await waitForSocketClose("/api/tags");

      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({});
      await waitForSocketClose("/api/show");

      mode = "success";
      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [{ name: "llama3:8b" }],
      });
      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        contextWindow: 32768,
        capabilities: ["completion", "tools"],
      });
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  });

  it("fails soft and stops reading when discovery streams exceed the JSON byte cap", async () => {
    // Larger than the shared 16 MiB readProviderJsonResponse cap so the bounded reader cancels
    // the stream mid-flight; if the cap were removed the reader would buffer the whole payload.
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32; // 32 MiB advertised body, double the cap.
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const makeOversizedJsonResponse = (): Response => {
      bytesPulled = 0;
      canceled = false;
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          pulled += 1;
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOversizedJsonResponse()),
    );
    const tags = await fetchOllamaModels("http://127.0.0.1:11434");
    expect(tags).toEqual({ reachable: false, models: [] });
    expect(canceled).toBe(true);
    // Only the bounded prefix is pulled, never the full advertised 32 MiB stream.
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOversizedJsonResponse()),
    );
    const showInfo = await queryOllamaModelShowInfo("http://127.0.0.1:11434", "evil-model:latest");
    expect(showInfo).toEqual({});
    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });
});
