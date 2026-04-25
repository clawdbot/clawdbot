import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { ChannelOutboundAdapter, ChannelOutboundContext } from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createCliDeps,
  expectDirectTelegramDelivery,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

type ChannelCase = {
  name: string;
  channel: "slack" | "discord" | "whatsapp" | "imessage";
  to: string;
  sendKey: keyof Pick<
    CliDeps,
    "sendMessageSlack" | "sendMessageDiscord" | "sendMessageWhatsApp" | "sendMessageIMessage"
  >;
  expectedTo: string;
};

const CASES: ChannelCase[] = [
  {
    name: "Slack",
    channel: "slack",
    to: "channel:C12345",
    sendKey: "sendMessageSlack",
    expectedTo: "channel:C12345",
  },
  {
    name: "Discord",
    channel: "discord",
    to: "channel:789",
    sendKey: "sendMessageDiscord",
    expectedTo: "channel:789",
  },
  {
    name: "WhatsApp",
    channel: "whatsapp",
    to: "+15551234567",
    sendKey: "sendMessageWhatsApp",
    expectedTo: "+15551234567",
  },
  {
    name: "iMessage",
    channel: "imessage",
    to: "friend@example.com",
    sendKey: "sendMessageIMessage",
    expectedTo: "friend@example.com",
  },
];

async function runExplicitAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  channel: ChannelCase["channel"];
  to: string;
}) {
  return await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath),
    deps: params.deps,
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      delivery: {
        mode: "announce",
        channel: params.channel,
        to: params.to,
      },
    },
    message: "do it",
    sessionKey: "cron:job-1",
    lane: "cron",
  });
}

type CoreChannelSendFn = CliDeps[ChannelCase["sendKey"]];

async function expectCoreChannelAnnounceDelivery({
  assertSend,
  meta,
  payloads,
  testCase,
}: {
  assertSend: (sendFn: CoreChannelSendFn) => void;
  meta?: Parameters<typeof mockAgentPayloads>[1];
  payloads: Parameters<typeof mockAgentPayloads>[0];
  testCase: ChannelCase;
}): Promise<void> {
  await withTempCronHome(async (home) => {
    const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
    const deps = createCliDeps();
    if (meta) {
      mockAgentPayloads(payloads, meta);
    } else {
      mockAgentPayloads(payloads);
    }

    const res = await runExplicitAnnounceTurn({
      home,
      storePath,
      deps,
      channel: testCase.channel,
      to: testCase.to,
    });

    expect(res.status).toBe("ok");
    expect(res.delivered).toBe(true);
    expect(res.deliveryAttempted).toBe(true);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    assertSend(deps[testCase.sendKey]);
  });
}

type CoreChannel = ChannelCase["channel"];
type TestSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId?: string } & Record<string, unknown>>;

function withRequiredMessageId(channel: CoreChannel, result: Awaited<ReturnType<TestSendFn>>) {
  return {
    channel,
    ...result,
    messageId:
      typeof result.messageId === "string" && result.messageId.trim()
        ? result.messageId
        : `${channel}-test-message`,
  };
}

function resolveCoreChannelSender(
  channel: CoreChannel,
  deps: ChannelOutboundContext["deps"],
): TestSendFn {
  const sender = resolveOutboundSendDep<TestSendFn>(deps, channel);
  if (!sender) {
    throw new Error(`missing ${channel} sender`);
  }
  return sender;
}

function createCliDelegatingOutbound(params: {
  channel: CoreChannel;
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
  preferFinalAssistantVisibleText?: boolean;
  resolveTarget?: ChannelOutboundAdapter["resolveTarget"];
}): ChannelOutboundAdapter {
  return {
    deliveryMode: params.deliveryMode ?? "direct",
    ...(params.preferFinalAssistantVisibleText !== undefined
      ? { preferFinalAssistantVisibleText: params.preferFinalAssistantVisibleText }
      : {}),
    ...(params.resolveTarget ? { resolveTarget: params.resolveTarget } : {}),
    sendText: async ({ cfg, to, text, accountId, deps }) =>
      withRequiredMessageId(
        params.channel,
        await resolveCoreChannelSender(params.channel, deps)(to, text, {
          cfg,
          accountId: accountId ?? undefined,
        }),
      ),
  };
}

const identityResolveTarget: ChannelOutboundAdapter["resolveTarget"] = ({ to }) => {
  const trimmed = to?.trim();
  return trimmed
    ? { ok: true, to: trimmed }
    : { ok: false, error: new Error("target is required") };
};

function makeRunMeta(finalAssistantVisibleText: string) {
  return {
    durationMs: 5,
    agentMeta: { sessionId: "s", provider: "p", model: "m" },
    finalAssistantVisibleText,
  };
}

