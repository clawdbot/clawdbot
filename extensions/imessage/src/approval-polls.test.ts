// Imessage tests cover native approval poll bindings and vote authorization.
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildApprovalPollOptions,
  iMessageApprovalPollTargets,
  mapSentPollOptionsToDecisions,
  maybeResolveIMessageApprovalPollVote,
} from "./approval-polls.js";
import type { IMessagePayload } from "./monitor/types.js";

const resolverMocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveApprovalOverGateway,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", () => ({
  isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
}));

const APPROVER = "+15551230000";
const POLL_GUID = "poll-guid-1";
const cfg = { channels: { imessage: { allowFrom: [APPROVER] } } };

const ALLOW_ONCE_OPTION = "opt-allow-once";
const DENY_OPTION = "opt-deny";
const GROUP_CHAT_GUID = "iMessage;+;chat0000";

function bind(overrides?: {
  optionDecisions?: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]>;
  expiresAtMs?: number;
}): boolean {
  return iMessageApprovalPollTargets.register({
    accountId: "default",
    conversation: { handle: APPROVER },
    pollGuid: POLL_GUID,
    approvalId: "exec-1",
    approvalKind: "exec",
    optionDecisions:
      overrides?.optionDecisions ??
      ([
        [ALLOW_ONCE_OPTION, "allow-once"],
        [DENY_OPTION, "deny"],
      ] as const),
    expiresAtMs: overrides?.expiresAtMs ?? Date.now() + 60_000,
  });
}

function buildVote(overrides?: {
  sender?: string;
  participant?: string;
  optionId?: string;
  eventType?: string;
  pollGuid?: string;
  isFromMe?: boolean;
  destinationCallerId?: string;
}): IMessagePayload {
  return {
    sender: overrides?.sender ?? APPROVER,
    is_from_me: overrides?.isFromMe,
    destination_caller_id: overrides?.destinationCallerId,
    poll: {
      kind: "vote",
      original_guid: overrides?.pollGuid ?? POLL_GUID,
      poll_guid: overrides?.pollGuid ?? POLL_GUID,
      vote: {
        option_id: overrides?.optionId ?? ALLOW_ONCE_OPTION,
        option_text: "👍 Allow Once",
        participant: overrides?.participant ?? APPROVER,
        event_type: overrides?.eventType ?? "selected",
      },
    },
  } as IMessagePayload;
}

beforeEach(() => {
  iMessageApprovalPollTargets.clearForTest();
  resolverMocks.resolveApprovalOverGateway.mockReset();
  resolverMocks.resolveApprovalOverGateway.mockResolvedValue({ applied: true, approval: {} });
  resolverMocks.isApprovalNotFoundError.mockReset();
  resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
});

describe("buildApprovalPollOptions", () => {
  it("emits canonical decision order with labels", () => {
    expect(
      buildApprovalPollOptions({ allowedDecisions: ["deny", "allow-always", "allow-once"] }),
    ).toEqual([
      { decision: "allow-once", text: "👍 Allow Once" },
      { decision: "allow-always", text: "♾️ Allow Always" },
      { decision: "deny", text: "👎 Deny" },
    ]);
  });

  it("drops decisions the approval does not allow", () => {
    expect(buildApprovalPollOptions({ allowedDecisions: ["allow-once", "deny"] })).toHaveLength(2);
    // Messages requires >= 2 options, so the caller skips the poll entirely here.
    expect(buildApprovalPollOptions({ allowedDecisions: ["deny"] })).toHaveLength(1);
  });
});

