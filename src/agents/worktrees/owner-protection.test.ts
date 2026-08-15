import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedWorktreeOwnerProtection } from "./owner-protection.js";
import { IDLE_GC_MS } from "./service.js";

const mocks = vi.hoisted(() => ({
  resolveSessionEntryAccessTarget: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  resolveSessionEntryAccessTarget: mocks.resolveSessionEntryAccessTarget,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("createManagedWorktreeOwnerProtection", () => {
  it("protects only recently active session owners", () => {
    const now = 1_800_000_000_000;
    const entries: Record<string, { lastInteractionAt?: number; updatedAt?: number }> = {
      "agent:main:live": { lastInteractionAt: now - 1_000 },
      "agent:main:stale": { updatedAt: now - IDLE_GC_MS - 1 },
    };
    mocks.resolveSessionEntryAccessTarget.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => ({ entry: entries[sessionKey] }),
    );
    const shouldProtectOwner = createManagedWorktreeOwnerProtection({}, () => now);

    expect(shouldProtectOwner("session", "agent:main:live")).toBe(true);
    expect(shouldProtectOwner("session", "agent:main:stale")).toBe(false);
    expect(shouldProtectOwner("manual", "agent:main:live")).toBe(false);
    expect(shouldProtectOwner("session", "agent:main:missing")).toBe(false);
  });

  it("protects session owners when their state cannot be read", () => {
    mocks.resolveSessionEntryAccessTarget.mockImplementation(() => {
      throw new Error("unreadable session store");
    });
    const shouldProtectOwner = createManagedWorktreeOwnerProtection({});

    expect(shouldProtectOwner("session", "agent:main:live")).toBe(true);
  });
});
