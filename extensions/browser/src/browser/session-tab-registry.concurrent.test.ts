import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloseTab, RegistryModule } from "./session-tab-registry.sqlite.test-helpers.js";

const processStateSymbols = [
  "openclaw.browser.session-tabs.volatile",
  "openclaw.browser.session-tabs.volatile-cleanup",
  "openclaw.browser.session-tabs.volatile-aliases",
  "openclaw.browser.session-tabs.exact-volatile-aliases",
];

function clearProcessLocalTabState(): void {
  const state = globalThis as Record<symbol, unknown>;
  for (const name of processStateSymbols) {
    delete state[Symbol.for(name)];
  }
}

describe("volatile session tab cleanup across Browser plugin bundles", () => {
  let freshModuleCounter = 0;

  async function freshRegistry(label: string): Promise<RegistryModule> {
    freshModuleCounter += 1;
    return await importFreshModule<RegistryModule>(
      import.meta.url,
      `./session-tab-registry.js?concurrent=${label}-${freshModuleCounter}`,
    );
  }

  beforeEach(clearProcessLocalTabState);
  afterEach(clearProcessLocalTabState);

  it("shares one close attempt and releases a failed reservation for retry", async () => {
    const first = await freshRegistry("first");
    const duplicate = await freshRegistry("duplicate");
    first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "bridge-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
    });

    let failClose!: () => void;
    const failedClose = new Promise<void>((_resolve, reject) => {
      failClose = () => reject(new Error("network down"));
    });
    const closeTab = vi.fn<CloseTab>(async () => await failedClose);
    const onWarn = vi.fn();
    const firstAttempts = [first, duplicate].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
        onWarn,
      }),
    );
    failClose();
    await expect(Promise.all(firstAttempts)).resolves.toEqual([0, 0]);
    expect(closeTab).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledOnce();

    let finishRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    const retry = vi.fn<CloseTab>(async () => await retryGate);
    const retries = [duplicate, first].map((registry) =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: retry,
      }),
    );
    finishRetry();
    const retryResults = await Promise.all(retries);

    expect(retry).toHaveBeenCalledOnce();
    expect(retryResults.reduce((total, closed) => total + closed, 0)).toBe(1);
  });
});
