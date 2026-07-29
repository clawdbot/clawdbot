// Tests private message-tool final delivery and visibility suppression.
import { describe, expect, it } from "vitest";
import { shouldWarnAboutPrivateMessageToolFinal } from "./private-message-tool-final.js";

const base = {
  sourceReplyDeliveryMode: "message_tool_only" as const,
  sendPolicyDenied: false,
  successfulSourceReplyDelivery: false,
  finalText:
    "Here is the answer the user asked for. It includes enough detail to look like a visible response rather than an internal no-op note.",
};

describe("shouldWarnAboutPrivateMessageToolFinal", () => {
  it("flags a multi-sentence private final that was never delivered via the message tool (#85714)", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal(base)).toBe(true);
  });

  it("flags a long private final even without multiple sentence terminators", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "x".repeat(280),
      }),
    ).toBe(true);
  });

  it("does not flag automatic delivery mode (final text is delivered normally)", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, sourceReplyDeliveryMode: "automatic" }),
    ).toBe(false);
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, sourceReplyDeliveryMode: undefined }),
    ).toBe(false);
  });

  it("does not flag when the message tool already delivered this turn", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, successfulSourceReplyDelivery: true }),
    ).toBe(false);
  });

  it("does not flag silent sentinel variants (intentional silence)", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "NO_REPLY" })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "  no_reply  " })).toBe(
      false,
    );
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "NO_REPLY\n\nNO_REPLY" }),
    ).toBe(false);
  });

  it("does not flag a short private final", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "Nothing to add here.",
      }),
    ).toBe(false);
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "I do not need to send anything. Nothing else to add.",
      }),
    ).toBe(false);
  });

  it("flags a multi-sentence CJK private final (full-width terminators, no trailing space)", () => {
    // Real-world shape: a substantive Chinese answer the model wrote as a private
    // final instead of calling the message tool. Full-width terminators are not
    // followed by whitespace, so the ASCII-only rule counted zero terminators and
    // this reply stayed under the 280-char long-final threshold.
    const cjkFinal =
      "近 7 日營收較前期增加 5.09%，已連續兩週回升。最大風險是集中：前五大站台占正營收 86.5%，已超過 85% 觀察門檻。" +
      "近 30 日最大單一產品占 44.2%，亦超過 40% 門檻。建議先維持成長節奏並優先降低集中風險，不建議只看總額就全面加碼。" +
      "成長主因仍待業務確認，我尚未取得該線的回覆。";
    expect(cjkFinal.length).toBeGreaterThanOrEqual(120);
    expect(cjkFinal.length).toBeLessThan(280);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: cjkFinal })).toBe(true);
  });

  it("does not flag a short CJK private final", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "沒有需要補充的。已完成。" }),
    ).toBe(false);
  });

  it("does not flag a CJK final that is long enough but has a single sentence", () => {
    const single = `${"字".repeat(150)}。`;
    expect(single.length).toBeGreaterThanOrEqual(120);
    expect(single.length).toBeLessThan(280);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: single })).toBe(false);
  });

  it("does not flag empty or whitespace-only final text", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "" })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "   \n " })).toBe(false);
  });

  it("does not flag when delivery was intentionally denied by send policy", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, sendPolicyDenied: true })).toBe(false);
  });
});
