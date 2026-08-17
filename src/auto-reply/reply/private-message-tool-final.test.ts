// Tests private message-tool final delivery and visibility suppression.
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { describe, expect, it } from "vitest";
import { classifyPrivateMessageToolFinal } from "./private-message-tool-final.js";

const base = {
  sourceReplyDeliveryMode: "message_tool_only" as const,
  sendPolicyDenied: false,
  successfulSourceReplyDelivery: false,
  isHeartbeat: false,
  isRoomEvent: false,
  finalText:
    "Here is the answer the user asked for. It includes enough detail to look like a visible response rather than an internal no-op note.",
};

function shouldWarnAboutPrivateMessageToolFinal(
  params: Parameters<typeof classifyPrivateMessageToolFinal>[0],
): boolean {
  return classifyPrivateMessageToolFinal(params) === "substantive";
}

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

  // Raw UTF-16 length under-counts CJK about 4x, so these all used to fall below
  // both thresholds and skip stranded recovery entirely (#115555).
  it.each([
    {
      label: "multi-sentence CJK report",
      finalText:
        "近 7 日營收較前期增加 5.09%，已連續兩週回升。最大風險是集中：前五大站台占正營收 86.5%，已超過 85% 觀察門檻。" +
        "建議先維持成長節奏並優先降低集中風險，不建議只看總額就全面加碼。",
      expected: true,
    },
    {
      label: "single-sentence CJK paragraph (length alone is substantive)",
      finalText: `${"字".repeat(150)}。`,
      expected: true,
    },
    {
      label: "CJK using full-width period U+FF0E",
      finalText: `${"項".repeat(150)}．`,
      expected: true,
    },
    {
      label: "CJK using halfwidth ideographic period U+FF61",
      finalText: `${"項".repeat(150)}｡`,
      expected: true,
    },
    { label: "short CJK acknowledgement", finalText: "沒有需要補充的。已完成。", expected: false },
    { label: "short CJK single clause", finalText: "已完成", expected: false },
  ])("$label -> $expected", ({ finalText, expected }) => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText })).toBe(expected);
  });

  it.each([
    { label: "ideographic full stop", terminator: "。" },
    { label: "full-width exclamation mark", terminator: "！" },
    { label: "full-width question mark", terminator: "？" },
    { label: "full-width full stop", terminator: "．" },
    { label: "half-width ideographic full stop", terminator: "｡" },
  ])("flags a medium-length CJK reply with $label", ({ terminator }) => {
    const finalText =
      `第一項設定已完成，請檢查通知狀態${terminator}` +
      `第二項資料已同步，稍後即可收到訊息${terminator}`;
    const estimatedChars = estimateStringChars(finalText);

    expect(estimatedChars).toBeGreaterThanOrEqual(120);
    expect(estimatedChars).toBeLessThan(280);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText })).toBe(true);
  });

  it.each([
    {
      label: "accented Latin stays on raw length",
      finalText: `Le café est prêt. ${"x".repeat(100)}`,
      expected: false,
    },
    {
      label: "Cyrillic stays on raw length",
      finalText: `Готово. ${"x".repeat(100)}`,
      expected: false,
    },
    {
      label: "emoji stays on raw length",
      finalText: `Done ✅ Shipped 🚀 ${"x".repeat(100)}`,
      expected: false,
    },
  ])("non-CJK non-ASCII is unaffected: $label", ({ finalText, expected }) => {
    expect(finalText.length).toBeLessThan(280);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText })).toBe(expected);
  });

  it("does not flag empty or whitespace-only final text", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "" })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "   \n " })).toBe(false);
  });

  it("does not flag when delivery was intentionally denied by send policy", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, sendPolicyDenied: true })).toBe(false);
  });

  it("does not flag heartbeat or room-event non-delivery", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, isHeartbeat: true })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, isRoomEvent: true })).toBe(false);
  });
});
