// Imessage tests cover approval handler plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { imessageApprovalNativeRuntime } from "./approval-handler.runtime.js";
import {
  iMessageApprovalPollTargets,
  maybeResolveIMessageApprovalPollVote,
} from "./approval-polls.js";

const sendMock = vi.hoisted(() => ({
  sendMessageIMessage: vi.fn(),
}));

const probeMock = vi.hoisted(() => ({
  getCachedIMessagePrivateApiStatus: vi.fn(),
  probeIMessagePrivateApi: vi.fn(),
}));

const actionsMock = vi.hoisted(() => ({
  sendPoll: vi.fn(),
  resolveChatGuidForTarget: vi.fn(),
}));

const timersMock = vi.hoisted(() => ({
  delay: vi.fn(async () => undefined),
}));

const approvalGatewayMock = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

const ACCOUNT_ID = "default";
const HANDLE = "+15551230000";
const CHAT_GUID = "iMessage;-;+15551230000";
const PROMPT_GUID = "prompt-guid";
const POLL_GUID = "poll-guid";
const POLL_TEXT = "Reply with: /approve exec-1 allow-once";
const POLL_CAPABLE_STATUS = {
  available: true,
  selectors: { pollPayloadMessage: true, retractMessagePart: true },
  rpcMethods: ["poll.send"],
  cliCapabilities: { pollSendSupportsNoComment: true },
};
const NO_POLL_SELECTOR_STATUS = { available: true, selectors: {}, rpcMethods: [] };

type PendingPayloadArgs = Parameters<
  typeof imessageApprovalNativeRuntime.presentation.buildPendingPayload
>[0];
type PrepareTargetArgs = Parameters<
  typeof imessageApprovalNativeRuntime.transport.prepareTarget
>[0];

function buildPendingPayload(
  args: Pick<PendingPayloadArgs, "request" | "approvalKind" | "view"> &
    Partial<Omit<PendingPayloadArgs, "request" | "approvalKind" | "view">>,
) {
  return imessageApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg: {} as never,
    accountId: ACCOUNT_ID,
    context: { accountId: ACCOUNT_ID },
    nowMs: 0,
    ...args,
  });
}

function execRequest(approvalId = "exec-1") {
  return {
    id: approvalId,
    request: { command: "echo hi" },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  } as never;
}

function execView(
  approvalId = "exec-1",
  actions: Array<Record<string, string>> = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    approvalKind: "exec",
    approvalId,
    commandText: "echo hi",
    actions,
    ...overrides,
  } as never;
}

function prepareTarget(
  to: string,
  accountId = ACCOUNT_ID,
  surface: "origin" | "approver-dm" = "origin",
) {
  const args: PrepareTargetArgs = {
    cfg: {} as never,
    accountId,
    context: { accountId },
    plannedTarget: {
      surface,
      reason: "preferred",
      target: { to },
    },
    request: execRequest(),
    approvalKind: "exec",
    view: execView(),
    pendingPayload: {
      text: "pending",
      pollText: "pending",
      allowedDecisions: ["allow-once"],
    },
  };
  return imessageApprovalNativeRuntime.transport.prepareTarget(args);
}

function sendResult(
  messageId: string,
  params: {
    guid?: string;
    service?: string;
    chatGuid?: string;
    sentText?: string;
  } = {},
) {
  return {
    messageId,
    ...params,
    receipt: { kind: "text" } as never,
  };
}

vi.mock("node:timers/promises", () => ({
  setTimeout: timersMock.delay,
}));

vi.mock("./send.js", () => ({
  sendMessageIMessage: sendMock.sendMessageIMessage,
}));

vi.mock("./probe.js", () => ({
  getCachedIMessagePrivateApiStatus: probeMock.getCachedIMessagePrivateApiStatus,
  probeIMessagePrivateApi: probeMock.probeIMessagePrivateApi,
}));

