import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MatrixConfig, MatrixStreamingMode } from "../../types.js";
import type { MatrixRoomInfo } from "./room-info.js";

type DirectRoomTrackerOptions = {
  canPromoteRecentInvite?: (roomId: string) => boolean | Promise<boolean>;
  canPromoteUnmappedStrictRoom?: (roomId: string) => boolean | Promise<boolean>;
  shouldKeepLocallyPromotedDirectRoom?:
    | ((roomId: string) => boolean | undefined | Promise<boolean | undefined>)
    | undefined;
};

const hoisted = vi.hoisted(() => {
  const createEmitter = () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
      on(event: string, listener: (...args: unknown[]) => void) {
        let bucket = listeners.get(event);
        if (!bucket) {
          bucket = new Set();
          listeners.set(event, bucket);
        }
        bucket.add(listener);
        return this;
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(listener);
        return this;
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
        return true;
      },
      removeAllListeners() {
        listeners.clear();
        return this;
      },
    };
  };
  const callOrder: string[] = [];
  const state = {
    startClientError: null as Error | null,
  };
  const accountConfig = {
    dm: {},
  };
  const inboundDeduper = {
    claimEvent: vi.fn(() => true),
    commitEvent: vi.fn(async () => undefined),
    releaseEvent: vi.fn(),
    flush: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const createMatrixInboundEventDeduper = vi.fn(async () => inboundDeduper);
  const client = Object.assign(createEmitter(), {
    id: "matrix-client",
    hasPersistedSyncState: vi.fn(() => false),
    stopSyncWithoutPersist: vi.fn(),
    drainPendingDecryptions: vi.fn(async () => undefined),
  });
  const createMatrixRoomMessageHandler = vi.fn(() => vi.fn());
  const createDirectRoomTracker = vi.fn((_client: unknown, _opts?: DirectRoomTrackerOptions) => ({
    isDirectMessage: vi.fn(async () => false),
  }));
  const getRoomInfo = vi.fn<
    (roomId: string, opts?: { includeAliases?: boolean }) => Promise<MatrixRoomInfo>
  >(async () => ({
    altAliases: [],
    nameResolved: true,
    aliasesResolved: true,
  }));
  const getMemberDisplayName = vi.fn(async () => "Bot");
  const resolveTextChunkLimit = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => number
  >(() => 4000);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stopThreadBindingManager = vi.fn();
  const releaseSharedClientInstance = vi.fn(async () => true);
  const resolveSharedMatrixClient = vi.fn(async (params: { startClient?: boolean }) => {
    if (params.startClient === false) {
      callOrder.push("prepare-client");
      return client;
    }
    if (!callOrder.includes("create-manager")) {
      throw new Error("Matrix client started before thread bindings were registered");
    }
    if (state.startClientError) {
      throw state.startClientError;
    }
    callOrder.push("start-client");
    return client;
  });
  const setActiveMatrixClient = vi.fn();
  const setMatrixRuntime = vi.fn();
  const backfillMatrixAuthDeviceIdAfterStartup = vi.fn(async () => undefined);
  const runMatrixStartupMaintenance = vi.fn<
    (params: { abortSignal?: AbortSignal }) => Promise<void>
  >(async () => undefined);
  const setStatus = vi.fn();
  return {
    backfillMatrixAuthDeviceIdAfterStartup,
    callOrder,
    accountConfig,
    client,
    createDirectRoomTracker,
    createMatrixInboundEventDeduper,
    createMatrixRoomMessageHandler,
    getMemberDisplayName,
    getRoomInfo,
    inboundDeduper,
    logger,
    registeredOnRoomMessage: null as null | ((roomId: string, event: unknown) => Promise<void>),
    releaseSharedClientInstance,
    resolveSharedMatrixClient,
    resolveTextChunkLimit,
    runMatrixStartupMaintenance,
    registeredHealthySyncGetter: undefined as undefined | (() => number | undefined),
    setActiveMatrixClient,
    setMatrixRuntime,
    setStatus,
    state,
    stopThreadBindingManager,
  };
});

