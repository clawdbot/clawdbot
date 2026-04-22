import { describe, expect, it } from "vitest";
import { buildFeishuModelOverrideParentCandidates } from "./conversation-id.js";

describe("buildFeishuModelOverrideParentCandidates", () => {
  it("returns topic and chat fallback ids for sender-scoped topics", () => {
    expect(
      buildFeishuModelOverrideParentCandidates(
        "oc_group_chat:Topic:om_topic_root:Sender:ou_topic_user",
      ),
    ).toEqual(["oc_group_chat:topic:om_topic_root", "oc_group_chat"]);
  });

  it("returns chat fallback ids for sender-scoped chats", () => {
    expect(buildFeishuModelOverrideParentCandidates("oc_group_chat:sender:ou_topic_user")).toEqual([
      "oc_group_chat",
    ]);
  });
});
