import { describe, expect, it } from "vitest";
import {
  sanitizeApprovalScope,
  summarizeApprovalScope,
  type ApprovalScope,
} from "./approval-scope.js";

describe("approval scope", () => {
  it.each([
    [
      {
        kind: "message-send",
        target: "email",
        recipientCount: 3,
        recipients: ["alice@x.com", "bob@y.com"],
        audience: "external",
      },
      "Send to 3 recipients via email (external): alice@x.com, bob@y.com, +1 more",
    ],
    [
      { kind: "message-send", target: "slack #general", recipientCount: 1 },
      "Send to 1 recipient via slack #general",
    ],
    [
      { kind: "payment", amount: "49.99", currency: "EUR", target: "Stripe" },
      "Pay 49.99 EUR to Stripe",
    ],
    [{ kind: "external-post", target: "github", visibility: "public" }, "Post publicly to github"],
    [
      { kind: "external-post", target: "github", visibility: "restricted" },
      "Post restricted to github",
    ],
  ] satisfies [ApprovalScope, string][])("summarizes $kind", (scope, expected) => {
    expect(summarizeApprovalScope(scope)).toBe(expected);
  });

  it("preserves clean scope fields and visibly escapes spoofing characters", () => {
    const cleanScope = {
      kind: "message-send",
      target: "email",
      recipientCount: 1,
      recipients: ["alice@example.com"],
      audience: "internal",
    } satisfies ApprovalScope;

    expect(sanitizeApprovalScope(cleanScope)).toEqual(cleanScope);
    expect(sanitizeApprovalScope({ ...cleanScope, target: "mail\u202Ebox" })).toMatchObject({
      target: "mail\\u{202E}box",
    });
    expect(sanitizeApprovalScope({ ...cleanScope, target: "🦞".repeat(128) })).toMatchObject({
      target: "🦞".repeat(128),
    });
  });

  it("clamps recipient previews to the declared recipient count", () => {
    const clamped = sanitizeApprovalScope({
      kind: "message-send",
      target: "email",
      recipientCount: 1,
      recipients: ["alice@example.com", "bob@example.com"],
    });
    expect(clamped).toMatchObject({ recipientCount: 1, recipients: ["alice@example.com"] });
    expect(
      summarizeApprovalScope({
        kind: "message-send",
        target: "email",
        recipientCount: 1,
        recipients: (clamped as Extract<ApprovalScope, { kind: "message-send" }>).recipients,
      }),
    ).toBe("Send to 1 recipient via email: alice@example.com");
  });

  it.each([
    { kind: "message-send", target: `${"x".repeat(127)}\u202E`, recipientCount: 1 },
    {
      kind: "message-send",
      target: "email",
      recipientCount: 1,
      recipients: [`${"x".repeat(127)}\u202E`],
    },
    { kind: "payment", amount: `${"x".repeat(39)}\u202E`, currency: "EUR", target: "Stripe" },
    { kind: "payment", amount: "49.99", currency: `${"x".repeat(11)}\u202E`, target: "Stripe" },
    { kind: "external-post", target: `${"x".repeat(127)}\u202E`, visibility: "public" },
    {
      kind: "standing-grant",
      automation: `${"x".repeat(127)}\u202E`,
      command: "id -un",
    },
    {
      kind: "standing-grant",
      automation: "nightly",
      command: `${"x".repeat(255)}\u202E`,
    },
  ] satisfies ApprovalScope[])(
    "drops scopes that exceed a bound after escaping ($kind)",
    (scope) => {
      expect(sanitizeApprovalScope(scope)).toBeNull();
    },
  );

  it("sanitizes and summarizes standing-grant scopes", () => {
    const sanitized = sanitizeApprovalScope({
      kind: "standing-grant",
      automation: "nightly backup",
      command: "id -un",
      expiresInDays: 30,
    });
    expect(sanitized).toEqual({
      kind: "standing-grant",
      automation: "nightly backup",
      command: "id -un",
      expiresInDays: 30,
    });
    expect(summarizeApprovalScope(sanitized!)).toBe(
      'Always allow runs this exact command for "nightly backup" without asking, for 30 days (revocable)',
    );
    expect(
      summarizeApprovalScope({
        kind: "standing-grant",
        automation: "nightly backup",
        command: "id -un",
      }),
    ).toBe(
      'Always allow runs this exact command for "nightly backup" without asking, until revoked (revocable)',
    );
  });
});
