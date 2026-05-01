import { expect } from "vitest";

export const openaiCodexCatalogEntries = [
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
  { provider: "openai", id: "gpt-5.2-pro", name: "GPT-5.2 Pro" },
  { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
  { provider: "openai", id: "gpt-5-nano", name: "GPT-5 nano" },
  { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
];

export const expectedAugmentedOpenaiCodexCatalogEntries = [
  { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
  { provider: "openai", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
  { provider: "openai", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
  { provider: "openai", id: "gpt-5.4-nano", name: "gpt-5.4-nano" },
  { provider: "openai-codex", id: "gpt-5.4", name: "gpt-5.4" },
  { provider: "openai-codex", id: "gpt-5.4-pro", name: "gpt-5.4-pro" },
  { provider: "openai-codex", id: "gpt-5.4-mini", name: "gpt-5.4-mini" },
];

export const expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55 = [
  { provider: "openai", id: "gpt-5.5-pro", name: "gpt-5.5-pro" },
  ...expectedAugmentedOpenaiCodexCatalogEntries.slice(0, 4),
  { provider: "openai-codex", id: "gpt-5.5-pro", name: "gpt-5.5-pro" },
  ...expectedAugmentedOpenaiCodexCatalogEntries.slice(4),
];

export const expectedOpenaiPluginCodexCatalogEntriesWithGpt55 =
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55;

export function expectCodexMissingAuthHint(
  buildProviderMissingAuthMessageWithPlugin: (params: {
    provider: string;
    env: NodeJS.ProcessEnv;
    context: {
      env: NodeJS.ProcessEnv;
      provider: string;
      listProfileIds: (providerId: string) => string[];
    };
  }) => string | undefined,
  expectedModel = "openai/gpt-5.5",
) {
  expect(
    buildProviderMissingAuthMessageWithPlugin({
      provider: "openai",
      env: process.env,
      context: {
        env: process.env,
        provider: "openai",
        listProfileIds: (providerId) => (providerId === "openai-codex" ? ["p1"] : []),
      },
    }),
  ).toContain(expectedModel);
}

export async function expectAugmentedCodexCatalog(
  augmentModelCatalogWithProviderPlugins: (params: {
    env: NodeJS.ProcessEnv;
    context: {
      env: NodeJS.ProcessEnv;
      entries: typeof openaiCodexCatalogEntries;
    };
  }) => Promise<unknown>,
  expectedEntries = expectedAugmentedOpenaiCodexCatalogEntries,
) {
  const result = (await augmentModelCatalogWithProviderPlugins({
    env: process.env,
    context: {
      env: process.env,
      entries: openaiCodexCatalogEntries,
    },
  })) as Array<Record<string, unknown>>;
  expect(result).toHaveLength(expectedEntries.length);
  for (const entry of expectedEntries) {
    expect(result).toContainEqual(expect.objectContaining(entry));
  }
}
