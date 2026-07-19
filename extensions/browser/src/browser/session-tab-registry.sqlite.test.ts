// Browser tests cover durable session tab cleanup through the real plugin-state store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { BrowserTabOwnership } from "./client.types.js";
import { browserSessionTabStorageKey } from "./session-tab-store.js";

const cdpMocks = vi.hoisted(() => ({
  closeTrackedCdpTarget: vi.fn<() => Promise<CloseTrackedCdpTargetResult>>(),
}));

vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  closeTrackedCdpTarget: cdpMocks.closeTrackedCdpTarget,
}));

type TabIdentity = {
  sessionKey?: string;
  targetId?: string;
  baseUrl?: string;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

type DurableRecord = {
  version: 1;
  sessionKey: string;
  nativeTargetId: string;
  profile: string;
  profileAliases?: string[];
  profileFingerprint: string;
  browserInstanceFingerprint: string;
  interactionTargetKind: "native" | "opaque";
  trackedAt: number;
  lastUsedAt: number;
  cleanupRequestedAt?: number;
  cleanupAttemptToken?: string;
  cleanupKind?: "lifecycle" | "sweep";
};

type DurableTab = DurableRecord & { kind: "durable"; storageKey: string };
type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
}) => Promise<void>;

type CleanupParams = {
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: { shouldClose: () => boolean },
  ) => Promise<CloseTrackedCdpTargetResult>;
  onWarn?: (message: string) => void;
};

type RegistryModule = {
  trackSessionBrowserTab(params: TabIdentity & { now?: number }): void;
  touchSessionBrowserTab(params: TabIdentity & { now?: number }): void;
  untrackSessionBrowserTab(params: TabIdentity): void;
  closeTrackedBrowserTabsForSessions(
    params: CleanupParams & { sessionKeys: Array<string | undefined> },
  ): Promise<number>;
  sweepTrackedBrowserTabs(
    params: CleanupParams & {
      now?: number;
      idleMs?: number;
      maxTabsPerSession?: number;
      sessionFilter?: (sessionKey: string) => boolean;
    },
  ): Promise<number>;
};

const ownership = (
  nativeTargetId: string,
  profileFingerprint = "test-profile-fingerprint",
  browserInstanceFingerprint = "test-browser-instance-fingerprint",
): BrowserTabOwnership => ({
  status: "durable",
  nativeTargetId,
  profileFingerprint,
  browserInstanceFingerprint,
});

function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of [
    "openclaw.browser.session-tabs.volatile",
    "openclaw.browser.session-tabs.active-durable-keys",
    "openclaw.browser.session-tabs.cold-native-activity",
    "openclaw.browser.session-tabs.interaction-storage-keys",
    "openclaw.browser.session-tabs.exact-interaction-storage-keys",
    "openclaw.browser.session-tabs.volatile-aliases",
    "openclaw.browser.session-tabs.exact-volatile-aliases",
  ]) {
    delete state[Symbol.for(name)];
  }
}

