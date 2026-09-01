// Mattermost tests cover which handler a button click reaches first.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveOptionMock = vi.hoisted(() => vi.fn());
const createInteractionHandlerMock = vi.hoisted(() => vi.fn(() => async () => {}));
const registerPluginHttpRouteMock = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: resolveOptionMock },
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

function interaction(context: Record<string, unknown>) {
  return {
    payload: { channel_id: "chan-1", post_id: "post-1", user_id: "user-1", user_name: "ada" },
    userName: "ada",
    actionId: "question1",
    actionName: "production",
    originalMessage: "Which environment?",
    context,
    post: { id: "post-1", message: "Which environment?" },
  } as never;
}

/** The composed dispatcher the registration hands to the transport. */
function registerAndCaptureDispatcher(handleModelPickerInteraction: ReturnType<typeof vi.fn>) {
  registerMattermostInteractions({
    monitor: {
      account: { accountId: "main" },
      cfg: {},
      client: {},
      core: {},
      pairing: {},
      resources: {},
      runtime: { error: vi.fn(), log: vi.fn() },
      botUserId: "bot",
    },
    interactionPath: "/mattermost/interactions/main",
    allowedSourceIps: ["127.0.0.1"],
    handleModelPickerInteraction,
  } as never);
  const options = createInteractionHandlerMock.mock.calls[0]?.[0] as
    | { handleInteraction?: (opts: never) => Promise<unknown> }
    | undefined;
  if (!options?.handleInteraction) {
    throw new Error("registration did not supply a handleInteraction");
  }
  return options.handleInteraction;
}

describe("registerMattermostInteractions handler order", () => {
  beforeEach(() => {
    resolveOptionMock.mockReset();
    resolveOptionMock.mockResolvedValue({ status: "answered" });
    createInteractionHandlerMock.mockClear();
  });

  it("answers a question click without consulting the model picker", async () => {
    const picker = vi.fn(async () => null);
    const dispatch = registerAndCaptureDispatcher(picker);

    const response = await dispatch(
      interaction({ oc_question: true, question_id: QUESTION_ID, option_index: 1 }),
    );

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(picker).not.toHaveBeenCalled();
    expect((response as { ephemeral_text?: string } | null)?.ephemeral_text).toBe(
      "Answer submitted.",
    );
  });

  it("still hands every other click to the model picker", async () => {
    const picker = vi.fn(async () => ({ ephemeral_text: "picker" }));
    const dispatch = registerAndCaptureDispatcher(picker);

    const response = await dispatch(interaction({ callback_data: "deploy_approve" }));

    expect(resolveOptionMock).not.toHaveBeenCalled();
    expect(picker).toHaveBeenCalledTimes(1);
    expect((response as { ephemeral_text?: string } | null)?.ephemeral_text).toBe("picker");
  });
});
