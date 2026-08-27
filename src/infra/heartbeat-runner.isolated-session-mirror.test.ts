// Covers isolated heartbeat outbound session routing and base-session bookkeeping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageTool } from "../agents/tools/message-tool-execution.js";
import { recordReplyOperationAgentTurn } from "../auto-reply/reply/reply-operation-agent-turn-state.js";
import { resolveReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
} from "../sessions/session-lifecycle-admission.js";
import {
  completeTargetSessionDelivery as completeDelivery,
  installRoutedWhatsAppPlugin,
  readTargetSessionTranscript as readTargetTranscript,
  TARGET_SESSION_RECIPIENT as RECIPIENT,
  runTargetSessionScenario as runScenario,
  STALE_TARGET_SESSION_RECIPIENT as STALE_TARGET,
  type TargetSessionDeliveryRequest as MockDeliveryRequest,
  type TargetSessionScenarioContext as ScenarioContext,
  type TargetSessionTargetSeed as TargetSeed,
  withRoutedTargetSessionScenario as withRoutedScenario,
} from "./heartbeat-runner.target-session.test-harness.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
} from "./heartbeat-runner.test-utils.js";
import { runAbortableHeartbeatWake } from "./heartbeat-wake-lifecycle.js";
import {
  OutboundDeliveryError,
  type OutboundPayloadDeliveryOutcome,
} from "./outbound/deliver-types.js";
import { runMessageAction } from "./outbound/message-action-runner.js";
import type { TargetSessionProjectionCoordinator } from "./outbound/target-session-projection.js";
import {
  enqueueSystemEvent,
  isSystemEventDeferredDuringHeartbeat,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

type ProjectionDeliveryRequest = MockDeliveryRequest & {
  onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
};

const deliverOutboundPayloadsInternal = vi.hoisted(() => vi.fn());
const transcriptRuntimeMockState = vi.hoisted(() => ({
  beforeAppend: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

vi.mock("../config/sessions/transcript.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/transcript.runtime.js")>();
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: async (
      ...args: Parameters<typeof actual.appendAssistantMessageToSessionTranscript>
    ) => {
      await transcriptRuntimeMockState.beforeAppend?.();
      return await actual.appendAssistantMessageToSessionTranscript(...args);
    },
  };
});

installHeartbeatRunnerTestRuntime();

beforeEach(() => {
  resetSystemEventsForTest();
  transcriptRuntimeMockState.beforeAppend = undefined;
  deliverOutboundPayloadsInternal.mockReset();
  deliverOutboundPayloadsInternal.mockImplementation(async (request: MockDeliveryRequest) =>
    completeDelivery(request, "msg-1"),
  );
});

afterEach(() => {
  transcriptRuntimeMockState.beforeAppend = undefined;
  resetSystemEventsForTest();
});

type HeartbeatProjectionReplyOptions = {
  targetSessionProjectionCoordinator?: TargetSessionProjectionCoordinator;
};

async function recordCapturedHeartbeatMessageToolSend(params: {
  context: ScenarioContext;
  options: object | undefined;
  text: string;
  projectionConfig?: OpenClawConfig;
}): Promise<void> {
  const projectionOptions = params.options as HeartbeatProjectionReplyOptions | undefined;
  const coordinator = projectionOptions?.targetSessionProjectionCoordinator;
  if (!coordinator) {
    throw new Error("expected heartbeat target-session projection coordinator");
  }
  await runMessageAction({
    cfg: params.context.cfg,
    action: "send",
    params: {
      channel: "whatsapp",
      target: RECIPIENT,
      message: params.text,
    },
    actionOrigin: "message-tool",
    agentId: "main",
    sessionKey: params.context.baseSessionKey,
    sourceReplySessionKey: params.context.isolatedSessionKey,
    targetSessionProjection: {
      cfg: params.projectionConfig ?? params.context.cfg,
      readCurrentConfig: coordinator.readCurrentConfig,
      coordinator,
    },
    skipQueue: true,
    dryRun: false,
  });
}

function installGatedSuccessfulDelivery(messageId: string): {
  platformStarted: Promise<void>;
  releasePlatformSend: () => void;
} {
  let releasePlatformSend = () => {};
  const platformSendGate = new Promise<void>((resolve) => {
    releasePlatformSend = resolve;
  });
  let reportPlatformStarted = () => {};
  const platformStarted = new Promise<void>((resolve) => {
    reportPlatformStarted = resolve;
  });
  deliverOutboundPayloadsInternal.mockImplementationOnce(async (request: MockDeliveryRequest) => {
    reportPlatformStarted();
    await platformSendGate;
    return completeDelivery(request, messageId);
  });
  return { platformStarted, releasePlatformSend };
}

type NonDeliveryCase = {
  name: string;
  slug: string;
  replyText: string;
  outcome: "suppressed" | "ambiguous" | "failed" | "partial";
  target?: TargetSeed;
  expectedStatus: "ran" | "failed";
  expectedTargetTo?: string;
  expectedAwareness?: string;
};

const nonDeliveryCases: NonDeliveryCase[] = [
  {
    name: "does not project a heartbeat suppressed before visible delivery",
    slug: "suppressed-owner",
    replyText: "This send will be suppressed.",
    outcome: "suppressed",
    target: { sessionId: "target-session", lastTo: STALE_TARGET },
    expectedStatus: "ran",
    expectedTargetTo: STALE_TARGET,
  },
  {
    name: "queues uncertainty without mirroring when the adapter may have sent without an identity",
    slug: "ambiguous-owner",
    replyText: "The adapter omitted its message identity.",
    outcome: "ambiguous",
    target: { sessionId: "target-session", lastTo: STALE_TARGET },
    expectedStatus: "ran",
    expectedTargetTo: RECIPIENT,
    expectedAwareness: [
      "A heartbeat attempted to deliver this message to this channel, but the channel did not confirm a delivery identity. It may have been delivered:",
      "The adapter omitted its message identity.",
    ].join("\n"),
  },
  {
    name: "queues a target non-outcome when heartbeat delivery fails",
    slug: "failed-owner",
    replyText: "This alert cannot be delivered.",
    outcome: "failed",
    target: { sessionId: "target-session", lastTo: STALE_TARGET },
    expectedStatus: "failed",
    expectedTargetTo: STALE_TARGET,
    expectedAwareness: [
      "A heartbeat attempted to deliver a message to this channel, but delivery failed.",
      "No delivery was confirmed.",
    ].join("\n"),
  },
  {
    name: "does not leave failed-delivery awareness for a future target generation",
    slug: "future-owner",
    replyText: "This alert has no target generation yet.",
    outcome: "failed",
    expectedStatus: "failed",
  },
  {
    name: "binds the target route but records only a non-outcome after partial delivery",
    slug: "partial-owner",
    replyText: "This alert was only partly delivered.",
    outcome: "partial",
    target: { sessionId: "target-session", lastTo: STALE_TARGET },
    expectedStatus: "failed",
    expectedTargetTo: RECIPIENT,
    expectedAwareness: [
      "A heartbeat attempted to deliver a message to this channel, but delivery failed.",
      "One or more heartbeat message parts may already have been delivered.",
    ].join("\n"),
  },
];

function arrangeNonDeliveryOutcome(outcome: NonDeliveryCase["outcome"]): void {
  if (outcome === "suppressed") {
    deliverOutboundPayloadsInternal.mockResolvedValueOnce([]);
    return;
  }
  if (outcome === "ambiguous") {
    deliverOutboundPayloadsInternal.mockImplementationOnce(
      async (request: ProjectionDeliveryRequest) => {
        for (const payload of request.payloads ?? []) {
          request.onPayload?.({
            text: payload.text ?? "",
            mediaUrls: [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter(
              (value): value is string => Boolean(value),
            ),
          });
        }
        request.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_identity",
        });
        return [];
      },
    );
    return;
  }
  if (outcome === "partial") {
    deliverOutboundPayloadsInternal.mockRejectedValueOnce(
      new OutboundDeliveryError("second part failed", {
        cause: new Error("channel interrupted"),
        results: [{ channel: "whatsapp", messageId: "msg-before-failure" }],
      }),
    );
    return;
  }
  deliverOutboundPayloadsInternal.mockRejectedValueOnce(new Error("channel unavailable"));
}

