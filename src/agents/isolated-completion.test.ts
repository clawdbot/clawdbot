import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import type { AgentHarness } from "./harness/types.js";

const mocks = vi.hoisted(() => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => {}),
  getRegisteredAgentHarness: vi.fn(),
  isCliRuntimeAliasForProvider: vi.fn(() => false),
  prepareSimpleCompletionModel: vi.fn(),
  resolveCliRuntimeCanonicalProvider: vi.fn(() => undefined),
  resolveCliBackendConfig: vi.fn<
    () => { config: { command: string; modelAliases?: Record<string, string> } } | undefined
  >(() => ({ config: { command: "test-cli" } })),
  resolveCliRuntimeExecutionProvider: vi.fn<() => string | undefined>(() => undefined),
  resolveEmbeddedCliBackendDispatchEligibility: vi.fn(() => undefined),
  resolveEffectiveAgentRuntime: vi.fn(() => "codex"),
  runCliAgent: vi.fn(),
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "main",
}));
vi.mock("./cli-backends.js", () => ({
  resolveCliBackendConfig: mocks.resolveCliBackendConfig,
  resolveCliRuntimeCanonicalProvider: mocks.resolveCliRuntimeCanonicalProvider,
}));
vi.mock("./embedded-agent-runner/cli-backend-dispatch-eligibility.js", () => ({
  resolveEmbeddedCliBackendDispatchEligibility: mocks.resolveEmbeddedCliBackendDispatchEligibility,
}));
vi.mock("./harness/registry.js", () => ({
  getRegisteredAgentHarness: mocks.getRegisteredAgentHarness,
}));
vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: mocks.ensureSelectedAgentHarnessPlugin,
}));
vi.mock("./model-runtime-aliases.js", () => ({
  isCliRuntimeAliasForProvider: mocks.isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider: mocks.resolveCliRuntimeExecutionProvider,
}));
vi.mock("./simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModel: mocks.prepareSimpleCompletionModel,
}));
vi.mock("./thinking-runtime.js", () => ({
  resolveEffectiveAgentRuntime: mocks.resolveEffectiveAgentRuntime,
}));
vi.mock("./cli-runner.runtime.js", () => ({ runCliAgent: mocks.runCliAgent }));
vi.mock("../infra/private-temp-workspace.js", () => ({
  withTempWorkspace: async (_options: unknown, run: (value: { dir: string }) => unknown) =>
    await run({ dir: "/tmp/isolated" }),
}));
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => "/tmp",
}));

import { runIsolatedCompletion } from "./isolated-completion.js";

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant" as const,
    content,
    api: "openai-responses" as const,
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function request() {
  return {
    config: {},
    provider: "openai",
    model: "gpt-test",
    systemPrompt: "Return JSON.",
    prompt: "Do the task.",
    timeoutMs: 1_000,
    agentHarnessRuntimeOverride: "codex",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(false);
  mocks.resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
  mocks.resolveEmbeddedCliBackendDispatchEligibility.mockReturnValue(undefined);
  mocks.prepareSimpleCompletionModel.mockResolvedValue({
    model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
    auth: { apiKey: "secret", source: "profile:openai:test", mode: "oauth" },
    sourceAuthFingerprint: "fingerprint",
  });
});

