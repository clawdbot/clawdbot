import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import {
  buildFinalizedFeishuQuestionCard,
  buildFeishuPresentationCard,
  buildFeishuPresentationCardElements,
  isFeishuCardWithinEnvelope,
} from "./presentation-card.js";

describe("buildFeishuPresentationCardElements", () => {
  it("renders table blocks through the portable text fallback", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCardElements({ presentation })).toEqual([
      {
        tag: "markdown",
        content:
          "Pipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      },
    ]);
  });

  it("renders guarded question callbacks and removes them after resolution", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        { type: "text", text: "Choose an environment" },
        {
          type: "buttons",
          buttons: [
            {
              label: "Production",
              action: {
                type: "question",
                questionId: "ask_0123456789abcdef0123456789abcdef",
                optionValue: "Production",
              },
            },
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    const card = buildFeishuPresentationCard({
      presentation,
      questionContext: { u: "ou_user", h: "oc_chat", e: 3_601_000 },
    });
    expect(card.body).toEqual({
      elements: [
        { tag: "markdown", content: "Choose an environment" },
        {
          tag: "button",
          text: { tag: "plain_text", content: "Production" },
          type: "default",
          behaviors: [
            {
              type: "callback",
              value: {
                oc: "ocf1",
                k: "button",
                a: "feishu.payload.question",
                m: {
                  questionId: "ask_0123456789abcdef0123456789abcdef",
                  optionValue: "Production",
                },
                c: { u: "ou_user", h: "oc_chat", e: 3_601_000 },
              },
            },
          ],
        },
      ],
    });

    expect(
      buildFinalizedFeishuQuestionCard({
        card,
        statusLine: "Answered: <Production>",
      }).body,
    ).toEqual({
      elements: [
        { tag: "markdown", content: "Choose an environment" },
        {
          tag: "markdown",
          content: "<font color='grey'>Answered: &lt;Production&gt;</font>",
        },
      ],
    });
  });
});

describe("isFeishuCardWithinEnvelope", () => {
  it("counts nested elements against the 200-element API limit", () => {
    const buildCard = (elementCount: number) => ({
      schema: "2.0",
      body: {
        elements: Array.from({ length: elementCount }, (_entry, index) => ({
          tag: "markdown",
          content: String(index),
        })),
      },
    });

    expect(isFeishuCardWithinEnvelope(buildCard(200))).toBe(true);
    expect(isFeishuCardWithinEnvelope(buildCard(201))).toBe(false);
  });
});
