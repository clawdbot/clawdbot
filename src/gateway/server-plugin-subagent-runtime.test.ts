import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { runIsolatedCompletion } from "../agents/isolated-completion.js";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginIdScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  createBackgroundWorkOwner,
  getBackgroundWorkSnapshot,
} from "../process/background-work.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import * as inProcessDispatch from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import {
  createGatewaySubagentRuntime,
  resolvePluginSubagentOverridePolicies,
} from "./server-plugin-subagent-runtime.js";

const isolated = vi.hoisted(() => vi.fn<typeof runIsolatedCompletion>());
vi.mock("../agents/isolated-completion.js", () => ({ runIsolatedCompletion: isolated }));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

const PLUGIN_ID = "test-completion";
type CompleteParams = Parameters<PluginRuntime["subagent"]["complete"]>[0];
let config: OpenClawConfig;
let context: GatewayRequestContext | undefined;
let lifetime: AbortController;

function createRuntime() {
  return createGatewaySubagentRuntime(
    () => context,
    resolvePluginSubagentOverridePolicies(config),
    lifetime.signal,
  );
}

function complete(runtime: PluginRuntime["subagent"], params: Partial<CompleteParams> = {}) {
  return withPluginRuntimePluginIdScope(PLUGIN_ID, () =>
    runtime.complete({ agentId: "research", message: "Review these notes", ...params }),
  );
}

function completeScoped(
  client: GatewayRequestOptions["client"],
  params: Partial<CompleteParams> = {},
) {
  const runtime = createRuntime();
  return withPluginRuntimeGatewayRequestScope(
    { pluginId: PLUGIN_ID, client, isWebchatConnect: () => false },
    () => runtime.complete({ agentId: "research", message: "Review these notes", ...params }),
  );
}

const operatorProfile = {
  profileId: "completion-operator",
  displayName: "Completion operator",
  hasAvatar: false,
  updatedAt: 1,
};

function restrictOperatorAgents() {
  config.gateway = {
    roles: {
      default: "limited",
      definitions: {
        limited: { agents: ["main"], scopes: ["operator.write"], sessions: { others: "none" } },
      },
    },
  };
}

function blockBackgroundSlots(count: number) {
  const owner = createBackgroundWorkOwner({ owner: "core:completion-test", maxConcurrent: 3 });
  const gate = createDeferred();
  const work = Array.from({ length: count }, () => owner.enqueue(async () => await gate.promise));
  return { release: () => gate.resolve(), settled: () => Promise.all(work) };
}

