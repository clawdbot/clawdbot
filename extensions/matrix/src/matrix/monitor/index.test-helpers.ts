import { vi } from "vitest";
import type { MatrixRoomInfo } from "./room-info.js";

export type DirectRoomTrackerOptions = {
  isExplicitlyConfiguredRoom?: (roomId: string) => boolean | Promise<boolean>;
  canPromoteRecentInvite?: (roomId: string) => boolean | Promise<boolean>;
  canPromoteUnmappedStrictRoom?: (roomId: string) => boolean | Promise<boolean>;
  shouldKeepLocallyPromotedDirectRoom?:
    | ((roomId: string) => boolean | undefined | Promise<boolean | undefined>)
    | undefined;
};

type MonitorRetirement = {
  closeTaskAdmission: () => void;
  detachListeners: () => void;
  waitForTasks: () => Promise<void>;
  cleanup: () => Promise<void> | void;
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
      listenerCount(event: string) {
        return listeners.get(event)?.size ?? 0;
      },
      removeAllListeners() {
        listeners.clear();
        return this;
      },
    };
  };
  const callOrder: string[] = [];
  const state = {
    leaseAbortController: new AbortController(),
    monitorRetirement: null as MonitorRetirement | null,
    monitorRetirementPromise: null as Promise<void> | null,
    startClientError: null as Error | null,
  };
  const accountConfig = {
    dm: {},
  };
  const inboundReplayClaim = {
    keys: ["test"] as const,
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
  const inboundDeduper = {
    claim: vi.fn(async () => ({ kind: "claimed" as const, handle: inboundReplayClaim })),
  };
  const createMatrixInboundEventDeduper = vi.fn(() => inboundDeduper);
  const client = Object.assign(createEmitter(), {
    id: "matrix-client",
    hasPersistedSyncState: vi.fn(() => false),
    drainPendingDecryptions: vi.fn(async () => undefined),
  });
  const createMatrixRoomMessageHandler = vi.fn(() => vi.fn());
  const createDirectRoomTracker = vi.fn(
    (_clientForTest: unknown, _opts?: DirectRoomTrackerOptions) => ({
      isDirectMessage: vi.fn(async () => false),
    }),
  );
  const getRoomInfo = vi.fn<
    (roomId: string, opts?: { includeAliases?: boolean }) => Promise<MatrixRoomInfo>
  >(async () => ({
    altAliases: [],
    nameResolved: true,
    aliasesResolved: true,
  }));
  const getMemberDisplayName = vi.fn(async () => "Bot");
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stopThreadBindingManager = vi.fn();
  const createThreadBindingManager = vi.fn(async () => {
    callOrder.push("create-manager");
    return {
      accountId: "default",
      stop: stopThreadBindingManager,
    };
  });
  const disposeAutoJoin = vi.fn(() => {
    callOrder.push("dispose-auto-join");
  });
  const disposeMonitorEvents = vi.fn(() => {
    callOrder.push("dispose-monitor-events");
  });
  const acquireSharedMatrixClientImpl = async (params: { startClient?: boolean }) => {
    if (params.startClient !== false) {
      throw new Error("Matrix monitor must acquire its lease before startup");
    }
    callOrder.push("prepare-client");
    return lease;
  };
  const registerMonitorRetirement = vi.fn((retirement: MonitorRetirement) => {
    state.monitorRetirement = retirement;
    state.monitorRetirementPromise = null;
  });
  const runRegisteredMonitorRetirement = (): Promise<void> => {
    if (state.monitorRetirementPromise) {
      return state.monitorRetirementPromise;
    }
    state.monitorRetirementPromise = (async () => {
      const retirement = state.monitorRetirement;
      retirement?.closeTaskAdmission();
      retirement?.detachListeners();
      await retirement?.waitForTasks();
      await retirement?.cleanup();
    })();
    return state.monitorRetirementPromise;
  };
  const finalReleaseImpl = async () => {
    await runRegisteredMonitorRetirement();
  };
  const resolveSharedMatrixClientImpl = async () => {
    if (!callOrder.includes("create-manager")) {
      throw new Error("Matrix client started before thread bindings were registered");
    }
    if (!state.monitorRetirement) {
      throw new Error("Matrix client started before monitor retirement was registered");
    }
    if (state.startClientError) {
      throw state.startClientError;
    }
    callOrder.push("start-client");
    return client;
  };
  const acquireSharedMatrixClient = vi.fn(acquireSharedMatrixClientImpl);
  const releaseSharedClientInstance = vi.fn(finalReleaseImpl);
  const lease = {
    get abortSignal() {
      return state.leaseAbortController.signal;
    },
    client,
    role: "monitor" as const,
    registerMonitorRetirement,
    start: vi.fn(resolveSharedMatrixClientImpl),
    release: releaseSharedClientInstance,
  };
  const registerMatrixAutoJoin = vi.fn(() => disposeAutoJoin);
  const registerMatrixMonitorEvents = vi.fn(
    (_params: {
      getHealthySyncSinceMs?: () => number | undefined;
      onRoomMessage: (roomId: string, event: unknown) => Promise<void>;
      runDetachedTask?: (label: string, task: () => Promise<void>) => Promise<void>;
    }) => {
      callOrder.push("register-events");
      return disposeMonitorEvents;
    },
  );
  const registerChannelRuntimeContext = vi.fn();
  const setMatrixRuntime = vi.fn();
  const backfillMatrixAuthDeviceIdAfterStartup = vi.fn(async () => undefined);
  const runMatrixStartupMaintenance = vi.fn<
    (params: { abortSignal?: AbortSignal }) => Promise<void>
  >(async () => undefined);
  const setStatus = vi.fn();
  return {
    accountConfig,
    acquireSharedMatrixClient,
    acquireSharedMatrixClientImpl,
    backfillMatrixAuthDeviceIdAfterStartup,
    callOrder,
    client,
    createDirectRoomTracker,
    createMatrixInboundEventDeduper,
    createMatrixRoomMessageHandler,
    createThreadBindingManager,
    disposeAutoJoin,
    disposeMonitorEvents,
    finalReleaseImpl,
    getMemberDisplayName,
    getRoomInfo,
    inboundDeduper,
    inboundReplayClaim,
    logger,
    registeredHealthySyncGetter: undefined as undefined | (() => number | undefined),
    registeredOnRoomMessage: null as null | ((roomId: string, event: unknown) => Promise<void>),
    registerChannelRuntimeContext,
    registerMatrixAutoJoin,
    registerMatrixMonitorEvents,
    registerMonitorRetirement,
    releaseSharedClientInstance,
    resolveSharedMatrixClient: lease.start,
    resolveSharedMatrixClientImpl,
    runMatrixStartupMaintenance,
    runRegisteredMonitorRetirement,
    setMatrixRuntime,
    setStatus,
    state,
    stopThreadBindingManager,
  };
});

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => ({
  registerChannelRuntimeContext: hoisted.registerChannelRuntimeContext,
}));

