import { DatabaseSync } from "node:sqlite";
import {
  createWritableTransportEventStream,
  failTransportStream,
  finalizeTransportStream,
  notifyProviderHttpMetadata,
} from "@openclaw/ai/transports";
import { expect, it, vi } from "vitest";
import type { PreparedModelRuntimeLease } from "../agents/prepared-model-runtime.types.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { completeWithPreparedSimpleCompletionModelCore } from "../agents/simple-completion-execution.js";
import { acquireSimpleCompletionModel } from "../agents/simple-completion-runtime.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  getPluginRegistryResourceScope,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AssistantMessage } from "./types.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

const acquireRuntime = vi.hoisted(() => vi.fn<() => Promise<PreparedModelRuntimeLease>>());
vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  acquireAgentRunPreparedModelRuntime: acquireRuntime,
}));
vi.mock("../agents/model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-auth.js")>()),
  getApiKeyForModelCore: async () => ({
    mode: "api-key",
    source: "synthetic",
    apiKey: "synthetic-completion-key",
  }),
}));

it.each(["factory", "response-abort", "stream-cancel", "idle-release"] as const)(
  "retains acquired completion generation through actual %s work",
  async (mode) => {
    await withOpenClawTestState({ label: "completion-resource-owner" }, async (state) => {
      const registry = createEmptyPluginRegistry();
      const unrelated = createEmptyPluginRegistry();
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const db = new DatabaseSync(":memory:");
      const owner = createPluginRegistryResourceOwner(registry, "scoped");
      registerPluginRegistryResourceDisposer(registry, "completion-fixture", {
        id: "completion-fixture",
        dispose: () => db.close(),
      });
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const observed: unknown[] = [];
      const callbackSettled = createDeferredCore();
      const controller = new AbortController();
      const model = makeProviderModelFixture({
        provider: "completion-fixture",
        id: "synthetic",
        api: "fixture-api",
        baseUrl: "https://example.invalid",
      });
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const readAfterGate = async () => {
        observed.push(getPluginRuntimeGenerationRegistry(), getPluginRegistryResourceScope());
        started.resolve();
        try {
          await finish.promise;
          observed.push(getPluginRuntimeGenerationRegistry(), getPluginRegistryResourceScope());
          message.content = [
            { type: "text", text: JSON.stringify(db.prepare("SELECT 42 AS value").get()) },
          ];
        } finally {
          callbackSettled.resolve();
        }
      };
      const stream = vi.fn(async () => {
        if (mode === "factory") {
          await readAfterGate();
          const output = createAssistantMessageEventStream();
          output.end(message);
          return output;
        }
        const { eventStream, stream: output } = createWritableTransportEventStream();
        // Exercise the actual response callback's cancellation race and terminal producer.
        void notifyProviderHttpMetadata({
          options: {
            signal: controller.signal,
            onResponse:
              mode === "stream-cancel"
                ? () => {
                    throw new Error("synthetic response failure");
                  }
                : readAfterGate,
          },
          response: { status: 200, headers: {} },
          model,
          cancelStream: mode === "stream-cancel" ? readAfterGate : () => {},
        }).then(
          () =>
            finalizeTransportStream({ stream: output, output: message, signal: controller.signal }),
          (error: unknown) =>
            failTransportStream({
              stream: output,
              output: message,
              error,
              signal: controller.signal,
            }),
        );
        return eventStream;
      });
      registry.providers.push({
        pluginId: "completion-fixture",
        source: "synthetic",
        provider: {
          id: "completion-fixture",
          label: "Synthetic",
          auth: [],
          createStreamFn: () => stream,
        },
      });
      const authStorage = AuthStorage.inMemory();
      const modelRegistry = ModelRegistry.create(authStorage, state.path("models.json"), {
        includePluginCatalogs: false,
        pluginMetadataSnapshot: metadataSnapshot,
      });
      const release = vi.fn(() => owner.release());
      const config = {};
      acquireRuntime.mockResolvedValue({
        snapshot: {
          catalogOwner: undefined,
          agentDir: state.root,
          workspaceDir: state.root,
          activeProjectKeys: [],
          config,
          observationConfig: config,
          isCurrent: () => true,
          authModes: {},
          metadataSnapshot,
          pluginRegistry: registry,
          allowGatewaySubagentBinding: false,
          modelCatalog: { entries: [], routeVariants: [] },
          configuredRuntimeModels: [],
          inlineProviderModels: [],
          createStores: () => ({ authStorage, modelRegistry }),
        },
        pluginGeneration: {
          pluginMetadataSnapshot: metadataSnapshot,
          pluginRegistry: registry,
          inlineProviderModels: [],
          configuredCatalogEntries: [],
        },
        release,
      });
      const prepared = await acquireSimpleCompletionModel({
        cfg: config,
        provider: model.provider,
        modelId: model.id,
        modelResolver: async () => ({ model, authStorage, modelRegistry }),
      });
      if ("error" in prepared) {
        throw new Error(prepared.error);
      }
      const request = { model: prepared.model, auth: prepared.auth, context: { messages: [] } };
      let pending: Promise<AssistantMessage> | undefined;
      try {
        if (mode === "idle-release") {
          prepared.release();
          prepared.release();
          await drainPluginRegistryResourceDisposals();
          expect(db.isOpen).toBe(false);
          expect(release).toHaveBeenCalledOnce();
          expect(stream).not.toHaveBeenCalled();
          return;
        }
        const revoked = new Error("current owner revoked");
        await expect(
          completeWithPreparedSimpleCompletionModelCore({
            ...request,
            assertCurrent: () => {
              throw revoked;
            },
          }),
        ).rejects.toBe(revoked);
        expect(stream).not.toHaveBeenCalled();
        pending = withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry: unrelated },
          () => completeWithPreparedSimpleCompletionModelCore(request),
        );
        await started.promise;
        expect.soft(observed[0]).toBe(registry);
        expect.soft(observed[1]).toBeDefined();
        if (mode === "response-abort") {
          controller.abort(new Error("synthetic cancellation"));
          expect((await pending).stopReason).toBe("aborted");
        } else if (mode === "stream-cancel") {
          expect(await pending).toMatchObject({
            stopReason: "error",
            errorMessage: "synthetic response failure",
          });
        }
        prepared.release();
        expect.soft(release).not.toHaveBeenCalled();
        expect.soft(db.isOpen).toBe(true);
        finish.resolve();
        await pending;
        await callbackSettled.promise;
        expect.soft(message.content).toEqual([{ type: "text", text: '{"value":42}' }]);
        await expect(completeWithPreparedSimpleCompletionModelCore(request)).rejects.toThrow(
          /released/,
        );
        expect(stream).toHaveBeenCalledOnce();
        expect.soft(observed[2]).toBe(registry);
        expect.soft(observed[3]).toBe(observed[1]);
        await drainPluginRegistryResourceDisposals();
        expect(release).toHaveBeenCalledOnce();
        expect(db.isOpen).toBe(false);
      } finally {
        finish.resolve();
        await pending?.catch(() => {});
        prepared.release();
        await drainPluginRegistryResourceDisposals();
        if (db.isOpen) {
          db.close();
        }
      }
    });
  },
);
