// Mattermost tests cover replaying a recorded button click.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  buildEventPlan: vi.fn(),
  deliverReply: vi.fn(),
  dispatch: vi.fn(),
  enqueueSystemEvent: vi.fn(),
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

import type {
  MattermostIngressInteraction,
  MattermostIngressLifecycle,
} from "./monitor-ingress.js";
import { createMattermostInteractionDispatch } from "./monitor-interactions.js";
import type { MattermostMonitorContext } from "./monitor-types.js";

const recordedClick: MattermostIngressInteraction = {
  eventId: "click-1",
  channelId: "channel-1",
  userId: "user-1",
  userName: "alice",
  actionId: "approve",
  actionName: "Approve",
  postId: "post-1",
};

const lifecycle = {
  abortSignal: new AbortController().signal,
  onAdopted: vi.fn(),
  onDeferred: vi.fn(),
  onAdoptionFinalizing: vi.fn(),
  onAbandoned: vi.fn(),
} as unknown as MattermostIngressLifecycle;

function createMonitor(): MattermostMonitorContext {
  return {
    account: { accountId: "default", config: {} },
    cfg: {},
    core: {
      channel: {
        commands: { shouldHandleTextCommands: vi.fn(() => true) },
        inbound: { dispatch: mocks.dispatch },
        text: { convertMarkdownTables: vi.fn((text: string) => text) },
      },
      system: { enqueueSystemEvent: mocks.enqueueSystemEvent },
    },
    pairing: { readAllowFromStore: vi.fn(async () => []) },
    resources: { resolveChannelInfo: vi.fn(async () => ({ id: "channel-1", type: "O" })) },
    runtime: { error: vi.fn(), log: vi.fn() },
  } as unknown as MattermostMonitorContext;
}

describe("createMattermostInteractionDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      ok: true,
      commandAuthorized: true,
      channelInfo: { id: "channel-1", team_id: "team-1", type: "O" },
      kind: "channel",
      chatType: "channel",
      channelName: "ops",
      channelDisplay: "Ops",
      roomLabel: "#ops",
    });
    mocks.buildEventPlan.mockResolvedValue({
      channelId: "channel-1",
      channelDisplay: "Ops",
      kind: "channel",
      roomLabel: "#ops",
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
    mocks.dispatch.mockResolvedValue(undefined);
  });

  it("refuses a recorded click whose sender lost access after it was taken", async () => {
    // The click was authorized when it was recorded; the allowlist has since narrowed.
    mocks.authorize.mockResolvedValue({ ok: false, roomLabel: "#ops" });
    const monitor = createMonitor();

    const outcome = await createMattermostInteractionDispatch(monitor)(recordedClick, lifecycle);

    // Route preparation may run first — it is a read. What must not happen is any
    // agent-visible effect.
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    // A refused click reached no turn, so it must settle instead of waiting for an
    // adoption that will never come.
    expect(outcome).toBe("dropped");
  });

  it("refuses a click whose sender loses access while its route is prepared", async () => {
    // Authorization has to be the last thing before the enqueue and dispatch. Route
    // preparation awaits a channel lookup, so a pairing or allowlist change can land
    // inside that await; a check taken before it would already be stale.
    const monitor = createMonitor();
    mocks.buildEventPlan.mockImplementation(async () => {
      mocks.authorize.mockResolvedValue({ ok: false, roomLabel: "#ops" });
      return {
        channelId: "channel-1",
        channelDisplay: "Ops",
        kind: "channel",
        roomLabel: "#ops",
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
      };
    });

    const outcome = await createMattermostInteractionDispatch(monitor)(recordedClick, lifecycle);

    expect(outcome).toBe("dropped");
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("settles a click whose channel can no longer be routed", async () => {
    mocks.buildEventPlan.mockResolvedValue(undefined);
    const monitor = createMonitor();

    const outcome = await createMattermostInteractionDispatch(monitor)(recordedClick, lifecycle);

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(outcome).toBe("dropped");
  });

  it("answers a recorded click whose sender still has access", async () => {
    const monitor = createMonitor();

    const outcome = await createMattermostInteractionDispatch(monitor)(recordedClick, lifecycle);

    expect(outcome).toBe("dispatched");
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    const dispatched = mocks.dispatch.mock.calls[0]?.[0] as {
      ctxPayload?: Record<string, unknown>;
    };
    expect(dispatched.ctxPayload?.MessageSid).toBe("interaction:post-1:approve:click-1");
    expect(dispatched.ctxPayload?.CommandAuthorized).toBe(false);
  });

  it("gives a second press of the same button its own inbound identity", async () => {
    const monitor = createMonitor();
    const dispatch = createMattermostInteractionDispatch(monitor);

    await dispatch(recordedClick, lifecycle);
    await dispatch({ ...recordedClick, eventId: "click-2" }, lifecycle);

    const sids = mocks.dispatch.mock.calls.map(
      ([params]) => (params as { ctxPayload?: Record<string, unknown> }).ctxPayload?.MessageSid,
    );
    expect(sids).toEqual([
      "interaction:post-1:approve:click-1",
      "interaction:post-1:approve:click-2",
    ]);
  });
});
