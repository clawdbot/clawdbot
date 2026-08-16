// @vitest-environment node
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  controlModelChatInteractionProps,
  controlModelQuestionPromptCommand,
} from "./chat-control-model-interactions.ts";

afterEach(() => vi.restoreAllMocks());

function conversation(status = "pending") {
  const answerQuestion = vi.fn(async () => ({ status: "answered" }));
  const cancelQuestion = vi.fn(async () => ({ status: "cancelled" }));
  return {
    answerQuestion,
    cancelQuestion,
    getSnapshot: () => ({
      artifacts: [{ id: "artifact-one" }],
      questions: [{ id: "question-1", status }],
      commandAvailability: {
        send: true,
        abort: true,
        resolveApproval: false,
        answerQuestion: true,
        cancelQuestion: true,
        materializeView: false,
      },
    }),
  };
}

describe("controlModelQuestionPromptCommand", () => {
  it("routes an exact pending answer through the selected conversation with its deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const selected = conversation();
    const command = controlModelQuestionPromptCommand(selected, "question-1", "answer");

    await expect(
      command?.({
        id: "question-1",
        expiresAtMs: 3_000,
        answers: { answers: { format: ["Compact"] } },
      }),
    ).resolves.toEqual({ status: "answered" });
    expect(selected.answerQuestion).toHaveBeenCalledWith(
      "question-1",
      { format: ["Compact"] },
      { timeoutMs: 2_000 },
    );
    expect(selected.cancelQuestion).not.toHaveBeenCalled();
  });

  it("caps a selected cancel at the incumbent Gateway request deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const selected = conversation();
    const command = controlModelQuestionPromptCommand(selected, "question-1", "cancel");

    await command?.({
      id: "question-1",
      expiresAtMs: 1_000 + DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS * 2,
      cancel: true,
    });

    expect(selected.cancelQuestion).toHaveBeenCalledWith("question-1", {
      timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
    });
    expect(selected.answerQuestion).not.toHaveBeenCalled();
  });

  it("leaves unmatched and terminal questions on the incumbent raw path", () => {
    expect(
      controlModelQuestionPromptCommand(conversation(), "question-other", "answer"),
    ).toBeUndefined();
    expect(
      controlModelQuestionPromptCommand(conversation("answered"), "question-1", "cancel"),
    ).toBeUndefined();
  });

  it("does not expose the previous global agent conversation after agent selection changes", () => {
    const selected = conversation();
    const state = {
      controlModelConversation: selected,
      controlModelConversationSessionKey: "global",
      controlModelConversationAgentId: "main",
    } as never;

    expect(
      controlModelChatInteractionProps(state, {} as never, "global", "work").controlModelArtifacts,
    ).toBeUndefined();
    expect(
      controlModelChatInteractionProps(state, {} as never, "global", "main").controlModelArtifacts,
    ).toEqual([{ id: "artifact-one" }]);
  });
});
