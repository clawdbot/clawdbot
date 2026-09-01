// Mattermost tests cover answering an ask_user question from its button.
//
// Every case drives the composed handleInteraction that registerMattermostInteractions
// hands to the transport, so the behavior and the wiring are pinned together.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOptionMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn());
type CapturedDispatch = (opts: never) => Promise<{
  update?: { message: string; props?: Record<string, unknown> };
  ephemeral_text?: string;
} | null>;
const createInteractionHandlerMock = vi.hoisted(() =>
  vi.fn((_options: { handleInteraction?: CapturedDispatch }) => async () => {}),
);
const registerPluginHttpRouteMock = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: resolveOptionMock },
}));
vi.mock("./monitor-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-auth.js")>()),
  authorizeMattermostCommandInvocation: authorizeMock,
}));
vi.mock("./interactions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./interactions.js")>()),
  createMattermostInteractionHandler: createInteractionHandlerMock,
}));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  registerPluginHttpRoute: registerPluginHttpRouteMock,
}));

const { registerMattermostInteractions } = await import("./monitor-interactions.js");

const QUESTION_ID = "01JD3ZK8Q0000000000000000A";

const resolveChannelInfoMock = vi.fn(async () => ({ id: "chan-1", type: "O" }));

function captureDispatcher(overrides?: {
  error?: (message: string) => void;
  handleModelPickerInteraction?: ReturnType<typeof vi.fn>;
}) {
  registerMattermostInteractions({
    monitor: {
      account: { accountId: "main" },
      cfg: {},
      client: {},
      core: { channel: { commands: { shouldHandleTextCommands: () => true } } },
      pairing: { readAllowFromStore: async () => [] },
      resources: { resolveChannelInfo: resolveChannelInfoMock },
      runtime: { error: overrides?.error ?? vi.fn(), log: vi.fn() },
      botUserId: "bot",
    },
    interactionPath: "/mattermost/interactions/main",
    allowedSourceIps: ["127.0.0.1"],
    handleModelPickerInteraction:
      overrides?.handleModelPickerInteraction ?? vi.fn(async () => null),
  } as never);
  const options = createInteractionHandlerMock.mock.calls[0]?.[0];
  if (!options?.handleInteraction) {
    throw new Error("registration did not supply a handleInteraction");
  }
  return options.handleInteraction;
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

describe("mattermost question interactions", () => {
  beforeEach(() => {
    resolveOptionMock.mockReset();
    resolveOptionMock.mockResolvedValue({ status: "answered" });
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue({ ok: true, roomLabel: "#town-square" });
    resolveChannelInfoMock.mockClear();
    createInteractionHandlerMock.mockClear();
  });

  it("submits the clicked option to the question Gateway and retires the prompt", async () => {
    const response = await captureDispatcher()(questionInteraction(questionContext));

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
    await captureDispatcher()(questionInteraction(questionContext));

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

    const response = await captureDispatcher()(questionInteraction(questionContext));

    expect(resolveOptionMock).not.toHaveBeenCalled();
    expect(response?.ephemeral_text).toBe("OpenClaw ignored this action for #town-square.");
    expect(response?.update).toBeUndefined();
  });

  it("keeps the prompt when the question was already answered", async () => {
    resolveOptionMock.mockResolvedValue({ status: "already-answered" });

    const response = await captureDispatcher()(questionInteraction(questionContext));

    expect(response?.ephemeral_text).toBe("This question was already answered.");
    expect(response?.update).toBeUndefined();
  });

  it("keeps the prompt when the Gateway rejects the answer, and tells the clicker", async () => {
    const error = vi.fn();
    resolveOptionMock.mockRejectedValue(new Error("gateway down"));

    const response = await captureDispatcher({ error })(questionInteraction(questionContext));

    expect(response?.ephemeral_text).toBe("Could not submit this answer.");
    expect(response?.update).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("gateway down"));
  });

  it("answers a question click without consulting the model picker", async () => {
    const picker = vi.fn(async () => null);

    await captureDispatcher({ handleModelPickerInteraction: picker })(
      questionInteraction(questionContext),
    );

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(picker).not.toHaveBeenCalled();
  });

  it("still hands every other click to the model picker", async () => {
    const picker = vi.fn(async () => ({ ephemeral_text: "picker" }));

    const response = await captureDispatcher({ handleModelPickerInteraction: picker })(
      questionInteraction({ callback_data: "deploy_approve" }),
    );

    expect(authorizeMock).not.toHaveBeenCalled();
    expect(resolveOptionMock).not.toHaveBeenCalled();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(response?.ephemeral_text).toBe("picker");
  });
});
