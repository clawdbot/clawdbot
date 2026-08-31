// Signal durable-ingress replay proof: a transient Gateway failure during
// approval-reaction resolution must release the real SQLite claim so the real
// drain redelivers the operator's reaction once the Gateway recovers.
// Everything here is real (SQLite queue, monitor, drain, event handler,
// approval-reaction resolution) except the one true external boundary: the
// Gateway approval-resolution call.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSignalApprovalReactionTargetsForTest,
  registerSignalApprovalReactionTarget,
} from "./approval-reactions.js";
import { startSignalIngressMonitor } from "./signal-ingress.js";

const resolverMocks = vi.hoisted(() => ({
  resolveSignalApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveSignalApproval,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", () => ({
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

vi.useRealTimers();
let createBaseSignalEventHandlerDeps: typeof import("./monitor/event-handler.test-harness.js").createBaseSignalEventHandlerDeps;
let createSignalReceiveEvent: typeof import("./monitor/event-handler.test-harness.js").createSignalReceiveEvent;
let createSignalEventHandler: typeof import("./monitor/event-handler.js").createSignalEventHandler;

type SignalIngressQueue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];

beforeAll(async () => {
  const harness = await import("./monitor/event-handler.test-harness.js");
  createBaseSignalEventHandlerDeps = harness.createBaseSignalEventHandlerDeps;
  createSignalReceiveEvent = harness.createSignalReceiveEvent;
  ({ createSignalEventHandler } = await import("./monitor/event-handler.js"));
});

beforeEach(() => {
  clearSignalApprovalReactionTargetsForTest();
  resolverMocks.resolveSignalApproval.mockReset();
  resolverMocks.isApprovalNotFoundError.mockReset();
  resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function withQueue<T>(fn: (queue: SignalIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-ingress-replay-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<SignalIngressPayload>({
    channelId: "signal",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("Signal approval reaction durable replay", () => {
  it(
    "releases the claim and replays a reaction after a transient Gateway failure",
    { timeout: 30_000 },
    async () => {
      await withQueue(async (queue) => {
        // First resolution attempt fails like a transient Gateway 503; the
        // redelivered attempt resolves the approval.
        resolverMocks.resolveSignalApproval
          .mockRejectedValueOnce(new Error("gateway 503"))
          .mockResolvedValue({
            applied: true,
            approval: { status: "allowed", decision: "allow-once" },
          });
        registerSignalApprovalReactionTarget({
          accountId: "default",
          // normalizeE164 preserves '+', matching the conversationKey the handler
          // derives from the sender (signal:+15550001111).
          conversationKey: "+15550001111",
          messageId: "1700000000123",
          approvalId: "approval-abc-123",
          approvalKind: "exec",
          allowedDecisions: ["allow-once"],
          targetAuthorKeys: ["+15550001111"],
          route: { deliveryMode: "session" },
          routeAllowed: true,
        });

        const handler = createSignalEventHandler(
          createBaseSignalEventHandlerDeps({
            cfg: {
              channels: { signal: { allowFrom: ["+15550001111"] } },
              approvals: { exec: { enabled: true, mode: "session" } },
            },
            isSignalReactionMessage: (reaction) => reaction != null,
          }),
        );
        const monitor = await startSignalIngressMonitor({
          accountId: "default",
          queue,
          dispatch: handler,
          runtime: { error: vi.fn(), log: vi.fn() },
        });
        const reactionEvent = createSignalReceiveEvent({
          sourceNumber: "+15550001111",
          reactionMessage: {
            emoji: "👍",
            targetAuthor: "+15550001111",
            targetSentTimestamp: 1700000000123,
          },
        });

        try {
          await monitor.receive(reactionEvent);
          // First attempt: the handler's throw escapes into the real drain.
          await vi.waitFor(
            () => expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledTimes(1),
            { timeout: 5_000 },
          );
          await monitor.waitForIdle();

          // The drain released the claim instead of completing it: the durable
          // row is pending again with the recorded attempt and error. The retry
          // backoff (>=1s from the release) keeps the lane unclaimed here, so
          // this is a produced-state read, never a race against redelivery.
          expect(await queue.listClaims()).toHaveLength(0);
          const pendingAfterFailure = await queue.listPending({ limit: "all" });
          expect(pendingAfterFailure).toHaveLength(1);
          expect(pendingAfterFailure[0]?.attempts).toBe(1);
          expect(pendingAfterFailure[0]?.lastError).toContain("gateway 503");

          // The real drain reclaims and redelivers the same reaction event.
          await vi.waitFor(
            () => expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledTimes(2),
            { timeout: 15_000 },
          );
          await monitor.waitForIdle();

          // Redelivery carried the identical resolution request.
          expect(resolverMocks.resolveSignalApproval.mock.calls[1]?.[0]).toEqual(
            resolverMocks.resolveSignalApproval.mock.calls[0]?.[0],
          );
          expect(resolverMocks.resolveSignalApproval.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({
              approvalId: "approval-abc-123",
              approvalKind: "exec",
              decision: "allow-once",
              channel: "signal",
              accountId: "default",
            }),
          );

          // The replayed attempt resolved the approval and completed the row.
          expect(await queue.listPending({ limit: "all" })).toHaveLength(0);
          expect(await queue.listClaims()).toHaveLength(0);

          // The completion tombstone is durable: the same reaction can never
          // dispatch a third time.
          await monitor.receive(reactionEvent);
          await monitor.waitForIdle();
          expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledTimes(2);
        } finally {
          await monitor.stop();
        }
      });
    },
  );
});
