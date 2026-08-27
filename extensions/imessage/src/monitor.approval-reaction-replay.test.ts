// IMessage durable-ingress replay proof: a transient Gateway failure during
// approval-reaction resolution must release the real SQLite claim so the real
// drain redelivers the operator's reaction once the Gateway recovers.
// Everything here is real (SQLite queue, monitor, drain, approval-reaction
// resolution) except the one true external boundary: the Gateway
// approval-resolution call.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearIMessageApprovalReactionTargetsForTest,
  maybeResolveIMessageApprovalReaction,
  registerIMessageApprovalReactionTarget,
} from "./approval-reactions.js";
import { createIMessageDurableIngress } from "./monitor/ingress.js";
import type { IMessagePayload } from "./monitor/types.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const resolverMocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveApprovalOverGateway,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/error-runtime")>(
    "openclaw/plugin-sdk/error-runtime",
  );
  return {
    ...actual,
    isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
  };
});

vi.useRealTimers();

type IMessageIngressQueue = NonNullable<
  Parameters<typeof createIMessageDurableIngress>[0]["queue"]
>;
type IMessageIngressPayload = Parameters<IMessageIngressQueue["enqueue"]>[1];

beforeEach(() => {
  clearIMessageApprovalReactionTargetsForTest();
  installIMessageStateRuntimeForTest();
  resolverMocks.resolveApprovalOverGateway.mockReset();
  resolverMocks.isApprovalNotFoundError.mockReset();
  resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function withQueue<T>(fn: (queue: IMessageIngressQueue) => Promise<T>): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-ingress-replay-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<IMessageIngressPayload>({
    channelId: "imessage",
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

function buildReactionIngressRow(): { message: IMessagePayload } {
  return {
    message: {
      id: 42,
      guid: "guid-reaction-1",
      chat_id: 7,
      sender: "+15551230000",
      is_reaction: true,
      reaction_emoji: "👍",
      reacted_to_guid: "pending-approval",
    } as IMessagePayload,
  };
}

describe("iMessage approval reaction durable replay", () => {
  it(
    "releases the claim and replays a reaction after a transient Gateway failure",
    { timeout: 30_000 },
    async () => {
      await withQueue(async (queue) => {
        // The iMessage drain reclaims a released row with no backoff window, so
        // the released-pending state is not stably observable. Hold the
        // redelivered attempt open instead: reaching it at all proves the drain
        // released and reclaimed the claim rather than completing it.
        let openSecondAttempt = () => {};
        const secondAttemptGate = new Promise<void>((resolve) => {
          openSecondAttempt = resolve;
        });
        resolverMocks.resolveApprovalOverGateway
          .mockRejectedValueOnce(new Error("gateway 503"))
          .mockImplementationOnce(async () => {
            await secondAttemptGate;
            return {
              applied: true,
              approval: { status: "allowed", decision: "allow-once", reason: "user" },
            };
          });
        registerIMessageApprovalReactionTarget({
          accountId: "default",
          conversation: { chatId: 7, handle: "+15551230000" },
          messageId: "pending-approval",
          approvalId: "approval-abc-123",
          approvalKind: "exec",
          allowedDecisions: ["allow-once", "deny"],
        });

        const cfg = {
          channels: { imessage: { allowFrom: ["+15551230000"] } },
        } as Parameters<typeof maybeResolveIMessageApprovalReaction>[0]["cfg"];
        const chatLaneDispatch = vi.fn(async () => ({ kind: "completed" as const }));
        const monitor = createIMessageDurableIngress({
          accountId: "default",
          queue,
          // Mirrors the monitor-provider ownership mapping for the reaction
          // path: a handled reaction completes the claim, anything else falls
          // through to the chat lane, and a thrown resolver error escapes into
          // the real drain. The chat lane completes like production would, so
          // a fall-through finishes the claim without any replay.
          dispatchPriority: async (message) => {
            const handled = await maybeResolveIMessageApprovalReaction({
              cfg,
              accountId: "default",
              message,
              bodyText: "",
            });
            return handled ? { kind: "completed" as const } : undefined;
          },
          dispatch: chatLaneDispatch,
          runtime: { error: vi.fn(), log: vi.fn() },
        });
        monitor.start();
        const reactionRow = buildReactionIngressRow();

        try {
          await monitor.receive(reactionRow);
          // The first attempt throws into the real drain; the drain releases
          // the claim and redelivers the same row. A completed or dropped
          // claim could never produce this second call.
          await vi.waitFor(
            () => expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledTimes(2),
            { timeout: 15_000 },
          );

          // The reaction must stay in the approval lane: falling through to
          // the chat lane would complete the claim without any replay.
          expect(chatLaneDispatch).not.toHaveBeenCalled();

          // Redelivery carried the identical resolution request.
          expect(resolverMocks.resolveApprovalOverGateway.mock.calls[1]?.[0]).toEqual(
            resolverMocks.resolveApprovalOverGateway.mock.calls[0]?.[0],
          );
          expect(resolverMocks.resolveApprovalOverGateway.mock.calls[1]?.[0]).toEqual(
            expect.objectContaining({
              approvalId: "approval-abc-123",
              approvalKind: "exec",
              decision: "allow-once",
              channel: "imessage",
              accountId: "default",
            }),
          );

          // The redelivered row stays claimed (not completed, not lost) while
          // its delivery is still open.
          expect(await queue.listClaims()).toHaveLength(1);

          // Let the replayed attempt resolve the approval and complete the row.
          openSecondAttempt();
          await monitor.waitForIdle();
          expect(await queue.listPending({ limit: "all" })).toHaveLength(0);
          expect(await queue.listClaims()).toHaveLength(0);

          // The completion tombstone is durable: the same reaction can never
          // dispatch a third time.
          await monitor.receive(reactionRow);
          await monitor.waitForIdle();
          expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
        } finally {
          openSecondAttempt();
          await monitor.stop();
        }
      });
    },
  );
});
