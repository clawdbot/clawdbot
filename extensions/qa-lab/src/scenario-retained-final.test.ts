import { describe, expect, it } from "vitest";
import { startRetainedFinalScenario } from "./scenario-retained-final.test-support.js";

describe("failed-tool scenario retained final", () => {
  it("waits through preview deletion and final send until the exact inbound is acknowledged", async () => {
    const harness = await startRetainedFinalScenario();
    try {
      await harness.previewSent;
      await harness.waitObserved;
      harness.startFinal();
      await harness.deleteStarted;
      expect(
        harness.state
          .getSnapshot()
          .messages.filter((m) => m.direction === "outbound" && !m.deleted),
      ).toEqual([]);
      expect(harness.state.getAcknowledgedPollCursor("default")).toBe(0);
      expect(await harness.probePending()).toBeUndefined();
      harness.releaseDelete();
      await harness.finalStarted;
      expect(harness.state.getAcknowledgedPollCursor("default")).toBe(0);
      expect(await harness.probePending()).toBeUndefined();
      harness.releaseFinal();
      expect(await harness.result).toMatchObject({ status: "pass" });
      expect(harness.state.getAcknowledgedPollCursor("default")).toBeGreaterThanOrEqual(
        Number(harness.vars.inboundCursor),
      );
      expect(harness.vars.reply).toMatchObject({
        text: "The requested file could not be read: ENOENT. QA-FAILED-TOOL-FINALIZED-OK",
      });
    } finally {
      await harness.stop();
    }
  });

  it.each([
    {
      name: "preview-only with processing ack",
      previewOnly: true,
      error: "ordered preview send/delete/replacement chain",
    },
    {
      name: "deleted preview without final",
      failFinal: true,
      error: "expected exactly one failure-honest reply, got []",
    },
    {
      name: "duplicate retained final",
      duplicateFinal: true,
      error: "expected exactly one failure-honest reply",
    },
    {
      name: "typed error with matching text",
      typedError: true,
      error: "The requested file could not be read: ENOENT",
    },
    {
      name: "wrong account",
      finalRoute: { accountId: "foreign" },
      error: "retained reply has the wrong route",
    },
    {
      name: "wrong conversation",
      finalRoute: { to: "group:foreign" },
      error: "retained reply has the wrong route",
    },
    {
      name: "wrong conversation kind",
      finalRoute: { to: "channel:qa-failed-terminal" },
      error: "retained reply has the wrong route",
    },
    {
      name: "wrong thread",
      finalRoute: { threadId: "foreign" },
      error: "retained reply has the wrong route",
    },
    {
      name: "wrong reply target",
      finalRoute: { replyToId: "foreign" },
      error: "retained reply has the wrong route",
    },
  ])("rejects $name", async (fault) => {
    const harness = await startRetainedFinalScenario(fault);
    try {
      await harness.previewSent;
      await harness.waitObserved;
      harness.releaseDelete();
      harness.releaseFinal();
      harness.startFinal();
      expect(await harness.result).toMatchObject({
        status: "fail",
        details: expect.stringContaining(fault.error),
      });
      if (!fault.typedError) {
        expect(harness.state.getAcknowledgedPollCursor("default")).toBeGreaterThanOrEqual(
          Number(harness.vars.inboundCursor),
        );
      }
    } finally {
      await harness.stop();
    }
  });

  it("does not accept a later native control as the pending inbound's processing ack", async () => {
    const harness = await startRetainedFinalScenario();
    try {
      await harness.previewSent;
      harness.startFinal();
      await harness.deleteStarted;
      await harness.sendControl();
      expect(harness.state.getAcknowledgedPollCursor("default")).toBe(0);
      expect(await harness.probePending()).toBeUndefined();
      harness.expireDeadline();
      expect(await harness.result).toMatchObject({
        status: "fail",
        details: "injected processing acknowledgment deadline",
      });
    } finally {
      await harness.stop();
    }
  });
});
