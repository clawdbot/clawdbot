import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AskUserToolSchema, normalizeAskUserParams } from "./ask-user-tool-normalization.js";

const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging (Recommended)", description: "Safer default" },
        { label: "Production" },
      ],
    },
  ],
};

describe("ask_user normalization", () => {
  it("normalizes headers, forces free text, and clamps timeout", () => {
    const normalized = normalizeAskUserParams({ ...validArgs, timeoutSeconds: 5 });

    expect(normalized.timeoutSeconds).toBe(30);
    expect(normalized.questions[0]).toMatchObject({
      questionId: "deploy_target",
      header: "Deployment t",
      isOther: true,
    });
    expect(normalizeAskUserParams({ ...validArgs, timeoutSeconds: 9_999 }).timeoutSeconds).toBe(
      3_600,
    );
    expect(Value.Check(AskUserToolSchema, validArgs)).toBe(true);
    expect(
      Value.Check(AskUserToolSchema, {
        questions: [{ ...validArgs.questions[0], isSecret: true }],
      }),
    ).toBe(false);
    expect(normalized.questions[0]).not.toHaveProperty("isSecret");
  });

  it("repeats the structured-choice contract in the model-visible schema", () => {
    const schema = JSON.stringify(AskUserToolSchema);

    expect(schema).toContain("Put all selectable choices in options");
    expect(schema).toContain("Every selectable choice");
    expect(schema).toContain("True only when the user may choose several options at once");
  });

  it.each([
    ["empty questions", { questions: [] }, "1 to 3 questions"],
    [
      "too many questions",
      { questions: Array.from({ length: 4 }, () => validArgs.questions[0]) },
      "1 to 3 questions",
    ],
    [
      "too few options",
      { questions: [{ ...validArgs.questions[0], options: [{ label: "Only" }] }] },
      "2 to 4 options",
    ],
    [
      "duplicate ids",
      { questions: [validArgs.questions[0], validArgs.questions[0]] },
      "duplicate question id 'deploy_target'",
    ],
    [
      "invalid id",
      { questions: [{ ...validArgs.questions[0], id: "Deploy Target" }] },
      "must be snake_case",
    ],
  ])("rejects %s", (_name, args, error) => {
    expect(() => normalizeAskUserParams(args)).toThrow(error);
  });
});
