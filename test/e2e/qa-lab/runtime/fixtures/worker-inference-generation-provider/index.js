import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "qa-worker-generation";
const PROVIDER_ID = PLUGIN_ID;
const MODEL_ID = "qa-worker-generation-model";

function requireConfig(pluginConfig) {
  const generation = pluginConfig?.generation;
  const tracePath = pluginConfig?.tracePath;
  const barrierPath = pluginConfig?.barrierPath;
  const mockProviderBaseUrl = pluginConfig?.mockProviderBaseUrl;
  if (
    (generation !== "A" && generation !== "B" && generation !== "C") ||
    typeof tracePath !== "string" ||
    !tracePath ||
    typeof barrierPath !== "string" ||
    !barrierPath ||
    typeof mockProviderBaseUrl !== "string" ||
    !mockProviderBaseUrl
  ) {
    throw new Error("qa worker generation fixture config is incomplete");
  }
  return { generation, tracePath, barrierPath, mockProviderBaseUrl };
}

function createTraceWriter(tracePath, generation) {
  mkdirSync(path.dirname(tracePath), { recursive: true });
  return (event, facts = {}) => {
    appendFileSync(
      tracePath,
      `${JSON.stringify({ event, generation, ...facts, at: Date.now() })}\n`,
      "utf8",
    );
  };
}

async function readBarrierState(barrierPath) {
  return await readFile(barrierPath, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
}

async function waitForBarrierRelease(barrierPath) {
  const deadline = Date.now() + 120_000;
  while ((await readBarrierState(barrierPath)) !== "released") {
    if (Date.now() >= deadline) {
      throw new Error("qa worker generation barrier release timed out");
    }
    await sleep(25);
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "QA worker generation fixture",
  description: "Exercises worker inference provider ownership across plugin reload.",
  register(api) {
    const { generation, tracePath, barrierPath, mockProviderBaseUrl } = requireConfig(
      api.pluginConfig,
    );
    const trace = createTraceWriter(tracePath, generation);
    const sourceCredential = api.config.models?.providers?.[PROVIDER_ID]?.apiKey;
    if (typeof sourceCredential !== "string" || !sourceCredential) {
      throw new Error("qa worker generation provider requires a direct credential");
    }
    trace("registered", { registrationMode: api.registrationMode });
    api.registerReload({
      hotPrefixes: [`plugins.entries.${PLUGIN_ID}.config`],
    });
    api.registerProvider({
      id: PROVIDER_ID,
      label: "QA worker generation provider",
      auth: [],
      normalizeResolvedModel: ({ model }) => {
        trace("model", { modelMatches: model.id === MODEL_ID });
        return {
          ...model,
          baseUrl: mockProviderBaseUrl,
          params: {
            ...model.params,
            fixtureBaseUrl: mockProviderBaseUrl,
            fixtureGeneration: generation,
          },
        };
      },
      prepareRuntimeAuth: async ({ apiKey, model }) => {
        const shouldWait = (await readBarrierState(barrierPath)) === "armed";
        trace("auth-prepare", {
          modelGenerationMatches: model.params?.fixtureGeneration === generation,
          sourceAuthMatchesGeneration: apiKey === sourceCredential,
          waited: shouldWait,
        });
        if (shouldWait) {
          await waitForBarrierRelease(barrierPath);
          trace("auth-prepare-released", { waited: true });
        }
        const runtimeGeneration =
          typeof apiKey === "string" ? apiKey.slice(apiKey.lastIndexOf("-") + 1) : generation;
        const runtimeCredential = `qa-worker-runtime-${runtimeGeneration}`;
        trace("auth-ready", { runtimeCredentialGeneration: runtimeGeneration });
        return { apiKey: runtimeCredential };
      },
      createStreamFn: ({ model }) => {
        trace("factory", {
          modelGenerationMatches: model.params?.fixtureGeneration === generation,
        });
        return streamSimple;
      },
      prepareExtraParams: ({ model }) => {
        trace("policy", {
          modelGenerationMatches: model?.params?.fixtureGeneration === generation,
        });
        return {};
      },
      wrapStreamFn: ({ model, streamFn }) => {
        trace("wrapper", {
          modelGenerationMatches: model?.params?.fixtureGeneration === generation,
          streamPresent: Boolean(streamFn),
        });
        if (!streamFn) {
          return undefined;
        }
        return (streamModel, context, options) => {
          trace("execution", {
            authPresent: typeof options?.apiKey === "string" && options.apiKey.length > 0,
            baseUrlMatchesGeneration: streamModel.baseUrl === mockProviderBaseUrl,
            modelGenerationMatches: streamModel.params?.fixtureGeneration === generation,
          });
          return streamFn(streamModel, context, options);
        };
      },
    });
  },
});
