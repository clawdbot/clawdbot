import { describe, expect, it } from "vitest";
import { resolveProviderDiscoveryFilterForTest } from "./models-config.providers.implicit.js";

function liveFilterEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    VITEST: "1",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function resolveOwners(provider: string): readonly string[] | undefined {
  return provider === "claude-cli" ? ["anthropic"] : undefined;
}

describe("resolveProviderDiscoveryFilterForTest", () => {
  it("maps live provider backend ids to owning plugin ids", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "claude-cli",
        }),
        resolveOwners,
      }),
    ).toEqual(["anthropic"]);
  });

  it("honors gateway live provider filters too", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_GATEWAY_PROVIDERS: "claude-cli",
        }),
        resolveOwners,
      }),
    ).toEqual(["anthropic"]);
  });

  it("keeps explicit plugin-id filters when no owning provider plugin exists", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "openrouter",
        }),
        resolveOwners,
      }),
    ).toEqual(["openrouter"]);
  });
});