beforeEach(() => {
  resetCommandQueueStateForTest();
  isolated.mockReset().mockImplementation(async (params) => ({
    text: `${params.agentId}:${params.provider}/${params.model}`,
    provider: params.provider,
    model: params.model,
    owner: { kind: "harness", id: "test-runtime" },
  }));
  config = {
    agents: {
      defaults: { model: "test-provider/global-model" },
      entries: {
        main: { model: "test-provider/main-model" },
        research: { model: "test-provider/research-model@research-profile" },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  lifetime = new AbortController();
});

afterEach(() => {
  lifetime.abort();
  resetCommandQueueStateForTest();
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

describe("plugin background completions", () => {
  it("uses the selected agent's model and credential owner without creating a session", async () => {
    const dispatch = vi.spyOn(inProcessDispatch, "dispatchGatewayMethodInProcess");
    await expect(
      complete(createRuntime(), { extraSystemPrompt: "Summarize only" }),
    ).resolves.toEqual({
      text: "research:test-provider/research-model",
    });
    expect(isolated).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "research",
        provider: "test-provider",
        model: "research-model",
        authProfileId: "research-profile",
        systemPrompt: "Summarize only",
        prompt: "Review these notes",
        timeoutMs: 30_000,
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records one trusted usage event attributed to the host plugin and selected agent without a session", async () => {
    resetDiagnosticEventsForTest();
    const events: Array<{
      event: Extract<DiagnosticEventPayload, { type: "model.usage" }>;
      hostPluginId?: string;
      trusted: boolean;
      internal?: boolean;
    }> = [];
    const stop = onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event, metadata, privateData) => {
        if (event.type === "model.usage") {
          events.push({
            event,
            hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
            trusted: metadata.trusted,
            internal: metadata.internal,
          });
        }
      }),
    );
    isolated.mockResolvedValueOnce({
      text: "summary",
      provider: "test-provider",
      model: "research-model",
      owner: { kind: "harness", id: "test-runtime" },
      usage: {
        input: 11,
        output: 7,
        cacheRead: 5,
        cacheWrite: 2,
        total: 25,
        cost: { total: 0.0042 },
      },
    });
    const request = {
      message: "Summarize",
      pluginId: "spoofed-plugin",
      sessionKey: "spoofed-session",
    };
    try {
      await expect(complete(createRuntime(), request)).resolves.toEqual({ text: "summary" });
    } finally {
      stop();
      resetDiagnosticEventsForTest();
    }
    expect(events).toEqual([
      {
        trusted: true,
        internal: true,
        hostPluginId: PLUGIN_ID,
        event: expect.objectContaining({
          type: "model.usage",
          agentId: "research",
          provider: "test-provider",
          model: "research-model",
          usage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, promptTokens: 18, total: 25 },
          costUsd: 0.0042,
        }),
      },
    ]);
    expect(events[0]?.event).not.toHaveProperty("sessionKey");
    expect(events[0]?.event).not.toHaveProperty("sessionId");
  });

  it.each([
    {
      name: "untrusted plugin",
      subagent: undefined,
      model: "test-provider/override",
      allowed: false,
    },
    {
      name: "allowlisted model",
      subagent: { allowModelOverride: true, allowedModels: ["test-provider/override"] },
      model: "test-provider/override",
      allowed: true,
      expectedText: "research:test-provider/override",
    },
    {
      name: "provider-qualified model id",
      subagent: { allowModelOverride: true, allowedModels: ["openrouter/test-model"] },
      model: "openrouter/test-model",
      allowed: true,
      expectedText: "research:openrouter/openrouter/test-model",
    },
    {
      name: "model outside allowlist",
      subagent: { allowModelOverride: true, allowedModels: ["test-provider/other"] },
      model: "test-provider/override",
      allowed: false,
    },
    {
      name: "auth profile outside allowlist",
      subagent: { allowModelOverride: true, allowedModels: ["test-provider/override"] },
      model: "test-provider/override@other-profile",
      allowed: false,
    },
    {
      name: "invalid allowlist",
      subagent: { allowModelOverride: true, allowedModels: ["not-a-model-ref"] },
      model: "test-provider/override",
      allowed: false,
    },
  ])(
    "applies existing subagent override policy for $name",
    async ({ subagent, model, allowed, expectedText }) => {
      config.plugins = { entries: { [PLUGIN_ID]: { subagent } } };
      const result = complete(createRuntime(), { model });
      if (allowed) {
        await expect(result).resolves.toEqual({ text: expectedText });
        expect(isolated).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toThrow(/not trusted|not allowlisted|none of the entries/u);
        expect(isolated).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["operator.write", "operator.admin"])(
    "retains request-scoped %s model override authority",
    async (scope) => {
      const result = completeScoped(createSyntheticPluginRuntimeClient({ scopes: [scope] }), {
        model: "test-provider/override",
      });
      if (scope === "operator.admin") {
        await expect(result).resolves.toEqual({ text: "research:test-provider/override" });
      } else {
        await expect(result).rejects.toThrow("override is not authorized");
        expect(isolated).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["operator.read", "operator.write"])(
    "enforces %s scope even when using the agent's default model",
    async (scope) => {
      const result = completeScoped(createSyntheticPluginRuntimeClient({ scopes: [scope] }));
      if (scope === "operator.read") {
        await expect(result).rejects.toThrow("missing scope: operator.write");
        expect(isolated).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toEqual({ text: "research:test-provider/research-model" });
      }
    },
  );

  it("keeps operator agent ceilings while admitting genuine background work", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      restrictOperatorAgents();
      const profile = ensureProfileForEmail("completion-ceiling@example.com");
      const client = createSyntheticPluginRuntimeClient({
        scopes: ["operator.write"],
        authenticatedUserProfile: { ...operatorProfile, profileId: profile.id },
      });
      await expect(completeScoped(client)).rejects.toThrow(
        'Your operator role cannot create sessions for agent "research"',
      );
      expect(isolated).not.toHaveBeenCalled();
      await expect(completeScoped(client, { agentId: "main" })).resolves.toEqual({
        text: "main:test-provider/main-model",
      });
      await expect(complete(createRuntime())).resolves.toEqual({
        text: "research:test-provider/research-model",
      });
    });
  });

  it("snapshots the authorized agent and credentials before queued request mutation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      restrictOperatorAgents();
      const profile = ensureProfileForEmail("completion-mutation@example.com");
      config.agents!.entries!.main!.model = "test-provider/main-model@main-profile";
      const blockers = blockBackgroundSlots(3);
      const runtime = createRuntime();
      const request = { agentId: "main", message: "Review these notes" };
      const result = withPluginRuntimeGatewayRequestScope(
        {
          pluginId: PLUGIN_ID,
          client: createSyntheticPluginRuntimeClient({
            scopes: ["operator.write"],
            authenticatedUserProfile: { ...operatorProfile, profileId: profile.id },
          }),
          isWebchatConnect: () => false,
        },
        () => runtime.complete(request),
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.dynamicImportSettled();
      await vi.waitFor(() => expect(getBackgroundWorkSnapshot().queuedCount).toBe(1));
      request.agentId = "research";
      blockers.release();
      await blockers.settled();
      await expect(result).resolves.toEqual({ value: { text: "main:test-provider/main-model" } });
      expect(isolated).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "main",
          model: "main-model",
          authProfileId: "main-profile",
        }),
      );
    });
  });

  it.each(["runtime retirement", "binding replacement"])(
    "rechecks the host after profile verification awaits during %s",
    async (reason) => {
      const entered = createDeferred();
      const verification = createDeferred();
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
      client.authenticatedGitHubIdentitySync = async () => {
        entered.resolve();
        await verification.promise;
        client.authenticatedUserProfile = operatorProfile;
        return { profileId: operatorProfile.profileId, updatedAt: Date.now() };
      };
      const result = completeScoped(client, { agentId: "main" });
      const rejected = expect(result).rejects.toThrow(/retired|current gateway instance binding/u);
      await entered.promise;
      if (reason === "runtime retirement") {
        lifetime.abort(new Error("runtime retired"));
      } else {
        context = { getRuntimeConfig: () => config } as GatewayRequestContext;
      }
      verification.resolve();
      await rejected;
      expect(isolated).not.toHaveBeenCalled();
    },
  );

  it.each(["queued", "running"])(
    "rejects %s work after inherited operator tool authority closes",
    async (phase) => {
      const blockers = blockBackgroundSlots(phase === "queued" ? 3 : 0);
      const started = createDeferred();
      const cleanup = createDeferred();
      let runningSignal: AbortSignal | undefined;
      if (phase === "running") {
        isolated.mockImplementationOnce(async (params) => {
          runningSignal = params.abortSignal;
          started.resolve();
          await cleanup.promise;
          return {
            text: "late output",
            provider: params.provider,
            model: params.model,
            owner: { kind: "harness", id: "test-runtime" },
          };
        });
      }
      let rejected: Promise<void> | undefined;
      await inProcessDispatch.withOperatorToolGatewayAuthority(
        { authenticatedUserProfile: operatorProfile, scopes: ["operator.write"] },
        async () => {
          const result = complete(createRuntime());
          rejected = expect(result).rejects.toThrow("operator tool invocation authority expired");
          if (phase === "queued") {
            await vi.waitFor(() => expect(getBackgroundWorkSnapshot().queuedCount).toBe(1));
          } else {
            await started.promise;
          }
        },
      );
      if (phase === "running") {
        expect(runningSignal?.aborted).toBe(true);
      }
      blockers.release();
      cleanup.resolve();
      await rejected;
      await blockers.settled();
      expect(isolated).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
    },
  );

  it("revalidates the captured Gateway before inference after isolated preparation", async () => {
    const preparing = createDeferred();
    const finishPreparation = createDeferred();
    const inference = vi.fn();
    isolated.mockImplementationOnce(async (params) => {
      preparing.resolve();
      await finishPreparation.promise;
      params.assertCurrent?.();
      inference();
      return {
        text: "must not be generated",
        provider: params.provider,
        model: params.model,
        owner: { kind: "harness", id: "test-runtime" },
      };
    });
    const result = complete(createRuntime());
    const rejected = expect(result).rejects.toThrow("current gateway instance binding");
    await preparing.promise;
    context = { getRuntimeConfig: () => config } as GatewayRequestContext;
    finishPreparation.resolve();
    await rejected;
    expect(inference).not.toHaveBeenCalled();
  });

  it.each(["caller cancellation", "runtime retirement", "binding replacement"])(
    "never starts queued inference after %s",
    async (reason) => {
      const blockers = blockBackgroundSlots(3);
      const controller = new AbortController();
      const result = complete(createRuntime(), { signal: controller.signal });
      const rejected = expect(result).rejects.toThrow(
        /cancelled|retired|current gateway instance binding/u,
      );
      await vi.waitFor(() => expect(getBackgroundWorkSnapshot().queuedCount).toBe(1));
      if (reason === "caller cancellation") {
        controller.abort(new Error("caller cancelled"));
      } else if (reason === "runtime retirement") {
        lifetime.abort(new Error("runtime retired"));
      } else {
        context = {} as GatewayRequestContext;
      }
      blockers.release();
      await Promise.all([rejected, blockers.settled()]);
      expect(isolated).not.toHaveBeenCalled();
      expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 0, queuedCount: 0 });
    },
  );

  it.each(["caller cancellation", "timeout"])(
    "holds capacity through cleanup after %s and rejects late output",
    async (reason) => {
      const blockers = blockBackgroundSlots(2);
      const started = createDeferred();
      const aborted = createDeferred();
      const cleanup = createDeferred();
      let runningSignal: AbortSignal | undefined;
      isolated.mockImplementationOnce(async (params) => {
        runningSignal = params.abortSignal;
        runningSignal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        started.resolve();
        await cleanup.promise;
        return {
          text: "late output",
          provider: params.provider,
          model: params.model,
          owner: { kind: "harness", id: "test-runtime" },
        };
      });
      const controller = new AbortController();
      const runtime = createRuntime();
      const first = complete(runtime, {
        signal: controller.signal,
        ...(reason === "timeout" ? { timeoutMs: 10 } : {}),
      });
      await started.promise;
      const second = complete(runtime);
      await vi.waitFor(() => expect(getBackgroundWorkSnapshot().queuedCount).toBe(1));
      const rejected =
        reason === "timeout"
          ? expect(first).rejects.toMatchObject({ name: "TimeoutError" })
          : expect(first).rejects.toThrow("caller cancelled");
      if (reason === "caller cancellation") {
        controller.abort(new Error("caller cancelled"));
      }
      await aborted.promise;
      expect(runningSignal?.aborted).toBe(true);
      expect(isolated).toHaveBeenCalledOnce();
      expect(getBackgroundWorkSnapshot()).toMatchObject({ activeCount: 3, queuedCount: 1 });
      cleanup.resolve();
      await rejected;
      await expect(second).resolves.toEqual({ text: "research:test-provider/research-model" });
      expect(isolated).toHaveBeenCalledTimes(2);
      blockers.release();
      await blockers.settled();
    },
  );
});
