// Slack tests cover durable Events API admission, replay, and tombstones.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { App, type Receiver, type ReceiverEvent } from "@slack/bolt";
import type { WebClientOptions } from "@slack/web-api";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type {
  ChannelIngressMonitorLifecycle,
  ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackMonitorContext } from "./context.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { createSlackDurableIngress, resolveSlackIngressTurnLifecycle } from "./ingress.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

function createSlackEnvelope(
  eventId: string,
  ts = "1700000000.000100",
  event?: Record<string, PluginJsonValue>,
) {
  return {
    team_id: "T_TEST",
    api_app_id: "A_TEST",
    type: "event_callback",
    event_id: eventId,
    event_time: 1_700_000_000,
    event: event ?? {
      type: "message",
      channel: "C_TEST",
      user: "U_TEST",
      ts,
      client_msg_id: "client-message-1",
      text: "hello",
    },
  };
}

function createChannelIdChangedEnvelope(
  eventId: string,
  oldChannelId: string,
  newChannelId: string,
) {
  return {
    team_id: "T_TEST",
    api_app_id: "A_TEST",
    type: "event_callback",
    event_id: eventId,
    event_time: 1_700_000_000,
    event: {
      type: "channel_id_changed",
      old_channel_id: oldChannelId,
      new_channel_id: newChannelId,
    },
  };
}

function createReceiverHarness() {
  let receive: ((event: ReceiverEvent) => Promise<void>) | undefined;
  const receiver: Receiver = {
    init: (app) => {
      receive = async (event) => await app.processEvent(event);
    },
    start: async () => undefined,
    stop: async () => undefined,
  };
  return {
    receiver,
    receive: async (event: ReceiverEvent) => {
      if (!receive) {
        throw new Error("Receiver not initialized");
      }
      await receive(event);
    },
  };
}

function createReceiverEvent(
  eventId: string,
  ack = vi.fn(async () => {}),
  options: {
    retryNum?: number;
    ts?: string;
    event?: Record<string, PluginJsonValue>;
  } = {},
): ReceiverEvent {
  return {
    body: createSlackEnvelope(eventId, options.ts, options.event),
    ack,
    ...(options.retryNum === undefined ? {} : { retryNum: options.retryNum }),
  };
}

function createMemberEvent(type: "member_joined_channel" | "member_left_channel", eventTs: string) {
  return {
    type,
    user: "U_TEST",
    channel: "C_TEST",
    channel_type: "channel",
    event_ts: eventTs,
  };
}

function attachBoltMemberIngress(params: {
  queue: ChannelIngressQueue<SlackIngressPayload>;
  trackEvent: () => void;
  usersInfo?: App["client"]["users"]["info"];
  usersInfoFetch?: NonNullable<WebClientOptions["fetch"]>;
  pollIntervalMs?: number;
}) {
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue: params.queue,
    pollIntervalMs: params.pollIntervalMs ?? 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
  const receiverHarness = createReceiverHarness();
  const app = new App({
    receiver: ingress.wrapReceiver(receiverHarness.receiver),
    authorize: async () => ({
      botToken: "xoxb-test",
      botId: "B_BOT",
      botUserId: "U_BOT",
      teamId: "T_TEST",
    }),
    ...(params.usersInfoFetch
      ? {
          clientOptions: {
            fetch: params.usersInfoFetch,
            retryConfig: { retries: 0 },
            slackApiUrl: "https://slack.test/api/",
          },
        }
      : {}),
    convoStore: false,
    ignoreSelf: false,
  });
  vi.spyOn(app.client.conversations, "info").mockResolvedValue({
    ok: true,
    channel: { id: "C_TEST", name: "general", is_channel: true },
  });
  if (!params.usersInfoFetch) {
    vi.spyOn(app.client.users, "info").mockImplementation(
      params.usersInfo ??
        (async () => ({
          ok: true,
          user: { id: "U_TEST", name: "alice" },
        })),
    );
  }
  const ctx = createSlackMonitorContext({
    cfg: {} as OpenClawConfig,
    accountId: "default",
    botToken: "xoxb-test",
    app,
    runtime: {} as RuntimeEnv,
    botUserId: "U_BOT",
    botId: "B_BOT",
    identityHealth: { lifecycle: "ready", lastError: null },
    teamId: "T_TEST",
    apiAppId: "A_TEST",
    installationIdentity: { kind: "workspace", teamId: "T_TEST" },
    historyLimit: 0,
    sessionScope: "per-sender",
    mainKey: "main",
    dmEnabled: true,
    dmPolicy: "open",
    allowFrom: [],
    allowNameMatching: true,
    groupDmEnabled: true,
    groupDmChannels: [],
    defaultRequireMention: true,
    channelsConfig: { C_TEST: { users: ["alice"], enabled: true } },
    groupPolicy: "open",
    useAccessGroups: false,
    reactionMode: "off",
    reactionAllowlist: [],
    replyToMode: "off",
    slashCommand: {
      enabled: false,
      name: "openclaw",
      sessionPrefix: "slack:slash",
      ephemeral: true,
    },
    textLimit: 4000,
    ackReactionScope: "group-mentions",
    typingReaction: "",
    mediaMaxBytes: 1,
    threadHistoryScope: "thread",
    threadInheritParent: false,
  });
  registerSlackMemberEvents({ ctx, trackEvent: params.trackEvent });
  return { ingress, receive: receiverHarness.receive };
}

