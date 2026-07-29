import {
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
// Signal tests cover approval reactions plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSignalApprovalReactionHintToText,
  addSignalApprovalReactionHintToStructuredPayload,
  buildSignalApprovalReactionHint,
  clearSignalApprovalReactionTargetsForTest,
  maybeResolveSignalApprovalReaction,
  registerSignalApprovalReactionTargetForDeliveredPayload,
  registerSignalApprovalReactionTarget,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";

const resolverMocks = vi.hoisted(() => ({
  resolveSignalApproval: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("./approval-resolver.js", () => ({
  resolveSignalApproval: resolverMocks.resolveSignalApproval,
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

const approvalRoute = {
  deliveryMode: "session" as const,
  agentId: "main",
  sessionKey: "agent:main:signal:direct:+15551230000",
};

describe("Signal approval reactions", () => {
  beforeEach(() => {
    clearSignalApprovalReactionTargetsForTest();
    resolverMocks.resolveSignalApproval.mockReset();
    resolverMocks.resolveSignalApproval.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("renders thumbs-only reaction choices for allowed decisions", () => {
    expect(buildSignalApprovalReactionHint(["allow-once", "deny"])).toBe(
      "React with:\n\n👍 Allow Once\n👎 Deny",
    );
  });

  it("exposes allow-always as a reaction choice when allowed", () => {
    expect(buildSignalApprovalReactionHint(["allow-once", "allow-always", "deny"])).toBe(
      "React with:\n\n👍 Allow Once\n♾️ Allow Always\n👎 Deny",
    );
  });

  it("appends thumbs-only reaction choices to outbound approval prompts", () => {
    expect(
      addSignalApprovalReactionHintToText({
        text: "Exec approval required\nID: exec-1\n\nReply with: /approve exec-1 allow-once|deny",
        allowedDecisions: ["allow-once", "deny"],
      }),
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

    expect(
      addSignalApprovalReactionHintToText({
        text: prompt,
        allowedDecisions: ["allow-once", "deny"],
      }),
    ).toBe(prompt);
  });

  it("registers delivered structured approval payloads for reactions", async () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    };
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-structured-approval",
      approvalSlug: "exec-str",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    const deliveredPayload = addSignalApprovalReactionHintToStructuredPayload({
      cfg,
      accountId: "default",
      to: "+15551230000",
      payload,
      targetAuthor: "+15550009999",
    });

    expect(
      registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: {
          channel: "signal",
          to: "+15551230000",
          accountId: "default",
        },
        payload: deliveredPayload!,
        results: [
          {
            channel: "signal",
            messageId: "1700000000012",
            toJid: "+15551230000",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(true);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000012",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toEqual({
      approvalId: "exec-structured-approval",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: "+15551230000",
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15551230000",
      },
    });
  });

  it("does not register metadata-only approval payloads without visible reaction hints", async () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    };
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-hidden-reaction",
      approvalSlug: "exec-hid",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf hidden",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });

    expect(
      registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: {
          channel: "signal",
          to: "+15551230000",
          accountId: "default",
        },
        payload,
        results: [
          {
            channel: "signal",
            messageId: "1700000000015",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(false);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000015",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBeNull();
  });

  it("registers only delivered chunks that contain visible reaction hints", async () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        exec: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    };
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-chunked-reaction",
      approvalSlug: "exec-ch",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf chunked",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    const deliveredPayload = addSignalApprovalReactionHintToStructuredPayload({
      cfg,
      accountId: "default",
      to: "+15551230000",
      payload,
      targetAuthor: "+15550009999",
    });

    expect(
      registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: {
          channel: "signal",
          to: "+15551230000",
          accountId: "default",
        },
        payload: deliveredPayload!,
        results: [
          {
            channel: "signal",
            messageId: "1700000000016",
            meta: {
              signalVisibleText: "Exec approval required\n\nReact with:\n\n👍 Allow Once\n👎 Deny",
            },
          },
          {
            channel: "signal",
            messageId: "1700000000017",
            meta: {
              signalVisibleText: "Continuation chunk without controls",
            },
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(true);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000016",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toMatchObject({
      approvalId: "exec-chunked-reaction",
      decision: "allow-once",
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000017",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBeNull();
  });

  it("registers delivered structured plugin approval payloads using metadata kind", async () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: ["+15551230000"],
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "+15551230000" }],
        },
      },
    };
    const payload = buildPluginApprovalPendingReplyPayload({
      request: {
        id: "plugin-structured-approval",
        request: {
          title: "Sensitive plugin action",
          description: "Needs approval",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      nowMs: 1_000,
    });
    const deliveredPayload = addSignalApprovalReactionHintToStructuredPayload({
      cfg,
      accountId: "default",
      to: "+15551230000",
      payload,
      targetAuthor: "+15550009999",
    });

    expect(
      registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: {
          channel: "signal",
          to: "+15551230000",
          accountId: "default",
        },
        payload: deliveredPayload!,
        results: [
          {
            channel: "signal",
            messageId: "1700000000013",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(true);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000013",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toMatchObject({
      approvalId: "plugin-structured-approval",
      approvalKind: "plugin",
      decision: "allow-once",
    });
  });

  it("registers alias-configured delivered prompts under the canonical target", async () => {
    const cfg = {
      channels: {
        signal: {
          allowFrom: ["+15551230000"],
          aliases: {
            me: "+15551230000",
          },
        },
      },
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets" as const,
          targets: [{ channel: "signal", to: "signal:me" }],
        },
      },
    };
    const payload = buildPluginApprovalPendingReplyPayload({
      request: {
        id: "plugin:abc",
        request: {
          title: "Sensitive plugin action",
          description: "Needs approval",
          allowedDecisions: ["allow-once", "deny"],
          pluginId: "demo",
          toolName: "dangerousTool",
          agentId: "main",
          sessionKey: "agent:main:signal:direct:+15551230000",
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      nowMs: 1_000,
    });
    const deliveredPayload = addSignalApprovalReactionHintToStructuredPayload({
      cfg,
      accountId: "default",
      to: "+15551230000",
      payload,
      targetAuthor: "+15550009999",
    });

    expect(deliveredPayload?.text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    expect(
      registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg,
        target: {
          channel: "signal",
          to: "+15551230000",
          accountId: "default",
        },
        payload: deliveredPayload!,
        results: [
          {
            channel: "signal",
            messageId: "1700000000010",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(true);

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000010",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toMatchObject({
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: "+15551230000",
        accountId: "default",
      },
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "me",
        messageId: "1700000000010",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBeNull();
  });

  it("does not register delivered structured approval payloads without explicit approvers", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-no-approvers",
      approvalSlug: "exec-no",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf test",
      host: "gateway",
    });
    const deliveredPayload = {
      ...payload,
      text: addSignalApprovalReactionHintToText({
        text: payload.text ?? "",
        allowedDecisions: ["allow-once", "deny"],
      }),
    };

    expect(
      registerSignalApprovalReactionTargetForDeliveredPayload({
        cfg: {
          channels: {
            signal: {},
          },
          approvals: {
            exec: {
              enabled: true,
              mode: "targets",
              targets: [{ channel: "signal", to: "+15551230000" }],
            },
          },
        },
        target: {
          channel: "signal",
          to: "+15551230000",
          accountId: "default",
        },
        payload: deliveredPayload,
        results: [
          {
            channel: "signal",
            messageId: "1700000000014",
          },
        ],
        targetAuthor: "+15550009999",
      }),
    ).toBe(false);
  });

  it("registers reaction state when only allow-always is available", async () => {
    expect(
      registerSignalApprovalReactionTarget({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000000",
        approvalId: "exec-allow-always",
        approvalKind: "exec",
        allowedDecisions: ["allow-always"],
        targetAuthorKeys: ["+15550009999"],
        route: approvalRoute,
        routeAllowed: true,
      }),
    ).toEqual({
      approvalId: "exec-allow-always",
      approvalKind: "exec",
      allowedDecisions: ["allow-always"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
    });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000000",
        reactionKey: "♾️",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toEqual({
      approvalId: "exec-allow-always",
      approvalKind: "exec",
      decision: "allow-always",
      route: approvalRoute,
    });
  });

  it("rejects reaction registration without a valid explicit approval kind", () => {
    expect(
      registerSignalApprovalReactionTarget({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000099",
        approvalId: "approval-without-owner",
        approvalKind: undefined as never,
        allowedDecisions: ["deny"],
        targetAuthorKeys: ["+15550009999"],
        route: approvalRoute,
        routeAllowed: true,
      }),
    ).toBeNull();
  });

  it("resolves a registered reaction target", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000000",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000000",
        reactionKey: "👎",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "deny",
      route: approvalRoute,
    });
  });

  it("does not match timestamp-only bindings when the inbound conversation id differs", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "username:kevin",
      messageId: "1700000000001",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000001",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBeNull();
  });

  it("normalizes UUID target-author casing before matching", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000001",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
      targetAuthorKeys: ["uuid:ABCDEF12-3456-7890-ABCD-EF1234567890"],
      route: approvalRoute,
      routeAllowed: true,
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000001",
        reactionKey: "👍",
        targetAuthorUuid: "abcdef12-3456-7890-abcd-ef1234567890",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      route: approvalRoute,
    });
  });

  it("ignores unsupported numeric approval reaction choices", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000002",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });
    for (const reactionKey of ["1️⃣", "2️⃣", "3️⃣", "1", "2", "3"]) {
      await expect(
        resolveSignalApprovalReactionTargetWithPersistence({
          accountId: "default",
          conversationKey: "+15551230000",
          messageId: "1700000000002",
          reactionKey,
          targetAuthor: "+15550009999",
        }),
      ).resolves.toBeNull();
    }
  });

  it("requires the reaction target author to match the outbound bot identity", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000006",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000006",
        reactionKey: "👍",
        targetAuthor: "+15550008888",
      }),
    ).resolves.toBeNull();

    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000006",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toEqual({
      approvalId: "exec-1",
      approvalKind: "exec",
      decision: "allow-once",
      route: approvalRoute,
    });
  });

  it("authorizes reactions using Signal approval approvers", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "group:g1",
      messageId: "1700000000003",
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });

    const handled = await maybeResolveSignalApprovalReaction({
      cfg: {
        channels: {
          signal: {
            allowFrom: ["+15551230000"],
          },
        },
        approvals: {
          plugin: {
            enabled: true,
            mode: "session",
          },
        },
      },
      accountId: "default",
      conversationKey: "group:g1",
      messageId: "1700000000003",
      reactionKey: "👍",
      actorId: "+15551230000",
      targetAuthor: "+15550009999",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledWith({
      cfg: {
        channels: {
          signal: {
            allowFrom: ["+15551230000"],
          },
        },
        approvals: {
          plugin: {
            enabled: true,
            mode: "session",
          },
        },
      },
      approvalId: "plugin:abc",
      approvalKind: "plugin",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("authorizes reactions using Signal defaultTo approvers", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000008",
      approvalId: "exec-default-to",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });

    const handled = await maybeResolveSignalApprovalReaction({
      cfg: {
        channels: {
          signal: {
            allowFrom: [],
            defaultTo: "+15551230000",
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "session",
          },
        },
      },
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000008",
      reactionKey: "👍",
      actorId: "+15551230000",
      targetAuthor: "+15550009999",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledWith({
      cfg: {
        channels: {
          signal: {
            allowFrom: [],
            defaultTo: "+15551230000",
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "session",
          },
        },
      },
      approvalId: "exec-default-to",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("consumes a losing surface and logs the canonical winning decision", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000019",
      approvalId: "exec-losing-surface",
      approvalKind: "exec",
      allowedDecisions: ["allow-once", "deny"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });
    resolverMocks.resolveSignalApproval.mockResolvedValueOnce({
      applied: false,
      approval: { status: "denied", decision: "deny" },
    });
    const logVerboseMessage = vi.fn();

    await expect(
      maybeResolveSignalApprovalReaction({
        cfg: {
          channels: {
            signal: {
              allowFrom: ["+15551230000"],
            },
          },
          approvals: {
            exec: {
              enabled: true,
              mode: "session",
            },
          },
        },
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000019",
        reactionKey: "👍",
        actorId: "+15551230000",
        targetAuthor: "+15550009999",
        logVerboseMessage,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveSignalApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-losing-surface",
        approvalKind: "exec",
        decision: "allow-once",
      }),
    );
    expect(logVerboseMessage).toHaveBeenCalledWith(
      "signal: approval reaction already resolved id=exec-losing-surface " +
        "sender=+15551230000 status=denied decision=deny",
    );
    expect(logVerboseMessage).not.toHaveBeenCalledWith(
      expect.stringContaining("decision=allow-once"),
    );
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000019",
        reactionKey: "👍",
        targetAuthor: "+15550009999",
      }),
    ).resolves.toBeNull();
  });

  it("requires explicit approvers for approval reactions", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000004",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });

    const handled = await maybeResolveSignalApprovalReaction({
      cfg: {
        channels: {
          signal: {},
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "session",
          },
        },
      },
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000004",
      reactionKey: "👍",
      actorId: "+15551230000",
      targetAuthor: "+15550009999",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveSignalApproval).not.toHaveBeenCalled();
  });

  it("re-checks the top-level approval route before resolving reactions", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000007",
      approvalId: "exec-1",
      approvalKind: "exec",
      allowedDecisions: ["allow-once"],
      targetAuthorKeys: ["+15550009999"],
      route: approvalRoute,
      routeAllowed: true,
    });

    const handled = await maybeResolveSignalApprovalReaction({
      cfg: {
        channels: {
          signal: {
            allowFrom: ["+15551230000"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "session",
            agentFilter: ["other-agent"],
          },
        },
      },
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000007",
      reactionKey: "👍",
      actorId: "+15551230000",
      targetAuthor: "+15550009999",
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveSignalApproval).not.toHaveBeenCalled();
  });
});
