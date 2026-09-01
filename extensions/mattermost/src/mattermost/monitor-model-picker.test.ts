// Mattermost tests cover native model-picker interaction dispatch ownership.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  buildEventPlan: vi.fn(),
  buildPreparedModelsProviderData: vi.fn(),
  deliverReply: vi.fn(),
  dispatch: vi.fn(),
  parseContext: vi.fn(),
  runDetachedWebhookWork: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/webhook-request-guards", () => ({
  runDetachedWebhookWork: mocks.runDetachedWebhookWork,
}));

vi.mock("./model-picker.js", () => ({
  buildMattermostAllowedModelRefs: () => new Set(["openai/gpt-5.4"]),
  parseMattermostModelPickerContext: mocks.parseContext,
  renderMattermostModelsPickerView: () => ({ text: "updated picker", buttons: [] }),
  renderMattermostProviderPickerView: () => ({ text: "provider picker", buttons: [] }),
  resolveMattermostModelPickerCurrentModel: () => "openai/gpt-5.4",
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: mocks.authorize,
}));

vi.mock("./monitor-event-plan.js", () => ({
  buildMattermostEventPlan: mocks.buildEventPlan,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverMattermostReplyPayload: mocks.deliverReply,
}));

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  return {
    ...actual,
    buildPreparedModelsProviderData: mocks.buildPreparedModelsProviderData,
  };
});

import { createMattermostModelPickerInteractionHandler } from "./monitor-model-picker.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

describe("Mattermost model-picker interaction dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseContext.mockReturnValue({
      action: "select",
      ownerUserId: "user-1",
      provider: "openai",
      model: "gpt-5.4",
      page: 0,
    });
    mocks.authorize.mockResolvedValue({
      ok: true,
      commandAuthorized: true,
      channelInfo: { id: "channel-1", team_id: "team-1", type: "O" },
      kind: "channel",
      chatType: "channel",
      channelName: "lifecycle",
      channelDisplay: "Lifecycle",
      roomLabel: "#lifecycle",
    });
    mocks.buildPreparedModelsProviderData.mockResolvedValue({ providers: [{ id: "openai" }] });
    mocks.deliverReply.mockResolvedValue({
      outcome: "text",
      visibleReplySent: true,
      messageIds: ["confirmation-1"],
      content: "model updated",
    });
    mocks.buildEventPlan.mockResolvedValue({
      channelId: "channel-1",
      channelDisplay: "Lifecycle",
      kind: "channel",
      roomLabel: "#lifecycle",
      route: { agentId: "main", dmScope: "per-peer", sessionKey: "agent:main:mm" },
      thread: { sessionKey: "agent:main:mm", effectiveReplyToId: undefined },
      to: "channel:channel-1",
      finalizeContext: (context: Record<string, unknown>) => context,
      createReplyPlan: () => ({
        replyOptions: {},
        replyPipeline: {},
        tableMode: "off",
        textLimit: 4000,
      }),
    });
    mocks.dispatch.mockImplementation(async (params: Record<string, unknown>) => {
      const delivery = params.delivery as
        | { deliver?: (payload: { text: string; replyToId?: string }) => Promise<unknown> }
        | undefined;
      await delivery?.deliver?.({
        text: "model updated",
        replyToId: "interaction:picker-post-1:select:openai/gpt-5.4",
      });
      return {};
    });
  });

  it("reserves independent work before ack", async () => {
    let detachedRun: (() => Promise<void>) | undefined;
    mocks.runDetachedWebhookWork.mockImplementation((run: () => Promise<void>) => {
      detachedRun = run;
      return Promise.resolve();
    });
    const updateModelPickerPost = vi.fn(async () => ({}));
    const monitor = {
      account: { accountId: "default", config: {} },
      cfg: {},
      core: {
        channel: {
          commands: { shouldHandleTextCommands: vi.fn(() => true) },
          inbound: { dispatch: mocks.dispatch },
          text: {
            convertMarkdownTables: vi.fn((text: string) => text),
            hasControlCommand: vi.fn(() => true),
          },
        },
      },
      pairing: { readAllowFromStore: vi.fn(async () => []) },
      resources: {
        resolveChannelInfo: vi.fn(async () => ({ id: "channel-1", type: "O" })),
        updateModelPickerPost,
      },
      runtime: { error: vi.fn() },
    } as unknown as MattermostMonitorContext;
    const handler = createMattermostModelPickerInteractionHandler(monitor);

    const response = await handler({
      payload: {
        channel_id: "channel-1",
        post_id: "picker-post-1",
        team_id: "team-1",
        user_id: "user-1",
      },
      userName: "tester",
      context: {},
      post: { id: "picker-post-1", channel_id: "channel-1", message: "picker" },
    });

    expect(response).toEqual({});
    expect(mocks.runDetachedWebhookWork).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(detachedRun).toBeTypeOf("function");

    await detachedRun?.();

    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "mattermost",
        delivery: expect.objectContaining({ observeMessageSent: true }),
      }),
    );
    expect(mocks.deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "channel-1", replyToId: "picker-post-1" }),
    );
    expect(updateModelPickerPost).toHaveBeenCalledWith(
      expect.objectContaining({ message: "updated picker" }),
    );
  });
});
