import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
  startQaGatewayChild,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";

type TraceRecord = {
  hook: "agent_turn_prepare" | "llm_input" | "message_received";
  channel?: string;
  chatId?: string;
  content?: string;
  messageId?: string;
  prompt?: string;
  runId?: string;
  senderId?: string;
  sessionKey?: string;
};

async function settleCleanup(...cleanups: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "qa-channel queued message id cleanup failed");
  }
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30_000,
  timeoutContext?: () => unknown | Promise<unknown>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  const context = await timeoutContext?.();
  throw new Error(
    `timed out waiting for QA queued-message-id evidence${
      context === undefined ? "" : `: ${JSON.stringify(context)}`
    }`,
  );
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function readTrace(tracePath: string): Promise<TraceRecord[]> {
  try {
    return (await fs.readFile(tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeTurnTracerPlugin(pluginDir: string, tracePath: string): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: "qa-channel-turn-tracer",
        name: "QA Channel Turn Tracer",
        description: "Records real qa-channel inbound and model-turn hooks for PR proof.",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      `const tracePath = ${JSON.stringify(tracePath)};`,
      "const record = (entry) => appendFileSync(tracePath, `${JSON.stringify(entry)}\\n`);",
      "export default {",
      '  id: "qa-channel-turn-tracer",',
      '  name: "QA Channel Turn Tracer",',
      "  register(api) {",
      '    api.on("message_received", (event, ctx) => {',
      "      record({",
      '        hook: "message_received",',
      "        channel: ctx.channelId,",
      "        chatId: ctx.conversationId,",
      "        content: event.content,",
      "        messageId: event.messageId ?? ctx.messageId,",
      "        runId: event.runId ?? ctx.runId,",
      "        senderId: event.senderId ?? ctx.senderId,",
      "        sessionKey: event.sessionKey ?? ctx.sessionKey,",
      "      });",
      "    });",
      '    api.on("agent_turn_prepare", (event, ctx) => {',
      "      record({",
      '        hook: "agent_turn_prepare",',
      "        channel: ctx.channel,",
      "        chatId: ctx.chatId,",
      "        prompt: event.prompt,",
      "        runId: ctx.runId,",
      "        senderId: ctx.senderId,",
      "        sessionKey: ctx.sessionKey,",
      "      });",
      "      return {};",
      "    });",
      '    api.on("llm_input", (event, ctx) => {',
      "      record({",
      '        hook: "llm_input",',
      "        channel: ctx.channel,",
      "        chatId: ctx.chatId,",
      "        prompt: event.prompt,",
      "        runId: event.runId,",
      "        senderId: ctx.senderId,",
      "        sessionKey: ctx.sessionKey,",
      "      });",
      "    });",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

describe("qa-channel queued message ids", () => {
  test("runs queued channel messages as one executed turn while preserving source ids", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-pr122238-"));
    const pluginDir = path.join(fixtureDir, "plugin");
    const tracePath = path.join(fixtureDir, "turn-trace.ndjson");
    await writeTurnTracerPlugin(pluginDir, tracePath);

    const state = createQaBusState();
    const conversation = { id: "pr-122238-qa-channel", kind: "direct" as const };
    const sender = { senderId: "qa-operator", senderName: "QA Operator" };
    const firstMessageId = "qa-msg-pr122238-active";
    const queuedFirstMessageId = "qa-msg-pr122238-queued-first";
    const queuedLastMessageId = "qa-msg-pr122238-queued-last";
    const queuedFirstNeedle = "PR122238-QUEUED-FIRST-NEEDLE";
    const queuedLastNeedle = "PR122238-QUEUED-LAST-NEEDLE";
    let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;

    try {
      bus = await startQaBusServer({ state });
      mock = await startQaMockOpenAiServer({ finalOnlyMarkerPauseMs: 2_000 });
      gateway = await startQaGatewayChild({
        repoRoot,
        useRepoCli: true,
        providerBaseUrl: `${mock.baseUrl}/v1`,
        providerMode: "mock-openai",
        transport: createQaChannelTransport(state),
        transportBaseUrl: bus.baseUrl,
        enabledPluginIds: ["qa-lab"],
        controlUiEnabled: false,
        mutateConfig: (cfg) => ({
          ...cfg,
          session: { ...cfg.session, dmScope: "per-peer" },
          plugins: {
            ...cfg.plugins,
            allow: [...(cfg.plugins?.allow ?? []), "qa-channel-turn-tracer"],
            load: { paths: [pluginDir] },
            entries: {
              ...cfg.plugins?.entries,
              "qa-channel-turn-tracer": {
                enabled: true,
                hooks: { allowConversationAccess: true },
              },
            },
          },
          messages: {
            ...cfg.messages,
            queue: {
              mode: "collect",
              debounceMsByChannel: { "qa-channel": 0 },
              cap: 10,
              drop: "summarize",
            },
          },
        }),
      });

      const before = await readJson<{ cursor: number }>(`${mock.baseUrl}/debug/request-cursor`);
      const outboundStart = state.getSnapshot().messages.length;
      state.addInboundMessage(
        {
          conversation,
          ...sender,
          text: "Final-only marker streaming QA check. Reply exactly: QA-PR122238-ACTIVE-OK.",
        },
        firstMessageId,
      );
      await waitFor(async () => {
        const requests = await readJson<MockOpenAiRequestSnapshot[]>(
          `${mock!.baseUrl}/debug/requests?after=${before.cursor}`,
        );
        return requests.length >= 1 ? requests : undefined;
      });

      state.addInboundMessage(
        {
          conversation,
          ...sender,
          text: `Queued source one for PR 122238: ${queuedFirstNeedle}.`,
        },
        queuedFirstMessageId,
      );
      state.addInboundMessage(
        {
          conversation,
          ...sender,
          text:
            `Queued source two for PR 122238: ${queuedLastNeedle}. ` +
            "After considering both queued sources, reply exactly: QA-PR122238-COLLECTED-OK.",
        },
        queuedLastMessageId,
      );

      await waitFor(() =>
        state
          .getSnapshot()
          .messages.slice(outboundStart)
          .find(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === conversation.id &&
              message.text.includes("QA-PR122238-COLLECTED-OK"),
          ),
      );

      const requests = await readJson<MockOpenAiRequestSnapshot[]>(
        `${mock.baseUrl}/debug/requests?after=${before.cursor}`,
      );
      const collectedRequests = requests.filter(
        (request) =>
          request.allInputText.includes(queuedFirstNeedle) &&
          request.allInputText.includes(queuedLastNeedle),
      );
      expect(collectedRequests).toHaveLength(1);
      const collectedRequest = collectedRequests[0];
      expect(collectedRequest).toBeDefined();
      expect(collectedRequest?.allInputText).toContain("QA-PR122238-COLLECTED-OK");

      const trace = await readTrace(tracePath);
      const received = trace.filter((entry) => entry.hook === "message_received");
      expect(received.map((entry) => entry.messageId)).toEqual([
        firstMessageId,
        queuedFirstMessageId,
        queuedLastMessageId,
      ]);
      expect(new Set(received.map((entry) => entry.sessionKey)).size).toBe(1);

      const preparedTurns = trace.filter((entry) => entry.hook === "agent_turn_prepare");
      expect(preparedTurns.length).toBeGreaterThanOrEqual(2);
      expect(preparedTurns.at(-1)).toMatchObject({
        channel: "qa-channel",
        chatId: conversation.id,
        senderId: sender.senderId,
        sessionKey: received[0]?.sessionKey,
      });

      console.info(
        `[pr122238-qa-channel-proof] ${JSON.stringify({
          transport: "qa-channel",
          provider: "mock-openai",
          gateway: "ephemeral-child",
          receivedMessageIds: received.map((entry) => entry.messageId),
          collectedProviderRequestCount: collectedRequests.length,
          collectedRequestCursor: collectedRequest?.cursor,
          queuedNeedlesPresent: [
            collectedRequest?.allInputText.includes(queuedFirstNeedle),
            collectedRequest?.allInputText.includes(queuedLastNeedle),
          ],
        })}`,
      );
    } finally {
      await settleCleanup(
        async () => {
          await gateway?.stop();
        },
        async () => {
          await mock?.stop();
        },
        async () => {
          await bus?.stop();
        },
        async () => {
          await fs.rm(fixtureDir, { force: true, recursive: true });
        },
      );
    }
  }, 120_000);
});
