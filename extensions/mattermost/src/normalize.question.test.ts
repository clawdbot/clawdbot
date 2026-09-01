// Mattermost tests cover ask_user question encoding in presentations.
import { describe, expect, it } from "vitest";
import { parseMattermostQuestionContext, resolveMattermostPresentation } from "./normalize.js";

const QUESTION_ID = "01JD3ZK8Q0000000000000000A";

function questionPayload(overrides?: { optionValues?: string[] }) {
  return {
    text: "Which environment?\n- staging\n- production",
    presentationTextMode: "fallback" as const,
    presentation: {
      blocks: [
        { type: "text" as const, text: "Which environment?" },
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "staging",
              action: {
                type: "question" as const,
                questionId: QUESTION_ID,
                optionValue: "staging",
              },
            },
            {
              label: "production",
              action: {
                type: "question" as const,
                questionId: QUESTION_ID,
                optionValue: "production",
              },
            },
          ],
        },
      ],
    },
    channelData: {
      askUser: {
        questionId: QUESTION_ID,
        optionValues: overrides?.optionValues ?? ["staging", "production"],
      },
    },
  };
}

describe("resolveMattermostPresentation question actions", () => {
  it("encodes each option as a button carrying the Gateway option index", () => {
    const { buttons } = resolveMattermostPresentation(questionPayload());

    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toEqual([
      {
        id: "question-0",
        text: "staging",
        context: { oc_question: true, question_id: QUESTION_ID, option_index: 0 },
        style: undefined,
      },
      {
        id: "question-1",
        text: "production",
        context: { oc_question: true, question_id: QUESTION_ID, option_index: 1 },
        style: undefined,
      },
    ]);
  });

  it("uses the Gateway's option order, not the order the buttons render in", () => {
    const payload = questionPayload({ optionValues: ["production", "staging"] });
    const { buttons } = resolveMattermostPresentation(payload);

    expect(buttons[0]?.map((button) => [button.text, button.context.option_index])).toEqual([
      ["staging", 1],
      ["production", 0],
    ]);
  });

  it("leaves the custom-input option to prose", () => {
    const payload = questionPayload();
    payload.presentation.blocks[1]!.buttons!.push({
      label: "Other…",
      // The Gateway has no option index for free-form input.
      action: { type: "question", questionId: QUESTION_ID, intent: "custom-input" },
    } as never);

    const { buttons } = resolveMattermostPresentation(payload);

    expect(buttons[0]?.map((button) => button.text)).toEqual(["staging", "production"]);
  });

  it("emits no button when the reply carries no Gateway option list", () => {
    const payload = questionPayload();
    const { buttons } = resolveMattermostPresentation({ ...payload, channelData: undefined });

    expect(buttons).toEqual([]);
  });

  it("still refuses typed actions Mattermost cannot preserve", () => {
    const { buttons } = resolveMattermostPresentation({
      text: "Deploy?",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Run", action: { type: "command", command: "/deploy" } },
              { label: "Ping", action: { type: "callback", value: "ping" } },
            ],
          },
        ],
      },
      channelData: {
        askUser: { questionId: QUESTION_ID, optionValues: ["staging", "production"] },
      },
    });

    expect(buttons).toEqual([]);
  });

  it("keeps rendering the deprecated value-shaped button", () => {
    const { buttons } = resolveMattermostPresentation({
      text: "Deploy?",
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "deploy_approve" }] }],
      },
    });

    expect(buttons[0]?.[0]).toMatchObject({ id: "deploy_approve", text: "Approve" });
  });
});

describe("parseMattermostQuestionContext", () => {
  it("reads back what the button encoded", () => {
    const { buttons } = resolveMattermostPresentation(questionPayload());
    const context = buttons[0]?.[1]?.context;

    expect(parseMattermostQuestionContext(context as Record<string, unknown>)).toEqual({
      questionId: QUESTION_ID,
      optionIndex: 1,
    });
  });

  it("ignores a context that is not a question", () => {
    expect(parseMattermostQuestionContext({ callback_data: "deploy_approve" })).toBeNull();
    expect(parseMattermostQuestionContext({ oc_question: true })).toBeNull();
    expect(
      parseMattermostQuestionContext({ oc_question: true, question_id: QUESTION_ID }),
    ).toBeNull();
  });
});
