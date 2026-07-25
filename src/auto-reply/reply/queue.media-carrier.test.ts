// Prompt media carrier tests cover collect batching, deferral, and retry identity.
import { afterEach, describe, expect, it } from "vitest";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, FollowupRunDeferredError, scheduleFollowupDrain } from "./queue.js";
import { createDeferred, createQueueTestRun } from "./queue.test-helpers.js";
import { createOverflowSummaryRetrySource } from "./queue/drain.js";
import { clearFollowupQueue } from "./queue/state.js";

const queueKeys = new Set<string>();

afterEach(() => {
  for (const key of queueKeys) {
    clearFollowupQueue(key);
  }
  queueKeys.clear();
});

describe("followup prompt media carrier", () => {
  it("keeps collected prompt bytes and ordered facts stable across deferred admission", async () => {
    const key = `prompt-media-collect-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const done = createDeferred<void>();
    const calls: FollowupRun[] = [];

    for (const [prompt, path, contentType] of [
      ["[media attached: /tmp/a.png (image/png)]\nfirst", "/tmp/a.png", "image/png"],
      ["[media attached: /tmp/b.pdf (application/pdf)]\nsecond", "/tmp/b.pdf", "application/pdf"],
    ] as const) {
      const run = createQueueTestRun({ prompt });
      run.media = [{ path, contentType }];
      enqueueFollowupRun(key, run, settings);
    }

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        throw new FollowupRunDeferredError();
      }
      done.resolve();
    });
    await done.promise;

    const expectedPrompt = [
      "[Queued messages while agent was busy]",
      "---\nQueued #1\n[media attached: /tmp/a.png (image/png)]\nfirst",
      "---\nQueued #2\n[media attached: /tmp/b.pdf (application/pdf)]\nsecond",
    ].join("\n\n");
    expect(calls).toHaveLength(2);
    expect(calls.map((run) => run.prompt)).toEqual([expectedPrompt, expectedPrompt]);
    expect(calls.map((run) => run.media)).toEqual([
      [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.pdf", contentType: "application/pdf" },
      ],
      [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.pdf", contentType: "application/pdf" },
      ],
    ]);
  });

  it("preserves facts when an overflow source is rebuilt for retry", () => {
    const source = createQueueTestRun({
      prompt: "[media attached: /tmp/retry.png (image/png)]\nretry me",
    });
    source.media = [{ path: "/tmp/retry.png", contentType: "image/png" }];

    const retry = createOverflowSummaryRetrySource(source);

    expect(retry.prompt).toBe(source.prompt);
    expect(retry.media).toEqual(source.media);
  });
});
