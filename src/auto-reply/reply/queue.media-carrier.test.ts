// Prompt metadata carrier tests cover collect batching, deferral, and retry identity.
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  compareChannelAdmissionParticipants,
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  createChannelParticipantAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, FollowupRunDeferredError, scheduleFollowupDrain } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createOverflowSummaryRetrySource } from "./queue/drain.js";
import { clearFollowupQueue } from "./queue/state.js";

const queueKeys = new Set<string>();
const evidenceCleanups = new Set<() => void>();

afterEach(() => {
  for (const key of queueKeys) {
    clearFollowupQueue(key);
  }
  queueKeys.clear();
  for (const cleanup of evidenceCleanups) {
    cleanup();
  }
  evidenceCleanups.clear();
});

describe("followup prompt metadata carrier", () => {
  it("keeps collected prompt bytes and ordered facts stable across deferred admission", async () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    evidenceCleanups.add(clearCollection);
    const key = `prompt-media-collect-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const done = createDeferred();
    const calls: FollowupRun[] = [];

    for (const [prompt, path, contentType, skillName] of [
      ["[media attached: /tmp/a.png (image/png)]\nfirst", "/tmp/a.png", "image/png", "a"],
      [
        "[media attached: /tmp/b.pdf (application/pdf)]\nsecond",
        "/tmp/b.pdf",
        "application/pdf",
        "b",
      ],
    ] as const) {
      const run = createQueueTestRun({ prompt });
      run.media = [{ path, contentType }];
      run.explicitSkillSelections = [
        { name: skillName, path: `/tmp/skills/${skillName}/SKILL.md` },
      ];
      run.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-1",
      });
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
    const expectedSkills = [
      { name: "a", path: "/tmp/skills/a/SKILL.md" },
      { name: "b", path: "/tmp/skills/b/SKILL.md" },
    ];
    expect(calls.map((run) => run.explicitSkillSelections)).toEqual([
      expectedSkills,
      expectedSkills,
    ]);
    expect(
      compareChannelAdmissionParticipants(calls.map((run) => run.channelAdmissionEvidence)),
    ).toBe("same");
    expect(consumeChannelAdmissionEvidence(calls[1]?.channelAdmissionEvidence)).toMatchObject({
      ingressState: "present",
      invoker: { state: "present", kind: "person" },
    });
  });

  it("preserves facts when an overflow source is rebuilt for retry", () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    evidenceCleanups.add(clearCollection);
    const source = createQueueTestRun({
      prompt: "[media attached: /tmp/retry.png (image/png)]\nretry me",
    });
    source.media = [{ path: "/tmp/retry.png", contentType: "image/png" }];
    source.explicitSkillSelections = [{ name: "retry", path: "/tmp/skills/retry/SKILL.md" }];
    source.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
      channelId: "test",
      participantId: "person-1",
    });

    const retry = createOverflowSummaryRetrySource(source);

    expect(retry.prompt).toBe(source.prompt);
    expect(retry.media).toEqual(source.media);
    expect(retry.explicitSkillSelections).toEqual(source.explicitSkillSelections);
    expect(retry.channelAdmissionEvidence).toBe(source.channelAdmissionEvidence);
  });
});
