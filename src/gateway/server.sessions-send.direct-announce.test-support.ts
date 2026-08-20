import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, vi, type Mock } from "vitest";
import { runSessionsSendA2AFlow } from "../agents/tools/sessions-send-tool.a2a.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  agentCommandMock,
  setTestPluginRegistry,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

async function emitDirectAnnounceReply(params: {
  opts: unknown;
  defaultSessionId: string;
}): Promise<void> {
  const command = params.opts as {
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
  };
  if (!command.sessionKey) {
    throw new Error("expected direct announce session key");
  }
  const sessionId = command.sessionId ?? params.defaultSessionId;
  const runId = command.runId ?? sessionId;
  const startedAt = Date.now();
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start", startedAt } });
  await persistSessionTranscriptTurn(
    {
      sessionId,
      sessionKey: command.sessionKey,
      ...(testState.sessionStorePath ? { storePath: testState.sessionStorePath } : {}),
    },
    {
      cwd: "/tmp",
      updateMode: "none",
      messages: [
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "direct announcement delivered" }],
          },
          now: Date.now(),
        },
      ],
    },
  );
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt, endedAt: Date.now() },
  });
}

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
  const agentCommand = agentCommandMock as unknown as Mock<(opts: unknown) => Promise<void>>;
  agentCommand.mockClear();
  const operationalRunInstance = {
    instanceId: `direct-announce-${Date.now()}`,
    runId: `direct-announce-run-${Date.now()}`,
  };
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  try {
    const sessionId = `direct-announce-${expectedAccountId ?? "default"}-${sessionKey.includes(":dm:") ? "dm" : "direct"}`;
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      },
    });
    agentCommand.mockImplementation(async (opts: unknown) =>
      emitDirectAnnounceReply({ opts, defaultSessionId: sessionId }),
    );

    await runSessionsSendA2AFlow({
      targetSessionKey: sessionKey,
      displayKey: sessionKey,
      message: "announce to the direct session",
      announceTimeoutMs: 5_000,
      maxPingPongTurns: 0,
      roundOneReply: "agent completed",
      authority: {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
      },
      handoffContext: {
        inheritedToolPolicy: { version: 1, allow: ["message"], deny: [] },
        requester: { messageProvider: "feishu" },
      },
    });

    expect(agentCommand.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ sessionKey }));

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
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
    agentCommand.mockReset();
    agentCommand.mockResolvedValue(undefined);
    testState.sessionStorePath = undefined;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
