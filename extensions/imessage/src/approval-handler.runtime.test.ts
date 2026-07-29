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

const approvalResolverMock = vi.hoisted(() => ({
  resolveIMessageApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

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

vi.mock("./approval-resolver.js", () => approvalResolverMock);

describe("imessageApprovalNativeRuntime", () => {
  it("renders shared reactions in pending exec approvals", async () => {
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "exec-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "exec-1",
        commandText: "echo hi",
        actions: [
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
        ],
      } as never,
    });

    expect(payload.text).toContain("👍 Allow Once");
    expect(payload.text).toContain("👎 Deny");
    expect(payload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.text).not.toContain("3️⃣ Deny");
    expect(payload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("renders shared reactions in pending plugin approvals", async () => {
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
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
      nowMs: 0,
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
    await expect(
      imessageApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "ops",
        context: { accountId: "ops" },
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: {
            to: "+1 (555) 123-0000",
          },
        },
        request: {
          id: "exec-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: "exec-1",
          commandText: "echo hi",
          actions: [],
        } as never,
        pendingPayload: {
          text: "pending",
          pollText: "pending",
          allowedDecisions: ["allow-once"],
        },
      }),
    ).resolves.toEqual({
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
      approvalResolverMock.resolveIMessageApproval.mockReset();
      approvalResolverMock.resolveIMessageApproval.mockResolvedValue({
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
      accountId: "default",
      context: { accountId: "default" },
      preparedTarget: { to: "+15551230000", accountId: "default" },
      plannedTarget: {
        surface: "origin" as const,
        reason: "preferred" as const,
        target: { to: "+15551230000" },
      },
      request: {
        id: "exec-1",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec" as const,
      view: {
        approvalKind: "exec",
        approvalId: "exec-1",
        commandText: "echo hi",
        actions: [],
      } as never,
      pendingPayload: {
        text: "Reply with: /approve exec-1 allow-once",
        pollText: "Reply with: /approve exec-1 allow-once",
        allowedDecisions: ["allow-once" as const],
      },
    };

    it("refuses to bind when the bridge returns only a numeric ROWID", async () => {
      // Regression for ClawSweeper P1: native deliverPending must require a
      // GUID for the binding because inbound `reacted_to_guid` is always a
      // GUID — never the numeric ROWID. A bridge that returns just
      // { message_id: 12345 } has no usable approval-reaction id.
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "12345",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toBeNull();
    });

    it("binds against the GUID when the bridge returns one", async () => {
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "p:0/abc-123",
        guid: "p:0/abc-123",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toEqual({
        accountId: "default",
        to: "+15551230000",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/abc-123",
      });
    });

    it("refuses to bind when the bridge returns 'unknown' or 'ok' placeholders", async () => {
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "ok",
        sentText: "Reply with: /approve exec-1 allow-once",
        receipt: { kind: "text" } as never,
      });

      await expect(
        imessageApprovalNativeRuntime.transport.deliverPending(baseDeliverArgs),
      ).resolves.toBeNull();
    });
  });

  it("preserves group chat targets when preparing delivery", async () => {
    await expect(
      imessageApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "default",
        context: { accountId: "default" },
        plannedTarget: {
          surface: "approver-dm",
          reason: "preferred",
          target: {
            to: "chat_guid:iMessage;+;chat42",
          },
        },
        request: {
          id: "exec-1",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: "exec-1",
          commandText: "echo hi",
          actions: [],
        } as never,
        pendingPayload: {
          text: "pending",
          pollText: "pending",
          allowedDecisions: ["allow-once"],
        },
      }),
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
    const payload = await imessageApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "exec-omit",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "exec-omit",
        commandText: "echo hi",
        actions: [
          { decision: "allow-once", label: "Allow Once", command: "/approve exec-omit allow-once" },
          { decision: "deny", label: "Deny", command: "/approve exec-omit deny" },
        ],
      } as never,
    });

    expect(payload.pollText).toContain("/approve exec-omit allow-once");
    expect(payload.pollText).toContain("/approve exec-omit deny");
    expect(payload.pollText).not.toContain("React with:");
    expect(payload.pollText).toContain("Pending command:");
    expect(payload.pollText).toContain("Full id:");
    // The tapback-mode text is unchanged for hosts without poll support.
    expect(payload.text).toContain("👍 Allow Once");
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
      request: {
        id: "exec-poll",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec" as const,
      view: {
        approvalKind: "exec",
        approvalId: "exec-poll",
        commandText: "echo hi",
        actions: [],
        expiresAtMs: Date.now() + 60_000,
      } as never,
      pendingPayload: {
        text: [
          "PROMPT WITH HINT",
          "",
          "React with:",
          "",
          "👍 Allow Once",
          "👎 Deny",
          "",
          "/approve exec-poll allow-once",
          "/approve exec-poll deny",
        ].join("\n"),
        pollText: [
          "PROMPT WITH COMMANDS",
          "",
          "/approve exec-poll allow-once",
          "/approve exec-poll deny",
        ].join("\n"),
        allowedDecisions: ["allow-once" as const, "deny" as const],
      },
    };

    beforeEach(() => {
      iMessageApprovalPollTargets.clearForTest();
      approvalResolverMock.resolveIMessageApproval.mockReset();
      approvalResolverMock.resolveIMessageApproval.mockResolvedValue({
        applied: true,
        approval: {},
      });
      sendMock.sendMessageIMessage.mockReset();
      sendMock.sendMessageIMessage.mockResolvedValue({
        messageId: "prompt-guid",
        guid: "prompt-guid",
        sentText: "PROMPT WITH COMMANDS",
        receipt: { kind: "text" } as never,
      });
      probeMock.getCachedIMessagePrivateApiStatus.mockReset();
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        selectors: { pollPayloadMessage: true, retractMessagePart: true },
        rpcMethods: ["poll.send"],
        cliCapabilities: { pollSendSupportsNoComment: true },
      });
      probeMock.probeIMessagePrivateApi.mockReset();
      actionsMock.sendPoll.mockReset();
      actionsMock.sendPoll.mockResolvedValue({
        messageId: "poll-guid",
        pollOptions: [
          { id: "id-allow", text: "👍 Allow Once" },
          { id: "id-deny", text: "👎 Deny" },
        ],
      });
      actionsMock.resolveChatGuidForTarget.mockReset();
      actionsMock.resolveChatGuidForTarget.mockResolvedValue("iMessage;-;+15551230000");
      timersMock.delay.mockClear();
    });

    it("attests text fallback sends as host-originated, not delegated", async () => {
      // #99905: unstamped operations fail closed to "delegated". Approval
      // delivery targets come from approval routing/config, never model input,
      // so the send must carry its real authority.
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));

      await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);
      for (const call of sendMock.sendMessageIMessage.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ conversationReadOrigin: "direct-operator" }),
        );
      }
    });

    it("sends approval details before a captionless poll", async () => {
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(1);
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.pollText,
        expect.objectContaining({ conversationReadOrigin: "direct-operator" }),
      );
      expect(sendMock.sendMessageIMessage.mock.calls[0]?.[2]).not.toHaveProperty("approvalKind");
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

    it("binds the poll before deliverPending returns", async () => {
      await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      await expect(
        maybeResolveIMessageApprovalPollVote({
          cfg: pollDeliverArgs.cfg,
          accountId: "default",
          message: {
            sender: "+15551230000",
            chat_guid: "iMessage;-;+15551230000",
            poll: {
              kind: "vote",
              original_guid: "poll-guid",
              votes: [
                {
                  option_id: "id-allow",
                  participant: "+15551230000",
                  event_type: "selected",
                },
              ],
            },
          } as never,
        }),
      ).resolves.toBe(true);
      expect(approvalResolverMock.resolveIMessageApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "exec-poll",
          decision: "allow-once",
        }),
      );
    });

    it("does not recreate a poll target after an immediate vote resolves it", async () => {
      let immediateVote: Promise<boolean> | undefined;
      actionsMock.sendPoll.mockImplementationOnce(async () => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            immediateVote = maybeResolveIMessageApprovalPollVote({
              cfg: pollDeliverArgs.cfg,
              accountId: "default",
              message: {
                sender: "+15551230000",
                chat_guid: "iMessage;-;+15551230000",
                poll: {
                  kind: "vote",
                  original_guid: "poll-guid",
                  votes: [
                    {
                      option_id: "id-deny",
                      participant: "+15551230000",
                      event_type: "selected",
                    },
                  ],
                },
              } as never,
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

      await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);
      await vi.waitFor(() => expect(immediateVote).toBeDefined());
      await expect(immediateVote).resolves.toBe(true);

      await expect(
        maybeResolveIMessageApprovalPollVote({
          cfg: pollDeliverArgs.cfg,
          accountId: "default",
          message: {
            sender: "+15551230000",
            chat_guid: "iMessage;-;+15551230000",
            poll: {
              kind: "vote",
              original_guid: "poll-guid",
              votes: [
                {
                  option_id: "id-deny",
                  participant: "+15551230000",
                  event_type: "selected",
                },
              ],
            },
          } as never,
        }),
      ).resolves.toBe(true);
      expect(approvalResolverMock.resolveIMessageApproval).toHaveBeenCalledTimes(1);
    });

    it("keeps the tapback hint when the bridge has no poll selector", async () => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        selectors: {},
        rpcMethods: [],
      });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("keeps text controls when imsg lacks caption suppression", async () => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: true,
        selectors: { pollPayloadMessage: true, retractMessagePart: true },
        rpcMethods: ["poll.send"],
        cliCapabilities: { pollSendSupportsNoComment: false },
      });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("keeps text controls when the cached private bridge is unavailable", async () => {
      probeMock.getCachedIMessagePrivateApiStatus.mockReturnValue({
        available: false,
        selectors: { pollPayloadMessage: true, retractMessagePart: true },
        rpcMethods: ["poll.send"],
        cliCapabilities: { pollSendSupportsNoComment: true },
      });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("keeps text controls when polls are disabled in config", async () => {
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
        cfg: {
          channels: {
            imessage: { actions: { polls: false }, allowFrom: ["+15551230000"] },
          },
        } as never,
      });

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("keeps explicit forwarding targets on the text approval path", async () => {
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
        plannedTarget: {
          surface: "forward",
          reason: "preferred",
          target: { to: "+15551230000" },
        } as never,
      });

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.anything(),
      );
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it.each(["sms:+15551230000", "chat_guid:SMS;-;+15551230000"])(
      "keeps non-iMessage target %s on the text approval path",
      async (to) => {
        const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
          ...pollDeliverArgs,
          preparedTarget: { to, accountId: "default" },
          plannedTarget: {
            ...pollDeliverArgs.plannedTarget,
            target: { to },
          },
        });

        expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
          to,
          pollDeliverArgs.pendingPayload.text,
          expect.anything(),
        );
        expect(actionsMock.sendPoll).not.toHaveBeenCalled();
        expect(entry?.poll).toBeUndefined();
      },
    );

    it("uses polls for an auto handle when the account does not force SMS", async () => {
      sendMock.sendMessageIMessage.mockResolvedValueOnce({
        messageId: "prompt-guid",
        guid: "prompt-guid",
        service: "imessage",
        chatGuid: "iMessage;-;+15551230000",
        sentText: "PROMPT WITH HINT",
        receipt: { kind: "text" } as never,
      });
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
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
      sendMock.sendMessageIMessage.mockResolvedValueOnce({
        messageId: "prompt-guid",
        guid: "prompt-guid",
        service: "imessage",
        chatGuid: "iMessage;+;chat42",
        sentText: "PROMPT WITH HINT",
        receipt: { kind: "text" } as never,
      });
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
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
      sendMock.sendMessageIMessage.mockResolvedValueOnce({
        messageId: "prompt-guid",
        guid: "prompt-guid",
        service: "sms",
        chatGuid: "SMS;-;+15551230000",
        sentText: "PROMPT WITH HINT",
        receipt: { kind: "text" } as never,
      });
      const to = "chat_id:42";

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
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
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
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

      await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(probeMock.probeIMessagePrivateApi).not.toHaveBeenCalled();
      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    });

    it("adds a threaded tapback hint when the chat is not registered with Messages", async () => {
      actionsMock.resolveChatGuidForTarget.mockResolvedValue(null);
      sendMock.sendMessageIMessage
        .mockResolvedValueOnce({
          messageId: "prompt-guid",
          guid: "prompt-guid",
          receipt: { kind: "text" } as never,
        })
        .mockResolvedValueOnce({
          messageId: "hint-guid",
          guid: "hint-guid",
          receipt: { kind: "text" } as never,
        });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

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
      const entry = await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
        pendingPayload: { ...pollDeliverArgs.pendingPayload, allowedDecisions: ["allow-once"] },
      });

      expect(actionsMock.sendPoll).not.toHaveBeenCalled();
      expect(entry?.poll).toBeUndefined();
    });

    it("restores the complete manual fallback when the poll send fails", async () => {
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(entry?.poll).toBeUndefined();
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(2);
      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.objectContaining({
          approvalKind: "exec",
          replyToId: "prompt-guid",
        }),
      );
    });

    it("restores allow-always when poll delivery fails", async () => {
      actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));
      const fallbackText = [
        pollDeliverArgs.pendingPayload.text,
        "/approve exec-poll allow-always",
      ].join("\n");

      await imessageApprovalNativeRuntime.transport.deliverPending({
        ...pollDeliverArgs,
        pendingPayload: {
          text: fallbackText,
          pollText: [
            "PROMPT WITH COMMANDS",
            "/approve exec-poll allow-once",
            "/approve exec-poll allow-always",
            "/approve exec-poll deny",
          ].join("\n"),
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
        .mockResolvedValueOnce({
          messageId: "prompt-guid",
          guid: "prompt-guid",
          receipt: { kind: "text" } as never,
        })
        .mockResolvedValueOnce({
          messageId: "fallback-guid",
          guid: "fallback-guid",
          receipt: { kind: "text" } as never,
        });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(entry).toMatchObject({
        messageId: "prompt-guid",
        hintMessageId: "fallback-guid",
      });
    });

    it("keeps manual controls when the approval prompt has no GUID", async () => {
      sendMock.sendMessageIMessage.mockResolvedValueOnce({
        messageId: "42",
        receipt: { kind: "text" } as never,
      });

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

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

      const entry = await imessageApprovalNativeRuntime.transport.deliverPending(pollDeliverArgs);

      expect(entry?.poll).toBeUndefined();
      expect(sendMock.sendMessageIMessage).toHaveBeenCalledTimes(2);
      expect(sendMock.sendMessageIMessage).toHaveBeenLastCalledWith(
        "+15551230000",
        pollDeliverArgs.pendingPayload.text,
        expect.objectContaining({
          approvalKind: "exec",
          replyToId: "prompt-guid",
        }),
      );
    });

    it("attests resolved and expired threaded replies as host-originated", async () => {
      await imessageApprovalNativeRuntime.transport.updateEntry?.({
        cfg: {} as never,
        accountId: "default",
        context: { accountId: "default" },
        entry: {
          accountId: "default",
          to: "+15551230000",
          conversation: { chatIdentifier: "iMessage;-;+15551230000" },
          messageId: "prompt-guid",
        },
        payload: { text: "Canonical result: Denied" },
        phase: "resolved",
      });

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
      await imessageApprovalNativeRuntime.transport.updateEntry?.({
        cfg: {} as never,
        accountId: "default",
        context: { accountId: "default" },
        entry: {
          accountId: "default",
          to: "+15551230000",
          conversation: { chatIdentifier: "iMessage;-;+15551230000" },
          messageId: "prompt-guid",
          poll: {
            pollGuid: "bridge-reported-guid",
            optionDecisions: [["id-allow", "allow-once"]],
          },
        },
        payload: { text: "Canonical result: Allowed once" },
        phase: "resolved",
      });

      expect(sendMock.sendMessageIMessage).toHaveBeenCalledWith(
        "+15551230000",
        "Canonical result: Allowed once",
        expect.objectContaining({ replyToId: "prompt-guid" }),
      );
    });
  });
});