describe("runHeartbeatOnce - isolated heartbeat outbound session mirror", () => {
  it("keeps a tool send and direct alert ahead of the next first-contact turn", async () => {
    await withRoutedScenario(
      { targetSessionKey: "agent:main:whatsapp:direct:message-tool-first-contact" },
      async (context) => {
        const activeTurn = await beginSessionWorkAdmission({
          scope: context.storePath,
          identities: [context.targetSessionKey],
          assertAllowed: () => {},
        });
        context.replySpy.mockImplementationOnce(async (_ctx, options) => {
          await recordCapturedHeartbeatMessageToolSend({
            context,
            options,
            text: "First-contact tool reminder.",
            projectionConfig: structuredClone(context.cfg),
          });
          return { text: "First-contact direct reminder." };
        });

        const run = runScenario(context);
        await vi.waitFor(() => expect(deliverOutboundPayloadsInternal).toHaveBeenCalledTimes(2));
        expect(
          readSessionStoreForTest(context.storePath)[context.targetSessionKey],
        ).toBeUndefined();
        let eventsAtNextTurnAdmission: ReturnType<typeof peekSystemEventEntries> | undefined;
        const nextTurn = beginSessionWorkAdmission({
          scope: context.storePath,
          identities: [context.targetSessionKey],
          assertAllowed: () => {},
        });
        void nextTurn.then((admission) => {
          eventsAtNextTurnAdmission = peekSystemEventEntries(context.targetSessionKey);
          admission.release();
        });
        activeTurn.release();
        await expect(run).resolves.toMatchObject({ status: "ran" });
        await nextTurn;

        const targetSessionId = readSessionStoreForTest<{ sessionId?: string }>(context.storePath)[
          context.targetSessionKey
        ]?.sessionId;
        expect(targetSessionId).toEqual(expect.any(String));
        const transcript = await readTargetTranscript(context, targetSessionId);
        for (const text of ["First-contact tool reminder.", "First-contact direct reminder."]) {
          expect(transcript).toContain(text);
        }
        expect(peekSystemEventEntries(context.targetSessionKey).map((event) => event.text)).toEqual(
          [
            "A heartbeat delivered this message to this channel:\nFirst-contact tool reminder.",
            "A heartbeat delivered this message to this channel:\nFirst-contact direct reminder.",
          ],
        );
        expect(eventsAtNextTurnAdmission).toHaveLength(2);
      },
    );
  });

  it("rejects a real message-action projection after the target resets during platform send", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:message-tool-reset",
        target: {
          sessionId: "message-tool-before-reset",
          lifecycleRevision: "message-tool-revision-before-reset",
        },
      },
      async (context) => {
        const gate = installGatedSuccessfulDelivery("message-tool-after-reset");
        context.replySpy.mockImplementationOnce(async (_ctx, options) => {
          await recordCapturedHeartbeatMessageToolSend({
            context,
            options,
            text: "Do not project this tool send across reset.",
          });
          return { text: "HEARTBEAT_OK" };
        });

        const run = runScenario(context);
        await gate.platformStarted;
        await resetSessionEntryLifecycle({
          agentId: "main",
          storePath: context.storePath,
          target: {
            canonicalKey: context.targetSessionKey,
            storeKeys: [context.targetSessionKey],
          },
          resetBoundaryReason: "reset",
          buildNextEntry: () => ({
            sessionId: "message-tool-after-reset",
            lifecycleRevision: "message-tool-revision-after-reset",
            updatedAt: context.nowMs,
          }),
        });
        gate.releasePlatformSend();

        await expect(run).resolves.toMatchObject({ status: "ran" });
        for (const sessionId of ["message-tool-before-reset", "message-tool-after-reset"]) {
          expect(await readTargetTranscript(context, sessionId)).not.toContain(
            "Do not project this tool send across reset.",
          );
        }
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([]);
      },
    );
  });

  it.each([
    ["cancelled", { status: "skipped", reason: "agent-runner-cancelled" }],
    ["errored", { status: "failed", reason: "accounting exploded" }],
  ] as const)(
    "keeps confirmed messaging-tool evidence when the agent run is %s",
    async (mode, expected) => {
      await withRoutedScenario(
        {
          targetSessionKey: `agent:main:whatsapp:direct:tool-${mode}`,
          target: { sessionId: `tool-${mode}-session` },
        },
        async (context) => {
          context.replySpy.mockImplementationOnce(async (_ctx, options) => {
            await recordCapturedHeartbeatMessageToolSend({
              context,
              options,
              text: "Delivered before terminal failure.",
            });
            const runState = resolveReplyOperationRunState(options);
            if (!runState) {
              throw new Error("expected heartbeat reply operation run state");
            }
            if (mode === "cancelled") {
              recordReplyOperationAgentTurn(runState, "cancelled");
              return { text: "HEARTBEAT_OK" };
            }
            throw new Error("accounting exploded");
          });

          await expect(runScenario(context)).resolves.toMatchObject(expected);
          expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([
            expect.objectContaining({
              text: [
                "A heartbeat delivered this message to this channel:",
                "Delivered before terminal failure.",
              ].join("\n"),
            }),
          ]);
        },
      );
    },
  );

  it("mirrors only confirmed content when a message-tool send partially fails", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:tool-partial",
        target: { sessionId: "tool-partial-session" },
      },
      async (context) => {
        deliverOutboundPayloadsInternal.mockImplementationOnce(async (request) => {
          completeDelivery(request, "tool-partial-confirmed");
          request.onPayload?.({ text: "Unconfirmed second part.", mediaUrls: [] });
          throw new OutboundDeliveryError("second part failed", {
            cause: new Error("channel interrupted"),
            results: [{ channel: "whatsapp", messageId: "tool-partial-confirmed" }],
          });
        });
        context.replySpy.mockImplementationOnce(async (_ctx, options) => {
          await recordCapturedHeartbeatMessageToolSend({
            context,
            options,
            text: "Confirmed before the channel failed.",
          });
          return { text: "HEARTBEAT_OK" };
        });

        await expect(runScenario(context)).resolves.toMatchObject({ status: "failed" });
        expect(await readTargetTranscript(context)).toContain(
          "Confirmed before the channel failed.",
        );
        expect(await readTargetTranscript(context)).not.toContain("Unconfirmed second part.");
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([
          expect.objectContaining({
            text: [
              "A heartbeat attempted to deliver a message to this channel, but delivery failed.",
              "One or more heartbeat message parts may already have been delivered.",
            ].join("\n"),
          }),
        ]);
      },
    );
  });

  it.each([
    {
      name: "projects structured plugin delivery without inventing transcript content",
      payload: { messageId: "plugin-confirmed" },
      expectedTo: RECIPIENT,
      expectedAwareness:
        "A heartbeat delivered this message to this channel:\n[No text representation was available.]",
    },
    {
      name: "keeps the legacy route for an opaque accepted plugin send",
      payload: { success: true },
      expectedTo: RECIPIENT,
    },
    {
      name: "does not project a plugin-suppressed send",
      payload: { status: "suppressed" },
      expectedTo: STALE_TARGET,
    },
    {
      name: "fails closed when the plugin owner omits its exact session",
      payload: { messageId: "plugin-owner-ambiguous" },
      expectedTo: STALE_TARGET,
      omitProjectionSessionOwner: true,
    },
  ])("$name", async ({ payload, expectedTo, expectedAwareness, omitProjectionSessionOwner }) => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:opaque-plugin-owner",
        target: { sessionId: "opaque-plugin-session", lastTo: STALE_TARGET },
      },
      async (context) => {
        installRoutedWhatsAppPlugin(context.targetSessionKey, payload, omitProjectionSessionOwner);
        context.replySpy.mockImplementationOnce(async (_ctx, options) => {
          const projectionOptions = options as HeartbeatProjectionReplyOptions | undefined;
          const coordinator = projectionOptions?.targetSessionProjectionCoordinator;
          if (!coordinator) {
            throw new Error("expected heartbeat target-session projection coordinator");
          }
          const tool = createMessageTool({
            config: context.cfg,
            getRuntimeConfig: coordinator.readCurrentConfig,
            agentId: "main",
            agentSessionKey: context.baseSessionKey,
            runSessionKey: context.isolatedSessionKey,
            targetSessionProjectionCoordinator: coordinator,
            requireExplicitTarget: true,
          });
          await tool.execute("plugin-send", {
            action: "send",
            channel: "whatsapp",
            target: RECIPIENT,
            message: "Plugin payload.",
          });
          return { text: "HEARTBEAT_OK" };
        });

        await expect(runScenario(context)).resolves.toMatchObject({ status: "ran" });
        expect(
          readSessionStoreForTest<{ delivery?: { context?: { to?: string } } }>(context.storePath)[
            context.targetSessionKey
          ]?.delivery?.context?.to,
        ).toBe(expectedTo);
        expect(await readTargetTranscript(context)).not.toContain("Plugin payload.");
        expect(peekSystemEventEntries(context.targetSessionKey).map((event) => event.text)).toEqual(
          expectedAwareness ? [expectedAwareness] : [],
        );
      },
    );
  });

  it("projects a successful alert into the routed target", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:heartbeat-owner",
        replyText: "Status needs attention.",
      },
      async (context) => {
        await seedHeartbeatScratchForTest({
          content: "Check whether the user needs a status update.",
        });

        await expect(runScenario(context)).resolves.toMatchObject({ status: "ran" });
        const store = readSessionStoreForTest<{
          sessionId?: string;
          delivery?: { context?: { channel?: string; to?: string } };
        }>(context.storePath);
        expect(store[context.targetSessionKey]).toMatchObject({
          delivery: { context: { channel: "whatsapp", to: RECIPIENT } },
        });
        const targetSessionId = store[context.targetSessionKey]?.sessionId;
        expect(targetSessionId).toEqual(expect.any(String));

        const targetTranscript = await loadTranscriptEvents({
          agentId: "main",
          sessionKey: context.targetSessionKey,
          sessionId: targetSessionId ?? "missing-target-session",
          storePath: context.storePath,
        });
        const mirroredMessage = (
          targetTranscript.find((event) => (event as { type?: unknown }).type === "message") as
            | { message?: unknown }
            | undefined
        )?.message as
          | { idempotencyKey?: string; model?: string; provider?: string; content?: unknown }
          | undefined;
        expect(mirroredMessage).toMatchObject({
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "Status needs attention." }],
          idempotencyKey: expect.any(String),
        });
        const awarenessEvents = peekSystemEventEntries(context.targetSessionKey);
        expect(awarenessEvents).toEqual([
          expect.objectContaining({
            contextKey: mirroredMessage?.idempotencyKey,
            text: "A heartbeat delivered this message to this channel:\nStatus needs attention.",
          }),
        ]);
        expect(isSystemEventDeferredDuringHeartbeat(awarenessEvents[0]!)).toBe(true);

        const nextTurnContext = await drainFormattedSystemEvents({
          cfg: context.cfg,
          agentId: "main",
          sessionKey: context.targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        });
        expect(nextTurnContext).toContain("Status needs attention.");
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([]);
      },
    );
  });

  it("projects a delivered runner-failure notice into the routed target", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:runner-failure-owner",
        target: { sessionId: "runner-failure-target" },
      },
      async (context) => {
        context.replySpy.mockImplementationOnce(async (_ctx, options) => {
          const runState = resolveReplyOperationRunState(options);
          if (!runState) {
            throw new Error("expected heartbeat reply operation run state");
          }
          recordReplyOperationAgentTurn(runState, "failed");
          return { text: "The heartbeat provider failed before finishing its check." };
        });

        await expect(runScenario(context)).resolves.toEqual({
          status: "failed",
          reason: "agent-runner-failure",
        });
        expect(await readTargetTranscript(context)).toContain(
          "The heartbeat provider failed before finishing its check.",
        );
        expect(
          readSessionStoreForTest<{ delivery?: { context?: { to?: string } } }>(context.storePath)[
            context.targetSessionKey
          ]?.delivery?.context?.to,
        ).toBe(RECIPIENT);
        expect(peekSystemEventEntries(context.targetSessionKey).map((event) => event.text)).toEqual(
          [
            [
              "A heartbeat delivered this message to this channel:",
              "The heartbeat provider failed before finishing its check.",
            ].join("\n"),
          ],
        );
      },
    );
  });

  it.each(nonDeliveryCases)("$name", async (testCase) => {
    const targetSessionKey = `agent:main:whatsapp:direct:${testCase.slug}`;
    await withRoutedScenario(
      { targetSessionKey, target: testCase.target, replyText: testCase.replyText },
      async (context) => {
        arrangeNonDeliveryOutcome(testCase.outcome);
        await expect(runScenario(context)).resolves.toMatchObject({
          status: testCase.expectedStatus,
        });

        const store = readSessionStoreForTest<{
          lastHeartbeatText?: string;
          delivery?: { context?: { to?: string } };
        }>(context.storePath);
        expect(store[context.baseSessionKey]?.lastHeartbeatText).toBeUndefined();
        if (testCase.target) {
          expect(store[targetSessionKey]?.delivery?.context?.to).toBe(testCase.expectedTargetTo);
          expect(await readTargetTranscript(context)).not.toContain(testCase.replyText);
        } else {
          expect(store[targetSessionKey]).toBeUndefined();
        }

        if (testCase.expectedAwareness) {
          const awarenessEvents = peekSystemEventEntries(targetSessionKey);
          expect(awarenessEvents).toEqual([
            expect.objectContaining({
              contextKey: expect.stringMatching(/^heartbeat-delivery:v1:/),
              text: testCase.expectedAwareness,
            }),
          ]);
          expect(isSystemEventDeferredDuringHeartbeat(awarenessEvents[0]!)).toBe(true);
        } else {
          expect(peekSystemEventEntries(targetSessionKey)).toEqual([]);
        }
      },
    );
  });

  it("commits awareness after wake cancellation between target turns", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:ordered-owner",
        target: {
          sessionId: "ordered-target-session",
          lifecycleRevision: "ordered-revision",
        },
        replyText: "The next turn must see this alert.",
      },
      async (context) => {
        const targetSessionId = context.targetSessionId ?? "missing-target-session";
        const activeTurn = await beginSessionWorkAdmission({
          scope: context.storePath,
          identities: [context.targetSessionKey, targetSessionId],
          assertAllowed: () => {},
        });

        const wakeAbort = new AbortController();
        let committedRun: ReturnType<typeof runScenario> | undefined;
        const wake = runAbortableHeartbeatWake(
          async () => {
            committedRun = runScenario(context);
            return await committedRun;
          },
          { source: "manual", intent: "manual" },
          wakeAbort.signal,
        );
        await vi.waitFor(() =>
          expect(
            isSessionLifecycleMutationActive(context.storePath, [
              context.targetSessionKey,
              targetSessionId,
            ]),
          ).toBe(true),
        );
        expect(
          (await drainFormattedSystemEvents({
            cfg: context.cfg,
            agentId: "main",
            sessionKey: context.targetSessionKey,
            isMainSession: false,
            isNewSession: false,
          })) ?? "",
        ).not.toContain("The next turn must see this alert.");

        let nextTurnAdmitted = false;
        const nextTurn = beginSessionWorkAdmission({
          scope: context.storePath,
          identities: [context.targetSessionKey, targetSessionId],
          assertAllowed: () => {},
        });
        void nextTurn.then(() => {
          nextTurnAdmitted = true;
        });
        await Promise.resolve();
        expect(nextTurnAdmitted).toBe(false);

        wakeAbort.abort(new Error("replacement wake"));
        await expect(wake).rejects.toThrow("replacement wake");

        activeTurn.release();
        if (!committedRun) {
          throw new Error("expected the heartbeat run to start");
        }
        await expect(committedRun).resolves.toMatchObject({ status: "ran" });
        const nextTurnAdmission = await nextTurn;
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([
          expect.objectContaining({
            text: [
              "A heartbeat delivered this message to this channel:",
              "The next turn must see this alert.",
            ].join("\n"),
          }),
        ]);
        nextTurnAdmission.release();
      },
    );
  });

  it("rejects a late projection when the routed target resets during delivery", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:reset-owner",
        target: {
          sessionId: "target-before-reset",
          lifecycleRevision: "revision-before-reset",
        },
        replyText: "Do not leak across reset.",
      },
      async (context) => {
        const gate = installGatedSuccessfulDelivery("msg-after-reset");
        const run = runScenario(context);
        await gate.platformStarted;
        await resetSessionEntryLifecycle({
          agentId: "main",
          storePath: context.storePath,
          target: {
            canonicalKey: context.targetSessionKey,
            storeKeys: [context.targetSessionKey],
          },
          resetBoundaryReason: "reset",
          buildNextEntry: () => ({
            sessionId: "target-after-reset",
            lifecycleRevision: "revision-after-reset",
            updatedAt: context.nowMs,
          }),
        });
        gate.releasePlatformSend();

        await expect(run).resolves.toMatchObject({ status: "ran" });
        for (const sessionId of ["target-before-reset", "target-after-reset"]) {
          expect(await readTargetTranscript(context, sessionId)).not.toContain(
            "Do not leak across reset.",
          );
        }
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([]);
        expect(
          readSessionStoreForTest<{ lastHeartbeatText?: string }>(context.storePath)[
            context.baseSessionKey
          ],
        ).toMatchObject({ lastHeartbeatText: "Do not leak across reset." });
      },
    );
  });

  it("preserves a full event queue when target projection becomes stale", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:reloaded-store-owner",
        target: { sessionId: "reloaded-store-target" },
        replyText: "Do not project into the retired store.",
      },
      async (context) => {
        for (let index = 0; index < 20; index += 1) {
          enqueueSystemEvent(`Existing event ${index}`, { sessionKey: context.targetSessionKey });
        }
        const queuedBeforeProjection = peekSystemEventEntries(context.targetSessionKey);
        let currentConfig = context.cfg;
        transcriptRuntimeMockState.beforeAppend = async () => {
          currentConfig = {
            ...context.cfg,
            session: { ...context.cfg.session, store: `${context.storePath}.reloaded` },
          };
        };

        await expect(runScenario(context, undefined, () => currentConfig)).resolves.toMatchObject({
          status: "ran",
        });
        expect(await readTargetTranscript(context)).not.toContain(
          "Do not project into the retired store.",
        );
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual(queuedBeforeProjection);
      },
    );
  });

  it("does not adopt a target generation created and reset during delivery", async () => {
    await withRoutedScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:first-contact-reset-owner",
        replyText: "Do not adopt a replacement generation.",
      },
      async (context) => {
        const gate = installGatedSuccessfulDelivery("msg-after-first-contact-reset");
        const run = runScenario(context);
        await gate.platformStarted;
        await replaceSessionEntry(
          {
            agentId: "main",
            sessionKey: context.targetSessionKey,
            storePath: context.storePath,
          },
          {
            sessionId: "target-first-contact",
            lifecycleRevision: "revision-first-contact",
            updatedAt: context.nowMs,
          },
        );
        await resetSessionEntryLifecycle({
          agentId: "main",
          storePath: context.storePath,
          target: {
            canonicalKey: context.targetSessionKey,
            storeKeys: [context.targetSessionKey],
          },
          resetBoundaryReason: "reset",
          buildNextEntry: () => ({
            sessionId: "target-after-first-contact-reset",
            lifecycleRevision: "revision-after-first-contact-reset",
            updatedAt: context.nowMs + 1,
          }),
        });
        gate.releasePlatformSend();

        await expect(run).resolves.toMatchObject({ status: "ran" });
        for (const sessionId of ["target-first-contact", "target-after-first-contact-reset"]) {
          expect(await readTargetTranscript(context, sessionId)).not.toContain(
            "Do not adopt a replacement generation.",
          );
        }
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([]);
        expect(
          readSessionStoreForTest<{ delivery?: { context?: { to?: string } } }>(context.storePath)[
            context.targetSessionKey
          ]?.delivery?.context?.to,
        ).toBeUndefined();
      },
    );
  });
});
