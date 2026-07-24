/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  applyServerUiPrefs,
  changedServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPrefsSync,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
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
  it("patches config and marks the replaced hash so stale snapshots cannot revert", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1" };
      }
      return {};
    });
    const client = { request } as unknown as Parameters<typeof pushServerUiPrefs>[0];

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("config.patch", {
        baseHash: "hash-1",
        raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
        note: "control-ui prefs sync",
      });
    });

    // A snapshot still carrying the replaced hash predates the patch.
    const onApplied = vi.fn();
    patchSettings({ themeMode: "dark" });
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), {
        snapshotHash: "hash-1",
        onApplied,
      }),
    ).toBe(false);
    expect(onApplied).not.toHaveBeenCalled();
    expect(loadSettings().themeMode).toBe("dark");

    // A post-patch snapshot (any other hash) stays authoritative.
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "system" }), {
        snapshotHash: "hash-2",
        onApplied,
      }),
    ).toBe(true);
    expect(loadSettings().themeMode).toBe("system");

    // Once post-patch state was observed, the old hash means another writer
    // genuinely restored that config, so it becomes authoritative again.
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), {
        snapshotHash: "hash-1",
        onApplied,
      }),
    ).toBe(true);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("marks sidebar arrays for replacement when pinned entries are removed", async () => {
    let hash = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: `hash-${hash}` };
      }
      hash += 1;
      return {};
    });
    const client = { request } as unknown as Parameters<typeof pushServerUiPrefs>[0];
    const sidebarEntries = ["route:usage", "session:agent:main:test"];

    pushServerUiPrefs(client, { sidebarEntries });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("config.patch", {
        baseHash: "hash-0",
        raw: JSON.stringify({ ui: { prefs: { sidebarEntries } } }),
        replacePaths: ["ui.prefs.sidebarEntries"],
        note: "control-ui prefs sync",
      });
    });

    const remainingEntries = ["route:usage"];
    pushServerUiPrefs(client, { sidebarEntries: remainingEntries });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("config.patch", {
        baseHash: "hash-1",
        raw: JSON.stringify({ ui: { prefs: { sidebarEntries: remainingEntries } } }),
        replacePaths: ["ui.prefs.sidebarEntries"],
        note: "control-ui prefs sync",
      });
    });
  });

  it("coalesces rapid changes into serial patches instead of racing the hash", async () => {
    let hash = 0;
    const patched: unknown[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return { hash: `hash-${hash}` };
      }
      hash += 1;
      patched.push((params as { raw: string }).raw);
      return {};
    });
    const client = { request } as unknown as Parameters<typeof pushServerUiPrefs>[0];

    pushServerUiPrefs(client, { themeMode: "dark" });
    pushServerUiPrefs(client, { locale: "de" });
    pushServerUiPrefs(client, { themeMode: "light" });

    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([method]) => method === "config.patch").length).toBe(2);
    });
    // The first patch carries the first delta; the rest coalesce into one.
    expect(patched[0]).toBe(JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }));
    expect(patched[1]).toBe(
      JSON.stringify({ ui: { prefs: { locale: "de", themeMode: "light" } } }),
    );
  });

  it("drops a stale gateway's queue instead of writing it to the next gateway", async () => {
    let resolveFirstGet: ((value: { hash: string }) => void) | undefined;
    const requestA = vi.fn(
      (method: string) =>
        new Promise((resolve) => {
          if (method === "config.get") {
            resolveFirstGet = resolve as (value: { hash: string }) => void;
            return;
          }
          resolve({});
        }),
    );
    const requestB = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: "b-1" };
      }
      return {};
    });
    const clientA = { request: requestA } as unknown as Parameters<typeof pushServerUiPrefs>[0];
    const clientB = { request: requestB } as unknown as Parameters<typeof pushServerUiPrefs>[0];

    pushServerUiPrefs(clientA, { themeMode: "dark" });
    pushServerUiPrefs(clientB, { locale: "de" });
    resolveFirstGet?.({ hash: "a-1" });

    await vi.waitFor(() => {
      expect(requestB.mock.calls.filter(([method]) => method === "config.patch").length).toBe(1);
    });
    // Gateway A's drain saw the client switch and never patched.
    expect(requestA.mock.calls.filter(([method]) => method === "config.patch").length).toBe(0);
    expect(requestB).toHaveBeenCalledWith("config.patch", {
      baseHash: "b-1",
      raw: JSON.stringify({ ui: { prefs: { locale: "de" } } }),
      note: "control-ui prefs sync",
    });
  });

  it("retries once on a hash conflict and gives up silently otherwise", async () => {
    let patchCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "config.get") {
        return { hash: `hash-${patchCalls}` };
      }
      patchCalls += 1;
      if (patchCalls === 1) {
        throw new Error("config baseHash mismatch");
      }
      return {};
    });
    const client = { request } as unknown as Parameters<typeof pushServerUiPrefs>[0];

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => {
      expect(patchCalls).toBe(2);
    });
  });
});
