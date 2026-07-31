// Session reset tests cover conversation-aware reset classification.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { resolveSessionResetType } from "./reset.js";

describe("session reset thread detection", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("does not treat Feishu conversation ids with embedded :topic: as thread suffixes", () => {
    expect(
      resolveSessionResetType({
        sessionKey:
          "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      }),
    ).toBe("group");
  });

  it("still treats Telegram :topic: suffixes as thread sessions", () => {
    expect(
      resolveSessionResetType({ sessionKey: "agent:main:telegram:group:-100123:topic:77" }),
    ).toBe("thread");
  });
});
