import { describe, expect, it } from "vitest";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";

describe("imessageApprovalAuth", () => {
  it("authorizes individual handles and ignores group/chat target entries", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["+1 (555) 123-0000"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      getIMessageApprovalApprovers({
        cfg: {
          channels: {
            imessage: {
              allowFrom: ["chat_guid:iMessage;+;chat123", "chat_id:42"],
            },
          },
        },
      }),
    ).toEqual([]);

    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
        senderId: "+15551239999",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on iMessage.",
    });
  });

  it("authorizes lowercase-normalized email senders against canonical allowFrom", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["Owner@Example.com"] } } },
        senderId: "owner@example.com",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });

  it("falls back to implicit same-chat authorization when no allowFrom is configured", () => {
    expect(
      getIMessageApprovalApprovers({
        cfg: { channels: { imessage: { allowFrom: [] } } },
      }),
    ).toEqual([]);

    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: [] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("supports explicit wildcard approval approvers", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["*"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });

  it("strips imessage:/sms:/auto: service prefixes when normalizing approver entries", () => {
    // The resolved approver list itself must contain the bare normalized
    // handle — a previous bug rejected service-prefixed entries entirely,
    // which silently fell back to the empty-approvers implicit-same-chat
    // authorization and masked the regression. Assert the explicit list here
    // so reaction resolution (which requires a non-empty approver list) works
    // for service-prefixed allowFrom values too.
    expect(
      getIMessageApprovalApprovers({
        cfg: { channels: { imessage: { allowFrom: ["imessage:+15551230000"] } } },
      }),
    ).toEqual(["+15551230000"]);
    expect(
      getIMessageApprovalApprovers({
        cfg: { channels: { imessage: { allowFrom: ["sms:+15551230001"] } } },
      }),
    ).toEqual(["+15551230001"]);
    expect(
      getIMessageApprovalApprovers({
        cfg: { channels: { imessage: { allowFrom: ["auto:Owner@Example.com"] } } },
      }),
    ).toEqual(["owner@example.com"]);

    // A sender that matches the normalized handle is explicitly authorized
    // (not via the implicit same-chat fallback).
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["imessage:+15551230000"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    // And a NON-matching sender is rejected — proving the entry was added
    // to the approver list rather than collapsing to empty.
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["imessage:+15551230000"] } } },
        senderId: "+15559999999",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on iMessage.",
    });
  });

  it("rejects chat_id / chat_guid / chat_identifier as approver entries even with service prefixes", () => {
    expect(
      getIMessageApprovalApprovers({
        cfg: {
          channels: {
            imessage: {
              allowFrom: [
                "chat_id:42",
                "chat_guid:iMessage;+;chat42",
                "chat_identifier:chat42@example.com",
                "imessage:chat_id:43",
              ],
            },
          },
        },
      }),
    ).toEqual([]);
  });
});
