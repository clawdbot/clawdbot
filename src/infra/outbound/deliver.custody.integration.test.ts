import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deliverFollowupDecision } from "../../auto-reply/reply/followup-delivery.js";
import type { AdmittedFollowupTurn } from "../../auto-reply/reply/followup-turn-admission.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { getDeliveryQueueEntryStatus } from "../delivery-queue-sqlite.js";
import { createQueuedDeliveryOwner } from "./deliver-queue-state.js";
import { drainMatrixReconnect } from "./deliver.queue-integration.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

vi.mock("../../agents/runtime-plan/build.js", () => ({
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

describe("follow-up delivery custody", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["ack", "retire"] as const)(
    "keeps a committed %s released when a later observer throws",
    async (transition) => {
      const stateDir = fixtures.tmpDir();
      const queueId = `custody-${transition}`;
      await enqueueDeliveryOnce(
        { channel: "matrix", to: "!room:example", payloads: [{ text: "settled reply" }] },
        queueId,
        stateDir,
      );
      const owner = createQueuedDeliveryOwner({ queueId, stateDir });
      const observed = (async () => {
        try {
          await owner[transition]();
          throw new Error("terminal observer failed");
        } catch (error) {
          throw owner.project(error);
        }
      })();
      await expect(observed).rejects.toMatchObject({
        message: "terminal observer failed",
        queueCustody: "released",
      });
      expect(await loadPendingDeliveries(stateDir)).toEqual([]);
      if (transition === "retire") {
        expect(getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, queueId, stateDir)).toBe(
          "failed",
        );
      }
    },
  );

  it.each(["AbortError", "Error"])(
    "leaves one sender after an admitted route fails with %s before dispatch",
    async (name) => {
      const tmpDir = fixtures.tmpDir();
      process.env.OPENCLAW_STATE_DIR = tmpDir;
      const accepted: string[] = [];
      let startupClosed = true;
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "matrix",
                config: { listAccountIds: () => [] },
              }),
              message: {
                id: "matrix",
                durableFinal: { capabilities: { text: true } },
                send: {
                  lifecycle: {
                    beforeSendAttempt: async () => {
                      if (startupClosed) {
                        throw Object.assign(new Error("monitor startup closed"), { name });
                      }
                    },
                  },
                  text: async ({ text, onPlatformSendDispatch }) => {
                    await onPlatformSendDispatch?.();
                    accepted.push(text);
                    return {
                      messageId: "recovered",
                      receipt: createMessageReceiptFromOutboundResults({
                        results: [{ channel: "matrix", messageId: "recovered" }],
                        kind: "text",
                      }),
                    };
                  },
                },
              },
            } satisfies ChannelPlugin,
          },
        ]),
      );
      const turn: AdmittedFollowupTurn = {
        runId: "custody-run",
        queued: {
          prompt: "queued",
          enqueuedAt: 1,
          originatingChannel: "matrix",
          originatingTo: "!room:example",
          run: {
            agentId: "agent",
            agentDir: tmpDir,
            sessionId: "session",
            sessionKey: "main",
            sessionFile: `${tmpDir}/session.jsonl`,
            workspaceDir: tmpDir,
            config: {},
            provider: "test",
            model: "test",
            messageProvider: "matrix",
            timeoutMs: 1000,
            blockReplyBreak: "message_end",
          },
        },
        operation: {} as AdmittedFollowupTurn["operation"],
        config: {},
        session: {
          kind: "session",
          key: "main",
          current: () => undefined,
          publish: () => undefined,
          adopt: () => undefined,
        },
        sendPolicy: "allow",
        preflightCompactionApplied: false,
      };
      const nativeSend = vi.fn(async (payload: ReplyPayload) => {
        accepted.push(payload.text ?? "");
      });
      await deliverFollowupDecision({
        decision: { kind: "deliver", payloads: [{ text: "one queued reply" }] },
        turn,
        runId: "custody-run",
        runFollowup: vi.fn(async () => {}),
        defaults: {
          defaultModel: "test",
          typingMode: "never",
          typing: {
            onReplyStart: vi.fn(async () => {}),
            startTypingLoop: vi.fn(async () => {}),
            startTypingOnText: vi.fn(async () => {}),
            refreshTypingTtl: vi.fn(),
            isActive: () => false,
            markRunComplete: vi.fn(),
            markDispatchIdle: vi.fn(),
            cleanup: vi.fn(),
          },
          opts: { onBlockReply: nativeSend },
        },
      });
      const pending = await loadPendingDeliveries(tmpDir);
      expect(pending).toHaveLength(1);
      startupClosed = false;
      await drainMatrixReconnect({ stateDir: tmpDir, deliver: deliverOutboundPayloads });
      expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
      expect(accepted).toEqual(["one queued reply"]);
      expect(nativeSend).not.toHaveBeenCalled();
    },
  );
});
