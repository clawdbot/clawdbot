import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { registerChannelIngressHostOwner } from "../channels/message-access/ingress-host-owner.js";
import { createChannelIngressDrain } from "../channels/message/ingress-drain.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  createPluginBlobStore,
  type OpenBlobStoreOptions,
} from "../plugin-state/plugin-blob-store.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { formatPluginTrustRefusal } from "./plugin-trust.js";
import {
  activatePluginRecordLifecycleEpoch,
  isPluginRecordLifecycleEpochActive,
  isPluginRegistryActivated,
  isPluginRegistryRetired,
  revokePluginRecordLifecycleEpoch,
} from "./registry-lifecycle.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import {
  getGatewayContextResolver,
  withPluginRuntimePluginIdScope,
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

export function createPluginRuntimeResolver(state: PluginRegistryState) {
  const { registry, registryParams } = state;
  const pluginRuntimeById = new Map<string, PluginRuntime>();
  const pluginRuntimeRecordById = new Map<string, PluginRecord>();
  const activePluginRuntimeRecords = new WeakSet<PluginRecord>();
  const recordChannelRuntime = new WeakMap<PluginRecord, PluginRuntime["channel"]>();
  const registeredChannelRuntime = new WeakMap<PluginRecord, PluginRuntime["channel"]>();
  const registeredRuntimeRecordById = new Map<string, PluginRecord>();
  const registeredAdmissionOwnerByRecord = new WeakMap<
    PluginRecord,
    { isLive: () => boolean; dispose: () => void }
  >();

  const addPluginRuntimeResolutionContext = (params: {
    error: unknown;
    pluginId: string;
    prop: PropertyKey;
  }): never => {
    const { error, pluginId, prop } = params;
    if (
      error instanceof Error &&
      error.message.startsWith("Unable to resolve plugin runtime module") &&
      !error.message.includes("pluginRuntimeContext=")
    ) {
      const record =
        pluginRuntimeRecordById.get(pluginId) ??
        registry.plugins.find((entry) => entry.id === pluginId);
      const propName =
        typeof prop === "symbol" ? (prop.description ?? prop.toString()) : String(prop);
      error.message = [
        error.message,
        `pluginRuntimeContext=pluginId:${pluginId}`,
        `property:${propName}`,
        ...(record?.source ? [`source:${record.source}`] : []),
      ].join("; ");
    }
    throw error;
  };

  const resolveRecordChannelRuntime = (
    record: PluginRecord,
    requireCurrentRuntimeRecord: boolean,
  ): PluginRuntime["channel"] => {
    const cache = requireCurrentRuntimeRecord ? recordChannelRuntime : registeredChannelRuntime;
    const cached = cache.get(record);
    const cachedOwner = registeredAdmissionOwnerByRecord.get(record);
    if (cached && (requireCurrentRuntimeRecord || cachedOwner?.isLive() === true)) {
      return cached;
    }
    if (!requireCurrentRuntimeRecord && cachedOwner) {
      cachedOwner.dispose();
      registeredAdmissionOwnerByRecord.delete(record);
    }
    const channel = (() => {
      try {
        return Reflect.get(
          registryParams.runtime,
          "channel",
          registryParams.runtime,
        ) as PluginRuntime["channel"];
      } catch (error) {
        return addPluginRuntimeResolutionContext({
          error,
          pluginId: record.id,
          prop: "channel",
        });
      }
    })();
    if (record.origin !== "bundled" || requireCurrentRuntimeRecord) {
      cache.set(record, channel);
      return channel;
    }
    const ownsLiveRegistrySlot = () =>
      activePluginRuntimeRecords.has(record) &&
      registeredRuntimeRecordById.get(record.id) === record &&
      isPluginRegistryActivated(registry) &&
      !isPluginRegistryRetired(registry) &&
      registry.plugins.some((candidate) => candidate === record && candidate.status === "loaded");
    const previousRecord = registeredRuntimeRecordById.get(record.id);
    if (previousRecord && previousRecord !== record) {
      registeredAdmissionOwnerByRecord.get(previousRecord)?.dispose();
      registeredAdmissionOwnerByRecord.delete(previousRecord);
      revokePluginRecordLifecycleEpoch(registry, previousRecord);
    }
    registeredRuntimeRecordById.set(record.id, record);
    const epoch = activatePluginRecordLifecycleEpoch(registry, record);
    if (!epoch) {
      cache.set(record, channel);
      return channel;
    }
    const owner = Object.freeze({
      channelId: record.id,
      record,
      epoch,
      resolveGatewayContext: getGatewayContextResolver(registryParams.runtime.subagent),
      isLive: () =>
        ownsLiveRegistrySlot() && isPluginRecordLifecycleEpochActive(registry, record, epoch),
    });
    const disposeOwner = registerChannelIngressHostOwner(owner);
    registeredAdmissionOwnerByRecord.set(record, {
      isLive: owner.isLive,
      dispose: disposeOwner,
    });
    const buildHostContext = createHostChannelInboundEventContextBuilder(
      channel.inbound.buildContext,
      owner,
    );
    const buildContext = ((
      params: Parameters<PluginRuntime["channel"]["inbound"]["buildContext"]>[0],
    ) => {
      // Audit provenance is passive: stale closures still build the message context,
      // but only the exact live bundled owner may attach participant evidence.
      return buildHostContext(params as never);
    }) as unknown as PluginRuntime["channel"]["inbound"]["buildContext"];
    const scoped = {
      ...channel,
      inbound: { ...channel.inbound, buildContext },
    } satisfies PluginRuntime["channel"];
    cache.set(record, scoped);
    return scoped;
  };

  const resolvePluginRuntime = (pluginId: string): PluginRuntime => {
    const cached = pluginRuntimeById.get(pluginId);
    if (cached) {
      return cached;
    }
    // Cache checks, not config or row facts; actions resolve ownership after the import settles.
    const loadSessionOwnership = createLazyRuntimeSurface(
      () => import("./registry-runtime-session-ownership.js"),
      (module) => module.createPluginSessionOwnership(state, pluginId),
    );
    let scopedAgentRuntime: PluginRuntime["agent"] | undefined;
    const assertTrustedPluginRuntime = (
      methodName:
        | "dispatchHookAgentTurn"
        | "openBlobStore"
        | "openKeyedStore"
        | "openSyncKeyedStore"
        | "openChannelIngressQueue"
        | "openChannelIngressDrain",
    ) => {
      const record =
        pluginRuntimeRecordById.get(pluginId) ??
        registry.plugins.find((entry) => entry.id === pluginId);
      if (record?.origin !== "bundled" && record?.trustedOfficialInstall !== true) {
        throw new Error(
          formatPluginTrustRefusal({
            methodName,
            pluginId,
            origin: record?.origin,
            trust: record?.trust,
          }),
        );
      }
    };
    const runtime = new Proxy(registryParams.runtime, {
      get(target, prop, receiver) {
        const runWithPluginScope = <T>(run: () => T): T => {
          const record =
            pluginRuntimeRecordById.get(pluginId) ??
            registry.plugins.find((entry) => entry.id === pluginId);
          return record?.source
            ? withPluginRuntimePluginScope(
                {
                  pluginId,
                  pluginSource: record.source,
                  pluginOrigin: record.origin,
                  pluginTrustedOfficialInstall: record.trustedOfficialInstall,
                },
                run,
              )
            : withPluginRuntimePluginScope({ pluginId }, run);
        };
        const getRuntimeProperty = () => {
          try {
            return Reflect.get(target, prop, receiver);
          } catch (error) {
            return addPluginRuntimeResolutionContext({ error, pluginId, prop });
          }
        };
        if (prop === "state") {
          const baseState = getRuntimeProperty();
          return {
            ...baseState,
            openBlobStore: <TMetadata>(options: OpenBlobStoreOptions) => {
              assertTrustedPluginRuntime("openBlobStore");
              return createPluginBlobStore<TMetadata>(pluginId, options);
            },
            openKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
              assertTrustedPluginRuntime("openKeyedStore");
              return createPluginStateKeyedStore<T>(pluginId, options);
            },
            openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
              assertTrustedPluginRuntime("openSyncKeyedStore");
              return createPluginStateSyncKeyedStore<T>(pluginId, options);
            },
            openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
            ) => {
              assertTrustedPluginRuntime("openChannelIngressQueue");
              const stateDir = options?.stateDir ?? baseState.resolveStateDir();
              return createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
                ...options,
                channelId: pluginId,
                stateDir,
              });
            },
            openChannelIngressDrain: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options: Omit<
                Parameters<
                  typeof createChannelIngressDrain<TPayload, TMetadata, TCompletedMetadata>
                >[0],
                "queue"
              > & {
                queue?: ReturnType<
                  typeof createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>
                >;
                accountId?: string;
                stateDir?: string;
              },
            ) => {
              assertTrustedPluginRuntime("openChannelIngressDrain");
              const stateDir = options.stateDir ?? baseState.resolveStateDir();
              const queue =
                options.queue ??
                createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
                  channelId: pluginId,
                  accountId: options.accountId,
                  stateDir,
                });
              const {
                queue: _queue,
                accountId: _accountId,
                stateDir: _stateDir,
                ...drainOptions
              } = options;
              return createChannelIngressDrain<TPayload, TMetadata, TCompletedMetadata>({
                ...drainOptions,
                queue,
              });
            },
          } satisfies PluginRuntime["state"];
        }
        if (prop === "config") {
          const config: PluginRuntime["config"] = getRuntimeProperty();
          return {
            ...config,
            current: () => runWithPluginScope(() => config.current()),
            mutateConfigFile: (params) => runWithPluginScope(() => config.mutateConfigFile(params)),
            replaceConfigFile: (params) =>
              runWithPluginScope(() => config.replaceConfigFile(params)),
          } satisfies PluginRuntime["config"];
        }
        if (prop === "channel") {
          const ownerRecord = pluginRuntimeRecordById.get(pluginId);
          if (!ownerRecord) {
            return getRuntimeProperty();
          }
          return resolveRecordChannelRuntime(ownerRecord, true);
        }
        if (prop === "llm") {
          const llm = getRuntimeProperty();
          return {
            acquireLocalService: (...args) =>
              withPluginRuntimePluginIdScope(pluginId, () => llm.acquireLocalService(...args)),
            complete: (params) =>
              withPluginRuntimePluginIdScope(pluginId, () => llm.complete(params)),
          } satisfies PluginRuntime["llm"];
        }
        if (prop === "gateway") {
          const gateway = getRuntimeProperty();
          return {
            isAvailable: () => runWithPluginScope(() => gateway.isAvailable()),
            request: async (method, params, options) => {
              const { assertGatewaySessionRequestOwned } = await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                assertGatewaySessionRequestOwned(method, params);
                return await gateway.request(method, params, options);
              });
            },
          } satisfies PluginRuntime["gateway"];
        }
        if (prop === "hooks") {
          const hooks: PluginRuntime["hooks"] = getRuntimeProperty();
          return {
            dispatchHookAgentTurn: async (params) => {
              assertTrustedPluginRuntime("dispatchHookAgentTurn");
              return await runWithPluginScope(() => hooks.dispatchHookAgentTurn(params));
            },
          } satisfies PluginRuntime["hooks"];
        }
        if (prop === "nodes") {
          const nodes = getRuntimeProperty();
          return {
            list: (params) => runWithPluginScope(() => nodes.list(params)),
            invoke: (params) => runWithPluginScope(() => nodes.invoke(params)),
            openDuplex: (params) =>
              withPluginRuntimeRegistryScope(registry, () =>
                runWithPluginScope(() => nodes.openDuplex(params)),
              ),
          } satisfies PluginRuntime["nodes"];
        }
        if (prop === "agent") {
          if (scopedAgentRuntime) {
            return scopedAgentRuntime;
          }
          const agent: PluginRuntime["agent"] = getRuntimeProperty();
          const session = agent.session;
          const scopedSession = {
            resolveStorePath: session.resolveStorePath,
            getSessionEntry: session.getSessionEntry,
            listSessionEntries: session.listSessionEntries,
            createSessionEntry: async (params) => {
              const { assertOwnedHarness, assertReservedSessionKeyOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const runtimeOwnerCount = [
                  "agentHarnessId" in params.initialEntry,
                  "cliBackendId" in params.initialEntry,
                  "acpSessionBinding" in params.initialEntry,
                ].filter(Boolean).length;
                if (runtimeOwnerCount !== 1) {
                  throw new Error(
                    `Plugin "${pluginId}" session creation requires exactly one runtime owner.`,
                  );
                }
                if ("agentHarnessId" in params.initialEntry) {
                  // Session ownership follows the registered harness capability,
                  // independently of whether the caller chooses its reserved namespace.
                  assertOwnedHarness(params.initialEntry.agentHarnessId, "create its sessions");
                  assertReservedSessionKeyOwned(params.key, "create");
                  return await session.createSessionEntry(params);
                }
                if ("acpSessionBinding" in params.initialEntry) {
                  if (!params.key.startsWith(`plugin:${pluginId}:`)) {
                    throw new Error(
                      `Plugin "${pluginId}" session keys must start with "plugin:${pluginId}:".`,
                    );
                  }
                  return await session.createSessionEntry({
                    ...params,
                    initialEntry: { ...params.initialEntry, pluginOwnerId: pluginId },
                  });
                }
                const cliInitial = params.initialEntry;
                const backend = registry.cliBackends.find(
                  (entry) => entry.backend.id === cliInitial.cliBackendId,
                );
                if (!backend || backend.pluginId !== pluginId) {
                  throw new Error(
                    `Plugin "${pluginId}" must own CLI backend "${cliInitial.cliBackendId}" to create its sessions.`,
                  );
                }
                // Plugin-owned sessions stay inside a namespace that no other plugin can claim.
                if (!params.key.startsWith(`plugin:${pluginId}:`)) {
                  throw new Error(
                    `Plugin "${pluginId}" session keys must start with "plugin:${pluginId}:".`,
                  );
                }
                return await session.createSessionEntry({
                  ...params,
                  initialEntry: { ...cliInitial, pluginOwnerId: pluginId },
                });
              });
            },
            patchSessionEntry: async (params) => {
              const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                assertStoredSessionEntryOwned({
                  action: "patch",
                  sessionKey: params.sessionKey,
                  ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                  ...(params.env !== undefined ? { env: params.env } : {}),
                  ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
                });
                return await session.patchSessionEntry({
                  ...params,
                  update: async (entry, context) => {
                    const patch = await params.update(entry, context);
                    if (!patch) {
                      return patch;
                    }
                    const next = params.replaceEntry
                      ? (patch as SessionEntry)
                      : ({ ...entry, ...patch } satisfies SessionEntry);
                    assertStoreEntryOwned({
                      action: "patch",
                      before: context.existingEntry ?? entry,
                      entry: next,
                      sessionKey: params.sessionKey,
                    });
                    return patch;
                  },
                });
              });
            },
            upsertSessionEntry: async (params) => {
              const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const before = assertStoredSessionEntryOwned({
                  action: "upsert",
                  sessionKey: params.sessionKey,
                  ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
                  ...(params.env !== undefined ? { env: params.env } : {}),
                  ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
                });
                assertStoreEntryOwned({
                  action: "upsert",
                  before,
                  entry: params.entry,
                  sessionKey: params.sessionKey,
                });
                await session.upsertSessionEntry(params);
              });
            },
            runWithWorkAdmission: async (params, run) => {
              const { resolveStoredSessionExecutionOwner } = await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                const resolveCurrentExecutionOwner = () =>
                  resolveStoredSessionExecutionOwner({
                    action: "admit work on",
                    sessionKey: params.sessionKey,
                    storePath: params.storePath,
                  });
                const ownerPluginId = resolveCurrentExecutionOwner();
                const admissionSession = ownerPluginId
                  ? resolvePluginRuntime(ownerPluginId).agent.session
                  : session;
                return await admissionSession.runWithWorkAdmission(params, async (signal) => {
                  // Admission can wait behind another run that changes ownership.
                  // Recheck delegation inside the admitted callback before plugin work starts.
                  if (resolveCurrentExecutionOwner() !== ownerPluginId) {
                    throw new Error(
                      `Session "${params.sessionKey}" changed execution ownership while starting work.`,
                    );
                  }
                  // The owner supplies the admission primitive, but the caller's
                  // callback must not inherit the owner's plugin identity.
                  return await runWithPluginScope(() => run(signal));
                });
              });
            },
            updateSessionStoreEntry: async (params) => {
              const { assertStoredSessionEntryOwned, assertStoreEntryOwned } =
                await loadSessionOwnership();
              return await runWithPluginScope(async () => {
                assertStoredSessionEntryOwned({
                  action: "update",
                  sessionKey: params.sessionKey,
                  storePath: params.storePath,
                });
                return await session.updateSessionStoreEntry({
                  ...params,
                  update: async (entry) => {
                    const patch = await params.update(entry);
                    if (!patch) {
                      return patch;
                    }
                    assertStoreEntryOwned({
                      action: "update",
                      before: entry,
                      entry: { ...entry, ...patch },
                      sessionKey: params.sessionKey,
                    });
                    return patch;
                  },
                });
              });
            },
          } satisfies PluginRuntime["agent"]["session"];
          const runEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (params) => {
            const runParams = { ...params };
            const { prepareRunSessionExecution } = await loadSessionOwnership();
            return await runWithPluginScope(async () => {
              const { ownerPluginId, agentHarnessRuntimeOverride } =
                prepareRunSessionExecution(runParams);
              if (agentHarnessRuntimeOverride !== undefined) {
                runParams.agentHarnessRuntimeOverride = agentHarnessRuntimeOverride;
              }
              if (ownerPluginId) {
                return await resolvePluginRuntime(ownerPluginId).agent.runEmbeddedAgent(runParams);
              }
              // The public runtime adapter owns admission preparation. Passing
              // host authority through this plugin wrapper is rejected by design.
              return await agent.runEmbeddedAgent(runParams);
            });
          };
          const channelOwnerRecord = pluginRuntimeRecordById.get(pluginId);
          const runCommandFromIngress: PluginRuntime["agent"]["runCommandFromIngress"] = async (
            params,
            commandRuntime,
          ) => {
            const { senderIsOwner: claimedOwner, messageChannel, ...remainingParams } = params;
            const senderIsOwner = claimedOwner === true;
            // Validate and dispatch the same host-owned values; never re-read plugin-owned authority.
            const ingressParams = { ...remainingParams, senderIsOwner, messageChannel };
            if (
              !channelOwnerRecord ||
              // Community channels may admit guests; trusted provenance is required only for owner elevation.
              (senderIsOwner &&
                channelOwnerRecord.origin !== "bundled" &&
                channelOwnerRecord.trustedOfficialInstall !== true) ||
              pluginRuntimeRecordById.get(pluginId) !== channelOwnerRecord ||
              !activePluginRuntimeRecords.has(channelOwnerRecord) ||
              isPluginRegistryRetired(registry) ||
              !registry.plugins.some(
                (record) => record === channelOwnerRecord && record.status === "loaded",
              ) ||
              !registry.channels.some(
                (channel) => channel.pluginId === pluginId && channel.plugin.id === messageChannel,
              )
            ) {
              throw new Error(
                `Plugin "${pluginId}" cannot admit authenticated owner authority for channel "${messageChannel ?? "unknown"}".`,
              );
            }
            return await runWithPluginScope(() =>
              agent.runCommandFromIngress(ingressParams, commandRuntime),
            );
          };
          const scopedAgent = Object.create(
            Object.getPrototypeOf(agent),
            Object.getOwnPropertyDescriptors(agent),
          ) as PluginRuntime["agent"];
          Object.defineProperties(scopedAgent, {
            runCommandFromIngress: {
              configurable: true,
              enumerable: true,
              value: runCommandFromIngress,
            },
            runEmbeddedAgent: {
              configurable: true,
              enumerable: true,
              value: runEmbeddedAgent,
            },
            session: {
              configurable: true,
              enumerable: true,
              value: scopedSession,
            },
          });
          scopedAgentRuntime = scopedAgent;
          return scopedAgentRuntime;
        }
        if (prop !== "subagent") {
          return getRuntimeProperty();
        }
        const subagent = getRuntimeProperty();
        return {
          complete: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.complete(params)),
          run: async (params) => {
            const { assertSessionIdentitiesOwned } = await loadSessionOwnership();
            return await withPluginRuntimePluginIdScope(pluginId, async () => {
              assertSessionIdentitiesOwned({
                action: "run",
                sessionKeys: [params.sessionKey],
              });
              return await subagent.run(params);
            });
          },
          waitForRun: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.waitForRun(params)),
          getSessionMessages: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSessionMessages(params)),
          deleteSession: async (params) => {
            const { assertStoredSessionEntryOwned } = await loadSessionOwnership();
            return await withPluginRuntimePluginIdScope(pluginId, async () => {
              assertStoredSessionEntryOwned({ action: "delete", sessionKey: params.sessionKey });
              await subagent.deleteSession(params);
            });
          },
        } satisfies PluginRuntime["subagent"];
      },
    });
    pluginRuntimeById.set(pluginId, runtime);
    return runtime;
  };

  return {
    resolvePluginRuntime,
    resolveRegisteredChannelRuntime: (record: PluginRecord) =>
      resolveRecordChannelRuntime(record, false),
    setPluginRuntimeRecord: (record: PluginRecord) => {
      pluginRuntimeRecordById.set(record.id, record);
      activePluginRuntimeRecords.add(record);
    },
    revokePluginRuntimeRecord: (pluginId: string, record?: PluginRecord) => {
      const ownedRecord = record ?? pluginRuntimeRecordById.get(pluginId);
      if (ownedRecord) {
        activePluginRuntimeRecords.delete(ownedRecord);
        revokePluginRecordLifecycleEpoch(registry, ownedRecord);
        registeredAdmissionOwnerByRecord.get(ownedRecord)?.dispose();
        registeredAdmissionOwnerByRecord.delete(ownedRecord);
        if (registeredRuntimeRecordById.get(pluginId) === ownedRecord) {
          registeredRuntimeRecordById.delete(pluginId);
        }
      }
    },
  };
}

export type PluginRuntimeResolver = ReturnType<typeof createPluginRuntimeResolver>;
