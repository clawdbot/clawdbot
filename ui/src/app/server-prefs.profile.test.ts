/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeUiAppearancePreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { resolveServerUiPrefStateFromSnapshot } from "./server-prefs-state.ts";
import { configWithPrefs, createServerPrefsWriter } from "./server-prefs.test-support.ts";
import {
  changedServerUiPrefs,
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPref,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";
import type { ThemeName } from "./theme.ts";

const profileId = "profile-ada";
const scope = "ws://profiles";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  resetServerUiPrefsSync();
  vi.unstubAllGlobals();
});

describe("profile-bound appearance preferences", () => {
  it("stores every Control UI theme name the profile wire contract knows", () => {
    // Record<ThemeName, boolean> turns a theme added to the UI but missing from
    // this table into a compile error, and the loop turns a wire-contract
    // mismatch into a runtime failure — a mismatch silently drops profile
    // themes. "custom" is the deliberate exception: its palette is
    // browser-local, so the selection must never follow the profile.
    const profileStorable: Record<ThemeName, boolean> = {
      claw: true,
      knot: true,
      dash: true,
      absolutely: true,
      tide: true,
      beacon: true,
      phosphor: true,
      custom: false,
    };
    for (const [theme, storable] of Object.entries(profileStorable)) {
      expect(normalizeUiAppearancePreference(UI_APPEARANCE_PREFERENCE_KEYS.theme, theme)).toBe(
        storable ? theme : undefined,
      );
    }
  });

  it("keeps a profile-bound custom theme selection in this browser only", async () => {
    const request = vi.fn(async () => ({ status: "ok" as const }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const afterCommit = vi.fn();

    pushServerUiPrefs(
      writer,
      { theme: "custom", accent: "#123456" },
      { profileId, canWrite: true, afterCommit },
    );

    // The accent still syncs; the custom theme is retained browser-local and
    // never reaches users.prefs.set.
    await waitForFast(() =>
      expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.set", {
        entries: { "ui.accent": "#123456" },
      }),
    );
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true });
  });

  it("overlays profile appearance values without changing anonymous snapshot resolution", () => {
    const config = configWithPrefs({ theme: "claw" });
    const settings = { ...loadSettings(), theme: "knot" as const };

    expect(
      resolveServerUiPrefStateFromSnapshot(config, "theme", null, settings, true, {
        theme: "knot",
      }),
    ).toEqual({
      overridden: true,
      provenance: "profile",
      resetValue: "claw",
      value: "knot",
    });
    expect(resolveServerUiPrefStateFromSnapshot(config, "theme", null, settings, true)).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "claw",
      value: "knot",
    });
  });

  it("normalizes profile overrides above config while rejecting malformed stored values", async () => {
    const config = configWithPrefs({ theme: "claw", themeMode: "dark", accent: "#123456" });
    const request = vi.fn(async () => ({
      status: "ok" as const,
      entries: {
        "ui.theme": "knot",
        "ui.themeMode": { mode: "light" },
        "ui.accent": "#AbC123",
      },
    }));
    const writer = createServerPrefsWriter(request, scope);
    const onApplied = vi.fn();

    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied,
    });

    expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.get", {
      keys: ["ui.theme", "ui.themeMode", "ui.accent"],
    });
    expect(onApplied).toHaveBeenCalledWith({ theme: "knot", themeMode: "dark", accent: "#abc123" });
    expect(resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId })).toEqual(
      { overridden: true, provenance: "profile", resetValue: "claw", value: "knot" },
    );
    expect(
      resolveServerUiPrefState(config, "themeMode", scope, loadSettings(), { profileId })
        .provenance,
    ).toBe("synced");
    expect(
      resolveServerUiPrefState(config, "accent", scope, loadSettings(), { profileId }),
    ).toEqual({
      overridden: true,
      provenance: "profile",
      resetValue: "#123456",
      value: "#abc123",
    });
  });

  it("writes profile-bound appearance without requiring config-admin access", async () => {
    const request = vi.fn(async () => ({ status: "ok" as const }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);

    pushServerUiPrefs(writer, { theme: "knot" }, { profileId, canWrite: true });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.set", {
        entries: { "ui.theme": "knot" },
      }),
    );
  });

  it("keeps pending local edits above incoming profile updates", async () => {
    let releaseWrite!: (value: unknown) => void;
    const write = new Promise<unknown>((resolve) => {
      releaseWrite = resolve;
    });
    let profileTheme = "knot";
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: { "ui.theme": profileTheme } }
        : await write,
    );
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const config = configWithPrefs({ theme: "claw" });
    const options = {
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs(options);
    patchSettings({ theme: "dash" });
    pushServerUiPrefs(writer, { theme: "dash" }, { profileId, canWrite: true });
    profileTheme = "absolutely";

    await refreshProfileAppearancePrefs(options);

    expect(loadSettings().theme).toBe("dash");
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId }),
    ).toMatchObject({ provenance: "pending", value: "dash" });
    releaseWrite({ status: "ok" });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
  });

  it("restores gateway defaults by deleting only the profile preference", async () => {
    const config = configWithPrefs({ theme: "claw" });
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: { "ui.theme": "knot" } }
        : { status: "ok" as const },
    );
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    Object.assign(writer.state, { configSnapshot: { config } });
    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    });
    const previous = loadSettings();
    const state = resolveServerUiPrefState(config, "theme", scope, previous, { profileId });
    const next = resetServerUiPref("theme", state, scope);

    expect(next.theme).toBe("claw");
    expect(changedServerUiPrefs(previous, next)).toEqual({ theme: null });
    const afterCommit = vi.fn();
    pushServerUiPrefs(writer, { theme: null }, { profileId, canWrite: true, afterCommit });
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());

    expect(request).toHaveBeenLastCalledWith("users.prefs.set", { entries: { "ui.theme": null } });
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId }),
    ).toMatchObject({ provenance: "synced", value: "claw" });
    expect(request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
  });

  it("keeps read-only profile edits device-local without attempting a profile write", async () => {
    const config = configWithPrefs({ theme: "claw" });
    const request = vi.fn(async () => ({ status: "ok" as const, entries: {} }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    });
    patchSettings({ theme: "knot" });
    const afterCommit = vi.fn();

    pushServerUiPrefs(writer, { theme: "knot" }, { profileId, canWrite: false, afterCommit });

    expect(request).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true });
    expect(
      resolveServerUiPrefState(config, "theme", scope, loadSettings(), {
        profileId,
        canSync: false,
      }),
    ).toMatchObject({ provenance: "device-local", value: "knot" });
  });

  it("targets reset at the gateway value so an explicit product-default choice persists", async () => {
    // With an empty profile over a gateway theme of Dash, resetValue must be the
    // deletion fallback ("dash"); a product-default resetValue would classify an
    // explicit Claw selection as a reset and silently drop the user's choice.
    const config = configWithPrefs({ theme: "dash" });
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: {} }
        : { status: "ok" as const },
    );
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    await refreshProfileAppearancePrefs({
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    });

    const state = resolveServerUiPrefState(config, "theme", scope, loadSettings(), { profileId });
    expect(state).toMatchObject({ provenance: "synced", resetValue: "dash", value: "dash" });

    // The explicit Claw choice is a profile write, never a null reset.
    patchSettings({ theme: "claw" });
    pushServerUiPrefs(writer, { theme: "claw" }, { profileId, canWrite: true });
    await waitForFast(() =>
      expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
        entries: { "ui.theme": "claw" },
      }),
    );

    // Resetting from synced provenance with a profile bound lands on the
    // gateway value locally, matching what the profile-key deletion resolves to.
    const reset = resetServerUiPref("theme", state, scope);
    expect(reset.theme).toBe("dash");
  });

  it("reapplies the returning profile's appearance after an identity switch", async () => {
    // A→B→A in one browser: per-scope last-seen state must not skip re-applying
    // A's values while the DOM still shows B's.
    const config = configWithPrefs({});
    const prefsByProfile: Record<string, Record<string, string>> = {
      "profile-a": { "ui.theme": "knot" },
      "profile-b": { "ui.theme": "dash", "ui.accent": "#123456" },
    };
    let activeProfile = "profile-a";
    const request = vi.fn(async () => ({
      status: "ok" as const,
      entries: prefsByProfile[activeProfile],
    }));
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const refresh = (nextProfile: string) => {
      activeProfile = nextProfile;
      return refreshProfileAppearancePrefs({
        client: writer.state.client!,
        profileId: nextProfile,
        configObject: config,
        scope,
        onApplied: vi.fn(),
      });
    };

    await refresh("profile-a");
    expect(loadSettings().theme).toBe("knot");
    await refresh("profile-b");
    expect(loadSettings().theme).toBe("dash");
    expect(loadSettings().accent).toBe("#123456");
    await refresh("profile-a");
    expect(loadSettings().theme).toBe("knot");
    // B's accent must not linger on A even though A's scope never recorded one.
    expect(loadSettings().accent).toBeUndefined();
  });
});