describe("mapSentPollOptionsToDecisions", () => {
  const requested = buildApprovalPollOptions({ allowedDecisions: ["allow-once", "deny"] });

  it("maps returned option ids back to decisions by text", () => {
    expect(
      mapSentPollOptionsToDecisions({
        requested,
        sent: [
          { id: "id-deny", text: "👎 Deny" },
          { id: "id-allow", text: "👍 Allow Once" },
        ],
      }),
    ).toEqual([
      ["id-deny", "deny"],
      ["id-allow", "allow-once"],
    ]);
  });

  it("fails closed when the bridge normalizes option text", () => {
    expect(
      mapSentPollOptionsToDecisions({
        requested,
        sent: [
          { id: "id-a", text: "Allow Once" },
          { id: "id-b", text: "Deny" },
        ],
      }),
    ).toEqual([]);
  });

  it("fails closed when the bridge returns only a subset", () => {
    expect(
      mapSentPollOptionsToDecisions({
        requested,
        sent: [{ id: "id-a", text: "👍 Allow Once" }],
      }),
    ).toEqual([]);
  });

  it("fails closed when option ids are duplicated", () => {
    expect(
      mapSentPollOptionsToDecisions({
        requested,
        sent: [
          { id: "same-id", text: "👍 Allow Once" },
          { id: "same-id", text: "👎 Deny" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("maybeResolveIMessageApprovalPollVote", () => {
  it("resolves a pending approval from an authorized vote", async () => {
    expect(bind()).toBe(true);
    const gatewayRuntime = { request: vi.fn() } as never;

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote(),
        gatewayRuntime,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-1",
        decision: "allow-once",
        senderId: APPROVER,
        gatewayRuntime,
      }),
    );
  });

  it("selects the transport actor from a multi-participant complete vote set", async () => {
    expect(bind()).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: {
          sender: APPROVER,
          poll: {
            kind: "vote",
            original_guid: POLL_GUID,
            vote: {
              option_id: ALLOW_ONCE_OPTION,
              participant: "+15559999999",
              event_type: "selected",
            },
            votes: [
              {
                option_id: ALLOW_ONCE_OPTION,
                participant: "+15559999999",
                event_type: "selected",
              },
              {
                option_id: DENY_OPTION,
                participant: APPROVER,
                event_type: "selected",
              },
            ],
          },
        } as IMessagePayload,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "exec-1", decision: "deny" }),
    );
  });

  it("fails closed when a multi-participant set does not identify the transport actor", async () => {
    expect(bind()).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: {
          sender: APPROVER,
          poll: {
            kind: "vote",
            original_guid: POLL_GUID,
            votes: [
              {
                option_id: ALLOW_ONCE_OPTION,
                participant: "+15559999998",
                event_type: "selected",
              },
              {
                option_id: DENY_OPTION,
                participant: "+15559999999",
                event_type: "selected",
              },
            ],
          },
        } as IMessagePayload,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("accepts a complete multi-record set for one participant alias", async () => {
    expect(bind()).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: {
          sender: APPROVER,
          poll: {
            kind: "vote",
            original_guid: POLL_GUID,
            votes: [
              {
                option_id: ALLOW_ONCE_OPTION,
                participant: "e:active-account-alias@example.com",
                event_type: "selected",
              },
              {
                option_id: DENY_OPTION,
                participant: "e:active-account-alias@example.com",
                event_type: "removed",
              },
            ],
          },
        } as IMessagePayload,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "exec-1", decision: "allow-once" }),
    );
  });

  it("fails closed when the actor selected multiple approval decisions", async () => {
    expect(bind()).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: {
          sender: APPROVER,
          poll: {
            kind: "vote",
            original_guid: POLL_GUID,
            votes: [
              {
                option_id: ALLOW_ONCE_OPTION,
                participant: APPROVER,
                event_type: "selected",
              },
              {
                option_id: DENY_OPTION,
                participant: APPROVER,
                event_type: "selected",
              },
            ],
          },
        } as IMessagePayload,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("authenticates paired-device self votes with destination_caller_id", async () => {
    expect(bind()).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({
          sender: "",
          participant: APPROVER,
          isFromMe: true,
          destinationCallerId: APPROVER,
        }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allow-once", senderId: APPROVER }),
    );
  });

  it("does not trust destination_caller_id on received rows", async () => {
    expect(bind()).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({
          sender: "",
          participant: APPROVER,
          isFromMe: false,
          destinationCallerId: APPROVER,
        }),
      }),
    ).resolves.toBe(false);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("rejects imsg's local-identity sender fallback on received rows", async () => {
    expect(bind()).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({
          sender: APPROVER,
          participant: APPROVER,
          isFromMe: false,
          destinationCallerId: APPROVER,
        }),
      }),
    ).resolves.toBe(false);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("uses the option id when imsg reports the prompt GUID instead of the poll GUID", async () => {
    iMessageApprovalPollTargets.register({
      accountId: "default",
      conversation: { handle: APPROVER },
      pollGuid: "bridge-reported-prompt-guid",
      approvalId: "exec-racy-guid",
      approvalKind: "exec",
      optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({ pollGuid: "actual-native-poll-guid" }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-racy-guid",
        decision: "allow-once",
      }),
    );
  });

  // A group poll is where authorization actually carries weight: the binding is
  // keyed by chat, so every member's vote finds it and only allowFrom stops
  // them. In a DM the handle-keyed lookup already scopes to the approver.
  function bindGroup(): void {
    iMessageApprovalPollTargets.register({
      accountId: "default",
      conversation: { chatGuid: GROUP_CHAT_GUID },
      pollGuid: POLL_GUID,
      approvalId: "exec-group",
      approvalKind: "exec",
      optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]] as const,
      expiresAtMs: Date.now() + 60_000,
    });
  }

  function buildGroupVote(overrides: { sender: string; participant: string }): IMessagePayload {
    return {
      ...buildVote(overrides),
      chat_guid: GROUP_CHAT_GUID,
      is_group: true,
    } as IMessagePayload;
  }

  it("authorizes the transport sender, not the payload participant", async () => {
    // The vote payload's participant is attacker-shaped: imsg falls back to the
    // row sender only when it is absent, so a crafted envelope can claim an
    // allowlisted handle while being sent by someone else.
    bindGroup();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildGroupVote({ sender: "+15559999999", participant: APPROVER }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("denies a group vote from a member outside allowFrom", async () => {
    bindGroup();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildGroupVote({ sender: "+15559999999", participant: "+15559999999" }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("resolves a group vote from an approver", async () => {
    bindGroup();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildGroupVote({ sender: APPROVER, participant: APPROVER }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "exec-group", senderId: APPROVER }),
    );
  });

  it("authorizes an email sender when Apple reports another active-account alias", async () => {
    const emailCfg = { channels: { imessage: { allowFrom: ["person@example.com"] } } };
    iMessageApprovalPollTargets.register({
      accountId: "default",
      conversation: { handle: "person@example.com" },
      pollGuid: POLL_GUID,
      approvalId: "exec-email",
      approvalKind: "exec",
      optionDecisions: [[DENY_OPTION, "deny"]] as const,
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg: emailCfg,
        accountId: "default",
        message: buildVote({
          sender: "person@example.com",
          participant: "another-alias@example.com",
          optionId: DENY_OPTION,
        }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "exec-email", decision: "deny" }),
    );
  });

  it("requires explicit approvers", async () => {
    bind();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg: { channels: { imessage: {} } },
        accountId: "default",
        message: buildVote(),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("owns an un-vote without resolving it", async () => {
    bind();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({ eventType: "removed" }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("ignores an option id that is not bound to a decision", async () => {
    bind();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({ optionId: "opt-unknown" }),
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-vote poll", { kind: "created", options: [] }],
    ["a vote without a poll identity", { kind: "vote", vote: null }],
  ])("falls through on %s", async (_label, poll) => {
    bind();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: { sender: APPROVER, poll } as unknown as IMessagePayload,
      }),
    ).resolves.toBe(false);
  });

  it("owns an empty complete vote set as a deselection", async () => {
    bind();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: {
          sender: APPROVER,
          poll: { kind: "vote", original_guid: POLL_GUID, vote: null, votes: [] },
        } as IMessagePayload,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed complete vote set for an owned poll", async () => {
    bind();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: {
          sender: APPROVER,
          poll: {
            kind: "vote",
            original_guid: POLL_GUID,
            votes: [{ option_id: 7, participant: APPROVER }],
          },
        } as unknown as IMessagePayload,
      }),
    ).resolves.toBe(true);

    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("falls through for a poll it does not own so ordinary polls still render", async () => {
    bind();

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({
          pollGuid: "some-other-poll",
          optionId: "some-other-option",
        }),
      }),
    ).resolves.toBe(false);
  });

  it("swallows late votes after the approval resolved", async () => {
    bind();
    await maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message: buildVote() });
    resolverMocks.resolveApprovalOverGateway.mockClear();

    // Messages cannot close a poll, so the balloon stays tappable; a late tap
    // must not reach the agent as prose.
    await expect(
      maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message: buildVote() }),
    ).resolves.toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("retains a tombstone after the live target expires", async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const expiringPollGuid = "poll-guid-natural-expiry";
      expect(
        iMessageApprovalPollTargets.register({
          accountId: "default",
          conversation: { handle: APPROVER },
          pollGuid: expiringPollGuid,
          approvalId: "exec-expiring",
          approvalKind: "exec",
          optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
          expiresAtMs: 1_001,
        }),
      ).toBe(true);
      vi.setSystemTime(1_002);

      await expect(
        maybeResolveIMessageApprovalPollVote({
          cfg,
          accountId: "default",
          message: buildVote({ pollGuid: expiringPollGuid }),
        }),
      ).resolves.toBe(true);
      expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows votes for a created poll that could not be bound", async () => {
    const orphanPollGuid = "poll-guid-orphaned";
    expect(
      iMessageApprovalPollTargets.registerTombstone({
        accountId: "default",
        conversation: { handle: APPROVER },
        pollGuid: orphanPollGuid,
        approvalId: "exec-orphaned",
      }),
    ).toBe(true);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({ pollGuid: orphanPollGuid }),
      }),
    ).resolves.toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("clears the binding when the approval is already gone", async () => {
    bind();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(true);
    resolverMocks.resolveApprovalOverGateway.mockRejectedValue(new Error("not found"));

    await maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message: buildVote() });

    resolverMocks.resolveApprovalOverGateway.mockClear();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
    resolverMocks.resolveApprovalOverGateway.mockResolvedValue({ applied: true, approval: {} });

    await maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message: buildVote() });
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("retains the binding on a transient resolver error so a retry can land", async () => {
    bind();
    resolverMocks.resolveApprovalOverGateway.mockRejectedValueOnce(new Error("gateway 503"));

    await expect(
      maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message: buildVote() }),
    ).rejects.toThrow("gateway 503");

    resolverMocks.resolveApprovalOverGateway.mockResolvedValue({ applied: true, approval: {} });
    await maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message: buildVote() });

    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalId: "exec-1", decision: "allow-once" }),
    );
  });

  it("does not resolve once the binding expired", async () => {
    // Own poll GUID: sibling tests leave tombstones under POLL_GUID, and the
    // shared keyed store outlives clearForTest. Real polls always have unique
    // GUIDs, so only the tests can collide here.
    const expiredPollGuid = "poll-guid-expired";
    expect(
      iMessageApprovalPollTargets.register({
        accountId: "default",
        conversation: { handle: APPROVER },
        pollGuid: expiredPollGuid,
        approvalId: "exec-expired",
        approvalKind: "exec",
        optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]] as const,
        expiresAtMs: Date.now() - 1,
      }),
    ).toBe(false);

    await expect(
      maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: "default",
        message: buildVote({ pollGuid: expiredPollGuid }),
      }),
    ).resolves.toBe(false);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("matches a vote that arrives keyed by chat guid instead of handle", async () => {
    iMessageApprovalPollTargets.register({
      accountId: "default",
      conversation: { chatGuid: "iMessage;-;+15551230000", handle: APPROVER },
      pollGuid: POLL_GUID,
      approvalId: "exec-chat",
      approvalKind: "exec",
      optionDecisions: [[DENY_OPTION, "deny"]] as const,
      expiresAtMs: Date.now() + 60_000,
    });

    const message = {
      ...buildVote({ optionId: DENY_OPTION }),
      chat_guid: "iMessage;-;+15551230000",
    } as IMessagePayload;

    await expect(
      maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message }),
    ).resolves.toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "exec-chat" }),
    );
  });

  it("stops resolving after the target is unregistered", async () => {
    bind();
    iMessageApprovalPollTargets.unregister({
      accountId: "default",
      conversation: { handle: APPROVER },
      pollGuid: POLL_GUID,
      optionDecisions: [
        [ALLOW_ONCE_OPTION, "allow-once"],
        [DENY_OPTION, "deny"],
      ],
    });

    await maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message: buildVote() });
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });
});
