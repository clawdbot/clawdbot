// Mattermost tests cover answering an ask_user question from its button.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOptionMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: resolveOptionMock },
}));

const { createMattermostQuestionInteractionHandler } = await import("./monitor-interactions.js");

const QUESTION_ID = "01JD3ZK8Q0000000000000000A";

function createHandler(overrides?: { error?: (message: string) => void }) {
  return createMattermostQuestionInteractionHandler({
    account: { accountId: "main" },
    cfg: {},
    runtime: { error: overrides?.error ?? vi.fn() },
  } as never);
}

function questionInteraction(context: Record<string, unknown>) {
  return {
    payload: {
      channel_id: "chan-1",
      post_id: "post-1",
      user_id: "user-1",
      user_name: "ada",
    },
    userName: "ada",
    actionId: "question-1",
    actionName: "production",
    originalMessage: "Which environment?",
    context,
    post: { id: "post-1", message: "Which environment?" },
  } as never;
}

const questionContext = {
  oc_question: true,
  question_id: QUESTION_ID,
  option_index: 1,
};

describe("createMattermostQuestionInteractionHandler", () => {
  beforeEach(() => {
    resolveOptionMock.mockReset();
    resolveOptionMock.mockResolvedValue({ status: "answered" });
  });

  it("submits the clicked option to the question Gateway", async () => {
    const response = await createHandler()(questionInteraction(questionContext));

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(resolveOptionMock.mock.calls[0]?.[0]).toMatchObject({
      questionId: QUESTION_ID,
      optionIndex: 1,
      senderId: "user-1",
    });
    expect(response?.ephemeral_text).toBe("Answer submitted.");
    expect(response?.update?.props).toEqual({
      attachments: [{ text: "✓ **production** selected by @ada" }],
    });
  });

  it("leaves every other button to the handler that owns it", async () => {
    const response = await createHandler()(
      questionInteraction({ callback_data: "deploy_approve" }),
    );

    expect(response).toBeNull();
    expect(resolveOptionMock).not.toHaveBeenCalled();
  });

  it("says so when the question was already answered", async () => {
    resolveOptionMock.mockResolvedValue({ status: "already-answered" });

    const response = await createHandler()(questionInteraction(questionContext));

    expect(response?.ephemeral_text).toBe("This question was already answered.");
  });

  it("reports a Gateway failure to the clicker instead of staying silent", async () => {
    const error = vi.fn();
    resolveOptionMock.mockRejectedValue(new Error("gateway down"));

    const response = await createHandler({ error })(questionInteraction(questionContext));

    expect(response?.ephemeral_text).toBe("Could not submit this answer.");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("gateway down"));
  });
});
