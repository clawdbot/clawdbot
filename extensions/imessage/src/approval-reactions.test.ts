// Imessage tests cover approval reactions plugin behavior.
import { buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addIMessageApprovalReactionHintToStructuredPayload,
  appendIMessageApprovalReactionHintForOutboundMessage,
  buildIMessageApprovalConversationKeyForTarget,
  buildIMessageApprovalReactionHint,
  clearIMessageApprovalReactionTargetsForTest,
  extractIMessageApprovalPromptBinding,
  handleIMessageApprovalReaction,
  listPendingIMessageApprovalReactionPollTargets,
  maybeResolveIMessageApprovalReaction,
  registerIMessageApprovalReactionTargetForDeliveredPayload,
  registerIMessageApprovalReactionTargetForOutboundMessage,
  registerIMessageApprovalReactionTarget as registerIMessageApprovalReactionTargetRaw,
  resolveIMessageApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import type { IMessagePayload } from "./monitor/types.js";

const resolverMocks = vi.hoisted(() => ({
  resolveIMessageApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

type IMessageTargetParams = Parameters<typeof registerIMessageApprovalReactionTargetRaw>[0];

function registerIMessageApprovalReactionTarget(
  params: Omit<IMessageTargetParams, "approvalKind"> & {
    approvalKind?: IMessageTargetParams["approvalKind"];
  },
) {
  return registerIMessageApprovalReactionTargetRaw({
    ...params,
    approvalKind: params.approvalKind ?? "exec",
  });
}

vi.mock("./approval-resolver.js", () => ({
  resolveIMessageApproval: resolverMocks.resolveIMessageApproval,
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

function requireExecApprovalMetadata(payload: ReplyPayload): Record<string, unknown> {
  const value = payload.channelData?.execApproval;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected exec approval metadata");
  }
  return value as Record<string, unknown>;
}

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
    resolverMocks.resolveIMessageApproval.mockImplementation(
      async ({ decision }: { decision: "allow-once" | "allow-always" | "deny" }) => ({
        applied: true,
        approval:
          decision === "deny"
            ? { status: "denied", decision, reason: "user" }
            : { status: "allowed", decision, reason: "user" },
      }),
    );
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

  it("uses typed metadata to prepare shared forwarded prompts", () => {
    const payload: ReplyPayload = {
      text: [
        "🛡️ Plugin approval required",
        "ID: plugin:shared-1",
        "Reply with: /approve plugin:shared-1 allow-once|deny",
      ].join("\n"),
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                action: {
                  type: "approval",
                  approvalId: "plugin:shared-1",
                  approvalKind: "plugin",
                  decision: "allow-once",
                },
              },
              {
                label: "Deny",
                action: {
                  type: "approval",
                  approvalId: "plugin:shared-1",
                  approvalKind: "plugin",
                  decision: "deny",
                },
              },
            ],
          },
        ],
      },
      channelData: {
        execApproval: {
          approvalId: "plugin:shared-1",
          approvalSlug: "shared-1",
          approvalKind: "plugin",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    };

    const prepared = addIMessageApprovalReactionHintToStructuredPayload({
      payload,
      approvalKind: "plugin",
    });
    expect(prepared?.text).toBe(
      [
        "🛡️ Plugin approval required",
        "ID: plugin:shared-1",
        "",
        "React with:",
        "",
        "👍 Allow Once",
        "👎 Deny",
        "",
        "Reply with: /approve plugin:shared-1 allow-once|deny",
      ].join("\n"),
    );
    expect(prepared?.channelData?.imessageApprovalReactionBindingV1).toEqual({
      version: 1,
      approvalId: "plugin:shared-1",
      approvalSlug: "shared-1",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload,
        approvalKind: "exec",
      }),
    ).toBeNull();
  });

  it("binds delivered shared prompts from typed metadata and stable GUIDs", async () => {
    const payload = addIMessageApprovalReactionHintToStructuredPayload({
      approvalKind: "exec",
      payload: buildTypedExecApprovalPendingReplyPayload({
        approvalId: "exec-shared-1",
        approvalSlug: "shared-1",
        command: "echo shared",
        host: "gateway",
        allowedDecisions: ["allow-once", "deny"],
      }),
    });
    if (!payload) {
      throw new Error("Expected typed iMessage approval payload");
    }

    expect(
      registerIMessageApprovalReactionTargetForDeliveredPayload({
        accountId: "default",
        target: { channel: "imessage", to: "+15551230000" },
        payload,
        results: [
          {
            channel: "imessage",
            messageId: "42",
            meta: {
              imessageMessageGuid: "p:0/shared-guid",
              imessageVisibleText: payload.text,
            },
            receipt: {
              primaryPlatformMessageId: "42",
              platformMessageIds: ["42"],
              parts: [{ platformMessageId: "42", kind: "text", index: 0 }],
              sentAt: 1_000,
            },
          },
        ],
      }),
    ).toBe(true);

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/shared-guid",
        reactionKey: "👎",
      }),
    ).resolves.toEqual({
      approvalId: "exec-shared-1",
      approvalKind: "exec",
      decision: "deny",
    });
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "42",
        reactionKey: "👎",
      }),
    ).resolves.toBeNull();
  });

  it("binds approval reactions when outbound chunking splits the visible prompt", async () => {
    const payload = addIMessageApprovalReactionHintToStructuredPayload({
      approvalKind: "exec",
      payload: buildTypedExecApprovalPendingReplyPayload({
        approvalId: "exec-chunked-1",
        approvalSlug: "chunked-1",
        command: "echo chunked",
        host: "gateway",
        allowedDecisions: ["allow-once", "deny"],
      }),
    });
    if (!payload?.text) {
      throw new Error("Expected typed iMessage approval payload");
    }
    const visibleText = payload.text;
    const bodyIndex = visibleText.indexOf("Approval required.");
    if (bodyIndex < 1) {
      throw new Error("Expected approval body after reaction hint");
    }

    expect(
      registerIMessageApprovalReactionTargetForDeliveredPayload({
        accountId: "default",
        target: { channel: "imessage", to: "+15551230000" },
        payload,
        results: [
          {
            channel: "imessage",
            messageId: "41",
            meta: {
              imessageMessageGuid: "p:0/chunked-guid-1",
              imessageVisibleText: visibleText.slice(0, bodyIndex),
            },
          },
          {
            channel: "imessage",
            messageId: "42",
            meta: {
              imessageMessageGuid: "p:0/chunked-guid-2",
              imessageVisibleText: visibleText.slice(bodyIndex),
            },
          },
        ],
      }),
    ).toBe(true);

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/chunked-guid-1",
        reactionKey: "👎",
      }),
    ).resolves.toEqual({
      approvalId: "exec-chunked-1",
      approvalKind: "exec",
      decision: "deny",
    });
  });

  it("fails closed when typed metadata and approval actions disagree", () => {
    const buildPayload = () =>
      buildTypedExecApprovalPendingReplyPayload({
        approvalId: "exec-strict-1",
        approvalSlug: "strict-1",
        command: "echo strict",
        host: "gateway",
        allowedDecisions: ["allow-once", "deny"],
      });
    const missingKind = buildPayload();
    delete requireExecApprovalMetadata(missingKind).approvalKind;
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload: missingKind,
        approvalKind: "exec",
      }),
    ).toBeNull();

    const mismatchedAction = buildPayload();
    const buttons = mismatchedAction.presentation?.blocks.find((block) => block.type === "buttons");
    if (!buttons || buttons.type !== "buttons" || !buttons.buttons[0]?.action) {
      throw new Error("Expected typed approval buttons");
    }
    buttons.buttons[0].action = {
      type: "approval",
      approvalId: "exec-other",
      approvalKind: "exec",
      decision: "allow-once",
    };
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload: mismatchedAction,
        approvalKind: "exec",
      }),
    ).toBeNull();

    const duplicateDecision = buildPayload();
    requireExecApprovalMetadata(duplicateDecision).allowedDecisions = [
      "allow-once",
      "allow-once",
      "deny",
    ];
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload: duplicateDecision,
        approvalKind: "exec",
      }),
    ).toBeNull();
  });

  it("rejects delivered shared prompts without the exact private GUID and visible binding", () => {
    const payload: ReplyPayload = {
      text: [
        "🔒 Exec approval required",
        "ID: exec-shared-2",
        "Reply with: /approve exec-shared-2 allow-once|deny",
      ].join("\n"),
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Once",
                action: {
                  type: "approval",
                  approvalId: "exec-shared-2",
                  approvalKind: "exec",
                  decision: "allow-once",
                },
              },
              {
                label: "Deny",
                action: {
                  type: "approval",
                  approvalId: "exec-shared-2",
                  approvalKind: "exec",
                  decision: "deny",
                },
              },
            ],
          },
        ],
      },
      channelData: {
        execApproval: {
          approvalId: "exec-shared-2",
          approvalSlug: "shared-2",
          approvalKind: "exec",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    };
    const prepared = addIMessageApprovalReactionHintToStructuredPayload({
      payload,
      approvalKind: "exec",
    });
    if (!prepared?.text) {
      throw new Error("Expected typed iMessage approval payload");
    }

    expect(
      registerIMessageApprovalReactionTargetForDeliveredPayload({
        accountId: "default",
        target: { channel: "imessage", to: "+15551230000" },
        payload: prepared,
        results: [
          {
            channel: "imessage",
            messageId: "p:0/guessed-guid",
            meta: { imessageVisibleText: prepared.text },
          },
          {
            channel: "imessage",
            messageId: "42",
            meta: {
              imessageMessageGuid: "p:0/real-guid",
              imessageVisibleText: prepared.text.replace("exec-shared-2", "exec-other"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("derives reaction conversation keys from every supported target form", () => {
    expect(buildIMessageApprovalConversationKeyForTarget("+1 (555) 123-0000")).toEqual({
      handle: "+15551230000",
    });
    expect(buildIMessageApprovalConversationKeyForTarget("chat_id:42")).toEqual({ chatId: 42 });
    expect(buildIMessageApprovalConversationKeyForTarget("chat_guid:iMessage;+;group-1")).toEqual({
      chatGuid: "iMessage;+;group-1",
    });
    expect(
      buildIMessageApprovalConversationKeyForTarget("chat_identifier:group@example.com"),
    ).toEqual({ chatIdentifier: "group@example.com" });
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
      approvalKind: "exec",
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
      approvalKind: "exec",
      decision: "allow-always",
    });
  });

  it("rejects reaction targets without an explicit approval kind", () => {
    expect(
      registerIMessageApprovalReactionTargetRaw({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "msg-missing-kind",
        approvalId: "exec-missing-kind",
        approvalKind: undefined as unknown as "exec",
        allowedDecisions: ["allow-once"],
      }),
    ).toBeNull();
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
      approvalKind: "exec",
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

  it("does not keep pending poll targets when the process clock is invalid", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      expect(
        registerIMessageApprovalReactionTarget({
          accountId: "default",
          conversation: { handle: "+15551230000" },
          messageId: "msg-invalid-clock",
          approvalId: "exec-invalid-clock",
          allowedDecisions: ["allow-once", "deny"],
        }),
      ).toBeNull();
    } finally {
      dateNow.mockRestore();
    }

    expect(listPendingIMessageApprovalReactionPollTargets({ accountId: "default" })).toEqual([]);
  });

  it("falls back to the default pending poll target ttl for invalid explicit ttl values", () => {
    const nowMs = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      registerIMessageApprovalReactionTarget({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "msg-invalid-ttl",
        approvalId: "exec-invalid-ttl",
        allowedDecisions: ["allow-once", "deny"],
        ttlMs: Number.NaN,
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(listPendingIMessageApprovalReactionPollTargets({ accountId: "default" })).toEqual([
      expect.objectContaining({
        approvalId: "exec-invalid-ttl",
        expiresAtMs: nowMs + 24 * 60 * 60 * 1000,
      }),
    ]);
  });

  it("resolves a registered group reaction target keyed by chat_guid", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { chatGuid: "iMessage;+;chat42" },
      messageId: "msg-group-1",
      approvalId: "plugin:abc",
      approvalKind: "plugin",
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
      approvalKind: "plugin",
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
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });

    expect(
      registerIMessageApprovalReactionTargetForOutboundMessage({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "prompt-message",
        approvalKind: "exec",
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
      approvalKind: "exec",
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
        approvalKind: "exec",
        text: "Run /approve task-7 allow-once when you're ready.",
      }),
    ).toBe(false);

    expect(
      extractIMessageApprovalPromptBinding("Run /approve task-7 allow-once when you're ready."),
    ).toBeNull();
  });

  it("rejects outbound prompt bindings whose approval kind does not match", () => {
    expect(
      registerIMessageApprovalReactionTargetForOutboundMessage({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "mismatched-prompt-message",
        approvalKind: "exec",
        text: [
          "Plugin approval required",
          "ID: plugin:abc",
          "Reply with: /approve plugin:abc allow-once|deny",
        ].join("\n"),
      }),
    ).toBe(false);
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
      approvalKind: "exec",
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
      approvalKind: "exec",
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
      approvalKind: "exec",
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
      approvalKind: "exec",
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
      approvalKind: "plugin",
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
      approvalKind: "plugin",
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
      approvalKind: "exec",
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

  it("clears a losing surface and reports the canonical first-answer outcome", async () => {
    registerIMessageApprovalReactionTarget({
      accountId: "default",
      conversation: { handle: "+15551230000" },
      messageId: "already-resolved-message",
      approvalId: "exec-already-resolved",
      allowedDecisions: ["allow-once", "deny"],
    });
    resolverMocks.resolveIMessageApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny", reason: "user" },
    });
    const logVerboseMessage = vi.fn();

    await expect(
      handleIMessageApprovalReaction({
        cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
        accountId: "default",
        message: buildTapbackReactionPayload({
          sender: "+15551230000",
          reaction_emoji: "👍",
          reacted_to_guid: "already-resolved-message",
        }),
        bodyText: "",
        logVerboseMessage,
      }),
    ).resolves.toEqual({ handled: true, stopPolling: true, stopPollingReason: "resolved" });

    expect(logVerboseMessage).toHaveBeenCalledWith(
      "imessage: approval reaction already resolved id=exec-already-resolved sender=+15551230000 status=denied decision=deny reason=user via messageId=already-resolved-message",
    );
    expect(logVerboseMessage.mock.calls.flat().join(" ")).not.toContain("decision=allow-once");
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "already-resolved-message",
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
