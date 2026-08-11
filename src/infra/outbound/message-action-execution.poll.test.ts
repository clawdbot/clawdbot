// Covers message-action poll handling through plugin dispatch and core gateway
// poll fallback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearMessageActionPollMocks,
  messageActionRunnerMocks as mocks,
  pollerConfig,
  pollerTestPlugin,
  resetMessageActionPollMocks,
  runPollAction,
} from "./message-action-runner.test-helpers.js";

describe("runMessageAction poll handling", () => {
  beforeEach(() => {
    resetMessageActionPollMocks();
  });

  afterEach(() => {
    clearMessageActionPollMocks();
  });
  it("passes shared poll fields and auto threadId to executePollAction", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        pollDurationHours: 2,
      },
      toolContext: {
        currentChannelId: "poller:123",
        currentThreadTs: "42",
      },
    });

    expect(call?.durationHours).toBe(2);
    expect(call?.threadId).toBe("42");
    expect(call?.ctx?.params?.threadId).toBe("42");
    expect(call?.ctx?.plugin).toBe(pollerTestPlugin);
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, "1.5", "soon"])(
    "rejects invalid pollDurationHours value %s",
    async (pollDurationHours) => {
      await expect(
        runPollAction({
          cfg: pollerConfig,
          actionParams: {
            channel: "poller",
            target: "poller:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationHours,
          },
        }),
      ).rejects.toThrow(/pollDurationHours must be a positive integer/i);
    },
  );

  it("passes inbound event kind to poll execution", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
      },
      inboundEventKind: "room_event",
    });

    expect(call?.ctx?.inboundEventKind).toBe("room_event");
  });

  it("copies the normalized idempotency key into poll execution context", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
        idempotencyKey: " run-1:message-tool:poll-1:fingerprint ",
      },
    });

    expect(call?.ctx?.idempotencyKey).toBe("run-1:message-tool:poll-1:fingerprint");
  });

  it("expands maxSelections when pollMulti is enabled", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
        pollMulti: true,
      },
    });

    expect(call?.maxSelections).toBe(3);
  });

  it("defaults maxSelections to one choice when pollMulti is omitted", async () => {
    const call = await runPollAction({
      cfg: pollerConfig,
      actionParams: {
        channel: "poller",
        target: "poller:123",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi", "Soup"],
      },
    });

    expect(call?.maxSelections).toBe(1);
  });
});
