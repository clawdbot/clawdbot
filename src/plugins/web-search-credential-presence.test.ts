import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => [
    {
      id: "brave",
      pluginId: "brave",
      envVars: ["BRAVE_API_KEY"],
      getCredentialValue: (searchConfig: Record<string, unknown> | undefined) =>
        searchConfig?.apiKey,
    },
  ]),
}));

vi.mock("./web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

let hasConfiguredWebSearchCredential: typeof import("./web-search-credential-presence.js").hasConfiguredWebSearchCredential;

beforeAll(async () => {
  ({ hasConfiguredWebSearchCredential } = await import("./web-search-credential-presence.js"));
});

beforeEach(() => {
  resolvePluginWebSearchProvidersMock.mockClear();
});

describe("hasConfiguredWebSearchCredential", () => {
  it("keeps empty config and env on the manifest-only path", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {},
        origin: "bundled",
        bundledAllowlistCompat: true,
      }),
    ).toBe(false);
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("loads provider runtime only when a credential candidate exists", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "brave-key" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
        bundledAllowlistCompat: true,
      }),
    ).toBe(true);
    expect(resolvePluginWebSearchProvidersMock).toHaveBeenCalledTimes(1);
  });
});
