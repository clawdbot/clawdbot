import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveCodexNativeAuth = vi.hoisted(() => vi.fn());

vi.mock("./src/app-server/native-auth.js", () => ({ resolveCodexNativeAuth }));

import provider from "./provider-discovery.js";

describe("Codex provider discovery", () => {
  beforeEach(() => {
    resolveCodexNativeAuth.mockReset();
  });

  it("publishes the runtime-owned marker for an authenticated canonical provider", () => {
    resolveCodexNativeAuth.mockReturnValue({
      apiKey: "codex-app-server",
      source: "Codex CLI native auth",
      mode: "oauth",
    });
    const config = {};

    expect(provider.resolveSyntheticAuth?.({ config, provider: "openai" })).toEqual({
      apiKey: "codex-app-server",
      source: "Codex CLI native auth",
      mode: "oauth",
      runtime: "codex",
    });
    expect(provider.resolveSyntheticAuth?.({ config, provider: "codex" })).toEqual({
      apiKey: "codex-app-server",
      source: "Codex CLI native auth",
      mode: "oauth",
      runtime: "codex",
    });
    expect(resolveCodexNativeAuth).toHaveBeenCalledOnce();
  });

  it("does not publish a marker when Codex reports no login", () => {
    resolveCodexNativeAuth.mockReturnValue(undefined);
    const config = {};

    expect(provider.resolveSyntheticAuth?.({ config, provider: "openai" })).toBeUndefined();
    expect(provider.resolveSyntheticAuth?.({ config, provider: "other" })).toBeUndefined();
    // A logged-out probe is cached like a positive one; re-probing would respawn
    // `codex login status` (3s timeout) on every synthetic-auth pass.
    expect(provider.resolveSyntheticAuth?.({ config, provider: "codex" })).toBeUndefined();
    expect(resolveCodexNativeAuth).toHaveBeenCalledOnce();
  });
});
