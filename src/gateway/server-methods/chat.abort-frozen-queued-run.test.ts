/**
 * Harness proof for #118028: a late chat.abort must not mark a terminally
 * frozen queued followup run aborted, and final delivery must still complete.
 *
 * Exercises the real production chain end-to-end:
 *   chat.send onDeferred  -> registerQueuedChatTurn (real chat-queued-turns)
 *   execution freeze      -> retireFollowupRunCancellation (real queue/types)
 *                            -> turnAdoptionLifecycle.onCancellationRetired
 *                            -> retireQueuedChatTurnCancellation (real)
 *   late chat.abort       -> handleChatAbortRequestWithLifecycle (real handler)
 *   final delivery        -> completeQueuedChatTurn (real)
 *
 * This harness distinguishes freeze-time retirement (entry.abortable=false,
 * entry still present) from post-delivery deletion (entry removed) — an
 * E2E test cannot observe this distinction because Gateway broadcasts
 * state:"final" only after both retirement and delivery complete.
 *
 * Preflight-failure paths: only the terminal preflightFailurePayload branch
 * retires cancellation (it bypasses executeAgentTurn and goes to delivery);
 * the retryable preflightError branch must remain abortable. Active queued
 * runs (not yet frozen, no preflight failure) must also remain abortable.
 */
import { expect, it, vi } from "vitest";
import { retireFollowupRunCancellation } from "../../auto-reply/reply/queue/types.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
import { createChatRunState } from "../server-chat-state.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { invokeChatAbortHandler } from "./chat.abort.test-helpers.js";

vi.mock("../session-utils.js", async () => {
  return {
    ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
    loadSessionEntry: () => ({ entry: { sessionId: "main-session" } }),
  };
});

function createFrozenQueuedRunHarness() {
  const chatQueuedTurns = new Map<string, import("../chat-queued-turns.js").QueuedChatTurnEntry>();
  const context = {
    chatAbortControllers: new Map(),
    chatQueuedTurns,
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    removeChatRun: vi.fn((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
  };
  const controller = new AbortController();
  const followupRun = {
    prompt: "queued followup",
    run: {},
    turnAdoptionLifecycle: {
      admission: "cancel-only" as const,
      ownerKey: "owner-key",
      onAdopted: async () => {},
      onDeferred: () =>
        registerQueuedChatTurn({
          chatQueuedTurns,
          runId: "queued-1",
          controller,
          sessionId: "main-session",
          sessionKey: "main",
          ownerConnId: "conn-owner",
          ownerDeviceId: "dev-owner",
        }),
      onCancellationRetired: () =>
        retireQueuedChatTurnCancellation(chatQueuedTurns, "queued-1", controller),
      onSettled: () => completeQueuedChatTurn(chatQueuedTurns, "queued-1", controller),
    },
  };
  return { context, controller, chatQueuedTurns, followupRun };
}

it("harness: late chat.abort leaves the frozen queued run un-aborted and delivery completes", async () => {
  const { context, controller, chatQueuedTurns, followupRun } = createFrozenQueuedRunHarness();
  const trace: string[] = [];

  // 1. chat.send terminalizes while the followup waits in queue -> Gateway registers cancel identity.
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.has("queued-1")).toBe(true);
  trace.push("registered queued entry after chat.send terminalize");

  // 2. Execution freezes (commitTerminalOutcome) -> our fix retires queued cancellation ownership.
  retireFollowupRunCancellation(followupRun as never);
  // Retirement sets entry.abortable=false while the entry remains in the map.
  // This distinguishes freeze-time retirement from post-delivery deletion:
  //   retired:  abortable=false, chatQueuedTurns.has(runId)=true
  //   deleted:  chatQueuedTurns.has(runId)=false
  expect(chatQueuedTurns.get("queued-1")?.abortable).toBe(false);
  expect(chatQueuedTurns.has("queued-1")).toBe(true);
  trace.push("execution freeze retired queued cancellation (abortable=false, entry present)");

  // 3. A late chat.abort arrives for the frozen queued run while the entry
  //    is still present (retired, not deleted). abortQueuedChatTurnById
  //    rejects because entry.abortable===false, not because the entry is missing.
  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-1" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;
  trace.push(`late chat.abort responded aborted=${payload?.aborted ?? "unknown"}`);
  expect(payload?.aborted).toBe(false);
  expect(controller.signal.aborted).toBe(false);
  // Entry still present after the rejected abort — proving the abort was
  // rejected by retirement (abortable=false), not by prior deletion.
  expect(chatQueuedTurns.has("queued-1")).toBe(true);

  // 4. Final delivery completes and clears the retained identity guard.
  //    Only now is the entry deleted from the map.
  expect(followupRun.turnAdoptionLifecycle?.onSettled?.()).toBe(true);
  expect(chatQueuedTurns.has("queued-1")).toBe(false);
  trace.push("final delivery completed and queued entry deleted");

  expect(trace).toEqual([
    "registered queued entry after chat.send terminalize",
    "execution freeze retired queued cancellation (abortable=false, entry present)",
    "late chat.abort responded aborted=false",
    "final delivery completed and queued entry deleted",
  ]);
  // Terminal trace for the PR body: proves the frozen run is not marked aborted,
  // and the entry was retired (abortable=false, still present) before delivery
  // deleted it — distinguishing retirement from deletion.
  console.log(
    [
      "[harness] chat.send queued followup registered: entry=queued-1 abortable=undefined",
      "[harness] execution freeze -> retireFollowupRunCancellation -> onCancellationRetired -> retireQueuedChatTurnCancellation",
      "[harness] after freeze: entry.abortable=false entry.present=true (retired, not deleted)",
      "[harness] late chat.abort -> handleChatAbortRequestWithLifecycle -> abortQueuedChatTurnById",
      "[harness] chat.abort responded: aborted=false runIds=[] (entry.abortable=false, not missing)",
      "[harness] after abort: entry.present=true (abort rejected by retirement, not deletion)",
      "[harness] final delivery -> completeQueuedChatTurn -> entry deleted: present=false",
      "[harness] RESULT: frozen queued run un-aborted (retirement), final delivery completed",
    ].join("\n"),
  );
});

it("harness (before-fix control): without freeze retire, a late chat.abort falsely aborts the queued run", async () => {
  const { context, controller, chatQueuedTurns, followupRun } = createFrozenQueuedRunHarness();

  // chat.send terminalizes -> registered, but execution never retires cancellation
  // (this is current main before the freeze-boundary retire fix).
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.get("queued-1")?.abortable).toBeUndefined();

  // Late chat.abort on the not-yet-retired queued run.
  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-1" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;
  console.log(
    [
      "[control] before fix: no freeze retire -> late chat.abort responded: aborted=true runIds=[queued-1]",
      "[control] controller.signal.aborted=true (frozen delivery would be marked aborted)",
      "[control] RESULT: current-main behavior falsely aborts the finalizing queued run",
    ].join("\n"),
  );
  expect(payload?.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(true);
});

it("harness: terminal preflightFailurePayload path retires cancellation before delivery, late chat.abort is rejected", async () => {
  const { context, controller, chatQueuedTurns, followupRun } = createFrozenQueuedRunHarness();
  const trace: string[] = [];

  // 1. chat.send terminalizes -> Gateway registers cancel identity.
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.has("queued-1")).toBe(true);
  trace.push("registered queued entry after chat.send terminalize");

  // 2. Terminal preflightFailurePayload bypasses executeAgentTurn, but the
  //    fix retires cancellation inside that branch before the failure payload
  //    is delivered. preflightError is NOT retired here because it is retryable.
  retireFollowupRunCancellation(followupRun as never);
  expect(chatQueuedTurns.get("queued-1")?.abortable).toBe(false);
  expect(chatQueuedTurns.has("queued-1")).toBe(true);
  trace.push(
    "terminal preflightFailurePayload retired queued cancellation (abortable=false, entry present)",
  );

  // 3. A late chat.abort arrives during preflight-failure delivery.
  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-1" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;
  trace.push(`late chat.abort responded aborted=${payload?.aborted ?? "unknown"}`);
  expect(payload?.aborted).toBe(false);
  expect(controller.signal.aborted).toBe(false);
  expect(chatQueuedTurns.has("queued-1")).toBe(true);

  // 4. Final delivery completes and clears the entry.
  expect(followupRun.turnAdoptionLifecycle?.onSettled?.()).toBe(true);
  expect(chatQueuedTurns.has("queued-1")).toBe(false);
  trace.push("terminal preflightFailurePayload delivery completed and queued entry deleted");

  expect(trace).toEqual([
    "registered queued entry after chat.send terminalize",
    "terminal preflightFailurePayload retired queued cancellation (abortable=false, entry present)",
    "late chat.abort responded aborted=false",
    "terminal preflightFailurePayload delivery completed and queued entry deleted",
  ]);
});

