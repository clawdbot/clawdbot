import { beforeEach, describe, expect, it } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { considerRouteRestore, persistRoute } from "./native-route-memory.ts";

let storage: Storage;

beforeEach(() => {
  storage = createStorageMock();
});

describe("native route memory", () => {
  it("persists and restores known routes", () => {
    persistRoute("usage", "?agent=main", storage, true);
    expect(considerRouteRestore("chat", "", storage, true)).toEqual({
      routeId: "usage",
      search: "?agent=main",
    });
  });

  it("drops corrupt and invalid entries", () => {
    storage.setItem("openclaw.native.lastRoute", "{");
    expect(considerRouteRestore("chat", "", storage, true)).toBeNull();
    expect(storage.getItem("openclaw.native.lastRoute")).toBeNull();

    storage.setItem(
      "openclaw.native.lastRoute",
      JSON.stringify({ routeId: "retired", search: "" }),
    );
    expect(considerRouteRestore("chat", "", storage, true)).toBeNull();
    expect(storage.getItem("openclaw.native.lastRoute")).toBeNull();
  });

  it("does nothing outside the native host", () => {
    storage.setItem("openclaw.native.lastRoute", JSON.stringify({ routeId: "usage", search: "" }));
    persistRoute("chat", "", storage, false);
    expect(considerRouteRestore("chat", "", storage, false)).toBeNull();
    expect(JSON.parse(storage.getItem("openclaw.native.lastRoute") ?? "{}")).toEqual({
      routeId: "usage",
      search: "",
    });
  });

  it("restores only the default route without explicit search", () => {
    persistRoute("usage", "", storage, true);
    expect(considerRouteRestore("chat", "?approval=123", storage, true)).toBeNull();
    expect(considerRouteRestore("chat", "?session=abc", storage, true)).toBeNull();
    expect(considerRouteRestore("usage", "", storage, true)).toBeNull();
    expect(considerRouteRestore("chat", "", storage, true)).toEqual({
      routeId: "usage",
      search: "",
    });
  });

  it("skips restoring the route it is already on", () => {
    persistRoute("chat", "", storage, true);
    expect(considerRouteRestore("chat", "", storage, true)).toBeNull();
  });

  it("strips transient action params before persisting", () => {
    persistRoute("chat", "?session=abc&draft=deploy%20", storage, true);
    expect(considerRouteRestore("chat", "", storage, true)).toEqual({
      routeId: "chat",
      search: "?session=abc",
    });
  });
});
