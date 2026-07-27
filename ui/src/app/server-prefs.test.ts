/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  applyServerUiPrefs,
  changedServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPrefsSync,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function configWithPrefs(prefs: Record<string, unknown>) {
  return { ui: { prefs } };
}

describe("server pref extraction", () => {
  it("applies only valid, known pref values", () => {
    const onApplied = vi.fn();
    expect(
      applyServerUiPrefs(
        configWithPrefs({
          theme: "knot",
          themeMode: "dark",
          locale: "de",
          chatShowThinking: false,
          chatSendShortcut: "modifier-enter",
          textScale: 125,
          sidebarLiveActivity: false,
          chatMessageMaxWidth: "82%",
          showAdvancedSettings: true,
          sidebarEntries: ["route:usage", "session:agent:main:test", "route:usage", 7],
          bogus: true,
        }),
        { onApplied },
      ),
    ).toBe(true);
    expect(onApplied).toHaveBeenCalledWith({
      theme: "knot",
      themeMode: "dark",
      locale: "de",
      chatShowThinking: false,
      chatSendShortcut: "modifier-enter",
      showAdvancedSettings: true,
      sidebarEntries: ["route:usage", "session:agent:main:test"],
    });
  });

  it("ignores invalid values and configs without prefs", () => {
    const onApplied = vi.fn();
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "neon", locale: "xx-YY" }), {
        onApplied,
      }),
    ).toBe(false);
    resetServerUiPrefsSync();
    expect(applyServerUiPrefs({}, { onApplied })).toBe(false);
    resetServerUiPrefsSync();
    expect(applyServerUiPrefs(null, { onApplied })).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("applyServerUiPrefs", () => {
  it("applies a server delta to the local mirror once", () => {
    const onApplied = vi.fn();
    const config = configWithPrefs({ themeMode: "dark" });

    expect(applyServerUiPrefs(config, { onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("dark");
    expect(onApplied).toHaveBeenCalledWith({ themeMode: "dark" });

    // The same server value never re-applies, so a later local edit sticks.
    patchSettings({ themeMode: "light" });
    expect(applyServerUiPrefs(config, { onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("does not reapply a retained pre-commit snapshot after an ack moves lastSeen", async () => {
    const scope = "ws://gw";
    const oldSnapshot = configWithPrefs({ themeMode: "light" });
    const onApplied = vi.fn();
    applyServerUiPrefs(oldSnapshot, { scope, onApplied });
    patchSettings({ themeMode: "dark" });
    const request = vi.fn(async () => ({}));
    const client = { connected: true, gatewayUrl: scope, request } as unknown as Parameters<
      typeof pushServerUiPrefs
    >[0];

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() =>
      expect(localStorage.getItem(`openclaw.control.serverPrefs.pending.v1:${scope}`)).toBeNull(),
    );

    expect(applyServerUiPrefs(oldSnapshot, { scope, onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");
  });

  it("treats a new object with old content after ack as a genuine LWW restore", async () => {
    const scope = "ws://gw";
    const oldSnapshot = configWithPrefs({ themeMode: "light" });
    const onApplied = vi.fn();
    applyServerUiPrefs(oldSnapshot, { scope, onApplied });
    patchSettings({ themeMode: "dark" });
    const request = vi.fn(async () => ({}));
    const client = { connected: true, gatewayUrl: scope, request } as unknown as Parameters<
      typeof pushServerUiPrefs
    >[0];
    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() =>
      expect(localStorage.getItem(`openclaw.control.serverPrefs.pending.v1:${scope}`)).toBeNull(),
    );

    // A new post-bump snapshot object represents a genuine foreign restore and is LWW-correct.
    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), { scope, onApplied })).toBe(
      true,
    );
    expect(loadSettings().themeMode).toBe("light");
  });

  it("clears the retained-object memo on reset", () => {
    const scope = "ws://memo";
    const snapshot = configWithPrefs({ themeMode: "dark" });
    const onApplied = vi.fn();
    expect(applyServerUiPrefs(snapshot, { scope, onApplied })).toBe(true);
    patchSettings({ themeMode: "light" });
    localStorage.setItem(
      `openclaw.control.serverPrefs.v1:${scope}`,
      JSON.stringify({ themeMode: "light" }),
    );
    expect(applyServerUiPrefs(snapshot, { scope, onApplied })).toBe(false);

    resetServerUiPrefsSync();

    expect(applyServerUiPrefs(snapshot, { scope, onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("dark");
  });

  it("keeps an unpushed local edit across a sync reset (reload/reconnect)", () => {
    const onApplied = vi.fn();
    const config = configWithPrefs({ themeMode: "dark" });
    applyServerUiPrefs(config, { scope: "ws://gw", onApplied });
    patchSettings({ themeMode: "light" });

    // The last-seen server value persists per gateway scope, so the same old
    // server snapshot after a reload is not treated as a fresh change.
    resetServerUiPrefsSync();
    expect(applyServerUiPrefs(config, { scope: "ws://gw", onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("applies again when the server value actually changes", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ themeMode: "dark" }), { onApplied });
    patchSettings({ themeMode: "light" });

    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "system" }), { onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("system");
  });

  it("applies only the fields the server actually changed", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ themeMode: "dark", locale: "de" }), { onApplied });
    // Unpushable local edit on one field...
    patchSettings({ themeMode: "light" });

    // ...survives a server change to a *different* field.
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "dark", locale: "fr" }), { onApplied }),
    ).toBe(true);
    expect(loadSettings().locale).toBe("fr");
    expect(loadSettings().themeMode).toBe("light");
  });

  it("preserves a local sidebar edit when only another server preference changes", () => {
    const onApplied = vi.fn();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];
    applyServerUiPrefs(configWithPrefs({ sidebarEntries, themeMode: "dark" }), { onApplied });
    patchSettings({ sidebarEntries: ["route:usage"] });

    expect(
      applyServerUiPrefs(
        configWithPrefs({ sidebarEntries: [...sidebarEntries], themeMode: "light" }),
        { onApplied },
      ),
    ).toBe(true);
    expect(loadSettings().sidebarEntries).toEqual(["route:usage"]);
    expect(loadSettings().themeMode).toBe("light");
    expect(onApplied).toHaveBeenLastCalledWith({ themeMode: "light" });
  });

  it("ignores a server custom theme until this browser imported one", () => {
    const onApplied = vi.fn();
    expect(applyServerUiPrefs(configWithPrefs({ theme: "custom" }), { onApplied })).toBe(false);
    expect(loadSettings().theme).toBe("claw");
  });
});

