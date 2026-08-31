import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  type AgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type { AssistantMessage } from "../llm/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import type { AgentHarness } from "./harness/types.js";
import { createEmptyPluginMetadataSnapshot } from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

type IsolatedCliRunParams = {
  preparedRunAdmission: PreparedAgentRunAdmission;
  prompt: string;
  runId: string;
  sessionId: string;
};

const mocks = vi.hoisted(() => ({
  acquireAgentRunPreparedModelRuntime: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => {}),
  getRegisteredAgentHarness: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  isCliRuntimeAliasForProvider: vi.fn(() => false),
  prepareSimpleCompletionModel: vi.fn(),
  prepareAgentRuntimeAuth: vi.fn(),
  resolveModelWithRegistry: vi.fn(),
  resolveCliRuntimeCanonicalProvider: vi.fn(() => undefined),
  resolveCliBackendConfig: vi.fn<
    () => { config: { command: string; modelAliases?: Record<string, string> } } | undefined
  >(() => ({ config: { command: "test-cli" } })),
  resolveCliRuntimeExecutionProvider: vi.fn<() => string | undefined>(() => undefined),
  resolveEmbeddedCliBackendDispatchEligibility: vi.fn(() => undefined),
  resolveEffectiveAgentRuntime: vi.fn(() => "codex"),
  runCliAgent: vi.fn<(params: IsolatedCliRunParams) => Promise<unknown>>(),
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
vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelWithRegistry: mocks.resolveModelWithRegistry,
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
vi.mock("./model-auth.js", () => ({ ensureAuthProfileStore: mocks.ensureAuthProfileStore }));
vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireAgentRunPreparedModelRuntime,
}));
vi.mock("./simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModel: mocks.prepareSimpleCompletionModel,
}));
vi.mock("./runtime-plan/prepare-auth.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-plan/prepare-auth.js")>(
    "./runtime-plan/prepare-auth.js",
  );
  return { ...actual, prepareAgentRuntimeAuth: mocks.prepareAgentRuntimeAuth };
});
vi.mock("./runtime-plan/resolve-auth.js", () => ({
  scopeAuthProfileStoreToPreparedPlan: (
    store: { version: number; profiles: Record<string, unknown> },
    plan: { forwardedAuthProfileCandidateIds?: string[] },
  ) => ({
    ...store,
    profiles: Object.fromEntries(
      (plan.forwardedAuthProfileCandidateIds ?? []).flatMap((profileId) => {
        const profile = store.profiles[profileId];
        return profile ? [[profileId, profile]] : [];
      }),
    ),
  }),
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

let preparedModelRuntime: object;
let releaseRuntimeLease: ReturnType<typeof vi.fn>;

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

const nativeAuthPlan = {
  providerForAuth: "openai",
  modelId: "gpt-test",
  harnessAuthProvider: "openai",
  modelRoute: { authRequirement: "subscription" as const },
};

beforeEach(() => {
  vi.clearAllMocks();
  preparedModelRuntime = {
    config: {},
    metadataSnapshot: createEmptyPluginMetadataSnapshot("/tmp/workspace"),
    pluginRegistry: createEmptyPluginRegistry(),
    workspaceDir: "/tmp/workspace",
    createStores: () => ({ modelRegistry: {} }),
  };
  releaseRuntimeLease = vi.fn();
  mocks.acquireAgentRunPreparedModelRuntime.mockResolvedValue({
    snapshot: preparedModelRuntime,
    release: releaseRuntimeLease,
  });
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(false);
  mocks.resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
  mocks.resolveEmbeddedCliBackendDispatchEligibility.mockReturnValue(undefined);
  mocks.prepareSimpleCompletionModel.mockResolvedValue({
    model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
    auth: { apiKey: "secret", source: "profile:openai:test", mode: "oauth" },
    sourceAuthFingerprint: "fingerprint",
  });
  mocks.resolveModelWithRegistry.mockReturnValue({
    provider: "openai",
    id: "gpt-test",
    api: "openai-chatgpt-responses",
  });
  mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  const plan = nativeAuthPlan;
  mocks.prepareAgentRuntimeAuth.mockReturnValue({
    plan,
    attempts: [{ kind: "implicit", plan }],
  });
});

function registerHarness(overrides: Partial<AgentHarness>): void {
  mocks.getRegisteredAgentHarness.mockReturnValue({
    harness: {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
      ...overrides,
    } satisfies AgentHarness,
  });
}

describe("runIsolatedCompletion", () => {
  it("hands harness-owned authorization to the V2 owner without resolving a host key", async () => {
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: assistant([{ type: "text", text: "native result" }]),
    }));
    registerHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await expect(runIsolatedCompletion(request())).resolves.toMatchObject({
      text: "native result",
      owner: { kind: "harness", id: "codex" },
    });
    expect(mocks.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(expect.any(Object), {
      catalogMode: "static",
    });
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({ owner: "harness" }),
      }),
    );
  });

  it("clamps V2 output tokens to the resolved physical model limit", async () => {
    mocks.resolveModelWithRegistry.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-test",
      api: "openai-chatgpt-responses",
      maxTokens: 1_024,
    });
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: assistant([{ type: "text", text: "native result" }]),
    }));
    registerHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await runIsolatedCompletion({
      ...request(),
      outputTextPolicy: "strict-visible",
      streamParams: { maxTokens: 4_096, temperature: 0.2 },
    });

    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        outputTextPolicy: "strict-visible",
        streamParams: { maxTokens: 1_024, temperature: 0.2 },
      }),
    );
  });

  it("keeps automatic harness fallback core-owned and scopes one profile per call", async () => {
    const firstPlan = {
      ...nativeAuthPlan,
      forwardedAuthProfileId: "openai:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["openai:first", "openai:backup"],
    };
    const backupPlan = {
      ...firstPlan,
      forwardedAuthProfileId: "openai:backup",
      forwardedAuthProfileCandidateIds: ["openai:backup"],
    };
    mocks.ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:first": { type: "token", provider: "openai", token: "first" },
        "openai:backup": { type: "token", provider: "openai", token: "backup" },
      },
    });
    mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
      plan: firstPlan,
      attempts: [
        { kind: "profile", plan: firstPlan, profileId: "openai:first" },
        { kind: "profile", plan: backupPlan, profileId: "openai:backup" },
      ],
    });
    const runIsolatedCompletionV2 = vi
      .fn()
      .mockRejectedValueOnce(new Error("first profile unavailable"))
      .mockResolvedValueOnce({
        assistant: assistant([{ type: "text", text: "backup result" }]),
      });
    registerHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await expect(runIsolatedCompletion(request())).resolves.toMatchObject({
      text: "backup result",
    });
    expect(runIsolatedCompletionV2).toHaveBeenCalledTimes(2);
    expect(
      runIsolatedCompletionV2.mock.calls.map(([params]) => ({
        profileId:
          params.authorization.owner === "harness"
            ? params.authorization.plan.forwardedAuthProfileId
            : undefined,
        candidateIds:
          params.authorization.owner === "harness"
            ? params.authorization.plan.forwardedAuthProfileCandidateIds
            : undefined,
        profiles:
          params.authorization.owner === "harness"
            ? Object.keys(params.authorization.authProfileStore.profiles)
            : [],
      })),
    ).toEqual([
      {
        profileId: "openai:first",
        candidateIds: ["openai:first"],
        profiles: ["openai:first"],
      },
      {
        profileId: "openai:backup",
        candidateIds: ["openai:backup"],
        profiles: ["openai:backup"],
      },
    ]);
    expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires actual profile dispatch before direct auth (cooled: %s)",
    async (cooled) => {
      const profilePlan = {
        providerForAuth: "openai",
        modelId: "gpt-test",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:first",
        forwardedAuthProfileSource: "auto" as const,
        forwardedAuthProfileCandidateIds: ["openai:first"],
      };
      const directPlan = {
        providerForAuth: "openai",
        modelId: "gpt-test",
        harnessAuthProvider: "openai",
        modelRoute: { authRequirement: "api-key" as const },
      };
      mocks.ensureAuthProfileStore.mockReturnValueOnce({
        version: 1,
        profiles: {
          "openai:first": { type: "token", provider: "openai", token: "first" },
        },
        usageStats: cooled ? { "openai:first": { cooldownUntil: Date.now() + 60_000 } } : {},
      });
      mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
        plan: profilePlan,
        attempts: [
          { kind: "profile", plan: profilePlan, profileId: "openai:first" },
          {
            kind: "direct",
            plan: directPlan,
            allowAuthProfileFallback: false,
            requiresPriorProfileAttempt: true,
          },
        ],
      });
      const runIsolatedCompletionV2 = vi
        .fn()
        .mockRejectedValueOnce(new Error("profile unavailable"))
        .mockResolvedValueOnce({ assistant: assistant([{ type: "text", text: "direct result" }]) });
      registerHarness({
        authBootstrap: "harness",
        runIsolatedCompletionV2,
      });

      if (cooled) {
        await expect(runIsolatedCompletion(request())).rejects.toThrow("temporarily unavailable");
        expect(runIsolatedCompletionV2).not.toHaveBeenCalled();
        expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      } else {
        await expect(runIsolatedCompletion(request())).resolves.toMatchObject({
          text: "direct result",
        });
        expect(runIsolatedCompletionV2).toHaveBeenCalledTimes(2);
        expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
      }
    },
  );

  it("skips a cooled profile without hiding a prepared healthy backup", async () => {
    const firstPlan = {
      ...nativeAuthPlan,
      forwardedAuthProfileId: "openai:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["openai:first", "openai:backup"],
    };
    const backupPlan = {
      ...firstPlan,
      forwardedAuthProfileId: "openai:backup",
      forwardedAuthProfileCandidateIds: ["openai:backup"],
    };
    mocks.ensureAuthProfileStore.mockReturnValueOnce({
      version: 1,
      profiles: {
        "openai:first": { type: "token", provider: "openai", token: "first" },
        "openai:backup": { type: "token", provider: "openai", token: "backup" },
      },
      usageStats: {
        "openai:first": { cooldownUntil: Date.now() + 60_000 },
      },
    });
    mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
      plan: firstPlan,
      attempts: [
        { kind: "profile", plan: firstPlan, profileId: "openai:first" },
        { kind: "profile", plan: backupPlan, profileId: "openai:backup" },
      ],
    });
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: assistant([{ type: "text", text: "backup result" }]),
    }));
    registerHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await expect(runIsolatedCompletion(request())).resolves.toMatchObject({
      text: "backup result",
    });
    expect(runIsolatedCompletionV2).toHaveBeenCalledOnce();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          owner: "harness",
          plan: expect.objectContaining({ forwardedAuthProfileId: "openai:backup" }),
        }),
      }),
    );
  });

  it("uses host authorization for V2 API-key routes", async () => {
    const plan = {
      ...nativeAuthPlan,
      modelRoute: { authRequirement: "api-key" as const },
    };
    mocks.prepareAgentRuntimeAuth.mockReturnValueOnce({
      plan,
      attempts: [{ kind: "implicit", plan }],
    });
    const runIsolatedCompletionV2 = vi.fn(async () => ({
      assistant: assistant([{ type: "text", text: "key result" }]),
    }));
    registerHarness({
      authBootstrap: "harness",
      runIsolatedCompletionV2,
    });

    await runIsolatedCompletion(request());

    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledOnce();
    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({ preparedModelRuntime, workspaceDir: "/tmp/workspace" }),
    );
    expect(mocks.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledOnce();
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    expect(runIsolatedCompletionV2).toHaveBeenCalledWith(
      expect.objectContaining({ authorization: expect.objectContaining({ owner: "host" }) }),
    );
  });

  it("passes one prepared route to the selected harness and returns text", async () => {
    const runIsolatedCompletionHarness = vi.fn(async () => ({
      assistant: assistant([{ type: "text", text: '{"ok":true}' }]),
    }));
    registerHarness({
      runIsolatedCompletion: runIsolatedCompletionHarness,
    });

    await expect(runIsolatedCompletion(request())).resolves.toEqual({
      text: '{"ok":true}',
      provider: "openai",
      model: "gpt-test",
      owner: { kind: "harness", id: "codex" },
      usage: expect.objectContaining({ input: 1, output: 1, totalTokens: 2 }),
    });
    expect(mocks.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: undefined,
        bindAuthOwner: true,
        preparedModelRuntime,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.acquireAgentRunPreparedModelRuntime).toHaveBeenCalledOnce();
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
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
    registerHarness({
      id: "copilot",
      label: "Copilot",
      runIsolatedCompletion: runIsolatedCompletionHarness,
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
    registerHarness({
      runIsolatedCompletion: vi.fn(async () => ({
        assistant: {
          ...assistant([{ type: "text", text: "done" }]),
          provider: "openai",
          model: "gpt-5.6-sol-actual",
        },
      })),
    });

    await expect(runIsolatedCompletion(request())).resolves.toEqual({
      text: "done",
      provider: "openai",
      model: "gpt-5.6-sol-actual",
      owner: { kind: "harness", id: "codex" },
      usage: expect.objectContaining({ input: 1, output: 1, totalTokens: 2 }),
    });
  });

  it.each([undefined, "claude-cli"])(
    "rejects a non-adopting explicit harness despite CLI candidate %s",
    async (cliCandidate) => {
      mocks.resolveCliRuntimeExecutionProvider.mockReturnValue(cliCandidate);
      registerHarness({ id: "external", label: "External" });
      await expect(
        runIsolatedCompletion({ ...request(), agentHarnessRuntimeOverride: "external" }),
      ).rejects.toThrow("does not support isolated completion");
      expect(mocks.prepareSimpleCompletionModel).not.toHaveBeenCalled();
      expect(mocks.runCliAgent).not.toHaveBeenCalled();
    },
  );

  it("rejects tool-shaped harness output", async () => {
    registerHarness({
      runIsolatedCompletion: vi.fn(async () => ({
        assistant: assistant([
          { type: "toolCall", id: "call-1", name: "update_plan", arguments: {} },
        ]),
      })),
    });

    await expect(runIsolatedCompletion(request())).rejects.toMatchObject({
      code: "output-rejected",
      message: expect.stringContaining("returned a tool call"),
    });
  });

  it.each(["error", "aborted"] as const)(
    "rejects %s harness output before usage reaches the runtime finalizer",
    async (stopReason) => {
      registerHarness({
        runIsolatedCompletion: vi.fn(async () => ({
          assistant: assistant([{ type: "text", text: "partial" }], stopReason),
        })),
      });

      await expect(runIsolatedCompletion(request())).rejects.toMatchObject({
        code: "output-rejected",
        message: expect.stringContaining(`stop reason ${stopReason}`),
      });
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "allows thinking-only output only for strict title requests (CLI: %s, strict: %s)",
    async (cli, strict) => {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(cli);
      mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "hidden", isReasoning: true }] });
      registerHarness({
        runIsolatedCompletion: vi.fn(async () => ({
          assistant: assistant([{ type: "thinking", thinking: "hidden" }]),
        })),
      });

      const result = runIsolatedCompletion({
        ...request(),
        ...(strict ? { outputTextPolicy: "strict-visible" as const } : {}),
      });
      if (strict) {
        await expect(result).resolves.toMatchObject({ text: "" });
      } else {
        await expect(result).rejects.toMatchObject({
          code: "output-rejected",
          message: expect.stringContaining("empty output"),
        });
      }
      if (cli) {
        expect(mocks.runCliAgent).toHaveBeenCalledWith(
          expect.objectContaining({ outputTextPolicy: strict ? "strict-visible" : undefined }),
        );
      }
    },
  );

  it.each([undefined, { input: 8, output: 3, cacheRead: 2, total: 13 }])(
    "routes CLI owners through one empty-tool run with reported usage %j",
    async (usage) => {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
      mocks.runCliAgent.mockResolvedValue({
        payloads: [{ text: '{"cli":true}' }],
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "cli-session",
            provider: "claude-cli",
            model: "claude-test",
            usage,
          },
        },
      });

      await expect(
        runIsolatedCompletion({
          ...request(),
          provider: "anthropic",
          model: "claude-test",
          agentHarnessRuntimeOverride: "claude-cli",
        }),
      ).resolves.toStrictEqual({
        text: '{"cli":true}',
        provider: "anthropic",
        model: "claude-test",
        owner: { kind: "cli", id: "claude-cli" },
        ...(usage ? { usage } : {}),
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
    },
  );

  it("keeps concurrent CLI isolated completions independently admitted", async () => {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const firstStarted = createDeferred();
    const bothStarted = createDeferred();
    const calls: Array<{
      admitted: AdmittedRunContext;
      authority: AgentRunDelegatedAuthority;
      params: IsolatedCliRunParams;
      release: ReturnType<typeof createDeferred<void>>;
    }> = [];
    mocks.runCliAgent.mockImplementation(async (params) => {
      const admitted = await params.preparedRunAdmission.admit("embedded");
      const authority = getAdmittedRunDelegatedAuthority(admitted);
      if (!authority) {
        throw new Error("expected active isolated completion authority");
      }
      const release = createDeferred();
      calls.push({ admitted, authority, params, release });
      if (calls.length === 1) {
        firstStarted.resolve();
      }
      if (calls.length === 2) {
        bothStarted.resolve();
      }
      await release.promise;
      return { payloads: [{ text: `done: ${params.prompt}` }] };
    });

    const first = runIsolatedCompletion({ ...request(), prompt: "first" });
    let second: ReturnType<typeof runIsolatedCompletion> | undefined;
    try {
      await Promise.race([
        firstStarted.promise,
        first.then(() => {
          throw new Error("first isolated completion settled before reaching the barrier");
        }),
      ]);
      second = runIsolatedCompletion({ ...request(), prompt: "second" });
      await Promise.race([
        bothStarted.promise,
        Promise.all([first, second]).then(() => {
          throw new Error("isolated completions settled before reaching the barrier");
        }),
      ]);
      const firstCall = calls.find(({ params }) => params.prompt === "first");
      const secondCall = calls.find(({ params }) => params.prompt === "second");
      if (!firstCall || !secondCall) {
        throw new Error("expected both isolated completions to start");
      }
      expect(firstCall.params.runId).toBe(firstCall.params.sessionId);
      expect(secondCall.params.runId).toBe(secondCall.params.sessionId);
      expect(firstCall.params.runId).not.toBe(secondCall.params.runId);
      expect(firstCall.admitted.operationalRunInstance.runId).toBe(firstCall.params.runId);
      expect(secondCall.admitted.operationalRunInstance.runId).toBe(secondCall.params.runId);
      expect(validateAgentRunDelegatedAuthority(firstCall.authority)).toBe(true);
      expect(validateAgentRunDelegatedAuthority(secondCall.authority)).toBe(true);

      firstCall.release.resolve();
      await expect(first).resolves.toMatchObject({ text: "done: first" });
      expect(validateAgentRunDelegatedAuthority(firstCall.authority)).toBe(false);
      expect(validateAgentRunDelegatedAuthority(secondCall.authority)).toBe(true);

      secondCall.release.resolve();
      await expect(second).resolves.toMatchObject({ text: "done: second" });
      expect(validateAgentRunDelegatedAuthority(secondCall.authority)).toBe(false);
    } finally {
      for (const call of calls) {
        call.release.resolve();
      }
      await Promise.allSettled(second ? [first, second] : [first]);
      clock.mockRestore();
    }
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
