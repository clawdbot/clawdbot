// Prompt metadata carrier tests cover collect batching, deferral, and retry identity.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import {
  compareChannelAdmissionParticipants,
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, FollowupRunDeferredError, scheduleFollowupDrain } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  createOverflowSummaryRetrySource,
  resolveFollowupDeliveryContextKey,
} from "./queue/drain.js";
import { clearFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const queueKeys = new Set<string>();
const evidenceCleanups = new Set<() => void>();

function addCombinedCarrierFacts(run: FollowupRun): void {
  run.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"], ["exec", "message"]]);
  run.disableTools = true;
  run.run = {
    ...run.run,
    provider: "openai",
    model: "gpt-route",
    memberRoleIds: ["operator", "member"],
    trustedInternalHandoff: {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-route",
    },
    scheduledToolPolicy: { version: 1, mode: "trusted" },
    runtimePluginToolGrant: {
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    },
  };
}

function expectCombinedCarrierFacts(run: FollowupRun | undefined): void {
  expect(run).toBeDefined();
  expect(run?.toolsAllow).toEqual(["exec"]);
  expect(run?.toolsAllow ? readToolAllowlistIntersection(run.toolsAllow) : undefined).toEqual([
    ["exec"],
    ["exec", "message"],
  ]);
  expect(run?.disableTools).toBe(true);
  expect(run?.run).toMatchObject({
    provider: "openai",
    model: "gpt-route",
    memberRoleIds: ["operator", "member"],
    trustedInternalHandoff: {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-route",
    },
    scheduledToolPolicy: { version: 1, mode: "trusted" },
    runtimePluginToolGrant: {
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    },
  });
}

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
  it("drains the complete parked image turn after active steering rejects it", async () => {
    const key = "agent:main:parked-media-fallback";
    queueKeys.add(key);
    const run = createQueueTestRun({
      prompt: "  preserve this caption\n",
      messageId: "media-fallback",
    });
    run.images = [{ type: "image", data: "inline-png", mimeType: "image/png" }];
    run.imageOrder = ["offloaded", "inline"];
    run.media = [{ path: "/tmp/stored.png", contentType: "image/png" }, { kind: "image" }];
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: run.prompt, media: run.media },
      target: () => undefined,
    });
    run.userTurnTranscriptRecorder = recorder;
    const persist = vi.spyOn(recorder, "persistApproved");
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: run.run.sessionId,
      resetTriggered: false,
    });
    operation.bindToolAuthorityFingerprint("media-authority");
    const reject = vi.fn(async () => {
      throw new Error("no active turn to steer");
    });
    operation.attachBackend({
      kind: "embedded",
      supportsQueueMessageImages: true,
      toolAuthorityFingerprint: "media-authority",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: reject },
    });
    operation.setPhase("running");
    const delivered = createDeferred<FollowupRun>();
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      delivered.resolve(queued);
    });
    const typing = createMockTypingController();
    try {
      await expect(
        runActiveReplySteer({
          followupRun: run,
          opts: undefined,
          providedReplyOperation: operation,
          queueKey: key,
          releaseAdmissionTicket: vi.fn(),
          replyOperationRunState: undefined,
          resolvedQueue: { mode: "steer", debounceMs: 0 },
          restartRecoverySourceTurnId: "media-fallback",
          runFollowup,
          sessionCtx: {},
          sessionKey: key,
          touchActiveSessionEntry: async () => {},
          typing,
          typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
          toolAuthorityFingerprint: "media-authority",
        }),
      ).resolves.toBe("handled");
      expect(reject).toHaveBeenCalledOnce();
      expect(persist).not.toHaveBeenCalled();
      operation.complete();
      await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledOnce());
      const fallback = await delivered.promise;
      expect({
        text: fallback.prompt,
        images: fallback.images,
        imageOrder: fallback.imageOrder,
        media: fallback.media,
      }).toEqual({
        text: "  preserve this caption\n",
        images: [{ type: "image", data: "inline-png", mimeType: "image/png" }],
        imageOrder: ["offloaded", "inline"],
        media: [{ path: "/tmp/stored.png", contentType: "image/png" }, { kind: "image" }],
      });
      expect(fallback.userTurnTranscriptRecorder).toBe(recorder);
      expect(recorder.hasPersisted()).toBe(false);
    } finally {
      operation.complete();
      persist.mockRestore();
    }
  });

  it("keeps participant evidence out of sender-scoped collect routing", () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    evidenceCleanups.add(clearCollection);
    const runs = ["person-1", "person-2"].map((senderId) => {
      const item = createQueueTestRun({
        prompt: `from ${senderId}`,
        originatingChannel: "slack",
        originatingTo: "channel:A",
      });
      item.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        channelId: "slack",
        accountId: "default",
        participantId: senderId,
      });
      item.run = {
        ...item.run,
        senderId,
        senderE164: `+1555000${senderId.at(-1)}`,
        senderIsOwner: false,
      };
      return item;
    });

    expect(resolveFollowupDeliveryContextKey(runs[0]!)).not.toBe(
      resolveFollowupDeliveryContextKey(runs[1]!),
    );
  });
  it("keeps collected prompt bytes and ordered facts stable across deferred admission", async () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    evidenceCleanups.add(clearCollection);
    const key = `prompt-media-collect-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const done = createDeferred();
    const calls: FollowupRun[] = [];

    for (const [prompt, path, contentType, skillName, sharedSkillName] of [
      [
        "[media attached: /tmp/a.png (image/png)]\nfirst",
        "/tmp/a.png",
        "image/png",
        "a",
        "shared-first",
      ],
      [
        "[media attached: /tmp/b.pdf (application/pdf)]\nsecond",
        "/tmp/b.pdf",
        "application/pdf",
        "b",
        "shared-last",
      ],
    ] as const) {
      const run = createQueueTestRun({ prompt });
      addCombinedCarrierFacts(run);
      run.images = [{ type: "image", data: path, mimeType: contentType }];
      run.imageOrder = ["inline"];
      run.media = [{ path, contentType }];
      run.explicitSkillSelections = [
        { name: skillName, path: `/tmp/skills/${skillName}/SKILL.md` },
        { name: sharedSkillName, path: "/tmp/skills/shared/SKILL.md" },
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
    expect(calls.map((run) => run.images)).toEqual([
      [
        { type: "image", data: "/tmp/a.png", mimeType: "image/png" },
        { type: "image", data: "/tmp/b.pdf", mimeType: "application/pdf" },
      ],
      [
        { type: "image", data: "/tmp/a.png", mimeType: "image/png" },
        { type: "image", data: "/tmp/b.pdf", mimeType: "application/pdf" },
      ],
    ]);
    expect(calls.map((run) => run.imageOrder)).toEqual([
      ["inline", "inline"],
      ["inline", "inline"],
    ]);
    const expectedSkills = [
      { name: "a", path: "/tmp/skills/a/SKILL.md" },
      { name: "shared-last", path: "/tmp/skills/shared/SKILL.md" },
      { name: "b", path: "/tmp/skills/b/SKILL.md" },
    ];
    expect(calls.map((run) => run.explicitSkillSelections)).toEqual([
      expectedSkills,
      expectedSkills,
    ]);
    for (const call of calls) {
      expectCombinedCarrierFacts(call);
    }
    expect(
      compareChannelAdmissionParticipants(calls.map((run) => run.channelAdmissionEvidence)),
    ).toBe("same");
    expect(consumeChannelAdmissionEvidence(calls[1]?.channelAdmissionEvidence)).toMatchObject({
      ingressState: "present",
      invoker: { state: "present", kind: "person" },
    });
  });

  it("removes sender authority when collected evidence identifies mixed participants", async () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    evidenceCleanups.add(clearCollection);
    const key = `prompt-metadata-mixed-${Date.now()}`;
    queueKeys.add(key);
    const done = createDeferred();
    const calls: FollowupRun[] = [];

    for (const [participantId, skillName] of [
      ["person-1", "a"],
      ["person-2", "b"],
    ] as const) {
      const run = createQueueTestRun({
        prompt: `from ${participantId}`,
        originatingChannel: "test",
        originatingTo: "room:shared",
      });
      addCombinedCarrierFacts(run);
      run.explicitSkillSelections = [
        { name: skillName, path: `/tmp/skills/${skillName}/SKILL.md` },
      ];
      run.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId,
      });
      run.run = {
        ...run.run,
        senderId: "ambiguous-transport-sender",
        senderName: "Ambiguous Sender",
        senderUsername: "ambiguous",
        senderE164: "+15550000000",
        senderIsOwner: true,
        traceAuthorized: true,
        ownerNumbers: ["+15550000000"],
      };
      enqueueFollowupRun(key, run, { mode: "collect", debounceMs: 0 });
    }

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.explicitSkillSelections).toEqual([
      { name: "a", path: "/tmp/skills/a/SKILL.md" },
      { name: "b", path: "/tmp/skills/b/SKILL.md" },
    ]);
    expect(consumeChannelAdmissionEvidence(calls[0]?.channelAdmissionEvidence)).toMatchObject({
      ingressState: "unknown",
      invoker: { state: "unknown" },
    });
    expect(calls[0]?.run).toMatchObject({
      senderId: undefined,
      senderName: undefined,
      senderUsername: undefined,
      senderE164: undefined,
      senderIsOwner: false,
      traceAuthorized: false,
      ownerNumbers: [],
    });
    expectCombinedCarrierFacts(calls[0]);
  });

  it("preserves facts when an overflow source is rebuilt for retry", () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    evidenceCleanups.add(clearCollection);
    const source = createQueueTestRun({
      prompt: "[media attached: /tmp/retry.png (image/png)]\nretry me",
    });
    addCombinedCarrierFacts(source);
    source.images = [{ type: "image", data: "png", mimeType: "image/png" }];
    source.imageOrder = ["offloaded"];
    source.media = [{ path: "/tmp/retry.png", contentType: "image/png" }];
    source.explicitSkillSelections = [{ name: "retry", path: "/tmp/skills/retry/SKILL.md" }];
    source.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
      channelId: "test",
      participantId: "person-1",
    });

    const retry = createOverflowSummaryRetrySource(source);

    expect(retry.prompt).toBe(source.prompt);
    expect(retry.images).toEqual(source.images);
    expect(retry.imageOrder).toEqual(source.imageOrder);
    expect(retry.media).toEqual(source.media);
    expect(retry.explicitSkillSelections).toEqual(source.explicitSkillSelections);
    expect(retry.channelAdmissionEvidence).toBe(source.channelAdmissionEvidence);
    expectCombinedCarrierFacts(retry);
  });
});
