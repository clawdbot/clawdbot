import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

const target = {
  agentId: "main",
  sessionId: "failed-turn-session",
  sessionKey: "agent:main:main",
};
const runId = "failed-turn-run";
const error = "Worker turn rejected: cloud worker unavailable";
const event = {
  sessionId: target.sessionId,
  runId,
  ts: 2_000,
  data: { phase: "error", startedAt: 1_000, endedAt: 2_000, error },
};

async function seed(assistantBranch?: "active" | "inactive" | "other-run") {
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1_000,
    startedAt: 1_000,
    status: "running",
    lifecycleRunId: runId,
  });
  await replaceTranscriptEvents(target, [
    { type: "session", id: target.sessionId, version: CURRENT_SESSION_VERSION },
    {
      type: "message",
      id: "user-turn",
      parentId: null,
      message: { role: "user", content: "Please continue." },
    },
    ...(assistantBranch
      ? [
          {
            type: "message",
            id: "assistant-error",
            parentId: "user-turn",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Provider failed",
              __openclaw: { runId: assistantBranch === "other-run" ? "previous-run" : runId },
            },
          },
        ]
      : []),
    ...(assistantBranch === "inactive"
      ? [
          {
            type: "leaf",
            id: "selected-branch",
            parentId: "assistant-error",
            targetId: "user-turn",
          },
        ]
      : []),
  ]);
}

async function reports() {
  return (await loadTranscriptEvents(target)).filter(
    (entry) => isRecord(entry) && entry.customType === "run-failed-before-reply",
  );
}

describe("durable pre-reply run failure", () => {
  it("records one displayed failure per run and retains it after the next run starts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await persistGatewaySessionLifecycleEvent({ ...target, event });
      expect(await reports()).toMatchObject([
        {
          type: "custom_message",
          customType: "run-failed-before-reply",
          content: `This turn did not run: ${error}.`,
          display: true,
          details: { runId, error },
        },
      ]);
      await persistGatewaySessionLifecycleEvent({ ...target, event });
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ...event,
          runId: "next-run",
          ts: 3_000,
          data: { phase: "start", startedAt: 3_000 },
        },
      });
      expect(await reports()).toHaveLength(1);
    });
  });

  it.each(["active", "inactive", "other-run"] as const)(
    "checks assistant output on the %s branch for this run",
    async (branch) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await seed(branch);
        await persistGatewaySessionLifecycleEvent({ ...target, event });
        expect(await reports()).toHaveLength(branch === "active" ? 0 : 1);
      });
    },
  );

  it.each([
    { phase: "start" },
    { phase: "end" },
    { phase: "error", aborted: true, stopReason: "aborted" },
    { phase: "aborted" },
    { phase: "completed" },
  ])("does not report $phase / $stopReason", async (data) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await persistGatewaySessionLifecycleEvent({ ...target, event: { ...event, data } });
      expect(await reports()).toEqual([]);
    });
  });

  it("sanitizes and bounds the stored error", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      const secret = [
        String.fromCharCode(115, 107),
        "proj",
        "failure",
        "abcdefghijklmnopqrstuvwxyz",
      ].join("-");
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ...event,
          data: {
            ...event.data,
            error: `Worker rejected token=${secret}\n${"detail ".repeat(150)}`,
          },
        },
      });
      const entries = await reports();
      expect(entries).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toContain(secret);
      expect(entries[0]).toMatchObject({ details: { runId, error: expect.any(String) } });
      const report = entries[0] as { details: { error: string } };
      expect(report.details.error.length).toBeLessThanOrEqual(512);
      expect(report.details.error).not.toContain("\n");
    });
  });

  it.each(["session", "run"])("does not report a stale %s error", async (stale) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ...event,
          sessionId: stale === "session" ? "previous-session" : target.sessionId,
          runId: "previous-run",
          data: { ...event.data, startedAt: 500 },
        },
      });
      expect(await reports()).toEqual([]);
    });
  });

  it("does not report an error whose lifecycle write was refused", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seed();
      await expect(
        persistGatewaySessionLifecycleEvent({
          ...target,
          event,
          assertCommitAllowed: () => {
            throw new Error("Run authority expired");
          },
        }),
      ).rejects.toThrow("Run authority expired");
      expect(await reports()).toEqual([]);
    });
  });
});
