// QQBot durable ingress test helpers own isolated persistent queue state.
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { GatewayEvent, GatewayOp } from "./constants.js";

export type QQBotTestIngressPayload = {
  version: 1;
  receivedAt: number;
  rawEnvelope: string;
};

export function qqC2CEnvelope(params: {
  messageId: string;
  deliveryId?: string;
  userId?: string;
  sequence?: number;
}): string {
  return JSON.stringify({
    op: GatewayOp.DISPATCH,
    id: params.deliveryId ?? `delivery-${params.messageId}`,
    s: params.sequence ?? 1,
    t: GatewayEvent.C2C_MESSAGE_CREATE,
    d: {
      id: params.messageId,
      content: "hello",
      timestamp: "2026-07-18T12:00:00Z",
      author: { user_openid: params.userId ?? "user-1" },
    },
  });
}

export function qqGroupEnvelope(params: {
  messageId: string;
  deliveryId: string;
  eventType: typeof GatewayEvent.GROUP_AT_MESSAGE_CREATE | typeof GatewayEvent.GROUP_MESSAGE_CREATE;
}): string {
  return JSON.stringify({
    op: GatewayOp.DISPATCH,
    id: params.deliveryId,
    s: 1,
    t: params.eventType,
    d: {
      id: params.messageId,
      content: "hello group",
      timestamp: "2026-07-18T12:00:00Z",
      author: { member_openid: "member-1" },
      group_openid: "group-1",
    },
  });
}

export async function withQQBotIngressQueue<T>(
  run: (
    queue: ReturnType<typeof createChannelIngressQueueForTests<QQBotTestIngressPayload>>,
  ) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-qqbot-ingress-"),
  );
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<QQBotTestIngressPayload>({
    channelId: "qqbot",
    accountId: "default",
    stateDir,
  });
  try {
    return await run(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
