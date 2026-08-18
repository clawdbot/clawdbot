import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { expect } from "vitest";
import { requireInvocationOrder } from "./bot-message-dispatch.test-harness.js";

type OrderedMock = { mock: { invocationCallOrder: number[] } };

/**
 * Turn end retires the progress window: no synthesized activity digest is ever
 * written back into it.
 */
export function expectWindowRetiredWithoutSummary(stream: {
  finalizeToPreview: { mock: { calls: unknown[][] } };
}) {
  const digests = stream.finalizeToPreview.mock.calls
    .map((call) => (call[0] as { text?: string } | undefined)?.text ?? "")
    .filter((text) => text.includes("⏱️"));
  expect(digests).toEqual([]);
}

/**
 * Retirement lands after the final, so shrinking the window above it never
 * pushes the final off the anchored viewport. Text windows clear; tool-only
 * windows reposition in place — assert the ordering, not the mechanism.
 */
export function expectWindowRetiredAfterFinal(
  stream: { clear: OrderedMock; rotateToNewMessageDeferringDelete: OrderedMock },
  deliverRepliesMock: OrderedMock,
) {
  const retiredAt = [
    ...stream.clear.mock.invocationCallOrder,
    ...stream.rotateToNewMessageDeferringDelete.mock.invocationCallOrder,
  ].toSorted((a, b) => a - b)[0];
  expect(expectDefined(retiredAt, "progress window retirement")).toBeGreaterThan(
    requireInvocationOrder(deliverRepliesMock, 0, "first reply delivery"),
  );
}
