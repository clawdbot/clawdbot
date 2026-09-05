// Browser tests cover extension-tab cleanup through live runtime-owned credentials.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../../plugin-registration.js";
import type { OpenClawPluginApi } from "../../runtime-api.js";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import { resolveBrowserConfig, type ResolvedBrowserConfig } from "./config.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import {
  durableOwnership,
  type DurableRecord,
} from "./session-tab-registry.sqlite.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cdpMocks = vi.hoisted(() => ({
  closeTrackedCdpTarget:
    vi.fn<(params: { nativeTargetId: string }) => Promise<CloseTrackedCdpTargetResult>>(),
}));

vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  closeTrackedCdpTarget: cdpMocks.closeTrackedCdpTarget,
}));

import {
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

const config = {
  browser: {
    defaultProfile: "chrome",
    profiles: {
      chrome: {
        driver: "extension",
        cdpPort: 18_799,
        color: "#123456",
      },
    },
  },
} satisfies OpenClawConfig;

function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of [
    "openclaw.browser.session-tabs.volatile",
    "openclaw.browser.session-tabs.volatile-cleanup",
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

function coldNativeActivityIdentities(): string[] {
  const state = globalThis as Record<symbol, unknown>;
  const activity = state[Symbol.for("openclaw.browser.session-tabs.cold-native-activity")] as
    | Map<string, unknown>
    | undefined;
  return [...(activity?.keys() ?? [])];
}

function installRuntime(): void {
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
          openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
            createPluginStateSyncKeyedStoreForTests("browser", options),
        },
      } as unknown as OpenClawPluginApi["runtime"],
    }),
  );
}

function openStore(): PluginStateSyncKeyedStore<unknown> {
  return createPluginStateSyncKeyedStoreForTests("browser", {
    namespace: "browser.session-tabs",
    maxEntries: 5_000,
    overflowPolicy: "reject-new",
  });
}

