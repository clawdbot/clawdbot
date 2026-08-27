// Covers target-session bookkeeping failures on either side of recipient-visible delivery.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeTargetSessionDelivery,
  readTargetSessionTranscript,
  TARGET_SESSION_RECIPIENT,
  runTargetSessionScenario,
  STALE_TARGET_SESSION_RECIPIENT,
  type TargetSessionDeliveryRequest,
  withRoutedTargetSessionScenario,
} from "./heartbeat-runner.target-session.test-harness.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { readSessionStoreForTest } from "./heartbeat-runner.test-utils.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "./system-events.js";

const deliverOutboundPayloadsInternal = vi.hoisted(() => vi.fn());
const sessionAccessorMockState = vi.hoisted(() => ({
  failLoadSessionKey: undefined as string | undefined,
  failPatchSessionKey: undefined as string | undefined,
}));

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntry: (...args: Parameters<typeof actual.loadSessionEntry>) => {
      if (args[0].sessionKey === sessionAccessorMockState.failLoadSessionKey) {
        throw new Error("target session snapshot read failed");
      }
      return actual.loadSessionEntry(...args);
    },
    patchSessionEntryCore: async (...args: Parameters<typeof actual.patchSessionEntryCore>) => {
      if (
        args[0].sessionKey === sessionAccessorMockState.failPatchSessionKey &&
        deliverOutboundPayloadsInternal.mock.calls.length > 0
      ) {
        throw new Error("source accounting failed");
      }
      return await actual.patchSessionEntryCore(...args);
    },
  };
});

installHeartbeatRunnerTestRuntime();

beforeEach(() => {
  resetSystemEventsForTest();
  sessionAccessorMockState.failLoadSessionKey = undefined;
  sessionAccessorMockState.failPatchSessionKey = undefined;
  deliverOutboundPayloadsInternal.mockReset();
  deliverOutboundPayloadsInternal.mockImplementation(
    async (request: TargetSessionDeliveryRequest) =>
      completeTargetSessionDelivery(request, "msg-1"),
  );
});

afterEach(() => {
  sessionAccessorMockState.failLoadSessionKey = undefined;
  sessionAccessorMockState.failPatchSessionKey = undefined;
  resetSystemEventsForTest();
});

describe("runHeartbeatOnce - target-session projection failure boundaries", () => {
  it("still sends when refreshing the target snapshot fails before delivery", async () => {
    await withRoutedTargetSessionScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:refresh-read-failure",
        target: { sessionId: "target-session", lastTo: STALE_TARGET_SESSION_RECIPIENT },
      },
      async (context) => {
        context.replySpy.mockImplementationOnce(async () => {
          sessionAccessorMockState.failLoadSessionKey = context.targetSessionKey;
          return { text: "Send despite target refresh failure." };
        });

        await expect(runTargetSessionScenario(context)).resolves.toMatchObject({ status: "ran" });
        expect(deliverOutboundPayloadsInternal).toHaveBeenCalledTimes(1);
        expect(await readTargetSessionTranscript(context)).not.toContain(
          "Send despite target refresh failure.",
        );
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([]);
        expect(
          readSessionStoreForTest<{ delivery?: { context?: { to?: string } } }>(context.storePath)[
            context.targetSessionKey
          ]?.delivery?.context?.to,
        ).toBe(STALE_TARGET_SESSION_RECIPIENT);
      },
    );
  });

  it("finishes target projection when source accounting fails after delivery", async () => {
    await withRoutedTargetSessionScenario(
      {
        targetSessionKey: "agent:main:whatsapp:direct:source-accounting-failure",
        target: { sessionId: "target-session", lastTo: STALE_TARGET_SESSION_RECIPIENT },
        replyText: "Delivered before source accounting failed.",
      },
      async (context) => {
        sessionAccessorMockState.failPatchSessionKey = context.baseSessionKey;

        await expect(runTargetSessionScenario(context)).resolves.toMatchObject({
          status: "failed",
          reason: "source accounting failed",
        });
        expect(deliverOutboundPayloadsInternal).toHaveBeenCalledTimes(1);
        expect(await readTargetSessionTranscript(context)).toContain(
          "Delivered before source accounting failed.",
        );
        expect(
          readSessionStoreForTest<{ delivery?: { context?: { to?: string } } }>(context.storePath)[
            context.targetSessionKey
          ]?.delivery?.context?.to,
        ).toBe(TARGET_SESSION_RECIPIENT);
        expect(peekSystemEventEntries(context.targetSessionKey)).toEqual([
          expect.objectContaining({
            text: [
              "A heartbeat delivered this message to this channel:",
              "Delivered before source accounting failed.",
            ].join("\n"),
          }),
        ]);
      },
    );
  });
});
