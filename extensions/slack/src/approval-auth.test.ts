// Slack tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { getSlackApprovalApprovers, isSlackApprovalAuthorizedSender } from "./approval-auth.js";

describe("isSlackApprovalAuthorizedSender", () => {
  it("authorizes general Slack approvers from allowFrom and defaultTo", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["slack:U123OWNER", "<@U234DM>"],
          defaultTo: "user:U345DEFAULT",
          execApprovals: { enabled: true, approvers: ["user:U999EXEC"] },
        },
      },
    };

    for (const senderId of ["U123OWNER", "u123owner", "U345DEFAULT", "u345default"]) {
      expect(isSlackApprovalAuthorizedSender({ cfg, senderId })).toBe(true);
    }
    for (const senderId of ["U999EXEC", "U999ATTACKER"]) {
      expect(isSlackApprovalAuthorizedSender({ cfg, senderId })).toBe(false);
    }
  });

  it("canonicalizes configured plugin approver ids before matching uppercase senders", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["slack:u123owner"],
          defaultTo: "user:u345default",
        },
      },
    };

    for (const senderId of ["U123OWNER", "U345DEFAULT"]) {
      expect(isSlackApprovalAuthorizedSender({ cfg, senderId })).toBe(true);
    }
  });

  it("keeps workspace-qualified plugin approvers scoped to their workspace", () => {
    const qualifiedApprover = "team:T11111111:user:U123OWNER";
    const qualifiedCfg = {
      channels: {
        slack: {
          allowFrom: [qualifiedApprover],
        },
      },
    };

    expect(getSlackApprovalApprovers({ cfg: qualifiedCfg })).toEqual([qualifiedApprover]);
    expect(
      isSlackApprovalAuthorizedSender({
        cfg: qualifiedCfg,
        senderId: qualifiedApprover,
      }),
    ).toBe(true);
    for (const senderId of ["team:T22222222:user:U123OWNER", "U123OWNER"]) {
      expect(isSlackApprovalAuthorizedSender({ cfg: qualifiedCfg, senderId })).toBe(false);
    }

    const unqualifiedCfg = {
      channels: {
        slack: {
          allowFrom: ["U123OWNER"],
        },
      },
    };
    for (const senderId of [
      "U123OWNER",
      "team:T11111111:user:U123OWNER",
      "team:T22222222:user:U123OWNER",
    ]) {
      expect(isSlackApprovalAuthorizedSender({ cfg: unqualifiedCfg, senderId })).toBe(true);
    }
  });

  it("allows same-chat plugin approval when no concrete Slack approvers are configured", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["*"],
        },
      },
    };

    expect(
      isSlackApprovalAuthorizedSender({
        cfg,
        senderId: "U123OWNER",
      }),
    ).toBe(true);
    expect(isSlackApprovalAuthorizedSender({ cfg })).toBe(false);
  });
});
