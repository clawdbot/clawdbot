// A completion announce falls back to a synchronous gateway `agent` dispatch
// keyed on the requester's own session key, so it serializes on that session's
// lane. When the requester is mid-turn the dispatch cannot be admitted until the
// turn ends — unbounded — and the old code spent the whole announce budget
// discovering that, then reported the child's delivery as failed. These tests
// pin the deferral that replaces that discovery, and pin that a free lane still
// dispatches exactly as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import type { dispatchGatewayMethodInProcess as runtimeDispatchGatewayMethodInProcess } from "../../../gateway/server-plugins.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { CommandLane } from "../../../process/lanes.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { resolveSessionLane } from "../../embedded-agent-runner/lanes.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { testing, deliverSubagentAnnouncement } from "./subagent-announce-delivery.test-support.js";

const REQUESTER_SESSION_KEY = "agent:main:slack:channel:C123:thread:171.222";
const REQUESTER_LANE = resolveSessionLane(REQUESTER_SESSION_KEY);
const CHILD_SESSION_KEY = "agent:main:subagent:child";

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
} as const;

function createGatewayMock() {
  return vi.fn(async (opts: Parameters<typeof runtimeCallGateway>[0]) => {
    opts.onAccepted?.({ status: "accepted" });
    return {};
  }) as unknown as typeof runtimeCallGateway;
}

function createInProcessGatewayMock() {
  return vi.fn(async () => ({
    result: {
      payloads: [{ text: "requester voice completion" }],
      deliveryStatus: { status: "sent", resultCount: 1 },
    },
  })) as unknown as typeof runtimeDispatchGatewayMethodInProcess;
}

function announce(params: {
  dispatchGatewayMethodInProcess: typeof runtimeDispatchGatewayMethodInProcess;
  callGateway: typeof runtimeCallGateway;
  deferOnRequesterLaneBusy?: boolean;
}) {
  testing.setDepsForTest({
    callGateway: params.callGateway,
    dispatchGatewayMethodInProcess: params.dispatchGatewayMethodInProcess,
    // A dormant requester is the arm the canary measured: the inline steer is
    // skipped, so the synchronous dispatch is the only delivery path left.
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-local",
      isActive: false,
    }),
    getRuntimeConfig: () => ({}) as never,
  });
  return deliverSubagentAnnouncement({
    requesterSessionKey: REQUESTER_SESSION_KEY,
    targetRequesterSessionKey: REQUESTER_SESSION_KEY,
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: slackThreadOrigin,
    requesterSessionOrigin: slackThreadOrigin,
    completionDirectOrigin: slackThreadOrigin,
    directOrigin: slackThreadOrigin,
    sourceSessionKey: CHILD_SESSION_KEY,
    internalEvents: taskCompletionEvents({
      childSessionKey: CHILD_SESSION_KEY,
      childSessionId: "child-session-local",
    }),
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "announce:v1:child:run-1",
    ...(params.deferOnRequesterLaneBusy === undefined
      ? {}
      : { deferOnRequesterLaneBusy: params.deferOnRequesterLaneBusy }),
  });
}

describe("subagent announce deferral on an occupied requester lane", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCommandQueueStateForTest();
    setCommandLaneConcurrency(CommandLane.Main, 1);
    setActivePluginRegistry(createTestRegistry());
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
    testing.setDepsForTest();
    setActivePluginRegistry(createTestRegistry());
  });

  it("does not dispatch, and reports deferred_requester_busy, while the requester holds its lane", async () => {
    const holdingTurn = createDeferred();
    const requesterTurn = enqueueCommandInLane(REQUESTER_LANE, async () => {
      await holdingTurn.promise;
    });
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock();
    const callGateway = createGatewayMock();

    const result = await announce({
      dispatchGatewayMethodInProcess,
      callGateway,
      deferOnRequesterLaneBusy: true,
    });

    // The whole point: no announce turn was started, so no admission budget was
    // spent waiting for a lane that provably could not free yet.
    expect(dispatchGatewayMethodInProcess).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      delivered: false,
      path: "none",
      reason: "requester_lane_busy",
      disposition: "deferred_requester_busy",
    });
    // A deferral is not a failure: nothing to log as an error, nothing to
    // attribute to the child, and no `error` string to surface as one.
    expect(result.error).toBeUndefined();

    holdingTurn.resolve(undefined);
    await requesterTurn;
  });

  it("dispatches unchanged when the requester lane is free", async () => {
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock();
    const callGateway = createGatewayMock();

    const result = await announce({
      dispatchGatewayMethodInProcess,
      callGateway,
      deferOnRequesterLaneBusy: true,
    });

    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ delivered: true, path: "direct" });
    expect(result.disposition).toBeUndefined();
  });

  it("dispatches into an occupied lane for callers that did not opt in", async () => {
    const holdingTurn = createDeferred();
    const requesterTurn = enqueueCommandInLane(REQUESTER_LANE, async () => {
      await holdingTurn.promise;
    });
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock();
    const callGateway = createGatewayMock();

    // Callers with no durable outbox behind them (the requester settle wake, the
    // media handoff, the harness task runtime) must keep today's behavior: a
    // deferral they cannot honor would simply lose the announcement.
    const result = await announce({ dispatchGatewayMethodInProcess, callGateway });

    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ delivered: true, path: "direct" });

    holdingTurn.resolve(undefined);
    await requesterTurn;
  });

  it("dispatches once the requester's turn releases the lane", async () => {
    const holdingTurn = createDeferred();
    const requesterTurn = enqueueCommandInLane(REQUESTER_LANE, async () => {
      await holdingTurn.promise;
    });
    const dispatchGatewayMethodInProcess = createInProcessGatewayMock();
    const callGateway = createGatewayMock();

    const deferred = await announce({
      dispatchGatewayMethodInProcess,
      callGateway,
      deferOnRequesterLaneBusy: true,
    });
    expect(deferred.disposition).toBe("deferred_requester_busy");

    holdingTurn.resolve(undefined);
    await requesterTurn;

    const delivered = await announce({
      dispatchGatewayMethodInProcess,
      callGateway,
      deferOnRequesterLaneBusy: true,
    });
    expect(delivered).toMatchObject({ delivered: true, path: "direct" });
    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledTimes(1);
  });
});
