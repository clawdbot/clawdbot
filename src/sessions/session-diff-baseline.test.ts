import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionWorkStartInvalidatedError } from "../config/sessions/lifecycle.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { createSessionDiffBaselineCaptureClaim } from "../config/sessions/session-diff-baseline-capture.js";
import type { InternalSessionEntry, SessionDiffBaseline } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";

type CaptureSessionDiffBaseline =
  (typeof import("./session-diff.js"))["captureSessionDiffBaseline"];
type PatchSessionEntryCore =
  (typeof import("../config/sessions/session-accessor.js"))["patchSessionEntryCore"];
type LoadSessionEntryReadOnly =
  (typeof import("../config/sessions/session-accessor.js"))["loadSessionEntryReadOnly"];

const captureMocks = vi.hoisted(() => ({
  capture: vi.fn<CaptureSessionDiffBaseline>(),
}));
const persistenceMocks = vi.hoisted(() => ({
  actualRead: undefined as LoadSessionEntryReadOnly | undefined,
  actualPatch: undefined as PatchSessionEntryCore | undefined,
  read: vi.fn<LoadSessionEntryReadOnly>(),
  patch: vi.fn<PatchSessionEntryCore>(),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  persistenceMocks.actualRead = actual.loadSessionEntryReadOnly;
  persistenceMocks.actualPatch = actual.patchSessionEntryCore;
  return {
    ...actual,
    loadSessionEntryReadOnly: persistenceMocks.read,
    patchSessionEntryCore: persistenceMocks.patch,
  };
});

vi.mock("./session-diff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-diff.js")>()),
  captureSessionDiffBaseline: captureMocks.capture,
}));

import { ensureSessionDiffBaseline } from "./session-diff-baseline.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function baseline(sessionId: string): SessionDiffBaseline {
  return {
    version: 1,
    sessionId,
    root: "/workspace",
    files: [],
  };
}

async function seedEntry(params: {
  entry: InternalSessionEntry;
  sessionKey?: string;
}): Promise<{ entry: InternalSessionEntry; sessionKey: string; storePath: string }> {
  const dir = tempDirs.make("openclaw-session-diff-owner-");
  const storePath = path.join(dir, "sessions.json");
  const sessionKey = params.sessionKey ?? "agent:main:diff-owner";
  await replaceSessionEntry({ sessionKey, storePath }, params.entry);
  return { entry: params.entry, sessionKey, storePath };
}

function loadInternal(sessionKey: string, storePath: string): InternalSessionEntry | undefined {
  return loadSessionEntry({ sessionKey, storePath }) as InternalSessionEntry | undefined;
}

function expectWorkStartError(
  result: PromiseSettledResult<unknown>,
  message: RegExp,
  code: "SESSION_WORK_START_CHANGED" | "SESSION_WORK_START_INVALIDATED",
): void {
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(result.reason).toMatchObject({ code });
    expect(String(result.reason)).toMatch(message);
  }
}

