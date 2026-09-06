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
import { resolveCodexPluginsPolicy, type CodexPluginConfig } from "./config.js";
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

  async function fixture(
    scheduled: boolean,
    configuredPlugins: CodexPluginConfig = pluginConfig,
    nativeApps: JsonObject = {},
  ) {
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      workspaceDir,
      scheduled ? { tools: { web: { search: { enabled: false } } } } : {},
    );
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
    params.pluginHarnessToolPolicyRestricted = scheduled;
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
    const nativeLinkPolicy: JsonObject = {};
    const currentConfig: JsonObject = {
      mcp_servers: { inherited: { command: "synthetic-mcp" } },
      apps: {
        ...nativeApps,
        _default: { enabled: false },
        [appId]: {
          enabled: true,
          tools: { list: { approval_mode: "auto" } },
          links: { account: nativeLinkPolicy },
        },
      },
    };

    async function createProcess(persistedThreadId?: string) {
      const processId = `process-${++processSequence}`;
      const loadedThreads = new Map<string, JsonObject>();
      const subscribedThreads = new Set<string>();
      const threadToolRevocations = new Set<string>();
      const disabledThreadApps = new Set<string>();
      const abort = new AbortController();
      const faults: {
        beforeInventory?: () => Promise<void>;
        beforeMcpAttestation?: () => Promise<void>;
        activeInheritedMcp?: boolean;
        unsubscribe?: Error;
      } = {};
      let closeError: Error | undefined;
      const appCache = new CodexAppInventoryCache();
      const metadataCache = new CodexPluginMetadataCache();
      const assertOpen = () => {
        if (closeError) {
          throw closeError;
        }
      };
      const reloadUserConfig = () => {
        for (const threadId of loadedThreads.keys()) {
          loadedThreads.set(
            threadId,
            mergeNativeFixtureConfig(currentConfig, durableThreads.get(threadId)!),
          );
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
          if (method === "config/batchWrite") {
            throw new Error("App admission must not mutate saved native settings");
          }
          if (method === "configRequirements/read") {
            return { requirements: null };
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
            const effective = threadId
              ? mergeNativeFixtureConfig(currentConfig, durableThreads.get(threadId)!)
              : currentConfig;
            const apps = isJsonObject(effective?.apps) ? effective.apps : {};
            const app = isJsonObject(apps[appId]) ? apps[appId] : {};
            const row = {
              ...appInfo(appId, !accountRevoked),
              isEnabled:
                effective?.["features.apps"] !== false &&
                app.enabled === true &&
                !(threadId && disabledThreadApps.has(threadId)),
              toolSummaries: [
                {
                  name: "list",
                  title: null,
                  description: "List calendar entries.",
                  isEnabled: true,
                  disabledReason: null,
                  isReadOnly: true,
                },
              ],
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
            if (threadId && requestParams.limit === undefined) {
              await faults.beforeMcpAttestation?.();
            }
            const effective = threadId
              ? mergeNativeFixtureConfig(currentConfig, durableThreads.get(threadId)!)
              : currentConfig;
            return {
              data: [
                ...(effective?.["features.apps"] === false
                  ? []
                  : [
                      {
                        name: "codex_apps",
                        serverInfo: { name: "codex_apps", version: "1" },
                        tools:
                          accountRevoked || (threadId && threadToolRevocations.has(threadId))
                            ? {}
                            : {
                                list: {
                                  _meta: { connector_id: appId },
                                  annotations: { destructiveHint: false, openWorldHint: false },
                                },
                              },
                      },
                    ]),
                {
                  name: "inherited",
                  serverInfo: faults.activeInheritedMcp
                    ? { name: "inherited", version: "1" }
                    : null,
                  tools: {},
                },
              ],
              nextCursor: null,
            };
          }
          if (method === "thread/start") {
            const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
            const config = isJsonObject(requestParams.config) ? requestParams.config : {};
            durableThreads.set(id, config);
            loadedThreads.set(id, mergeNativeFixtureConfig(currentConfig, config));
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
              loadedThreads.set(threadId, mergeNativeFixtureConfig(currentConfig, config));
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
      const policy = resolveCodexPluginsPolicy(configuredPlugins);
      const inputFingerprint = buildScheduledCodexAppAuthorityInputFingerprint(
        buildCodexPluginThreadConfigInputFingerprint({
          pluginConfig: configuredPlugins,
          appCacheKey,
        }),
        params.scheduledRuntimeAuthority,
      );
      const provider = () =>
        createCodexPluginThreadConfigStartupProvider({
          inputFingerprint,
          enabledPluginConfigKeys: policy.pluginPolicies
            .filter((plugin) => plugin.enabled)
            .map((plugin) => plugin.configKey),
          policy,
          requestTimeoutMs: appServer.requestTimeoutMs,
          signal: abort.signal,
          pluginConfig: configuredPlugins,
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
        reloadUserConfig,
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
            nativeCodeModeEnabled: !scheduled,
            ...(scheduled ? { webSearchAllowed: false, persistentWebSearchAllowed: false } : {}),
            hostSystemAgentActive: false,
            pluginThreadConfig: provider(),
          }),
      };
    }
    return {
      appServer,
      calls,
      createProcess,
      nativeLinkPolicy,
      readBinding: () => bindingStore.read(identity),
      replaceBinding: async (threadId: string) => {
        const current = bindingStore.read(identity);
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

  async function continuation(
    scheduled: boolean,
    lifecycle: string,
    configuredPlugins?: CodexPluginConfig,
    nativeApps?: JsonObject,
  ) {
    const f = await fixture(scheduled, configuredPlugins, nativeApps);
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
          apps: { [appId]: { tools: { list: { enabled: true, approval_mode: "prompt" } } } },
        });
      }
      expect(f.readBinding()?.pluginAppPolicyContext?.apps[appId]).toMatchObject({
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

  it.each(["cold", "warm", "unloaded-same-process"])(
    "preserves excluded native app denials on non-ask %s continuation",
    async (lifecycle) => {
      const f = await continuation(
        false,
        lifecycle,
        { codexPlugins: { enabled: true, allow_all_plugins: true } },
        { excluded: { enabled: true } },
      );
      const boundary = f.calls.length;
      const second = await f.process.run();
      expect(second.threadId).toBe(f.first.threadId);
      if (lifecycle === "warm") {
        expect(
          f.calls
            .slice(boundary)
            .some((call) => ["thread/resume", "thread/unsubscribe"].includes(call.method)),
        ).toBe(false);
      }
      expect(f.process.loadedThreads.get(second.threadId)).toMatchObject({
        apps: { [appId]: { enabled: true }, excluded: { enabled: false } },
      });
    },
  );

  it.each(["cold", "warm"])(
    "reconfigures the %s thread when native ask override keys change",
    async (lifecycle) => {
      const f = await continuation(false, lifecycle, {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "ask",
        },
      });
      expect(f.first.pluginAppPolicyContext?.apps[appId]).toMatchObject({
        source: "account",
        destructiveApprovalMode: "ask",
      });
      // A native client can add a higher-precedence link reviewer without changing
      // the OpenClaw policy fingerprint or invalidating its cached app inventory.
      f.nativeLinkPolicy.approvals_reviewer = "auto_review";
      if (lifecycle === "warm") {
        f.process.reloadUserConfig();
        expect(f.process.loadedThreads.get(f.first.threadId)).toMatchObject({
          apps: { [appId]: { links: { account: { approvals_reviewer: "auto_review" } } } },
        });
      }
      const boundary = f.calls.length;
      const second = await f.process.run();
      expect(f.nativeLinkPolicy.approvals_reviewer).toBe("auto_review");
      const writes = f.calls.slice(boundary).filter((call) => call.method === "config/batchWrite");
      expect(writes).toHaveLength(0);
      if (lifecycle === "cold") {
        expect(second.threadId).toBe(f.first.threadId);
      } else {
        expect(second.threadId).not.toBe(f.first.threadId);
      }
      expect(f.readBinding()?.pluginAppPolicyContext?.apps[appId]).toMatchObject({
        source: "account",
        destructiveApprovalMode: "ask",
      });
      expect(f.process.loadedThreads.get(second.threadId)).toMatchObject({
        apps: {
          [appId]: {
            enabled: true,
            approvals_reviewer: "user",
            links: { account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" } },
          },
        },
      });
      // A later native reload keeps this thread's higher-precedence ask overlay.
      expect(
        await retainCodexAppServerLiveThread(
          f.process.client,
          second.threadId,
          undefined,
          second.liveThreadConfigFingerprint,
        ),
      ).toBe(true);
      f.process.reloadUserConfig();
      const third = await f.process.run();
      expect(third.threadId).toBe(second.threadId);
      expect(f.process.loadedThreads.get(third.threadId)).toMatchObject({
        apps: { [appId]: { links: { account: { approvals_reviewer: "user" } } } },
      });
    },
  );

  it.each([
    { lifecycle: "warm", scheduled: false },
    { lifecycle: "cold", scheduled: false },
    { lifecycle: "warm", scheduled: true },
    { lifecycle: "cold", scheduled: true },
  ])(
    "contains $lifecycle ask inventory timeouts, scheduled=$scheduled",
    async ({ lifecycle, scheduled }) => {
      const f = await continuation(scheduled, lifecycle, {
        codexPlugins: {
          enabled: true,
          allow_all_plugins: true,
          allow_destructive_actions: "ask",
        },
      });
      const binding = f.readBinding();
      const release = createDeferred<void>();
      f.process.faults.beforeInventory = () => release.promise;
      f.appServer.requestTimeoutMs = 400;
      // Real request timers can win before the wall clock reaches the shared
      // deadline. Keep that ordering deterministic without replacing the timers.
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const boundary = f.calls.length;
      try {
        if (scheduled) {
          await expect(f.process.run()).rejects.toThrow(
            "Codex app policy verification exceeded its 100 ms startup budget",
          );
          expect(f.readBinding()).toEqual(binding);
          expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(
            false,
          );
          return;
        }
        const second = await f.process.run();
        expect(second.threadId).not.toBe(f.first.threadId);
        expect(f.readBinding()?.threadId).toBe(second.threadId);
        expect(f.readBinding()?.pluginAppPolicyContext?.apps).toEqual({});
        expect(f.process.loadedThreads.get(second.threadId)).toMatchObject({
          "features.apps": false,
          apps: { _default: { enabled: false }, [appId]: { enabled: true } },
        });
        const mcp = await f.process.client.request("mcpServerStatus/list", {
          threadId: second.threadId,
        });
        expect(mcp.data).not.toContainEqual(expect.objectContaining({ name: "codex_apps" }));
        expect(f.process.subscribedThreads.has(f.first.threadId)).toBe(false);
        expect(
          f.calls.slice(boundary).filter((call) => call.method === "thread/start"),
        ).toHaveLength(1);
      } finally {
        f.process.abort.abort();
        release.resolve();
      }
    },
  );

  it("keeps revoked account apps unavailable after a cold process restart", async () => {
    const f = await continuation(false, "cold");
    f.revokeAccount();
    const boundary = f.calls.length;
    const second = await f.process.run();
    expect(second.pluginAppPolicyContext?.apps).not.toHaveProperty(appId);
    expect(f.readBinding()?.pluginAppPolicyContext?.apps).not.toHaveProperty(appId);
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

  it.each(["cold", "warm"])(
    "rejects active inherited MCP servers on a scheduled %s continuation",
    async (lifecycle) => {
      const f = await continuation(true, lifecycle);
      const previousBinding = f.readBinding();
      f.process.faults.activeInheritedMcp = true;
      const boundary = f.calls.length;
      await expect(f.process.run()).rejects.toThrow(
        "restricted-tool-surface MCP attestation found active server inherited",
      );
      expect(f.readBinding()).toEqual(previousBinding);
      expect(f.process.subscribedThreads.has(f.first.threadId)).toBe(false);
      expect(f.process.loadedThreads.has(f.first.threadId)).toBe(true);
      expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(false);
    },
  );

  it("fences warm ownership revoked during restricted MCP attestation", async () => {
    const f = await continuation(true, "warm");
    const previousBinding = f.readBinding();
    f.process.faults.beforeMcpAttestation = async () => {
      f.process.notify({ method: "thread/closed", params: { threadId: f.first.threadId } });
    };
    await expect(f.process.run()).rejects.toThrow("Codex warm thread ownership changed");
    expect(f.readBinding()).toEqual(previousBinding);
  });

  it.each([
    { lifecycle: "cold", fault: "abort" },
    { lifecycle: "warm", fault: "abort" },
    { lifecycle: "cold", fault: "replacement" },
    { lifecycle: "warm", fault: "replacement" },
  ])("fences $fault during $lifecycle loaded-thread admission", async ({ lifecycle, fault }) => {
    const f = await continuation(false, lifecycle);
    const previousBinding = f.readBinding();
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
    expect(f.readBinding()).toEqual(
      fault === "abort" ? previousBinding : { ...previousBinding, threadId: replacementId },
    );
    expect(f.process.subscribedThreads.has(f.first.threadId)).toBe(false);
    expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(false);
  });

  it.each(["cold", "warm"])(
    "keeps the %s loaded thread when an optional app is disabled",
    async (lifecycle) => {
      const f = await continuation(false, lifecycle);
      const previousBinding = f.readBinding();
      f.process.disabledThreadApps.add(f.first.threadId);
      const boundary = f.calls.length;
      await expect(f.process.run()).resolves.toMatchObject({ threadId: f.first.threadId });
      expect(f.readBinding()).toMatchObject({ threadId: previousBinding!.threadId });
      expect(f.process.subscribedThreads.has(f.first.threadId)).toBe(true);
      expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(false);
    },
  );

  it.each(["cold", "warm"])(
    "preserves the durable binding when the %s client closes during inventory",
    async (lifecycle) => {
      const f = await continuation(false, lifecycle);
      const previousBinding = f.readBinding();
      f.process.faults.beforeInventory = async () => {
        f.process.faults.beforeInventory = undefined;
        f.process.close(new Error("codex app-server client is closed"));
      };
      const boundary = f.process.request.mock.calls.length;
      await expect(f.process.run()).rejects.toThrow();
      expect(f.readBinding()).toEqual(previousBinding);
      expect(
        f.process.request.mock.calls.slice(boundary).some(([method]) => method === "thread/start"),
      ).toBe(false);
    },
  );

  it.each(["cold", "warm"])(
    "retires the %s client when denied admission cannot unsubscribe",
    async (lifecycle) => {
      const f = await continuation(true, lifecycle);
      const previousBinding = f.readBinding();
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
      expect(f.readBinding()).toEqual(previousBinding);
      expect(f.calls.slice(boundary).some((call) => call.method === "thread/start")).toBe(false);
    },
  );
});

// Codex reloads durable user layers while retaining the thread's session overrides.
function mergeNativeFixtureConfig(base: JsonObject, patch: JsonObject): JsonObject {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] =
      isJsonObject(current) && isJsonObject(value)
        ? mergeNativeFixtureConfig(current, value)
        : structuredClone(value);
  }
  return merged;
}
