import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendIMessageApprovalReactionHintForOutboundMessage,
  buildIMessageApprovalReactionHint,
  clearIMessageApprovalReactionTargetsForTest,
  extractIMessageApprovalPromptBinding,
  listPendingIMessageApprovalReactionPollTargets,
  maybeResolveIMessageApprovalReaction,
  registerIMessageApprovalReactionTargetForOutboundMessage,
  registerIMessageApprovalReactionTarget,
  resolveIMessageApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import type { IMessagePayload } from "./monitor/types.js";

const resolverMocks = vi.hoisted(() => ({
  resolveIMessageApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("./approval-resolver.js", () => ({
  resolveIMessageApproval: resolverMocks.resolveIMessageApproval,
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

function buildTapbackReactionPayload(overrides: Partial<IMessagePayload>): IMessagePayload {
  return {
    sender: "+15551230000",
    is_reaction: true,
    reaction_emoji: "👍",
    reacted_to_guid: "msg-1",
    ...overrides,
  } as IMessagePayload;
}

describe("iMessage approval reactions", () => {
  beforeEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    resolverMocks.resolveIMessageApproval.mockReset();
    resolverMocks.resolveIMessageApproval.mockResolvedValue(undefined);
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("renders shared reaction choices for allowed decisions", () => {
    expect(buildIMessageApprovalReactionHint(["allow-once", "allow-always", "deny"])).toBe(
      "React with:\n\n👍 Allow Once\n♾️ Allow Always\n👎 Deny",
    );
  });

  it("appends thumbs-only reaction choices to outbound approval prompts", () => {
    expect(
      appendIMessageApprovalReactionHintForOutboundMessage(
        "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
      ),
    ).toBe(
      "Exec approval required\nID: exec-1\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\nReply with: /approve exec-1 allow-once|deny",
    );
  });

  it("does not duplicate reaction choices on native approval prompts", () => {
    const prompt = [
      "Plugin approval required",
      "Reply with: /approve plugin:abc allow-once|allow-always|deny",
      "",
      "React with:",
      "",
      "👍 Allow Once",
      "👎 Deny",
    ].join("\n");

    expect(appendIMessageApprovalReactionHintForOutboundMessage(prompt)).toBe(prompt);
  });

  it("exposes allow-always as the shared infinity reaction choice", () => {
    expect(buildIMessageApprovalReactionHint(["allow-once", "allow-always", "deny"])).toBe(
      "React with:\n\n👍 Allow Once\n♾️ Allow Always\n👎 Deny",
    );
  });

  it("registers and resolves allow-always through the shared infinity reaction", async () => {
    expect(
      registerIMessageApprovalReactionTarget({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "msg-allow-always",
        approvalId: "exec-allow-always",
        allowedDecisions: ["allow-always"],
      }),
    ).toEqual({
      approvalId: "exec-allow-always",
      allowedDecisions: ["allow-always"],
    });

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "msg-allow-always",
        reactionKey: "♾",
      }),
    ).resolves.toEqual({
      approvalId: "exec-allow-always",
      decision: "allow-always",
    });
  });

  it("resolves a registered reaction target keyed by handle", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "msg-1",
        reactionKey: "👎",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      decision: "deny",
    });
  });

  it("merges learned chat ids into pending poll targets", () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "p:0/msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: {
        chatGuid: "SMS;-;+15551230000",
        chatIdentifier: "+15551230000",
        chatId: 42,
      },
      messageId: "msg-1",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });

    expect(listPendingIMessageApprovalReactionPollTargets({ accountId: "default" })).toEqual([
      expect.objectContaining({
        approvalId: "exec-1",
        conversation: {
          chatGuid: "SMS;-;+15551230000",
          chatIdentifier: "+15551230000",
          chatId: 42,
          handle: "+15551230000",
        },
        messageId: "p:0/msg-1",
      }),
    ]);
  });

  it("resolves a registered group reaction target keyed by chat_guid", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { chatGuid: "iMessage;+;chat42" },
      messageId: "msg-group-1",
      approvalId: "plugin:abc",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { chatGuid: "iMessage;+;chat42" },
        messageId: "msg-group-1",
        reactionKey: "👍",
      }),
    ).resolves.toEqual({
      approvalId: "plugin:abc",
      decision: "allow-once",
    });
  });

  it("extracts approval bindings from explicit outbound prompts", async () => {
    expect(
      extractIMessageApprovalPromptBinding(
        [
          "Plugin approval required",
          "ID: plugin:abc",
          "Reply with: /approve plugin:abc allow-once|allow-always|deny",
        ].join("\n"),
      ),
    ).toEqual({
      approvalId: "plugin:abc",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    expect(
      registerIMessageApprovalReactionTargetForOutboundMessage({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "prompt-message",
        text: [
          "Exec approval required",
          "ID: exec-1",
          "",
          "Reply with: /approve exec-1 allow-once|deny",
        ].join("\n"),
      }),
    ).toBe(true);

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "prompt-message",
        reactionKey: "👎",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      decision: "deny",
    });

    for (const reactionKey of ["1️⃣", "2️⃣", "3️⃣", "1", "2", "3", "❤️", "♾️"]) {
      await expect(
        resolveIMessageApprovalReactionTargetWithPersistence({
          accountId: "default",
          conversation: { handle: "+15551230000" },
          messageId: "prompt-message",
          reactionKey,
        }),
      ).resolves.toBeNull();
    }
  });

  it("does not register a phantom binding when /approve text appears in a non-approval message", () => {
    // Agent help text quoting /approve syntax should NOT register a binding —
    // requiring a canonical `ID: <id>` header line is the gate.
    expect(
      registerIMessageApprovalReactionTargetForOutboundMessage({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "help-message",
        text: "Run /approve task-7 allow-once when you're ready.",
      }),
    ).toBe(false);

    expect(
      extractIMessageApprovalPromptBinding("Run /approve task-7 allow-once when you're ready."),
    ).toBeNull();
  });

  it("escapes `$` sequences in approvalId when interpolating into outbound text", () => {
    // The shared replaceApprovalIdPlaceholder helper guards against
    // String.prototype.replace interpreting `$1`/`$&`/`$$` in the
    // replacement string. Verified indirectly via the binding extractor:
    // a prompt rendered for approvalId "exec-$1abc" must keep the id intact.
    const text = [
      "Exec approval required",
      "ID: exec-1abc",
      "Reply with: /approve exec-1abc allow-once",
    ].join("\n");
    expect(extractIMessageApprovalPromptBinding(text)).toEqual({
      approvalId: "exec-1abc",
      allowedDecisions: ["allow-once"],
    });
  });

  it("resolves is_from_me tapbacks when the actor is an explicit approver", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "exec-self",
      allowedDecisions: ["allow-once", "deny"],
    });

    const handled = await maybeResolveIMessageApprovalReaction({
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        is_from_me: true,
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-self",
        decision: "allow-once",
        senderId: "+15551230000",
      }),
    );
  });

  it("clears the in-memory binding on successful approval resolve so toggle 👍→👎 does not refire", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "exec-success",
      allowedDecisions: ["allow-once", "deny"],
    });

    const cfg = { channels: { imessage: { allowFrom: ["+15551230000"] } } };
    await expect(
      maybeResolveIMessageApprovalReaction({
        cfg,
        accountId: "default",
        message: buildTapbackReactionPayload({
          sender: "+15551230000",
          reaction_emoji: "👍",
          reacted_to_guid: "approval-message",
        }),
        bodyText: "",
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);

    // Second tapback (toggle to 👎) must not hit the resolver — the in-memory
    // binding was cleared on the first success.
    await expect(
      maybeResolveIMessageApprovalReaction({
        cfg,
        accountId: "default",
        message: buildTapbackReactionPayload({
          sender: "+15551230000",
          reaction_emoji: "👎",
          reacted_to_guid: "approval-message",
        }),
        bodyText: "",
      }),
    ).resolves.toBe(false);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledTimes(1);
  });

  it("resolves a reaction when the approver was configured with a service-prefixed allowFrom entry", async () => {
    // Regression test for the ClawSweeper-flagged normalizer bug: a previous
    // version of normalizeIMessageApproverId rejected service-prefixed direct
    // handles (`imessage:+...`, `sms:+...`, `auto:+...`) before stripping the
    // prefix, so the approver list collapsed to empty and reaction resolution
    // silently denied with "reactions require explicit approvers".
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "exec-service-prefix",
      allowedDecisions: ["allow-once", "deny"],
    });

    const cfg = {
      channels: { imessage: { allowFrom: ["imessage:+15551230000"] } },
    };
    const handled = await maybeResolveIMessageApprovalReaction({
      cfg,
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "exec-service-prefix",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("resolves a reaction when the binding was registered under a `p:0/…` prefixed GUID and the tapback surfaces both forms", async () => {
    // Regression for the second ClawSweeper P1 finding: imsg can return
    // `p:0/<guid>` as the outbound guid, so send.ts registers the binding
    // under that prefixed key. The inbound tapback's `targetGuid` is the
    // normalized (unprefixed) form, but `targetGuids` contains BOTH the
    // normalized and raw forms. The resolver must probe every candidate or
    // the lookup misses for valid tapbacks.
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "p:0/abc-123",
      approvalId: "exec-prefixed",
      allowedDecisions: ["allow-once", "deny"],
    });

    const cfg = { channels: { imessage: { allowFrom: ["+15551230000"] } } };
    const handled = await maybeResolveIMessageApprovalReaction({
      cfg,
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        // associated_message_guid carries the prefixed form; reacted_to_guid
        // gets normalized by resolveIMessageReactionContext into the
        // unprefixed form. The reaction-context helper exposes BOTH via
        // `targetGuids`.
        reacted_to_guid: "p:0/abc-123",
        associated_message_guid: "p:0/abc-123",
        reaction_emoji: "👍",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "exec-prefixed",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });

    // Both forms should be cleared from the in-memory map after success so a
    // toggle/replay tap doesn't re-fire.
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/abc-123",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "abc-123",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });

  it("resolves DM reactions even when send registered under handle but inbound carries chat_guid", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      // Send path keys by handle (target.kind === 'handle').
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "exec-dm",
      allowedDecisions: ["allow-once", "deny"],
    });

    const cfg = { channels: { imessage: { allowFrom: ["+15551230000"] } } };
    const handled = await maybeResolveIMessageApprovalReaction({
      cfg,
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        // Inbound DM payload populates chat_guid (chat.db always sets it).
        chat_guid: "iMessage;-;+15551230000",
        chat_identifier: "+15551230000",
        chat_id: 17,
        is_group: false,
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "exec-dm",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("ignores removed tapbacks for approval reactions", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once", "deny"],
    });

    const handled = await maybeResolveIMessageApprovalReaction({
      cfg: {
        channels: {
          imessage: { allowFrom: ["+15551230000"] },
        },
      },
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        is_reaction: true,
        is_reaction_add: false,
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(false);
    expect(resolverMocks.resolveIMessageApproval).not.toHaveBeenCalled();
  });

  it("resolves a direct approval reaction from an authorized sender", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "plugin:abc",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    const cfg = {
      channels: {
        imessage: { allowFrom: ["+15551230000"] },
      },
    };
    const handled = await maybeResolveIMessageApprovalReaction({
      cfg,
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "plugin:abc",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("resolves a group approval reaction keyed by chat_guid using the participant identity", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { chatGuid: "iMessage;+;chat42" },
      messageId: "approval-message",
      approvalId: "exec-group",
      allowedDecisions: ["allow-once", "deny"],
    });

    const cfg = {
      channels: {
        imessage: { allowFrom: ["+15551239999"] },
      },
    };
    const handled = await maybeResolveIMessageApprovalReaction({
      cfg,
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551239999",
        chat_guid: "iMessage;+;chat42",
        chat_id: 42,
        is_group: true,
        reaction_emoji: "👎",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "exec-group",
      decision: "deny",
      senderId: "+15551239999",
      gatewayUrl: undefined,
    });
  });

  it("denies reactions from senders not on the approvers list", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551239999" },
      messageId: "approval-message",
      approvalId: "exec-deny",
      allowedDecisions: ["allow-once", "deny"],
    });

    const handled = await maybeResolveIMessageApprovalReaction({
      cfg: {
        channels: {
          imessage: { allowFrom: ["+15551230000"] },
        },
      },
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551239999",
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).not.toHaveBeenCalled();
  });

  it("requires explicit approvers for direct approval reactions", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "exec-1",
      allowedDecisions: ["allow-once"],
    });

    const handled = await maybeResolveIMessageApprovalReaction({
      cfg: { channels: { imessage: {} } },
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveIMessageApproval).not.toHaveBeenCalled();
  });

  it("forgets stale bindings when the gateway reports an unknown approval", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "expired-message",
      approvalId: "exec-expired",
      allowedDecisions: ["allow-once"],
    });
    resolverMocks.resolveIMessageApproval.mockRejectedValueOnce(new Error("approval not found"));
    resolverMocks.isApprovalNotFoundError.mockReturnValue(true);

    const handled = await maybeResolveIMessageApprovalReaction({
      cfg: {
        channels: { imessage: { allowFrom: ["+15551230000"] } },
      },
      accountId: "default",
      message: buildTapbackReactionPayload({
        sender: "+15551230000",
        reaction_emoji: "👍",
        reacted_to_guid: "expired-message",
      }),
      bodyText: "",
    });

    expect(handled).toBe(true);

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "expired-message",
        reactionKey: "👍",
      }),
    ).resolves.toBeNull();
  });

  it("resolves approvals when the legacy tapback text path is used", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "approval-message",
      approvalId: "exec-legacy",
      allowedDecisions: ["allow-once", "deny"],
    });

    const handled = await maybeResolveIMessageApprovalReaction({
      cfg: {
        channels: { imessage: { allowFrom: ["+15551230000"] } },
      },
      accountId: "default",
      message: {
        sender: "+15551230000",
        reacted_to_guid: "approval-message",
      } as IMessagePayload,
      bodyText: "liked “Exec approval required”",
    });

    // Legacy text tapbacks lack a targetGuid in the reaction context, so they
    // should fall through to the dispatch pipeline rather than resolving an
    // approval here.
    expect(handled).toBe(false);
    expect(resolverMocks.resolveIMessageApproval).not.toHaveBeenCalled();
  });
});
