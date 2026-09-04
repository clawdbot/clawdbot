// iMessage reply_to_guid echo detection regression tests.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "../test-support/runtime.js";
import { createSentMessageCache } from "./echo-cache.js";

type InboundProcessingModule = typeof import("./inbound-processing.js");
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];
const cfg = {} as OpenClawConfig;
type InboundDecisionParams = Parameters<
  InboundProcessingModule["resolveIMessageInboundDecision"]
>[0];

beforeAll(async () => {
  await loadFreshIMessageReplyCacheForTest();
  ({ resolveIMessageInboundDecision } = await import("./inbound-processing.js"));
});

function createInboundDecisionParams(
  overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
    message?: Partial<InboundDecisionParams["message"]>;
  } = {},
): InboundDecisionParams {
  const { message: messageOverrides, ...restOverrides } = overrides;
  const message = {
    id: 42,
    sender: "+15555550123",
    text: "ok",
    is_from_me: false,
    is_group: false,
    ...messageOverrides,
  };
  const messageText = restOverrides.messageText ?? message.text ?? "";
  const bodyText = restOverrides.bodyText ?? messageText;
  return {
    cfg,
    accountId: "default",
    opts: undefined,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    isKnownFromMeMessageId: () => false,
    logVerbose: undefined,
    ...restOverrides,
    message,
    messageText,
    bodyText,
  };
}

function resolveDecision(overrides: Parameters<typeof createInboundDecisionParams>[0] = {}) {
  return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
}

describe("resolveIMessageInboundDecision reply_to_guid echo detection", () => {
  it("drops paired mirror with reply_to_guid matching outbound echo cache guid", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    const decision = await resolveDecision({
      message: {
        id: 100,
        guid: "GUID-B",
        reply_to_guid: "GUID-A",
        text: "Hello",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
  });

  it("does not drop inline reply with reply_to_guid but different text", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    const decision = await resolveDecision({
      message: {
        id: 101,
        guid: "GUID-C",
        reply_to_guid: "GUID-A",
        text: "Goodbye",
      },
      messageText: "Goodbye",
      bodyText: "Goodbye",
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop message with identical text but unrelated reply_to_guid", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });

    const decision = await resolveDecision({
      message: {
        id: 102,
        guid: "GUID-D",
        reply_to_guid: "GUID-UNRELATED",
        text: "Hello",
      },
      messageText: "Hello",
      bodyText: "Hello",
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop inline reply whose text matches a different outbound GUID", async () => {
    const echoCache = createSentMessageCache();
    const scope = "default:imessage:+15555550123";
    echoCache.remember(scope, { text: "Hello", messageId: "GUID-A" });
    echoCache.remember(scope, { text: "Okay", messageId: "GUID-B" });

    const decision = await resolveDecision({
      message: {
        id: 103,
        guid: "GUID-C",
        reply_to_guid: "GUID-A",
        text: "Okay",
      },
      messageText: "Okay",
      bodyText: "Okay",
      echoCache,
    });

    expect(decision.kind).toBe("dispatch");
  });
});
