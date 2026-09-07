import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  BOOT_RECORD_PREFIX,
  clearBootRecords,
  persistBootRecord,
  readBootRecord,
  type BootRecord,
} from "./boot-record.ts";

const scope = "https://gateway.example";
const record = (): BootRecord => ({
  version: 1,
  scope,
  savedAt: Date.now(),
  profileId: "profile-a",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [{ name: "Work", position: 0 }],
  sectionOrder: ["category:Work", "ungrouped"],
});

async function settleWrite(): Promise<void> {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(500);
}

describe("Control UI boot record", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
  });
  afterEach(() => {
    clearBootRecords();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("round-trips a debounced record within its gateway scope", async () => {
    const saved = record();
    persistBootRecord(saved);
    expect(readBootRecord(scope)).toBeNull();
    await settleWrite();
    expect(readBootRecord(scope)).toEqual(saved);
    expect(readBootRecord("https://another.example")).toBeNull();
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong version", { ...record(), version: 2 }],
    ["wrong scope", { ...record(), scope: "https://another.example" }],
    ["invalid agent roster", { ...record(), agents: { defaultId: 42 } }],
    ["invalid group", { ...record(), groups: [{ name: "Work", position: "first" }] }],
    ["old record", { ...record(), savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 - 1 }],
    ["oversized record", { ...record(), sectionOrder: ["x".repeat(64 * 1024)] }],
  ])("removes %s without blocking startup", (_name, value) => {
    const key = BOOT_RECORD_PREFIX + scope;
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    expect(readBootRecord(scope)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("removes an existing record when a later write exceeds the byte cap", async () => {
    persistBootRecord(record());
    await settleWrite();
    expect(readBootRecord(scope)).not.toBeNull();
    persistBootRecord({ ...record(), sectionOrder: ["🦞".repeat((64 * 1024) / 3)] });
    await settleWrite();
    expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBeNull();
  });

  it("excludes avatars from the agent roster", async () => {
    const saved = record();
    saved.agents.agents = [
      { id: "main", identity: { name: "Main", avatar: "private", avatarUrl: "/avatar" } },
    ];
    persistBootRecord(saved);
    await settleWrite();
    expect(readBootRecord(scope)?.agents.agents[0]?.identity).toEqual({ name: "Main" });
  });

  it("clears all scopes and fences pending writes without clearing other settings", async () => {
    persistBootRecord(record());
    await settleWrite();
    persistBootRecord({ ...record(), scope: "https://another.example" });
    await settleWrite();
    localStorage.setItem("unrelated", "keep");
    persistBootRecord(record());
    clearBootRecords();
    await settleWrite();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("tolerates unavailable storage", async () => {
    vi.stubGlobal("localStorage", null);
    persistBootRecord(record());
    await settleWrite();
    expect(readBootRecord(scope)).toBeNull();
    expect(clearBootRecords).not.toThrow();
  });
});
