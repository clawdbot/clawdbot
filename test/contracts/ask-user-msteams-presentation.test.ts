import { describe, expect, it } from "vitest";
import { msteamsPlugin } from "../../extensions/msteams/api.js";
import { buildAgentHarnessQuestionPromptPayload } from "../../src/agents/harness/user-input-bridge.js";

describe("question reply guidance", () => {
  it.each([
    { isOther: false, guidance: "Reply with the number or option text." },
    {
      isOther: true,
      guidance: "Reply with the number, the option text, or your own answer.",
    },
  ])(
    "remains actionable without question buttons (isOther=$isOther)",
    async ({ isOther, guidance }) => {
      const payload = buildAgentHarnessQuestionPromptPayload({
        questionId: "question-1",
        questions: [
          {
            id: "target",
            header: "Target",
            question: "Where should this deploy?",
            options: [{ label: "Staging", description: "Safer default" }, { label: "Production" }],
            isOther,
          },
        ],
      });
      const presentation = payload.presentation;
      if (!presentation) {
        throw new Error("Expected a single-choice question presentation");
      }
      const optionText = ["- Staging: Safer default", "- Production", "", guidance].join("\n");

      expect(payload.text).toContain(guidance);

      // Teams supports buttons, but does not encode question actions as native controls.
      const rendered = await msteamsPlugin.outbound?.renderPresentation?.({
        payload,
        presentation,
        ctx: { cfg: {}, to: "conversation:test", text: payload.text, payload },
      });
      expect(rendered?.channelData?.msteams).toEqual({
        presentationCard: {
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: payload.text, wrap: true },
            { type: "TextBlock", text: "Where should this deploy?", wrap: true },
            { type: "TextBlock", text: optionText, wrap: true },
          ],
        },
      });
    },
  );
});