describe("ensureSessionDiffBaseline", () => {
  beforeEach(() => {
    captureMocks.capture.mockReset();
    persistenceMocks.read.mockReset();
    persistenceMocks.patch.mockReset();
    persistenceMocks.read.mockImplementation((...args) => {
      if (!persistenceMocks.actualRead) {
        throw new Error("missing actual session entry loader");
      }
      return persistenceMocks.actualRead(...args);
    });
    persistenceMocks.patch.mockImplementation((...args) => {
      if (!persistenceMocks.actualPatch) {
        throw new Error("missing actual session entry patcher");
      }
      return persistenceMocks.actualPatch(...args);
    });
  });

  it("settles a Gateway-precreated pending claim for an existing session", async () => {
    const sessionId = "precreated-session";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    captureMocks.capture.mockResolvedValue(baseline(sessionId));

    const settled = await ensureSessionDiffBaseline({
      ...target,
      cwd: "/workspace",
      isNewSession: false,
    });

    expect(settled.sessionDiffBaseline).toEqual(baseline(sessionId));
    expect(settled.sessionDiffBaselineCapture).toBeUndefined();
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      sessionDiffBaseline: baseline(sessionId),
    });
  });

  it("shares one capture across concurrent first-turn ensures", async () => {
    const sessionId = "concurrent-session";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);

    const first = ensureSessionDiffBaseline({
      ...target,
      cwd: "/workspace",
      isNewSession: true,
    });
    const second = ensureSessionDiffBaseline({
      ...target,
      cwd: "/workspace",
      isNewSession: true,
    });
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledTimes(1));
    capture.resolve(baseline(sessionId));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.sessionDiffBaseline).toEqual(baseline(sessionId));
    expect(secondResult.sessionDiffBaseline).toEqual(baseline(sessionId));
  });

  it.each([
    ["settled baseline", true],
    ["legacy no-baseline state", false],
  ] as const)(
    "rejects stale cached %s after the authoritative generation rotates",
    async (_label, withCachedBaseline) => {
      const sessionId = `stale-cached-${withCachedBaseline ? "settled" : "legacy"}`;
      const cachedEntry: InternalSessionEntry = {
        createdVia: "operator",
        lifecycleRevision: "cached-generation",
        sessionId,
        ...(withCachedBaseline ? { sessionDiffBaseline: baseline(sessionId) } : {}),
        updatedAt: Date.now(),
      };
      const target = await seedEntry({ entry: cachedEntry });
      const freshClaim = createSessionDiffBaselineCaptureClaim();
      await replaceSessionEntry(
        { sessionKey: target.sessionKey, storePath: target.storePath },
        {
          ...cachedEntry,
          lifecycleRevision: "fresh-generation",
          sessionDiffBaseline: undefined,
          sessionDiffBaselineCapture: freshClaim,
        },
      );

      await expect(
        ensureSessionDiffBaseline({
          ...target,
          cwd: "/workspace",
          entry: cachedEntry,
          isNewSession: false,
        }),
      ).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(captureMocks.capture).not.toHaveBeenCalled();
      expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
        lifecycleRevision: "fresh-generation",
        sessionDiffBaselineCapture: freshClaim,
      });
    },
  );

  it("settles an authoritative pending claim instead of returning a stale cached baseline", async () => {
    const sessionId = "same-generation-stale-settled";
    const cachedEntry: InternalSessionEntry = {
      createdVia: "operator",
      lifecycleRevision: "shared-generation",
      sessionId,
      sessionDiffBaseline: baseline(sessionId),
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry: cachedEntry });
    const pendingClaim = createSessionDiffBaselineCaptureClaim();
    await replaceSessionEntry(
      { sessionKey: target.sessionKey, storePath: target.storePath },
      {
        ...cachedEntry,
        sessionDiffBaseline: undefined,
        sessionDiffBaselineCapture: pendingClaim,
      },
    );
    const authoritativeBaseline = { ...baseline(sessionId), root: "/authoritative" };
    captureMocks.capture.mockResolvedValue(authoritativeBaseline);

    await expect(
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        entry: cachedEntry,
        isNewSession: false,
      }),
    ).resolves.toMatchObject({ sessionDiffBaseline: authoritativeBaseline });
    expect(captureMocks.capture).toHaveBeenCalledOnce();
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "shared-generation",
      sessionDiffBaseline: authoritativeBaseline,
    });
  });

  it("fails closed when the authoritative generation read fails", async () => {
    const sessionId = "settled-read-failure";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      lifecycleRevision: "read-failure-generation",
      sessionId,
      sessionDiffBaseline: baseline(sessionId),
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    persistenceMocks.read.mockImplementationOnce(() => {
      throw new Error("authoritative read failed");
    });

    await expect(
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ).rejects.toMatchObject({ code: "SESSION_WORK_START_INVALIDATED" });
    expect(captureMocks.capture).not.toHaveBeenCalled();
  });

  it("returns a terminal unavailable entry after capture failure and never retries it", async () => {
    const sessionId = "failed-session";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    captureMocks.capture.mockRejectedValue(new Error("capture failed"));

    const settled = await ensureSessionDiffBaseline({
      ...target,
      cwd: "/workspace",
      isNewSession: false,
    });
    expect(settled.sessionDiffBaselineCapture).toMatchObject({ status: "unavailable" });
    const unavailable = loadInternal(target.sessionKey, target.storePath);
    expect(unavailable?.sessionDiffBaselineCapture).toMatchObject({
      status: "unavailable",
    });
    if (!unavailable) {
      throw new Error("expected unavailable capture marker");
    }

    await expect(
      ensureSessionDiffBaseline({
        ...target,
        entry: unavailable,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ).resolves.toEqual(unavailable);
    expect(captureMocks.capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["captured baseline", false],
    ["terminal unavailable", true],
  ] as const)("fails closed when persisting %s fails", async (_label, captureFails) => {
    const sessionId = `settlement-failure-${captureFails ? "unavailable" : "baseline"}`;
    const claim = createSessionDiffBaselineCaptureClaim();
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: claim,
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    if (captureFails) {
      captureMocks.capture.mockRejectedValueOnce(new Error("capture failed"));
    } else {
      captureMocks.capture.mockResolvedValueOnce(baseline(sessionId));
    }
    persistenceMocks.patch.mockRejectedValueOnce(new Error("settlement write failed"));

    const [settled] = await Promise.allSettled([
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ]);
    if (!settled) {
      throw new Error("expected capture settlement");
    }
    expectWorkStartError(
      settled,
      /could not persist its diff baseline/i,
      "SESSION_WORK_START_INVALIDATED",
    );
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      sessionDiffBaselineCapture: claim,
    });
  });

  it("preserves an existing work-start invalidation from settlement persistence", async () => {
    const sessionId = "settlement-invalidation";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    const invalidation = new SessionWorkStartInvalidatedError(
      "session reset while persisting baseline",
    );
    captureMocks.capture.mockResolvedValueOnce(baseline(sessionId));
    persistenceMocks.patch.mockRejectedValueOnce(invalidation);

    await expect(
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ).rejects.toBe(invalidation);
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      sessionDiffBaselineCapture: entry.sessionDiffBaselineCapture,
    });
  });

  it("does not retroactively capture a legacy existing session", async () => {
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId: "legacy-session",
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });

    const authoritative = loadInternal(target.sessionKey, target.storePath);
    await expect(
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ).resolves.toEqual(authoritative);
    expect(captureMocks.capture).not.toHaveBeenCalled();
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject(entry);
    expect(loadInternal(target.sessionKey, target.storePath)).not.toHaveProperty(
      "sessionDiffBaselineCapture",
    );
  });

  it("arms an ordinary new operator rollover before capture", async () => {
    const sessionId = "operator-rollover";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    captureMocks.capture.mockResolvedValue(baseline(sessionId));

    const settled = await ensureSessionDiffBaseline({
      ...target,
      cwd: "/workspace",
      isNewSession: true,
    });

    expect(settled.sessionDiffBaseline).toEqual(baseline(sessionId));
    expect(captureMocks.capture).toHaveBeenCalledTimes(1);
  });

  it("rejects claim arming before mutating a replacement lifecycle generation", async () => {
    const sessionId = "replacement-before-arm";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      lifecycleRevision: "old-generation",
      sessionId,
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    persistenceMocks.patch.mockImplementationOnce(async (...args) => {
      await replaceSessionEntry(
        { sessionKey: target.sessionKey, storePath: target.storePath },
        { ...entry, lifecycleRevision: "replacement-generation" },
      );
      if (!persistenceMocks.actualPatch) {
        throw new Error("missing actual session entry patcher");
      }
      return await persistenceMocks.actualPatch(...args);
    });

    await expect(
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: true,
      }),
    ).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "replacement-generation",
      sessionId,
    });
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaselineCapture).toBe(
      undefined,
    );
    expect(captureMocks.capture).not.toHaveBeenCalled();
  });

  it("invalidates claim arming when the authoritative row is missing", async () => {
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId: "deleted-before-arm",
      updatedAt: Date.now(),
    };
    const storePath = path.join(tempDirs.make("openclaw-session-diff-missing-"), "sessions.json");

    const result = await Promise.allSettled([
      ensureSessionDiffBaseline({
        cwd: "/workspace",
        entry,
        isNewSession: true,
        sessionKey: "agent:main:missing-before-arm",
        storePath,
      }),
    ]);

    const [settled] = result;
    if (!settled) {
      throw new Error("expected claim-arm settlement");
    }
    expectWorkStartError(settled, /was deleted while starting work/i, "SESSION_WORK_START_CHANGED");
    expect(captureMocks.capture).not.toHaveBeenCalled();
  });

  it("invalidates capture completion after the authoritative row is deleted", async () => {
    const sessionId = "deleted-during-capture";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);
    const completion = ensureSessionDiffBaseline({
      ...target,
      cwd: "/workspace",
      isNewSession: false,
    });
    const outcome = Promise.allSettled([completion]);
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledOnce());
    await deleteSessionEntryLifecycle({
      archiveTranscript: false,
      storePath: target.storePath,
      target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
    });
    capture.resolve(baseline(sessionId));

    const [settled] = await outcome;
    if (!settled) {
      throw new Error("expected capture settlement");
    }
    expectWorkStartError(settled, /was deleted while starting work/i, "SESSION_WORK_START_CHANGED");
    expect(loadInternal(target.sessionKey, target.storePath)).toBeUndefined();
  });

  it("rejects an old completion after the same session id receives a fresh claim", async () => {
    const sessionId = "same-session-id";
    const oldClaim = createSessionDiffBaselineCaptureClaim();
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: oldClaim,
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);
    const oldCompletions = [
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ];
    const outcomes = Promise.allSettled(oldCompletions);
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledTimes(1));

    const freshClaim = createSessionDiffBaselineCaptureClaim();
    await replaceSessionEntry(
      { sessionKey: target.sessionKey, storePath: target.storePath },
      { ...entry, lifecycleRevision: "fresh-generation", sessionDiffBaselineCapture: freshClaim },
    );
    capture.resolve(baseline(sessionId));
    for (const result of await outcomes) {
      expectWorkStartError(result, /changed while starting work/i, "SESSION_WORK_START_CHANGED");
    }

    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "fresh-generation",
      sessionDiffBaselineCapture: freshClaim,
    });
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaseline).toBeUndefined();
  });

  it("rejects an old completion before mutating a same-claim replacement generation", async () => {
    const sessionId = "same-claim-replacement";
    const claim = createSessionDiffBaselineCaptureClaim();
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      lifecycleRevision: "old-generation",
      sessionId,
      sessionDiffBaselineCapture: claim,
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    const capture = createDeferredCore<SessionDiffBaseline>();
    captureMocks.capture.mockReturnValue(capture.promise);
    const completion = ensureSessionDiffBaseline({
      ...target,
      cwd: "/workspace",
      isNewSession: false,
    });
    const outcome = Promise.allSettled([completion]);
    await vi.waitFor(() => expect(captureMocks.capture).toHaveBeenCalledOnce());

    await replaceSessionEntry(
      { sessionKey: target.sessionKey, storePath: target.storePath },
      { ...entry, lifecycleRevision: "replacement-generation" },
    );
    capture.resolve(baseline(sessionId));

    const [settled] = await outcome;
    if (!settled) {
      throw new Error("expected capture settlement");
    }
    expectWorkStartError(settled, /changed while starting work/i, "SESSION_WORK_START_CHANGED");
    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "replacement-generation",
      sessionDiffBaselineCapture: claim,
    });
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaseline).toBeUndefined();
  });
});