describe("runIsolatedCompletion", () => {
  it("passes one prepared route to the selected harness and returns text", async () => {
    const runIsolatedCompletionHarness = vi.fn(async () => ({
      assistant: assistant([{ type: "text", text: '{"ok":true}' }]),
    }));
    mocks.getRegisteredAgentHarness.mockReturnValue({
      harness: {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        runIsolatedCompletion: runIsolatedCompletionHarness,
      } satisfies AgentHarness,
    });

    await expect(runIsolatedCompletion(request())).resolves.toEqual({
      text: '{"ok":true}',
      provider: "openai",
      model: "gpt-test",
      owner: { kind: "harness", id: "codex" },
      usage: expect.objectContaining({ input: 1, output: 1, totalTokens: 2 }),
    });
    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: undefined, bindAuthOwner: true }),
    );
    expect(runIsolatedCompletionHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-test",
        sourceAuthFingerprint: "fingerprint",
        systemPrompt: "Return JSON.",
        prompt: "Do the task.",
      }),
    );
  });

  it("unwraps prepared credentials only at the external harness boundary", async () => {
    const apiKey = mintSecretSentinel("github-source-token", { label: "isolated-auth" });
    const authorization = mintSecretSentinel("Bearer github-source-token", {
      label: "isolated-header",
    });
    mocks.prepareSimpleCompletionModel.mockResolvedValueOnce({
      model: {
        provider: "github-copilot",
        id: "gpt-test",
        api: "openai-responses",
        headers: { Authorization: authorization },
      },
      auth: {
        apiKey,
        source: "profile:github-copilot:test",
        mode: "token",
      },
      sourceAuthFingerprint: "fingerprint",
    });
    const runIsolatedCompletionHarness = vi.fn(async () => ({
      assistant: assistant([{ type: "text", text: "done" }]),
    }));
    mocks.getRegisteredAgentHarness.mockReturnValue({
      harness: {
        id: "copilot",
        label: "Copilot",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        runIsolatedCompletion: runIsolatedCompletionHarness,
      } satisfies AgentHarness,
    });

    await runIsolatedCompletion({
      ...request(),
      provider: "github-copilot",
      agentHarnessRuntimeOverride: "copilot",
    });

    expect(runIsolatedCompletionHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ apiKey: "github-source-token" }),
        model: expect.objectContaining({
          headers: { Authorization: "Bearer github-source-token" },
        }),
      }),
    );
  });

  it("returns the provider and model identity reported by the harness", async () => {
    mocks.getRegisteredAgentHarness.mockReturnValue({
      harness: {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        runIsolatedCompletion: vi.fn(async () => ({
          assistant: {
            ...assistant([{ type: "text", text: "done" }]),
            provider: "openai",
            model: "gpt-5.6-sol-actual",
          },
        })),
      } satisfies AgentHarness,
    });

    await expect(runIsolatedCompletion(request())).resolves.toEqual({
      text: "done",
      provider: "openai",
      model: "gpt-5.6-sol-actual",
      owner: { kind: "harness", id: "codex" },
      usage: expect.objectContaining({ input: 1, output: 1, totalTokens: 2 }),
    });
  });

  it("fails closed for a selected non-adopting harness", async () => {
    mocks.getRegisteredAgentHarness.mockReturnValue({
      harness: {
        id: "external",
        label: "External",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
      } satisfies AgentHarness,
    });

    await expect(
      runIsolatedCompletion({ ...request(), agentHarnessRuntimeOverride: "external" }),
    ).rejects.toThrow("does not support isolated completion");
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it("does not replace an explicit non-CLI harness with automatic CLI routing", async () => {
    mocks.resolveCliRuntimeExecutionProvider.mockReturnValue("claude-cli");
    mocks.getRegisteredAgentHarness.mockReturnValue({
      harness: {
        id: "external",
        label: "External",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
      } satisfies AgentHarness,
    });

    await expect(
      runIsolatedCompletion({ ...request(), agentHarnessRuntimeOverride: "external" }),
    ).rejects.toThrow("does not support isolated completion");
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
  });

  it("rejects tool-shaped harness output", async () => {
    mocks.getRegisteredAgentHarness.mockReturnValue({
      harness: {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        runIsolatedCompletion: vi.fn(async () => ({
          assistant: assistant([
            { type: "toolCall", id: "call-1", name: "update_plan", arguments: {} },
          ]),
        })),
      } satisfies AgentHarness,
    });

    await expect(runIsolatedCompletion(request())).rejects.toMatchObject({
      code: "output-rejected",
      message: expect.stringContaining("returned a tool call"),
    });
  });

  it("routes CLI owners through one exact empty-tool run without direct preparation", async () => {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.runCliAgent.mockResolvedValue({
      payloads: [{ text: '{"cli":true}' }],
      meta: { durationMs: 1 },
    });

    await expect(
      runIsolatedCompletion({
        ...request(),
        provider: "anthropic",
        model: "claude-test",
        agentHarnessRuntimeOverride: "claude-cli",
      }),
    ).resolves.toEqual({
      text: '{"cli":true}',
      provider: "anthropic",
      model: "claude-test",
      owner: { kind: "cli", id: "claude-cli" },
    });
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
    expect(mocks.runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        modelProvider: "anthropic",
        authProfileId: undefined,
        executionMode: "side-question",
        isolatedCompletion: true,
        disableTools: true,
        cliToolAvailability: { native: [], openClaw: [] },
      }),
    );
  });

  it("forwards one explicit auth profile unchanged to a CLI owner", async () => {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "done" }] });

    await runIsolatedCompletion({
      ...request(),
      provider: "google",
      model: "gemini-test",
      authProfileId: "google:locked",
      agentHarnessRuntimeOverride: "google-gemini-cli",
    });

    expect(mocks.runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "google:locked" }),
    );
  });

  it("reports the normalized model sent to a CLI owner", async () => {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.resolveCliBackendConfig.mockReturnValue({
      config: { command: "gemini", modelAliases: { flash: "gemini-3.1-flash-preview" } },
    });
    mocks.runCliAgent.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1 },
    });

    await expect(
      runIsolatedCompletion({
        ...request(),
        provider: "google",
        model: "flash",
        agentHarnessRuntimeOverride: "google-gemini-cli",
      }),
    ).resolves.toEqual({
      text: "done",
      provider: "google",
      model: "gemini-3.1-flash-preview",
      owner: { kind: "cli", id: "google-gemini-cli" },
    });
  });
});
