import { describe, expect, it } from "vitest";
import { WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-computer.js";
import { WORKER_INFERENCE_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  IDENTITY,
  TRANSCRIPT_COMMIT,
  ATTACHED_IDENTITY,
  waitForWorkerProtocol,
  attachHarness,
  admit,
  setupWorkerProtocolTestState,
} from "./message-handler.worker.test-support.js";

describe("worker computer and media websocket protocol", () => {
  setupWorkerProtocolTestState();

  it.each([true, false])(
    "gates session computer RPC and preserves image responses (supported: %s)",
    async (supported) => {
      const harness = attachHarness({
        identity: {
          ...ATTACHED_IDENTITY,
          protocolFeatures: ATTACHED_IDENTITY.protocolFeatures.filter(
            (feature) => supported || feature !== WORKER_COMPUTER_PROTOCOL_FEATURE,
          ),
        },
      });
      await admit(harness);
      const request = { command: "screen.snapshot", paramsJson: "{}" };
      harness.sendRequest("worker.computer", request);
      await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
      if (supported) {
        expect(harness.service.executeComputer).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: ATTACHED_IDENTITY.sessionId }),
          request,
          expect.any(AbortSignal),
        );
        expect(harness.responses[1]).toMatchObject({
          ok: true,
          payload: { resultJson: expect.stringContaining("a".repeat(128 * 1024)) },
        });
      } else {
        expect(harness.service.executeComputer).not.toHaveBeenCalled();
        expect(harness.responses[1]).toMatchObject({
          ok: false,
          error: { details: { reason: "method-not-allowed" } },
        });
      }
    },
  );

  it.each([
    { name: "image", text: "caption", allowed: true },
    {
      name: "ordinary image",
      protocolFeatures: [
        WORKER_TRANSCRIPT_COMMIT_PROTOCOL_FEATURE,
        WORKER_INFERENCE_PROTOCOL_FEATURE,
      ],
      text: "caption",
      allowed: true,
    },
    {
      name: "oversized control content with image",
      text: "x".repeat(64 * 1024),
      allowed: false,
    },
  ])(
    "admits media transcript frames within the existing image and control limits: $name",
    async ({ protocolFeatures, text, allowed }) => {
      const identity = {
        ...IDENTITY,
        protocolFeatures: protocolFeatures ?? IDENTITY.protocolFeatures,
      };
      const harness = attachHarness({ identity });
      await admit(harness);
      const request = {
        ...TRANSCRIPT_COMMIT,
        messages: [
          {
            role: "toolResult",
            toolCallId: "shot",
            toolName: "computer",
            content: [
              { type: "text", text },
              { type: "image", mimeType: "image/png", data: "a".repeat(128 * 1024) },
            ],
            isError: false,
            timestamp: 1,
          },
        ],
      };
      harness.sendRequest("worker.transcript.commit", request);
      if (allowed) {
        await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
        expect(harness.service.commitTranscript).toHaveBeenCalledWith(identity, request);
        expect(harness.close).not.toHaveBeenCalled();
      } else {
        await waitForWorkerProtocol(() =>
          expect(harness.close).toHaveBeenCalledWith(1009, "invalid-frame"),
        );
        expect(harness.service.commitTranscript).not.toHaveBeenCalled();
      }
    },
  );
});
