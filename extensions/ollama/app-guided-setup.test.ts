import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const selected = "setup-tools:latest";
const configuredModel: ModelDefinitionConfig = {
  id: selected,
  name: "Existing model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 8_192,
  compat: { supportsTools: true },
};

async function withOllamaServer(
  options: {
    models?: string[];
    loaded?: string[];
    show?: Record<string, unknown>;
    showStatus?: number;
    onShow?: () => void;
  },
  run: (baseUrl: string, inspected: string[]) => Promise<void>,
) {
  const inspected: string[] = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/ps") {
          response.end(
            JSON.stringify({ models: (options.loaded ?? [selected]).map((name) => ({ name })) }),
          );
        } else if (request.url === "/api/tags") {
          response.end(
            JSON.stringify({ models: (options.models ?? [selected]).map((name) => ({ name })) }),
          );
        } else if (request.url === "/api/show") {
          inspected.push((JSON.parse(body) as { model: string }).model);
          options.onShow?.();
          response.writeHead(options.showStatus ?? 200).end(
            JSON.stringify(
              options.show ?? {
                model_info: { "model.context_length": 32_768 },
                capabilities: ["completion", "tools"],
              },
            ),
          );
        } else {
          response.writeHead(404).end();
        }
      });
    },
    async (baseUrl) => {
      await run(baseUrl, inspected);
    },
  );
}

function guidedSetup() {
  const guided = capturePluginRegistration(plugin).providers.find(
    (provider) => provider.id === "ollama",
  )?.auth[0]?.appGuidedSetup;
  if (!guided) {
    throw new Error("Ollama app-guided setup was not registered");
  }
  return guided;
}

describe("Ollama app-guided setup HTTP discovery", () => {
  it.each(["detect", "prepare"] as const)(
    "%s finds a loaded model beyond the general catalog cap without inspecting idle models",
    async (operation) => {
      const models = [...Array.from({ length: 200 }, (_, index) => `idle-${index}`), selected];
      await withOllamaServer({ models }, async (baseUrl, inspected) => {
        const guided = guidedSetup();
        const context = {
          config: { models: { providers: { ollama: { baseUrl, models: [] } } } },
          env: {},
        };
        const result =
          operation === "detect"
            ? await guided.detect(context)
            : await guided.prepare({ ...context, modelRef: `ollama/${selected}` });
        expect(result).toMatchObject(
          operation === "detect"
            ? { modelRef: `ollama/${selected}` }
            : { defaultModel: `ollama/${selected}` },
        );
        expect(inspected).toEqual([selected]);
      });
    },
  );

  it.each([
    { name: "unmeasured context", show: { capabilities: ["completion", "tools"] } },
    {
      name: "no tool support",
      show: { model_info: { "model.context_length": 32_768 }, capabilities: ["completion"] },
    },
    {
      name: "no completion support",
      show: { model_info: { "model.context_length": 32_768 }, capabilities: ["tools"] },
    },
    { name: "failed inspection", showStatus: 503 },
  ])("rejects a loaded model with $name", async (options) => {
    await withOllamaServer(options, async (baseUrl) => {
      await expect(
        guidedSetup().detect({
          config: { models: { providers: { ollama: { baseUrl, models: [] } } } },
          env: {},
        }),
      ).resolves.toBeNull();
    });
  });

  it.each(["detect", "prepare"] as const)(
    "cancels %s during model inspection",
    async (operation) => {
      const controller = new AbortController();
      await withOllamaServer(
        { onShow: () => controller.abort(new Error("Setup cancelled")) },
        async (baseUrl, inspected) => {
          const context = {
            config: { models: { providers: { ollama: { baseUrl, models: [] } } } },
            env: {},
            signal: controller.signal,
          };
          const guided = guidedSetup();
          await expect(
            operation === "detect"
              ? guided.detect(context)
              : guided.prepare({ ...context, modelRef: `ollama/${selected}` }),
          ).rejects.toThrow("Setup cancelled");
          expect(inspected).toEqual([selected]);
        },
      );
    },
  );

  it("prepares an idle configured model while retaining the provider and its other models", async () => {
    await withOllamaServer({ loaded: [] }, async (baseUrl, inspected) => {
      const otherModel = { ...configuredModel, id: "other-model", params: { temperature: 0.5 } };
      const provider = {
        baseUrl,
        api: "ollama" as const,
        apiKey: "fixture-provider-access",
        headers: { "X-Provider": "fixture" },
        timeoutSeconds: 17,
        models: [otherModel, configuredModel],
      };
      const result = await guidedSetup().prepare({
        config: { models: { providers: { ollama: provider } } },
        env: {},
        modelRef: `ollama/${selected}`,
      });
      expect(result?.defaultModel).toBe(`ollama/${selected}`);
      expect(result?.configPatch?.models?.providers?.ollama).toMatchObject({
        ...provider,
        models: [otherModel, expect.objectContaining({ id: selected, contextTokens: 32_768 })],
      });
      expect(inspected).toEqual([selected]);
    });
  });

  it.each(["local", "cloud"] as const)(
    "only explicit cloud setup can use a configured %s model absent from tags",
    async (kind) => {
      const model = { ...configuredModel, id: kind === "cloud" ? "setup-tools:cloud" : selected };
      await withOllamaServer({ models: [], loaded: [], show: {} }, async (baseUrl) => {
        const result = await guidedSetup().prepare({
          config: { models: { providers: { ollama: { baseUrl, models: [model] } } } },
          env: {},
          modelRef: `ollama/${model.id}`,
        });
        if (kind === "cloud") {
          expect(result?.defaultModel).toBe(`ollama/${model.id}`);
          const prepared = result?.configPatch?.models?.providers?.ollama?.models?.[0];
          expect(prepared?.contextWindow).toBe(model.contextWindow);
          expect(prepared?.contextTokens).toBeUndefined();
        } else {
          expect(result).toBeNull();
        }
      });
    },
  );
});
