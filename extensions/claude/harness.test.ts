import { afterEach, describe, expect, it, vi } from "vitest";

// Spy on the shared-client pool module so we can assert exactly which pool
// key dispose() clears WITHOUT spawning a real bridge. The harness
// dynamic-imports this module, so the mock must be registered before the
// factory's dispose() runs (vi.mock is hoisted, so this is fine).
const clearSpy = vi.fn(async () => {});
vi.mock("./src/app-server/client.js", () => ({
  clearSharedClaudeAppServerClient: clearSpy,
}));

import { createClaudeAppServerAgentHarness } from "./harness.js";

/**
 * Regression guard for openclaw-91t: dispose() must clear ONLY the caller's
 * own pool slot, never the whole pool. With both extensions/claude and
 * extensions/glm-bridge registering a bridge harness, a keyless clear tore
 * down the sibling extension's live bridge process on reload/disable.
 */
describe("createClaudeAppServerAgentHarness dispose() pool-key scoping", () => {
  afterEach(() => {
    clearSpy.mockClear();
  });

  it("defaults to the anthropic pool slot for the Claude extension", async () => {
    const harness = createClaudeAppServerAgentHarness();
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:anthropic");
  });

  it("clears the zai pool slot for a glm-bridge-style harness", async () => {
    const harness = createClaudeAppServerAgentHarness({ providerIds: ["zai"] });
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:zai");
  });

  it("never clears the whole pool (keyless clear) — the openclaw-91t bug", async () => {
    const harness = createClaudeAppServerAgentHarness({ providerIds: ["zai"] });
    await harness.dispose?.();
    expect(clearSpy).not.toHaveBeenCalledWith(undefined);
    expect(clearSpy).not.toHaveBeenCalledWith();
  });

  it("honors an explicit poolKey override", async () => {
    const harness = createClaudeAppServerAgentHarness({
      providerIds: ["zai"],
      poolKey: "claude-bridge:custom",
    });
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:custom");
  });

  it("reset() clears the session's thread binding by session identity", async () => {
    const { createClaudeTestBindingStore } =
      await import("./src/app-server/thread-store.test-helpers.js");
    const bindingStore = createClaudeTestBindingStore();
    const identity = { sessionKey: "agent:main:direct:tester", sessionId: "sess-1" };
    await bindingStore.write(identity, { threadId: "thr_reset_me", cwd: "/tmp" });

    const harness = createClaudeAppServerAgentHarness({ bindingStore });
    await harness.reset?.({ ...identity, reason: "new" });
    expect(await bindingStore.read(identity)).toBeNull();
  });

  it("resolves the pool key from the LIVE plugin config, not a providerIds guess frozen at construction", async () => {
    // An operator config that sets appServer.modelProvider to something other
    // than providerIds[0] is unusual but legal — dispose() must still match
    // whatever run-attempt.ts would have used for a real turn, not silently
    // clear a slot nobody's turns actually used.
    let modelProvider = "zai";
    const harness = createClaudeAppServerAgentHarness({
      providerIds: ["zai"],
      resolvePluginConfig: () => ({ appServer: { modelProvider } }),
    });
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:zai");

    // Live config changes between calls (e.g. a reload) are picked up fresh
    // on the NEXT dispose() — the key isn't frozen at harness construction.
    modelProvider = "zai-staging";
    await harness.dispose?.();
    expect(clearSpy).toHaveBeenCalledWith("claude-bridge:zai-staging");
  });
});