vi.mock("./actions.runtime.js", () => ({
  imessageActionsRuntime: {
    sendPoll: actionsMock.sendPoll,
    resolveChatGuidForTarget: actionsMock.resolveChatGuidForTarget,
  },
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: approvalGatewayMock.resolveApprovalOverGateway,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/error-runtime")>(
    "openclaw/plugin-sdk/error-runtime",
  );
  return {
    ...actual,
    isApprovalNotFoundError: approvalGatewayMock.isApprovalNotFoundError,
  };
});

describe("imessageApprovalNativeRuntime", () => {
  it("renders shared reactions in pending exec approvals", async () => {
    const payload = await buildPendingPayload({
      request: execRequest(),
      approvalKind: "exec",
      view: execView("exec-1", [
        {
          decision: "allow-once",
          label: "Allow Once",
          command: "/approve exec-1 allow-once",
          style: "success",
        },
        {
          decision: "deny",
          label: "Deny",
          command: "/approve exec-1 deny",
          style: "danger",
        },
      ]),
    });

    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.text).not.toContain("3️⃣ Deny");
    expect(payload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("renders shared reactions in pending plugin approvals", async () => {
    const payload = await buildPendingPayload({
      request: {
        id: "plugin:abc",
        request: {
          title: "Allow Codex to use 1Password?",
          description: "Allow Codex to use 1Password?",
          pluginId: "openclaw-codex-app-server",
          toolName: "codex_mcp_tool_approval",
          severity: "warning",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:abc",
        title: "Plugin approval required",
        severity: "warning",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:abc allow-once",
            style: "success",
          },
          {
            decision: "allow-always",
            label: "Allow Always",
            command: "/approve plugin:abc allow-always",
            style: "primary",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:abc deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.text).toContain("Plugin approval required");
    expect(payload.text).toContain("Reply with: /approve plugin:abc allow-once|allow-always|deny");
    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("♾️ Allow Always");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("/approve <id>");
    expect(payload.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
  });

  it("normalizes iMessage handle targets and carries account ids into prepared delivery", async () => {
    await expect(prepareTarget("+1 (555) 123-0000", "ops")).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "+15551230000",
        accountId: "ops",
      },
    });
  });

  describe("deliverPending GUID-only binding", () => {
    beforeEach(() => {
      iMessageApprovalPollTargets.clearForTest();
      approvalGatewayMock.resolveApprovalOverGateway.mockReset();
      approvalGatewayMock.resolveApprovalOverGateway.mockResolvedValue({
        applied: true,
        approval: {},
      });
      sendMock.sendMessageIMessage.mockReset();
      // No cached bridge status: these cases exercise the text+tapback path.
      probeMock.getCachedIMessagePrivateApiStatus.mockReset();
      actionsMock.sendPoll.mockReset();
    });

    const baseDeliverArgs = {
      cfg: {} as never,
      accountId: ACCOUNT_ID,
      context: { accountId: ACCOUNT_ID },
      preparedTarget: { to: HANDLE, accountId: ACCOUNT_ID },
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: HANDLE },
      },
      request: execRequest(),
      approvalKind: "exec" as const,
      view: execView(),
      pendingPayload: {
        text: POLL_TEXT,
        pollText: POLL_TEXT,
        allowedDecisions: ["allow-once" as const],
      },
    };

    const deliverBase = () =>
      imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs);

    // Inbound `reacted_to_guid` is always a GUID, never the numeric ROWID.
    // Placeholder and ROWID-only bridge receipts therefore cannot bind reactions.
    [
      {
        title: "refuses to bind when the bridge returns only a numeric ROWID",
        sendResult: sendResult("12345", { sentText: POLL_TEXT }),
        expected: null,
      },
      {
        title: "binds against the GUID when the bridge returns one",
        sendResult: sendResult("p:0/abc-123", { guid: "p:0/abc-123", sentText: POLL_TEXT }),
        expected: {
          accountId: ACCOUNT_ID,
          to: HANDLE,
          conversation: { handle: HANDLE },
          messageId: "p:0/abc-123",
        },
      },
      {
        title: "refuses to bind when the bridge returns 'unknown' or 'ok' placeholders",
        sendResult: sendResult("ok", { sentText: POLL_TEXT }),
        expected: null,
      },
    ].forEach(({ title, sendResult: result, expected }) => {
      it(title, async () => {
        sendMock.sendMessageIMessage.mockResolvedValue(result);

        await expect(deliverBase()).resolves.toEqual(expected);
      });
    });
  });

  it("preserves group chat targets when preparing delivery", async () => {
    await expect(
      prepareTarget("chat_guid:iMessage;+;chat42", ACCOUNT_ID, "approver-dm"),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "chat_guid:iMessage;+;chat42",
        accountId: "default",
      },
    });
  });

  it("keeps manual commands but omits tapback instructions from the poll-mode prompt", async () => {
    // Bridge capability cannot prove the recipient's Apple client can render
    // polls, so the details message retains a complete manual fallback.
    const payload = await buildPendingPayload({
      request: execRequest("exec-omit"),
      approvalKind: "exec",
      view: execView("exec-omit", [
        { decision: "allow-once", label: "Allow Once", command: "/approve exec-omit allow-once" },
        { decision: "deny", label: "Deny", command: "/approve exec-omit deny" },
      ]),
    });

    expect(payload.pollText).toContain("/approve exec-omit allow-once");
    expect(payload.pollText).toContain("/approve exec-omit deny");
    expect(payload.pollText).not.toContain("React with:");
    expect(payload.pollText).toContain("Pending command:");
    expect(payload.pollText).toContain("Full id:");
    // The tapback-mode text is unchanged for hosts without poll support.
    expect(payload.text).toContain("👍 Allow Once");
  });

  it("carries the same bold headers and labels in tapback and poll mode", async () => {
    // #85954: poll mode used to fall back to the unstyled legacy prompt, so
    // every label reached Messages as flat text on any poll-capable bridge.
    const payload = await buildPendingPayload({
      request: execRequest("exec-bold"),
      approvalKind: "exec",
      view: execView(
        "exec-bold",
        [
          { decision: "allow-once", label: "Allow Once", command: "/approve exec-bold allow-once" },
          { decision: "deny", label: "Deny", command: "/approve exec-bold deny" },
        ],
        { host: "gateway", cwd: "/tmp/work", expiresAtMs: 60_000 },
      ),
    });

    for (const text of [payload.text, payload.pollText]) {
      expect(text).toContain("**Exec approval required**");
      expect(text).toContain("**ID:** exec-bold");
      expect(text).toContain("**Host:** gateway");
      expect(text).toContain("**CWD:**");
      expect(text).toContain("**Expires in:**");
      expect(text).toContain("**Full id:**");
    }
    // The poll owns the controls, so the tapback hint stays out of poll mode.
    expect(payload.text).toContain("React with:");
    expect(payload.pollText).not.toContain("React with:");
  });

  describe("native poll controls", () => {
    const pollDeliverArgs = {
      cfg: {
        channels: {
          imessage: { service: "imessage", allowFrom: ["+15551230000"] },
        },
      } as never,
      accountId: "default",
      context: { accountId: "default" },
      preparedTarget: { to: "+15551230000", accountId: "default" },
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: "+15551230000" },
      },
      request: execRequest("exec-poll"),
      approvalKind: "exec" as const,
      view: execView("exec-poll", [], { expiresAtMs: Date.now() + 60_000 }),
      pendingPayload: {
        text: "PROMPT WITH HINT\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\n/approve exec-poll allow-once\n/approve exec-poll deny",
        pollText: "PROMPT WITH COMMANDS\n\n/approve exec-poll allow-once\n/approve exec-poll deny",
        allowedDecisions: ["allow-once" as const, "deny" as const],
      },
    };

    type DeliverPendingArgs = Parameters<
      typeof imessageApprovalNativeRuntime.transport.deliverPending
    >[0];
    const deliverPoll = (overrides: Partial<DeliverPendingArgs> = {}) =>
      imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
        ...overrides,
      });
    const resolvePollVote = (params: {
      sender: string;
      participant: string;
      optionId: string;
      pollGuid: string;
    }) =>
      maybeResolveIMessageApprovalPollVote({
        cfg: pollDeliverArgs.cfg,
        accountId: ACCOUNT_ID,
        message: {
          sender: params.sender,
          chat_guid: CHAT_GUID,
          poll: {
            kind: "vote",
            original_guid: params.pollGuid,
            votes: [
              {
                option_id: params.optionId,
                participant: params.participant,
                event_type: "selected",
              },
            ],
          },
        } as never,
      });
    const updateEntry = (
      text: string,
      poll?: { pollGuid: string; optionDecisions: [[string, "allow-once"]] },
    ) =>
      imessageApprovalNativeRuntime.transport.updateEntry?.({
        cfg: {} as never,
        accountId: ACCOUNT_ID,
        context: { accountId: ACCOUNT_ID },
        entry: {
          accountId: ACCOUNT_ID,
          to: HANDLE,
          conversation: { chatIdentifier: CHAT_GUID },
          messageId: PROMPT_GUID,
          ...(poll ? { poll } : {}),
        },
        payload: { text },
        phase: "resolved",
      });

    beforeEach(() => {
      iMessageApprovalPollTargets.clearForTest();
      approvalGatewayMock.resolveApprovalOverGateway.mockReset();
      approvalGatewayMock.resolveApprovalOverGateway.mockResolvedValue({
        applied: true,
        approval: {},
      });
      sendMock.sendMessageIMessage.mockReset();
      sendMock.sendMessageIMessage.mockResolvedValue(
        sendResult(PROMPT_GUID, { guid: PROMPT_GUID, sentText: "PROMPT WITH COMMANDS" }),
      );
      probeMock.getCachedIMessagePrivateApiStatus.mockReset();
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(POLL_CAPABLE_STATUS);
      probeMock.probeIMessagePrivateApi.mockReset();
      actionsMock.sendPoll.mockReset();
      actionsMock.sendPoll.mockResolvedValue({
        messageId: POLL_GUID,
        pollOptions: [
          { id: "id-allow", text: "👍 Allow Once" },
          { id: "id-deny", text: "👎 Deny" },
        ],
      });
      actionsMock.resolveChatGuidForTarget.mockReset();
      actionsMock.resolveChatGuidForTarget.mockResolvedValue(CHAT_GUID);
      timersMock.delay.mockClear();
    });

    it("attests text fallback sends as host-originated, not delegated", async () => {
      // #99905: unstamped operations fail closed to "delegated". Approval
      // delivery targets come from approval routing/config, never model input,
      // so the send must carry its real authority.
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));

      await deliverPoll();
      for (const call of sendMock.sendMessageIMessage.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ conversationReadOrigin: "direct-operator" }),
        );
      }
    });

    it("sends approval details before a captionless poll", async () => {
      const entry = await deliverPoll();

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(1);
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.pollText,
        expect.objectContaining({ conversationReadOrigin: "direct-operator" }),
      );
      expect(sendMock.sendMessageIMessage.mock.calls[0]?.[2]).not.toHaveProperty("approvalPrompt");
      expect(actionsMock.sendPoll).toHaveBeenCalledWith(
        expect.objectContaining({
          chatGuid: "iMessage;-;+15551230000",
          question: pollDeliverArgs.pendingPayload.pollText,
          choices: ["👍 Allow Once", "👎 Deny"],
          suppressComment: true,
        }),
      );
      expect(actionsMock.sendPoll.mock.calls[0]?.[0]).not.toHaveProperty("replyToMessageId");
      expect(timersMock.delay).toHaveBeenCalledWith(1_100);
      expect(entry).toMatchObject({
        messageId: "prompt-guid",
        poll: { pollGuid: "poll-guid" },
      });
      expect(entry?.poll?.optionDecisions).toEqual([
        ["id-allow", "allow-once"],
        ["id-deny", "deny"],
      ]);
    });

    it("keeps markdown markers out of the poll question", async () => {
      // The details message is styled through attributedBody ranges, but
      // `imsg poll send --question` has no formatting channel, so the balloon
      // would otherwise show literal asterisks.
      const pollText = ["**Exec approval required**", "**ID:** exec-poll"].join("\n");
      await deliverPoll({
        pendingPayload: { ...pollDeliverArgs.pendingPayload, pollText },
      });

      // The send path converts the markers into typed ranges itself.
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollText,
        expect.objectContaining({ conversationReadOrigin: "direct-operator" }),
      );
      const question = actionsMock.sendPoll.mock.calls[0]?.[0]?.question;
      expect(question).toBe("Exec approval required\nID: exec-poll");
      expect(question).not.toContain("**");
    });

    it("binds the poll before deliverPending returns", async () => {
      await deliverPoll();

      await expect(
        resolvePollVote({
          sender: HANDLE,
          participant: HANDLE,
          optionId: "id-allow",
          pollGuid: POLL_GUID,
        }),
      ).resolves.toBe(true);
      expect(approvalGatewayMock.resolveApprovalOverGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "exec-poll",
          decision: "allow-once",
          channel: "imessage",
        }),
      );
    });

    it("does not recreate a poll target after an immediate vote resolves it", async () => {
      let immediateVote: Promise<boolean> | undefined;
      actionsMock.sendPoll.mockImplementationOnce(async () => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            immediateVote = resolvePollVote({
              sender: HANDLE,
              participant: HANDLE,
              optionId: "id-deny",
              pollGuid: POLL_GUID,
            });
          });
        });
        return {
          messageId: "poll-guid",
          pollOptions: [
            { id: "id-allow", text: "👍 Allow Once" },
            { id: "id-deny", text: "👎 Deny" },
          ],
        };
      });

      await deliverPoll();
      await vi.waitFor(() => expect(immediateVote).toBeDefined());
      await expect(immediateVote).resolves.toBe(true);

      await expect(
        resolvePollVote({
          sender: HANDLE,
          participant: HANDLE,
          optionId: "id-deny",
          pollGuid: POLL_GUID,
        }),
      ).resolves.toBe(true);
      expect(approvalGatewayMock.resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    });

    [
      {
        title: "keeps the tapback hint when the bridge has no poll selector",
        status: NO_POLL_SELECTOR_STATUS,
      },
      {
        title: "keeps text controls when imsg lacks caption suppression",
        status: {
          ...POLL_CAPABLE_STATUS,
          cliCapabilities: { pollSendSupportsNoComment: false },
        },
      },
      {
        title: "keeps text controls when the cached private bridge is unavailable",
        status: { ...POLL_CAPABLE_STATUS, available: false },
      },
      {
        title: "keeps text controls when polls are disabled in config",
        overrides: {
          cfg: {
            channels: { imessage: { actions: { polls: false }, allowFrom: [HANDLE] } },
          } as never,
        },
      },
      {
        title: "keeps explicit forwarding targets on the text approval path",
        overrides: {
          plannedTarget: {
            surface: "forward",
            reason: "preferred",
            target: { to: HANDLE },
          } as never,
        },
      },
      ...["sms:+15551230000", "chat_guid:SMS;-;+15551230000"].map((to) => ({
        title: `keeps non-iMessage target ${to} on the text approval path`,
        to,
        overrides: {
          preparedTarget: { to, accountId: ACCOUNT_ID },
          plannedTarget: { ...pollDeliverArgs.plannedTarget, target: { to } },
        },
      })),
    ].forEach((testCase) => {
      it(testCase.title, async () => {
        if ("status" in testCase && testCase.status) {
          probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(testCase.status);
        }

        const entry = await deliverPoll("overrides" in testCase ? testCase.overrides : undefined);
        const to = "to" in testCase ? testCase.to : HANDLE;

        expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
          to,
          pollDeliverArgs.pendingPayload.text,
          expect.anything(),
        );
        expect(actionsMock.sendPoll).not.toHaveBeenCalled();
        expect(entry?.poll).toBeUndefined();
      });
    });

    it("uses polls for an auto handle when the account does not force SMS", async () => {
      sendMock.sendMessageIMessage.mockResolvedValueOnce(
        sendResult(PROMPT_GUID, {
          guid: PROMPT_GUID,
          service: "imessage",
          chatGuid: CHAT_GUID,
          sentText: "PROMPT WITH HINT",
        }),
      );
      const entry = await deliverPoll({
        cfg: {
          channels: {
            imessage: { allowFrom: ["+15551230000"] },
          },
        } as never,
      });

      expect(actionsMock.resolveChatGuidForTarget).toHaveBeenCalled();
      expect(actionsMock.sendPoll).toHaveBeenCalled();
      expect(entry).toMatchObject({ poll: expect.anything(), reactionFallbackVisible: true });
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
    });

    it("resolves a chat_id before sending its native poll", async () => {
      const to = "chat_id:42";
      sendMock.sendMessageIMessage.mockResolvedValueOnce(
        sendResult(PROMPT_GUID, {
          guid: PROMPT_GUID,
          service: "imessage",
          chatGuid: "iMessage;+;chat42",
          sentText: "PROMPT WITH HINT",
        }),
      );
      const entry = await deliverPoll({
        preparedTarget: { to, accountId: "default" },
        plannedTarget: {
          ...pollDeliverArgs.plannedTarget,
          target: { to },
        },
      });

      expect(actionsMock.resolveChatGuidForTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "chat_id", chatId: 42 },
          conversationReadOrigin: "direct-operator",
        }),
      );
      expect(actionsMock.sendPoll).toHaveBeenCalled();
      expect(entry).toMatchObject({ poll: expect.anything(), reactionFallbackVisible: true });
    });

    it("keeps the original text controls when a chat_id send is confirmed as SMS", async () => {
      sendMock.sendMessageIMessage.mockResolvedValueOnce(
        sendResult(PROMPT_GUID, {
          guid: PROMPT_GUID,
          service: "sms",
          chatGuid: "SMS;-;+15551230000",
          sentText: "PROMPT WITH HINT",
        }),
      );
      const to = "chat_id:42";

      const entry = await deliverPoll({
        preparedTarget: { to, accountId: "default" },
        plannedTarget: {
          ...pollDeliverArgs.plannedTarget,
          target: { to },
        },
      });

      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(1);
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        to,
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
    });

    it("keeps text controls when no explicit approver can authorize a poll vote", async () => {
      const entry = await deliverPoll({
        cfg: { channels: { imessage: {} } } as never,
      });

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("never probes the bridge on the approval path", async () => {
      // A probe spawns imsg; putting it in front of an approval prompt would
      // add seconds of latency. Cold cache degrades to tapbacks instead.
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue(undefined);

      await deliverPoll();

      expect(probeMock.probeIMessagePrivateApi).not.toHaveBeenCalled();
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    });

    it("adds a threaded tapback hint when the chat is not registered with Messages", async () => {
      actionsMock.resolveChatGuidForTarget.mockResolvedValue(null);
      sendMock.sendMessageIMessage
        .mockResolvedValueOnce(sendResult(PROMPT_GUID, { guid: PROMPT_GUID }))
        .mockResolvedValueOnce(sendResult("hint-guid", { guid: "hint-guid" }));

      const entry = await deliverPoll();

      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(2);
      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        expect.stringContaining("👍 Allow Once"),
        expect.objectContaining({
          conversationReadOrigin: "direct-operator",
          replyToId: "prompt-guid",
        }),
      );
      expect(entry).toMatchObject({ messageId: "prompt-guid", hintMessageId: "hint-guid" });
    });

    it("keeps the tapback hint when fewer than two decisions are allowed", async () => {
      const entry = await deliverPoll({
        pendingPayload: { ...pollDeliverArgs.pendingPayload, allowedDecisions: ["allow-once"] },
      });

      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("restores the complete manual fallback when the poll send fails", async () => {
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));

      const entry = await deliverPoll();

      expect(entry?.poll).toBeUndefined();
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(2);
      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.objectContaining({
          approvalPrompt: {
            approvalId: "exec-poll",
            approvalKind: "exec",
            allowedDecisions: ["allow-once", "deny"],
          },
          replyToId: "prompt-guid",
        }),
      );
    });

    it("restores allow-always when poll delivery fails", async () => {
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));
      const fallbackText = `${pollDeliverArgs.pendingPayload.text}\n/approve exec-poll allow-always`;

      await deliverPoll({
        pendingPayload: {
          text: fallbackText,
          pollText:
            "PROMPT WITH COMMANDS\n/approve exec-poll allow-once\n/approve exec-poll allow-always\n/approve exec-poll deny",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
      });

      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        fallbackText,
        expect.objectContaining({ replyToId: "prompt-guid" }),
      );
    });

    it("uses both prompt and fallback GUIDs as reaction targets", async () => {
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));
      sendMock.sendMessageIMessage
        .mockResolvedValueOnce(sendResult(PROMPT_GUID, { guid: PROMPT_GUID }))
        .mockResolvedValueOnce(sendResult("fallback-guid", { guid: "fallback-guid" }));

      const entry = await deliverPoll();

      expect(entry).toMatchObject({
        messageId: "prompt-guid",
        hintMessageId: "fallback-guid",
      });
    });

    it("keeps manual controls when the approval prompt has no GUID", async () => {
      sendMock.sendMessageIMessage.mockResolvedValueOnce(sendResult("42"));

      const entry = await deliverPoll();

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(1);
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.pollText,
        expect.objectContaining({ conversationReadOrigin: "direct-operator" }),
      );
      expect(pollDeliverArgs.pendingPayload.pollText).toContain("/approve exec-poll allow-once");
      expect(pollDeliverArgs.pendingPayload.pollText).toContain("/approve exec-poll deny");
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry).toBeNull();
    });

    it("restores text controls when poll option metadata is incomplete", async () => {
      actionsMock.sendPoll.mockResolvedValue({
        messageId: "orphan-poll-guid",
        pollOptions: [],
      });

      const entry = await deliverPoll();

      expect(entry?.poll).toBeUndefined();
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(2);
      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.objectContaining({
          approvalPrompt: {
            approvalId: "exec-poll",
            approvalKind: "exec",
            allowedDecisions: ["allow-once", "deny"],
          },
          replyToId: "prompt-guid",
        }),
      );
    });

    it("attests resolved and expired threaded replies as host-originated", async () => {
      await updateEntry("Canonical result: Denied");

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        "Canonical result: Denied",
        expect.objectContaining({
          conversationReadOrigin: "direct-operator",
          replyToId: "prompt-guid",
        }),
      );
    });

    it("threads poll resolution updates to the verified approval prompt", async () => {
      await updateEntry("Canonical result: Allowed once", {
        pollGuid: "bridge-reported-guid",
        optionDecisions: [["id-allow", "allow-once"]],
      });

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        "Canonical result: Allowed once",
        expect.objectContaining({ replyToId: "prompt-guid" }),
      );
    });
  });
});
