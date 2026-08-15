import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import { registerChannelAdmissionEvidenceOwner } from "../channels/message-access/admission-evidence.js";
import { createChannelIngressDrain } from "../channels/message/ingress-drain.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import {
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesTarget,
} from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  createPluginBlobStore,
  type OpenBlobStoreOptions,
  type PluginBlobStore,
} from "../plugin-state/plugin-blob-store.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  type OpenKeyedStoreOptions,
  type PluginStateKeyedStore,
  type PluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
} from "../sessions/agent-harness-session-key.js";
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
  withPluginRuntimePluginIdScope,
  withPluginRuntimePluginScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS = new Set([
  "agent",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "message.action",
  "plugins.sessionAction",
  "send",
  "sessions.abort",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.branches.switch",
  "sessions.rewind",
  "sessions.fork",
  "sessions.create",
  "sessions.delete",
  "sessions.patchMany",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reset",
  "sessions.send",
  "sessions.steer",
  "wake",
]);

const PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS = new Set([
  "sessions.cleanup",
  "sessions.groups.delete",
  "sessions.groups.rename",
]);

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
      isLive: () =>
        ownsLiveRegistrySlot() && isPluginRecordLifecycleEpochActive(registry, record, epoch),
    });
    const disposeOwner = registerChannelAdmissionEvidenceOwner(owner);
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
    const resolveHarnessRegistration = (harnessId: unknown) => {
      const normalizedHarnessId = normalizeOptionalAgentRuntimeId(harnessId);
      return normalizedHarnessId
        ? registry.agentHarnesses.find(
            (entry) => normalizeOptionalAgentRuntimeId(entry.harness.id) === normalizedHarnessId,
          )
        : undefined;
    };
    const resolveHarnessRegistrationForSessionKey = (sessionKey: string) =>
      registry.agentHarnesses.find((entry) => {
        const rawHarnessId = normalizeOptionalString(entry.harness.id)?.toLowerCase();
        return (
          rawHarnessId === normalizeOptionalAgentRuntimeId(rawHarnessId) &&
          isAgentHarnessSessionKeyOwnedBy(sessionKey, rawHarnessId)
        );
      });
    const assertOwnedHarness = (harnessId: unknown, action: string): string => {
      const normalizedHarnessId = normalizeOptionalAgentRuntimeId(harnessId);
      if (!normalizedHarnessId) {
        throw new Error(
          `Plugin "${pluginId}" must provide a registered agent harness id to ${action}.`,
        );
      }
      const registration = resolveHarnessRegistration(normalizedHarnessId);
      if (!registration) {
        throw new Error(
          `Plugin "${pluginId}" must register agent harness "${normalizedHarnessId}" before it can ${action}.`,
        );
      }
      if (registration.pluginId !== pluginId) {
        throw new Error(
          `Agent harness "${normalizedHarnessId}" is owned by plugin "${registration.pluginId}", not "${pluginId}".`,
        );
      }
      return normalizedHarnessId;
    };
    const assertReservedSessionKeyOwned = (sessionKey: unknown, action: string): void => {
      const normalizedSessionKey = normalizeOptionalString(sessionKey);
      if (!normalizedSessionKey || !isAgentHarnessSessionKey(normalizedSessionKey)) {
        return;
      }
      const registration = resolveHarnessRegistrationForSessionKey(normalizedSessionKey);
      if (!registration) {
        throw new Error(
          `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" because its harness is not registered.`,
        );
      }
      if (registration.pluginId !== pluginId) {
        throw new Error(
          `Plugin "${pluginId}" cannot ${action} reserved agent harness session "${normalizedSessionKey}" owned by plugin "${registration.pluginId}".`,
        );
      }
    };
    const resolveLockedSessionHarnessRegistration = (
      sessionKey: string,
      entry: SessionEntry,
      action: string,
    ) => {
      if (entry.modelSelectionLocked !== true) {
        return undefined;
      }
      const harnessId = normalizeOptionalAgentRuntimeId(entry.agentHarnessId);
      if (!harnessId) {
        const pluginOwnerId = normalizeOptionalString(entry.pluginOwnerId);
        if (pluginOwnerId) {
          return { ownerPluginId: pluginOwnerId };
        }
        throw new Error(
          `Plugin "${pluginId}" must provide a registered agent harness id to ${action} locked sessions.`,
        );
      }
      const registration = resolveHarnessRegistration(harnessId);
      if (!registration) {
        throw new Error(
          `Plugin "${pluginId}" must register agent harness "${harnessId}" before it can ${action} locked sessions.`,
        );
      }
      if (
        isAgentHarnessSessionKey(sessionKey) &&
        !isAgentHarnessSessionKeyOwnedBy(sessionKey, harnessId)
      ) {
        throw new Error(
          `Locked session "${sessionKey}" belongs to agent harness "${harnessId}", which does not match its reserved session key.`,
        );
      }
      return { ownerPluginId: registration.pluginId, harnessId, registration };
    };
    const assertLockedSessionEntryOwned = (
      sessionKey: string,
      entry: SessionEntry,
      action: string,
    ): void => {
      const resolved = resolveLockedSessionHarnessRegistration(sessionKey, entry, action);
      if (!resolved) {
        return;
      }
      if (resolved.ownerPluginId !== pluginId) {
        throw new Error(
          `Locked session "${sessionKey}" is owned by plugin "${resolved.ownerPluginId}", not "${pluginId}".`,
        );
      }
    };
    const assertSessionEntryOwned = (params: {
      action: string;
      entry?: SessionEntry;
      sessionKey: string;
    }): void => {
      if (params.entry) {
        // Before harness locking shipped, plugins could create ordinary sessions
        // whose user-chosen key happened to start with `harness:`.
        assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
        return;
      }
      assertReservedSessionKeyOwned(params.sessionKey, params.action);
    };
    const assertStoredSessionEntryOwned = (params: {
      action: string;
      agentId?: string;
      env?: NodeJS.ProcessEnv;
      sessionKey: string;
      storePath?: string;
    }): SessionEntry | undefined => {
      const entry = registryParams.runtime.agent.session.getSessionEntry({
        sessionKey: params.sessionKey,
        readConsistency: "latest",
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(params.env !== undefined ? { env: params.env } : {}),
        ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
      });
      assertSessionEntryOwned({ action: params.action, entry, sessionKey: params.sessionKey });
      return entry;
    };
    const resolveStoredSessionExecutionOwner = (params: {
      action: string;
      agentId?: string;
      sessionKey: string;
      storePath?: string;
    }): string | undefined => {
      const entry = registryParams.runtime.agent.session.getSessionEntry({
        sessionKey: params.sessionKey,
        readConsistency: "latest",
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
      });
      const locked = entry
        ? resolveLockedSessionHarnessRegistration(params.sessionKey, entry, params.action)
        : undefined;
      if (!entry || !locked || locked.ownerPluginId === pluginId) {
        assertSessionEntryOwned({ action: params.action, entry, sessionKey: params.sessionKey });
        return undefined;
      }
      const registration = "registration" in locked ? locked.registration : undefined;
      if (!registration) {
        throw new Error(
          `Locked session "${params.sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
        );
      }
      if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
        assertLockedSessionEntryOwned(params.sessionKey, entry, params.action);
      }
      return locked.ownerPluginId;
    };
    const assertSessionIdentitiesOwned = (params: {
      action: string;
      agentId?: unknown;
      sessionFiles?: unknown[];
      sessionIds?: unknown[];
      sessionKeys?: unknown[];
      storePath?: unknown;
    }): void => {
      const agentId = normalizeOptionalString(params.agentId);
      const storePath = normalizeOptionalString(params.storePath);
      const sessionKeys = new Set<string>();
      for (const value of params.sessionKeys ?? []) {
        const sessionKey = normalizeOptionalString(value);
        if (sessionKey) {
          sessionKeys.add(sessionKey);
        }
      }
      for (const sessionKey of sessionKeys) {
        assertStoredSessionEntryOwned({
          action: params.action,
          sessionKey,
          ...(agentId ? { agentId } : {}),
          ...(storePath ? { storePath } : {}),
        });
      }

      const sessionIds = new Set<string>();
      for (const value of params.sessionIds ?? []) {
        const sessionId = normalizeOptionalString(value);
        if (sessionId) {
          sessionIds.add(sessionId);
        }
      }
      const sessionFiles = new Set<string>();
      for (const value of params.sessionFiles ?? []) {
        const sessionFile = normalizeOptionalString(value);
        if (sessionFile) {
          sessionFiles.add(sessionFile);
        }
      }
      if (sessionIds.size === 0 && sessionFiles.size === 0) {
        return;
      }
      const entries = registryParams.runtime.agent.session.listSessionEntries({
        ...(agentId ? { agentId } : {}),
        ...(storePath ? { storePath } : {}),
        readOnly: true,
      });
      for (const { sessionKey, entry } of entries) {
        if (sessionIds.has(entry.sessionId)) {
          assertSessionEntryOwned({ action: params.action, entry, sessionKey });
        }
      }
      for (const sessionFile of sessionFiles) {
        const sessionKeyMatches = entries.filter(({ sessionKey }) => sessionKey === sessionFile);
        if (sessionKeyMatches.length > 0) {
          for (const match of sessionKeyMatches) {
            assertSessionEntryOwned({
              action: params.action,
              entry: match.entry,
              sessionKey: match.sessionKey,
            });
          }
          const matchedSessionIds = new Set(
            sessionKeyMatches
              .map(({ entry }) => normalizeOptionalString(entry.sessionId))
              .filter((sessionId): sessionId is string => Boolean(sessionId)),
          );
          for (const match of entries) {
            const matchSessionId = normalizeOptionalString(match.entry.sessionId);
            if (matchSessionId && matchedSessionIds.has(matchSessionId)) {
              assertSessionEntryOwned({
                action: params.action,
                entry: match.entry,
                sessionKey: match.sessionKey,
              });
            }
          }
          continue;
        }
        const marker = parseSqliteSessionFileMarker(sessionFile);
        if (!marker) {
          throw new Error("Plugin session ownership checks require a SQLite transcript marker.");
        }
        const markerEntries = registryParams.runtime.agent.session.listSessionEntries({
          agentId: marker.agentId,
          storePath: marker.storePath,
          readOnly: true,
        });
        const matches = markerEntries.filter(({ entry }) => entry.sessionId === marker.sessionId);
        if (matches.length === 0) {
          throw new Error(`Plugin session ownership target not found: ${marker.sessionId}`);
        }
        for (const match of matches) {
          assertSessionEntryOwned({
            action: params.action,
            entry: match.entry,
            sessionKey: match.sessionKey,
          });
        }
      }
    };
    const resolveRunSessionExecutionOwner = (
      params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0],
    ): string | undefined => {
      const target = params.sessionTarget;
      const targetSessionKey = normalizeOptionalString(target?.sessionKey);
      const directSessionKey = normalizeOptionalString(params.sessionKey);
      if (targetSessionKey && directSessionKey && targetSessionKey !== directSessionKey) {
        throw new Error("Delegated agent execution requires one exact session key.");
      }
      const sessionKey = targetSessionKey ?? directSessionKey;
      const storePath = normalizeOptionalString(target?.storePath);
      const agentId = normalizeOptionalString(target?.agentId ?? params.agentId);
      const sessionKeyAgentId = parseAgentSessionKey(sessionKey)?.agentId;
      const normalizedAgentId = agentId ? normalizeAgentId(agentId) : undefined;
      if (sessionKeyAgentId && normalizedAgentId && normalizedAgentId !== sessionKeyAgentId) {
        throw new Error(
          `Plugin session ownership agent "${normalizedAgentId}" does not match session key agent "${sessionKeyAgentId}".`,
        );
      }
      const ownershipAgentId = sessionKeyAgentId ?? normalizedAgentId;
      // Embedded runs accept one exact key. Carry its resolved store into the
      // keyless ID/file scan so incognito ownership stays in the process-held DB.
      const ownershipStorePath =
        sessionKey && sessionKeyAgentId
          ? resolveSessionStorePathForScope({
              agentId: sessionKeyAgentId,
              sessionKey,
              ...(storePath ? { storePath } : {}),
            })
          : storePath;
      const entry = sessionKey
        ? registryParams.runtime.agent.session.getSessionEntry({
            sessionKey,
            readConsistency: "latest",
            ...(agentId ? { agentId } : {}),
            ...(storePath ? { storePath } : {}),
          })
        : undefined;
      const targetSessionId = normalizeOptionalString(target?.sessionId);
      const targetAgentId = normalizeOptionalString(target?.agentId);
      const directSessionId = normalizeOptionalString(params.sessionId);
      const directAgentId = normalizeOptionalString(params.agentId);
      const sessionFile = normalizeOptionalString(params.sessionFile);
      if (target) {
        const legacySessionIdentityMatches =
          Boolean(sessionFile) &&
          Boolean(agentId) &&
          Boolean(storePath) &&
          Boolean(entry?.sessionId) &&
          sqliteSessionFileMarkerMatchesTarget(sessionFile, {
            agentId: agentId!,
            sessionId: entry!.sessionId,
            storePath: storePath!,
          });
        const targetIdentityMatches =
          targetSessionKey === sessionKey &&
          Boolean(storePath) &&
          Boolean(entry) &&
          targetSessionId === entry?.sessionId &&
          directSessionId === entry?.sessionId &&
          targetAgentId === directAgentId &&
          (!sessionFile || sessionFile === sessionKey || legacySessionIdentityMatches);
        if (!targetIdentityMatches) {
          throw new Error(
            `Plugin "${pluginId}" may execute a persisted session only with its exact session target identity.`,
          );
        }
      }
      const locked =
        sessionKey && entry
          ? resolveLockedSessionHarnessRegistration(sessionKey, entry, "run")
          : undefined;
      const ownerPluginId = locked?.ownerPluginId;
      if (locked && entry && sessionKey && ownerPluginId !== pluginId) {
        const registration = "registration" in locked ? locked.registration : undefined;
        if (!registration) {
          throw new Error(
            `Locked session "${sessionKey}" is owned by plugin "${locked.ownerPluginId}", not "${pluginId}".`,
          );
        }
        if (!registration.harness.delegatedExecutionPluginIds?.includes(pluginId)) {
          assertLockedSessionEntryOwned(sessionKey, entry, "run");
        }
        const requestedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
        const requestedRuntimeOverride = normalizeOptionalAgentRuntimeId(
          params.agentHarnessRuntimeOverride,
        );
        const identityMatches =
          Boolean(target) &&
          targetSessionId === entry.sessionId &&
          directSessionId === entry.sessionId;
        const harnessMatches =
          params.modelSelectionLocked === true &&
          requestedHarnessId === locked.harnessId &&
          requestedRuntimeOverride === locked.harnessId;
        if (!identityMatches || !harnessMatches) {
          throw new Error(
            `Plugin "${pluginId}" may execute locked session "${sessionKey}" only with its exact persisted identity and harness.`,
          );
        }
        return ownerPluginId;
      }
      assertSessionIdentitiesOwned({
        action: "run",
        agentId: ownershipAgentId,
        sessionFiles: [params.sessionFile],
        sessionIds: [target?.sessionId ?? params.sessionId],
        sessionKeys: [target?.sessionKey ?? params.sessionKey],
        storePath: ownershipStorePath,
      });
      return undefined;
    };
    const assertGatewaySessionRequestOwned = (
      method: string,
      params: Record<string, unknown> | undefined,
    ): void => {
      if (PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS.has(method)) {
        throw new Error(`Plugin "${pluginId}" cannot request global session mutation "${method}".`);
      }
      if (!PLUGIN_GATEWAY_SESSION_MUTATION_METHODS.has(method)) {
        return;
      }
      const request = params ?? {};
      if (method === "sessions.patchMany" && Array.isArray(request.targets)) {
        for (const target of request.targets) {
          if (!isRecord(target)) {
            continue;
          }
          assertSessionIdentitiesOwned({
            action: `request gateway method "${method}" for`,
            agentId: target.agentId,
            sessionKeys: [target.key],
          });
        }
        return;
      }
      const sessionKeys = [request.sessionKey, request.key, request.parentSessionKey];
      const sessionIds = [request.sessionId];
      assertSessionIdentitiesOwned({
        action: `request gateway method "${method}" for`,
        agentId: request.agentId,
        sessionIds,
        sessionKeys,
      });
      if (
        method === "sessions.abort" &&
        !sessionKeys.some((value) => normalizeOptionalString(value)) &&
        !sessionIds.some((value) => normalizeOptionalString(value))
      ) {
        throw new Error(
          `Plugin "${pluginId}" must provide a session key when requesting gateway method "${method}".`,
        );
      }
    };
    const assertStoreEntryOwned = (params: {
      action: string;
      before?: SessionEntry;
      entry: SessionEntry;
      sessionKey: string;
    }): void => {
      if (params.entry.modelSelectionLocked === true) {
        assertLockedSessionEntryOwned(params.sessionKey, params.entry, params.action);
        return;
      }
      if (params.before?.modelSelectionLocked === true) {
        assertLockedSessionEntryOwned(params.sessionKey, params.before, params.action);
        return;
      }
      if (isAgentHarnessSessionKey(params.sessionKey) && !params.before) {
        assertReservedSessionKeyOwned(params.sessionKey, params.action);
      }
    };
    let scopedAgentRuntime: PluginRuntime["agent"] | undefined;
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
          const assertPluginStateAllowed = (
            methodName:
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
              // Name the denied plugin and its origin: several plugins share this gate, and a
              // bare capability name cannot tell an operator which install needs replacing.
              throw new Error(
                `${methodName} is only available for trusted plugins in this release. Plugin "${pluginId}" loaded with origin "${record?.origin ?? "unknown"}"; reinstall it from its official npm package or ClawHub listing to enable trusted plugin state.`,
              );
            }
          };
          return {
            ...baseState,
            openBlobStore: <TMetadata>(
              options: OpenBlobStoreOptions,
            ): PluginBlobStore<TMetadata> => {
              assertPluginStateAllowed("openBlobStore");
              return createPluginBlobStore<TMetadata>(pluginId, options);
            },
            openKeyedStore: <T>(options: OpenKeyedStoreOptions): PluginStateKeyedStore<T> => {
              assertPluginStateAllowed("openKeyedStore");
              return createPluginStateKeyedStore<T>(pluginId, options);
            },
            openSyncKeyedStore: <T>(
              options: OpenKeyedStoreOptions,
            ): PluginStateSyncKeyedStore<T> => {
              assertPluginStateAllowed("openSyncKeyedStore");
              return createPluginStateSyncKeyedStore<T>(pluginId, options);
            },
            openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
            ) => {
              assertPluginStateAllowed("openChannelIngressQueue");
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
              assertPluginStateAllowed("openChannelIngressDrain");
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
            request: async (method, params, options) =>
              await runWithPluginScope(async () => {
                assertGatewaySessionRequestOwned(method, params);
                return await gateway.request(method, params, options);
              }),
          } satisfies PluginRuntime["gateway"];
        }
        if (prop === "nodes") {
          const nodes = getRuntimeProperty();
          return {
            list: (params) => runWithPluginScope(() => nodes.list(params)),
            invoke: (params) => runWithPluginScope(() => nodes.invoke(params)),
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
            createSessionEntry: async (params) =>
              await runWithPluginScope(async () => {
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
              }),
            patchSessionEntry: async (params) =>
              await runWithPluginScope(async () => {
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
              }),
            upsertSessionEntry: async (params) =>
              await runWithPluginScope(async () => {
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
              }),
            runWithWorkAdmission: async (params, run) =>
              await runWithPluginScope(async () => {
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
              }),
            updateSessionStoreEntry: async (params) =>
              await runWithPluginScope(async () => {
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
              }),
          } satisfies PluginRuntime["agent"]["session"];
          const runEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (params) => {
            const runParams = { ...params, skillWorkshopCollectionReconcile: undefined };
            return await runWithPluginScope(async () => {
              const ownerPluginId = resolveRunSessionExecutionOwner(runParams);
              if (ownerPluginId) {
                return await resolvePluginRuntime(ownerPluginId).agent.runEmbeddedAgent(runParams);
              }
              // The public runtime adapter owns admission preparation. Passing
              // host authority through this plugin wrapper is rejected by design.
              return await agent.runEmbeddedAgent(runParams);
            });
          };
          const scopedAgent = Object.create(
            Object.getPrototypeOf(agent),
            Object.getOwnPropertyDescriptors(agent),
          ) as PluginRuntime["agent"];
          Object.defineProperties(scopedAgent, {
            runEmbeddedAgent: {
              configurable: true,
              enumerable: true,
              value: runEmbeddedAgent,
            },
            runEmbeddedPiAgent: {
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
          run: async (params) =>
            await withPluginRuntimePluginIdScope(pluginId, async () => {
              assertSessionIdentitiesOwned({
                action: "run",
                sessionKeys: [params.sessionKey],
              });
              return await subagent.run(params);
            }),
          waitForRun: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.waitForRun(params)),
          getSessionMessages: (params) =>
            withPluginRuntimePluginIdScope(pluginId, () => subagent.getSessionMessages(params)),
          deleteSession: async (params) =>
            await withPluginRuntimePluginIdScope(pluginId, async () => {
              assertStoredSessionEntryOwned({ action: "delete", sessionKey: params.sessionKey });
              await subagent.deleteSession(params);
            }),
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