vi.mock("../../runtime-api.js", () => {
  const normalizeAccountId = (value: string | null | undefined) => value?.trim() || "default";
  return {
    DEFAULT_ACCOUNT_ID: "default",
    GROUP_POLICY_BLOCKED_LABEL: {
      room: "room",
    },
    MarkdownConfigSchema: z.any().optional(),
    PAIRING_APPROVED_MESSAGE: "paired",
    ToolPolicySchema: z.any().optional(),
    addAllowlistUserEntriesFromConfigEntry: vi.fn(),
    buildChannelConfigSchema: (schema: unknown) => schema,
    buildChannelKeyCandidates: () => [],
    buildProbeChannelStatusSummary: (
      snapshot: Record<string, unknown>,
      extra?: Record<string, unknown>,
    ) => ({
      ...snapshot,
      ...extra,
    }),
    buildSecretInputSchema: () => z.string(),
    chunkTextForOutbound: vi.fn((text: string) => [text]),
    collectStatusIssuesFromLastError: () => [],
    createActionGate: () => () => true,
    createReplyPrefixOptions: () => ({}),
    createTypingCallbacks: () => ({}),
    formatDocsLink: (input: string) => input,
    formatZonedTimestamp: () => "2026-03-27T00:00:00.000Z",
    getAgentScopedMediaLocalRoots: () => [],
    getSessionBindingService: () => ({}),
    hasConfiguredSecretInput: (value: unknown) => Boolean(value),
    mergeAllowlist: ({ existing, additions }: { existing: string[]; additions: string[] }) => [
      ...existing,
      ...additions,
    ],
    normalizeAccountId,
    normalizeOptionalAccountId: normalizeAccountId,
    resolveThreadBindingIdleTimeoutMsForChannel: () => 24 * 60 * 60 * 1000,
    resolveThreadBindingMaxAgeMsForChannel: () => 0,
    resolveAllowlistProviderRuntimeGroupPolicy: () => ({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    }),
    resolveChannelEntryMatch: ({
      entries,
      keys,
      wildcardKey,
    }: {
      entries: Record<string, unknown>;
      keys: string[];
      wildcardKey: string;
    }) => {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(entries, key)) {
          return {
            entry: entries[key],
            key,
            wildcardEntry: Object.prototype.hasOwnProperty.call(entries, wildcardKey)
              ? entries[wildcardKey]
              : undefined,
            wildcardKey: Object.prototype.hasOwnProperty.call(entries, wildcardKey)
              ? wildcardKey
              : undefined,
          };
        }
      }
      return {
        entry: undefined,
        key: undefined,
        wildcardEntry: Object.prototype.hasOwnProperty.call(entries, wildcardKey)
          ? entries[wildcardKey]
          : undefined,
        wildcardKey: Object.prototype.hasOwnProperty.call(entries, wildcardKey)
          ? wildcardKey
          : undefined,
      };
    },
    resolveDefaultGroupPolicy: () => "allowlist",
    resolveOutboundSendDep: () => null,
    resolveThreadBindingFarewellText: () => null,
    resolveAckReaction: () => null,
    readJsonFileWithFallback: vi.fn(),
    readNumberParam: vi.fn(),
    readReactionParams: vi.fn(),
    readStringArrayParam: vi.fn(),
    readStringParam: vi.fn(),
    summarizeMapping: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
  };
});

vi.mock("../../resolve-targets.js", () => ({
  resolveMatrixTargets: vi.fn(async () => []),
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      current: () => ({
        channels: {
          matrix: hoisted.accountConfig,
        },
      }),
      replaceConfigFile: vi.fn(),
      mutateConfigFile: vi.fn(),
    },
    logging: {
      getChildLogger: () => hoisted.logger,
      shouldLogVerbose: () => false,
    },
    channel: {
      mentions: {
        buildMentionRegexes: () => [],
      },
      text: {
        resolveTextChunkLimit: (cfg: unknown, channel: unknown, accountId?: unknown) =>
          hoisted.resolveTextChunkLimit(cfg, channel, accountId),
      },
    },
    system: {
      formatNativeDependencyHint: () => "",
    },
    media: {
      loadWebMedia: vi.fn(),
    },
  }),
  setMatrixRuntime: hoisted.setMatrixRuntime,
}));

