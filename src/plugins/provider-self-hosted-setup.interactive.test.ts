import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { promptAndConfigureOpenAICompatibleSelfHostedProviderAuth } from "./provider-self-hosted-setup.js";

const { fetchWithSsrFGuardMock, upsertAuthProfileWithLock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(async () => null),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLock,
}));

describe("promptAndConfigureOpenAICompatibleSelfHostedProviderAuth", () => {
  it("returns normalized interactive setup results", async () => {
    const prompter = createWizardPrompter();
    vi.mocked(prompter.text)
      .mockResolvedValueOnce(" https://fixture.example.invalid/v1/// ")
      .mockResolvedValueOnce(" synthetic-setup-key ")
      .mockResolvedValueOnce(" org/demo-model ");
    const cfg = {
      agents: { defaults: { model: "existing/model" } },
      models: {
        mode: "replace",
        providers: { existing: { baseUrl: "https://existing.example.invalid/v1", models: [] } },
      },
    } satisfies OpenClawConfig;

    const result = await promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
      cfg,
      prompter,
      providerId: "fixture",
      providerLabel: "Fixture",
      defaultBaseUrl: "http://127.0.0.1:8000/v1",
      defaultApiKeyEnvVar: "FIXTURE_API_KEY",
      modelPlaceholder: "org/example",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 8192,
      maxTokens: 1024,
    });

    expect(result).toEqual({
      profiles: [
        {
          profileId: "fixture:default",
          credential: { type: "api_key", provider: "fixture", key: "synthetic-setup-key" },
        },
      ],
      configPatch: {
        ...cfg,
        models: {
          ...cfg.models,
          providers: {
            ...cfg.models.providers,
            fixture: {
              baseUrl: "https://fixture.example.invalid/v1",
              api: "openai-completions",
              apiKey: "FIXTURE_API_KEY",
              models: [
                {
                  id: "org/demo-model",
                  name: "org/demo-model",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
      },
      defaultModel: "fixture/org/demo-model",
    });
    expect(vi.mocked(prompter.text).mock.calls).toEqual([
      [
        {
          message: "Fixture base URL",
          initialValue: "http://127.0.0.1:8000/v1",
          placeholder: "http://127.0.0.1:8000/v1",
          validate: expect.any(Function),
        },
      ],
      [
        {
          message: "Fixture API key",
          placeholder: "sk-... (or any non-empty string)",
          validate: expect.any(Function),
          sensitive: true,
        },
      ],
      [{ message: "Fixture model", placeholder: "org/example", validate: expect.any(Function) }],
    ]);
    for (const [prompt] of vi.mocked(prompter.text).mock.calls) {
      expect(prompt.validate?.(" ")).toBe("Required");
      expect(prompt.validate?.(" value ")).toBeUndefined();
    }
    expect(upsertAuthProfileWithLock).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});
