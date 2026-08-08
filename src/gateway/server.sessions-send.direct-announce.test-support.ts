import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { testing as agentStepTesting } from "../agents/tools/agent-step.test-support.js";
import { runSessionsSendA2AFlow } from "../agents/tools/sessions-send-tool.a2a.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { setTestPluginRegistry, testState, writeSessionStore } from "./test-helpers.js";

export async function runDirectSessionAnnounceScenario(params: {
  sessionKey: string;
  expectedAccountId: string | undefined;
}): Promise<void> {
  const { sessionKey, expectedAccountId } = params;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-direct-announce-"));
  const sendCalls: Array<{
    to?: string;
    text?: string;
    accountId?: string | null;
  }> = [];
  const feishuPlugin = createOutboundTestPlugin({
    id: "feishu",
    label: "Feishu",
    outbound: {
      deliveryMode: "direct",
      resolveTarget: ({ to }) =>
        to?.startsWith("user:")
          ? { ok: true, to }
          : { ok: false, error: new Error("expected a direct user target") },
      sendText: async (ctx) => {
        sendCalls.push({ to: ctx.to, text: ctx.text, accountId: ctx.accountId });
        return { channel: "feishu", messageId: "direct-announce-proof" };
      },
    },
    messaging: {
      normalizeTarget: (raw) => raw,
      resolveDeliveryTarget: ({ conversationId }) => ({ to: `user:${conversationId}` }),
    },
  });
  setTestPluginRegistry(
    createTestRegistry([
      {
        pluginId: "feishu",
        source: "test",
        plugin: {
          ...feishuPlugin,
          config: {
            ...feishuPlugin.config,
            listAccountIds: () => ["default", "work"],
          },
        },
      },
    ]),
  );

  testState.sessionStorePath = path.join(dir, "sessions.json");
  try {
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId: `direct-announce-${expectedAccountId ?? "default"}-${sessionKey.includes(":dm:") ? "dm" : "direct"}`,
          updatedAt: Date.now(),
        },
      },
    });
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "direct announcement delivered", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
    });

    await runSessionsSendA2AFlow({
      targetSessionKey: sessionKey,
      displayKey: sessionKey,
      message: "announce to the direct session",
      announceTimeoutMs: 5_000,
      maxPingPongTurns: 0,
      roundOneReply: "agent completed",
    });

    await vi.waitFor(
      () => {
        expect(sendCalls).toHaveLength(1);
        expect(sendCalls[0]).toMatchObject({
          to: "user:ou_announce_recipient",
          text: "direct announcement delivered",
          ...(expectedAccountId ? { accountId: expectedAccountId } : {}),
        });
      },
      { timeout: 5_000 },
    );
  } finally {
    agentStepTesting.setDepsForTest();
    testState.sessionStorePath = undefined;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
