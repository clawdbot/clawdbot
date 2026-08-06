// Shared Docker E2E OpenAI provider config seed helper.
// Uses packaged plugin-sdk runtime modules so seeded configs match the npm tarball.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyProviderConfigWithDefaultModelPreset,
  type ModelDefinitionConfig,
  type OpenClawConfig,
} from "../../dist/plugin-sdk/provider-onboard.js";

export type { OpenClawConfig };

const DOCKER_OPENAI_MODEL_REF = "openai/gpt-5.6-luna";
const DOCKER_OPENAI_BASE_URL =
  process.env.OPENCLAW_DOCKER_OPENAI_BASE_URL?.trim() || "http://127.0.0.1:9/v1";
const DOCKER_OPENAI_MODEL: ModelDefinitionConfig = {
  id: "gpt-5.6-luna",
  name: "gpt-5.6-luna",
  api: "openai-responses",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
};

export function applyDockerOpenAiProviderConfig(
  config: OpenClawConfig,
  apiKey: string,
): OpenClawConfig {
  const seededConfig = applyProviderConfigWithDefaultModelPreset(config, {
    providerId: "openai",
    api: "openai-responses",
    baseUrl: DOCKER_OPENAI_BASE_URL,
    defaultModel: DOCKER_OPENAI_MODEL,
    defaultModelId: DOCKER_OPENAI_MODEL.id,
    aliases: [{ modelRef: DOCKER_OPENAI_MODEL_REF, alias: "GPT" }],
    primaryModelRef: DOCKER_OPENAI_MODEL_REF,
  });
  const openAiProvider = seededConfig.models?.providers?.openai;
  if (!openAiProvider) {
    throw new Error("failed to seed OpenAI provider config");
  }
  openAiProvider.apiKey = apiKey;
  return seededConfig;
}

async function writeDockerOpenAiProviderConfigFile(): Promise<string> {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
  const apiKey = process.env.OPENAI_API_KEY?.trim() || "sk-docker-smoke-test";
  let config: OpenClawConfig = {};
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const seededConfig = applyDockerOpenAiProviderConfig(config, apiKey);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(seededConfig, null, 2)}\n`, "utf8");
  return configPath;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const configPath = await writeDockerOpenAiProviderConfigFile();
  process.stdout.write(`${JSON.stringify({ ok: true, configPath })}\n`);
}
