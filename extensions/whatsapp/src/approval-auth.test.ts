import { describe, expect, it } from "vitest";
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";

describe("whatsappApprovalAuth", () => {
  it("authorizes direct WhatsApp recipients and ignores group entries", () => {
    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: ["+1 (555) 123-0000"] } } },
        senderId: "15551230000@s.whatsapp.net",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      getWhatsAppApprovalApprovers({
        cfg: { channels: { whatsapp: { allowFrom: ["12345-67890@g.us"] } } },
      }),
    ).toEqual([]);

    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: ["+15551230000"] } } },
        senderId: "+15551239999",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on WhatsApp.",
    });
  });

  it("does not treat defaultTo as an explicit approval approver", () => {
    expect(
      getWhatsAppApprovalApprovers({
        cfg: { channels: { whatsapp: { allowFrom: [], defaultTo: "+15551230000" } } },
      }),
    ).toEqual([]);

    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: [], defaultTo: "+15551230000" } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("supports explicit wildcard approval approvers", () => {
    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: ["*"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });
});
