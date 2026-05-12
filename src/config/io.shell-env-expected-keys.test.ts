import { describe, expect, it, vi } from "vitest";

const listKnownChannelEnvVarNames = vi.hoisted(() => vi.fn(() => ["DISCORD_BOT_TOKEN"]));
const listKnownProviderAuthEnvVarNames = vi.hoisted(() => vi.fn(() => ["OPENAI_API_KEY"]));

vi.mock("../secrets/channel-env-vars.js", () => ({
  listKnownChannelEnvVarNames,
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  listKnownProviderAuthEnvVarNames,
}));

describe("config io shell env expected keys", () => {
  it("includes provider and channel env vars from manifest-driven plugin metadata", async () => {
    listKnownProviderAuthEnvVarNames.mockReturnValueOnce([
      "OPENAI_API_KEY",
      "ARCEEAI_API_KEY",
      "FIREWORKS_ALT_API_KEY",
    ]);
    listKnownChannelEnvVarNames.mockReturnValueOnce([
      "DISCORD_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);

    vi.resetModules();
    const { resolveShellEnvExpectedKeys } = await import("./shell-env-expected-keys.js");

    const expectedKeys = resolveShellEnvExpectedKeys({} as NodeJS.ProcessEnv);
    expect(expectedKeys).toContain("OPENAI_API_KEY");
    expect(expectedKeys).toContain("ARCEEAI_API_KEY");
    expect(expectedKeys).toContain("FIREWORKS_ALT_API_KEY");
    expect(expectedKeys).toContain("DISCORD_BOT_TOKEN");
    expect(expectedKeys).toContain("SLACK_BOT_TOKEN");
    expect(expectedKeys).toContain("OPENCLAW_GATEWAY_TOKEN");
  });
});
