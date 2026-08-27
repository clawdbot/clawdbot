import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaModelsConfig,
  discoverOllamaModelsForSetup,
  findAvailableOllamaModelName,
  mergeUniqueModelNames,
  normalizeOllamaModelName,
  selectAppGuidedOllamaModelFromDiscovery,
} from "./setup-model-selection.js";
import { configureOllamaNonInteractive, promptAndConfigureOllama } from "./setup.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pendingAbortableResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
}

describe("Ollama onboarding model selection", () => {
  it("preserves catalog order while preferring an explicit latest tag", () => {
    expect(mergeUniqueModelNames(["gemma4", "qwen3:0.6b"], ["GEMMA4:latest"])).toEqual([
      "GEMMA4:latest",
      "qwen3:0.6b",
    ]);
  });

  it("resolves normalized custom model names to the installed latest tag", () => {
    expect(normalizeOllamaModelName("  OLLAMA/Gemma4  ")).toBe("Gemma4");
    expect(findAvailableOllamaModelName("Gemma4", ["qwen3:0.6b", "gemma4:latest"])).toBe(
      "gemma4:latest",
    );
  });

  it("keeps failed model inspections distinct from uninspected models", () => {
    const models = buildOllamaModelsConfig(
      ["deepseek-r1:14b", "uninspected"],
      new Map([["deepseek-r1:14b", { name: "deepseek-r1:14b", showInspectionFailed: true }]]),
    );

    expect(models[0]?.compat?.supportsTools).toBe(false);
    expect(models[0]?.reasoning).toBe(true);
    expect(models[1]?.compat?.supportsTools).toBe(true);
  });

  it("preserves discovered Gemma vision, reasoning, context, and tool capabilities", () => {
    const [model] = buildOllamaModelsConfig(
      ["gemma4:e2b"],
      new Map([
        [
          "gemma4:e2b",
          {
            name: "gemma4:e2b",
            contextWindow: 131_072,
            capabilities: ["completion", "tools", "vision", "thinking"],
          },
        ],
      ]),
    );

    expect(model).toMatchObject({
      id: "gemma4:e2b",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 131_072,
      compat: { supportsTools: true },
    });
  });

  it("selects a deterministic tools-capable model with enough context", () => {
    expect(
      selectAppGuidedOllamaModelFromDiscovery([
        { name: "llama3:8b", contextWindow: 32_768, capabilities: ["tools"] },
        { name: "qwen3:0.6b", contextWindow: 40_960, capabilities: ["tools"] },
        { name: "gemma4:e4b", contextWindow: 8_192, capabilities: ["tools"] },
      ]),
    ).toBe("qwen3:0.6b");
  });

  it.each([
    {
      description: "skips a smaller model with an explicit thinking capability",
      capabilities: ["tools", "thinking"],
      expected: "llama3.2:latest",
    },
    {
      description: "trusts explicit non-thinking capabilities over a reasoning-like model name",
      capabilities: ["tools"],
      expected: "deepseek-r1:8b",
    },
  ])("$description", ({ capabilities, expected }) => {
    expect(
      selectAppGuidedOllamaModelFromDiscovery([
        {
          name: "deepseek-r1:8b",
          contextWindow: 131_072,
          capabilities,
          size: 1_000,
        },
        {
          name: "orieg/gemma3-tools:12b-ft",
          contextWindow: 131_072,
          capabilities: ["tools"],
          size: 8_000,
        },
        {
          name: "llama3.2:latest",
          contextWindow: 131_072,
          capabilities: ["tools"],
          size: 2_000,
        },
      ]),
    ).toBe(expected);
  });

  it("selects the smallest explicitly non-thinking model during interactive setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/tags")) {
          return Response.json({
            models: [
              { name: "deepseek-r1:1b", size: 100 },
              { name: "llama3:70b", size: 70_000 },
            ],
          });
        }
        if (url.endsWith("/api/show")) {
          return Response.json({
            model_info: { "test.context_length": 32_768 },
            capabilities: ["completion", "tools"],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const prompter = {
      select: vi.fn().mockResolvedValueOnce("local-only"),
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;
    const result = await promptAndConfigureOllama({ cfg: {}, prompter });
    const selected = result.config.models?.providers?.ollama?.models?.find(
      (model) => model.id === "deepseek-r1:1b",
    );

    expect(selected?.reasoning).toBe(false);
    expect(result.defaultModel).toBe("ollama/deepseek-r1:1b");
  });

  it.each([
    {
      description: "model inspection fails",
      showResponse: () => Response.json({ error: "inspection unavailable" }, { status: 503 }),
    },
    {
      description: "model inspection omits metadata",
      showResponse: () => Response.json({}),
    },
  ])(
    "selects and configures list-advertised models when $description",
    async ({ showResponse }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) =>
          requestUrl(input).endsWith("/api/tags")
            ? Response.json({
                models: [
                  {
                    name: "gemma4:e2b",
                    size: 2_000_000_000,
                    details: { context_length: 32_768 },
                    capabilities: ["completion", "tools"],
                  },
                ],
              })
            : showResponse(),
        ),
      );
      const prompter = {
        select: vi.fn().mockResolvedValueOnce("local-only"),
        text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
        note: vi.fn(async () => undefined),
        confirm: vi.fn().mockResolvedValue(false),
      } as unknown as WizardPrompter;

      const result = await promptAndConfigureOllama({ cfg: {}, prompter });

      expect(result.defaultModel).toBe("ollama/gemma4:e2b");
      expect(result.config.models?.providers?.ollama?.models).toContainEqual(
        expect.objectContaining({
          id: "gemma4:e2b",
          contextWindow: 32_768,
          compat: expect.objectContaining({ supportsTools: true }),
        }),
      );
      expect(prompter.confirm).not.toHaveBeenCalled();
    },
  );

  it("preserves incomplete remote-model-only capabilities during interactive setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/api/tags")
          ? Response.json({
              models: [
                {
                  name: "deepseek-r1:remote",
                  remote_model: "upstream-deepseek-r1",
                  size: 2_000_000_000,
                  details: { context_length: 32_768 },
                  capabilities: ["tools"],
                },
              ],
            })
          : Response.json({}),
      ),
    );
    const prompter = {
      select: vi.fn().mockResolvedValueOnce("cloud-local"),
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      note: vi.fn(async () => undefined),
      confirm: vi.fn().mockResolvedValue(false),
    } as unknown as WizardPrompter;

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(result.defaultModel).toBe("ollama/deepseek-r1:remote");
    expect(result.config.models?.providers?.ollama?.models).toContainEqual(
      expect.objectContaining({
        id: "deepseek-r1:remote",
        contextWindow: 32_768,
        reasoning: true,
        compat: expect.objectContaining({ supportsTools: true }),
      }),
    );
  });

  it.each([
    ["local-only", "completion"],
    ["cloud-local", "completion"],
    ["cloud-local", "embedding"],
  ] as const)(
    "respects %s mode with %s remote rows before inspecting and configuring mixed inventory",
    async (mode, remoteCapability) => {
      const remoteModels = Array.from({ length: 201 }, (_, index) => ({
        name: index % 3 === 2 ? `remote-${index}:cloud` : `remote-${index}:latest`,
        ...(index % 3 === 0 ? { remote_host: "https://ollama.com" } : {}),
        ...(index % 3 === 1 ? { remote_model: `upstream-${index}` } : {}),
        size: 1,
      }));
      const inspected: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (requestUrl(input).endsWith("/api/tags")) {
            return Response.json({
              models: [...remoteModels, { name: "local-chat:latest", size: 500 }],
            });
          }
          if (requestUrl(input).endsWith("/api/show")) {
            const { model } = JSON.parse(requestBodyText(init?.body));
            inspected.push(model);
            return Response.json({
              capabilities: [
                model.startsWith("remote-") ? remoteCapability : "completion",
                "tools",
              ],
              model_info: { "test.context_length": 32_768 },
            });
          }
          return Response.json({});
        }),
      );
      const prompter = {
        select: vi.fn().mockResolvedValueOnce(mode),
        text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
        note: vi.fn(async () => undefined),
        confirm: vi.fn().mockResolvedValue(false),
      } as unknown as WizardPrompter;

      const result = await promptAndConfigureOllama({ cfg: {}, prompter });
      const configured = result.config.models?.providers?.ollama?.models.map((model) => model.id);

      if (mode === "local-only") {
        expect(inspected).toEqual(["local-chat:latest"]);
        expect(result.defaultModel).toBe("ollama/local-chat:latest");
        expect(configured).toContain("local-chat:latest");
        expect(configured?.filter((name) => name.startsWith("remote-"))).toEqual([]);
      } else {
        expect(inspected).toContain(remoteModels[0]?.name);
        expect(configured).toEqual(expect.arrayContaining(remoteModels.map((model) => model.name)));
        if (remoteCapability === "embedding") {
          expect(inspected).toContain("local-chat:latest");
          expect(result.defaultModel).toBe("ollama/local-chat:latest");
        }
      }
    },
  );

  describe.each(["interactive", "non-interactive"] as const)("%s defaults", (mode) => {
    it.each([
      ["embedding-only", ["embedding"], undefined, false, false],
      ["embedding with advertised tools", ["embedding", "tools"], undefined, false, true],
      ["completion and embedding", ["completion", "embedding"], undefined, true, true],
      ["unknown remote capabilities", [], undefined, true, true],
      ["authoritative empty inspection", ["completion", "tools"], [], false, false],
    ] as const)(
      "respects %s capabilities when selecting and configuring a default",
      async (_description, capabilities, inspectedCapabilities, useRemote, supportsTools) => {
        const remoteName = "remote-model:latest";
        const localName = "local-chat:latest";
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (requestUrl(input).endsWith("/api/tags")) {
              return Response.json({
                models: [
                  { name: remoteName, remote_model: "upstream-model", size: 1, capabilities },
                  { name: localName, size: 500 },
                ],
              });
            }
            if (requestUrl(input).endsWith("/api/show")) {
              const { model } = JSON.parse(requestBodyText(init?.body));
              return Response.json({
                model_info: { "test.context_length": 32_768 },
                capabilities:
                  model === remoteName ? inspectedCapabilities : ["completion", "tools"],
              });
            }
            return Response.json({});
          }),
        );
        const expectedDefault = `ollama/${useRemote ? remoteName : localName}`;
        let config: OpenClawConfig;
        if (mode === "interactive") {
          const result = await promptAndConfigureOllama({
            cfg: {},
            prompter: {
              select: vi.fn().mockResolvedValueOnce("cloud-local"),
              text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
              note: vi.fn(async () => undefined),
              confirm: vi.fn().mockResolvedValue(false),
            } as unknown as WizardPrompter,
          });
          expect(result.defaultModel).toBe(expectedDefault);
          config = result.config;
        } else {
          config = await configureOllamaNonInteractive({
            nextConfig: {},
            opts: { customBaseUrl: "http://127.0.0.1:11434" },
            runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          });
          expect(config.agents?.defaults?.model).toEqual({ primary: expectedDefault });
        }
        expect(config.models?.providers?.ollama?.models).toContainEqual(
          expect.objectContaining({
            id: remoteName,
            compat: expect.objectContaining({ supportsTools }),
          }),
        );
      },
    );
  });

  it("aborts pending model discovery with the setup signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        pendingAbortableResponse(init?.signal),
      ),
    );

    const discovery = discoverOllamaModelsForSetup({
      baseUrl: "http://127.0.0.1:11434",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    });
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts pending context enrichment with the setup signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "gemma4" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return pendingAbortableResponse(init?.signal);
      }),
    );

    const discovery = discoverOllamaModelsForSetup({
      baseUrl: "http://127.0.0.1:11434",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
  });
});
