// Tests collect-mode queue behavior, debounce, and drain semantics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy.js";
import {
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  refreshQueuedFollowupSession,
  scheduleFollowupDrain,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { resolveFollowupDeliveryContextKey } from "./queue/drain.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";

type InternalFollowupRun = FollowupRun & {
  currentTurnImagesPrepared?: true;
  mediaImageLayout?: {
    slots: Array<{ kind: "inline" | "offloaded"; factIndex?: number }>;
    suppressedFactIndexes: number[];
  };
};

installQueueRuntimeErrorSilencer();

function createQueueSettings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return {
    mode: "collect",
    debounceMs: 0,
    cap: 50,
    dropPolicy: "summarize",
    ...overrides,
  };
}

function enqueueTestRun(
  key: string,
  params: Parameters<typeof createRun>[0],
  settings: QueueSettings,
) {
  return enqueueFollowupRun(key, createRun(params), settings);
}

function createDrainRecorder(expectedCalls = 1) {
  const calls: Array<FollowupRun & { currentTurnImagesPrepared?: true }> = [];
  const done = createDeferred();
  const runFollowup = async (run: FollowupRun) => {
    calls.push(run);
    if (calls.length >= expectedCalls) {
      done.resolve();
    }
  };
  return { calls, done, runFollowup };
}

function createQueueCase(key: string, overrides: Partial<QueueSettings> = {}, expectedCalls = 1) {
  return { key, ...createDrainRecorder(expectedCalls), settings: createQueueSettings(overrides) };
}

function enqueueTestRuns(
  key: string,
  settings: QueueSettings,
  ...runs: Parameters<typeof createRun>[0][]
) {
  for (const run of runs) {
    enqueueTestRun(key, run, settings);
  }
}

async function drainRecordedQueue(
  key: string,
  runFollowup: ReturnType<typeof createDrainRecorder>["runFollowup"],
  done: ReturnType<typeof createDrainRecorder>["done"],
) {
  scheduleFollowupDrain(key, runFollowup);
  await done.promise;
}