function setBrowserProfileConfig(): void {
  const config = {
    browser: {
      defaultProfile: "remote",
      profiles: {
        remote: {
          driver: "existing-session",
          cdpUrl: "http://127.0.0.1:9222",
          color: "#123456",
        },
      },
    },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(config, config);
}

describe("durable session tab registry", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let freshModuleCounter = 0;

  function openStore(): PluginStateSyncKeyedStore<unknown> {
    return createPluginStateSyncKeyedStoreForTests("browser", {
      namespace: "browser.session-tabs",
      maxEntries: 5_000,
      overflowPolicy: "reject-new",
    });
  }

  function installRuntime(
    openSyncKeyedStore: (options: OpenKeyedStoreOptions) => PluginStateSyncKeyedStore<unknown> = (
      options,
    ) => createPluginStateSyncKeyedStoreForTests("browser", options),
  ): void {
    registerBrowserPlugin(
      createTestPluginApi({
        id: "browser",
        name: "Browser",
        source: "test",
        rootDir: "/plugins/browser",
        config: {},
        runtime: {
          state: {
            openKeyedStore: (options: OpenKeyedStoreOptions) =>
              createPluginStateKeyedStoreForTests("browser", options),
            openSyncKeyedStore,
          },
        } as unknown as OpenClawPluginApi["runtime"],
      }),
    );
  }

  async function freshRegistry(label: string): Promise<RegistryModule> {
    freshModuleCounter += 1;
    return await importFreshModule<RegistryModule>(
      import.meta.url,
      `./session-tab-registry.js?durable=${label}-${freshModuleCounter}`,
    );
  }

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-browser-tabs-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetPluginStateStoreForTests();
    installRuntime();
    openStore().clear();
    cdpMocks.closeTrackedCdpTarget.mockReset().mockResolvedValue({ status: "closed" });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("closes a durable tab after the SQLite database and module are reopened", async () => {
    setBrowserProfileConfig();
    const first = await freshRegistry("first");
    first.trackSessionBrowserTab({
      sessionKey: "Agent:Main:Main",
      targetId: "interaction-target",
      profile: "Remote",
      ownership: ownership("NATIVE-1"),
      now: 1_000,
    });
    expect(openStore().entries()).toHaveLength(1);

    resetPluginStateStoreForTests();
    installRuntime();
    clearProcessLocalTabState();
    const restarted = await freshRegistry("restarted");

    await expect(
      restarted.closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"] }),
    ).resolves.toBe(1);
    expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith({
      profileName: "remote",
      cdpUrl: "http://127.0.0.1:9222",
      nativeTargetId: "NATIVE-1",
      timeoutMs: expect.any(Number),
      ssrfPolicy: expect.any(Object),
      expectedProfileFingerprint: "test-profile-fingerprint",
      expectedBrowserInstanceFingerprint: "test-browser-instance-fingerprint",
      shouldClose: expect.any(Function),
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("keeps browser-bridge tabs volatile and closable by a duplicate bundle", async () => {
    const first = await freshRegistry("bridge-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "bridge-tab",
      baseUrl: "http://127.0.0.1:9999",
      profile: "remote",
      ownership: ownership("REMOTE-NATIVE"),
    });
    expect(openStore().entries()).toEqual([]);

    const duplicate = await freshRegistry("bridge-duplicate");
    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(
      duplicate.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "bridge-tab",
      baseUrl: "http://127.0.0.1:9999",
      profile: "remote",
    });
  });

  it("keeps browser-bridge aliases isolated from host-browser durable records", async () => {
    const registry = await freshRegistry("bridge-alias-isolation");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      profile: "remote",
      ownership: ownership("NATIVE-HOST"),
      now: 1_000,
    });
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      baseUrl: "http://127.0.0.1:9999",
      profile: "remote",
      ownership: ownership("NATIVE-BRIDGE"),
      now: 2_000,
    });

    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      baseUrl: "http://127.0.0.1:9999",
      profile: "remote",
      now: 3_000,
    });
    registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      baseUrl: "http://127.0.0.1:9999",
      profile: "remote",
    });

    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-HOST",
      lastUsedAt: 1_000,
    });
  });

  it("prefers an exact durable target over a volatile alias while untracking", async () => {
    const registry = await freshRegistry("durable-exact-over-volatile-alias");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "DURABLE-NATIVE",
      profile: "remote",
      ownership: ownership("DURABLE-NATIVE"),
      now: 1_000,
    });

    clearProcessLocalTabState();
    installRuntime();
    const restarted = await freshRegistry("durable-exact-over-volatile-alias-restarted");
    restarted.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "VOLATILE-RAW",
      profile: "remote",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      aliases: ["DURABLE-NATIVE"],
      now: 2_000,
    });

    restarted.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "DURABLE-NATIVE",
      profile: "remote",
    });
    expect(openStore().entries()).toEqual([]);

    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(
      restarted.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "VOLATILE-RAW",
      baseUrl: undefined,
      profile: "remote",
    });
  });

  it("prefers an exact volatile target over a durable alias while untracking", async () => {
    const registry = await freshRegistry("volatile-exact-over-durable-alias");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "DURABLE-OPAQUE",
      profile: "remote",
      ownership: ownership("DURABLE-NATIVE"),
      aliases: ["VOLATILE-RAW"],
      now: 1_000,
    });
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "VOLATILE-RAW",
      profile: "remote",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      now: 2_000,
    });

    registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "VOLATILE-RAW",
      profile: "remote",
    });
    expect(openStore().entries()).toHaveLength(1);

    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(closeDurableTab).toHaveBeenCalledWith(
      expect.objectContaining({ nativeTargetId: "DURABLE-NATIVE" }),
      expect.objectContaining({ shouldClose: expect.any(Function) }),
    );
  });

  it("keeps durable ownership when volatile exact profile aliases are ambiguous", async () => {
    const registry = await freshRegistry("cross-kind-exact-ambiguity");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "SHARED-NATIVE",
      profile: "requested-profile",
      ownership: ownership("SHARED-NATIVE"),
      now: 1_000,
    });
    for (const profile of ["resolved-a", "resolved-b"]) {
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "SHARED-NATIVE",
        profile,
        profileAliases: ["requested-profile"],
        ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
        now: 2_000,
      });
    }

    registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "SHARED-NATIVE",
      profile: "requested-profile",
    });
    expect(openStore().entries()).toHaveLength(1);

    const closeTab = vi.fn<CloseTab>(async () => {});
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
        closeDurableTab,
      }),
    ).resolves.toBe(3);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeDurableTab).toHaveBeenCalledOnce();
  });

  it("keys durable records by ownership and resolves same-process aliases", async () => {
    const registry = await freshRegistry("aliases");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-1",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
      aliases: ["opaque-1", "t1", "docs"],
      now: 1_000,
    });
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-2",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
      aliases: ["opaque-2", "t2"],
      now: 2_000,
    });

    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-A",
      trackedAt: 1_000,
      lastUsedAt: 2_000,
    });
    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "t2",
      profile: "remote",
      now: 3_000,
    });
    expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 3_000 });
    registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-2",
      profile: "remote",
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("resolves durable activity through the originally requested profile", async () => {
    const registry = await freshRegistry("resolved-profile-alias");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-resolved",
      profile: "resolved-profile",
      profileAliases: ["requested-profile"],
      ownership: ownership("NATIVE-RESOLVED"),
      aliases: ["opaque-resolved", "docs"],
      now: 1_000,
    });
    expect(openStore().entries()[0]?.value).toMatchObject({
      profileAliases: ["requested-profile"],
    });

    clearProcessLocalTabState();
    installRuntime();
    const restarted = await freshRegistry("resolved-profile-alias-restarted");

    restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-RESOLVED",
      profile: "requested-profile",
      now: 9_000,
    });
    expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 9_000 });

    restarted.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-RESOLVED",
      profile: "requested-profile",
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("fails closed when resolved-profile aliases collide", async () => {
    const registry = await freshRegistry("resolved-profile-collision");
    for (const [profile, nativeTargetId] of [
      ["resolved-a", "browser-a"],
      ["resolved-b", "browser-b"],
    ] as const) {
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "NATIVE-SHARED",
        profile,
        profileAliases: ["requested-profile"],
        ownership: ownership("NATIVE-SHARED", `profile-${profile}`, nativeTargetId),
        now: 1_000,
      });
    }

    clearProcessLocalTabState();
    installRuntime();
    const restarted = await freshRegistry("resolved-profile-collision-restarted");

    restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-SHARED",
      profile: "requested-profile",
      now: 9_000,
    });
    expect(
      openStore()
        .entries()
        .map((entry) => entry.value),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browserInstanceFingerprint: "browser-a", lastUsedAt: 1_000 }),
        expect.objectContaining({ browserInstanceFingerprint: "browser-b", lastUsedAt: 1_000 }),
      ]),
    );

    restarted.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-SHARED",
      profile: "resolved-b",
    });
    restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-SHARED",
      profile: "requested-profile",
      now: 10_000,
    });
    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      browserInstanceFingerprint: "browser-a",
      lastUsedAt: 10_000,
    });
  });

  it("keeps identical native ids isolated across browser instances", async () => {
    const first = await freshRegistry("browser-instance-collision-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:collision",
      targetId: "NATIVE-SHARED",
      profile: "remote",
      ownership: ownership("NATIVE-SHARED", "profile-a", "browser-a"),
      now: 1_000,
    });
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:collision",
      targetId: "NATIVE-SHARED",
      profile: "remote",
      ownership: ownership("NATIVE-SHARED", "profile-b", "browser-b"),
      now: 2_000,
    });
    expect(openStore().entries()).toHaveLength(2);

    clearProcessLocalTabState();
    const restarted = await freshRegistry("browser-instance-collision-restarted");
    restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:collision",
      targetId: "NATIVE-SHARED",
      profile: "remote",
      now: 10_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeDurableTab }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();
    expect(
      openStore()
        .entries()
        .map((entry) => (entry.value as DurableRecord).lastUsedAt)
        .toSorted((left, right) => left - right),
    ).toEqual([1_000, 2_000]);
  });

  it("fails closed at capacity without evicting an existing ownership record", async () => {
    const registry = await freshRegistry("capacity");
    for (let index = 0; index < 5_000; index += 1) {
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: `tab-${index}`,
        profile: "remote",
        ownership: ownership(`NATIVE-${index}`),
        now: index + 1,
      });
    }
    expect(() =>
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "tab-5000",
        profile: "remote",
        ownership: ownership("NATIVE-5000"),
        now: 5_001,
      }),
    ).toThrow(/5000-row limit/);

    const records = openStore()
      .entries()
      .map((entry) => entry.value as DurableRecord);
    expect(records).toHaveLength(5_000);
    expect(records.some((record) => record.nativeTargetId === "NATIVE-0")).toBe(true);
    expect(records.some((record) => record.nativeTargetId === "NATIVE-4999")).toBe(true);
    expect(records.some((record) => record.nativeTargetId === "NATIVE-5000")).toBe(false);
  });

  it("keeps transient close failures and retires terminal outcomes", async () => {
    const registry = await freshRegistry("outcomes");
    for (const target of ["closed", "missing", "mismatch", "unavailable"]) {
      registry.trackSessionBrowserTab({
        sessionKey: `agent:main:${target}`,
        targetId: target,
        profile: "remote",
        ownership: ownership(`NATIVE-${target}`),
      });
    }
    const outcomeByTarget: Record<string, CloseTrackedCdpTargetResult> = {
      "NATIVE-closed": { status: "closed" },
      "NATIVE-missing": { status: "missing" },
      "NATIVE-mismatch": { status: "ownership-mismatch" },
      "NATIVE-unavailable": { status: "unavailable", reason: "target-lookup-failed" },
    };
    const closeDurableTab = vi.fn(async (tab: DurableTab) => outcomeByTarget[tab.nativeTargetId]!);

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:closed", "agent:main:missing", "agent:main:mismatch"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:unavailable"],
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(
      openStore()
        .entries()
        .map((entry) => (entry.value as DurableRecord).nativeTargetId),
    ).toEqual(["NATIVE-unavailable"]);
  });

  it("keeps a touched durable tab out of an idle sweep but lifecycle cleanup still closes it", async () => {
    const registry = await freshRegistry("touch");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque",
      profile: "remote",
      ownership: ownership("NATIVE-TOUCH"),
      aliases: ["opaque", "docs"],
      now: 1_000,
    });
    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "remote",
      now: 9_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);

    await expect(
      registry.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 5_000,
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
  });

  it("cancels an in-flight sweep when the tab becomes active before close", async () => {
    const registry = await freshRegistry("sweep-touch-race");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque",
      profile: "remote",
      ownership: ownership("NATIVE-RACE"),
      aliases: ["opaque", "docs"],
      now: 1_000,
    });
    let markStarted: (() => void) | undefined;
    let releaseClose: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeDurableTab = vi.fn(
      async (_tab: DurableTab, options: { shouldClose: () => boolean }) => {
        markStarted?.();
        await closeGate;
        return options.shouldClose()
          ? ({ status: "closed" } as const)
          : ({ status: "cancelled" } as const);
      },
    );

    const sweep = registry.sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      closeDurableTab,
    });
    await started;
    registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "remote",
      now: 11_000,
    });
    releaseClose?.();

    await expect(sweep).resolves.toBe(0);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-RACE",
      lastUsedAt: 11_000,
    });
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
  });

  it("does not delete a replacement row after an obsolete close completes", async () => {
    const registry = await freshRegistry("replacement-race");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque",
      profile: "remote",
      ownership: ownership("NATIVE-REPLACED"),
      now: 1_000,
    });
    const closeDurableTab = vi.fn(async () => {
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "opaque",
        profile: "remote",
        ownership: ownership("NATIVE-REPLACED"),
        now: 2_000,
      });
      return { status: "closed" } as const;
    });

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-REPLACED",
      lastUsedAt: 2_000,
    });
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
  });

  it("retries pending lifecycle cleanup even when normal sweeps filter the session", async () => {
    const registry = await freshRegistry("lifecycle-retry");
    registry.trackSessionBrowserTab({
      sessionKey: "agent:subagent:ended",
      targetId: "opaque",
      profile: "remote",
      ownership: ownership("NATIVE-PENDING"),
      now: 1_000,
    });
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:subagent:ended"],
        closeDurableTab: async () => ({
          status: "unavailable",
          reason: "target-lookup-failed",
        }),
      }),
    ).resolves.toBe(0);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-PENDING",
      cleanupKind: "lifecycle",
      cleanupAttemptToken: expect.any(String),
    });

    await expect(
      registry.sweepTrackedBrowserTabs({
        now: 10_000,
        sessionFilter: () => false,
        closeDurableTab: async (_tab, options) =>
          options.shouldClose() ? { status: "closed" } : { status: "cancelled" },
      }),
    ).resolves.toBe(1);
    expect(openStore().entries()).toEqual([]);
  });

  it("throws when durable registration cannot write SQLite", async () => {
    installRuntime((options) => {
      const store = createPluginStateSyncKeyedStoreForTests("browser", options);
      return new Proxy(store, {
        get(target, property) {
          if (property === "update") {
            return () => {
              throw new Error("sqlite unavailable");
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const registry = await freshRegistry("write-failure");

    expect(() =>
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "tab-a",
        profile: "remote",
        ownership: ownership("NATIVE-A"),
      }),
    ).toThrow("sqlite unavailable");
  });

  it("converges after close succeeds but the first durable delete fails", async () => {
    const realStore = openStore();
    let failDelete = true;
    installRuntime(
      () =>
        new Proxy(realStore, {
          get(target, property) {
            if (property === "deleteIf") {
              return (...args: Parameters<NonNullable<typeof target.deleteIf>>) => {
                if (failDelete) {
                  failDelete = false;
                  throw new Error("delete unavailable");
                }
                return target.deleteIf?.(...args);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    const first = await freshRegistry("delete-failure");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
    });
    await first.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeDurableTab: async () => ({ status: "closed" }),
    });
    expect(openStore().entries()).toHaveLength(1);

    resetPluginStateStoreForTests();
    installRuntime();
    const restarted = await freshRegistry("delete-failure-restart");
    await restarted.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeDurableTab: async () => ({ status: "missing" }),
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("deletes invalid or wrongly keyed rows without closing a target", async () => {
    const validRecord = {
      version: 1,
      sessionKey: "agent:main:main",
      nativeTargetId: "NATIVE-WRONG-KEY",
      profile: "remote",
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      interactionTargetKind: "native",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    } satisfies DurableRecord;
    openStore().register("wrong-storage-key", validRecord);
    openStore().register("invalid-record", { version: 999, sessionKey: "agent:main:main" });
    const warnings: string[] = [];
    const registry = await freshRegistry("invalid");

    await registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:other"],
      closeDurableTab: cdpMocks.closeTrackedCdpTarget,
      onWarn: (message) => warnings.push(message),
    });
    expect(openStore().entries()).toEqual([]);
    expect(cdpMocks.closeTrackedCdpTarget).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(2);
  });

  it("keeps non-durable tabs out of SQLite but shared across duplicate bundles", async () => {
    const first = await freshRegistry("volatile-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "volatile",
      profile: "remote",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
    });
    expect(openStore().entries()).toEqual([]);

    const duplicate = await freshRegistry("volatile-duplicate");
    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(
      duplicate.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("defers a cold native sweep after observed activity without adopting the row", async () => {
    const record = {
      version: 1,
      sessionKey: "agent:main:cold",
      nativeTargetId: "NATIVE-COLD",
      profile: "remote",
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      interactionTargetKind: "native",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    } satisfies DurableRecord;
    openStore().register(browserSessionTabStorageKey(record), record);
    clearProcessLocalTabState();
    const restarted = await freshRegistry("cold-alias");

    restarted.touchSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: "docs-cold",
      profile: record.profile,
      now: 9_000,
    });
    restarted.untrackSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: "docs-cold",
      profile: record.profile,
    });
    expect(openStore().lookup(browserSessionTabStorageKey(record))).toMatchObject({
      lastUsedAt: 1_000,
    });

    restarted.touchSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: record.nativeTargetId,
      profile: record.profile,
      now: 10_000,
    });
    expect(openStore().lookup(browserSessionTabStorageKey(record))).toMatchObject({
      lastUsedAt: 1_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 12_000,
        idleMs: 5_000,
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();

    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 20_000,
        idleMs: 5_000,
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(openStore().lookup(browserSessionTabStorageKey(record))).toBeUndefined();
  });

  it("defers a pending cold sweep when activity shares its timestamp", async () => {
    const first = await freshRegistry("cold-pending-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:cold-pending",
      targetId: "NATIVE-COLD-PENDING",
      profile: "remote",
      ownership: ownership("NATIVE-COLD-PENDING"),
      now: 1_000,
    });
    clearProcessLocalTabState();
    const restarted = await freshRegistry("cold-pending-restarted");
    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        closeDurableTab: async () => ({ status: "unavailable", reason: "target-lookup-failed" }),
      }),
    ).resolves.toBe(0);

    restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:cold-pending",
      targetId: "NATIVE-COLD-PENDING",
      profile: "remote",
      now: 10_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();
  });

  it("defers cold opaque handles from sweeps but still performs lifecycle cleanup", async () => {
    const first = await freshRegistry("opaque-first");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:opaque",
      targetId: "mcp-session-handle",
      profile: "remote",
      ownership: ownership("NATIVE-OPAQUE"),
      now: 1_000,
    });
    clearProcessLocalTabState();
    const restarted = await freshRegistry("opaque-restarted");
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);

    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();

    await expect(
      restarted.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:opaque"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(closeDurableTab).toHaveBeenCalledOnce();
  });
});