describe("changedServerUiPrefs", () => {
  it("returns only the synced keys that changed", () => {
    const previous = loadSettings();
    const next = { ...previous, themeMode: "dark" as const, navCollapsed: !previous.navCollapsed };
    expect(changedServerUiPrefs(previous, next)).toEqual({ themeMode: "dark" });
    expect(changedServerUiPrefs(previous, { ...previous })).toBeNull();
  });

  it("syncs canonical sidebar entries without treating equal arrays as changes", () => {
    const previous = loadSettings();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];
    expect(changedServerUiPrefs(previous, { ...previous, sidebarEntries })).toEqual({
      sidebarEntries,
    });
    expect(
      changedServerUiPrefs(
        { ...previous, sidebarEntries },
        { ...previous, sidebarEntries: [...sidebarEntries] },
      ),
    ).toBeNull();
  });

  it("does not sync browser-local presentation preferences", () => {
    const previous = loadSettings();
    expect(
      changedServerUiPrefs(previous, {
        ...previous,
        textScale: 125,
        sidebarLiveActivity: false,
        chatMessageMaxWidth: "82%",
      }),
    ).toBeNull();
  });

  it("syncs the advanced settings visibility preference", () => {
    const previous = loadSettings();
    expect(previous.showAdvancedSettings).toBe(false);
    expect(changedServerUiPrefs(previous, { ...previous, showAdvancedSettings: true })).toEqual({
      showAdvancedSettings: true,
    });
  });

  it("syncs chat behavior prefs and pushes clearable resets as null", () => {
    const previous = loadSettings();
    const withOverrides = {
      ...previous,
      chatPersistCommentary: false,
      chatFollowUpMode: "queue" as const,
    };
    expect(changedServerUiPrefs(previous, withOverrides)).toEqual({
      chatPersistCommentary: false,
      chatFollowUpMode: "queue",
    });

    // Clearing the follow-up override must propagate as an explicit removal.
    expect(
      changedServerUiPrefs(withOverrides, { ...withOverrides, chatFollowUpMode: undefined }),
    ).toEqual({ chatFollowUpMode: null });
  });
});

describe("clearable pref removal from the server", () => {
  it("clears the local follow-up override when the server removes it", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ chatFollowUpMode: "queue" }), { onApplied });
    expect(loadSettings().chatFollowUpMode).toBe("queue");

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    expect(loadSettings().chatFollowUpMode).toBeUndefined();
  });
});

