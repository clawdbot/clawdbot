// Mattermost tests cover answering an ask_user question from its button.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOptionMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: resolveOptionMock },
}));
vi.mock("./monitor-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-auth.js")>()),
  authorizeMattermostCommandInvocation: authorizeMock,
}));

const { createMattermostQuestionInteractionHandler } = await import("./monitor-interactions.js");

const QUESTION_ID = "01JD3ZK8Q0000000000000000A";

const resolveChannelInfoMock = vi.fn(async () => ({ id: "chan-1", type: "O" }));
const readAllowFromStoreMock = vi.fn(async () => []);

function createHandler(overrides?: { error?: (message: string) => void }) {
  return createMattermostQuestionInteractionHandler({
    account: { accountId: "main" },
    cfg: {},
    core: { channel: { commands: { shouldHandleTextCommands: () => true } } },
    pairing: { readAllowFromStore: readAllowFromStoreMock },
    resources: { resolveChannelInfo: resolveChannelInfoMock },
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
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue({ ok: true, roomLabel: "#town-square" });
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

  it("takes a fresh authorization decision before the Gateway write", async () => {
    await createHandler()(questionInteraction(questionContext));

    expect(authorizeMock).toHaveBeenCalledTimes(1);
    expect(authorizeMock.mock.calls[0]?.[0]).toMatchObject({
      senderId: "user-1",
      channelId: "chan-1",
      hasControlCommand: false,
    });
    expect(resolveChannelInfoMock).toHaveBeenCalledWith("chan-1");
  });

  it("refuses a click current policy denies, before any Gateway I/O", async () => {
    authorizeMock.mockResolvedValue({
      ok: false,
      denyReason: "channel-no-allowlist",
      roomLabel: "#town-square",
    });

    const response = await createHandler()(questionInteraction(questionContext));

    expect(resolveOptionMock).not.toHaveBeenCalled();
    expect(response?.ephemeral_text).toBe("OpenClaw ignored this action for #town-square.");
    expect(response?.update).toBeUndefined();
  });

  it("leaves every other button to the handler that owns it", async () => {
    const response = await createHandler()(
      questionInteraction({ callback_data: "deploy_approve" }),
    );

    expect(response).toBeNull();
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(resolveOptionMock).not.toHaveBeenCalled();
  });

  it("keeps the prompt when the question was already answered", async () => {
    resolveOptionMock.mockResolvedValue({ status: "already-answered" });

    const response = await createHandler()(questionInteraction(questionContext));

    expect(response?.ephemeral_text).toBe("This question was already answered.");
    expect(response?.update).toBeUndefined();
  });

  it("keeps the prompt when the Gateway rejects the answer, and tells the clicker", async () => {
    const error = vi.fn();
    resolveOptionMock.mockRejectedValue(new Error("gateway down"));

    const response = await createHandler({ error })(questionInteraction(questionContext));

    expect(response?.ephemeral_text).toBe("Could not submit this answer.");
    expect(response?.update).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("gateway down"));
  });
});
