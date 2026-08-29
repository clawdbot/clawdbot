import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { App, Receiver, ReceiverEvent } from "@slack/bolt";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createSlackDurableIngress } from "./ingress.js";

type SlackIngressQueue = NonNullable<Parameters<typeof createSlackDurableIngress>[0]["queue"]>;
export type SlackIngressPayload = Parameters<SlackIngressQueue["enqueue"]>[1];

export function createReceiverHarness() {
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

export function attachIngress(
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

export async function withQueue(
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
