import { afterEach, describe, expect, it } from "vitest";
import { resolveMessagingToolPayloadDedupe } from "../auto-reply/reply/reply-payloads-dedupe.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
} from "./embedded-agent-subscribe.tools.js";

const PARTIAL_RESULT_PROVIDER = "partialthreadprovider";

function createPartialResultPlugin(): unknown {
  return {
    ...createChannelTestPluginBase({ id: PARTIAL_RESULT_PROVIDER }),
    actions: {
      extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
        args.action === "send" && typeof args.to === "string"
          ? { to: args.to, threadImplicit: true }
          : null,
      extractToolSendResult: ({ result }: { result: unknown }) => {
        const toolSend = (result as { details?: { toolSend?: Record<string, unknown> } })?.details
          ?.toolSend;
        const to = typeof toolSend?.to === "string" ? toolSend.to : undefined;
        if (!to) {
          return null;
        }
        const threadId = typeof toolSend?.threadId === "string" ? toolSend.threadId : undefined;
        return {
          to,
          ...(threadId ? { threadId } : {}),
          ...(toolSend?.threadImplicit === true ? { threadImplicit: true } : {}),
          ...(toolSend?.threadSuppressed === true ? { threadSuppressed: true } : {}),
        };
      },
    },
    threading: {
      resolveAutoThreadId: ({ toolContext }: { toolContext?: { currentThreadTs?: string } }) =>
        toolContext?.currentThreadTs,
    },
  };
}

function registerPartialResultProvider(): void {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: PARTIAL_RESULT_PROVIDER, source: "test", plugin: createPartialResultPlugin() },
    ]),
  );
}

describe("extractMessagingToolSendResult thread evidence", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("preserves implicit thread evidence when the provider result omits it", () => {
    registerPartialResultProvider();

    const pending = extractMessagingToolSend(
      "message",
      { action: "send", provider: PARTIAL_RESULT_PROVIDER, to: "channel:abc", message: "answer" },
      {
        currentChannelId: "channel:abc",
        currentMessagingTarget: "channel:abc",
        currentThreadId: "root-1",
        replyToMode: "all",
      },
    );
    expect(pending?.threadImplicit).toBe(true);
    expect(pending?.threadId).toBe("root-1");

    const confirmed = extractMessagingToolSendResult(pending!, {
      details: { toolSend: { to: "channel:abc" } },
    });
    expect(confirmed.threadImplicit).toBe(true);
    expect(confirmed.threadId).toBe("root-1");

    const decision = resolveMessagingToolPayloadDedupe({
      messageProvider: PARTIAL_RESULT_PROVIDER,
      originatingTo: "channel:abc",
      originatingThreadId: "root-1",
      messagingToolSentTargets: [confirmed],
    });
    expect(decision.matchingRoute).toBe(true);
  });

  it("lets an explicit provider-reported thread override pending implicit evidence", () => {
    registerPartialResultProvider();

    const confirmed = extractMessagingToolSendResult(
      {
        tool: "message",
        provider: PARTIAL_RESULT_PROVIDER,
        to: "channel:abc",
        threadImplicit: true,
      },
      { details: { toolSend: { to: "channel:abc", threadId: "root-9" } } },
    );
    expect(confirmed.threadId).toBe("root-9");
    expect(confirmed.threadImplicit).toBeUndefined();
  });

  it.each([
    {
      name: "provider suppression replaces pending implicit evidence",
      pending: {
        threadId: "root-1",
        threadImplicit: true,
      },
      result: {
        threadSuppressed: true,
      },
      expected: {
        threadId: undefined,
        threadImplicit: undefined,
        threadSuppressed: true,
      },
    },
    {
      name: "provider implicit evidence replaces pending suppression",
      pending: {
        threadSuppressed: true,
      },
      result: {
        threadImplicit: true,
      },
      expected: {
        threadId: undefined,
        threadImplicit: true,
        threadSuppressed: undefined,
      },
    },
    {
      name: "a partial result preserves pending suppression",
      pending: {
        threadSuppressed: true,
      },
      result: {},
      expected: {
        threadId: undefined,
        threadImplicit: undefined,
        threadSuppressed: true,
      },
    },
  ])("$name", ({ pending, result, expected }) => {
    registerPartialResultProvider();

    const confirmed = extractMessagingToolSendResult(
      {
        tool: "message",
        provider: PARTIAL_RESULT_PROVIDER,
        to: "channel:abc",
        ...pending,
      },
      { details: { toolSend: { to: "channel:abc", ...result } } },
    );

    expect({
      threadId: confirmed.threadId,
      threadImplicit: confirmed.threadImplicit,
      threadSuppressed: confirmed.threadSuppressed,
    }).toEqual(expected);
  });
});
