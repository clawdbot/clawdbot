// @vitest-environment node
import type { SystemAgentChatQuestion } from "@openclaw/gateway-protocol";
import { describe, expect, it } from "vitest";
import { parseCustodianQuestion } from "./structured-question.ts";

describe("custodian typed question", () => {
  it("accepts a valid typed question and keeps replies and recommendations", () => {
    const question: SystemAgentChatQuestion = {
      id: "onboarding-next-step",
      header: "Next step",
      question: "What would you like to do first?",
      options: [
        { label: "Talk to my agent", reply: "talk to agent", recommended: true },
        { label: "Connect WhatsApp", reply: "connect whatsapp", description: "Chat there." },
      ],
      isOther: true,
      skipAction: "exit",
    };
    expect(parseCustodianQuestion(question)).toEqual({
      id: "onboarding-next-step",
      header: "Next step",
      question: "What would you like to do first?",
      options: [
        { label: "Talk to my agent", reply: "talk to agent", recommended: true },
        { label: "Connect WhatsApp", reply: "connect whatsapp", description: "Chat there." },
      ],
      isOther: true,
      skipAction: "exit",
    });
  });

  it("accepts wizard-style questions without any recommendation", () => {
    const parsed = parseCustodianQuestion({
      id: "channel",
      header: "Channel",
      question: "Which channel?",
      options: [{ label: "WhatsApp" }, { label: "Telegram" }],
    });
    expect(parsed?.options).toHaveLength(2);
    expect(parsed?.isOther).toBe(false);
  });

  it("rejects malformed questions instead of rendering broken cards", () => {
    expect(parseCustodianQuestion(undefined)).toBeNull();
    expect(
      parseCustodianQuestion({
        id: "one-option",
        header: "H",
        question: "Q",
        options: [{ label: "Only" }],
      }),
    ).toBeNull();
    expect(
      parseCustodianQuestion({
        id: "dupes",
        header: "H",
        question: "Q",
        options: [{ label: "Same" }, { label: "same" }],
      }),
    ).toBeNull();
    expect(
      parseCustodianQuestion({
        id: "two-recommended",
        header: "H",
        question: "Q",
        options: [
          { label: "A", recommended: true },
          { label: "B", recommended: true },
        ],
      }),
    ).toBeNull();
    expect(
      parseCustodianQuestion({
        id: "blank-label",
        header: "H",
        question: "Q",
        options: [{ label: "A" }, { label: "   " }],
      }),
    ).toBeNull();
  });
});