describe("durable extension session tab cleanup", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let resolved: ResolvedBrowserConfig;

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-browser-extension-tabs-");
    resetPluginStateStoreForTests();
    installRuntime();
    openStore().clear();
    cdpMocks.closeTrackedCdpTarget.mockReset().mockResolvedValue({ status: "closed" });
    setRuntimeConfigSnapshot(config, config);
    resolved = resolveBrowserConfig(config.browser, config);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearProcessLocalTabState();
    resetPluginStateStoreForTests();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("uses the live process-only extension credential for lifecycle cleanup", async () => {
    expect(resolved.extensionRelayInternalTokens).toEqual({});
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "extension-tab",
      profile: "chrome",
      ownership: durableOwnership("NATIVE-EXTENSION"),
      now: 1_000,
    });
    const internalToken = "process-only-test-credential";
    const liveResolved: ResolvedBrowserConfig = {
      ...resolved,
      extensionRelayInternalTokens: { chrome: internalToken },
    };
    expect(JSON.stringify(openStore().entries())).not.toContain(internalToken);

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        getResolvedBrowserConfig: () => liveResolved,
      }),
    ).resolves.toBe(1);
    expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "chrome",
        cdpUrl: `http://openclaw-internal:${internalToken}@127.0.0.1:18799`,
        nativeTargetId: "NATIVE-EXTENSION",
      }),
    );
    expect(openStore().entries()).toEqual([]);
  });

  it("retains cleanup without a runtime and closes it after reconnect", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "extension-tab",
      profile: "chrome",
      ownership: durableOwnership("NATIVE-EXTENSION"),
      now: 1_000,
    });
    let liveResolved: ResolvedBrowserConfig | null = null;
    const warnings: string[] = [];
    const getResolvedBrowserConfig = () => liveResolved;
    const afterRetireAge = 1_000 + BROWSER_TAB_UNREACHABLE_RETIRE_MS;

    await expect(
      sweepTrackedBrowserTabs({
        now: afterRetireAge,
        idleMs: 1,
        getResolvedBrowserConfig,
        onWarn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(0);
    expect(cdpMocks.closeTrackedCdpTarget).not.toHaveBeenCalled();
    expect(openStore().entries()).toHaveLength(1);
    expect(warnings).toContain(
      "deferred tracked browser tab NATIVE-EXTENSION: extension relay runtime unavailable",
    );

    const internalToken = "reconnected-process-only-credential";
    liveResolved = {
      ...resolved,
      extensionRelayInternalTokens: { chrome: internalToken },
    };
    await expect(
      sweepTrackedBrowserTabs({
        now: afterRetireAge + 1,
        idleMs: 1,
        getResolvedBrowserConfig,
      }),
    ).resolves.toBe(1);
    expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: `http://openclaw-internal:${internalToken}@127.0.0.1:18799`,
      }),
    );
    expect(openStore().entries()).toEqual([]);
  });

  it("retires cold activity only with the final durable generation", () => {
    const sessionKey = "agent:main:cold-retirement";
    const nativeTargetId = "NATIVE-COLD-RETIREMENT";
    const identity = `${sessionKey}\u0000chrome\u0000${nativeTargetId}`;
    trackSessionBrowserTab({
      sessionKey,
      targetId: nativeTargetId,
      profile: "chrome",
      ownership: durableOwnership(nativeTargetId, "profile-a", "browser-a"),
      now: 1_000,
    });
    clearProcessLocalTabState();
    touchSessionBrowserTab({ sessionKey, targetId: nativeTargetId, profile: "chrome", now: 2_000 });
    expect(coldNativeActivityIdentities()).toEqual([identity]);

    trackSessionBrowserTab({
      sessionKey,
      targetId: nativeTargetId,
      profile: "chrome",
      ownership: durableOwnership(nativeTargetId, "profile-b", "browser-b"),
      now: 3_000,
    });
    untrackSessionBrowserTab({
      sessionKey,
      targetId: nativeTargetId,
      profile: "chrome",
      ownership: durableOwnership(nativeTargetId, "profile-a", "browser-a"),
    });
    expect(openStore().entries()).toHaveLength(1);
    expect(coldNativeActivityIdentities()).toEqual([identity]);

    untrackSessionBrowserTab({
      sessionKey,
      targetId: nativeTargetId,
      profile: "chrome",
      ownership: durableOwnership(nativeTargetId, "profile-b", "browser-b"),
    });
    expect(openStore().entries()).toEqual([]);
    expect(coldNativeActivityIdentities()).toEqual([]);
  });

  it("retires cold activity for terminal cleanup outcomes", async () => {
    for (const outcome of ["closed", "unavailable"]) {
      const nativeTargetId = `NATIVE-${outcome}`;
      trackSessionBrowserTab({
        sessionKey: `agent:main:${outcome}`,
        targetId: nativeTargetId,
        profile: "chrome",
        ownership: durableOwnership(nativeTargetId),
      });
    }
    clearProcessLocalTabState();
    for (const outcome of ["closed", "unavailable"]) {
      touchSessionBrowserTab({
        sessionKey: `agent:main:${outcome}`,
        targetId: `NATIVE-${outcome}`,
        profile: "chrome",
      });
    }
    cdpMocks.closeTrackedCdpTarget.mockImplementation(async ({ nativeTargetId }) =>
      nativeTargetId === "NATIVE-closed"
        ? { status: "closed" }
        : { status: "unavailable", reason: "target-lookup-failed" },
    );

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:closed", "agent:main:unavailable"],
        getResolvedBrowserConfig: () => ({
          ...resolved,
          extensionRelayInternalTokens: { chrome: "terminal-outcome-test-credential" },
        }),
      }),
    ).resolves.toBe(1);
    expect(
      openStore()
        .entries()
        .map((entry) => (entry.value as DurableRecord).nativeTargetId),
    ).toEqual(["NATIVE-unavailable"]);
    expect(coldNativeActivityIdentities()).toEqual([
      "agent:main:unavailable\u0000chrome\u0000NATIVE-unavailable",
    ]);
  });
});