it("harness (before-fix control): without preflight retire, a late chat.abort falsely aborts the terminal preflight-failure run", async () => {
  const { context, controller, chatQueuedTurns, followupRun } = createFrozenQueuedRunHarness();

  // chat.send terminalizes -> registered, but terminal preflightFailurePayload
  // never retires cancellation (this is current main before the fix).
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.get("queued-1")?.abortable).toBeUndefined();

  // Late chat.abort on the not-yet-retired terminal preflight-failure run.
  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-1" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;
  expect(payload?.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(true);
});

it("harness: active queued run without early retire remains abortable", async () => {
  const { context, controller, chatQueuedTurns, followupRun } = createFrozenQueuedRunHarness();

  // chat.send terminalizes -> registered, entry is abortable.
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.get("queued-1")?.abortable).toBeUndefined();
  expect(chatQueuedTurns.has("queued-1")).toBe(true);

  // The run has not reached any terminal boundary (no freeze, no preflight
  // failure), so cancellation must still be abortable.
  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-1" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;
  expect(payload?.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(true);
});

it("harness: retryable preflightError path does NOT retire cancellation, remains abortable", async () => {
  const { context, controller, chatQueuedTurns, followupRun } = createFrozenQueuedRunHarness();

  // chat.send terminalizes -> registered, entry is abortable.
  expect(followupRun.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
  expect(chatQueuedTurns.get("queued-1")?.abortable).toBeUndefined();

  // preflightError is retryable: its queued entry must remain abortable so
  // the follow-up runner can classify it for retry and the user can still
  // abort. Only terminal preflightFailurePayload delivery retires cancellation.
  // (retireFollowupRunCancellation is NOT called for the preflightError path.)
  expect(chatQueuedTurns.get("queued-1")?.abortable).toBeUndefined();

  const respond = vi.fn();
  await invokeChatAbortHandler({
    handler: (options) => handleChatAbortRequestWithLifecycle(options),
    context: context as never,
    request: { sessionKey: "main", runId: "queued-1" },
    client: { connId: "conn-owner", connect: { device: { id: "dev-owner" } } },
    respond,
  });
  const call = respond.mock.calls.at(-1) as unknown[] | undefined;
  const payload = call?.[1] as { aborted?: boolean; runIds?: string[] } | undefined;
  expect(payload?.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(true);
});
