import type { ReceiverEvent } from "@slack/bolt";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachIngress, withQueue, type SlackIngressPayload } from "./ingress.test-harness.js";

describe("Slack interaction durable ingress", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetSystemEventsForTest();
  });

  function createSlackBlockActionsBody(): Record<string, PluginJsonValue> {
    return {
      type: "block_actions",
      team: { id: "T_TEST", domain: "test" },
      user: { id: "U_TEST", username: "alice", team_id: "T_TEST" },
      api_app_id: "A_TEST",
      token: "legacy-verification-token",
      trigger_id: "trigger-1",
      container: { type: "message", channel_id: "C_TEST", message_ts: "1700000000.000200" },
      channel: { id: "C_TEST", name: "general" },
      response_url: "https://slack.test/response/1",
      actions: [
        {
          type: "button",
          action_id: "openclaw:verify",
          block_id: "b1",
          action_ts: "1700000000.000300",
        },
      ],
    };
  }

  it("does not acknowledge an interaction when the durable append fails", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("database unavailable");
      });
      const failingQueue = { ...queue, enqueue } as ChannelIngressQueue<SlackIngressPayload>;
      const processEvent = vi.fn(async () => {});
      const { ingress, receive } = attachIngress(failingQueue, processEvent);
      const ack = vi.fn(async () => {});

      await expect(receive({ body: createSlackBlockActionsBody(), ack })).rejects.toThrow(
        "database unavailable",
      );

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(ack).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("acknowledges an interaction only after durable admission and replays it after restart", async () => {
    await withQueue(async (queue) => {
      const preRestartDispatch = vi.fn(async () => {});
      const first = attachIngress(queue, preRestartDispatch);
      const ack = vi.fn(async () => {});

      await first.receive({ body: createSlackBlockActionsBody(), ack });

      expect(ack).toHaveBeenCalledTimes(1);
      expect(preRestartDispatch).not.toHaveBeenCalled();
      await first.ingress.stop();

      const dispatch = vi.fn(async (_event: ReceiverEvent) => {});
      const restarted = attachIngress(queue, dispatch);
      restarted.ingress.start();
      await restarted.ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      const expected = createSlackBlockActionsBody();
      delete expected.token;
      expect(dispatch.mock.calls[0]?.[0]?.body).toEqual(expected);
      await restarted.ingress.stop();
    });
  });

  it("does not persist the legacy verification token in the interaction row", async () => {
    await withQueue(async (queue) => {
      const payloads: SlackIngressPayload[] = [];
      const enqueue = vi.fn(async (...args: Parameters<typeof queue.enqueue>) => {
        payloads.push(args[1]);
        return await queue.enqueue(...args);
      }) as ChannelIngressQueue<SlackIngressPayload>["enqueue"];
      const spyQueue = { ...queue, enqueue } as ChannelIngressQueue<SlackIngressPayload>;
      const { ingress, receive } = attachIngress(spyQueue, async () => {});

      await receive({ body: createSlackBlockActionsBody(), ack: vi.fn(async () => {}) });

      expect(payloads).toHaveLength(1);
      const stored = payloads[0] as { kind: string; body: Record<string, unknown> };
      expect(stored.kind).toBe("interaction");
      expect(stored.body.token).toBeUndefined();
      expect(stored.body.response_url).toBe("https://slack.test/response/1");
      await ingress.stop();
    });
  });

  it("admits every empty-acknowledgement interaction type durably", async () => {
    await withQueue(async (queue) => {
      const admitted: string[] = [];
      const enqueue = vi.fn(async (...args: Parameters<typeof queue.enqueue>) => {
        admitted.push(args[0]);
        return await queue.enqueue(...args);
      }) as ChannelIngressQueue<SlackIngressPayload>["enqueue"];
      const spyQueue = { ...queue, enqueue } as ChannelIngressQueue<SlackIngressPayload>;
      const processEvent = vi.fn(async () => {});
      const { ingress, receive } = attachIngress(spyQueue, processEvent);

      for (const type of ["shortcut", "message_action", "view_submission", "view_closed"]) {
        const ack = vi.fn(async () => {});
        await receive({ body: { type, user: { id: "U_TEST" }, team: { id: "T_TEST" } }, ack });
        expect(ack).toHaveBeenCalledTimes(1);
      }

      expect(admitted).toHaveLength(4);
      expect(admitted.every((id) => id.startsWith("interaction:"))).toBe(true);
      expect(processEvent).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("keeps payload-bearing acknowledgement types on the synchronous path", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("unexpected durable admission");
      });
      const spyQueue = { ...queue, enqueue } as ChannelIngressQueue<SlackIngressPayload>;
      const processEvent = vi.fn(async () => {});
      const { ingress, receive } = attachIngress(spyQueue, processEvent);

      await receive({
        body: { type: "block_suggestion", action_id: "openclaw:cmdarg", value: "he" },
        ack: vi.fn(async () => {}),
      });
      await receive({
        body: { command: "/openclaw", user_id: "U_TEST", channel_id: "C_TEST" },
        ack: vi.fn(async () => {}),
      });

      expect(processEvent).toHaveBeenCalledTimes(2);
      expect(enqueue).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });
});
