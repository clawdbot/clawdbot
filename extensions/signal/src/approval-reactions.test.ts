import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSignalApprovalReactionHintToText,
  buildSignalApprovalReactionHint,
  clearSignalApprovalReactionTargetsForTest,
  maybeResolveSignalApprovalReaction,
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
    resolverMocks.resolveSignalApproval.mockResolvedValue(undefined);
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("renders thumbs-only reaction choices for allowed decisions", () => {
    expect(buildSignalApprovalReactionHint(["allow-once", "deny"])).toBe(
      "React with:\n\n👍 Allow Once\n👎 Deny",
    );
  });

  it("does not expose allow-always as a reaction choice", () => {
    expect(buildSignalApprovalReactionHint(["allow-once", "allow-always", "deny"])).toBe(
      "React with:\n\n👍 Allow Once\n👎 Deny",
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

  it("does not register reaction state when only allow-always is available", () => {
    expect(
      registerSignalApprovalReactionTarget({
        accountId: "default",
        conversationKey: "+15551230000",
        messageId: "1700000000000",
        approvalId: "exec-allow-always",
        allowedDecisions: ["allow-always"],
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
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
    });
  });

  it("requires explicit approvers for approval reactions", async () => {
    registerSignalApprovalReactionTarget({
      accountId: "default",
      conversationKey: "+15551230000",
      messageId: "1700000000004",
      approvalId: "exec-1",
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
