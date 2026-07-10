/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLobsterdex, recordLobsterVisit } from "./lobster-dex.ts";

beforeEach(() => {
  // getSafeLocalStorage only accepts an own value property under Vitest, so
  // tests opt in by stubbing jsdom's storage onto globalThis.
  vi.stubGlobal("localStorage", window.localStorage);
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("lobsterdex", () => {
  it("records palettes once and round-trips through storage", () => {
    expect(getLobsterdex().size).toBe(0);
    recordLobsterVisit("crimson");
    recordLobsterVisit("gold");
    recordLobsterVisit("crimson");
    expect([...getLobsterdex()].toSorted()).toEqual(["crimson", "gold"]);
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem("openclaw.control.lobsterdex.v1", "{not json");
    expect(getLobsterdex().size).toBe(0);
    recordLobsterVisit("teal");
    expect(getLobsterdex().has("teal")).toBe(true);
  });
});
