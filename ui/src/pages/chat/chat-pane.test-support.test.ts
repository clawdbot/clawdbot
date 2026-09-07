import { expect, it, onTestFinished, vi } from "vitest";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

it("retires pane background work before the fixture's test finishes", () => {
  vi.useFakeTimers();
  const list = vi.fn(async () => null);
  // Completion callbacks run in reverse registration order, so this observes
  // the fixture after its own cleanup, including an import still in flight.
  onTestFinished(async () => {
    try {
      await vi.dynamicImportSettled();
      await vi.runOnlyPendingTimersAsync();
      expect(list).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  const client = createGatewayBrowserClientFixture();
  const sessions = createSessionCapabilityFixture({ canonicalListRevision: 0, list });
  const { pane } = createTestChatPane({ client, sessions });

  pane.applyGatewaySnapshot(pane.context.gateway.snapshot);
});
