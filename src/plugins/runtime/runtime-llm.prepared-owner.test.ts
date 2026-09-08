import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../../agents/auth-profiles/runtime-snapshots.js";
import * as modelResolution from "../../agents/embedded-agent-runner/model.js";
import {
  acquireAgentRunPreparedModelRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { resetPluginLoaderTestStateForTest } from "../loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

it.each([
  "overlap",
  "config",
  "auth",
  "lru",
  "fork",
  "prepare-error",
  "prepare-throw",
  "provider-error",
  "abort",
] as const)("keeps direct completion ownership coherent: %s", async (mode) => {
  const roots = createSyncSuiteTempRootTracker("runtime-llm-prepared-owner");
  const root = fs.realpathSync(roots.makeTempDir());
  fs.mkdirSync(path.join(root, "provider"));
  const fixture = createColdPluginFixture({
    rootDir: path.join(root, "provider"),
    pluginId: "completion-lease-fixture",
    providerId: "completion-lease-provider",
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = {
      id: ${JSON.stringify(fixture.pluginId)},
      register(api) {
        api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Lease fixture", auth: [] });
      },
    };`,
  );
  const requests: ServerResponse[] = [];
  const requestFacts: Array<{ url: string; authorization: string | undefined }> = [];
  const arrivals = [createDeferred(), createDeferred(), createDeferred()];
  let finishing = false;
  const finish = (response: ServerResponse, index: number) => {
    if (response.writableEnded || response.destroyed) {
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "completion-lease-response",
        object: "chat.completion.chunk",
        model: "lease-model",
        choices: [
          {
            index: 0,
            delta: {
              content: `result-${index}|${requestFacts[index]?.url}|${requestFacts[index]?.authorization}`,
            },
            finish_reason: "stop",
          },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  };
  const server = createServer((request, response) => {
    request.resume();
    const index = requests.push(response) - 1;
    requestFacts.push({ url: request.url ?? "/", authorization: request.headers.authorization });
    arrivals[index]?.resolve();
    if (finishing) {
      finish(response, index);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const pending: Promise<unknown>[] = [];
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Completion fixture did not expose a TCP port");
    }
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: root,
          model: `${fixture.providerId}/lease-model${mode === "auth" ? `@${fixture.providerId}:control` : ""}`,
        },
      },
      models: {
        providers: {
          [fixture.providerId]: {
            api: "openai-completions",
            ...(mode === "auth" ? {} : { apiKey: "fixture-auth-A" }),
            baseUrl: `http://127.0.0.1:${address.port}/A/v1`,
            models: [
              "lease-model",
              ...Array.from({ length: 9 }, (_, index) => `churn-${index}`),
            ].map((id) => ({
              id,
              name: "Lease model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            })),
          },
        },
      },
      plugins: {
        load: { paths: [fixture.rootDir] },
        slots: { memory: "none" },
        entries: { [fixture.pluginId]: { enabled: true } },
      },
    };
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      const create = vi.spyOn(ModelRegistry, "create");
      const fork = vi.spyOn(ModelRegistry.prototype, "fork");
      const setRuntimeKey = vi.spyOn(AuthStorage.prototype, "setRuntimeApiKey");
      const resolveModel = modelResolution.resolveModelAsync;
      const resolver = vi.spyOn(modelResolution, "resolveModelAsync");
      let currentConfig = cfg;
      const llm = createRuntimeLlm({ getConfig: () => currentConfig });
      const input = (modelId = "lease-model") => ({
        config: cfg,
        agentId: "main",
        agentDir: resolveAgentDir(cfg, "main"),
        workspaceDir: root,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: fixture.providerId, modelId, agentId: "main" }],
      });
      const publishAuth = (key: string) =>
        setRuntimeAuthProfileStoreSnapshot(
          {
            version: 1,
            profiles: {
              [`${fixture.providerId}:control`]: {
                type: "api_key",
                provider: fixture.providerId,
                key,
              },
            },
          },
          input().agentDir,
        );
      if (mode === "auth") {
        publishAuth("fixture-auth-A");
      }
      if (mode === "lru") {
        await refreshPreparedModelRuntimeSnapshots(cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
      }
      const retained =
        mode === "config" || mode === "auth"
          ? await acquireAgentRunPreparedModelRuntime(input(), { catalogMode: "static" })
          : undefined;
      const start = (index: number, signal?: AbortSignal) => {
        const completion = llm.complete({
          messages: [{ role: "user", content: `request-${index}` }],
          ...(signal ? { signal } : {}),
        });
        pending.push(completion);
        return completion;
      };
      const waitForRequest = (index: number, completion: Promise<unknown>) =>
        Promise.race([
          arrivals[index]!.promise,
          completion.then(() => {
            throw new Error(`Completion ${index} settled before its provider request`);
          }),
        ]);
      try {
        if (mode === "fork" || mode === "prepare-error" || mode === "prepare-throw") {
          if (mode === "fork") {
            fork.mockImplementationOnce(() => {
              throw new Error("fixture store fork failure");
            });
          }
          if (mode === "prepare-throw") {
            setRuntimeKey.mockImplementationOnce(() => {
              throw new Error("fixture preparation failure");
            });
          }
          if (mode === "prepare-error") {
            resolver.mockImplementationOnce(async (...args) => ({
              ...(await resolveModel(...args)),
              model: undefined,
              error: "fixture model preparation unavailable",
            }));
          }
          const unexpectedRequest = createDeferred<never>();
          const rejectProviderRequest = () =>
            unexpectedRequest.reject(
              new Error("Preparation failure unexpectedly reached the provider"),
            );
          server.once("request", rejectProviderRequest);
          const failed = start(0);
          try {
            await Promise.race([
              expect(failed).rejects.toThrow(
                mode === "fork"
                  ? "fixture store fork failure"
                  : mode === "prepare-throw"
                    ? "fixture preparation failure"
                    : "Plugin LLM completion failed:",
              ),
              unexpectedRequest.promise,
            ]);
          } finally {
            server.removeListener("request", rejectProviderRequest);
          }
          expect(requests).toHaveLength(0);
          const buildsAfterFailure = create.mock.calls.length;
          expect(buildsAfterFailure).toBeGreaterThan(0);
          const next = start(0);
          await waitForRequest(0, next);
          expect.soft(create.mock.calls.length).toBe(buildsAfterFailure + 1);
          finish(requests[0]!, 0);
          await expect(next).resolves.toMatchObject({
            text: "result-0|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
          return;
        }
        const abortController = mode === "abort" ? new AbortController() : undefined;
        const firstStarted = performance.now();
        const first = start(0, abortController?.signal);
        await waitForRequest(0, first);
        const firstPreparationMs = performance.now() - firstStarted;
        const firstBuilds = create.mock.calls.length;
        expect(firstBuilds).toBeGreaterThan(0);
        if (mode === "provider-error" || mode === "abort") {
          if (abortController) {
            abortController.abort();
          } else {
            requests[0]!.writeHead(400, { "content-type": "application/json" });
            requests[0]!.end(
              JSON.stringify({
                error: { message: "fixture provider rejection", type: "invalid_request_error" },
              }),
            );
          }
          await expect(first).resolves.toMatchObject({ text: "" });
          const next = start(1);
          await waitForRequest(1, next);
          expect(create.mock.calls.length).toBe(firstBuilds + 1);
          finish(requests[1]!, 1);
          await expect(next).resolves.toMatchObject({
            text: "result-1|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
          return;
        }
        if (mode === "config") {
          currentConfig = {
            ...cfg,
            models: {
              providers: {
                ...cfg.models?.providers,
                [fixture.providerId]: {
                  ...cfg.models!.providers![fixture.providerId]!,
                  baseUrl: `http://127.0.0.1:${address.port}/B/v1`,
                  apiKey: "fixture-auth-B",
                },
              },
            },
          };
        }
        if (mode === "auth") {
          publishAuth("fixture-auth-B");
          await prepareModelRuntimeSnapshot(input());
        }
        if (mode === "lru") {
          for (let index = 0; index < 9; index += 1) {
            const other = await acquireAgentRunPreparedModelRuntime(input(`churn-${index}`), {
              catalogMode: "static",
            });
            other.release();
          }
        }
        const buildsBeforeSecond = create.mock.calls.length;
        const forksBeforeSecond = fork.mock.calls.length;
        const secondStarted = performance.now();
        const second = start(1);
        await waitForRequest(1, second);
        const secondPreparationMs = performance.now() - secondStarted;
        const secondBuilds = create.mock.calls.length;
        console.info("direct completion owner reuse", {
          mode,
          firstBuilds,
          buildsBeforeSecond,
          secondBuilds,
          firstPreparationMs,
          secondPreparationMs,
        });
        if (mode === "overlap" || mode === "lru") {
          expect.soft(secondBuilds).toBe(buildsBeforeSecond);
        }
        expect(fork.mock.calls.length).toBe(forksBeforeSecond + 1);
        expect(fork.mock.calls[forksBeforeSecond - 1]![0]).not.toBe(
          fork.mock.calls[forksBeforeSecond]![0],
        );
        finish(requests[0]!, 0);
        await expect(first).resolves.toMatchObject({
          text: "result-0|/A/v1/chat/completions|Bearer fixture-auth-A",
        });
        finish(requests[1]!, 1);
        await expect(second).resolves.toMatchObject({
          text: `result-1|/${mode === "config" ? "B" : "A"}/v1/chat/completions|Bearer fixture-auth-${mode === "config" || mode === "auth" ? "B" : "A"}`,
        });
        if (mode === "overlap") {
          const third = start(2);
          await waitForRequest(2, third);
          expect(create.mock.calls.length).toBe(secondBuilds + 1);
          finish(requests[2]!, 2);
          await expect(third).resolves.toMatchObject({
            text: "result-2|/A/v1/chat/completions|Bearer fixture-auth-A",
          });
        }
      } finally {
        finishing = true;
        requests.forEach(finish);
        await Promise.allSettled(pending);
        retained?.release();
        create.mockRestore();
        fork.mockRestore();
        setRuntimeKey.mockRestore();
        resolver.mockRestore();
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearRuntimeAuthProfileStoreSnapshots();
        clearPluginMetadataLifecycleCaches();
        resetPluginLoaderTestStateForTest();
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    roots.cleanup();
  }
});
