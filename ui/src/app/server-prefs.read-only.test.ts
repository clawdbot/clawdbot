/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  configWithPrefs,
  createServerPrefsWriter,
  type RequestMock,
} from "./server-prefs.test-support.ts";
import {
  applyServerUiPrefs,
  changedServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPref,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings, setSettingsChangeListener } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  setSettingsChangeListener(null);
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};
const pendingKey = (scope: string) => `openclaw.control.serverPrefs.pending.v1:${scope}`;
const readPending = (scope: string) =>
  JSON.parse(localStorage.getItem(pendingKey(scope)) ?? "{}") as Record<string, unknown>;
const createClient = createServerPrefsWriter;

describe("read-only server preference lifecycle", () => {
  it("keeps every governed preference browser-local for a connected read-only writer", () => {
    const scope = "ws://read-only";
    const config = configWithPrefs({
      theme: "claw",
      themeMode: "light",
      locale: "en",
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatPersistCommentary: true,
      chatSendShortcut: "enter",
      chatFollowUpMode: "queue",
      sidebarEntries: ["route:usage"],
    });
    applyServerUiPrefs(config, { scope, onApplied: vi.fn() });
    const previous = loadSettings();
    const next = patchSettings({
      theme: "knot",
      themeMode: "dark",
      locale: "fr",
      chatShowThinking: false,
      chatShowToolCalls: false,
      chatPersistCommentary: false,
      chatSendShortcut: "modifier-enter",
      chatFollowUpMode: "steer",
      sidebarEntries: ["route:agents"],
    });
    const prefs = changedServerUiPrefs(previous, next);
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
    const afterCommit = vi.fn();

    expect(Object.keys(prefs ?? {}).toSorted()).toEqual(
      [
        "theme",
        "themeMode",
        "locale",
        "chatShowThinking",
        "chatShowToolCalls",
        "chatPersistCommentary",
        "chatSendShortcut",
        "chatFollowUpMode",
        "sidebarEntries",
      ].toSorted(),
    );
    pushServerUiPrefs(createClient(request, scope, true, { ok: true }, false), prefs ?? {}, {
      afterCommit,
    });

    expect(request).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey(scope))).toBeNull();
    expect(afterCommit).toHaveBeenCalledExactlyOnceWith({
      needsRefresh: false,
      retainedLocal: true,
    });
    for (const key of [
      "theme",
      "themeMode",
      "locale",
      "chatShowThinking",
      "chatShowToolCalls",
      "chatPersistCommentary",
      "chatSendShortcut",
      "chatFollowUpMode",
      "sidebarEntries",
    ] as const) {
      expect(
        resolveServerUiPrefState(config, key, scope, next, { canSync: false }).provenance,
      ).toBe("device-local");
    }
  });

  it("retains a pre-snapshot read-only edit until the first server baseline is recorded", () => {
    const scope = "ws://read-only";
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
    patchSettings({ theme: "knot" });

    pushServerUiPrefs(
      createClient(request, scope, true, { ok: true }, false),
      { theme: "knot" },
      { afterCommit: vi.fn() },
    );

    const initial = configWithPrefs({ theme: "claw" });
    expect(applyServerUiPrefs(initial, { scope, onApplied: vi.fn() })).toBe(false);
    expect(loadSettings().theme).toBe("knot");
    expect(
      localStorage.getItem(`openclaw.control.serverPrefs.retained-local.v1:${scope}`),
    ).toBeNull();

    resetServerUiPrefsSync();
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "claw" }), {
        scope,
        onApplied: vi.fn(),
      }),
    ).toBe(false);
    expect(loadSettings().theme).toBe("knot");

    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "dash" }), {
        scope,
        onApplied: vi.fn(),
      }),
    ).toBe(true);
    expect(loadSettings().theme).toBe("dash");
    expect(request).not.toHaveBeenCalled();
  });

  it("applies the first server delta after a post-snapshot read-only edit", () => {
    const scope = "ws://read-only";
    const initial = configWithPrefs({ theme: "claw" });
    applyServerUiPrefs(initial, { scope, onApplied: vi.fn() });
    patchSettings({ theme: "knot" });

    pushServerUiPrefs(
      createClient(vi.fn(), scope, true, { ok: true }, false),
      { theme: "knot" },
      {
        afterCommit: ({ retainedLocal }) => {
          expect(retainedLocal).toBe(true);
          expect(applyServerUiPrefs(initial, { scope, onApplied: vi.fn() })).toBe(false);
        },
      },
    );

    expect(
      localStorage.getItem(`openclaw.control.serverPrefs.retained-local.v1:${scope}`),
    ).toBeNull();
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "dash" }), {
        scope,
        onApplied: vi.fn(),
      }),
    ).toBe(true);
    expect(loadSettings().theme).toBe("dash");
  });

  it("keeps offline intent through read-only reconnect and replays it after authorization", async () => {
    const scope = "ws://read-only";
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const writer = createClient(request, scope, false, { ok: true }, false);
    patchSettings({ theme: "knot" });

    pushServerUiPrefs(writer, { theme: "knot" });
    expect(readPending(scope)).toEqual({ theme: "knot" });
    expect(
      resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", scope, loadSettings(), {
        canSync: false,
      }),
    ).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "claw",
      value: "knot",
    });

    (writer.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(writer);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(readPending(scope)).toEqual({ theme: "knot" });

    (writer as { canPatch?: boolean }).canPatch = true;
    flushServerUiPrefs(writer);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey(scope))).toBeNull());
  });

  it("cancels only the reset or superseded read-only keys from offline pending intent", () => {
    const scope = "ws://read-only";
    const offline = createClient(vi.fn(), scope, false, { ok: true }, false);
    patchSettings({ locale: "fr", theme: "knot" });
    pushServerUiPrefs(offline, { locale: "fr", theme: "knot" });

    const themeState = resolveServerUiPrefState(
      configWithPrefs({ locale: "de", theme: "claw" }),
      "theme",
      scope,
      loadSettings(),
      { canSync: false },
    );
    const beforeReset = loadSettings();
    const reset = resetServerUiPref("theme", themeState, scope);

    expect(changedServerUiPrefs(beforeReset, reset)).toBeNull();
    expect(reset.theme).toBe("claw");
    expect(readPending(scope)).toEqual({ locale: "fr" });

    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
    pushServerUiPrefs(createClient(request, scope, true, { ok: true }, false), { locale: "en" });
    expect(request).not.toHaveBeenCalled();
    expect(localStorage.getItem(pendingKey(scope))).toBeNull();
  });

  it("rechecks write capability after queued config writes settle", async () => {
    const scope = "ws://gw";
    const gate = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const client = {
      request,
      gatewayUrl: scope,
      connected: true,
    } as unknown as GatewayBrowserClient;
    let canPatch = true;
    const writer: Parameters<typeof pushServerUiPrefs>[0] = {
      get canPatch() {
        return canPatch;
      },
      state: { client, connected: true },
      runExternalMutation: async (task, options) => {
        await gate.promise;
        if (options?.canDispatch && !options.canDispatch()) {
          return {
            ok: false,
            reason: "unavailable",
            error: options.dispatchError ?? "dispatch blocked",
          };
        }
        return { ok: true, value: await task(client), refresh: { ok: true } };
      },
    };

    pushServerUiPrefs(writer, { locale: "de" });
    canPatch = false;
    gate.resolve(undefined);
    await vi.waitFor(() => expect(readPending(scope)).toEqual({ locale: "de" }));

    expect(request).not.toHaveBeenCalled();
  });

  it("does not replay persisted intent that another tab cancelled", async () => {
    const scope = "ws://gw";
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const client = createClient(request, scope, false);

    pushServerUiPrefs(client, { theme: "knot" });
    expect(readPending(scope)).toEqual({ theme: "knot" });

    localStorage.removeItem(pendingKey(scope));
    (client.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(client);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
  });

  it("does not resurrect a sibling key another tab cancelled during a read-only edit", async () => {
    const scope = "ws://gw";
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const client = createClient(request, scope, false);

    pushServerUiPrefs(client, { locale: "de", theme: "knot" });
    localStorage.setItem(pendingKey(scope), JSON.stringify({ theme: "knot" }));
    (client.state as { connected: boolean }).connected = true;
    (client as { canPatch: boolean }).canPatch = false;
    pushServerUiPrefs(client, { themeMode: "dark" });

    expect(readPending(scope)).toEqual({ theme: "knot" });
    expect(request).not.toHaveBeenCalled();

    (client as { canPatch: boolean }).canPatch = true;
    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { theme: "knot" } } }),
      note: "control-ui prefs sync",
    });
  });

  it("dispatches a same-key replacement persisted by another tab", async () => {
    const scope = "ws://gw";
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const client = createClient(request, scope, false);

    pushServerUiPrefs(client, { theme: "knot" });
    localStorage.setItem(pendingKey(scope), JSON.stringify({ theme: "dash" }));
    (client.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { theme: "dash" } } }),
      note: "control-ui prefs sync",
    });
  });

  it("does not migrate cancelled pre-connection intent into an adopted gateway scope", async () => {
    const request: RequestMock = vi.fn(async () => ({}));
    const writer = createClient(request, "", false);
    (writer.state as { client: GatewayBrowserClient | null }).client = null;

    pushServerUiPrefs(writer, { theme: "knot" });
    localStorage.removeItem(pendingKey(""));

    (writer.state as { client: GatewayBrowserClient | null; connected: boolean }).client = {
      request,
      gatewayUrl: "ws://first",
      connected: true,
    } as unknown as GatewayBrowserClient;
    (writer.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(writer);
    pushServerUiPrefs(writer, { themeMode: "dark" });

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
      note: "control-ui prefs sync",
    });
  });
});