vi.mock("openclaw/plugin-sdk/runtime-group-policy", () => ({
  GROUP_POLICY_BLOCKED_LABEL: { room: "room" },
  resolveAllowlistProviderRuntimeGroupPolicy: () => ({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: () => "allowlist",
  warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/thread-bindings-runtime", () => ({
  resolveThreadBindingIdleTimeoutMsForChannel: () => 24 * 60 * 60 * 1000,
  resolveThreadBindingMaxAgeMsForChannel: () => 0,
}));

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

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: hoisted.acquireSharedMatrixClient,
  backfillMatrixAuthDeviceIdAfterStartup: hoisted.backfillMatrixAuthDeviceIdAfterStartup,
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
  createMatrixThreadBindingManager: hoisted.createThreadBindingManager,
}));

vi.mock("./allowlist.js", () => ({
  normalizeMatrixUserId: (value: string) => value,
}));

vi.mock("./auto-join.js", () => ({
  registerMatrixAutoJoin: hoisted.registerMatrixAutoJoin,
}));

vi.mock("./direct.js", () => ({
  createDirectRoomTracker: hoisted.createDirectRoomTracker,
}));

vi.mock("./events.js", () => ({
  registerMatrixMonitorEvents: hoisted.registerMatrixMonitorEvents.mockImplementation(
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
      return hoisted.disposeMonitorEvents;
    },
  ),
}));

vi.mock("./handler.js", () => ({
  createMatrixRoomMessageHandler: hoisted.createMatrixRoomMessageHandler,
}));

vi.mock("./inbound-dedupe.js", () => ({
  createMatrixInboundEventDeduper: hoisted.createMatrixInboundEventDeduper,
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

export function getMatrixMonitorIndexTestHarness() {
  return hoisted;
}
