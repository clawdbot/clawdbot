import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { createProviderApiKeyAuthMethod } from "./provider-api-key-auth.js";

describe("createProviderApiKeyAuthMethod", () => {
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
});
