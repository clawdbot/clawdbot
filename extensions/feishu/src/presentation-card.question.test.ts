import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import {
  FEISHU_PAYLOAD_QUESTION_ACTION,
  buildFeishuPresentationCard,
} from "./presentation-card.js";

const QUESTION_ID = "ask_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";

function renderButtonsBlock(button: Record<string, unknown>) {
  const presentation = normalizeMessagePresentation({
    blocks: [{ type: "buttons", buttons: [button] }],
  });
  if (!presentation) {
    throw new Error("expected valid presentation");
  }
  return buildFeishuPresentationCard({ presentation }).body.elements as Array<
    Record<string, unknown>
  >;
}

describe("buildFeishuPresentationCard question option buttons", () => {
  it("renders ask_user option buttons as tappable card callbacks", () => {
    const [element] = renderButtonsBlock({
      label: "Option A",
      action: {
        type: "question",
        questionId: QUESTION_ID,
        optionValue: "Option A",
      },
    });

    expect(element).toMatchObject({
      tag: "button",
      text: { tag: "plain_text", content: "Option A" },
      behaviors: [
        {
          type: "callback",
          value: {
            oc: "ocf1",
            k: "button",
            a: FEISHU_PAYLOAD_QUESTION_ACTION,
            q: QUESTION_ID,
            m: { o: "Option A" },
          },
        },
      ],
    });
  });

  it("keeps command buttons on the existing quick-command envelope", () => {
    const [element] = renderButtonsBlock({
      label: "Run /deploy",
      action: { type: "command", command: "/deploy" },
    });

    expect(element).toMatchObject({
      tag: "button",
      behaviors: [
        {
          type: "callback",
          value: {
            oc: "ocf1",
            k: "quick",
            a: "feishu.payload.button",
            q: "/deploy",
          },
        },
      ],
    });
  });

  it("keeps legacy value buttons on the quick-command envelope", () => {
    const [element] = renderButtonsBlock({
      label: "Custom",
      value: "custom-value",
    });

    expect(element).toMatchObject({
      tag: "button",
      behaviors: [
        {
          type: "callback",
          value: {
            oc: "ocf1",
            k: "quick",
            a: "feishu.payload.button",
            q: "custom-value",
          },
        },
      ],
    });
  });

  it("falls back to text for custom-input (Other) question buttons", () => {
    const [element] = renderButtonsBlock({
      label: "Other…",
      action: {
        type: "question",
        questionId: QUESTION_ID,
        intent: "custom-input",
      },
    });

    expect(element).toEqual({
      tag: "markdown",
      content: "- Other…",
    });
  });

  it("falls back to text when the question option exceeds the 512-char envelope limit", () => {
    const [element] = renderButtonsBlock({
      label: "Long option",
      action: {
        type: "question",
        questionId: QUESTION_ID,
        optionValue: "x".repeat(513),
      },
    });

    expect(element).toEqual({
      tag: "markdown",
      content: "- Long option",
    });
  });

  it("keeps disabled question buttons visible as plain text", () => {
    const [element] = renderButtonsBlock({
      label: "Unavailable option",
      disabled: true,
      action: {
        type: "question",
        questionId: QUESTION_ID,
        optionValue: "Unavailable option",
      },
    });

    expect(element).toEqual({
      tag: "markdown",
      content: "- Unavailable option",
    });
  });
});