vi.mock("../accounts.js", async () => {
  const actual = await vi.importActual<typeof import("../accounts.js")>("../accounts.js");
  return {
    ...actual,
    resolveConfiguredMatrixBotUserIds: vi.fn(() => new Set<string>()),
    resolveMatrixAccount: () => ({
      accountId: "default",
      config: hoisted.accountConfig,
    }),
  };
});

vi.mock("../active-client.js", () => ({
  setActiveMatrixClient: hoisted.setActiveMatrixClient,
}));

vi.mock("../client.js", () => ({
  backfillMatrixAuthDeviceIdAfterStartup: hoisted.backfillMatrixAuthDeviceIdAfterStartup,
  isBunRuntime: () => false,
  resolveMatrixAuth: vi.fn(async () => ({
    accountId: "default",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    initialSyncLimit: 20,
    encryption: false,
  })),
  resolveMatrixAuthContext: vi.fn(() => ({
    accountId: "default",
  })),
  resolveSharedMatrixClient: hoisted.resolveSharedMatrixClient,
}));

vi.mock("../client/shared.js", () => ({
  releaseSharedClientInstance: hoisted.releaseSharedClientInstance,
}));

vi.mock("../config-update.js", () => ({
  updateMatrixAccountConfig: vi.fn((cfg: unknown) => cfg),
}));

vi.mock("../device-health.js", () => ({
  summarizeMatrixDeviceHealth: vi.fn(() => ({
    staleOpenClawDevices: [],
  })),
}));

vi.mock("../profile.js", () => ({
  syncMatrixOwnProfile: vi.fn(async () => ({
    displayNameUpdated: false,
    avatarUpdated: false,
    convertedAvatarFromHttp: false,
    resolvedAvatarUrl: undefined,
  })),
}));

vi.mock("../thread-bindings.js", () => ({
  createMatrixThreadBindingManager: vi.fn(async () => {
    hoisted.callOrder.push("create-manager");
    return {
      accountId: "default",
      stop: hoisted.stopThreadBindingManager,
    };
  }),
}));

vi.mock("./allowlist.js", () => ({
  normalizeMatrixUserId: (value: string) => value,
}));

vi.mock("./auto-join.js", () => ({
  registerMatrixAutoJoin: vi.fn(),
}));

vi.mock("./direct.js", () => ({
  createDirectRoomTracker: hoisted.createDirectRoomTracker,
}));

vi.mock("./events.js", () => ({
  registerMatrixMonitorEvents: vi.fn(
    (params: {
      getHealthySyncSinceMs?: () => number | undefined;
      onRoomMessage: (roomId: string, event: unknown) => Promise<void>;
      runDetachedTask?: (label: string, task: () => Promise<void>) => Promise<void>;
    }) => {
      hoisted.callOrder.push("register-events");
      hoisted.registeredHealthySyncGetter = params.getHealthySyncSinceMs;
      hoisted.registeredOnRoomMessage = (roomId: string, event: unknown) =>
        params.runDetachedTask
          ? params.runDetachedTask("test room message", async () => {
              await params.onRoomMessage(roomId, event);
            })
          : params.onRoomMessage(roomId, event);
    },
  ),
}));

vi.mock("./handler.js", () => ({
  createMatrixRoomMessageHandler: hoisted.createMatrixRoomMessageHandler,
}));

vi.mock("./inbound-dedupe.js", () => ({
  createMatrixInboundEventDeduper: hoisted.createMatrixInboundEventDeduper,
}));

vi.mock("./legacy-crypto-restore.js", () => ({
  maybeRestoreLegacyMatrixBackup: vi.fn(),
}));

vi.mock("./room-info.js", () => ({
  createMatrixRoomInfoResolver: vi.fn(() => ({
    getRoomInfo: hoisted.getRoomInfo,
    getMemberDisplayName: hoisted.getMemberDisplayName,
  })),
}));

vi.mock("./startup-verification.js", () => ({
  ensureMatrixStartupVerification: vi.fn(),
}));

