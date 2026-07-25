// Codex tests cover harness plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import {
  createCodexTestBindingStore,
  sessionBindingIdentity,
  testCodexAppServerBindingStore,
} from "./src/app-server/session-binding.test-helpers.js";

describe("Codex agent harness supports()", () => {
  it("owns auth bootstrap for every native attempt", () => {
    expect(harness.authBootstrap).toBe("harness");
  });

  it("publishes provider ids for lightweight auto selection", () => {
    expect(harness.autoSelection?.providerIds).toEqual(["codex", "openai"]);
  });

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

  it("supports the canonical openai routing id (documented Codex path)", () => {
    expect(harness.supports({ provider: "openai", requestedRuntime: "codex" })).toEqual({
      supported: true,
      priority: 100,
    });
  });

  it("supports an official route declared compatible with Codex", () => {
    expect(
      harness.supports({
        provider: "openai",
        requestedRuntime: "codex",
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("rejects unresolved harness auth without declared route compatibility", () => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider: {
        requestTransportOverrides: "none",
        preparedAuth: { source: "harness" },
      },
    });
    expect(result.supported).toBe(false);
    expect(!result.supported ? result.reason : undefined).toContain("not declared");
  });

  it.each([
    {
      label: "forwarded OAuth subscription",
      preparedAuth: { source: "profile", mode: "oauth", requirement: "subscription" } as const,
      supported: true,
    },
    {
      label: "direct subscription credential",
      preparedAuth: { source: "direct", mode: "oauth", requirement: "subscription" } as const,
      supported: false,
    },
    {
      label: "missing subscription credential",
      preparedAuth: { source: "none", requirement: "subscription" } as const,
      supported: false,
    },
    {
      label: "resolved direct Platform key",
      preparedAuth: { source: "direct", mode: "api-key", requirement: "api-key" } as const,
      supported: true,
    },
    {
      label: "forwarded Platform key profile",
      preparedAuth: { source: "profile", mode: "api_key", requirement: "api-key" } as const,
      supported: true,
    },
    {
      label: "unresolved harness-native auth",
      preparedAuth: { source: "harness" } as const,
      supported: true,
    },
    {
      label: "unvalidated harness-native subscription",
      preparedAuth: { source: "harness", requirement: "subscription" } as const,
      supported: false,
    },
  ])("reports $label reproducibility", ({ preparedAuth, supported }) => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider: {
        api:
          preparedAuth.requirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
        baseUrl:
          preparedAuth.requirement === "api-key"
            ? "https://api.openai.com/v1"
            : "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        preparedAuth,
      },
    });

    expect(result.supported).toBe(supported);
    if (!supported) {
      expect(!result.supported ? result.reason : undefined).toContain("prepared");
    }
  });

  it.each([
    {
      name: "custom endpoint",
      modelProvider: {
        api: "openai-responses",
        baseUrl: "https://relay.example.test/v1",
        requestTransportOverrides: "none" as const,
        runtimePolicy: { compatibleIds: ["openclaw"] },
      },
    },
    {
      name: "Completions adapter",
      modelProvider: {
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "none" as const,
        runtimePolicy: { compatibleIds: ["openclaw"] },
      },
    },
    {
      name: "HTTP endpoint",
      modelProvider: {
        api: "openai-responses",
        baseUrl: "http://api.openai.com/v1",
        requestTransportOverrides: "none" as const,
        runtimePolicy: { compatibleIds: ["openclaw"] },
      },
    },
  ])("rejects a $name that Codex cannot reproduce", ({ modelProvider }) => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider,
    });
    expect(result.supported).toBe(false);
    expect(!result.supported ? result.reason : undefined).toContain("prepared provider route");
  });

  it("rejects authored request overrides defensively", () => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "present",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        preparedAuth: { source: "harness" },
      },
    });
    expect(result.supported).toBe(false);
    expect(!result.supported ? result.reason : undefined).toContain("request transport overrides");
  });

  it("rejects an OpenAI route without a provider compatibility declaration", () => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider: {
        api: "openai-responses",
        baseUrl: "https://relay.example.test/v1",
        requestTransportOverrides: "none",
      },
    });
    expect(result.supported).toBe(false);
    expect(!result.supported ? result.reason : undefined).toContain("not declared");
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
    expect(narrowHarness.autoSelection?.providerIds).toEqual(["codex"]);
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

describe("Codex agent harness dispose()", () => {
  it("uses the preloaded shared-client lifecycle seam", async () => {
    const sharedDisposer = Symbol.for("openclaw.codexAppServerClientDisposer");
    const state = globalThis as typeof globalThis & {
      [sharedDisposer]?: () => Promise<void>;
    };
    const previous = state[sharedDisposer];
    const dispose = vi.fn(async () => {});
    state[sharedDisposer] = dispose;
    const harness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
    });
    try {
      await harness.dispose?.();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      if (previous) {
        state[sharedDisposer] = previous;
      } else {
        delete state[sharedDisposer];
      }
    }
  });
});
