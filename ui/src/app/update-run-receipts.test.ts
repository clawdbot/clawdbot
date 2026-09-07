// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunReceipts } from "./update-run-receipts.ts";

const TRIAGED_KEY = "openclaw:control-ui:update:v1";
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => vi.unstubAllGlobals());

describe("update browser receipts", () => {
  it("keeps result dismissal separate from automatic triage and scoped to Gateway and profile", () => {
    const receipts = createUpdateRunReceipts();
    expect(receipts.acknowledge("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(receipts.triaged("ws://gateway.test", "operator", "run-1")).toBe(false);
    expect(receipts.recordTriage("ws://gateway.test", "operator", "run-1")).toBe(true);
    const reloaded = createUpdateRunReceipts();
    expect(reloaded.acknowledged("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(reloaded.triaged("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(reloaded.acknowledged("ws://other.test", "operator", "run-1")).toBe(false);
    expect(reloaded.triaged("ws://gateway.test", "other", "run-1")).toBe(false);
    sessionStorage.clear();
    const nextTab = createUpdateRunReceipts();
    expect(nextTab.acknowledged("ws://gateway.test", "operator", "run-1")).toBe(true);
    expect(nextTab.triaged("ws://gateway.test", "operator", "run-1")).toBe(false);
  });

  it.each([
    "unavailable",
    "read denied",
    "quota exceeded",
    "invalid receipts",
    "oversized history",
  ])("does not admit automatic triage or overwrite history when storage is %s", (failure) => {
    const storage = createStorageMock();
    storage.setItem(
      TRIAGED_KEY,
      JSON.stringify({ triaged: [JSON.stringify(["ws://gateway.test", null, "previous"])] }),
    );
    if (failure === "invalid receipts") {
      storage.setItem(TRIAGED_KEY, JSON.stringify({ triaged: false }));
    }
    if (failure === "oversized history") {
      storage.setItem(TRIAGED_KEY, "x".repeat(150_000));
    }
    const previous = storage.getItem(TRIAGED_KEY);
    if (failure === "read denied") {
      vi.spyOn(storage, "getItem").mockImplementation(() => {
        throw new Error("Access denied");
      });
    }
    if (failure === "quota exceeded") {
      vi.spyOn(storage, "setItem").mockImplementation(() => {
        throw new Error("Quota exceeded");
      });
    }
    vi.stubGlobal("sessionStorage", failure === "unavailable" ? undefined : storage);
    const receipts = createUpdateRunReceipts();
    expect(receipts.recordTriage("ws://gateway.test", null, "new-failure")).toBe(false);
    expect(receipts.triaged("ws://gateway.test", null, "new-failure")).toBe(false);
    vi.restoreAllMocks();
    expect(storage.getItem(TRIAGED_KEY)).toBe(previous);
  });

  it("bounds retained receipts while keeping the newest diagnostic consumed", () => {
    const receipts = createUpdateRunReceipts();
    for (let index = 0; index <= 32; index++) {
      receipts.recordTriage("ws://gateway.test", null, String(index));
    }
    const reloaded = createUpdateRunReceipts();
    expect(reloaded.triaged("ws://gateway.test", null, "0")).toBe(false);
    expect(reloaded.triaged("ws://gateway.test", null, "1")).toBe(true);
    expect(reloaded.triaged("ws://gateway.test", null, "32")).toBe(true);
  });
  it.each(["2026.9.1", "2026.9.2", "both"])(
    "preserves consumed failures from %s through reload and the next write",
    (version) => {
      const receipt = (run: string) => JSON.stringify(["ws://gateway.test", null, run]);
      const previous = [];
      if (version !== "2026.9.2") {
        sessionStorage.setItem(TRIAGED_KEY, JSON.stringify({ triaged: [receipt("older")] }));
        previous.push("older");
      }
      if (version !== "2026.9.1") {
        sessionStorage.setItem(
          "openclaw:control-ui:update-triaged:v1",
          JSON.stringify([receipt("newer")]),
        );
        previous.push("newer");
      }
      const receipts = createUpdateRunReceipts();
      for (const run of previous) {
        expect(receipts.triaged("ws://gateway.test", null, run)).toBe(true);
      }
      expect(receipts.recordTriage("ws://gateway.test", null, "new-run")).toBe(true);
      expect(JSON.parse(sessionStorage.getItem(TRIAGED_KEY)!)).toEqual({
        triaged: [...previous, "new-run"].map(receipt),
      });
      const reloaded = createUpdateRunReceipts();
      for (const run of [...previous, "new-run"]) {
        expect(reloaded.triaged("ws://gateway.test", null, run)).toBe(true);
      }
      expect(sessionStorage.getItem("openclaw:control-ui:update-triaged:v1")).toBeNull();
    },
  );

  it.each(["not-json", JSON.stringify([42]), "x".repeat(32_768)])(
    "does not admit triage over unreadable 2026.9.2 receipts (%#)",
    (raw) => {
      sessionStorage.setItem("openclaw:control-ui:update-triaged:v1", raw);
      const receipts = createUpdateRunReceipts();
      expect(receipts.recordTriage("ws://gateway.test", null, "new-run")).toBe(false);
      expect(sessionStorage.getItem("openclaw:control-ui:update-triaged:v1")).toBe(raw);
      expect(sessionStorage.getItem(TRIAGED_KEY)).toBeNull();
    },
  );
});