describe("pushServerUiPrefs", () => {
  type RequestMock = ReturnType<
    typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>
  >;
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
  const lastSeenKey = (scope: string) => `openclaw.control.serverPrefs.v1:${scope}`;
  const readPending = (scope: string) =>
    JSON.parse(localStorage.getItem(pendingKey(scope)) ?? "{}") as Record<string, unknown>;
  const createClient = (request: RequestMock, gatewayUrl = "ws://gw", connected = true) =>
    ({ request, gatewayUrl, connected }) as unknown as Parameters<typeof pushServerUiPrefs>[0];

  it("sends one hash-free patch and acknowledges lastSeen plus pending", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const afterCommit = vi.fn();
    const client = createClient(request);

    pushServerUiPrefs(client, { themeMode: "dark" }, { afterCommit });
    await vi.waitFor(() => expect(afterCommit).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledExactlyOnceWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
      note: "control-ui prefs sync",
    });
    expect(request.mock.calls.some(([method]) => method === "config.get")).toBe(false);
    expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull();
    expect(JSON.parse(localStorage.getItem(lastSeenKey("ws://gw")) ?? "{}")).toEqual({
      themeMode: "dark",
    });
  });

  it("merges this tab's edit with sibling persisted pending keys", () => {
    const scope = "ws://gw";
    const flight = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () => flight.promise,
    );
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));

    pushServerUiPrefs(client, { theme: "knot" });

    expect(readPending(scope)).toEqual({ locale: "fr", theme: "knot" });
  });

  it("settles only this tab's acknowledged keys from sibling persisted pending", async () => {
    const scope = "ws://gw";
    const flight = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () => flight.promise,
    );
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));
    pushServerUiPrefs(client, { theme: "knot" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    flight.resolve({});

    await vi.waitFor(() => expect(readPending(scope)).toEqual({ locale: "fr" }));
  });

  it("drops only this tab's validation-rejected keys from persisted pending", async () => {
    const scope = "ws://gw";
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw new Error("invalid config");
    });
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));

    pushServerUiPrefs(client, { theme: "knot" });

    await vi.waitFor(() => expect(readPending(scope)).toEqual({ locale: "fr" }));
  });

  it("overwrites only a same-key sibling value when this tab persists later", () => {
    const scope = "ws://gw";
    const flight = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () => flight.promise,
    );
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr", themeMode: "light" }));

    pushServerUiPrefs(client, { themeMode: "dark" });

    expect(readPending(scope)).toEqual({ locale: "fr", themeMode: "dark" });
  });

  it("preserves a newer same-key edit across the older batch ack", async () => {
    let resolveFirst: (() => void) | undefined;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () =>
        new Promise<unknown>((resolve) => {
          if (request.mock.calls.length === 1) {
            resolveFirst = () => resolve({});
          } else {
            resolve({});
          }
        }),
    );
    const client = createClient(request);

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    pushServerUiPrefs(client, { themeMode: "light" });
    resolveFirst?.();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "light" } } }),
      note: "control-ui prefs sync",
    });
  });

  it("retains a failed offline push and flushes it after reconnect", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw new Error("socket closed");
    });
    const clientState = { request, gatewayUrl: "ws://gw", connected: false };
    const client = clientState as unknown as Parameters<typeof pushServerUiPrefs>[0];

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(JSON.parse(localStorage.getItem(pendingKey("ws://gw")) ?? "{}")).toEqual({
      locale: "de",
    });

    clientState.connected = true;
    request.mockResolvedValue({});
    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull();
  });

  it("supersedes a hung prior-connection request on same-client flush", async () => {
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(() => {
      calls += 1;
      return calls === 1 ? new Promise<unknown>(() => {}) : Promise.resolve({});
    });
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    flushServerUiPrefs(client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("ignores a superseded request rejection while its replacement is pending", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(() => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    });
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    first.reject(new Error("socket closed"));
    await Promise.resolve();

    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();
    second.resolve({});
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("keeps pending shadow active during the post-commit refresh hook", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const client = createClient(request);
    patchSettings({ themeMode: "dark" });
    const onApplied = vi.fn();

    pushServerUiPrefs(
      client,
      { themeMode: "dark" },
      {
        afterCommit: () => {
          applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), {
            scope: "ws://gw",
            onApplied,
          });
        },
      },
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());

    expect(onApplied).not.toHaveBeenCalled();
    expect(loadSettings().themeMode).toBe("dark");
  });

  it("lets pending local intent shadow only its own server key", async () => {
    let resolveRequest: (() => void) | undefined;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = () => resolve({});
        }),
    );
    const client = createClient(request);
    patchSettings({ themeMode: "dark" });
    pushServerUiPrefs(client, { themeMode: "dark" });

    const onApplied = vi.fn();
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "light", locale: "de" }), {
        scope: "ws://gw",
        onApplied,
      }),
    ).toBe(true);
    expect(onApplied).toHaveBeenCalledWith({ locale: "de" });
    expect(loadSettings().themeMode).toBe("dark");
    resolveRequest?.();
  });

  it("does not let another scope's reconcile replace an active drain's pending state", async () => {
    let resolveRequest: (() => void) | undefined;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = () => resolve({});
        }),
    );
    const client = createClient(request, "ws://a");
    localStorage.setItem(pendingKey("ws://b"), JSON.stringify({ locale: "de" }));

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    applyServerUiPrefs(configWithPrefs({ themeMode: "light", locale: "fr" }), {
      scope: "ws://b",
      onApplied: vi.fn(),
    });
    resolveRequest?.();

    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://a"))).toBeNull());
    expect(JSON.parse(localStorage.getItem(pendingKey("ws://b")) ?? "{}")).toEqual({
      locale: "de",
    });
  });

  it("retries one conflict then retains pending, but drops validation failures", async () => {
    vi.useFakeTimers();
    const conflictRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => {
        throw new Error("config changed since last load; re-run config.get and retry");
      },
    );
    pushServerUiPrefs(createClient(conflictRequest), { locale: "de" });
    await vi.advanceTimersByTimeAsync(250);
    expect(conflictRequest).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();

    resetServerUiPrefsSync();
    localStorage.clear();
    const validationRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => {
        throw new Error("invalid config");
      },
    );
    pushServerUiPrefs(createClient(validationRequest), { locale: "de" });
    await vi.waitFor(() => expect(validationRequest).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("re-drains pending intent after a twice-conflicting batch", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      calls += 1;
      if (calls <= 2) {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return {};
    });

    pushServerUiPrefs(createClient(request), { locale: "de" });
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(request).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull();
  });

  it("cancels a conflict re-drain when flush or reset supersedes its epoch", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      calls += 1;
      if (calls <= 2) {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return {};
    });
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.advanceTimersByTimeAsync(250);
    flushServerUiPrefs(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);

    resetServerUiPrefsSync();
    localStorage.clear();
    const conflicting = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw new Error("config changed since last load; re-run config.get and retry");
    });
    pushServerUiPrefs(createClient(conflicting), { locale: "fr" });
    await vi.advanceTimersByTimeAsync(250);
    expect(conflicting).toHaveBeenCalledTimes(2);
    resetServerUiPrefsSync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conflicting).toHaveBeenCalledTimes(2);
  });

  it("caps conflict-triggered re-drains at five", async () => {
    vi.useFakeTimers();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw new Error("config changed since last load; re-run config.get and retry");
    });

    pushServerUiPrefs(createClient(request), { locale: "de" });
    for (let round = 0; round <= 5; round += 1) {
      await vi.advanceTimersByTimeAsync(250);
      expect(request).toHaveBeenCalledTimes((round + 1) * 2);
      if (round < 5) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(request).toHaveBeenCalledTimes(12);
    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();
  });

  it("marks sidebar arrays for replacement", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const sidebarEntries = ["route:usage"];

    pushServerUiPrefs(createClient(request), { sidebarEntries });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { sidebarEntries } } }),
      replacePaths: ["ui.prefs.sidebarEntries"],
      note: "control-ui prefs sync",
    });
  });

  it("persists pending per scope and reloads only the adopted scope", async () => {
    const offlineRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => {
        throw new Error("offline");
      },
    );
    pushServerUiPrefs(createClient(offlineRequest, "ws://a", false), { themeMode: "dark" });
    await vi.waitFor(() => expect(offlineRequest).toHaveBeenCalledTimes(1));
    pushServerUiPrefs(createClient(offlineRequest, "ws://b", false), { locale: "de" });
    await vi.waitFor(() => expect(offlineRequest).toHaveBeenCalledTimes(2));

    expect(JSON.parse(localStorage.getItem(pendingKey("ws://a")) ?? "{}")).toEqual({
      themeMode: "dark",
    });
    expect(JSON.parse(localStorage.getItem(pendingKey("ws://b")) ?? "{}")).toEqual({
      locale: "de",
    });

    resetServerUiPrefsSync();
    const replayRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => ({}),
    );
    flushServerUiPrefs(createClient(replayRequest, "ws://b"));
    await vi.waitFor(() => expect(replayRequest).toHaveBeenCalledOnce());
    expect(replayRequest.mock.calls[0]?.[1]).toMatchObject({
      raw: JSON.stringify({ ui: { prefs: { locale: "de" } } }),
    });
    expect(localStorage.getItem(pendingKey("ws://a"))).not.toBeNull();
  });
});
