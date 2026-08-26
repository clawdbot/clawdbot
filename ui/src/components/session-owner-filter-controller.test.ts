/* @vitest-environment jsdom */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";
import { SessionOwnerFilterController } from "./session-owner-filter-controller.ts";

let originalLocalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  const values = new Map<string, string>();
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => void values.delete(key),
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("SessionOwnerFilterController", () => {
  it("waits for the new identity roster before validating its stored owner", async () => {
    let controller: ReactiveController | undefined;
    const host = {
      addController: (value: ReactiveController) => {
        controller = value;
      },
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
    let selfUserId = "profile-ada";
    let canonicalListRevision = 1;
    const setOwnerFilter = vi.fn(() => Promise.resolve());
    const ownerFilter = new SessionOwnerFilterController(host, () => ({
      gateway: {
        connection: { gatewayUrl: "wss://one.example/ws" },
        snapshot: { selfUser: { id: selfUserId } },
      },
      sessions: {
        get canonicalListRevision() {
          return canonicalListRevision;
        },
        setInvolvingMeFilter: vi.fn(() => Promise.resolve()),
        setOwnerFilter,
      },
    }));
    expect(controller).toBe(ownerFilter);
    ownerFilter.hostUpdated();
    ownerFilter.observeOwnerFacet(true, [{ id: "owner-ada" }]);
    storeSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob", {
      ownerId: "owner-bob",
      involvingMe: false,
    });

    selfUserId = "profile-bob";
    ownerFilter.hostUpdated();
    await Promise.resolve();
    ownerFilter.observeOwnerFacet(true, [{ id: "owner-ada" }]);
    ownerFilter.hostUpdated();

    expect(ownerFilter.ownerId).toBe("owner-bob");
    expect(setOwnerFilter).toHaveBeenCalledWith("owner-bob");
    expect(setOwnerFilter).not.toHaveBeenCalledWith(null);
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob")).toEqual({
      ownerId: "owner-bob",
      involvingMe: false,
    });

    canonicalListRevision += 1;
    ownerFilter.hostUpdated();
    ownerFilter.observeOwnerFacet(true, [{ id: "owner-bob" }]);
    ownerFilter.hostUpdated();
    expect(ownerFilter.ownerId).toBe("owner-bob");
    expect(setOwnerFilter).not.toHaveBeenCalledWith(null);
    expect(loadStoredSidebarSessionOwnerFilter("wss://one.example/ws", "profile-bob")).toEqual({
      ownerId: "owner-bob",
      involvingMe: false,
    });
  });
});