async function expectTelegramAnnounceDelivery({
  expected,
  meta,
  payloads,
  to,
}: {
  expected: Parameters<typeof expectDirectTelegramDelivery>[1];
  meta?: Parameters<typeof mockAgentPayloads>[1];
  payloads: Parameters<typeof mockAgentPayloads>[0];
  to: string;
}): Promise<void> {
  await withTempCronHome(async (home) => {
    const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
    const deps = createCliDeps();
    if (meta) {
      mockAgentPayloads(payloads, meta);
    } else {
      mockAgentPayloads(payloads);
    }

    const res = await runTelegramAnnounceTurn({
      home,
      storePath,
      deps,
      delivery: { mode: "announce", channel: "telegram", to },
    });

    expect(res.status).toBe("ok");
    expect(res.delivered).toBe(true);
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expectDirectTelegramDelivery(deps, expected);
  });
}

describe("runCronIsolatedAgentTurn core-channel direct delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({
            id: "slack",
            outbound: createCliDelegatingOutbound({ channel: "slack" }),
          }),
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({
            id: "discord",
            outbound: createCliDelegatingOutbound({
              channel: "discord",
              preferFinalAssistantVisibleText: true,
            }),
          }),
          source: "test",
        },
        {
          pluginId: "whatsapp",
          plugin: createOutboundTestPlugin({
            id: "whatsapp",
            outbound: createCliDelegatingOutbound({
              channel: "whatsapp",
              deliveryMode: "gateway",
              resolveTarget: identityResolveTarget,
            }),
          }),
          source: "test",
        },
        {
          pluginId: "imessage",
          plugin: createOutboundTestPlugin({
            id: "imessage",
            outbound: createCliDelegatingOutbound({ channel: "imessage" }),
          }),
          source: "test",
        },
      ]),
    );
  });

  for (const testCase of CASES) {
    it(`routes ${testCase.name} text-only announce delivery through the outbound adapter`, async () => {
      await expectCoreChannelAnnounceDelivery({
        testCase,
        payloads: [{ text: "hello from cron" }],
        assertSend: (sendFn) => {
          expect(sendFn).toHaveBeenCalledTimes(1);
          expect(sendFn).toHaveBeenCalledWith(
            testCase.expectedTo,
            "hello from cron",
            expect.any(Object),
          );
        },
      });
    });

    if (testCase.channel === "discord") {
      it("collapses Discord text-only announce delivery to the final assistant text", async () => {
        await expectCoreChannelAnnounceDelivery({
          testCase,
          payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
          meta: {
            meta: {
              durationMs: 5,
              agentMeta: { sessionId: "s", provider: "p", model: "m" },
              finalAssistantVisibleText: "Final weather summary",
            },
          },
          assertSend: (sendFn) => {
            expect(sendFn).toHaveBeenCalledTimes(1);
            expect(sendFn).toHaveBeenCalledWith(
              testCase.expectedTo,
              "Final weather summary",
              expect.any(Object),
            );
          },
        });
      });
      continue;
    }

    it(`preserves multi-payload text-only announce delivery for ${testCase.name} even when final assistant text exists`, async () => {
      await expectCoreChannelAnnounceDelivery({
        testCase,
        payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
        meta: {
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
            finalAssistantVisibleText: "Final weather summary",
          },
        },
        assertSend: (sendFn) => {
          expect(sendFn).toHaveBeenCalledTimes(2);
          expect(sendFn).toHaveBeenNthCalledWith(
            1,
            testCase.expectedTo,
            "Working on it...",
            expect.any(Object),
          );
          expect(sendFn).toHaveBeenNthCalledWith(
            2,
            testCase.expectedTo,
            "Final weather summary",
            expect.any(Object),
          );
        },
      });
    });
  }
});

describe("runCronIsolatedAgentTurn telegram forum-topic direct delivery", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("routes forum-topic telegram targets through the correct delivery path", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123:topic:42",
      payloads: [{ text: "forum message" }],
      expected: {
        chatId: "123",
        text: "forum message",
        messageThreadId: 42,
      },
    });
  });

  it("delivers only the final assistant-visible text to forum-topic telegram targets", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123:topic:42",
      payloads: [
        { text: "section 1" },
        { text: "temporary error", isError: true },
        { text: "section 2" },
      ],
      meta: { meta: makeRunMeta("section 1\nsection 2") },
      expected: {
        chatId: "123",
        text: "section 1\nsection 2",
        messageThreadId: 42,
      },
    });
  });

  it("routes plain telegram targets through the correct delivery path", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123",
      payloads: [{ text: "plain message" }],
      expected: {
        chatId: "123",
        text: "plain message",
      },
    });
  });

  it("delivers only the final assistant-visible text to plain telegram targets", async () => {
    await expectTelegramAnnounceDelivery({
      to: "123",
      payloads: [{ text: "Working on it..." }, { text: "Final weather summary" }],
      meta: { meta: makeRunMeta("Final weather summary") },
      expected: {
        chatId: "123",
        text: "Final weather summary",
      },
    });
  });
});
