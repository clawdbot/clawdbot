// Msteams tests cover monitor handler.adaptive card plugin behavior.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { type MSTeamsActivityHandler, registerMSTeamsHandlers } from "./monitor-handler.js";
import {
  createActivityHandler,
  getMSTeamsTestRuntimeState,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { buildMSTeamsPresentationCard } from "./presentation.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const runtimeApiMockState = getMSTeamsTestRuntimeState();
const APPROVER_ID = "5e4b4b6f-c242-45de-b0de-bf44eb233145";

vi.mock("./reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
  }),
}));

function createDeps(): MSTeamsMessageHandlerDeps {
  installMSTeamsTestRuntime();

  return {
    cfg: {} as OpenClawConfig,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    app: {} as MSTeamsMessageHandlerDeps["app"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => false),
      findPreferredDmByUserId: vi.fn(async () => null),
    } satisfies MSTeamsConversationStore,
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };
}

async function runAdaptiveCardInvoke(
  registered: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  },
  value: unknown,
) {
  await registered.run({
    activity: {
      id: "invoke-1",
      type: "invoke",
      name: "adaptiveCard/action",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: "user-bf",
        aadObjectId: "user-aad",
        name: "User",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: "19:personal-chat;messageid=abc123",
        conversationType: "personal",
      },
      channelData: {},
      attachments: [],
      value,
    },
    sendActivity: vi.fn(async () => ({ id: "activity-id" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext);
}

async function runMessageActivity(params: {
  value?: unknown;
  text?: string;
  deps?: MSTeamsMessageHandlerDeps;
  senderId?: string;
}) {
  const deps = params.deps ?? createDeps();
  let messageHandler: Parameters<MSTeamsActivityHandler["onMessage"]>[0] | undefined;
  const handler: MSTeamsActivityHandler = {
    onMessage: (callback) => {
      messageHandler = callback;
      return handler;
    },
    onMembersAdded: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run: vi.fn(async () => undefined),
  };
  registerMSTeamsHandlers(handler, deps);
  await messageHandler?.(
    {
      activity: {
        id: "message-1",
        type: "message",
        text: params.text ?? "",
        channelId: "msteams",
        serviceUrl: "https://service.example.test",
        from: {
          id: "user-bf",
          aadObjectId: params.senderId ?? "user-aad",
          name: "User",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:personal-chat",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
        value: params.value,
      },
      sendActivity: vi.fn(async () => ({ id: "activity-id" })),
      sendActivities: async () => [],
    } as unknown as MSTeamsTurnContext,
    vi.fn(async () => undefined),
  );
}

function lastDispatchedCtxPayload(): Record<string, unknown> {
  const dispatched = runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mock.calls.at(
    -1,
  )?.[0] as { ctx?: Record<string, unknown> } | undefined;
  if (!dispatched?.ctx) {
    throw new Error("expected dispatched context payload");
  }
  return dispatched.ctx;
}

describe("msteams adaptive card action invoke", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  });

  it("renders and resolves a typed approval before agent dispatch", async () => {
    const card = buildMSTeamsPresentationCard({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                action: {
                  type: "approval",
                  approvalId: "plugin:approval-1",
                  approvalKind: "plugin",
                  decision: "allow-once",
                },
              },
            ],
          },
        ],
      },
    });
    const submittedData = (card.actions?.[0] as { data?: unknown } | undefined)?.data;
    const gatewayRequest = vi.fn(
      async (): Promise<ApprovalResolveResult> => ({
        applied: true,
        approval: {
          id: "plugin:approval-1",
          urlPath: "/approve/plugin%3Aapproval-1",
          createdAtMs: 1,
          expiresAtMs: 10_000,
          resolvedAtMs: 2,
          reason: "user",
          presentation: {
            kind: "plugin",
            title: "Send Outlook message",
            description: "Send this exact prepared Outlook message now.",
            severity: "info",
            allowedDecisions: ["allow-once", "deny"],
          },
          status: "allowed",
          decision: "allow-once",
        },
      }),
    );
    const deps = createDeps();
    deps.accountId = "jimmy";
    deps.cfg = {
      channels: { msteams: { allowFrom: [APPROVER_ID] } },
    } as OpenClawConfig;
    deps.approvalGatewayRuntime = { request: gatewayRequest };

    await runMessageActivity({ value: submittedData, deps, senderId: APPROVER_ID });

    expect(deps.log.debug).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
    expect(deps.runtime.error).not.toHaveBeenCalled();
    expect(gatewayRequest).toHaveBeenCalledWith(
      "approval.resolve",
      {
        id: "plugin:approval-1",
        kind: "plugin",
        decision: "allow-once",
        reviewer: {
          channel: "msteams",
          accountId: "jimmy",
          senderId: APPROVER_ID,
        },
      },
      { clientDisplayName: `Microsoft Teams approval (${APPROVER_ID})` },
    );
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("consumes an unauthorized approval before gateway or agent dispatch", async () => {
    const gatewayRequest = vi.fn();
    const deps = createDeps();
    deps.accountId = "jimmy";
    deps.cfg = {
      channels: { msteams: { allowFrom: [APPROVER_ID] } },
    } as OpenClawConfig;
    deps.approvalGatewayRuntime = { request: gatewayRequest };

    await runMessageActivity({
      text: "/approve plugin:approval-1 allow-once",
      deps,
      senderId: "6e4b4b6f-c242-45de-b0de-bf44eb233146",
    });

    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });

  it("forwards adaptive card submitted data to the agent as message text", async () => {
    const deps = createDeps();
    const run = vi.fn(async () => undefined);
    const handler = createActivityHandler(run);
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const payload = {
      action: {
        type: "Action.Submit",
        data: {
          intent: "deploy",
          environment: "prod",
        },
      },
      trigger: "button-click",
    };

    await runAdaptiveCardInvoke(registered, payload);

    expect(run).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const expectedBody = JSON.stringify(payload.action.data);
    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.RawBody).toBe(expectedBody);
    expect(ctxPayload.BodyForAgent).toBe(expectedBody);
    expect(ctxPayload.CommandBody).toBe(expectedBody);
    expect(ctxPayload.SessionKey).toBe("msteams:direct:user-aad");
    expect(ctxPayload.SenderId).toBe("user-aad");
  });

  it("routes Teams imBack actions as the submitted message text", async () => {
    const deps = createDeps();
    const handler = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await runAdaptiveCardInvoke(registered, {
      action: {
        type: "Action.Submit",
        data: { msteams: { type: "imBack", value: "Summarize my last meeting" } },
      },
    });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe("Summarize my last meeting");
    expect(ctxPayload.CommandBody).toBe("Summarize my last meeting");
  });

  it("routes typed command submit actions as command text", async () => {
    const deps = createDeps();
    const handler = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await runAdaptiveCardInvoke(registered, {
      action: {
        type: "Action.Submit",
        data: "/codex plugins menu",
      },
    });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe("/codex plugins menu");
    expect(ctxPayload.CommandBody).toBe("/codex plugins menu");
  });

  it("preserves legacy presentation submit values as structured data", async () => {
    const deps = createDeps();
    const handler = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const data = { value: "/codex permissions yolo", label: "Run" };

    await runAdaptiveCardInvoke(registered, {
      action: {
        type: "Action.Submit",
        data,
      },
    });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe(JSON.stringify(data));
    expect(ctxPayload.CommandBody).toBe(JSON.stringify(data));
  });

  it("preserves arbitrary submitted data with a value field", async () => {
    const deps = createDeps();
    const handler = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const data = { value: "selected", formId: "deploy-approval", choices: ["canary"] };

    await runAdaptiveCardInvoke(registered, {
      action: {
        type: "Action.Submit",
        data,
      },
    });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe(JSON.stringify(data));
    expect(ctxPayload.CommandBody).toBe(JSON.stringify(data));
  });

  it("preserves generic Action.Execute verb metadata", async () => {
    const deps = createDeps();
    const handler = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const payload = {
      action: {
        type: "Action.Execute",
        verb: "ticket.approve",
        data: { ticketId: "ticket-123" },
      },
    };

    await runAdaptiveCardInvoke(registered, payload);

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe(JSON.stringify(payload));
    expect(ctxPayload.CommandBody).toBe(JSON.stringify(payload));
  });

  it("routes message activities with submitted card values as message text", async () => {
    const data = { value: "button-submit-value", label: "Submit action" };

    await runMessageActivity({ value: data });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe(JSON.stringify(data));
    expect(ctxPayload.CommandBody).toBe(JSON.stringify(data));
    expect(ctxPayload.SessionKey).toBe("msteams:direct:user-aad");
    expect(ctxPayload.SenderId).toBe("user-aad");
  });

  it("keeps activity text ahead of submitted card values on normal messages", async () => {
    await runMessageActivity({
      text: "typed text",
      value: { value: "card-value", label: "Card value" },
    });

    const ctxPayload = lastDispatchedCtxPayload();
    expect(ctxPayload.BodyForAgent).toBe("typed text");
    expect(ctxPayload.CommandBody).toBe("typed text");
  });
});
