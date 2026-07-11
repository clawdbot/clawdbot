// Codex tests cover harness plugin behavior.
import { describe, expect, it } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import {
  createCodexTestBindingStore,
  sessionBindingIdentity,
  testCodexAppServerBindingStore,
} from "./src/app-server/session-binding.test-helpers.js";

describe("Codex agent harness supports()", () => {
  const harness = createCodexAppServerAgentHarness({
    bindingStore: testCodexAppServerBindingStore,
  });

  it("supports the canonical codex virtual provider", () => {
    expect(harness.supports({ provider: "codex", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("delegates locked-session execution only to the voice-call plugin", () => {
    expect(harness.delegatedExecutionPluginIds).toEqual(["voice-call"]);
  });

  it("supports openai as the primary OpenClaw routing id", () => {
    expect(harness.supports({ provider: "openai", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("rejects providers Codex app-server cannot resolve from its own config", () => {
    const result = harness.supports({ provider: "9router", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
    expect(!result.supported ? (result.reason ?? "") : "").toContain("codex");
  });

  it("normalizes provider casing", () => {
    expect(harness.supports({ provider: "OpenAI", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("honors explicit provider id overrides", () => {
    const narrowHarness = createCodexAppServerAgentHarness({
      providerIds: ["codex"],
      bindingStore: testCodexAppServerBindingStore,
    });
    const result = narrowHarness.supports({ provider: "openai", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
  });

  it("rejects legacy multi-token provider ids by default", () => {
    for (const provider of ["openai-codex", "OpenAI-Codex", "openai_codex", "openai:codex"]) {
      const result = harness.supports({ provider, requestedRuntime: "codex" });
      expect(result.supported).toBe(false);
    }
  });

  it("supports legacy exact provider ids when explicitly configured", () => {
    const legacyHarness = createCodexAppServerAgentHarness({
      providerIds: ["codex", "openai", "openai-codex"],
      bindingStore: testCodexAppServerBindingStore,
    });

    expect(legacyHarness.supports({ provider: "openai-codex", requestedRuntime: "codex" })).toEqual(
      {
        supported: true,
        priority: 100,
      },
    );
  });

  it("does NOT hijack non-Codex providers that merely contain a recognized token (#918 codex P2)", () => {
    // Regression anchor for the codex finding (harness.ts:54): a single
    // recognized token among otherwise-unrecognized ones must NOT route an
    // OpenAI-compatible / proxy provider into the Codex app-server harness at
    // priority 100, which would break that provider's normal runtime.
    for (const provider of [
      "custom-openai-proxy",
      "azure-openai",
      "openai-proxy",
      "codex-clone-router",
    ]) {
      const result = harness.supports({ provider, requestedRuntime: "codex" });
      expect(result.supported).toBe(false);
    }
  });

  it("exposes the fail-closed exact runtime artifact validator", async () => {
    if (!harness.runtimeArtifact) {
      throw new Error("expected Codex runtime artifact capability");
    }
    await expect(
      harness.runtimeArtifact.validate({
        id: "codex-app-server:v1:malformed",
        fingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });
});

describe("Codex agent harness reset()", () => {
  it("retires the physical session generation", async () => {
    const bindingStore = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
    });
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    const harness = createCodexAppServerAgentHarness({ bindingStore });
    if (!harness.reset) {
      throw new Error("expected Codex harness reset hook");
    }

    await harness.reset({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
      reason: "reset",
    });

    await expect(bindingStore.read(identity)).resolves.toBeUndefined();
  });
});
