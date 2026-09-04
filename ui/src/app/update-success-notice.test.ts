// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";

const { getSafeSessionStorageMock, reloadControlUiIfStaleMock, showToastMock } = vi.hoisted(() => ({
  getSafeSessionStorageMock: vi.fn(),
  reloadControlUiIfStaleMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock("../build-info.ts", () => ({
  reloadControlUiIfStale: reloadControlUiIfStaleMock,
}));
vi.mock("../i18n/index.ts", () => ({
  t: (_key: string, params?: Record<string, string>) => `Gateway updated · now on ${params?.sha}.`,
}));
vi.mock("../lib/toast.ts", () => ({ showToast: showToastMock }));
vi.mock("../local-storage.ts", () => ({
  getSafeSessionStorage: getSafeSessionStorageMock,
}));

describe("update success notice", () => {
  let createUpdateNoticeSession: typeof import("./update-success-notice.ts").createUpdateNoticeSession;

  beforeAll(async () => {
    // Discard any owner import that predates this suite's mocked boundaries.
    vi.resetModules();
    ({ createUpdateNoticeSession } = await import("./update-success-notice.ts"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getSafeSessionStorageMock.mockReturnValue(null);
    reloadControlUiIfStaleMock.mockReturnValue(false);
  });

  it("announces a non-reloading success when session storage is unavailable", () => {
    createUpdateNoticeSession("ws://gateway.test").announceVerifiedInstall(
      { version: "2026.8.11", sha: "abcdef1234567890" },
      { gateway: "ws://gateway.test", profileId: null },
    );

    expect(showToastMock).toHaveBeenCalledWith({
      message: "Gateway updated · now on abcdef1.",
    });
  });

  it.each(["handoff", "verified"] as const)(
    "hydrates the previous bundle's flat %s notice on upgrade",
    (kind) => {
      const storage = createStorageMock();
      getSafeSessionStorageMock.mockReturnValue(storage);
      const scope = { gateway: "ws://gateway.test", profileId: "operator" };
      // The outgoing bundle writes these flat v1 fields before its page reload.
      // Pending notices predate requestId; the replacement must retain them.
      const saved = {
        ...scope,
        kind,
        deadlineAtMs: Date.now() + 60_000,
        ...(kind === "handoff"
          ? { expectedVersion: "2.0.0", expectedSha: null, handoffId: "current-handoff" }
          : { version: "2.0.0", sha: "abcdef1234567890" }),
      };
      storage.setItem("openclaw:control-ui:update:v1", JSON.stringify(saved));

      const session = createUpdateNoticeSession(scope.gateway);
      expect(session.notice).toMatchObject(saved);
      if (kind === "handoff") {
        expect(session.notice).toMatchObject({ requestId: expect.any(String) });
        expect(createUpdateNoticeSession(scope.gateway).notice).toEqual(session.notice);
        expect(showToastMock).not.toHaveBeenCalled();
      } else {
        session.announceRecordedSuccess(scope);
        expect(showToastMock).toHaveBeenCalledOnce();
        expect(showToastMock).toHaveBeenCalledWith({
          message: "Gateway updated · now on abcdef1.",
        });
        expect(createUpdateNoticeSession(scope.gateway).notice).toBeNull();
      }
    },
  );

  it.each([
    "unavailable",
    "read denied",
    "quota exceeded",
    "invalid receipts",
    "oversized history",
  ])("does not consume triage or erase history when storage is %s", (failure) => {
    const storage = createStorageMock();
    getSafeSessionStorageMock.mockReturnValue(storage);
    const scope = { gateway: "ws://gateway.test", profileId: null };
    createUpdateNoticeSession(scope.gateway).recordTriage(scope, "previous");
    if (failure === "invalid receipts") {
      storage.setItem("openclaw:control-ui:update:v1", '{"triaged":false}');
    } else if (failure === "oversized history") {
      storage.setItem("openclaw:control-ui:update:v1", "x".repeat(150_000));
    }
    const previous = storage.getItem("openclaw:control-ui:update:v1");
    getSafeSessionStorageMock.mockReturnValue(
      failure === "unavailable"
        ? null
        : {
            get length() {
              return storage.length;
            },
            clear: storage.clear.bind(storage),
            key: storage.key.bind(storage),
            removeItem: storage.removeItem.bind(storage),
            getItem: (key: string) => {
              if (failure === "read denied") {
                throw new Error("Access denied");
              }
              return storage.getItem(key);
            },
            setItem: (key: string, value: string) => {
              if (failure === "quota exceeded") {
                throw new Error("Quota exceeded");
              }
              storage.setItem(key, value);
            },
          },
    );
    const session = createUpdateNoticeSession(scope.gateway);
    const admitted = session.recordTriage(scope, "new-failure");
    expect(session.hasTriaged(scope, "new-failure")).toBe(false);
    expect(admitted).toBe(false);
    session.announceVerifiedInstall({ version: "2.0.0", sha: "abcdef1234567890" }, scope);
    expect(showToastMock).toHaveBeenCalledOnce();
    expect(storage.getItem("openclaw:control-ui:update:v1")).toBe(previous);
  });

  it("preserves consumed identities when another receipt exceeds the size limit", () => {
    const storage = createStorageMock();
    getSafeSessionStorageMock.mockReturnValue(storage);
    const scope = { gateway: "ws://gateway.test", profileId: null };
    const session = createUpdateNoticeSession(scope.gateway);
    session.recordTriage(scope, "previous");
    const previous = storage.getItem("openclaw:control-ui:update:v1");
    const oversized = "x".repeat(150_000);
    const admitted = session.recordTriage(scope, oversized);
    expect(session.hasTriaged(scope, oversized)).toBe(false);
    expect(admitted).toBe(false);
    expect(storage.getItem("openclaw:control-ui:update:v1")).toBe(previous);
    expect(createUpdateNoticeSession(scope.gateway).hasTriaged(scope, "previous")).toBe(true);
  });

  it("retains the latest 32 consumed identities independently of pending and success notices", () => {
    getSafeSessionStorageMock.mockReturnValue(createStorageMock());
    const scope = { gateway: "ws://gateway.test", profileId: null };
    const session = createUpdateNoticeSession(scope.gateway);
    for (let index = 0; index <= 32; index += 1) {
      session.recordTriage(scope, String(index));
    }
    session.write({
      ...scope,
      kind: "handoff",
      requestId: "pending-request",
      handoffId: "pending-handoff",
      expectedVersion: "2.0.0",
      expectedSha: null,
      deadlineAtMs: Date.now() + 1_000,
    });

    const otherScope = { ...scope, gateway: "ws://other.test" };
    const other = createUpdateNoticeSession(otherScope.gateway);
    expect(other.notice).toBeNull();
    expect(other.hasTriaged(scope, "0")).toBe(false);
    expect(other.hasTriaged(scope, "1")).toBe(true);
    expect(other.hasTriaged(scope, "32")).toBe(true);
    expect(other.hasTriaged(otherScope, "32")).toBe(false);
    other.announceVerifiedInstall({ version: "2.0.0", sha: null }, otherScope);

    const reloaded = createUpdateNoticeSession(scope.gateway);
    expect(reloaded.notice).toBeNull();
    expect(reloaded.hasTriaged(scope, "1")).toBe(true);
    expect(reloaded.hasTriaged(scope, "32")).toBe(true);
  });
});
