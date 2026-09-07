import { describe, expect, it } from "vitest";
import { resolveFeishuOutboundSessionRoute } from "./session-route.js";

describe("resolveFeishuOutboundSessionRoute", () => {
  it("uses Feishu receive-id semantics for canonical recipient sessions", () => {
    const group = resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "oc_group",
    });
    const direct = resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "ou_user",
    });
    const legacyUserId = resolveFeishuOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "user:legacy_user_id",
    });

    expect(group).toMatchObject({
      recipientSessionExact: true,
      peer: { kind: "group", id: "oc_group" },
      to: "oc_group",
    });
    expect(direct).toMatchObject({
      recipientSessionExact: true,
      peer: { kind: "direct", id: "ou_user" },
      to: "ou_user",
    });
    expect(legacyUserId?.recipientSessionExact).toBe(false);
  });

  it("does not claim an exact group route when inbound sessions include sender or topic", () => {
    const accountScoped = resolveFeishuOutboundSessionRoute({
      cfg: {
        channels: {
          feishu: {
            groupSessionScope: "group_sender",
          },
        },
      },
      agentId: "main",
      target: "oc_group",
    });
    const groupScoped = resolveFeishuOutboundSessionRoute({
      cfg: {
        channels: {
          feishu: {
            groupSessionScope: "group",
            groups: {
              oc_group: { groupSessionScope: "group_topic" },
            },
          },
        },
      },
      agentId: "main",
      target: "oc_group",
    });

    expect(accountScoped?.recipientSessionExact).toBe(false);
    expect(groupScoped?.recipientSessionExact).toBe(false);
  });
});
