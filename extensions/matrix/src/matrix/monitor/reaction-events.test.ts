import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMatrixApprovalReactionTargetsForTest,
  registerMatrixApprovalReactionTarget,
  resolveMatrixApprovalReactionTarget,
} from "../../approval-reactions.js";
import type { CoreConfig } from "../../types.js";
import { handleInboundMatrixReaction } from "./reaction-events.js";

const resolveMatrixApproval = vi.fn();
type MatrixReactionParams = Parameters<typeof handleInboundMatrixReaction>[0];
type MatrixReactionClient = MatrixReactionParams["client"];
type MatrixReactionCore = MatrixReactionParams["core"];
type MatrixReactionEvent = MatrixReactionParams["event"];

vi.mock("../../exec-approval-resolver.js", () => ({
  isApprovalNotFoundError: (err: unknown) =>
    err instanceof Error && /unknown or expired approval id/i.test(err.message),
  resolveMatrixApproval: (...args: unknown[]) => resolveMatrixApproval(...args),
}));

beforeEach(() => {
  resolveMatrixApproval.mockReset();
  clearMatrixApprovalReactionTargetsForTest();
});

function buildConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok",
        reactionNotifications: "own",
        execApprovals: {
          enabled: true,
          approvers: ["@owner:example.org"],
          target: "channel",
        },
      },
    },
  } as CoreConfig;
}

function buildCore() {
  return {
    channel: {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          sessionKey: "agent:main:matrix:channel:!ops:example.org",
          mainSessionKey: "agent:main:matrix:channel:!ops:example.org",
          agentId: "main",
          matchedBy: "peer",
        }),
      },
    },
    system: {
      enqueueSystemEvent: vi.fn(),
    },
  } as unknown as Parameters<typeof handleInboundMatrixReaction>[0]["core"];
}

function createReactionClient(
  getEvent: ReturnType<typeof vi.fn> = vi.fn(),
): MatrixReactionClient & { getEvent: ReturnType<typeof vi.fn> } {
  return { getEvent } as unknown as MatrixReactionClient & {
    getEvent: ReturnType<typeof vi.fn>;
  };
}

function createReactionEvent(
  params: {
    eventId?: string;
    targetEventId?: string;
    reactionKey?: string;
  } = {},
): MatrixReactionEvent {
  return {
    event_id: params.eventId ?? "$reaction-1",
    sender: "@owner:example.org",
    type: "m.reaction",
    origin_server_ts: 123,
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: params.targetEventId ?? "$approval-msg",
        key: params.reactionKey ?? "✅",
      },
    },
  } as MatrixReactionEvent;
}

async function handleReaction(params: {
  client: MatrixReactionClient;
  core: MatrixReactionCore;
  cfg?: CoreConfig;
  targetEventId?: string;
  reactionKey?: string;
}): Promise<void> {
  await handleInboundMatrixReaction({
    client: params.client,
    core: params.core,
    cfg: params.cfg ?? buildConfig(),
    accountId: "default",
    roomId: "!ops:example.org",
    event: createReactionEvent({
      targetEventId: params.targetEventId,
      reactionKey: params.reactionKey,
    }),
    senderId: "@owner:example.org",
    senderLabel: "Owner",
    selfUserId: "@bot:example.org",
    isDirectMessage: false,
    logVerboseMessage: vi.fn(),
  });
}

describe("matrix approval reactions", () => {
  it("resolves approval reactions instead of enqueueing a generic reaction event", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        event_id: "$approval-msg",
        sender: "@bot:example.org",
        content: { body: "approval prompt" },
      }),
    );

    await handleReaction({
      client,
      core,
      cfg,
    });

    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "req-123",
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps ordinary reactions on bot messages as generic reaction events", async () => {
    const core = buildCore();
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        event_id: "$msg-1",
        sender: "@bot:example.org",
        content: {
          body: "normal bot message",
        },
      }),
    );

    await handleReaction({
      client,
      core,
      targetEventId: "$msg-1",
      reactionKey: "👍",
    });

    expect(resolveMatrixApproval).not.toHaveBeenCalled();
    expect(core.system.enqueueSystemEvent).toHaveBeenCalledWith(
      "Matrix reaction added: 👍 by Owner on msg $msg-1",
      {
        sessionKey: "agent:main:matrix:channel:!ops:example.org",
        contextKey: "matrix:reaction:add:!ops:example.org:$msg-1:@owner:example.org:👍",
      },
    );
  });

  it("still resolves approval reactions when generic reaction notifications are off", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.reactionNotifications = "off";
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["deny"],
    });
    const client = createReactionClient(
      vi.fn().mockResolvedValue({
        event_id: "$approval-msg",
        sender: "@bot:example.org",
        content: { body: "approval prompt" },
      }),
    );

    await handleReaction({
      client,
      core,
      cfg,
      reactionKey: "❌",
    });

    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "req-123",
      decision: "deny",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("resolves registered approval reactions without fetching the target event", async () => {
    const core = buildCore();
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["allow-once"],
    });
    const client = createReactionClient(vi.fn().mockRejectedValue(new Error("boom")));

    await handleReaction({
      client,
      core,
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      cfg: buildConfig(),
      approvalId: "req-123",
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("resolves plugin approval reactions through the same Matrix reaction path", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.dm = { allowFrom: ["@owner:example.org"] };
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$plugin-approval-msg",
      approvalId: "plugin:req-123",
      allowedDecisions: ["allow-once", "deny"],
    });
    const client = createReactionClient();

    await handleReaction({
      client,
      core,
      cfg,
      targetEventId: "$plugin-approval-msg",
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).toHaveBeenCalledWith({
      cfg,
      approvalId: "plugin:req-123",
      decision: "allow-once",
      senderId: "@owner:example.org",
    });
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("unregisters stale approval anchors after not-found resolution", async () => {
    const core = buildCore();
    resolveMatrixApproval.mockRejectedValueOnce(
      new Error("unknown or expired approval id req-123"),
    );
    registerMatrixApprovalReactionTarget({
      roomId: "!ops:example.org",
      eventId: "$approval-msg",
      approvalId: "req-123",
      allowedDecisions: ["deny"],
    });
    const client = createReactionClient();

    await handleReaction({
      client,
      core,
      reactionKey: "❌",
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(
      resolveMatrixApprovalReactionTarget({
        roomId: "!ops:example.org",
        eventId: "$approval-msg",
        reactionKey: "❌",
      }),
    ).toBeNull();
  });

  it("skips target fetches for ordinary reactions when notifications are off", async () => {
    const core = buildCore();
    const cfg = buildConfig();
    const matrixCfg = cfg.channels?.matrix;
    if (!matrixCfg) {
      throw new Error("matrix config missing");
    }
    matrixCfg.reactionNotifications = "off";
    const client = createReactionClient();

    await handleReaction({
      client,
      core,
      cfg,
      targetEventId: "$msg-1",
      reactionKey: "👍",
    });

    expect(client.getEvent).not.toHaveBeenCalled();
    expect(resolveMatrixApproval).not.toHaveBeenCalled();
    expect(core.system.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