vi.mock("./startup.js", () => ({
  runMatrixStartupMaintenance: hoisted.runMatrixStartupMaintenance,
}));

let matrixMonitorTesting: typeof import("./index.js").__testing;
let monitorMatrixProvider: typeof import("./index.js").monitorMatrixProvider;

describe("monitorMatrixProvider", () => {
  beforeAll(async () => {
    ({ __testing: matrixMonitorTesting, monitorMatrixProvider } = await import("./index.js"));
  });

  async function flushUntil(predicate: () => boolean, message: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (predicate()) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(message);
  }

  async function waitForCallOrderEntry(entry: string): Promise<void> {
    await flushUntil(
      () => hoisted.callOrder.includes(entry),
      `expected call order to include ${entry}`,
    );
  }

  async function startMonitorAndAbortAfterStartup(): Promise<void> {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    abortController.abort();
    await monitorPromise;
  }

  function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`expected mock call ${index}`);
    }
    return call[argIndex];
  }

  function lastMockCallArg(mock: { mock: { calls: unknown[][] } }, argIndex = 0): unknown {
    const call = mock.mock.calls.at(-1);
    if (!call) {
      throw new Error("expected mock call");
    }
    return call[argIndex];
  }

  function expectStatusCallFields(fields: Record<string, unknown>) {
    const matched = hoisted.setStatus.mock.calls.some(([status]) => {
      const record = status as Record<string, unknown>;
      return Object.entries(fields).every(([key, value]) => record[key] === value);
    });
    expect(matched).toBe(true);
  }

  function expectLastStatusFields(fields: Record<string, unknown>) {
    const status = lastMockCallArg(hoisted.setStatus) as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      expect(status[key]).toBe(value);
    }
  }

  beforeEach(() => {
    hoisted.callOrder.length = 0;
    hoisted.state.startClientError = null;
    hoisted.accountConfig.dm = {};
    delete (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms;
    hoisted.resolveTextChunkLimit.mockReset().mockReturnValue(4000);
    hoisted.releaseSharedClientInstance.mockReset().mockResolvedValue(true);
    hoisted.resolveSharedMatrixClient
      .mockReset()
      .mockImplementation(async (params: { startClient?: boolean }) => {
        if (params.startClient === false) {
          hoisted.callOrder.push("prepare-client");
          return hoisted.client;
        }
        if (!hoisted.callOrder.includes("create-manager")) {
          throw new Error("Matrix client started before thread bindings were registered");
        }
        if (hoisted.state.startClientError) {
          throw hoisted.state.startClientError;
        }
        hoisted.callOrder.push("start-client");
        return hoisted.client;
      });
    hoisted.createDirectRoomTracker.mockReset().mockReturnValue({
      isDirectMessage: vi.fn(async () => false),
    });
    hoisted.getRoomInfo.mockReset().mockResolvedValue({
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });
    hoisted.getMemberDisplayName.mockReset().mockResolvedValue("Bot");
    hoisted.registeredOnRoomMessage = null;
    hoisted.registeredHealthySyncGetter = undefined;
    hoisted.setActiveMatrixClient.mockReset();
    hoisted.stopThreadBindingManager.mockReset();
    hoisted.client.removeAllListeners();
    hoisted.client.hasPersistedSyncState.mockReset().mockReturnValue(false);
    hoisted.client.stopSyncWithoutPersist.mockReset();
    hoisted.client.drainPendingDecryptions.mockReset().mockResolvedValue(undefined);
    hoisted.inboundDeduper.claimEvent.mockReset().mockReturnValue(true);
    hoisted.inboundDeduper.commitEvent.mockReset().mockResolvedValue(undefined);
    hoisted.inboundDeduper.releaseEvent.mockReset();
    hoisted.inboundDeduper.flush.mockReset().mockResolvedValue(undefined);
    hoisted.inboundDeduper.stop.mockReset().mockResolvedValue(undefined);
    hoisted.createMatrixInboundEventDeduper.mockReset().mockResolvedValue(hoisted.inboundDeduper);
    hoisted.backfillMatrixAuthDeviceIdAfterStartup.mockReset().mockResolvedValue(undefined);
    hoisted.runMatrixStartupMaintenance.mockReset().mockResolvedValue(undefined);
    hoisted.createMatrixRoomMessageHandler.mockReset().mockReturnValue(vi.fn());
    hoisted.setStatus.mockReset();
    Object.values(hoisted.logger).forEach((mock) => mock.mockReset());
  });

  it.each([
    [undefined, "off", false],
    [false, "off", false],
    [true, "partial", true],
    ["off", "off", false],
    ["partial", "partial", true],
    ["quiet", "quiet", true],
    ["progress", "progress", true],
    [{}, "off", false],
    [{ mode: "off" }, "off", false],
    [{ mode: "partial" }, "partial", true],
    [{ mode: "quiet" }, "quiet", true],
    [{ mode: "progress" }, "progress", true],
    [{ mode: "partial", preview: { toolProgress: false } }, "partial", false],
    [{ mode: "quiet", preview: { toolProgress: false } }, "quiet", false],
    [{ mode: "partial", progress: { toolProgress: false } }, "partial", true],
    [{ mode: "quiet", progress: { toolProgress: false } }, "quiet", true],
    [{ mode: "progress", progress: { toolProgress: false } }, "progress", false],
    [
      { mode: "progress", progress: { toolProgress: false }, preview: { toolProgress: true } },
      "progress",
      false,
    ],
    [{ mode: "off", preview: { toolProgress: true } }, "off", false],
  ] satisfies Array<[MatrixConfig["streaming"], MatrixStreamingMode, boolean]>)(
    "resolves streaming=%j to mode=%s and toolProgress=%s",
    (streaming, expectedMode, expectedPreviewToolProgressEnabled) => {
      expect(matrixMonitorTesting.resolveMatrixStreamingMode(streaming)).toBe(expectedMode);
      expect(matrixMonitorTesting.resolveMatrixPreviewToolProgressEnabled(streaming)).toBe(
        expectedPreviewToolProgressEnabled,
      );
    },
  );

  it("returns immediately when the abort signal is already canceled", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await monitorMatrixProvider({ abortSignal: abortController.signal });

    expect(hoisted.callOrder).toStrictEqual([]);
    expect(hoisted.resolveTextChunkLimit).not.toHaveBeenCalled();
    expect(hoisted.createMatrixRoomMessageHandler).not.toHaveBeenCalled();
    expect(hoisted.setActiveMatrixClient).not.toHaveBeenCalled();
  });

  it("publishes disconnected startup status and connected sync status without failing the monitor", async () => {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({
      abortSignal: abortController.signal,
      setStatus: hoisted.setStatus,
    });

    await waitForCallOrderEntry("start-client");

    expectStatusCallFields({
      accountId: "default",
      baseUrl: "https://matrix.example.org",
      connected: false,
      healthState: "starting",
    });

    hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);

    expectStatusCallFields({
      accountId: "default",
      connected: true,
      healthState: "healthy",
      lastError: null,
    });

    abortController.abort();
    await expect(monitorPromise).resolves.toBeUndefined();
  });

  it("re-arms the healthy-sync milestone across reconnect transitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T16:21:00.000Z"));
    const abortController = new AbortController();
    try {
      const monitorPromise = monitorMatrixProvider({
        abortSignal: abortController.signal,
        setStatus: hoisted.setStatus,
      });

      await waitForCallOrderEntry("start-client");

      const getHealthySyncSinceMs = hoisted.registeredHealthySyncGetter;
      if (!getHealthySyncSinceMs) {
        throw new Error("expected healthy sync getter to be registered");
      }

      expect(getHealthySyncSinceMs()).toBeUndefined();

      hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);
      const firstHealthySyncSinceMs = Date.now();
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(3_000);
      hoisted.client.emit("sync.state", "CATCHUP", "SYNCING", undefined);
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(2_000);
      hoisted.client.emit("sync.state", "PREPARED", "CATCHUP", undefined);
      expect(getHealthySyncSinceMs()).toBe(firstHealthySyncSinceMs);

      await vi.advanceTimersByTimeAsync(5_000);
      hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("network flap"));
      expect(getHealthySyncSinceMs()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(7_000);
      hoisted.client.emit("sync.state", "SYNCING", "RECONNECTING", undefined);
      const rearmedHealthySyncSinceMs = Date.now();
      expect(getHealthySyncSinceMs()).toBe(rearmedHealthySyncSinceMs);

      abortController.abort();
      await expect(monitorPromise).resolves.toBeUndefined();

      hoisted.client.emit("sync.state", "RECONNECTING", "SYNCING", new Error("late noise"));
      expect(getHealthySyncSinceMs()).toBe(rearmedHealthySyncSinceMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains room-message handler rejections inside monitor task tracking", async () => {
    const abortController = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(async () => {
        throw new Error("room handler exploded");
      }),
    );

    process.on("unhandledRejection", onUnhandled);
    try {
      const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
      await waitForCallOrderEntry("start-client");

      const onRoomMessage = hoisted.registeredOnRoomMessage;
      if (!onRoomMessage) {
        throw new Error("expected room message handler to be registered");
      }

      await onRoomMessage("!room:example.org", { event_id: "$event" });
      await Promise.resolve();

      expect(unhandled).toHaveLength(0);
      expect(mockCallArg(hoisted.logger.warn, 0, 0)).toBe("matrix background task failed");
      const warningMetadata = mockCallArg(hoisted.logger.warn, 0, 1) as Record<string, unknown>;
      expect(warningMetadata.task).toBe("test room message");
      expect(warningMetadata.error).toBe("Error: room handler exploded");

      abortController.abort();
      await monitorPromise;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails the channel task when Matrix sync emits an unexpected fatal error", async () => {
    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({
      abortSignal: abortController.signal,
      setStatus: hoisted.setStatus,
    });

    await waitForCallOrderEntry("start-client");

    hoisted.client.emit("sync.unexpected_error", new Error("sync exploded"));

    await expect(monitorPromise).rejects.toThrow("sync exploded");
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(hoisted.client, "persist");
    expectStatusCallFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "sync exploded",
    });
  });

  it("marks early startup failures as error before the monitor loop starts", async () => {
    hoisted.resolveSharedMatrixClient.mockImplementation(
      async (params: { startClient?: boolean }) => {
        if (params.startClient === false) {
          throw new Error("prepare failed");
        }
        hoisted.callOrder.push("start-client");
        return hoisted.client;
      },
    );

    await expect(
      monitorMatrixProvider({
        setStatus: hoisted.setStatus,
      }),
    ).rejects.toThrow("prepare failed");

    expect(hoisted.releaseSharedClientInstance).not.toHaveBeenCalled();
    expectLastStatusFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "prepare failed",
    });
  });

  it("releases the prepared client when startup fails before later resources exist", async () => {
    hoisted.createMatrixInboundEventDeduper.mockRejectedValue(new Error("deduper failed"));

    await expect(
      monitorMatrixProvider({
        setStatus: hoisted.setStatus,
      }),
    ).rejects.toThrow("deduper failed");

    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(hoisted.client, "persist");
    expect(hoisted.inboundDeduper.stop).not.toHaveBeenCalled();
    expectLastStatusFields({
      accountId: "default",
      connected: false,
      healthState: "error",
      lastError: "deduper failed",
    });
  });

  it("aborts stalled startup promptly and releases the shared client without persist", async () => {
    const abortController = new AbortController();
    hoisted.resolveSharedMatrixClient.mockImplementation(
      async (params: { startClient?: boolean; abortSignal?: AbortSignal }) => {
        if (params.startClient === false) {
          hoisted.callOrder.push("prepare-client");
          return hoisted.client;
        }
        hoisted.callOrder.push("start-client");
        return await new Promise<typeof hoisted.client>((_resolve, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Matrix startup aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    );

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await waitForCallOrderEntry("start-client");

    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(hoisted.client, "stop");
    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
  });

  it("aborts during startup maintenance and releases the shared client without persist", async () => {
    const abortController = new AbortController();
    hoisted.runMatrixStartupMaintenance.mockImplementation(
      async (params: { abortSignal?: AbortSignal }) =>
        await new Promise<void>((_resolve, reject) => {
          params.abortSignal?.addEventListener(
            "abort",
            () => {
              const error = new Error("Matrix startup aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await flushUntil(
      () => hoisted.runMatrixStartupMaintenance.mock.calls.length === 1,
      "expected startup maintenance to run",
    );

    abortController.abort();

    await expect(monitorPromise).resolves.toBeUndefined();
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(hoisted.client, "stop");
    expect(hoisted.client.drainPendingDecryptions).not.toHaveBeenCalled();
  });

  it("registers Matrix thread bindings before starting the client", async () => {
    await startMonitorAndAbortAfterStartup();

    expect(hoisted.callOrder).toEqual([
      "prepare-client",
      "create-manager",
      "register-events",
      "start-client",
    ]);
    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
  });

  it("resolves text chunk limit for the effective Matrix account", async () => {
    await startMonitorAndAbortAfterStartup();

    const textLimitCall = hoisted.resolveTextChunkLimit.mock.calls[0];
    if (textLimitCall?.[0] === undefined) {
      throw new Error("Expected Matrix text chunk limit config argument");
    }
    expect(textLimitCall?.[1]).toBe("matrix");
    expect(textLimitCall?.[2]).toBe("default");
  });

  it("starts monitoring without waiting for best-effort deviceId backfill", async () => {
    hoisted.backfillMatrixAuthDeviceIdAfterStartup.mockImplementation(
      () => new Promise<undefined>(() => {}),
    );

    const abortController = new AbortController();
    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });

    await waitForCallOrderEntry("start-client");
    expect(hoisted.backfillMatrixAuthDeviceIdAfterStartup).toHaveBeenCalledTimes(1);
    const backfillParams = mockCallArg(hoisted.backfillMatrixAuthDeviceIdAfterStartup) as {
      abortSignal?: AbortSignal;
    };
    expect(backfillParams.abortSignal).toBe(abortController.signal);

    abortController.abort();
    await expect(monitorPromise).resolves.toBeUndefined();
  });

  it("cleans up thread bindings and shared clients when startup fails", async () => {
    hoisted.state.startClientError = new Error("start failed");

    await expect(monitorMatrixProvider()).rejects.toThrow("start failed");

    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(hoisted.client, "persist");
    expect(hoisted.setActiveMatrixClient).toHaveBeenNthCalledWith(1, hoisted.client, "default");
    expect(hoisted.setActiveMatrixClient).toHaveBeenNthCalledWith(2, null, "default");
  });

  it("disables cold-start backlog dropping only when sync state is cleanly persisted", async () => {
    hoisted.client.hasPersistedSyncState.mockReturnValue(true);
    await startMonitorAndAbortAfterStartup();

    const handlerParams = mockCallArg(hoisted.createMatrixRoomMessageHandler) as {
      dropPreStartupMessages?: unknown;
    };
    expect(handlerParams.dropPreStartupMessages).toBe(false);
  });

  it("stops sync, drains decryptions, then waits for in-flight handlers before persisting", async () => {
    const abortController = new AbortController();
    let resolveHandler: (() => void) | null = null;

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(() => {
        hoisted.callOrder.push("handler-start");
        return new Promise<void>((resolve) => {
          resolveHandler = () => {
            hoisted.callOrder.push("handler-done");
            resolve();
          };
        });
      }),
    );
    hoisted.client.stopSyncWithoutPersist.mockImplementation(() => {
      hoisted.callOrder.push("pause-client");
    });
    hoisted.client.drainPendingDecryptions.mockImplementation(async () => {
      hoisted.callOrder.push("drain-decrypts");
    });
    hoisted.stopThreadBindingManager.mockImplementation(() => {
      hoisted.callOrder.push("stop-manager");
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      hoisted.callOrder.push("release-client");
      return true;
    });
    hoisted.inboundDeduper.stop.mockImplementation(async () => {
      hoisted.callOrder.push("stop-deduper");
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await waitForCallOrderEntry("start-client");
    const onRoomMessage = hoisted.registeredOnRoomMessage;
    if (!onRoomMessage) {
      throw new Error("expected room message handler to be registered");
    }

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    abortController.abort();
    await waitForCallOrderEntry("pause-client");
    expect(hoisted.callOrder).not.toContain("stop-deduper");

    if (resolveHandler === null) {
      throw new Error("expected in-flight handler to be pending");
    }
    (resolveHandler as () => void)();
    await roomMessagePromise;
    await monitorPromise;

    expect(hoisted.callOrder.indexOf("pause-client")).toBeLessThan(
      hoisted.callOrder.indexOf("drain-decrypts"),
    );
    expect(hoisted.callOrder.indexOf("drain-decrypts")).toBeLessThan(
      hoisted.callOrder.indexOf("handler-done"),
    );
    expect(hoisted.callOrder.indexOf("handler-done")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-manager"),
    );
    expect(hoisted.callOrder.indexOf("stop-manager")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-deduper"),
    );
    expect(hoisted.callOrder.indexOf("stop-deduper")).toBeLessThan(
      hoisted.callOrder.indexOf("release-client"),
    );
  });

  it("wires recent-invite promotion to fail closed when room metadata is unresolved", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = hoisted.createDirectRoomTracker.mock.calls[0]?.[1];
    if (!trackerOpts?.canPromoteRecentInvite) {
      throw new Error("recent invite promotion callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: false,
      aliasesResolved: false,
    });

    await expect(trackerOpts.canPromoteRecentInvite("!room:example.org")).resolves.toBe(false);
  });

  it("wires recent-invite promotion to reject named rooms", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = hoisted.createDirectRoomTracker.mock.calls[0]?.[1];
    if (!trackerOpts?.canPromoteRecentInvite) {
      throw new Error("recent invite promotion callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      name: "Ops Room",
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });

    await expect(trackerOpts.canPromoteRecentInvite("!room:example.org")).resolves.toBe(false);
  });

  it("wires recent-invite promotion to reject wildcard-configured rooms", async () => {
    (hoisted.accountConfig as { rooms?: Record<string, unknown> }).rooms = {
      "*": { enabled: false },
    };

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = hoisted.createDirectRoomTracker.mock.calls[0]?.[1];
    if (!trackerOpts?.canPromoteRecentInvite) {
      throw new Error("recent invite promotion callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });

    await expect(trackerOpts.canPromoteRecentInvite("!room:example.org")).resolves.toBe(false);
  });

  it("does not wire unmapped strict room promotion for per-user DM scope", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = hoisted.createDirectRoomTracker.mock.calls[0]?.[1];

    expect(trackerOpts?.canPromoteUnmappedStrictRoom).toBeUndefined();
  });

  it("wires per-room unmapped strict room promotion through the room metadata gate", async () => {
    hoisted.accountConfig.dm = { sessionScope: "per-room" };

    await startMonitorAndAbortAfterStartup();

    const trackerOpts = hoisted.createDirectRoomTracker.mock.calls[0]?.[1];
    if (!trackerOpts?.canPromoteUnmappedStrictRoom) {
      throw new Error("per-room strict fallback callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });
    await expect(trackerOpts.canPromoteUnmappedStrictRoom("!dm:example.org")).resolves.toBe(true);

    hoisted.getRoomInfo.mockResolvedValueOnce({
      name: "Ops Room",
      altAliases: [],
      nameResolved: true,
      aliasesResolved: true,
    });
    await expect(trackerOpts.canPromoteUnmappedStrictRoom("!ops:example.org")).resolves.toBe(false);
  });

  it("treats unresolved room metadata as indeterminate for local promotion revalidation", async () => {
    await startMonitorAndAbortAfterStartup();

    const trackerOpts = hoisted.createDirectRoomTracker.mock.calls[0]?.[1];
    if (!trackerOpts?.shouldKeepLocallyPromotedDirectRoom) {
      throw new Error("local promotion revalidation callback was not wired");
    }

    hoisted.getRoomInfo.mockResolvedValueOnce({
      altAliases: [],
      nameResolved: false,
      aliasesResolved: false,
    });

    await expect(
      trackerOpts.shouldKeepLocallyPromotedDirectRoom("!room:example.org"),
    ).resolves.toBeUndefined();
  });
});
