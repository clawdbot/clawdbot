import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isSessionWorkStartInvalidatedError } from "../config/sessions/lifecycle.js";
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

const captureMocks = vi.hoisted(() => ({
  capture: vi.fn<CaptureSessionDiffBaseline>(),
}));

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

function expectInvalidated(result: PromiseSettledResult<unknown>, message: RegExp): void {
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(isSessionWorkStartInvalidatedError(result.reason)).toBe(true);
    expect(String(result.reason)).toMatch(message);
  }
}

describe("ensureSessionDiffBaseline", () => {
  beforeEach(() => {
    captureMocks.capture.mockReset();
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

  it("marks a thrown capture unavailable before rethrowing and never retries it", async () => {
    const sessionId = "failed-session";
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId,
      sessionDiffBaselineCapture: createSessionDiffBaselineCaptureClaim(),
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });
    captureMocks.capture.mockRejectedValue(new Error("capture failed"));

    await expect(
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ).rejects.toThrow("capture failed");
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
    ).resolves.toBe(unavailable);
    expect(captureMocks.capture).toHaveBeenCalledTimes(1);
  });

  it("does not retroactively capture a legacy existing session", async () => {
    const entry: InternalSessionEntry = {
      createdVia: "operator",
      sessionId: "legacy-session",
      updatedAt: Date.now(),
    };
    const target = await seedEntry({ entry });

    await expect(
      ensureSessionDiffBaseline({
        ...target,
        cwd: "/workspace",
        isNewSession: false,
      }),
    ).resolves.toBe(entry);
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
    expectInvalidated(settled, /was deleted while starting work/i);
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
    expectInvalidated(settled, /was deleted while starting work/i);
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
      expectInvalidated(result, /changed while starting work/i);
    }

    expect(loadInternal(target.sessionKey, target.storePath)).toMatchObject({
      lifecycleRevision: "fresh-generation",
      sessionDiffBaselineCapture: freshClaim,
    });
    expect(loadInternal(target.sessionKey, target.storePath)?.sessionDiffBaseline).toBeUndefined();
  });
});
