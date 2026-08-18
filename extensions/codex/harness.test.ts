// Codex tests cover harness plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";

const completeWithPreparedSimpleCompletionModel = vi.hoisted(() => vi.fn());
const runCodexIsolatedCompletion = vi.hoisted(() => vi.fn());
const runCodexAppServerAttempt = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  completeWithPreparedSimpleCompletionModel,
}));
vi.mock("./src/app-server/isolated-completion.js", () => ({
  runCodexIsolatedCompletion,
}));
vi.mock("./src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt,
}));

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
    expect(
      (harness as typeof harness & { cloudPlacement?: { mode: "remote-exec" } }).cloudPlacement,
    ).toEqual({ mode: "remote-exec" });
  });

  it("keeps computer-control denies out of the native-surface exemption", () => {
    expect(harness.conversationToolPolicySafeDenyTools).toContain("image_generate");
    expect(harness.conversationToolPolicySafeDenyTools).not.toEqual(
      expect.arrayContaining(["browser", "computer", "mobile_ui", "nodes", "screen"]),
    );
  });

  const harness = createCodexAppServerAgentHarness({
    bindingStore: testCodexAppServerBindingStore,
  });

  it("runs isolated completion through the prepared zero-tool transport", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce(assistant);
    const params = {
      model: { provider: "openai", id: "gpt-test", api: "openai-chatgpt-responses" },
      auth: { apiKey: "secret", source: "profile:test", mode: "oauth" },
      config: {},
      systemPrompt: "system",
      prompt: "user",
      timeoutMs: 1_000,
      provider: "openai",
      modelId: "gpt-test",
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    } as unknown as Parameters<NonNullable<typeof harness.runIsolatedCompletion>>[0];

    await expect(harness.runIsolatedCompletion?.(params)).resolves.toEqual({ assistant });
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: params.model,
        auth: params.auth,
        context: {
          systemPrompt: "system",
          messages: [expect.objectContaining({ role: "user", content: "user" })],
          tools: [],
        },
      }),
    );
  });

  it("delegates V2 isolated completion to the native bounded adapter", async () => {
    const legacyCallCount = completeWithPreparedSimpleCompletionModel.mock.calls.length;
    const result = {
      assistant: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
      },
    };
    runCodexIsolatedCompletion.mockResolvedValueOnce(result);
    const params = {
      authorization: {
        owner: "harness",
        plan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
        },
        authProfileStore: { version: 1, profiles: {} },
      },
      config: {},
      systemPrompt: "system",
      prompt: "user",
      timeoutMs: 1_000,
      provider: "openai",
      modelId: "gpt-test",
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    } as unknown as Parameters<NonNullable<typeof harness.runIsolatedCompletionV2>>[0];

    await expect(harness.runIsolatedCompletionV2?.(params)).resolves.toBe(result);
    expect(runCodexIsolatedCompletion).toHaveBeenCalledWith(params, { pluginConfig: undefined });
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(legacyCallCount);
  });

  it("keeps V2 host authorization on the prepared direct transport", async () => {
    const nativeCallCount = runCodexIsolatedCompletion.mock.calls.length;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    completeWithPreparedSimpleCompletionModel.mockResolvedValueOnce(assistant);
    const websocketHarness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
      pluginConfig: {
        appServer: { transport: "websocket", url: "ws://127.0.0.1:4501" },
      },
    });
    const hostModel = {
      provider: "openai",
      id: "gpt-test",
      api: "openai-responses",
    };
    const hostAuth = { apiKey: "secret", source: "profile:test", mode: "api-key" };
    const params = {
      authorization: {
        owner: "host",
        model: hostModel,
        auth: hostAuth,
      },
      config: {},
      systemPrompt: "system",
      prompt: "user",
      timeoutMs: 1_000,
      provider: "openai",
      modelId: "gpt-test",
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    } as unknown as Parameters<NonNullable<typeof harness.runIsolatedCompletionV2>>[0];

    await expect(websocketHarness.runIsolatedCompletionV2?.(params)).resolves.toEqual({
      assistant,
    });
    expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: hostModel,
        auth: hostAuth,
        context: expect.objectContaining({ tools: [] }),
      }),
    );
    expect(runCodexIsolatedCompletion).toHaveBeenCalledTimes(nativeCallCount);
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

  it("uses the attempt-scoped Codex config before the live Gateway config", async () => {
    runCodexAppServerAttempt.mockResolvedValueOnce({ stopReason: "stop" });
    const attemptHarness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
      pluginConfig: { appServer: { homeScope: "agent" } },
      resolvePluginConfig: () => ({ appServer: { homeScope: "agent" } }),
    });
    const params = {
      config: {
        plugins: {
          entries: {
            codex: { config: { appServer: { transport: "stdio", homeScope: "user" } } },
          },
        },
      },
    } as unknown as Parameters<NonNullable<typeof attemptHarness.runAttempt>>[0];

    await attemptHarness.runAttempt?.(params);

    expect(runCodexAppServerAttempt).toHaveBeenCalledWith(
      params,
      expect.objectContaining({
        pluginConfig: { appServer: { transport: "stdio", homeScope: "user" } },
      }),
    );
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
    expect(result).toEqual({
      supported: false,
      reason: "Codex cannot reproduce authored request transport overrides",
      fallbackRuntime: "openclaw",
    });
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
  it("is idempotent before the retained session has a binding", async () => {
    const bindingStore = createCodexTestBindingStore();
    const harness = createCodexAppServerAgentHarness({ bindingStore });
    if (!harness.reset) {
      throw new Error("expected Codex harness reset hook");
    }

    const resetParams = {
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
      reason: "reset" as const,
    };
    await expect(harness.reset(resetParams)).resolves.toBeUndefined();
    await expect(harness.reset(resetParams)).resolves.toBeUndefined();

    const identity = sessionBindingIdentity(resetParams);
    await expect(
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    await expect(bindingStore.read(identity)).resolves.toMatchObject({ threadId: "thread-1" });
  });

  it("clears an in-place session generation without stranding its replacement", async () => {
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
    await expect(
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-2", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    await expect(bindingStore.read(identity)).resolves.toMatchObject({ threadId: "thread-2" });
  });

  it("repairs a retirement fence left by an earlier in-place reset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-harness-reset-"));
    const storePath = path.join(root, "sessions.json");
    const bindingStore = createCodexTestBindingStore();
    const sessionKey = "agent:worker:main";
    const identity = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey,
    });
    try {
      await upsertSessionEntry({
        agentId: identity.agentId,
        sessionKey,
        storePath,
        entry: { sessionId: identity.sessionId, updatedAt: 1 },
      });
      await bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/repo" },
      });
      await bindingStore.retireSessionGeneration(identity);
      const harness = createCodexAppServerAgentHarness({
        bindingStore,
        resolveConfig: () => ({ session: { store: storePath } }),
      });

      await harness.reset?.({
        agentId: "worker",
        sessionId: "session-1",
        sessionKey,
        reason: "reset",
      });

      await expect(
        bindingStore.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-recovered", cwd: "/repo" },
        }),
      ).resolves.toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps deleted session generations retired", async () => {
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

    await harness.reset?.({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
      reason: "deleted",
    });

    await expect(
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-stale", cwd: "/repo" },
      }),
    ).resolves.toBe(false);
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
