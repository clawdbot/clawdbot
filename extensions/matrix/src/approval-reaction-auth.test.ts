// Matrix tests cover approval reaction auth behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { isMatrixApprovalReactionAuthorizedSender } from "./approval-reaction-auth.js";

describe("isMatrixApprovalReactionAuthorizedSender", () => {
  it.each(["plugin", "exec"] as const)(
    "requires an exact Matrix identity for %s approval reactions",
    (approvalKind) => {
      const cfg = {
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok",
            dm: { allowFrom: ["@\u212A:example.org"] },
            execApprovals: { enabled: true, approvers: ["@\u212A:example.org"] },
          },
        },
      } as OpenClawConfig;

      expect(
        isMatrixApprovalReactionAuthorizedSender({
          cfg,
          senderId: "@\u212A:example.org",
          approvalKind,
        }),
      ).toBe(true);
      expect(
        isMatrixApprovalReactionAuthorizedSender({
          cfg,
          senderId: "@k:example.org",
          approvalKind,
        }),
      ).toBe(false);
    },
  );
});
