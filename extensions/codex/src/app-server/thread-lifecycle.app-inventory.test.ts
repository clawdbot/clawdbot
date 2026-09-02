import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import {
  ensureCodexAppServerClientRuntime,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { resolveCodexPluginsPolicy } from "./config.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import { createCodexPluginThreadConfigStartupProvider } from "./plugin-thread-config-deadline.js";
import { buildCodexPluginThreadConfigInputFingerprint } from "./plugin-thread-config.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { buildScheduledCodexAppAuthorityInputFingerprint } from "./scheduled-app-authority.js";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";
import { createCodexTestModel, useAutoCleanupTempDirTracker } from "./test-support.js";
import { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";
import {
  createAppServerOptions,
  createLeasedCodexLifecycleHarness,
  createParams,
  resetThreadLifecycleTestFixtures,
} from "./thread-lifecycle.test-fixtures.js";

describe("Codex app inventory across physical process restart", () => {
  const appId = "calendar-app";
  const pluginName = "calendar";
  const pluginConfig = {
    codexPlugins: {
      enabled: true,
      plugins: {
        calendar: {
          marketplaceName: "openai-curated",
          pluginName,
          enabled: true,
          allow_destructive_actions: false,
        },
      },
    },
  };
  const authority: NonNullable<EmbeddedRunAttemptParams["scheduledRuntimeAuthority"]> = {
    version: 1,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: {
      version: 1,
      auth: { profileId: "openai:fixture", accountId: "fixture-account" },
      apps: [
        {
          id: appId,
          allowDestructiveActions: false,
          allowOpenWorld: true,
          destructiveApprovalMode: "deny",
          tools: { list: "prompt" },
        },
      ],
    },
  };
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir = "";
  const processes: Array<{ close: () => void }> = [];

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-cold-app-inventory-");
  });
  afterEach(() => {
    for (const process of processes.splice(0)) {
      process.close();
    }
    resetThreadLifecycleTestFixtures();
    vi.restoreAllMocks();
  });

  async function fixture(scheduled: boolean) {
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {});
    params.agentDir = agentDir;
    params.disableTools = false;
    params.provider = "openai";
    params.model = {
      ...createCodexTestModel("openai"),
      id: "gpt-5.6-luna",
      name: "gpt-5.6-luna",
    };
    params.modelId = params.model.id;
    params.scheduledRuntimeAuthority = scheduled ? authority : undefined;
    const appServer = {
      ...createAppServerOptions(),
      connectionClass: "local-loopback" as const,
      remoteAppsSubstrate: "preconfigured" as const,
    };
    appServer.start = {
      ...appServer.start,
      env: { HOME: path.join(tempDir, "home"), CODEX_HOME: path.join(tempDir, "codex-home") },
    };
    const state = createCodexTestBindingStateStore();
    let bindingStore = createCodexAppServerBindingStore(state);
    const identity = sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    const durableThreads = new Map<string, JsonObject>();
    let sequence = 0;
    let processSequence = 0;
    let accountRevoked = false;
    const calls: Array<{ processId: string; method: string; params: JsonObject; loaded: boolean }> =
      [];
    const currentConfig: JsonObject = {
      apps: {
        _default: { enabled: false },
        [appId]: { enabled: true, tools: { list: { approval_mode: "auto" } } },
      },
    };

    async function createProcess(persistedThreadId?: string) {
      const processId = `process-${++processSequence}`;
      const loadedThreads = new Map<string, JsonObject>();
      const subscribedThreads = new Set<string>();
      const threadToolRevocations = new Set<string>();
      const disabledThreadApps = new Set<string>();
      const abort = new AbortController();
      const faults: { beforeInventory?: () => Promise<void>; unsubscribe?: Error } = {};
      let closeError: Error | undefined;
      const appCache = new CodexAppInventoryCache();
      const metadataCache = new CodexPluginMetadataCache();
      const assertOpen = () => {
        if (closeError) {
          throw closeError;
        }
      };
      const fake = await createLeasedCodexLifecycleHarness({
        agentDir,
        persistedThreads: persistedThreadId ? [persistedThreadId] : [],
        unsubscribe: (threadId) => {
          calls.push({
            processId,
            method: "thread/unsubscribe",
            params: { threadId },
            loaded: loadedThreads.has(threadId),
          });
          if (faults.unsubscribe) {
            throw faults.unsubscribe;
          }
          const wasSubscribed = subscribedThreads.delete(threadId);
          return {
            status: !loadedThreads.has(threadId)
              ? "notLoaded"
              : wasSubscribed
                ? "unsubscribed"
                : "notSubscribed",
          };
        },
        respond: async (method, raw) => {
          assertOpen();
          const requestParams = isJsonObject(raw) ? raw : {};
          const threadId =
            typeof requestParams.threadId === "string" ? requestParams.threadId : undefined;
          calls.push({
            processId,
            method,
            params: requestParams,
            loaded: Boolean(threadId && loadedThreads.has(threadId)),
          });
          if (
            ["app/installed", "app/read", "mcpServerStatus/list"].includes(method) &&
            threadId &&
            !loadedThreads.has(threadId)
          ) {
            throw new CodexAppServerRpcError(
              { code: -32600, message: `thread not found: ${threadId}` },
              method,
            );
          }
          if (method === "skills/list") {
            return { data: [], errors: [] };
          }
          if (method === "config/read") {
            return { config: currentConfig, layers: [] };
          }
          if (method === "plugin/installed") {
            return pluginInstalled([pluginSummary(pluginName, { installed: true, enabled: true })]);
          }
          if (method === "plugin/read") {
            return pluginDetail(pluginName, [appSummary(appId)]);
          }
          if (method === "app/installed" || method === "app/read") {
            if (threadId) {
              await faults.beforeInventory?.();
            }
            assertOpen();
            const effective = threadId ? loadedThreads.get(threadId) : currentConfig;
            const apps = isJsonObject(effective?.apps) ? effective.apps : {};
            const app = isJsonObject(apps[appId]) ? apps[appId] : {};
            const row = {
              ...appInfo(appId, !accountRevoked),
              isEnabled: app.enabled === true && !(threadId && disabledThreadApps.has(threadId)),
            };
            if (method === "app/installed") {
              return codexAppInventoryResponse(
                method,
                [row],
                {
                  forceRefresh: requestParams.forceRefresh === true,
                },
                { callableByAppId: { [appId]: !accountRevoked && row.isEnabled } },
              );
            }
            return codexAppInventoryResponse(method, [row], {
              appIds: Array.isArray(requestParams.appIds)
                ? requestParams.appIds.filter((value): value is string => typeof value === "string")
                : [],
              includeTools: requestParams.includeTools === true,
            });
          }
          if (method === "mcpServerStatus/list") {
            return {
              data: [
                {
                  name: "codex_apps",
                  tools:
                    accountRevoked || (threadId && threadToolRevocations.has(threadId))
                      ? {}
                      : { list: { _meta: { connector_id: appId } } },
                },
              ],
              nextCursor: null,
            };
          }
          if (method === "thread/start") {
            const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
            const config = isJsonObject(requestParams.config) ? requestParams.config : {};
            durableThreads.set(id, config);
            loadedThreads.set(id, config);
            subscribedThreads.add(id);
            return { ...threadStartResult(id, workspaceDir), model: params.modelId };
          }
          if (method === "thread/resume" && threadId) {
            if (!durableThreads.has(threadId)) {
              throw new CodexAppServerRpcError(
                { code: -32600, message: `thread not found: ${threadId}` },
                method,
              );
            }
            // Loaded threads ignore config overrides; cold resume rebuilds effective config.
            if (!loadedThreads.has(threadId)) {
              const config = isJsonObject(requestParams.config)
                ? requestParams.config
                : durableThreads.get(threadId)!;
              loadedThreads.set(threadId, config);
              durableThreads.set(threadId, config);
            }
            subscribedThreads.add(threadId);
            return { ...threadStartResult(threadId, workspaceDir), model: params.modelId };
          }
          if (method === "thread/delete" && threadId) {
            loadedThreads.delete(threadId);
            durableThreads.delete(threadId);
            return {};
          }
          throw new Error(`unexpected fixture RPC: ${method}`);
        },
      });
      const close = (error?: Error) => {
        closeError = error;
        loadedThreads.clear();
        subscribedThreads.clear();
        fake.client.close();
      };
      fake.client.addCloseHandler((client) => {
        closeError = client.getCloseError() ?? new Error("codex app-server client is closed");
      });
      ensureCodexAppServerClientRuntime(fake.client, { agentDir });
      processes.push({ close });
      const abandonClient = vi.fn(async () => close());
      const appCacheKey = "same-account-home-version";
      const inputFingerprint = buildScheduledCodexAppAuthorityInputFingerprint(
        buildCodexPluginThreadConfigInputFingerprint({ pluginConfig, appCacheKey }),
        params.scheduledRuntimeAuthority,
      );
      const provider = () =>
        createCodexPluginThreadConfigStartupProvider({
          inputFingerprint,
          enabledPluginConfigKeys: [pluginName],
          policy: resolveCodexPluginsPolicy(pluginConfig),
          requestTimeoutMs: appServer.requestTimeoutMs,
          signal: abort.signal,
          pluginConfig,
          client: fake.client,
          configCwd: workspaceDir,
          appCache,
          appCacheKey,
          metadataCache,
          scheduledRuntimeAuthority: params.scheduledRuntimeAuthority,
        });
      return {
        ...fake,
        close,
        loadedThreads,
        subscribedThreads,
        threadToolRevocations,
        disabledThreadApps,
        abort,
        faults,
        abandonClient,
        run: () =>
          startOrResumeThreadImpl({
            client: fake.client,
            abandonClient,
            signal: abort.signal,
            params,
            cwd: workspaceDir,
            dynamicTools: [],
            appServer,
            bindingStore,
            userMcpServersEnabled: false,
            nativeCodeModeEnabled: true,
            hostSystemAgentActive: false,
            pluginThreadConfig: provider(),
          }),
      };
    }
    return {
      calls,
      createProcess,
      readBinding: () => bindingStore.read(identity),
      replaceBinding: async (threadId: string) => {
        const current = await bindingStore.read(identity);
        if (!current) {
          throw new Error("fixture binding missing");
        }
        expect(
          await bindingStore.mutate(identity, {
            kind: "replace-thread",
            expectedThreadId: current.threadId,
            binding: { ...current, threadId },
          }),
        ).toBe(true);
      },
      restartStore: () => {
        bindingStore = createCodexAppServerBindingStore(state);
      },
      revokeAccount: () => {
        accountRevoked = true;
      },
    };
  }

  async function continuation(scheduled: boolean, lifecycle: string) {
    const f = await fixture(scheduled);
    const firstProcess = await f.createProcess();
    const first = await firstProcess.run();
    expect(first.pluginAppPolicyContext?.apps[appId]).toBeDefined();
    expect(firstProcess.loadedThreads.has(first.threadId)).toBe(true);
    if (lifecycle !== "cold") {
      expect(
        await retainCodexAppServerLiveThread(
          firstProcess.client,
          first.threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        ),
      ).toBe(true);
      if (lifecycle === "unloaded-same-process") {
        expect(await releaseCodexAppServerLiveThread(firstProcess.client, first.threadId)).toBe(
          true,
        );
        expect(firstProcess.subscribedThreads.has(first.threadId)).toBe(false);
        expect(firstProcess.loadedThreads.has(first.threadId)).toBe(true);
        // Native idle eviction is a separate event, not an unsubscribe receipt.
        firstProcess.loadedThreads.delete(first.threadId);
        firstProcess.notify({
          method: "thread/closed",
          params: { threadId: first.threadId },
        });
      }
    } else {
      firstProcess.close();
      f.restartStore();
    }
    const process = lifecycle === "cold" ? await f.createProcess(first.threadId) : firstProcess;
    return { ...f, first, process };
  }

  it.each([
    { lifecycle: "cold", scheduled: false },
    { lifecycle: "warm", scheduled: false },
    { lifecycle: "unloaded-same-process", scheduled: false },
    { lifecycle: "cold", scheduled: true },
    { lifecycle: "warm", scheduled: true },
    { lifecycle: "unloaded-same-process", scheduled: true },
  ])(
    "preserves approved apps on $lifecycle continuation, scheduled=$scheduled",
    async ({ lifecycle, scheduled }) => {
      const f = await continuation(scheduled, lifecycle);
      const { first, process } = f;
      const boundary = f.calls.length;
      const requestBoundary = process.request.mock.calls.length;
      const second = await process.run();
      expect(
        process.request.mock.calls
          .slice(requestBoundary)
          .map(([method]) => method)
          .filter((method) => method.startsWith("thread/")),
      ).toEqual(
        lifecycle === "warm" ? [] : ["thread/read", "thread/resume", "thread/inject_items"],
      );
      expect(second.threadId).toBe(first.threadId);
      if (lifecycle === "warm") {
        expect(f.calls.slice(boundary).some((call) => call.method === "thread/resume")).toBe(false);
      }
      if (scheduled) {
        expect(process.loadedThreads.get(second.threadId)).toMatchObject({
          apps: { [appId]: { tools: { list: { approval_mode: "prompt" } } } },
        });
      }
      expect((await f.readBinding())?.pluginAppPolicyContext?.apps[appId]).toMatchObject({
        allowDestructiveActions: false,
      });
      const scopedReads = f.calls
        .slice(boundary)
        .filter(
          (call) =>
            ["app/installed", "app/read", "mcpServerStatus/list"].includes(call.method) &&
            call.params.threadId,
        );
      expect(scopedReads.length).toBeGreaterThan(0);
      expect(scopedReads.every((call) => call.loaded)).toBe(true);
      expect(
        scopedReads.some(
          (call) => call.method === "app/installed" && call.params.threadId === second.threadId,
        ),
      ).toBe(true);
      if (scheduled) {
        expect(
          scopedReads.some(
            (call) =>
              call.method === "mcpServerStatus/list" && call.params.threadId === second.threadId,
          ),
        ).toBe(true);
      }
    },
  );

  it("keeps revoked account apps unavailable after a cold process restart", async () => {
    const f = await continuation(false, "cold");
    f.revokeAccount();
    const boundary = f.calls.length;
    const second = await f.process.run();
    expect(second.pluginAppPolicyContext?.apps).not.toHaveProperty(appId);
    expect((await f.readBinding())?.pluginAppPolicyContext?.apps).not.toHaveProperty(appId);
    const reads = f.calls
      .slice(boundary)
      .filter((call) => ["app/installed", "app/read"].includes(call.method));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.some((call) => call.params.threadId && call.loaded)).toBe(true);
    expect(reads.every((call) => !call.params.threadId || call.loaded)).toBe(true);
  });

  it("rejects a scheduled continuation whose account app was revoked", async () => {
    const f = await continuation(true, "cold");
    f.revokeAccount();
    await expect(f.process.run()).rejects.toThrow("Scheduled Codex apps are unavailable");
  });

  it("checks scheduled tools on the loaded thread even when account-wide tools remain available", async () => {
    const f = await continuation(true, "warm");
    const { process, first } = f;
    process.threadToolRevocations.add(first.threadId);
    const boundary = f.calls.length;
    await expect(process.run()).rejects.toThrow("Scheduled Codex apps are unavailable");
    const calls = f.calls.slice(boundary);
    expect(
      calls.some(
        (call) =>
          call.method === "mcpServerStatus/list" &&
          call.params.threadId === first.threadId &&
          call.loaded,
      ),
    ).toBe(true);
    expect(
      calls.filter((call) => call.method === "thread/start" || call.method === "thread/resume"),
    ).toEqual([]);
  });

  it.each([
    { lifecycle: "cold", fault: "abort" },
    { lifecycle: "warm", fault: "abort" },
    { lifecycle: "cold", fault: "replacement" },
    { lifecycle: "warm", fault: "replacement" },
  ])("fences $fault during $lifecycle loaded-thread admission", async ({ lifecycle, fault }) => {
    const f = await continuation(false, lifecycle);
    const previousBinding = await f.readBinding();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const replacementId = "00000000-0000-4000-8000-000000000099";
    f.process.faults.beforeInventory = async () => {
      f.process.faults.beforeInventory = undefined;
      entered.resolve();
      await release.promise;
      if (fault === "replacement") {
        await f.replaceBinding(replacementId);
      }
    };
    const boundary = f.calls.length;
    const pending = f.process.run();
    const rejected = expect(pending).rejects.toThrow(
      fault === "abort" ? "admission cancelled" : "Codex thread binding changed",
    );
    await entered.promise;
    if (fault === "abort") {
      f.process.abort.abort(new Error("admission cancelled"));
    }
    release.resolve();
    await rejected;
    expect(await f.readBinding()).toEqual(
      fault === "abort" ? previousBinding : { ...previousBinding, threadId: replacementId },
    );
    expect(f.process.subscribedThreads.has(f.first.threadId)).toBe(false);
    expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(false);
  });

  it.each(["cold", "warm"])(
    "attests provisional apps on the %s loaded thread",
    async (lifecycle) => {
      const f = await continuation(false, lifecycle);
      const previousBinding = await f.readBinding();
      f.process.disabledThreadApps.add(f.first.threadId);
      const boundary = f.calls.length;
      await expect(f.process.run()).rejects.toThrow("did not expose admitted apps");
      expect(await f.readBinding()).toEqual(previousBinding);
      expect(f.process.subscribedThreads.has(f.first.threadId)).toBe(false);
      expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(false);
    },
  );

  it.each(["cold", "warm"])(
    "preserves the durable binding when the %s client closes during inventory",
    async (lifecycle) => {
      const f = await continuation(false, lifecycle);
      const previousBinding = await f.readBinding();
      f.process.faults.beforeInventory = async () => {
        f.process.faults.beforeInventory = undefined;
        f.process.close(new Error("codex app-server client is closed"));
      };
      const boundary = f.process.request.mock.calls.length;
      await expect(f.process.run()).rejects.toThrow();
      expect(await f.readBinding()).toEqual(previousBinding);
      expect(
        f.process.request.mock.calls.slice(boundary).some(([method]) => method === "thread/start"),
      ).toBe(false);
    },
  );

  it.each(["cold", "warm"])(
    "retires the %s client when denied admission cannot unsubscribe",
    async (lifecycle) => {
      const f = await continuation(true, lifecycle);
      const previousBinding = await f.readBinding();
      f.process.threadToolRevocations.add(f.first.threadId);
      f.process.faults.unsubscribe = new Error("unsubscribe unavailable");
      const boundary = f.calls.length;
      await expect(f.process.run()).rejects.toMatchObject(
        lifecycle === "cold"
          ? {
              name: "CodexThreadPolicyHandoffError",
              outcome: "not-written",
              cause: expect.objectContaining({
                message: expect.stringContaining("Scheduled Codex apps are unavailable"),
              }),
            }
          : { name: "CodexAppServerUnsafeSubscriptionError" },
      );
      expect(f.process.abandonClient).toHaveBeenCalledOnce();
      expect(await f.readBinding()).toEqual(previousBinding);
      expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(false);
    },
  );
});
