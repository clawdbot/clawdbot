import { bundledPluginRoot } from "../../scripts/lib/bundled-plugin-paths.mjs";

export const providerExtensionIds = [
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "byteplus",
  "chutes",
  "comfy",
  "deepseek",
  "github-copilot",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "lmstudio",
  "microsoft",
  "microsoft-foundry",
  "minimax",
  "mistral",
  "qwen",
  "moonshot",
  "nvidia",
  "ollama",
  "openrouter",
  "qianfan",
  "stepfun",
  "together",
  "venice",
  "volcengine",
  "xai",
  "zai",
];

export const providerOpenAiExtensionIds = ["openai"];

export const providerExtensionTestRoots = providerExtensionIds.map((id) => bundledPluginRoot(id));
export const providerOpenAiExtensionTestRoots = providerOpenAiExtensionIds.map((id) =>
  bundledPluginRoot(id),
);

export function isProviderExtensionRoot(root) {
  return providerExtensionTestRoots.includes(root);
}

export function isProviderOpenAiExtensionRoot(root) {
  return providerOpenAiExtensionTestRoots.includes(root);
}
