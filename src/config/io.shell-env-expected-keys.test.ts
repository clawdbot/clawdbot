// Verifies shell environment key metadata used by config IO.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./types.openclaw.js";

const listKnownChannelEnvVarNames = vi.hoisted(() =>
  vi.fn((_params?: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv }) => ["DISCORD_BOT_TOKEN"]),
);
const listKnownProviderAuthEnvVarNames = vi.hoisted(() =>
  vi.fn((_params?: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv }) => ["OPENAI_API_KEY"]),
);

vi.mock("../secrets/channel-env-vars.js", () => ({
  listKnownChannelEnvVarNames,
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {},
  }),
}));

describe("config io shell env expected keys", () => {
  it("includes provider and channel env vars from manifest-driven plugin metadata", async () => {
    const config: OpenClawConfig = {
      agents: { list: [{ id: "solo", workspace: "/workspace/owner" }] },
    };
    listKnownProviderAuthEnvVarNames.mockImplementationOnce((params) =>
      params?.config?.agents?.list?.[0]?.workspace === "/workspace/owner"
        ? ["OPENAI_API_KEY", "ARCEEAI_API_KEY", "FIREWORKS_ALT_API_KEY"]
        : [],
    );
    listKnownChannelEnvVarNames.mockImplementationOnce((params) =>
      params?.config?.agents?.list?.[0]?.workspace === "/workspace/owner"
        ? ["DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]
        : [],
    );

    vi.resetModules();
    const { resolveShellEnvExpectedKeys } = await import("./shell-env-expected-keys.js");

    const expectedKeys = resolveShellEnvExpectedKeys({}, config);
    expect(expectedKeys).toEqual([
      "OPENAI_API_KEY",
      "ARCEEAI_API_KEY",
      "FIREWORKS_ALT_API_KEY",
      "DISCORD_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "OPENCLAW_GATEWAY_TOKEN",
      "OPENCLAW_GATEWAY_PASSWORD",
    ]);
  });
});
