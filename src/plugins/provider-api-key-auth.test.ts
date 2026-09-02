import { describe, expect, it, vi } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createProviderApiKeyAuthMethod } from "./provider-api-key-auth.js";

describe("createProviderApiKeyAuthMethod", () => {
  it("persists non-interactive credentials through the runtime auth owner", async () => {
    await withOpenClawTestState({ label: "provider-api-key-auth" }, async (state) => {
      const method = createProviderApiKeyAuthMethod({
        providerId: "example",
        methodId: "api-key",
        label: "Example",
        optionKey: "exampleApiKey",
        flagName: "--example-api-key",
        envVar: "EXAMPLE_API_KEY",
        promptMessage: "Example API key",
      });
      const credential = { type: "api_key" as const, provider: "example", key: "test-token" };
      const config = await method.runNonInteractive?.({
        authChoice: "example-api-key",
        config: {},
        baseConfig: {},
        agentDir: state.agentDir(),
        opts: { exampleApiKey: "test-token" },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
        resolveApiKey: vi.fn(async () => ({ key: "test-token", source: "flag" as const })),
        toApiKeyCredential: () => credential,
      });
      expect(config?.auth?.profiles?.["example:default"]).toEqual({
        provider: "example",
        mode: "api_key",
      });
      expect(
        loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles["example:default"],
      ).toEqual(credential);
    });
  });

  it("exposes side-effect-free non-interactive credential validation", async () => {
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
    });
    const resolveApiKey = vi.fn(async () => ({ key: "test-token", source: "flag" as const }));

    const valid = await method.validateNonInteractive?.({
      authChoice: "example-api-key",
      config: {},
      baseConfig: {},
      opts: { exampleApiKey: "test-token" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
      resolveApiKey,
    });

    expect(valid).toBe(true);
    expect(resolveApiKey).toHaveBeenCalledWith({
      provider: "example",
      flagValue: "test-token",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
    });
  });

  it("applies a key-scoped default model during non-interactive auth", async () => {
    const resolveDefaultModel = vi.fn(async () => "example/enabled-model");
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
      defaultModel: "example/static-model",
      resolveDefaultModel,
    });

    const config = await method.runNonInteractive?.({
      authChoice: "example-api-key",
      config: {},
      baseConfig: {},
      opts: { exampleApiKey: "test-token" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
      resolveApiKey: vi.fn(async () => ({ key: "test-token", source: "profile" as const })),
      toApiKeyCredential: vi.fn(() => null),
    });

    expect(resolveDefaultModel).toHaveBeenCalledWith({ apiKey: "test-token", config: {} });
    expect(config?.agents?.defaults?.model).toEqual({ primary: "example/enabled-model" });
  });

  it.each([
    {
      name: "falls back to the static model when discovery fails",
      resolveDefaultModel: async () => {
        throw new Error("catalog unavailable");
      },
      expected: { primary: "example/static-model" },
    },
    {
      name: "leaves the model unset when discovery finds no safe default",
      resolveDefaultModel: async () => undefined,
      expected: undefined,
    },
  ])("$name", async ({ resolveDefaultModel, expected }) => {
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
      defaultModel: "example/static-model",
      resolveDefaultModel,
    });

    const config = await method.runNonInteractive?.({
      authChoice: "example-api-key",
      config: {},
      baseConfig: {},
      opts: { exampleApiKey: "test-token" },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
      resolveApiKey: vi.fn(async () => ({ key: "test-token", source: "profile" as const })),
      toApiKeyCredential: vi.fn(() => null),
    });

    expect(config?.agents?.defaults?.model).toEqual(expected);
  });

  it("returns a key-scoped default model during interactive auth", async () => {
    const resolveDefaultModel = vi.fn(async () => "example/enabled-model");
    const method = createProviderApiKeyAuthMethod({
      providerId: "example",
      methodId: "api-key",
      label: "Example",
      optionKey: "exampleApiKey",
      flagName: "--example-api-key",
      envVar: "EXAMPLE_API_KEY",
      promptMessage: "Example API key",
      defaultModel: "example/static-model",
      resolveDefaultModel,
    });

    const result = await method.run({
      config: {},
      env: {},
      opts: { exampleApiKey: "test-token" },
      prompter: { note: vi.fn() },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      secretInputMode: "plaintext",
    } as never);

    expect(resolveDefaultModel).toHaveBeenCalledWith({ apiKey: "test-token", config: {} });
    expect(result.defaultModel).toBe("example/enabled-model");
  });
});
