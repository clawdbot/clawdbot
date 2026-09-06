/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadStoredCollapsedSessionSections,
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionSortMode,
  loadStoredSidebarSessionStatusFilter,
  loadStoredSidebarSessionOwnerFilter,
  loadStoredSidebarSessionsShowPreview,
  setStoredSessionCatalogHidden,
  storeSidebarSessionSortMode,
  storeSidebarSessionStatusFilter,
  storeSidebarSessionOwnerFilter,
  storeSidebarSessionsShowPreview,
} from "./app-sidebar-session-types.ts";

// getSafeLocalStorage only accepts an own value property under Vitest, so the
// jsdom getter-backed localStorage must be replaced with a plain mock.
let originalLocalStorage: PropertyDescriptor | undefined;

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("sidebar session status preference", () => {
  it("defaults unknown stored values to active", () => {
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    localStorage.setItem("openclaw:sidebar:sessions:status-filter", "unexpected");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
  });

  it("stores archived and all filters", () => {
    storeSidebarSessionStatusFilter("archived");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("archived");
    storeSidebarSessionStatusFilter("all");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("all");
  });
});

describe("sidebar session owner preference", () => {
  it("isolates owner and involving-me filters by gateway and authenticated user", () => {
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
      ownerId: "profile-bob",
      involvingMe: false,
    });
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-grace", {
      ownerId: null,
      involvingMe: true,
    });

    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: "profile-bob",
      involvingMe: false,
    });
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-grace")).toEqual({
      ownerId: null,
      involvingMe: true,
    });
    expect(loadStoredSidebarSessionOwnerFilter("wss://two.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });
  });

  it("removes all-owner filters and rejects malformed stored values", () => {
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
      ownerId: "profile-bob",
      involvingMe: false,
    });
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", "owner:");
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });

    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
      ownerId: null,
      involvingMe: false,
    });
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });
    expect(localStorage.length).toBe(0);
  });

  it("keeps rendering when browser storage rejects access", () => {
    localStorage.getItem = () => {
      throw new Error("storage disabled");
    };
    localStorage.setItem = () => {
      throw new Error("storage disabled");
    };

    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada")).toEqual({
      ownerId: null,
      involvingMe: false,
    });
    expect(() =>
      storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-ada", {
        ownerId: null,
        involvingMe: true,
      }),
    ).not.toThrow();
  });
});

describe("sidebar session sort preference", () => {
  it("defaults absent and unknown stored values to created", () => {
    expect(loadStoredSidebarSessionSortMode()).toBe("created");
    localStorage.setItem("openclaw:sidebar:sessions:sort-mode", "unexpected");
    expect(loadStoredSidebarSessionSortMode()).toBe("created");
  });

  it("round-trips updated and people modes", () => {
    expect(storeSidebarSessionSortMode("updated", undefined)).toBe("updated");
    expect(loadStoredSidebarSessionSortMode()).toBe("updated");
    expect(storeSidebarSessionSortMode("people", true)).toBe("people");
    expect(loadStoredSidebarSessionSortMode()).toBe("people");
  });

  it("stores created instead of a people sort the gateway denied", () => {
    expect(storeSidebarSessionSortMode("people", false)).toBe("created");
    expect(loadStoredSidebarSessionSortMode()).toBe("created");
  });
});

describe("collapsed sidebar sections preference", () => {
  it("defaults Coding to compact while Online remains expanded", () => {
    expect([...loadStoredCollapsedSessionSections()]).toEqual(["work"]);
  });
});

describe("sidebar session preview preference", () => {
  it("defaults to hiding previews and round-trips the stored choice", () => {
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(false);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(false);

    storeSidebarSessionsShowPreview(true);
    expect(loadStoredSidebarSessionsShowPreview()).toBe(true);
  });
});

describe("hidden session catalog preference", () => {
  it("round-trips catalog ids and reverses one hide at a time", () => {
    setStoredSessionCatalogHidden("codex", true);
    setStoredSessionCatalogHidden("claude", true);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["codex", "claude"]);

    setStoredSessionCatalogHidden("codex", false);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["claude"]);
  });

  it.each(["not-json", JSON.stringify({ catalog: "codex" })])(
    "treats malformed storage as empty: %s",
    (stored) => {
      localStorage.setItem("openclaw:sidebar:sessions:hidden-catalogs", stored);
      expect(loadStoredHiddenSessionCatalogIds().size).toBe(0);
    },
  );
});
