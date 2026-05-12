import { describe, expect, it } from "vitest";
import { CreateResponseBodySchema, OutputItemSchema } from "./open-responses.schema.js";
import { buildAgentPrompt } from "./openresponses-prompt.js";
import { createAssistantOutputItem } from "./openresponses-shape.js";

describe("openresponses phase support", () => {
  it("accepts assistant message phase and rejects user phase", () => {
    const assistantPhaseRequest = CreateResponseBodySchema.safeParse({
      model: "gpt-5.4",
      input: [
        {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: "Checking logs before I answer.",
        },
        {
          type: "message",
          role: "user",
          content: "What did you find?",
        },
      ],
    });
    expect(assistantPhaseRequest.success).toBe(true);

    const userPhaseRequest = CreateResponseBodySchema.safeParse({
      model: "gpt-5.4",
      input: [
        {
          type: "message",
          role: "user",
          phase: "commentary",
          content: "Hi",
        },
      ],
    });
    expect(userPhaseRequest.success).toBe(false);
  });

  it("accepts assistant output item phase metadata", () => {
    const outputItem = OutputItemSchema.safeParse({
      type: "message",
      id: "msg_123",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Done." }],
      status: "completed",
    });

    expect(outputItem.success).toBe(true);
  });

  it("shapes assistant output items with the provided phase", () => {
    expect(
      createAssistantOutputItem({
        id: "msg_commentary",
        text: "Checking logs.",
        phase: "commentary",
        status: "completed",
      }),
    ).toEqual({
      type: "message",
      id: "msg_commentary",
      role: "assistant",
      content: [{ type: "output_text", text: "Checking logs." }],
      phase: "commentary",
      status: "completed",
    });

    expect(
      createAssistantOutputItem({
        id: "msg_final",
        text: "Root cause found.",
        phase: "final_answer",
        status: "completed",
      }),
    ).toEqual({
      type: "message",
      id: "msg_final",
      role: "assistant",
      content: [{ type: "output_text", text: "Root cause found." }],
      phase: "final_answer",
      status: "completed",
    });
  });

  it("builds prompts from phased assistant history without dropping text", () => {
    const prompt = buildAgentPrompt([
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: "Checking logs before I answer.",
      },
      {
        type: "message",
        role: "user",
        content: "What did you find?",
      },
    ]);

    expect(prompt.message).toContain("Checking logs before I answer.");
    expect(prompt.message).toContain("What did you find?");
  });
});