describe("followup queue collect routing", () => {
  it("carries queued local cron-authority unavailability through a followup drain", async () => {
    const key = `test-followup-cron-authority-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const run = createRun({ prompt: "queued local operator turn" });
    run.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gateway:local",
      cronCreatorAuthorityUnavailable: "queued-local-operator",
      onAdopted: async () => {},
    };
    enqueueFollowupRun(key, run, { ...createQueueSettings(), mode: "followup" });

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable).toBe(
      "queued-local-operator",
    );
  });

  it("carries queued local cron-authority unavailability through a collect batch", async () => {
    const key = `test-collect-cron-authority-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const first = createRun({ prompt: "first queued turn" });
    first.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gateway:local",
      cronCreatorAuthorityUnavailable: "queued-local-operator",
      onAdopted: async () => {},
    };
    const second = createRun({ prompt: "second queued turn" });
    second.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gateway:local",
      onAdopted: async () => {},
    };
    const settings = createQueueSettings();
    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.turnAdoptionLifecycle?.cronCreatorAuthorityUnavailable).toBe(
      "queued-local-operator",
    );
  });

  it("marks exclusive admission without onAbandoned and isolates collect identity", () => {
    // Failure window: cancel-only used to be inferred from missing onAbandoned,
    // so exclusive admission without onAbandoned shared collect identity.
    const exclusiveNoAbandon = createRun({ prompt: "exclusive a" });
    exclusiveNoAbandon.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: async () => {},
    };
    const exclusiveSibling = createRun({ prompt: "exclusive b" });
    exclusiveSibling.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: async () => {},
    };
    const cancelOnly = createRun({ prompt: "cancel-only" });
    cancelOnly.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gw:owner",
      onAdopted: async () => {},
    };
    const cancelOnlyShared = createRun({ prompt: "cancel-only shared" });
    cancelOnlyShared.turnAdoptionLifecycle = {
      admission: "cancel-only",
      ownerKey: "gw:owner",
      onAdopted: async () => {},
    };

    const exclusiveA = resolveFollowupDeliveryContextKey(exclusiveNoAbandon);
    const exclusiveB = resolveFollowupDeliveryContextKey(exclusiveSibling);
    expect(exclusiveA).not.toEqual(exclusiveB);

    const cancelA = resolveFollowupDeliveryContextKey(cancelOnly);
    const cancelB = resolveFollowupDeliveryContextKey(cancelOnlyShared);
    expect(cancelA).toEqual(cancelB);
  });

  it("retries lifecycle admission after a callback rejection", async () => {
    const onAdmitted = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("admission failed"))
      .mockResolvedValueOnce();
    const run = createRun({ prompt: "retry admission" });
    run.turnAdoptionLifecycle = {
      onAdopted: onAdmitted,
      admission: "exclusive",
      onAbandoned: () => {},
    };

    await expect(admitFollowupRunLifecycle(run)).rejects.toThrow("admission failed");
    await expect(admitFollowupRunLifecycle(run)).resolves.toBeUndefined();
    await expect(admitFollowupRunLifecycle(run)).resolves.toBeUndefined();

    expect(onAdmitted).toHaveBeenCalledTimes(2);
  });

  it("serializes completion behind rejected admission and blocks later admission", async () => {
    const admissionStarted = createDeferred();
    const releaseAdmission = createDeferred();
    const admissionError = new Error("admission failed");
    const events: string[] = [];
    const onAdmitted = vi.fn(async () => {
      events.push("admission-started");
      admissionStarted.resolve();
      await releaseAdmission.promise;
      events.push("admission-rejected");
      throw admissionError;
    });
    const onComplete = vi.fn(() => {
      events.push("complete");
    });
    const run = createRun({ prompt: "complete during admission" });
    run.turnAdoptionLifecycle = {
      onAdopted: onAdmitted,
      onSettled: onComplete,
      admission: "exclusive",
      onAbandoned: () => {},
    };

    const admission = admitFollowupRunLifecycle(run);
    await admissionStarted.promise;

    completeFollowupRunLifecycle(run);
    expect(onComplete).not.toHaveBeenCalled();

    releaseAdmission.resolve();
    await expect(admission).rejects.toBe(admissionError);
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    await expect(admitFollowupRunLifecycle(run)).rejects.toThrow(
      "followup run lifecycle completed before admission",
    );
    expect(onAdmitted).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["admission-started", "admission-rejected", "complete"]);
  });

  it("does not enqueue when the external lifecycle rejects the run identity", () => {
    const key = `test-rejected-lifecycle-${Date.now()}`;
    const onEnqueued = vi.fn(() => false);
    const run = createRun({ prompt: "duplicate owner" });
    run.turnAdoptionLifecycle = { onAdopted: async () => {}, onDeferred: onEnqueued };

    const enqueued = enqueueFollowupRun(key, run, {
      mode: "followup",
      debounceMs: 10_000,
      cap: 50,
      dropPolicy: "summarize",
    });

    expect(enqueued).toBe(false);
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(key)?.items).toEqual([]);
    clearFollowupQueue(key);
  });

  it("does not collect when destinations differ", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-diff-to-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      },
      {
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
  });

  it("collects when channel+destination match", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-same-to-${Date.now()}`,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      },
      {
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingChannel).toBe("slack");
    expect(calls[0]?.originatingTo).toBe("channel:A");
    expect(calls[0]?.originatingChatType).toBe("channel");
  });

  it("collects Slack top-level messages when reply anchors are disabled", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-slack-reply-off-${Date.now()}`,
    );

    for (const [prompt, replyToId] of [
      ["one", "101.001"],
      ["two", "101.002"],
    ] as const) {
      enqueueTestRun(
        key,
        {
          prompt,
          messageId: replyToId,
          originatingChannel: "slack",
          originatingTo: "channel:A",
          originatingReplyToId: replyToId,
          originatingReplyToMode: "off",
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("splits collect batches when enabled reply anchors differ", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-slack-reply-all-${Date.now()}`,
      {},
      2,
    );

    for (const [prompt, replyToId] of [
      ["one", "101.001"],
      ["two", "101.002"],
    ] as const) {
      enqueueTestRun(
        key,
        {
          prompt,
          messageId: replyToId,
          originatingChannel: "slack",
          originatingTo: "channel:A",
          originatingReplyToId: replyToId,
          originatingReplyToMode: "all",
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt)).toEqual(["one", "two"]);
    expect(calls.map((call) => call.messageId)).toEqual(["101.001", "101.002"]);
  });

  it.each([
    ["first", " Slack "],
    ["batched", "SLACK"],
  ] as const)(
    "splits standalone Slack collect batches by message id in %s reply mode",
    async (replyToMode, originatingChannel) => {
      const { key, calls, done, settings } = createQueueCase(
        `test-collect-slack-standalone-${replyToMode}-${Date.now()}`,
      );

      for (const [prompt, messageId] of [
        ["one", "101.001"],
        ["two", "101.002"],
      ] as const) {
        enqueueTestRun(
          key,
          {
            prompt,
            messageId,
            originatingChannel,
            originatingTo: "channel:A",
            originatingReplyToMode: replyToMode,
            originatingChatType: "channel",
          },
          settings,
        );
      }

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        if (calls.length === 2) {
          done.resolve();
        }
      });
      await done.promise;

      expect(calls.map((call) => call.prompt)).toEqual(["one", "two"]);
      expect(calls.map((call) => call.messageId)).toEqual(["101.001", "101.002"]);
    },
  );

  it("collects distinct messages inside the same routed thread", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-shared-thread-${Date.now()}`,
    );

    for (const [prompt, messageId] of [
      ["one", "message-1"],
      ["two", "message-2"],
    ] as const) {
      enqueueTestRun(
        key,
        {
          prompt,
          messageId,
          originatingChannel: "telegram",
          originatingTo: "chat:1",
          originatingThreadId: "topic-1",
          originatingReplyToMode: "all",
          originatingChatType: "group",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("does not collect when captured reply modes differ on the same anchor", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-slack-reply-mode-${Date.now()}`,
      {},
      2,
    );

    for (const [prompt, messageId, replyToMode] of [
      ["first", "message-1", "first"],
      ["all", "message-2", "all"],
    ] as const) {
      enqueueTestRun(
        key,
        {
          prompt,
          messageId,
          originatingChannel: "slack",
          originatingTo: "channel:A",
          originatingReplyToId: "101.001",
          originatingReplyToMode: replyToMode,
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt)).toEqual(["first", "all"]);
    expect(calls.map((call) => call.originatingReplyToMode)).toEqual(["first", "all"]);
  });

  it("does not collect when chat types differ on the same destination", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-diff-chat-type-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "direct",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      },
      {
        prompt: "channel",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt)).toEqual(["direct", "channel"]);
    expect(calls.map((call) => call.originatingChatType)).toEqual(["direct", "channel"]);
  });

  it("does not collect when source delivery policy differs", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-diff-delivery-policy-${Date.now()}`,
      {},
      2,
    );
    const createPolicyRun = (
      prompt: string,
      sourceReplyDeliveryMode: NonNullable<FollowupRun["run"]["sourceReplyDeliveryMode"]>,
    ) => {
      const base = createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      });
      return {
        ...base,
        run: {
          ...base.run,
          sourceReplyDeliveryMode,
        },
      };
    };

    enqueueFollowupRun(key, createPolicyRun("automatic", "automatic"), settings);
    enqueueFollowupRun(key, createPolicyRun("private", "message_tool_only"), settings);
    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt)).toEqual([
      "[Queued messages while agent was busy]\n\n---\nQueued #1\nautomatic",
      "[Queued messages while agent was busy]\n\n---\nQueued #1\nprivate",
    ]);
    expect(calls.map((call) => call.run.sourceReplyDeliveryMode)).toEqual([
      "automatic",
      "message_tool_only",
    ]);
  });

  it("does not collect when task suggestion delivery differs", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-diff-task-suggestion-delivery-${Date.now()}`,
      {},
      2,
    );
    const createTaskRun = (prompt: string, taskSuggestionDeliveryMode?: "gateway") => {
      const base = createRun({
        prompt,
        originatingChannel: "webchat",
        originatingTo: "same-target",
        originatingChatType: "direct",
      });
      return {
        ...base,
        run: {
          ...base.run,
          taskSuggestionDeliveryMode,
        },
      };
    };

    enqueueFollowupRun(key, createTaskRun("legacy client"), settings);
    enqueueFollowupRun(key, createTaskRun("actionable client", "gateway"), settings);
    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.run.taskSuggestionDeliveryMode)).toEqual([
      undefined,
      "gateway",
    ]);
  });

  it("keeps overflow summaries on the dropped source chat type", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-chat-type-${Date.now()}`,
      { cap: 1 },
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "private direct content",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      },
      {
        prompt: "public channel content",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- private direct content");
    expect(calls[0]?.originatingChatType).toBe("direct");
    expect(calls[1]?.prompt).toContain("public channel content");
    expect(calls[1]?.originatingChatType).toBe("channel");
  });

  it("keeps overflow summaries on the dropped source route", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-route-${Date.now()}`,
      { cap: 1 },
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "channel A content",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      },
      {
        prompt: "channel B content",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.prompt).toContain("- channel A content");
    expect(calls[0]?.originatingTo).toBe("channel:A");
    expect(calls[1]?.prompt).toContain("channel B content");
    expect(calls[1]?.prompt).not.toContain("channel A content");
    expect(calls[1]?.originatingTo).toBe("channel:B");
  });

  it("does not attribute elided private drops to a public summary", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-elided-context-${Date.now()}`,
      { cap: 1 },
      3,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "private direct content",
        originatingChannel: "slack",
        originatingTo: "direct:A",
        originatingChatType: "direct",
      },
      {
        prompt: "older public content",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
      {
        prompt: "newer public content",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).not.toContain("older public content");
    expect(calls[0]?.prompt).toContain("- private direct content");
    expect(calls[0]?.originatingTo).toBe("direct:A");
    expect(calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[1]?.prompt).toContain("- older public content");
    expect(calls[1]?.prompt).not.toContain("private direct content");
    expect(calls[1]?.originatingTo).toBe("channel:B");
    expect(calls[2]?.prompt).toContain("newer public content");
  });

  it("keeps content in every context-isolated overflow summary", async () => {
    const key = `test-collect-overflow-all-context-lines-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder(6);
    const settings = createQueueSettings({ cap: 3 });
    const queued = [
      ["dropped A", "A"],
      ["dropped B", "B"],
      ["dropped C1", "C"],
      ["dropped C2", "C"],
      ["dropped D", "D"],
      ["dropped E", "E"],
      ["survivor 1", "survivor"],
      ["survivor 2", "survivor"],
      ["survivor 3", "survivor"],
    ] as const;

    for (const [prompt, target] of queued) {
      enqueueTestRun(
        key,
        {
          prompt,
          originatingChannel: "slack",
          originatingTo: `channel:${target}`,
          originatingChatType: "channel",
        },
        settings,
      );
    }

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls).toHaveLength(6);
    const overflowPrompts = calls.slice(0, 5).map((run) => run.prompt);
    expect(overflowPrompts).toEqual([
      expect.stringContaining("- dropped A"),
      expect.stringContaining("- dropped B"),
      expect.stringMatching(/- dropped C1[\s\S]*- dropped C2/),
      expect.stringContaining("- dropped D"),
      expect.stringContaining("- dropped E"),
    ]);
    expect(overflowPrompts[2]).toContain("Dropped 2 messages");
    expect(overflowPrompts.every((prompt) => prompt.includes("Summary:\n- "))).toBe(true);
    expect(calls[5]?.prompt).toContain("survivor 1");
    expect(calls[5]?.prompt).toContain("survivor 2");
    expect(calls[5]?.prompt).toContain("survivor 3");
  });

  it("evicts oldest overflow context metadata when the item cap is reached", () => {
    const key = `test-collect-overflow-elision-bound-${Date.now()}`;
    const settings = createQueueSettings({ cap: 2 });

    const accepted = ["A", "B", "A", "B", "A", "B", "survivor"].map((target, index) =>
      enqueueTestRun(
        key,
        {
          prompt: `message ${index}`,
          originatingChannel: "slack",
          originatingTo: `channel:${target}`,
          originatingChatType: "channel",
        },
        settings,
      ),
    );

    const queue = getExistingFollowupQueue(key);
    expect(accepted).toEqual([true, true, true, true, true, true, true]);
    expect(queue?.summaryElisions).toHaveLength(2);
    expect(queue?.summaryElisions.map((entry) => entry.sources.at(-1)?.originatingTo)).toEqual([
      "channel:B",
      "channel:A",
    ]);
    expect(queue?.evictedSummaryCount).toBe(1);
    expect(queue?.items.map((item) => item.originatingTo)).toEqual([
      "channel:B",
      "channel:survivor",
    ]);
    clearFollowupQueue(key);
  });

  it("bounds retained overflow cancellation identities by the item cap", () => {
    const key = `test-collect-overflow-source-bound-${Date.now()}`;
    const completions = Array.from({ length: 8 }, () => vi.fn());
    const settings = createQueueSettings({ cap: 2 });

    for (const [index, onComplete] of completions.entries()) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({
            prompt: `message ${index}`,
            originatingChannel: "slack",
            originatingTo: "channel:A",
            originatingChatType: "channel",
          }),
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
        },
        settings,
      );
    }

    const queue = getExistingFollowupQueue(key);
    expect(queue?.summaryElisions.flatMap((entry) => entry.sources)).toHaveLength(2);
    expect(
      queue?.summaryElisions.flatMap((entry) => entry.sources.map((source) => source.prompt)),
    ).toEqual(["message 2", "message 3"]);
    expect(queue?.evictedSummaryCount).toBe(2);
    expect(completions.map((onComplete) => onComplete.mock.calls.length)).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
    clearFollowupQueue(key);
  });

  it("does not register a drop:new source that the full queue rejects", () => {
    const key = `test-drop-new-lifecycle-${Date.now()}`;
    const onEnqueued = vi.fn();
    const onAbandoned = vi.fn();
    const onDisposition = vi.fn();
    const onComplete = vi.fn();
    const settings = createQueueSettings({ mode: "followup", cap: 1, dropPolicy: "new" });

    expect(enqueueFollowupRun(key, createRun({ prompt: "existing" }), settings)).toBe(true);
    expect(
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt: "rejected" }),
          onQueueDisposition: onDisposition,
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onDeferred: onEnqueued,
            onAbandoned,
            onSettled: onComplete,
          },
        },
        settings,
      ),
    ).toBe(false);

    expect(onEnqueued).not.toHaveBeenCalled();
    expect(onDisposition).toHaveBeenCalledWith("queue-cap-new");
    expect(onAbandoned).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual(["existing"]);
    clearFollowupQueue(key);
  });

  it("keeps retained excess contexts isolated after evicting the oldest metadata", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-evicted-context-${Date.now()}`,
      { cap: 1 },
      3,
    );

    const accepted = ["A", "B", "C", "D"].map((target) =>
      enqueueFollowupRun(
        key,
        createRun({
          prompt: `content ${target}`,
          originatingChannel: "slack",
          originatingTo: `channel:${target}`,
          originatingChatType: "channel",
        }),
        settings,
      ),
    );
    expect(accepted).toEqual([true, true, true, true]);

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.originatingTo)).toEqual([
      "channel:B",
      "channel:C",
      "channel:D",
    ]);
    expect(calls[0]?.prompt).toContain("Dropped 1 message");
    expect(calls[0]?.prompt).toContain("- content B");
    expect(calls[1]?.prompt).toContain("- content C");
    expect(calls[2]?.prompt).toContain("content D");
    expect(calls.every((call) => !call.prompt.includes("content A"))).toBe(true);
  });

  it("keeps overflow summaries under the dropped sender authorization", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-auth-${Date.now()}`,
      { cap: 1 },
      2,
    );
    const dropped = createRun({
      prompt: "guest content",
      originatingChannel: "slack",
      originatingTo: "channel:A",
      originatingChatType: "channel",
    });
    const survivor = createRun({
      prompt: "owner content",
      originatingChannel: "slack",
      originatingTo: "channel:A",
      originatingChatType: "channel",
    });

    enqueueFollowupRun(
      key,
      {
        ...dropped,
        run: {
          ...dropped.run,
          senderId: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...survivor,
        run: {
          ...survivor.run,
          senderId: "owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.prompt).toContain("- guest content");
    expect(calls[0]?.run.senderId).toBe("guest");
    expect(calls[0]?.run.senderIsOwner).toBe(false);
    expect(calls[1]?.prompt).toContain("owner content");
    expect(calls[1]?.prompt).not.toContain("guest content");
    expect(calls[1]?.run.senderId).toBe("owner");
    expect(calls[1]?.run.senderIsOwner).toBe(true);
  });

  it("uses the head item authorization for non-collect overflow delivery", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-followup-overflow-auth-${Date.now()}`,
      { mode: "followup", cap: 2 },
      3,
    );
    const guestRun = (prompt: string) => {
      const base = createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      });
      return {
        ...base,
        run: {
          ...base.run,
          senderId: "guest",
          senderIsOwner: false,
        },
      };
    };
    const owner = createRun({
      prompt: "owner content",
      originatingChannel: "slack",
      originatingTo: "channel:A",
      originatingChatType: "channel",
    });

    enqueueFollowupRun(key, guestRun("dropped guest"), settings);
    enqueueFollowupRun(key, guestRun("surviving guest"), settings);
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("- dropped guest");
    expect(calls[0]?.run.senderId).toBe("guest");
    expect(calls[0]?.run.senderIsOwner).toBe(false);
    expect(calls[1]?.prompt).toBe("surviving guest");
    expect(calls[1]?.run.senderId).toBe("guest");
    expect(calls[1]?.run.senderIsOwner).toBe(false);
    expect(calls[2]?.prompt).toBe("owner content");
    expect(calls[2]?.run.senderId).toBe("owner");
    expect(calls[2]?.run.senderIsOwner).toBe(true);
  });

  it("batches compatible overflow sources into one summary run", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-group-${Date.now()}`,
      { cap: 3 },
      2,
    );

    for (const prompt of ["direct A", "direct B", "direct C"] as const) {
      const source = createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      });
      enqueueFollowupRun(
        key,
        {
          ...source,
          run: {
            ...source.run,
            model: "model-c",
          },
        },
        settings,
      );
    }
    for (const prompt of ["channel D", "channel E", "channel F"]) {
      enqueueTestRun(
        key,
        {
          prompt,
          originatingChannel: "slack",
          originatingTo: "same-target",
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 3 messages due to cap.");
    expect(calls[0]?.prompt).toContain("- direct A");
    expect(calls[0]?.prompt).toContain("- direct B");
    expect(calls[0]?.prompt).toContain("- direct C");
    expect(calls[0]?.originatingChatType).toBe("direct");
    expect(calls[0]?.run.model).toBe("model-c");
    expect(calls[0]?.run.suppressNextUserMessagePersistence).toBeUndefined();
    expect(calls[0]?.run.suppressTranscriptOnlyAssistantPersistence).toBeUndefined();
    expect(calls[0]?.userTurnTranscriptRecorder?.isBlocked()).toBe(false);
    expect(JSON.stringify(calls[0]?.userTurnTranscriptRecorder?.message)).toContain(
      "[Queue overflow]",
    );
    expect(calls[1]?.prompt).toContain("channel D");
    expect(calls[1]?.prompt).toContain("channel E");
    expect(calls[1]?.prompt).toContain("channel F");
    expect(calls[1]?.originatingChatType).toBe("channel");
  });

  it("scopes overflow transcript idempotency to the source route", async () => {
    const settings = createQueueSettings({ cap: 1 });
    const drainRoute = async (to: string): Promise<FollowupRun[]> => {
      const key = `test-collect-overflow-route-key-${to}-${Date.now()}`;
      const { calls, done } = createDrainRecorder();
      for (const [prompt, messageId] of [
        ["dropped", "provider-local-id"],
        ["survivor", "survivor-id"],
      ] as const) {
        enqueueTestRun(
          key,
          {
            prompt,
            messageId,
            originatingChannel: "slack",
            originatingTo: to,
            originatingAccountId: "workspace",
            originatingThreadId: "thread",
            originatingReplyToId: "reply",
            originatingReplyToMode: "all",
            originatingChatType: "channel",
          },
          settings,
        );
      }
      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        if (calls.length >= 2) {
          done.resolve();
        }
      });
      await done.promise;
      return calls;
    };

    const firstCalls = await drainRoute("channel:A");
    const secondCalls = await drainRoute("channel:B");
    const firstMessage = firstCalls[0]?.userTurnTranscriptRecorder?.message as
      | { idempotencyKey?: string }
      | undefined;
    const secondMessage = secondCalls[0]?.userTurnTranscriptRecorder?.message as
      | { idempotencyKey?: string }
      | undefined;

    expect(firstCalls[0]?.prompt).toBe(secondCalls[0]?.prompt);
    expect(firstMessage?.idempotencyKey).toMatch(/^followup-overflow:/);
    expect(secondMessage?.idempotencyKey).toMatch(/^followup-overflow:/);
    expect(firstMessage?.idempotencyKey).not.toBe(secondMessage?.idempotencyKey);
  });

  it("uses the newest run for a fully elided overflow segment", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-elided-latest-run-${Date.now()}`,
      { cap: 1 },
      3,
    );

    for (const [prompt, model, authProfileId, chatType] of [
      ["first", "model-a", "auth-a", "direct"],
      ["second", "model-b", "auth-b", "direct"],
      ["retained", "model-c", "auth-c", "channel"],
      ["survivor", "model-d", "auth-d", "channel"],
    ] as const) {
      const source = createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: chatType,
      });
      enqueueFollowupRun(
        key,
        {
          ...source,
          run: {
            ...source.run,
            model,
            authProfileId,
          },
        },
        settings,
      );
    }

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls[0]?.prompt).toContain("Dropped 1 message");
    expect(calls[0]?.prompt).toContain("- second");
    expect(calls[0]?.run.model).toBe("model-b");
    expect(calls[0]?.run.authProfileId).toBe("auth-b");
    expect(calls[1]?.prompt).toContain("- retained");
    expect(calls[2]?.prompt).toContain("survivor");
  });

  it("splits overflow groups when source delivery policy changes", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-delivery-policy-${Date.now()}`,
      { cap: 2 },
      3,
    );
    const createSource = (
      prompt: string,
      sourceReplyDeliveryMode: NonNullable<FollowupRun["run"]["sourceReplyDeliveryMode"]>,
    ) => {
      const base = createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      });
      return {
        ...base,
        run: {
          ...base.run,
          sourceReplyDeliveryMode,
        },
      };
    };

    enqueueFollowupRun(key, createSource("automatic source", "automatic"), settings);
    enqueueFollowupRun(key, createSource("private source", "message_tool_only"), settings);
    for (const prompt of ["survivor one", "survivor two"]) {
      enqueueTestRun(
        key,
        {
          prompt,
          originatingChannel: "slack",
          originatingTo: "channel:B",
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("- automatic source");
    expect(calls[0]?.run.sourceReplyDeliveryMode).toBe("automatic");
    expect(calls[1]?.prompt).toContain("- private source");
    expect(calls[1]?.run.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(calls[2]?.prompt).toContain("survivor one");
    expect(calls[2]?.prompt).toContain("survivor two");
  });

  it("splits overflow groups when runtime policy identity changes", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-runtime-policy-${Date.now()}`,
      { cap: 2 },
      3,
    );
    const createSource = (prompt: string, runtimePolicySessionKey: string) => {
      const base = createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      });
      return {
        ...base,
        run: {
          ...base.run,
          runtimePolicySessionKey,
        },
      };
    };

    enqueueFollowupRun(key, createSource("policy one", "policy:one"), settings);
    enqueueFollowupRun(key, createSource("policy two", "policy:two"), settings);
    for (const prompt of ["survivor one", "survivor two"]) {
      enqueueTestRun(
        key,
        {
          prompt,
          originatingChannel: "slack",
          originatingTo: "channel:B",
          originatingChatType: "channel",
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("- policy one");
    expect(calls[0]?.run.runtimePolicySessionKey).toBe("policy:one");
    expect(calls[1]?.prompt).toContain("- policy two");
    expect(calls[1]?.run.runtimePolicySessionKey).toBe("policy:two");
    expect(calls[2]?.prompt).toContain("survivor one");
    expect(calls[2]?.prompt).toContain("survivor two");
  });

  it("preserves the source message id for standalone overflow summaries", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-message-id-${Date.now()}`,
      { cap: 1 },
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "dropped source",
        messageId: "message-42",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingChatType: "channel",
      },
      {
        prompt: "survivor",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.prompt).toContain("- dropped source");
    expect(calls[0]?.messageId).toBe("message-42");
    expect(calls[1]?.prompt).toContain("survivor");
  });

  it.each([
    ["dropped", undefined, "channel"],
    ["surviving", "direct", undefined],
  ] as const)(
    "separates overflow when the %s chat type is missing",
    async (_missingSide, droppedChatType, survivingChatType) => {
      const { key, calls, done, runFollowup, settings } = createQueueCase(
        `test-collect-overflow-missing-chat-${_missingSide}-${Date.now()}`,
        { cap: 1 },
        2,
      );

      enqueueTestRuns(
        key,
        settings,
        {
          prompt: "dropped content",
          originatingChannel: "slack",
          originatingTo: "same-target",
          originatingChatType: droppedChatType,
        },
        {
          prompt: "surviving content",
          originatingChannel: "slack",
          originatingTo: "same-target",
          originatingChatType: survivingChatType,
        },
      );

      await drainRecordedQueue(key, runFollowup, done);

      expect(calls[0]?.prompt).toContain("- dropped content");
      expect(calls[0]?.originatingChatType).toBe(droppedChatType);
      expect(calls[1]?.prompt).toContain("surviving content");
      expect(calls[1]?.originatingChatType).toBe(survivingChatType);
    },
  );

  it("drops an aborted split summary before running the surviving item", async () => {
    const key = `test-collect-overflow-current-run-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const controller = new AbortController();
    const droppedBase = createRun({
      prompt: "private direct content",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "direct",
    });
    const survivingBase = createRun({
      prompt: "public channel content",
      originatingChannel: "slack",
      originatingTo: "same-target",
      originatingChatType: "channel",
    });
    const settings = createQueueSettings({ cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...droppedBase,
        abortSignal: controller.signal,
        currentInboundContext: { text: "private runtime context" },
        run: {
          ...droppedBase.run,
          model: "old-model",
          senderId: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...survivingBase,
        run: {
          ...survivingBase.run,
          model: "old-model",
          senderId: "owner",
          senderIsOwner: true,
        },
      },
      settings,
    );
    controller.abort();
    refreshQueuedFollowupSession({
      key,
      nextModel: "current-model",
    });

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.run.model).toBe("current-model");
    expect(calls[0]?.run.requestedRouteResolution).toBe("raw");
    expect(calls[0]?.originatingChatType).toBe("channel");
    expect(calls[0]?.run.senderId).toBe("owner");
    expect(calls[0]?.run.senderIsOwner).toBe(true);
  });

  it("removes a delivered split summary by source identity after concurrent enqueue", async () => {
    const key = `test-collect-overflow-concurrent-source-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const done = createDeferred();
    const settings = createQueueSettings({ cap: 1 });

    enqueueTestRun(
      key,
      {
        prompt: "source A",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      },
      settings,
    );
    enqueueTestRun(
      key,
      {
        prompt: "source B",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "channel",
      },
      settings,
    );

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return;
      }
      if (calls.length >= 3) {
        done.resolve();
      }
    });
    await firstStarted.promise;

    enqueueTestRun(
      key,
      {
        prompt: "surviving C",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "channel",
      },
      settings,
    );
    releaseFirst.resolve();
    await done.promise;

    expect(calls[0]?.prompt).toContain("- source A");
    expect(calls[0]?.originatingChatType).toBe("direct");
    expect(calls[1]?.prompt).toContain("- source B");
    expect(calls[1]?.prompt).not.toContain("source A");
    expect(calls[1]?.originatingChatType).toBe("channel");
    expect(calls[2]?.prompt).toContain("surviving C");
    expect(calls[2]?.prompt).not.toContain("source A");
    expect(calls[2]?.prompt).not.toContain("source B");
    expect(calls[2]?.originatingChatType).toBe("channel");
  });

  it("does not deliver a context group again after concurrent overflow summarizes it", async () => {
    const key = `test-collect-overflow-stale-context-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const settings = createQueueSettings({ cap: 2 });
    const createContextRun = (prompt: string, chatType: "direct" | "channel") =>
      createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: chatType,
      });

    enqueueFollowupRun(key, createContextRun("context A", "direct"), settings);
    enqueueFollowupRun(key, createContextRun("context B", "channel"), settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    });
    await firstStarted.promise;

    enqueueFollowupRun(key, createContextRun("context C", "channel"), settings);
    enqueueFollowupRun(key, createContextRun("context D", "channel"), settings);
    releaseFirst.resolve();

    await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());
    const contextBCalls = calls.filter((run) => run.prompt.includes("context B"));

    expect(contextBCalls).toHaveLength(1);
    expect(contextBCalls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
  });

  it("retries split overflow summaries after transient failure", async () => {
    const key = `test-collect-overflow-split-retry-${Date.now()}`;
    const prompts: string[] = [];
    const done = createDeferred();
    const onComplete = vi.fn();
    let attempt = 0;
    const settings = createQueueSettings({ cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "private source",
          originatingChannel: "slack",
          originatingTo: "same-target",
          originatingChatType: "direct",
        }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      },
      settings,
    );
    enqueueTestRun(
      key,
      {
        prompt: "public survivor",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "channel",
      },
      settings,
    );

    scheduleFollowupDrain(key, async (run) => {
      attempt += 1;
      prompts.push(run.prompt);
      if (attempt === 1) {
        throw new Error("transient summary failure");
      }
      if (attempt >= 3) {
        done.resolve();
      }
    });
    await done.promise;

    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("- private source");
    expect(prompts[1]).toContain("- private source");
    expect(prompts[2]).toContain("public survivor");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("keeps deferred overflow summary text paired with its source route", async () => {
    const { key, calls, done, settings } = createQueueCase(
      `test-collect-overflow-deferred-pairs-${Date.now()}`,
      { cap: 1 },
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "source A",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      },
      {
        prompt: "source B",
        originatingChannel: "slack",
        originatingTo: "same-target",
        originatingChatType: "direct",
      },
    );

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        enqueueTestRun(
          key,
          {
            prompt: "surviving C",
            originatingChannel: "slack",
            originatingTo: "same-target",
            originatingChatType: "channel",
          },
          settings,
        );
        throw new FollowupRunDeferredError();
      }
      if (calls.length >= 3) {
        done.resolve();
      }
    });
    await done.promise;

    expect(calls[1]?.prompt).toContain("- source B");
    expect(calls[1]?.prompt).not.toContain("source A");
    expect(calls[1]?.originatingChatType).toBe("direct");
    expect(calls[2]?.prompt).toContain("surviving C");
    expect(calls[2]?.prompt).not.toContain("source A");
    expect(calls[2]?.prompt).not.toContain("source B");
    expect(calls[2]?.originatingChatType).toBe("channel");
  });

  it("collects compatible items after one cross-channel drain", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-after-cross-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "first route",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      },
      {
        prompt: "second route one",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      },
      {
        prompt: "second route two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("first route");
    expect(calls[1]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[1]?.prompt).toContain("Queued #1\nsecond route one");
    expect(calls[1]?.prompt).toContain("Queued #2\nsecond route two");
    expect(calls[1]?.originatingChannel).toBe("slack");
    expect(calls[1]?.originatingTo).toBe("channel:B");
  });

  it("drains unresolved-origin items separately from a routed batch", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-unresolved-origin-${Date.now()}`,
      {},
      2,
    );

    enqueueFollowupRun(key, createRun({ prompt: "unresolved origin" }), settings);
    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "keyed one",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
      {
        prompt: "keyed two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.prompt).toContain("Queued #1\nunresolved origin");
    expect(calls[0]?.prompt).not.toContain("keyed one");
    expect(calls[0]?.originatingChannel).toBeUndefined();
    expect(calls[1]?.prompt).toContain("Queued #1\nkeyed one");
    expect(calls[1]?.prompt).toContain("Queued #2\nkeyed two");
    expect(calls[1]?.originatingChannel).toBe("slack");
    expect(calls[1]?.originatingTo).toBe("channel:B");
    expect(calls[1]?.originatingChatType).toBe("channel");
  });

  it("does not collect known route-less chat types into another destination", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-known-chat-without-route-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "unresolved direct",
        originatingChatType: "direct",
      },
      {
        prompt: "channel one",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
      {
        prompt: "channel two",
        originatingChannel: "slack",
        originatingTo: "channel:B",
        originatingChatType: "channel",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.prompt).toBe("unresolved direct");
    expect(calls[0]?.originatingChatType).toBe("direct");
    expect(calls[1]?.prompt).toContain("channel one");
    expect(calls[1]?.prompt).toContain("channel two");
    expect(calls[1]?.prompt).not.toContain("unresolved direct");
    expect(calls[1]?.originatingChatType).toBe("channel");
  });

  it("collects ordinary user-request followups with current turn kind", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-user-request-kind-${Date.now()}`,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        currentInboundEventKind: "user_request",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      },
      {
        prompt: "two",
        currentInboundEventKind: "user_request",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.prompt).toContain("Queued #1");
    expect(calls[0]?.prompt).toContain("Queued #2");
  });

  it("drains runtime-context followups individually instead of collecting them", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-runtime-context-${Date.now()}`,
      {},
      2,
    );
    const controller = new AbortController();
    const begin = () => () => undefined;
    const lifecycle = { onAdopted: async () => {}, onSettled: () => undefined };

    enqueueTestRun(
      key,
      {
        prompt: "[OpenClaw room event]",
        originatingChannel: "telegram",
        originatingTo: "-100123",
      },
      settings,
    );
    const first = getExistingFollowupQueue(key)?.items[0];
    if (!first) {
      throw new Error("expected queued followup");
    }
    first.currentInboundEventKind = "room_event";
    first.currentInboundAudio = true;
    first.currentInboundContext = { text: "room event body" };
    first.abortSignal = controller.signal;
    first.deliveryCorrelations = [{ begin }];
    first.turnAdoptionLifecycle = lifecycle;
    enqueueTestRun(
      key,
      {
        prompt: "second",
        originatingChannel: "telegram",
        originatingTo: "-100123",
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("[OpenClaw room event]");
    expect(calls[0]?.currentInboundEventKind).toBe("room_event");
    expect(calls[0]?.currentInboundAudio).toBe(true);
    expect(calls[0]?.currentInboundContext?.text).toBe("room event body");
    expect(calls[0]?.abortSignal).toBe(controller.signal);
    expect(calls[0]?.deliveryCorrelations?.[0]?.begin).toBe(begin);
    expect(calls[0]?.turnAdoptionLifecycle).toBe(lifecycle);
    expect(calls[1]?.prompt).toBe("second");
  });

  it("drains a disableCollectBatching retry individually instead of collecting it", async () => {
    const strandedReplyRetryMarker = "stranded-reply-retry";
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-disable-batching-${Date.now()}`,
      {},
      3,
    );

    const route = { originatingChannel: "slack" as const, originatingTo: "channel:A" };
    const retryPrompt = "[System] Please deliver this reply now by calling message(action=send).";

    enqueueFollowupRun(key, createRun({ prompt: "normal one", ...route }), settings);
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: retryPrompt, ...route }),
        summaryLine: strandedReplyRetryMarker,
        disableCollectBatching: true,
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "normal two", ...route }), settings);

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    const retryCall = calls.find((call) => call.prompt === retryPrompt);
    expect(retryCall).toBeDefined();
    expect(retryCall?.prompt).not.toContain("[Queued messages while agent was busy]");
    expect(retryCall?.prompt).not.toContain("Queued #");
    expect(retryCall?.summaryLine).toBe(strandedReplyRetryMarker);
    for (const call of calls) {
      if (call.prompt.includes(retryPrompt)) {
        expect(call.prompt).not.toContain("normal one");
        expect(call.prompt).not.toContain("normal two");
      }
    }
  });

  it("can prepend priority followups before already queued items", () => {
    const key = `test-priority-followup-front-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup" });

    enqueueFollowupRun(key, createRun({ prompt: "queued later one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "queued later two" }), settings);
    enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );

    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
      "queued later one",
      "queued later two",
    ]);
    expect(getExistingFollowupQueue(key)?.items[0]?.protectFromQueueOverflow).toBe(true);
  });

  it("preserves prepended priority followups during old-item overflow eviction", () => {
    const key = `test-priority-followup-overflow-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 2, dropPolicy: "old" });

    enqueueFollowupRun(key, createRun({ prompt: "queued later one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "queued later two" }), settings);
    enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    enqueueFollowupRun(key, createRun({ prompt: "queued later three" }), settings);

    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
      "queued later three",
    ]);
  });

  it("keeps a cap-one protected priority followup instead of evicting it", () => {
    const key = `test-priority-followup-cap-one-${Date.now()}`;
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    const priorityAccepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    const normalAccepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "normal after priority" }),
      settings,
    );

    expect(priorityAccepted).toBe(true);
    expect(normalAccepted).toBe(false);
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
    ]);
    expect(getExistingFollowupQueue(key)?.summarySources).toHaveLength(0);
  });

  it("does not advance debounce stamp when overflow rejects an incoming message", () => {
    const key = `test-priority-followup-debounce-reject-${Date.now()}`;
    const settings = createQueueSettings({
      mode: "followup",
      debounceMs: 5_000,
      cap: 1,
      dropPolicy: "old",
    });

    const priorityAccepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    const queue = getExistingFollowupQueue(key);
    expect(priorityAccepted).toBe(true);
    expect(queue).toBeDefined();
    const stampedAt = queue!.lastEnqueuedAt;
    expect(stampedAt).toBeGreaterThan(0);

    const rejected = enqueueFollowupRun(key, createRun({ prompt: "busy chat noise" }), settings);
    expect(rejected).toBe(false);
    expect(getExistingFollowupQueue(key)?.lastEnqueuedAt).toBe(stampedAt);
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
    ]);
  });

  it("leaves the queue untouched when protected overflow cannot drop enough items", () => {
    const key = `test-priority-followup-atomic-overflow-${Date.now()}`;
    const initialSettings: QueueSettings = {
      mode: "followup",
      debounceMs: 0,
      cap: 3,
      dropPolicy: "summarize",
    };
    const shrunkSettings: QueueSettings = {
      ...initialSettings,
      cap: 1,
    };

    enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      initialSettings,
      "none",
      undefined,
      false,
      { position: "front" },
    );
    enqueueFollowupRun(key, createRun({ prompt: "normal one" }), initialSettings);
    enqueueFollowupRun(key, createRun({ prompt: "normal two" }), initialSettings);

    const accepted = enqueueFollowupRun(
      key,
      createRun({ prompt: "normal after shrink" }),
      shrunkSettings,
    );

    expect(accepted).toBe(false);
    expect(getExistingFollowupQueue(key)?.items.map((item) => item.prompt)).toEqual([
      "priority retry",
      "normal one",
      "normal two",
    ]);
    expect(getExistingFollowupQueue(key)?.summarySources).toHaveLength(0);
    expect(getExistingFollowupQueue(key)?.summaryLines).toHaveLength(0);
  });

  it("drains protected priority followups before overflow summaries", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-priority-followup-before-summary-${Date.now()}`,
      { mode: "followup", cap: 1 },
      2,
    );

    enqueueFollowupRun(key, createRun({ prompt: "overflowed normal" }), settings);
    enqueueFollowupRun(
      key,
      createRun({ prompt: "priority retry" }),
      settings,
      "none",
      undefined,
      false,
      { position: "front" },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toBe("priority retry");
    expect(calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[1]?.prompt).toContain("- overflowed normal");
  });

  it("carries image payloads across collected batches", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-images-${Date.now()}`,
    );
    const firstImage = { type: "image" as const, data: "first", mimeType: "image/png" };
    const secondImage = { type: "image" as const, data: "second", mimeType: "image/png" };

    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "one",
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        images: [firstImage],
        imageOrder: ["inline"],
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "two",
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        images: [secondImage],
        imageOrder: ["inline"],
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.images).toEqual([firstImage, secondImage]);
    expect(calls[0]?.imageOrder).toEqual(["inline", "inline"]);
  });

  it("preserves prepared empty image state across collected batches", async () => {
    const key = `test-collect-prepared-empty-images-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const settings = createQueueSettings();
    const missingMedia = {
      path: "/openclaw-test-missing/current.png",
      contentType: "image/png",
      hydrationSuppressed: true,
    };

    for (const prompt of ["one", "two"]) {
      const preparedRun: InternalFollowupRun = {
        ...createRun({
          prompt,
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        currentTurnImagesPrepared: true,
        images: [],
        imageOrder: [],
        media: [missingMedia],
        mediaImageLayout: { slots: [], suppressedFactIndexes: [0] },
      };
      enqueueFollowupRun(key, preparedRun, settings);
    }

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    const collected = calls[0] as InternalFollowupRun | undefined;
    expect(collected?.currentTurnImagesPrepared).toBe(true);
    expect(collected?.images).toEqual([]);
    expect(collected?.imageOrder).toEqual([]);
    expect(collected?.media).toEqual([missingMedia, missingMedia]);
    expect(collected?.mediaImageLayout).toEqual({
      slots: [],
      suppressedFactIndexes: [0, 1],
    });
  });

  it("offsets prepared media layout fact indexes across collected batches", async () => {
    const key = `test-collect-prepared-image-layout-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const settings = createQueueSettings();

    for (const [index, prompt] of ["one", "two"].entries()) {
      const preparedRun: InternalFollowupRun = {
        ...createRun({
          prompt,
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        currentTurnImagesPrepared: true,
        images: [],
        imageOrder: ["offloaded"],
        media: [{ path: `/tmp/offloaded-${index}.png`, contentType: "image/png" }],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }],
          suppressedFactIndexes: [],
        },
      };
      enqueueFollowupRun(key, preparedRun, settings);
    }

    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect((calls[0] as InternalFollowupRun | undefined)?.mediaImageLayout).toEqual({
      slots: [
        { kind: "offloaded", factIndex: 0 },
        { kind: "offloaded", factIndex: 1 },
      ],
      suppressedFactIndexes: [],
    });
  });

  it("splits collect batches when sender authorization changes", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-auth-split-${Date.now()}`,
      {},
      2,
    );

    const nonOwner = createRun({
      prompt: "use the gateway tool",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    enqueueFollowupRun(
      key,
      {
        ...nonOwner,
        run: {
          ...nonOwner.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    const owner = createRun({
      prompt: "what's the weather?",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.run.senderIsOwner)).toEqual([false, true]);
    expect(calls[0]?.prompt).toContain("use the gateway tool");
    expect(calls[0]?.prompt).not.toContain("what's the weather?");
    expect(calls[1]?.prompt).toContain("what's the weather?");
    expect(calls[1]?.prompt).toContain("(from Owner)");
  });

  it("preserves sender-scoped batching while identity collection is disabled", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(false);
    try {
      const { key, calls, done, runFollowup, settings } = createQueueCase(
        `test-collect-identity-disabled-${Date.now()}`,
        {},
        2,
      );
      for (const senderId of ["user-1", "user-2"]) {
        const item = createRun({
          prompt: `from ${senderId}`,
          originatingChannel: "slack",
          originatingTo: "channel:A",
        });
        enqueueFollowupRun(
          key,
          {
            ...item,
            run: { ...item.run, senderId, senderIsOwner: false },
          },
          settings,
        );
      }

      await drainRecordedQueue(key, runFollowup, done);
      await vi.waitFor(() => expect(getExistingFollowupQueue(key)).toBeUndefined());

      expect(calls.map((call) => call.run.senderId)).toEqual(["user-1", "user-2"]);
    } finally {
      cleanup();
    }
  });

  it("keeps same-participant evidence for a collected batch", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const sameCase = createQueueCase(`test-collect-identity-same-${Date.now()}`);
      for (const prompt of ["same one", "same two"]) {
        const item = createRun({
          prompt,
          originatingChannel: "slack",
          originatingTo: "channel:A",
        });
        enqueueFollowupRun(
          sameCase.key,
          {
            ...item,
            channelAdmissionEvidence: createChannelParticipantAdmissionEvidence({
              channelId: "slack",
              accountId: "default",
              participantId: "user-1",
            }),
            run: { ...item.run, senderId: "user-1", senderIsOwner: false },
          },
          sameCase.settings,
        );
      }
      await drainRecordedQueue(sameCase.key, sameCase.runFollowup, sameCase.done);
      await vi.waitFor(() => expect(getExistingFollowupQueue(sameCase.key)).toBeUndefined());
      expect(sameCase.calls).toHaveLength(1);
      expect(sameCase.calls[0]?.run.senderId).toBe("user-1");
      expect(
        consumeChannelAdmissionEvidence(sameCase.calls[0]?.channelAdmissionEvidence),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
      });
    } finally {
      cleanup();
    }
  });

  it("splits collect batches when queued cancellation owners differ", async () => {
    const key = `test-collect-cancel-owner-split-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder(2);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    for (const [prompt, ownerKey] of [
      ["first", "connection:one"],
      ["second", "connection:two"],
    ] as const) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({
            prompt,
            originatingChannel: "webchat",
            originatingTo: "session:main",
          }),
          turnAdoptionLifecycle: { onAdopted: async () => {}, ownerKey },
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).not.toContain("second");
    expect(calls[1]?.prompt).toContain("second");
    expect(calls[1]?.prompt).not.toContain("first");
  });

  it("splits collect batches when queued authority facts change", async () => {
    const key = `test-collect-queued-authority-split-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder(3);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const route = { originatingChannel: "slack" as const, originatingTo: "channel:A" };
    const pluginGrant = createRun({ prompt: "plugin grant", ...route });
    pluginGrant.run.runtimePluginToolGrant = {
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    };
    const scheduled = createRun({ prompt: "scheduled authority", ...route });
    scheduled.run.scheduledToolPolicy = { version: 1, mode: "trusted" };
    const handoff = createRun({ prompt: "trusted handoff", ...route });
    handoff.run.trustedInternalHandoff = {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-5.6-luna",
    };

    enqueueFollowupRun(key, pluginGrant, settings);
    enqueueFollowupRun(key, scheduled, settings);
    enqueueFollowupRun(key, handoff, settings);
    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls.map((call) => call.prompt)).toEqual([
      expect.stringContaining("plugin grant"),
      expect.stringContaining("scheduled authority"),
      expect.stringContaining("trusted handoff"),
    ]);
    expect(calls[0]?.run.runtimePluginToolGrant).toEqual(pluginGrant.run.runtimePluginToolGrant);
    expect(calls[1]?.run.scheduledToolPolicy).toEqual(scheduled.run.scheduledToolPolicy);
    expect(calls[2]?.run.trustedInternalHandoff).toEqual(handoff.run.trustedInternalHandoff);
  });

  it("drains different provider and model routes under their own run snapshots", async () => {
    const key = `test-collect-route-authority-split-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder(3);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const route = { originatingChannel: "slack" as const, originatingTo: "channel:A" };
    const first = createRun({ prompt: "first route", ...route });
    first.run.provider = "openai";
    first.run.model = "gpt-primary";
    const second = createRun({ prompt: "second route", ...route });
    second.run.provider = "openai";
    second.run.model = "gpt-fallback";
    const third = createRun({ prompt: "third route", ...route });
    third.run.provider = "anthropic";
    third.run.model = "gpt-fallback";

    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);
    enqueueFollowupRun(key, third, settings);
    scheduleFollowupDrain(key, runFollowup);
    await done.promise;

    expect(calls.map((call) => [call.prompt, call.run.provider, call.run.model])).toEqual([
      [expect.stringContaining("first route"), "openai", "gpt-primary"],
      [expect.stringContaining("second route"), "openai", "gpt-fallback"],
      [expect.stringContaining("third route"), "anthropic", "gpt-fallback"],
    ]);
  });

  it("keys collect batches by turn allowlists, intersections, disablement, and roles", () => {
    const createAuthorityRun = () =>
      createRun({
        prompt: "authority",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      });
    const baseline = createAuthorityRun();
    const toolsAllow = createAuthorityRun();
    toolsAllow.toolsAllow = ["exec"];
    const disabled = createAuthorityRun();
    disabled.disableTools = true;
    const roles = createAuthorityRun();
    roles.run.memberRoleIds = ["operator"];
    const firstIntersection = createAuthorityRun();
    firstIntersection.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
    const secondIntersection = createAuthorityRun();
    secondIntersection.toolsAllow = attachToolAllowlistIntersection(
      ["exec"],
      [["exec"], ["message"]],
    );

    const baselineKey = resolveFollowupDeliveryContextKey(baseline);
    expect(resolveFollowupDeliveryContextKey(toolsAllow)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryContextKey(disabled)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryContextKey(roles)).not.toBe(baselineKey);
    expect(resolveFollowupDeliveryContextKey(firstIntersection)).not.toBe(
      resolveFollowupDeliveryContextKey(secondIntersection),
    );
  });

  it("keeps one collect batch when authorization context matches", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-auth-match-${Date.now()}`,
    );

    const first = createRun({
      prompt: "first",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const second = createRun({
      prompt: "second",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: {
          ...first.run,
          senderId: "user-1",
          senderName: "Guest",
          senderUsername: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: {
          ...second.run,
          senderId: "user-1",
          senderName: "Guest",
          senderUsername: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.abortSignal).toBeUndefined();
    expect(calls[0]?.prompt).toContain("(from Guest)");
  });

  it("keeps one collect batch when only sender display fields drift", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-auth-display-drift-${Date.now()}`,
    );

    const first = createRun({
      prompt: "first",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const second = createRun({
      prompt: "second",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: {
          ...first.run,
          senderId: "user-1",
          senderName: "Guest",
          senderUsername: "guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: {
          ...second.run,
          senderId: "user-1",
          senderName: "Guest User",
          senderUsername: "guest-renamed",
          senderIsOwner: false,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.prompt).toContain("(from Guest)");
    expect(calls[0]?.prompt).toContain("(from Guest User)");
  });

  it("splits collect batches when exec context changes", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-exec-split-${Date.now()}`,
      {},
      2,
    );

    const base = createRun({
      prompt: "first",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...base,
        run: {
          ...base.run,
          senderId: "owner-1",
          senderIsOwner: true,
          bashElevated: { enabled: false, allowed: true, defaultLevel: "off" },
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({
          prompt: "second",
          originatingChannel: "slack",
          originatingTo: "channel:A",
        }),
        run: {
          ...base.run,
          senderId: "owner-1",
          senderIsOwner: true,
          bashElevated: { enabled: true, allowed: true, defaultLevel: "on" },
          execOverrides: { ask: "always" },
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).not.toContain("second");
    expect(calls[1]?.prompt).toContain("second");
    expect(calls[1]?.run.bashElevated?.enabled).toBe(true);
    expect(calls[1]?.run.execOverrides?.ask).toBe("always");
  });

  it("uses the newest run within a matching authorization batch", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-latest-run-${Date.now()}`,
    );

    const first = createRun({ prompt: "first", originatingChannel: "slack", originatingTo: "A" });
    const second = createRun({
      prompt: "second",
      originatingChannel: "slack",
      originatingTo: "A",
    });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: {
          ...first.run,
          provider: "openai",
          model: "gpt-5.4",
          senderId: "user-1",
          senderName: "First Name",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: {
          ...second.run,
          provider: "openai",
          model: "gpt-5.4",
          senderId: "user-1",
          senderName: "Newest Name",
          senderIsOwner: false,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.run.provider).toBe("openai");
    expect(calls[0]?.run.model).toBe("gpt-5.4");
    expect(calls[0]?.run.senderName).toBe("Newest Name");
  });

  it("delivers summary-only collect work under its source route", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-summary-only-${Date.now()}`,
      { cap: 2 },
      3,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "first",
        originatingChannel: "slack",
        originatingTo: "channel:A",
      },
      {
        prompt: "second",
        originatingChannel: "slack",
        originatingTo: "channel:B",
      },
      {
        prompt: "third",
        originatingChannel: "slack",
        originatingTo: "channel:C",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- first");
    expect(calls[0]?.originatingTo).toBe("channel:A");
    expect(calls[1]?.prompt).toBe("second");
    expect(calls[2]?.prompt).toBe("third");
  });

  it("preserves collect order when authorization changes more than once", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-auth-order-${Date.now()}`,
      {},
      3,
    );

    const first = createRun({ prompt: "first", originatingChannel: "slack", originatingTo: "A" });
    const second = createRun({ prompt: "second", originatingChannel: "slack", originatingTo: "A" });
    const third = createRun({ prompt: "third", originatingChannel: "slack", originatingTo: "A" });

    enqueueFollowupRun(
      key,
      {
        ...first,
        run: { ...first.run, senderId: "user-a", senderName: "A", senderIsOwner: false },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...second,
        run: { ...second.run, senderId: "owner-1", senderName: "Owner", senderIsOwner: true },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...third,
        run: { ...third.run, senderId: "user-a", senderName: "A", senderIsOwner: false },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt)).toEqual([
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from A)\nfirst",
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from Owner)\nsecond",
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from A)\nthird",
    ]);
  });

  it("collects Slack messages in same thread and preserves string thread id", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-slack-thread-same-${Date.now()}`,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      },
      {
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
  });

  it("collects messages when numeric and string thread ids share the route key", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-thread-normalized-${Date.now()}`,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: 42.9,
      },
      {
        prompt: "two",
        originatingChannel: "telegram",
        originatingTo: "-100123",
        originatingThreadId: "42",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("[Queued messages while agent was busy]");
    expect(calls[0]?.prompt).toContain("one");
    expect(calls[0]?.prompt).toContain("two");
  });

  it("collects matching local webchat routes with distinct message ids", async () => {
    const key = `test-collect-local-webchat-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        messageId: "webchat-message-1",
        originatingChannel: "webchat",
        originatingReplyToMode: "all",
      },
      {
        prompt: "two",
        messageId: "webchat-message-2",
        originatingChannel: "webchat",
        originatingReplyToMode: "all",
      },
    );
    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("one");
    expect(calls[0]?.prompt).toContain("two");
  });

  it("does not collect Slack messages when thread ids differ", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-slack-thread-diff-${Date.now()}`,
      {},
      2,
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "one",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000001",
      },
      {
        prompt: "two",
        originatingChannel: "slack",
        originatingTo: "channel:A",
        originatingThreadId: "1706000000.000002",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toBe("one");
    expect(calls[1]?.prompt).toBe("two");
    expect(calls[0]?.originatingThreadId).toBe("1706000000.000001");
    expect(calls[1]?.originatingThreadId).toBe("1706000000.000002");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const key = `test-collect-retry-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      done.resolve();
    };
    const settings = createQueueSettings();

    enqueueFollowupRun(key, createRun({ prompt: "one" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "two" }), settings);

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toContain("Queued #1\none");
    expect(calls[0]?.prompt).toContain("Queued #2\ntwo");
  });

  it("retries only the remaining collect auth groups after a partial failure", async () => {
    const key = `test-collect-partial-retry-${Date.now()}`;
    const attempts: FollowupRun[] = [];
    const successfulCalls: FollowupRun[] = [];
    const done = createDeferred();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      attempts.push(run);
      if (attempt === 2) {
        throw new Error("transient failure");
      }
      successfulCalls.push(run);
      if (attempt >= 3) {
        done.resolve();
      }
    };
    const settings = createQueueSettings();

    const guest = createRun({
      prompt: "guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const owner = createRun({
      prompt: "owner message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...guest,
        run: {
          ...guest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    const guestAttempts = attempts.filter((call) => call.prompt.includes("guest message"));
    const ownerAttempts = attempts.filter((call) => call.prompt.includes("owner message"));

    expect(attempts).toHaveLength(3);
    expect(guestAttempts).toHaveLength(1);
    expect(ownerAttempts).toHaveLength(2);
    expect(successfulCalls.map((call) => call.prompt)).toEqual([
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from Guest)\nguest message",
      "[Queued messages while agent was busy]\n\n---\nQueued #1 (from Owner)\nowner message",
    ]);
  });

  it("retries overflow summary delivery without losing dropped previews", async () => {
    const key = `test-overflow-summary-retry-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("transient failure");
      }
      calls.push(run);
      done.resolve();
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);

    await drainRecordedQueue(key, runFollowup, done);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- first");
  });

  it("persists overflow summaries to the session selected after queue admission", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-overflow-session-"));
    const storePath = path.join(tempDir, "sessions.json");
    const oldTranscriptPath = path.join(tempDir, "old-session.jsonl");
    const { key, calls, done, settings } = createQueueCase(
      `test-overflow-summary-session-rotation-${Date.now()}`,
      { mode: "followup", cap: 1 },
    );

    try {
      await replaceSessionEntry(
        { storePath, sessionKey: "agent:agent:main" },
        {
          sessionId: "new-session",
          updatedAt: Date.now(),
        },
      );
      const first = createRun({ prompt: "first" });
      first.run.sessionId = "old-session";
      first.run.sessionKey = "agent:agent:main";
      first.run.sessionFile = oldTranscriptPath;
      first.run.config = { session: { store: storePath } };
      const second = createRun({ prompt: "second" });
      second.run = first.run;

      enqueueFollowupRun(key, first, settings);
      enqueueFollowupRun(key, second, settings);
      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        done.resolve();
      });
      await done.promise;

      const recorder = calls[0]?.userTurnTranscriptRecorder;
      expect(recorder).toBeDefined();
      const persisted = await recorder?.persistFallback();
      expect(persisted?.sessionFile).toBe("agent:agent:main");
      await expect(
        loadTranscriptEvents({
          agentId: "agent",
          sessionId: "new-session",
          sessionKey: "agent:agent:main",
          storePath,
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: expect.stringContaining("[Queue overflow] Dropped 1 message due to cap."),
          }),
          type: "message",
        }),
      );
      await expect(fs.stat(oldTranscriptPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearFollowupQueue(key);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps overflow summaries when aborts remove only the live item", async () => {
    const key = `test-overflow-summary-aborted-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const cleaned: FollowupRun[] = [];
    const settings = createQueueSettings({ mode: "followup", cap: 1 });
    const controller = new AbortController();
    const onComplete = vi.fn();

    enqueueFollowupRun(key, createRun({ prompt: "dropped" }), settings);
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "aborted" }),
        abortSignal: controller.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      },
      settings,
    );
    controller.abort();

    scheduleFollowupDrain(key, async (run) => {
      if (run.abortSignal?.aborted) {
        cleaned.push(run);
        return;
      }
      calls.push(run);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("- dropped");
    expect(cleaned.map((run) => run.prompt)).toEqual(["aborted"]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(key)).toBeUndefined();
  });

  it("delivers the overflow summary before split auth groups", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-collect-overflow-summary-once-${Date.now()}`,
      { cap: 2 },
      3,
    );

    const droppedGuest = createRun({
      prompt: "dropped guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const guest = createRun({
      prompt: "guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const owner = createRun({
      prompt: "owner message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...droppedGuest,
        run: {
          ...droppedGuest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...guest,
        run: {
          ...guest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- dropped guest message");
    expect(calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(calls[1]?.prompt).not.toContain("dropped guest message");
    expect(calls[1]?.prompt).toContain("guest message");
    expect(calls[2]?.prompt).toContain("owner message");
  });

  it("does not re-deliver overflow summary on partial auth group failure retry", async () => {
    const key = `test-collect-overflow-partial-retry-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    let attempt = 0;
    const runFollowup = async (run: FollowupRun) => {
      attempt += 1;
      // Summary succeeds (attempt 1), first group fails (attempt 2), then
      // both retained authorization groups succeed on retry.
      if (attempt === 2) {
        throw new Error("transient failure");
      }
      calls.push(run);
      if (calls.length >= 3) {
        done.resolve();
      }
    };
    const settings = createQueueSettings({ cap: 2 });

    const droppedGuest = createRun({
      prompt: "dropped guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const guest = createRun({
      prompt: "guest message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });
    const owner = createRun({
      prompt: "owner message",
      originatingChannel: "slack",
      originatingTo: "channel:A",
    });

    enqueueFollowupRun(
      key,
      {
        ...droppedGuest,
        run: {
          ...droppedGuest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...guest,
        run: {
          ...guest.run,
          senderId: "user-1",
          senderName: "Guest",
          senderIsOwner: false,
        },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...owner,
        run: {
          ...owner.run,
          senderId: "owner-1",
          senderName: "Owner",
          senderIsOwner: true,
        },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.prompt).toContain("- dropped guest message");
    expect(calls[1]?.prompt).not.toContain("[Queue overflow]");
    expect(calls[1]?.prompt).not.toContain("dropped guest message");
    expect(calls[1]?.prompt).toContain("guest message");
    expect(calls[2]?.prompt).not.toContain("[Queue overflow]");
    expect(calls[2]?.prompt).toContain("owner message");
  });

  it("preserves routing metadata on overflow summary followups", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-overflow-summary-routing-${Date.now()}`,
      { mode: "followup", cap: 1 },
    );

    enqueueTestRuns(
      key,
      settings,
      {
        prompt: "first",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      },
      {
        prompt: "second",
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      },
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls[0]?.originatingChannel).toBe("discord");
    expect(calls[0]?.originatingTo).toBe("channel:C1");
    expect(calls[0]?.originatingAccountId).toBe("work");
    expect(calls[0]?.originatingThreadId).toBe("1739142736.000100");
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
  });

  it("keeps live item runtime metadata out of standalone overflow summaries", async () => {
    const key = `test-overflow-summary-runtime-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const controller = new AbortController();
    const onComplete = vi.fn();
    const begin = vi.fn(() => () => undefined);
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      if (calls.length >= 2) {
        done.resolve();
      }
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped ambient" }),
        currentInboundEventKind: "room_event",
        currentInboundContext: { text: "dropped context" },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "live ambient" }),
        currentInboundEventKind: "room_event",
        currentInboundAudio: true,
        currentInboundContext: { text: "live context" },
        abortSignal: controller.signal,
        deliveryCorrelations: [{ begin }],
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[0]?.currentInboundEventKind).toBe("room_event");
    expect(calls[0]?.currentInboundContext).toBeUndefined();
    expect(calls[0]?.abortSignal).toBeUndefined();
    expect(calls[1]?.prompt).toBe("live ambient");
    expect(calls[1]?.currentInboundEventKind).toBe("room_event");
    expect(calls[1]?.currentInboundAudio).toBe(true);
    expect(calls[1]?.currentInboundContext?.text).toBe("live context");
    expect(calls[1]?.abortSignal).toBe(controller.signal);
    expect(calls[1]?.turnAdoptionLifecycle?.onSettled).toBe(onComplete);
    expect(calls[1]?.deliveryCorrelations?.[0]?.begin).toBe(begin);
  });

  it("keeps mixed overflow summaries as normal followups", async () => {
    const { key, calls, done, runFollowup, settings } = createQueueCase(
      `test-overflow-summary-mixed-kind-${Date.now()}`,
      { mode: "followup", cap: 1 },
      2,
    );

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped ambient" }),
        currentInboundEventKind: "room_event",
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped request" }),
        currentInboundEventKind: "user_request",
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
    expect(calls[0]?.currentInboundEventKind).toBeUndefined();
    expect(calls[1]?.prompt).toBe("live followup");
  });

  it("drops an aborted summarized room event before overflow delivery", async () => {
    const key = `test-overflow-summary-lifecycle-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const controller = new AbortController();
    const onComplete = vi.fn();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped ambient" }),
        currentInboundEventKind: "room_event",
        currentInboundContext: { text: "dropped context" },
        abortSignal: controller.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);
    controller.abort();

    expect(onComplete).not.toHaveBeenCalled();

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("live followup");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("retains summarized source identities through admitted overflow delivery", async () => {
    const key = `test-overflow-summary-admitted-lifecycle-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const sourceCompletions = [vi.fn(), vi.fn()];
    const sourceCancellationRetirements = [vi.fn(), vi.fn()];
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    for (const [index, prompt] of ["first dropped", "second dropped"].entries()) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          abortSignal: new AbortController().signal,
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onCancellationRetired: sourceCancellationRetirements[index],
            onSettled: sourceCompletions[index],
          },
        },
        settings,
      );
    }
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        expect(run.prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
        await run.turnAdoptionLifecycle?.onAdopted?.();
        expect(sourceCancellationRetirements[0]).toHaveBeenCalledTimes(1);
        expect(sourceCancellationRetirements[1]).not.toHaveBeenCalled();
        expect(sourceCompletions[0]).not.toHaveBeenCalled();
        expect(sourceCompletions[1]).not.toHaveBeenCalled();
        run.turnAdoptionLifecycle?.onSettled?.();
        expect(sourceCompletions[0]).toHaveBeenCalledTimes(1);
        expect(sourceCompletions[1]).toHaveBeenCalledTimes(1);
        return;
      }
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe("live followup");
  });

  it("admits one lifecycle-owned overflow source before delivery", async () => {
    const key = `test-overflow-summary-single-admission-${Date.now()}`;
    const events: string[] = [];
    const done = createDeferred();
    const sourceComplete = vi.fn(() => {
      events.push("source-complete");
    });
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped lifecycle source" }),
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            events.push("source-admitted");
          },
          onSettled: sourceComplete,
          admission: "exclusive",
          onAbandoned: () => {},
        },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("[Queue overflow]")) {
        events.push("summary-started");
        expect(run.turnAdoptionLifecycle?.onAdopted).toEqual(expect.any(Function));
        await run.turnAdoptionLifecycle?.onAdopted?.();
        events.push("model");
        run.turnAdoptionLifecycle?.onSettled?.();
        return;
      }
      events.push("live-followup");
      done.resolve();
    });
    await done.promise;

    expect(sourceComplete).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "summary-started",
      "source-admitted",
      "model",
      "source-complete",
      "live-followup",
    ]);
  });

  it("keeps one onComplete-only overflow source retryable after delivery fails", async () => {
    const key = `test-overflow-summary-lifecycle-failure-${Date.now()}`;
    const calls: FollowupRun[] = [];
    const firstAttempt = createDeferred();
    const releaseRetry = createDeferred();
    const done = createDeferred();
    const onComplete = vi.fn();
    let attempts = 0;
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      expect(run.turnAdoptionLifecycle).toBeUndefined();
      attempts += 1;
      if (attempts === 1) {
        firstAttempt.resolve();
        throw new Error("transient failure");
      }
      await releaseRetry.promise;
      done.resolve();
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "dropped ambient" }),
        currentInboundEventKind: "room_event",
        currentInboundContext: { text: "dropped context" },
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, runFollowup);
    await firstAttempt.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(getExistingFollowupQueue(key)?.summarySources).toHaveLength(1);
    expect(getExistingFollowupQueue(key)?.summarySources[0]?.currentInboundEventKind).toBe(
      "room_event",
    );
    expect(getExistingFollowupQueue(key)?.summarySources[0]?.turnAdoptionLifecycle).toBeDefined();
    expect(getExistingFollowupQueue(key)?.summarySources[0]?.currentInboundContext).toBeUndefined();

    scheduleFollowupDrain(key, runFollowup);
    releaseRetry.resolve();
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("[Queue overflow] Dropped 1 message due to cap.");
    expect(calls[1]?.prompt).toContain("- dropped ambient");
    expect(calls[1]?.currentInboundEventKind).toBe("room_event");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("collects compatible cancelable turns and completes each source lifecycle", async () => {
    const key = `test-collect-cancelable-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const runFollowup = async (run: FollowupRun) => {
      calls.push(run);
      done.resolve();
    };
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "first" }),
        abortSignal: new AbortController().signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: firstComplete },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "second" }),
        abortSignal: new AbortController().signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: secondComplete },
      },
      settings,
    );

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    await vi.waitFor(() => expect(firstComplete).toHaveBeenCalledTimes(1));
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });

  it("runs distinct collected admission lifecycles independently when one retries", async () => {
    const key = `test-collect-admission-isolation-${Date.now()}`;
    const events: string[] = [];
    const done = createDeferred();
    const secondAdmissionError = new Error("second admission failed");
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    const first = createRun({ prompt: "first" });
    first.turnAdoptionLifecycle = {
      onAdopted: async () => {
        events.push("first-admitted");
      },
      admission: "exclusive",
      onAbandoned: () => {},
    };
    const second = createRun({ prompt: "second" });
    second.turnAdoptionLifecycle = {
      onAdopted: vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          events.push("second-rejected");
          throw secondAdmissionError;
        })
        .mockImplementationOnce(async () => {
          events.push("second-admitted");
        }),
      admission: "exclusive",
      onAbandoned: () => {},
    };

    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);

    scheduleFollowupDrain(key, async (run) => {
      const prompt = run.prompt.includes("first") ? "first" : "second";
      events.push(`run:${prompt}`);
      try {
        await admitFollowupRunLifecycle(run);
      } catch (error) {
        events.push(`error:${prompt}`);
        throw error;
      }
      events.push(`model:${prompt}`);
      if (prompt === "second") {
        done.resolve();
      }
    });

    await done.promise;

    expect(events).toEqual([
      "run:first",
      "first-admitted",
      "model:first",
      "run:second",
      "second-rejected",
      "error:second",
      "run:second",
      "second-admitted",
      "model:second",
    ]);
    expect(second.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(2);
  });

  it("collects transcript-owned turns under one aggregate recorder", async () => {
    const key = `test-collect-transcript-owner-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const firstCorrelation = { begin: vi.fn() };
    const secondCorrelation = { begin: vi.fn() };
    const createRecorder = (text: string, mediaPath: string) =>
      createUserTurnTranscriptRecorder({
        input: { text, media: [{ path: mediaPath, contentType: "image/png" }] },
        target: createTestUserTurnTranscriptTarget(),
        updateMode: "none",
      });
    const firstRecorder = createRecorder("first transcript", "/tmp/first.png");
    const secondRecorder = createRecorder("second transcript", "/tmp/second.png");
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    for (const [prompt, recorder, onComplete, deliveryCorrelation] of [
      ["first", firstRecorder, firstComplete, firstCorrelation],
      ["second", secondRecorder, secondComplete, secondCorrelation],
    ] as const) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          transcriptPrompt: `${prompt} transcript`,
          userTurnTranscriptRecorder: recorder,
          currentInboundContext: { text: "shared gateway context", promptJoiner: " " },
          deliveryCorrelations: [deliveryCorrelation],
          abortSignal: new AbortController().signal,
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.transcriptPrompt).toContain("first transcript");
    expect(calls[0]?.transcriptPrompt).toContain("second transcript");
    expect(calls[0]?.currentInboundContext?.text).toContain(
      "Queued #1 context:\nshared gateway context",
    );
    expect(calls[0]?.currentInboundContext?.text).toContain(
      "Queued #2 context:\nshared gateway context",
    );
    expect(calls[0]?.currentInboundContext?.promptJoiner).toBe("\n\n");
    expect(calls[0]?.deliveryCorrelations).toEqual([firstCorrelation, secondCorrelation]);
    expect(calls[0]?.userTurnTranscriptRecorder).not.toBe(firstRecorder);
    expect(calls[0]?.userTurnTranscriptRecorder).not.toBe(secondRecorder);
    const message = await calls[0]?.userTurnTranscriptRecorder?.resolveMessage();
    expect(message?.content).toContain("first transcript");
    expect(message?.content).toContain("second transcript");
    expect(
      (message as unknown as { __openclaw?: { media?: Array<{ path?: string }> } } | undefined)?.[
        "__openclaw"
      ]?.media?.map((fact) => fact.path),
    ).toEqual(["/tmp/first.png", "/tmp/second.png"]);
    await vi.waitFor(() => expect(firstComplete).toHaveBeenCalledTimes(1));
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });

  it("pairs differing inbound runtime contexts inside one collected turn", async () => {
    const key = `test-collect-runtime-context-split-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    for (const [prompt, contextText] of [
      ["first", "context one"],
      ["second", "context two"],
    ] as const) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          currentInboundContext: { text: contextText },
        },
        settings,
      );
    }

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.currentInboundContext?.text).toContain("Queued #1 context:\ncontext one");
    expect(calls[0]?.currentInboundContext?.text).toContain("Queued #2 context:\ncontext two");
  });

  it("does not let one source cancel an admitted collected run", async () => {
    const key = `test-collect-transcript-cancel-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const canceled = new AbortController();
    const survivor = new AbortController();
    const sourceCompletions = [vi.fn(), vi.fn()];
    const sourceCancellationRetirements = [vi.fn(), vi.fn()];
    let firstResolvedContent = "";
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const createRecorder = (text: string) =>
      createUserTurnTranscriptRecorder({
        input: { text },
        target: createTestUserTurnTranscriptTarget(),
        updateMode: "none",
      });

    for (const [index, [prompt, abortSignal]] of (
      [
        ["canceled", canceled.signal],
        ["survivor", survivor.signal],
      ] as const
    ).entries()) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          transcriptPrompt: `${prompt} transcript`,
          userTurnTranscriptRecorder: createRecorder(`${prompt} transcript`),
          abortSignal,
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onCancellationRetired: sourceCancellationRetirements[index],
            onSettled: sourceCompletions[index],
          },
        },
        settings,
      );
    }

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        expect(run.abortSignal).toBeDefined();
        expect(run.abortSignal).not.toBe(survivor.signal);
        await run.turnAdoptionLifecycle?.onAdopted?.();
        expect(sourceCancellationRetirements[0]).toHaveBeenCalledTimes(1);
        expect(sourceCancellationRetirements[1]).not.toHaveBeenCalled();
        expect(sourceCompletions[0]).not.toHaveBeenCalled();
        expect(sourceCompletions[1]).not.toHaveBeenCalled();
        canceled.abort();
        expect(run.abortSignal?.aborted).toBe(false);
        const resolved = await run.userTurnTranscriptRecorder?.resolveMessage();
        firstResolvedContent = typeof resolved?.content === "string" ? resolved.content : "";
        done.resolve();
      }
    });
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(firstResolvedContent).toContain("survivor transcript");
    expect(firstResolvedContent).toContain("canceled transcript");
    await vi.waitFor(() => expect(sourceCompletions[1]).toHaveBeenCalledTimes(1));
    expect(sourceCompletions[0]).toHaveBeenCalledTimes(1);
    expect(sourceCompletions[1]).toHaveBeenCalledTimes(1);
    expect(getExistingFollowupQueue(key)?.items ?? []).toHaveLength(0);
  });

  it("keeps queue cancellation connected after collect admission", async () => {
    const key = `test-collect-queue-cancel-${Date.now()}`;
    const done = createDeferred();
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    enqueueFollowupRun(key, createRun({ prompt: "first" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "second" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      expect(run.abortSignal).toBeUndefined();
      expect(run.queueAbortSignal?.aborted).toBe(false);
      await run.turnAdoptionLifecycle?.onAdopted?.();
      clearFollowupQueue(key);
      expect(run.queueAbortSignal?.aborted).toBe(true);
      done.resolve();
    });
    await done.promise;
  });

  it.each(["first", "last"] as const)(
    "retries survivors when the %s source owns the sole pre-admission cancel signal",
    async (canceledPosition) => {
      const key = `test-collect-pre-admission-cancel-${canceledPosition}-${Date.now()}`;
      const canceled = new AbortController();
      const canceledComplete = vi.fn();
      const survivorComplete = vi.fn();
      const { calls, done } = createDrainRecorder();
      const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

      const enqueueSource = (prompt: string, onComplete: () => void, abortSignal?: AbortSignal) => {
        const source: FollowupRun = {
          ...createRun({ prompt }),
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
        };
        if (abortSignal) {
          source.abortSignal = abortSignal;
        }
        enqueueFollowupRun(key, source, settings);
      };
      if (canceledPosition === "first") {
        enqueueSource("canceled", canceledComplete, canceled.signal);
        enqueueSource("survivor", survivorComplete);
      } else {
        enqueueSource("survivor", survivorComplete);
        enqueueSource("canceled", canceledComplete, canceled.signal);
      }

      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        if (calls.length === 1) {
          canceled.abort();
          expect(run.abortSignal?.aborted).toBe(true);
          return;
        }
        done.resolve();
      });
      await done.promise;

      expect(calls).toHaveLength(2);
      expect(calls[0]?.prompt).toContain("canceled");
      expect(calls[0]?.prompt).toContain("survivor");
      expect(calls[1]?.prompt).toContain("survivor");
      expect(calls[1]?.prompt).not.toContain("canceled");
      await vi.waitFor(() => expect(survivorComplete).toHaveBeenCalledTimes(1));
      expect(canceledComplete).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps summarized work when a different cancelable live item is aborted", async () => {
    const key = `test-summary-owner-isolation-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const summarizedComplete = vi.fn();
    const abortedComplete = vi.fn();
    const aborted = new AbortController();
    const runFollowup = async (run: FollowupRun) => {
      if (run.abortSignal?.aborted) {
        return;
      }
      calls.push(run);
      done.resolve();
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "owner A summary" }),
        abortSignal: new AbortController().signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: summarizedComplete },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "owner B live" }),
        abortSignal: aborted.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: abortedComplete },
      },
      settings,
    );
    aborted.abort();

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("owner A summary");
    expect(calls[0]?.prompt).not.toContain("owner B live");
    await vi.waitFor(() => expect(summarizedComplete).toHaveBeenCalledTimes(1));
    expect(summarizedComplete).toHaveBeenCalledTimes(1);
    expect(abortedComplete).toHaveBeenCalledTimes(1);
  });

  it("removes an aborted elided source without leaking it into the summary", async () => {
    const key = `test-elided-summary-cancel-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const elidedComplete = vi.fn();
    const elided = new AbortController();
    const runFollowup = async (run: FollowupRun) => {
      if (run.abortSignal?.aborted) {
        return;
      }
      calls.push(run);
      if (calls.length === 2) {
        done.resolve();
      }
    };
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "elided and cancelled" }),
        abortSignal: elided.signal,
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: elidedComplete },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "retained summary" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "live item" }), settings);
    elided.abort();

    await drainRecordedQueue(key, runFollowup, done);

    expect(calls.map((call) => call.prompt).join("\n")).not.toContain("elided and cancelled");
    expect(calls[0]?.prompt).toContain("retained summary");
    expect(calls[1]?.prompt).toBe("live item");
    expect(elidedComplete).toHaveBeenCalledTimes(1);
  });

  it("does not replay elided sources after an admitted summary failure", async () => {
    const key = `test-elided-summary-admitted-failure-${Date.now()}`;
    const { calls, done } = createDrainRecorder();
    const elidedComplete = vi.fn();
    const retainedComplete = vi.fn();
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "elided source" }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: elidedComplete },
      },
      settings,
    );
    enqueueFollowupRun(
      key,
      {
        ...createRun({ prompt: "retained source" }),
        turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: retainedComplete },
      },
      settings,
    );
    enqueueFollowupRun(key, createRun({ prompt: "live item" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        expect(run.prompt).toContain("Dropped 2 messages");
        expect(run.prompt).toContain("retained source");
        await run.turnAdoptionLifecycle?.onAdopted?.();
        expect(getExistingFollowupQueue(key)?.summaryElisions).toEqual([]);
        expect(getExistingFollowupQueue(key)?.droppedCount).toBe(0);
        throw new Error("admitted summary failure");
      }
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe("live item");
    expect(elidedComplete).toHaveBeenCalledOnce();
    expect(retainedComplete).toHaveBeenCalledOnce();
  });

  it("runs distinct overflow admission lifecycles independently when one retries", async () => {
    const key = `test-overflow-admission-isolation-${Date.now()}`;
    const events: string[] = [];
    const done = createDeferred();
    const secondAdmissionError = new Error("second overflow admission failed");
    const settings = createQueueSettings({ mode: "followup", cap: 1 });

    const first = createRun({ prompt: "first dropped" });
    first.turnAdoptionLifecycle = {
      onAdopted: async () => {
        events.push("first-admitted");
      },
      admission: "exclusive",
      onAbandoned: () => {},
    };
    const second = createRun({ prompt: "second dropped" });
    second.turnAdoptionLifecycle = {
      onAdopted: vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(async () => {
          events.push("second-rejected");
          throw secondAdmissionError;
        })
        .mockImplementationOnce(async () => {
          events.push("second-admitted");
        }),
      admission: "exclusive",
      onAbandoned: () => {},
    };

    enqueueFollowupRun(key, first, settings);
    enqueueFollowupRun(key, second, settings);
    enqueueFollowupRun(key, createRun({ prompt: "live followup" }), settings);

    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("[Queue overflow]")) {
        events.push("summary-run");
        try {
          await admitFollowupRunLifecycle(run);
        } catch (error) {
          events.push("summary-error");
          throw error;
        }
        events.push("summary-model");
        return;
      }
      events.push("live-followup");
      done.resolve();
    });

    await done.promise;

    expect(events).toEqual([
      "summary-run",
      "first-admitted",
      "summary-model",
      "summary-run",
      "second-rejected",
      "summary-error",
      "summary-run",
      "second-admitted",
      "summary-model",
      "live-followup",
    ]);
    expect(second.turnAdoptionLifecycle.onAdopted).toHaveBeenCalledTimes(2);
  });
});

function resolveDeliveryKeyWithRunOverrides(
  item: FollowupRun,
  overrides: Partial<FollowupRun["run"]>,
): string {
  return resolveFollowupDeliveryContextKey({
    ...item,
    run: { ...item.run, ...overrides },
  });
}

describe("followup authorization delivery context", () => {
  it("changes when sender ownership changes", () => {
    const run = createRun({ prompt: "one" });
    expect(
      resolveDeliveryKeyWithRunOverrides(run, {
        senderId: "user-1",
        senderIsOwner: false,
      }),
    ).not.toBe(
      resolveDeliveryKeyWithRunOverrides(run, {
        senderId: "user-1",
        senderIsOwner: true,
      }),
    );
  });

  it("changes when exec defaults change", () => {
    const run = createRun({ prompt: "one" });
    expect(
      resolveDeliveryKeyWithRunOverrides(run, {
        senderId: "user-1",
        bashElevated: { enabled: false, allowed: true, defaultLevel: "off" },
      }),
    ).not.toBe(
      resolveDeliveryKeyWithRunOverrides(run, {
        senderId: "user-1",
        bashElevated: { enabled: true, allowed: true, defaultLevel: "on" },
        execOverrides: { ask: "always" },
      }),
    );
  });

  it("changes when the approval reviewer device changes", () => {
    const run = createRun({ prompt: "one" });
    expect(
      resolveDeliveryKeyWithRunOverrides(run, {
        approvalReviewerDeviceId: "device-a",
      }),
    ).not.toBe(
      resolveDeliveryKeyWithRunOverrides(run, {
        approvalReviewerDeviceId: "device-b",
      }),
    );
  });

  it("does not change when only sender display fields change", () => {
    const run = createRun({ prompt: "one" });
    expect(
      resolveDeliveryKeyWithRunOverrides(run, {
        senderId: "user-1",
        senderName: "Guest",
        senderUsername: "guest",
        senderIsOwner: false,
      }),
    ).toBe(
      resolveDeliveryKeyWithRunOverrides(run, {
        senderId: "user-1",
        senderName: "Guest User",
        senderUsername: "guest-renamed",
        senderIsOwner: false,
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