function createReceiverEventWithBody(body: Record<string, unknown>): ReceiverEvent {
  return { body, ack: vi.fn(async () => {}) };
}

function attachIngress(
  queue: ChannelIngressQueue<SlackIngressPayload>,
  processEvent: (event: ReceiverEvent) => Promise<void>,
  options: { adoptionStallTimeoutMs?: number } = {},
) {
  const ingress = createSlackDurableIngress({
    accountId: "default",
    queue,
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? 5_000,
  });
  const harness = createReceiverHarness();
  ingress.wrapReceiver(harness.receiver).init({ processEvent } as App);
  return { ingress, receive: harness.receive };
}

async function withQueue(
  fn: (queue: ChannelIngressQueue<SlackIngressPayload>) => Promise<void>,
): Promise<void> {
  const rawRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `openclaw-slack-ingress-${crypto.randomUUID()}-`),
  );
  const stateDir = await fs.realpath(rawRoot);
  const queue = createChannelIngressQueueForTests<SlackIngressPayload>({
    channelId: "slack",
    accountId: "default",
    stateDir,
  });
  try {
    await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("Slack durable ingress", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetSystemEventsForTest();
  });

  it("does not acknowledge when the durable append fails", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("database unavailable");
      });
      const failingQueue = { ...queue, enqueue } as ChannelIngressQueue<SlackIngressPayload>;
      const processEvent = vi.fn(async () => {});
      const { ingress, receive } = attachIngress(failingQueue, processEvent);
      const ack = vi.fn(async () => {});

      await expect(receive(createReceiverEvent("Ev-append-failure", ack))).rejects.toThrow(
        "database unavailable",
      );

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(ack).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("acknowledges a durable event before dispatch starts", async () => {
    await withQueue(async (queue) => {
      let releaseAck = () => {};
      const ackGate = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      const order: string[] = [];
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        order.push("dispatch");
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      const ack = vi.fn(async () => {
        order.push("ack-start");
        await ackGate;
        order.push("ack-complete");
      });
      ingress.start();

      const receiving = receive(createReceiverEvent("Ev-ack-order", ack));
      await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1));
      expect(processEvent).not.toHaveBeenCalled();

      releaseAck();
      await receiving;
      await ingress.waitForIdle();

      expect(order).toEqual(["ack-start", "ack-complete", "dispatch"]);
      await ingress.stop();
    });
  });

  it("dispatches independently routed threads concurrently after session ownership is established", async () => {
    await withQueue(async (queue) => {
      let releaseFirstDispatch: () => void = () => {};
      const firstDispatchGate = new Promise<void>((resolve) => {
        releaseFirstDispatch = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const event = (receiverEvent.body as { event: { thread_ts: string } }).event;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties);
        await lifecycle?.onSessionRouted?.(`agent:main:slack:thread:${event.thread_ts}`);
        starts.push(event.thread_ts);
        if (event.thread_ts === "1700000000.000100") {
          await firstDispatchGate;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();

      try {
        for (const [eventId, threadTs, ts] of [
          ["Ev-thread-one", "1700000000.000100", "1700000000.000101"],
          ["Ev-thread-two", "1700000000.000200", "1700000000.000201"],
        ] as const) {
          await receive(
            createReceiverEvent(eventId, undefined, {
              event: {
                type: "message",
                channel: "C_TEST",
                channel_type: "channel",
                user: "U_TEST",
                thread_ts: threadTs,
                ts,
                text: "thread reply",
              },
            }),
          );
        }

        await vi.waitFor(() => expect(starts).toHaveLength(2), { timeout: 500 });
        expect(starts).toEqual(["1700000000.000100", "1700000000.000200"]);
      } finally {
        releaseFirstDispatch();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it.each<{
    name: string;
    firstEvent: Record<string, PluginJsonValue> & { ts: string };
    secondEvent: Record<string, PluginJsonValue> & { ts: string };
  }>([
    {
      name: "top-level channel messages",
      firstEvent: { ts: "1700000000.000100" },
      secondEvent: { ts: "1700000000.000200" },
    },
    {
      name: "threads bound to the same configured session",
      firstEvent: { ts: "1700000000.000101", thread_ts: "1700000000.000100" },
      secondEvent: { ts: "1700000000.000201", thread_ts: "1700000000.000200" },
    },
  ])("serializes $name by their authoritative session", async ({ firstEvent, secondEvent }) => {
    await withQueue(async (queue) => {
      let releaseFirstDispatch: () => void = () => {};
      const firstDispatchGate = new Promise<void>((resolve) => {
        releaseFirstDispatch = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const event = (receiverEvent.body as { event: { ts: string } }).event;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:shared-session");
        starts.push(event.ts);
        if (event.ts === firstEvent.ts) {
          await firstDispatchGate;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();

      try {
        for (const [eventId, event] of [
          ["Ev-shared-first", firstEvent],
          ["Ev-shared-second", secondEvent],
        ] as const) {
          await receive(
            createReceiverEvent(eventId, undefined, {
              event: {
                type: "message",
                channel: "C_TEST",
                channel_type: "channel",
                user: "U_TEST",
                text: "shared session",
                ...event,
              },
            }),
          );
        }

        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(2), { timeout: 500 });
        expect(starts).toEqual([firstEvent.ts]);
        releaseFirstDispatch();
        await ingress.waitForIdle();
        expect(starts).toEqual([firstEvent.ts, secondEvent.ts]);
      } finally {
        releaseFirstDispatch();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it("keeps a queued same-session event alive past the adoption watchdog", async () => {
    await withQueue(async (queue) => {
      let releaseFirstSettlement: () => void = () => {};
      const firstSettlement = new Promise<void>((resolve) => {
        releaseFirstSettlement = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const eventId = (receiverEvent.body as { event_id: string }).event_id;
        const lifecycle = resolveSlackIngressTurnLifecycle(receiverEvent.customProperties);
        await lifecycle?.onSessionRouted?.("agent:main:slack:shared-session");
        starts.push(eventId);
        if (eventId === "Ev-session-watchdog-first") {
          (lifecycle as ChannelIngressMonitorLifecycle).onAdoptionFinalizing();
          await firstSettlement;
        }
        await lifecycle?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent, {
        adoptionStallTimeoutMs: 80,
      });
      ingress.start();

      try {
        await receive(createReceiverEvent("Ev-session-watchdog-first"));
        await receive(createReceiverEvent("Ev-session-watchdog-second"));
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(2));
        expect(starts).toEqual(["Ev-session-watchdog-first"]);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 120);
        });
        await receive(createReceiverEvent("Ev-session-watchdog-third"));
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(3));
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
          "Ev-session-watchdog-first",
          "Ev-session-watchdog-second",
          "Ev-session-watchdog-third",
        ]);
        expect(starts).toEqual(["Ev-session-watchdog-first"]);

        releaseFirstSettlement();
        await ingress.waitForIdle();
        expect(starts).toEqual([
          "Ev-session-watchdog-first",
          "Ev-session-watchdog-second",
          "Ev-session-watchdog-third",
        ]);
        expect(processEvent).toHaveBeenCalledTimes(3);
        expect(await queue.listPending()).toEqual([]);
      } finally {
        releaseFirstSettlement();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it("serializes new-channel messages behind channel-ID migration", async () => {
    await withQueue(async (queue) => {
      let markMigrationStarted: () => void = () => {};
      let releaseMigration: () => void = () => {};
      const migrationStarted = new Promise<void>((resolve) => {
        markMigrationStarted = resolve;
      });
      const migrationGate = new Promise<void>((resolve) => {
        releaseMigration = resolve;
      });
      const starts: string[] = [];
      const processEvent = vi.fn(async (receiverEvent: ReceiverEvent) => {
        const event = (receiverEvent.body as { event?: { type?: string } }).event;
        const type = event?.type ?? "unknown";
        starts.push(type);
        if (type === "channel_id_changed") {
          markMigrationStarted();
          await migrationGate;
        }
        await resolveSlackIngressTurnLifecycle(receiverEvent.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      ingress.start();

      await receive(
        createReceiverEventWithBody(
          createChannelIdChangedEnvelope("Ev-channel-migrate", "C_OLD", "C_NEW"),
        ),
      );
      await receive(
        createReceiverEventWithBody({
          ...createSlackEnvelope("Ev-new-channel-message"),
          event: {
            type: "message",
            channel: "C_NEW",
            channel_type: "channel",
            user: "U_TEST",
            ts: "1700000000.000200",
            thread_ts: "1700000000.000100",
            text: "after migration",
          },
        }),
      );

      await migrationStarted;
      await Promise.resolve();
      expect(starts).toEqual(["channel_id_changed"]);

      releaseMigration();
      await ingress.waitForIdle();
      expect(starts).toEqual(["channel_id_changed", "message"]);
      await ingress.stop();
    });
  });

  it.each([
    { name: "an already routed message", deferred: false },
    { name: "a deferred message", deferred: true },
  ])("serializes channel-ID migration behind $name through Bolt", async ({ deferred }) => {
    await withQueue(async (queue) => {
      let markMessageStarted: () => void = () => {};
      let releaseMessage: () => void = () => {};
      let releaseMigration: () => void = () => {};
      const messageStarted = new Promise<void>((resolve) => {
        markMessageStarted = resolve;
      });
      const messageGate = new Promise<void>((resolve) => {
        releaseMessage = resolve;
      });
      const migrationGate = new Promise<void>((resolve) => {
        releaseMigration = resolve;
      });
      const starts: string[] = [];
      const ingress = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      const harness = createReceiverHarness();
      const app = new App({
        receiver: ingress.wrapReceiver(harness.receiver),
        authorize: async () => ({
          botToken: "xoxb-test",
          botId: "B_BOT",
          botUserId: "U_BOT",
          teamId: "T_TEST",
        }),
        convoStore: false,
        ignoreSelf: false,
      });
      app.event("message", async ({ context }) => {
        const lifecycle = resolveSlackIngressTurnLifecycle(context);
        await lifecycle?.onSessionRouted?.("agent:main:slack:thread:C_NEW");
        starts.push("message");
        if (deferred) {
          lifecycle?.onDeferred();
        }
        markMessageStarted();
        await messageGate;
        await lifecycle?.onAdopted();
      });
      app.event("channel_id_changed", async ({ context }) => {
        starts.push("channel_id_changed");
        await migrationGate;
        await resolveSlackIngressTurnLifecycle(context)?.onAdopted();
      });
      ingress.start();

      try {
        await harness.receive(
          createReceiverEventWithBody({
            ...createSlackEnvelope("Ev-routed-before-migration"),
            event: {
              type: "message",
              channel: "C_NEW",
              channel_type: "channel",
              user: "U_TEST",
              ts: "1700000000.000200",
              thread_ts: "1700000000.000100",
              text: "before migration",
            },
          }),
        );
        await messageStarted;
        await harness.receive(
          createReceiverEventWithBody(
            createChannelIdChangedEnvelope("Ev-migration-after-route", "C_OLD", "C_NEW"),
          ),
        );
        await vi.waitFor(async () => {
          expect((await queue.listClaims()).map((claim) => claim.id)).toEqual([
            "Ev-routed-before-migration",
            "Ev-migration-after-route",
          ]);
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(starts).toEqual(["message"]);

        releaseMessage();
        await vi.waitFor(() => expect(starts).toEqual(["message", "channel_id_changed"]));
      } finally {
        releaseMessage();
        releaseMigration();
        await ingress.waitForIdle();
        await ingress.stop();
      }
    });
  });

  it("drains a durable event when its acknowledgement fails", async () => {
    await withQueue(async (queue) => {
      const processEvent = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, processEvent);
      const ackError = new Error("connection closed");
      ingress.start();

      await expect(
        receive(createReceiverEvent("Ev-ack-failure", vi.fn().mockRejectedValue(ackError))),
      ).rejects.toBe(ackError);
      await ingress.waitForIdle();

      expect(processEvent).toHaveBeenCalledTimes(1);
      await ingress.stop();
    });
  });

  it("recovers an uncompleted event with a fresh drain and dispatches once", async () => {
    await withQueue(async (queue) => {
      const first = attachIngress(
        queue,
        vi.fn(async () => {}),
      );
      const ack = vi.fn(async () => {});
      await first.receive(createReceiverEvent("Ev-restart", ack));
      await first.ingress.stop();

      const dispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const restarted = attachIngress(queue, dispatch);
      restarted.ingress.start();
      await restarted.ingress.waitForIdle();

      expect(ack).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("Ev-restart", {} as SlackIngressPayload)).kind).toBe("completed");
      await restarted.ingress.stop();
    });
  });

  it.each([
    { name: "a lane derived only at drain time", laneKey: undefined },
    { name: "its persisted channel-only lane", laneKey: "team:T_TEST:conversation:C_TEST" },
  ])("recovers a shipped threaded row with $name", async ({ laneKey }) => {
    await withQueue(async (queue) => {
      const body = createSlackEnvelope("Ev-legacy-lane", undefined, {
        type: "message",
        channel: "C_TEST",
        channel_type: "channel",
        user: "U_TEST",
        ts: "1700000000.000101",
        thread_ts: "1700000000.000100",
        text: "persisted thread reply",
      });
      await queue.enqueue(
        "Ev-legacy-lane",
        {
          version: 1,
          receivedAt: 1_700_000_000_000,
          kind: "events-api",
          body,
        },
        { receivedAt: 1_700_000_000_000, ...(laneKey ? { laneKey } : {}) },
      );
      const dispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const recovered = attachIngress(queue, dispatch);
      recovered.ingress.start();
      await recovered.ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("Ev-legacy-lane", {} as SlackIngressPayload)).kind).toBe(
        "completed",
      );
      await recovered.ingress.stop();
    });
  });

  it("retains completion so the same event_id cannot dispatch twice", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const { ingress, receive } = attachIngress(queue, dispatch);
      ingress.start();
      await receive(createReceiverEvent("Ev-completed"));
      await ingress.waitForIdle();

      const duplicateAck = vi.fn(async () => {});
      await receive(createReceiverEvent("Ev-completed", duplicateAck, { retryNum: 1 }));
      await ingress.waitForIdle();

      expect(duplicateAck).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("Ev-completed", {} as SlackIngressPayload)).kind).toBe(
        "completed",
      );
      await ingress.stop();
    });
  });

  it("dedupes Slack's delayed message redelivery after restart via the tombstone", async () => {
    await withQueue(async (queue) => {
      const firstDispatch = vi.fn(async (event: ReceiverEvent) => {
        await resolveSlackIngressTurnLifecycle(event.customProperties)?.onAdopted();
      });
      const first = attachIngress(queue, firstDispatch);
      first.ingress.start();
      await first.receive(
        createReceiverEvent("Ev-delayed-redelivery", undefined, {
          ts: "1700000000.000350",
        }),
      );
      await first.ingress.waitForIdle();
      await first.ingress.stop();

      const replayDispatch = vi.fn(async () => {});
      const restarted = attachIngress(queue, replayDispatch);
      const retryAck = vi.fn(async () => {});
      await restarted.receive(
        createReceiverEvent("Ev-delayed-redelivery", retryAck, {
          retryNum: 3,
          ts: "1700000000.000350",
        }),
      );
      restarted.ingress.start();
      await restarted.ingress.waitForIdle();

      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(retryAck).toHaveBeenCalledTimes(1);
      expect(replayDispatch).not.toHaveBeenCalled();
      await restarted.ingress.stop();
    });
  });

  it("preserves repeated member occurrences through Bolt while deduping Slack retries", async () => {
    await withQueue(async (queue) => {
      const trackEvent = vi.fn();
      const { ingress, receive } = attachBoltMemberIngress({ queue, trackEvent });
      ingress.start();
      try {
        for (const [eventId, event] of [
          ["Ev-member-join-1", createMemberEvent("member_joined_channel", "100.001")],
          ["Ev-member-left", createMemberEvent("member_left_channel", "100.002")],
          ["Ev-member-join-2", createMemberEvent("member_joined_channel", "100.003")],
        ] as const) {
          await receive(createReceiverEvent(eventId, undefined, { event }));
          await ingress.waitForIdle();
        }
        await receive(
          createReceiverEvent("Ev-member-join-2", undefined, {
            retryNum: 1,
            event: createMemberEvent("member_joined_channel", "100.003"),
          }),
        );
        await ingress.waitForIdle();

        expect(trackEvent).toHaveBeenCalledTimes(3);
        expect(
          peekSystemEventEntries("agent:main:slack:channel:c_test").map(
            (entry) => entry.contextKey,
          ),
        ).toEqual([
          "slack:member:joined:c_test:u_test:ev-member-join-1",
          "slack:member:left:c_test:u_test:ev-member-left",
          "slack:member:joined:c_test:u_test:ev-member-join-2",
        ]);
      } finally {
        await ingress.stop();
      }
    });
  });

  it("retries transient member failures through Bolt after restart", async () => {
    await withQueue(async (queue) => {
      const trackEvent = vi.fn();
      let usersInfoRequests = 0;
      const usersInfoFetch = vi.fn<NonNullable<WebClientOptions["fetch"]>>(async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/conversations.info")) {
          return new Response(
            JSON.stringify({
              ok: true,
              channel: { id: "C_TEST", name: "general", is_channel: true },
            }),
            { headers: { "content-type": "application/json" }, status: 200 },
          );
        }
        if (!pathname.endsWith("/users.info")) {
          throw new Error(`unexpected Slack API request: ${pathname}`);
        }
        usersInfoRequests += 1;
        if (usersInfoRequests === 1) {
          return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            headers: { "content-type": "application/json", "retry-after": "0" },
            status: 429,
          });
        }
        return new Response(JSON.stringify({ ok: true, user: { id: "U_TEST", name: "alice" } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      });
      const first = attachBoltMemberIngress({ queue, trackEvent, usersInfoFetch });
      first.ingress.start();
      let restarted: ReturnType<typeof attachBoltMemberIngress> | undefined;
      try {
        await first.receive(
          createReceiverEvent("Ev-member-retry", undefined, {
            event: createMemberEvent("member_joined_channel", "200.001"),
          }),
        );
        await first.ingress.waitForIdle();
        await first.ingress.stop();

        expect(trackEvent).toHaveBeenCalledTimes(1);
        expect(peekSystemEventEntries("agent:main:slack:channel:c_test")).toHaveLength(0);
        expect((await queue.listPending()).map((entry) => entry.id)).toContain("Ev-member-retry");

        restarted = attachBoltMemberIngress({
          queue,
          trackEvent,
          usersInfoFetch,
          pollIntervalMs: 25,
        });
        restarted.ingress.start();
        await vi.waitFor(
          async () => {
            await restarted?.ingress.waitForIdle();
            expect(trackEvent).toHaveBeenCalledTimes(2);
          },
          { timeout: 15_000, interval: 100 },
        );

        expect(usersInfoRequests).toBe(2);
        expect(peekSystemEventEntries("agent:main:slack:channel:c_test")).toHaveLength(1);
      } finally {
        await first.ingress.stop();
        await restarted?.ingress.stop();
      }
    });
  });
});

describe("Slack relay durable ingress", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  const relayMessage = {
    type: "message",
    channel: "C_RELAY",
    team: "T_TEST",
    user: "U_TEST",
    ts: "1700000001.000200",
    text: "relayed",
  };

  it("dedupes a router redelivery by logical message identity, not delivery id", async () => {
    await withQueue(async (queue) => {
      const dispatched: unknown[] = [];
      const ingress = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      ingress.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      ingress.start();

      await ingress.acceptRelayEvent({ deliveryId: "delivery-1", message: relayMessage });
      await ingress.waitForIdle();
      // Redelivery after a lost ack carries a fresh delivery id but the same message.
      await ingress.acceptRelayEvent({ deliveryId: "delivery-2", message: relayMessage });
      await ingress.waitForIdle();

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({ channel: "C_RELAY", text: "relayed" });
      await ingress.stop();
    });
  });

  it("retries a claimed relay event until a dispatcher attaches", async () => {
    await withQueue(async (queue) => {
      const detached = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 60_000,
        adoptionStallTimeoutMs: 5_000,
      });
      // Accept durably, then stop before any dispatcher exists (crash window).
      await detached.acceptRelayEvent({ deliveryId: "delivery-3", message: relayMessage });
      await detached.stop();

      const dispatched: unknown[] = [];
      const recovered = createSlackDurableIngress({
        accountId: "default",
        queue,
        pollIntervalMs: 25,
        adoptionStallTimeoutMs: 5_000,
      });
      recovered.start();
      await recovered.waitForIdle();
      expect(dispatched).toHaveLength(0);

      recovered.attachRelayDispatch(async (message) => {
        dispatched.push(message);
      });
      // First retry obeys the drain's backoff; give it room without flake.
      await vi.waitFor(
        async () => {
          await recovered.waitForIdle();
          expect(dispatched).toHaveLength(1);
        },
        { timeout: 15_000, interval: 250 },
      );
      await recovered.stop();
    });
  });
});
