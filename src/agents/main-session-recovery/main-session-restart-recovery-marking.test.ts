import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  admitReplyTurn,
  runWithReplyOperationLifecycleAdmission,
} from "../../auto-reply/reply/reply-turn-admission.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionWorkAdmission,
  captureGatewaySessionWorkAdmissions,
  getSessionWorkAdmissionRelease,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { markRestartAbortedMainSessions } from "./main-session-restart-recovery-marking.js";

it("marks only the closing Gateway's exact active admissions", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-owner-"));
  const storePath = path.join(stateDir, "sessions.json");
  const resolveGatewayContext = () => undefined;
  const otherGatewayContext = () => undefined;
  const admissions: SessionWorkAdmissionLease[] = [];
  try {
    for (const [name, resolver] of [
      ["closing", resolveGatewayContext],
      ["other", otherGatewayContext],
    ] as const) {
      const sessionKey = `agent:main:${name}`;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: name, status: "running", updatedAt: Date.now() },
      );
      admissions.push(
        await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, name],
          resolveGatewayContext: resolver,
          assertAllowed: () => {},
        }),
      );
    }
    await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir,
      activeRuns: [],
      resolveGatewayContext,
    });
    expect(loadSessionEntry({ storePath, sessionKey: "agent:main:closing" })?.abortedLastRun).toBe(
      true,
    );
    expect(
      loadSessionEntry({ storePath, sessionKey: "agent:main:other" })?.abortedLastRun,
    ).toBeUndefined();
  } finally {
    admissions.forEach((admission) => admission.release());
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

it.each(["release", "completed", "rotation"] as const)(
  "does not commit a restart mark when %s invalidates its owner after planning",
  async (change) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-commit-"));
    const storePath = path.join(stateDir, "sessions.json");
    const sessionKey = "agent:main:closing";
    const sessionId = "closing";
    const resolveGatewayContext = () => undefined;
    let admission: SessionWorkAdmissionLease | undefined;
    const apply = sessionAccessor.applySessionEntryReplacements;
    let restoreSpy = () => {};
    try {
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId, status: "running", updatedAt: Date.now() },
      );
      admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [sessionKey, sessionId],
        resolveGatewayContext,
        assertAllowed: () => {},
      });
      const spy = vi
        .spyOn(sessionAccessor, "applySessionEntryReplacements")
        .mockImplementationOnce((params) =>
          apply({
            ...params,
            update: async (entries) => {
              const prepared = await params.update(entries);
              if (change === "rotation") {
                rotateAgentEventLifecycleGeneration();
              } else {
                admission?.release();
                if (change === "completed") {
                  sessionAccessor.replaceSessionEntrySync(
                    { storePath, sessionKey },
                    { sessionId, status: "done", updatedAt: Date.now(), endedAt: 123 },
                  );
                }
              }
              return prepared;
            },
          }),
        );
      restoreSpy = () => spy.mockRestore();
      const marking = markRestartAbortedMainSessions({
        cfg: { session: { store: storePath } },
        stateDir,
        activeRuns: [],
        resolveGatewayContext,
      });
      if (change !== "rotation") {
        await expect(marking).resolves.toEqual({ marked: 0, skipped: 1 });
      } else {
        await expect(marking).rejects.toMatchObject({ code: "ERR_STALE_GATEWAY_LIFECYCLE" });
      }
      expect(loadSessionEntry({ storePath, sessionKey })?.abortedLastRun).toBeUndefined();
      if (change === "completed") {
        expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
          status: "done",
          endedAt: 123,
        });
      }
    } finally {
      restoreSpy();
      admission?.release();
      closeOpenClawAgentDatabasesForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  },
);

it("does not adopt an ambient Gateway when moving an unbound reply owner", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-adoption-"));
  const storePath = path.join(stateDir, "sessions.json");
  const sessionKey = "agent:main:adopted";
  const sessionId = "adopted";
  const otherGatewayContext = () => undefined;
  const operation = createReplyOperation({
    sessionKey: "agent:main:command",
    sessionId,
    resetTriggered: false,
  });
  try {
    await replaceSessionEntry(
      { storePath, sessionKey },
      { sessionId, status: "running", updatedAt: Date.now() },
    );
    await withPluginRuntimeGatewayContextResolver(otherGatewayContext, async () => {
      const admission = await admitReplyTurn({
        sessionKey,
        sessionId,
        storePath,
        kind: "visible",
        resetTriggered: false,
        adoptOperation: operation,
      });
      expect(admission.status).toBe("owned");
      const observedScope = await runWithReplyOperationLifecycleAdmission(
        operation,
        async () => getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
      );
      expect({
        selected: captureGatewaySessionWorkAdmissions(otherGatewayContext).isActive({
          scope: storePath,
          sessionKey,
          sessionId,
        }),
        observedScope,
      }).toEqual({ selected: false, observedScope: undefined });
    });
  } finally {
    const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey] });
    operation.complete();
    await released;
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

it("keeps another active session recoverable when one owner releases after batch planning", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-batch-"));
  const storePath = path.join(stateDir, "sessions.json");
  const resolveGatewayContext = () => undefined;
  const admissions: SessionWorkAdmissionLease[] = [];
  const apply = sessionAccessor.applySessionEntryReplacements;
  let restoreSpy = () => {};
  try {
    for (const name of ["finishing", "still-active"]) {
      const sessionKey = `agent:main:${name}`;
      await replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: name, status: "done", updatedAt: Date.now() },
      );
      admissions.push(
        await beginSessionWorkAdmission({
          scope: storePath,
          identities: [sessionKey, name],
          resolveGatewayContext,
          assertAllowed: () => {},
        }),
      );
    }
    const spy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementationOnce((params) =>
        apply({
          ...params,
          update: async (entries) => {
            const prepared = await params.update(entries);
            admissions[0]!.release();
            return prepared;
          },
        }),
      );
    restoreSpy = () => spy.mockRestore();
    let error: unknown;
    let counts: { marked: number; skipped: number } | undefined;
    try {
      counts = await markRestartAbortedMainSessions({
        cfg: { session: { store: storePath } },
        stateDir,
        activeRuns: [],
        resolveGatewayContext,
      });
    } catch (caught) {
      error = caught;
    }
    const stillActive = loadSessionEntry({ storePath, sessionKey: "agent:main:still-active" });
    const observed = {
      counts,
      error: error instanceof Error ? error.message : error,
      survivingAdmissionActive: admissions[1]!.isActive(),
      survivingStatus: stillActive?.status,
      survivingRestartMarker: stillActive?.abortedLastRun,
    };
    expect(observed).toEqual({
      counts: { marked: 1, skipped: 1 },
      error: undefined,
      survivingAdmissionActive: true,
      survivingStatus: "running",
      survivingRestartMarker: true,
    });
  } finally {
    restoreSpy();
    admissions.forEach((admission) => admission.release());
    closeOpenClawAgentDatabasesForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
