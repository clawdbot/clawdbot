import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadConfig so the single-arg setActiveWebListener overload resolves
// the configured default account as "work" (matching the regression test).
// All other tests pass explicit accountIds and are unaffected by this mock.
vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  loadConfig: () => ({
    channels: { whatsapp: { accounts: { work: { enabled: true } }, defaultAccount: "work" } },
  }),
}));

type ActiveListenerModule = typeof import("./active-listener.js");

const activeListenerModuleUrl = new URL("./active-listener.ts", import.meta.url).href;

async function importActiveListenerModule(cacheBust: string): Promise<ActiveListenerModule> {
  return (await import(`${activeListenerModuleUrl}?t=${cacheBust}`)) as ActiveListenerModule;
}

afterEach(async () => {
  const mod = await importActiveListenerModule(`cleanup-${Date.now()}`);
  mod.setActiveWebListener(null);
  mod.setActiveWebListener("work", null);
  mod.setActiveWebListener("default", null);
});

/** Minimal listener stub */
function makeListener() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };
}

describe("active WhatsApp listener singleton", () => {
  it("shares listeners across duplicate module instances (bundle-fragmentation fix)", async () => {
    // Simulates the scenario where two bundled copies of active-listener.ts are loaded
    // (e.g. channel-web-*.js calls setActiveWebListener, outbound-*.js calls
    // requireActiveWebListener). Without resolveGlobalSingleton they would each hold
    // their own Map and the listener would never be found by the outbound path.
    const first = await importActiveListenerModule(`first-${Date.now()}`);
    const second = await importActiveListenerModule(`second-${Date.now()}`);
    const listener = makeListener();

    first.setActiveWebListener("work", listener);

    expect(second.getActiveWebListener("work")).toBe(listener);
    expect(second.requireActiveWebListener("work")).toEqual({
      accountId: "work",
      listener,
    });
  });

  it("single-arg overload registers under configured default account, not always 'default'", async () => {
    // Regression: setActiveWebListener(listener) used DEFAULT_ACCOUNT_ID ("default")
    // even when the configured default account is named "work". This caused
    // requireActiveWebListener("work") to throw while the listener was silently
    // registered under the wrong key.
    const mod = await importActiveListenerModule(`named-account-${Date.now()}`);
    const listener = makeListener();

    // Single-arg call — should resolve accountId from loadConfig() default, which
    // vitest config maps to "work" (see mock below).
    mod.setActiveWebListener(listener);

    // "work" must be resolvable — previously this threw
    expect(mod.requireActiveWebListener("work")).toEqual({
      accountId: "work",
      listener,
    });
  });

  it("single-arg overload still works when default account is 'default'", async () => {
    // Backward-compat: configs that rely on the "default" account name must
    // continue to work after the fix. Use single-arg overload with a temporary
    // spy that returns "default" as the configured default account.
    const configRuntime = await import("openclaw/plugin-sdk/config-runtime");
    const spy = vi.spyOn(configRuntime, "loadConfig").mockReturnValue({
      channels: {
        whatsapp: { accounts: { default: { enabled: true } }, defaultAccount: "default" },
      },
    } as ReturnType<typeof configRuntime.loadConfig>);

    try {
      const mod = await importActiveListenerModule(`default-account-${Date.now()}`);
      const listener = makeListener();

      // Single-arg call — should resolve to "default" via the spy
      mod.setActiveWebListener(listener);

      expect(mod.requireActiveWebListener("default")).toEqual({
        accountId: "default",
        listener,
      });
      // The legacy no-arg lookup (undefined → "default") must also work
      expect(mod.requireActiveWebListener()).toEqual({
        accountId: "default",
        listener,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("requireActiveWebListener throws a clear error when listener is missing", async () => {
    const mod = await importActiveListenerModule(`missing-${Date.now()}`);

    expect(() => mod.requireActiveWebListener("work")).toThrowError(
      /No active WhatsApp Web listener \(account: work\)/,
    );
  });

  it("setActiveWebListener with null removes the listener", async () => {
    const mod = await importActiveListenerModule(`remove-${Date.now()}`);
    const listener = makeListener();

    mod.setActiveWebListener("work", listener);
    expect(mod.getActiveWebListener("work")).toBe(listener);

    mod.setActiveWebListener("work", null);
    expect(mod.getActiveWebListener("work")).toBeNull();
  });
});
