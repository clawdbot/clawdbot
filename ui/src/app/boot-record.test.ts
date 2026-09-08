import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  clearBootRecords,
  persistBootRecord,
  readBootRecord,
  resolveBootRecordAuth,
  type BootRecord,
} from "./boot-record.ts";

const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";

const credential = () => "test-token";
const scope = "https://gateway.example";
const record = (): BootRecord => ({
  version: 2,
  authMethod: "token",
  credential: "9d17676d",
  scope,
  savedAt: Date.now(),
  profileId: "profile-a",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [{ name: "Work", position: 0 }],
  sectionOrder: ["category:Work", "ungrouped"],
});

async function settleWrite(): Promise<void> {
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips a debounced record within its gateway scope", async () => {
    const saved = record();
    persistBootRecord(saved);
    expect(readBootRecord(scope, credential)).toBeNull();
    await settleWrite();
    expect(readBootRecord(scope, credential)).toEqual(saved);
    expect(readBootRecord("https://another.example", credential)).toBeNull();
  });

  it.each(["pagehide", "hidden"])("flushes the latest pending record on %s", async (event) => {
    persistBootRecord(record());
    const saved = { ...record(), sectionOrder: ["ungrouped", "category:Work"] };
    persistBootRecord(saved);
    expect(readBootRecord(scope, credential)).toBeNull();

    if (event === "pagehide") {
      window.dispatchEvent(new Event("pagehide"));
    } else {
      const visibility = vi.spyOn(document, "visibilityState", "get");
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(readBootRecord(scope, credential)).toBeNull();
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    }

    expect(readBootRecord(scope, credential)).toEqual(saved);
    clearBootRecords();
    await vi.advanceTimersByTimeAsync(500);
    expect(readBootRecord(scope, credential)).toBeNull();
  });

  it.each([
    ["invalid JSON", "{"],
    ["version-1 record", { ...record(), version: 1 }],
    ["missing method", { ...record(), authMethod: undefined }],
    ["proxy method", { ...record(), authMethod: "trusted-proxy" }],
    ["missing fingerprint", { ...record(), credential: undefined }],
    ["wrong scope", { ...record(), scope: "https://another.example" }],
    ["invalid agent roster", { ...record(), agents: { defaultId: 42 } }],
    ["invalid group", { ...record(), groups: [{ name: "Work", position: "first" }] }],
    ["old record", { ...record(), savedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 - 1 }],
    ["oversized record", { ...record(), sectionOrder: ["x".repeat(64 * 1024)] }],
  ])("removes %s without blocking startup", (_name, value) => {
    const key = BOOT_RECORD_PREFIX + scope;
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    expect(readBootRecord(scope, credential)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it.each([undefined, "", "changed-token"])(
    "removes a record when the current credential is %s",
    async (current) => {
      persistBootRecord(record());
      await settleWrite();
      expect(readBootRecord(scope, () => current)).toBeNull();
      expect(localStorage.getItem(BOOT_RECORD_PREFIX + scope)).toBeNull();
    },
  );

  it.each(["token", "device-token"])(
    "compares the credential for the recorded %s method",
    async (authMethod) => {
      persistBootRecord({ ...record(), authMethod });
      await settleWrite();
      const current = vi.fn((method: string) =>
        method === authMethod ? "test-token" : "other-token",
      );
      expect(readBootRecord(scope, current)?.authMethod).toBe(authMethod);
      expect(current).toHaveBeenCalledExactlyOnceWith(authMethod);
    },
  );

  it.each(["password", "trusted-proxy", "tailscale", "bootstrap-token", "none", undefined])(
    "rejects %s identity even with both browser tokens present",
    (method) => {
      expect(resolveBootRecordAuth({ method, deviceToken: "test-token" }, "test-token")).toBeNull();
    },
  );

  it("binds the accepted method and uses the newly issued device token after retry", () => {
    expect(
      resolveBootRecordAuth({ method: "token", deviceToken: "other-token" }, " test-token "),
    ).toEqual({ authMethod: "token", credential: "9d17676d" });
    expect(
      resolveBootRecordAuth(
        { method: "device-token", deviceToken: "test-token" },
        "rejected-token",
      ),
    ).toEqual({ authMethod: "device-token", credential: "9d17676d" });
    expect(resolveBootRecordAuth({ method: "token", deviceToken: "test-token" }, "")).toBeNull();
    expect(resolveBootRecordAuth({ method: "device-token" }, "test-token")).toBeNull();
  });

  it("removes an existing record when a later write exceeds the byte cap", async () => {
    persistBootRecord(record());
    await settleWrite();
    expect(readBootRecord(scope, credential)).not.toBeNull();
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
    expect(readBootRecord(scope, credential)?.agents.agents[0]?.identity).toEqual({ name: "Main" });
  });

  it("clears all scopes and fences pending writes even on pagehide", async () => {
    persistBootRecord(record());
    await settleWrite();
    persistBootRecord({ ...record(), scope: "https://another.example" });
    await settleWrite();
    localStorage.setItem("unrelated", "keep");
    persistBootRecord(record());
    clearBootRecords();
    window.dispatchEvent(new Event("pagehide"));
    await settleWrite();
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("tolerates unavailable storage", async () => {
    vi.stubGlobal("localStorage", null);
    persistBootRecord(record());
    await settleWrite();
    expect(readBootRecord(scope, credential)).toBeNull();
    expect(clearBootRecords).not.toThrow();
  });
});
