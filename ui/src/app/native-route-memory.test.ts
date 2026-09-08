import { beforeEach, describe, expect, it } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { considerRouteRestore, persistRoute } from "./native-route-memory.ts";

let storage: Storage;

beforeEach(() => {
  storage = createStorageMock();
});

describe("native route memory", () => {
  it("persists and restores known routes", () => {
    persistRoute("usage", "/usage", "?agent=main", storage, true);
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toEqual({
      routeId: "usage",
      pathname: "/usage",
      search: "?agent=main",
    });
  });

  it.each([
    "{",
    ...["retired", "constructor", "toString", "__proto__"].map((routeId) =>
      JSON.stringify({ routeId, pathname: `/${routeId}`, search: "" }),
    ),
  ])("drops corrupt or invalid entry %s", (raw) => {
    storage.setItem("openclaw.native.lastRoute", raw);
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toBeNull();
    expect(storage.getItem("openclaw.native.lastRoute")).toBeNull();
  });

  it("does nothing outside the native host", () => {
    storage.setItem(
      "openclaw.native.lastRoute",
      JSON.stringify({ routeId: "usage", pathname: "/usage", search: "" }),
    );
    persistRoute("chat", "/chat/main", "", storage, false);
    expect(considerRouteRestore("chat", "/chat", "", storage, false)).toBeNull();
    expect(JSON.parse(storage.getItem("openclaw.native.lastRoute") ?? "{}")).toEqual({
      routeId: "usage",
      pathname: "/usage",
      search: "",
    });
  });

  it("restores only the default route without explicit search", () => {
    persistRoute("usage", "/usage", "", storage, true);
    expect(considerRouteRestore("chat", "/chat", "?approval=123", storage, true)).toBeNull();
    expect(considerRouteRestore("chat", "/chat/main", "", storage, true)).toBeNull();
    expect(considerRouteRestore("usage", "/usage", "", storage, true)).toBeNull();
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toEqual({
      routeId: "usage",
      pathname: "/usage",
      search: "",
    });
  });

  it("skips restoring the route it is already on", () => {
    persistRoute("chat", "/chat", "", storage, true);
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toBeNull();
  });

  it("strips transient action params before persisting", () => {
    persistRoute("chat", "/chat/main/deploy-12345678", "?draft=deploy%20", storage, true);
    expect(considerRouteRestore("chat", "/chat", "", storage, true)).toEqual({
      routeId: "chat",
      pathname: "/chat/main/deploy-12345678",
      search: "",
    });
  });
});
