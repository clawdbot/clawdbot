import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as subagentKill from "../agents/subagents/registry/subagent-control-kill.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentRunQueued } from "../agents/subagents/registry/subagent-registry-read.js";
import { loadSubagentSessionListRunsFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  claimSubagentRunKill,
  registerSubagentRun,
  releaseSubagentRun,
  releaseSubagentRunKillClaim,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  activateSwarmRun,
  holdQueuedSwarmRun,
  releaseSwarmRun,
  removeQueuedSwarmRun,
  reserveSwarmRun,
} from "../agents/subagents/swarm/swarm-scheduler.js";
import { testing as schedulerTesting } from "../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { handleChatAbortRequest } from "./server-methods/chat-abort-handler.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { handleChatSend } from "./server-methods/chat-send-handler.js";
import { prepareAndAdmitChatSend } from "./server-methods/chat-send-setup.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { sessionAbortHandlers } from "./server-methods/sessions-abort.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";
import { useQueuedCollectorFixture } from "./session-utils.queued-collector.test-support.js";

const {
  parentKey,
  launchedRunIds,
  requestContext,
  operatorClient,
  listChildren,
  spawnCollectors,
  createQueuedReservation,
  observeLifecycle,
} = useQueuedCollectorFixture();

async function expectUnstartedChildHistory(
  context: GatewayRequestContext,
  sessionKey: string,
  activeRunIds: string[],
) {
  const respond = vi.fn();
  await expectDefined(
    chatHistoryHandlers["chat.history"],
    "chat.history handler",
  )({
    req: { type: "req", id: "queued-history", method: "chat.history" },
    params: { sessionKey, agentId: "main", offset: 0, limit: 20 },
    client: operatorClient(),
    isWebchatConnect: () => false,
    respond,
    context,
  });
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      messages: [],
      hasMore: false,
      totalMessages: 0,
      sessionInfo: expect.objectContaining({
        hasActiveRun: activeRunIds.length > 0,
        activeRunIds,
        status: activeRunIds.length > 0 ? "queued" : "killed",
      }),
    }),
  );
  const payload = respond.mock.calls[0]?.[1];
  expect(payload).not.toHaveProperty("inFlightRun");
  expect(payload?.sessionInfo.startedAt).toBeUndefined();
  expect(payload?.sessionInfo.runtimeMs).toBeUndefined();
}

describe("queued collector session projection", () => {
  it("lists both labeled collectors before the second launches without inventing its runtime", async () => {
    const context = requestContext();
    const broadcast = vi.fn();
    observeLifecycle(
      createLifecycleEventBroadcastHandler({
        broadcastToConnIds: broadcast,
        sessionEventSubscribers: { getAll: () => new Set(["observer"]) },
        chatAbortControllers: context.chatAbortControllers,
      }),
    );
    const results = await spawnCollectors();
    const first = expectDefined(results[0], "first collector");
    const second = expectDefined(results[1], "second collector");
    expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"]);
    await vi.waitFor(() => expect(launchedRunIds).toEqual([first.runId]));
    try {
      const rows = (await listChildren(context)).sessions;
      expect(rows.map((row) => row.key).toSorted()).toEqual(
        results
          .map((result) => expectDefined(result.childSessionKey, "accepted child key"))
          .toSorted(),
      );
      for (const [index, result] of results.entries()) {
        const row = expectDefined(
          rows.find((candidate) => candidate.key === result.childSessionKey),
          "collector session row",
        );
        expect.soft(row).toMatchObject({
          label: index === 0 ? "Collector A" : "Collector B",
          swarmGroupId: `swarm:${parentKey}:parent-turn`,
          subagentRunState: "active",
          hasActiveRun: true,
          status: index === 0 ? "running" : "queued",
        });
      }
      const queued = expectDefined(
        rows.find((row) => row.key === second.childSessionKey),
        "queued child",
      );
      expect.soft(queued.startedAt).toBeUndefined();
      expect.soft(queued.runtimeMs).toBeUndefined();
      expect(queued.activeRunIds).toEqual([second.runId]);
      await expectUnstartedChildHistory(context, queued.key, [second.runId!]);
      const created = broadcast.mock.calls.find(
        ([, event]) => event.sessionKey === second.childSessionKey && event.reason === "create",
      )?.[1];
      expect.soft(created).toMatchObject({
        label: "Collector B",
        swarmGroupId: `swarm:${parentKey}:parent-turn`,
        subagentRunState: "active",
        hasActiveRun: true,
        status: "queued",
      });
      expect.soft(created?.startedAt).toBeUndefined();
      expect.soft(created?.runtimeMs).toBeUndefined();
      expect
        .soft(rows.filter((row) => row.swarmGroupId === queued.swarmGroupId && row.hasActiveRun))
        .toHaveLength(2);

      const stopResponse = vi.fn();
      await expectDefined(
        sessionAbortHandlers["sessions.abort"],
        "sessions.abort handler",
      )({
        req: { type: "req", id: "stop-queued-child", method: "sessions.abort" },
        params: { key: second.childSessionKey, agentId: "main", clearQueued: true },
        client: operatorClient(),
        isWebchatConnect: () => false,
        context,
        respond: stopResponse,
      });
      expect(stopResponse).toHaveBeenCalledWith(
        true,
        { ok: true, status: "aborted", abortedRunId: second.runId },
        undefined,
        undefined,
      );
      releaseSwarmRun(first.runId!);
      const stopped = (await listChildren(context)).sessions.find(
        (row) => row.key === second.childSessionKey,
      );
      expect(stopped).toMatchObject({
        label: "Collector B",
        status: "killed",
        hasActiveRun: false,
      });
      expect(stopped?.startedAt).toBeUndefined();
      expect(stopped?.runtimeMs).toBeUndefined();
      await expectUnstartedChildHistory(context, queued.key, []);
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          sessionKey: queued.key,
          reason: "abort",
          status: "killed",
          hasActiveRun: false,
          activeRunIds: [],
        }),
        new Set(["observer"]),
        expect.any(Object),
      );
      expect(launchedRunIds).toEqual([first.runId]);
    } finally {
      removeQueuedSwarmRun(second.runId!);
      releaseSwarmRun(first.runId!);
    }
  });

  it("preserves an operator rename when a queued collector reaches agent dispatch", async () => {
    const context = requestContext();
    const [first, second] = await spawnCollectors();
    const queued = expectDefined(
      (await listChildren(context)).sessions.find((row) => row.key === second!.childSessionKey),
      "queued row",
    );
    const respond = vi.fn();
    await expectDefined(
      sessionMutationHandlers["sessions.patch"],
      "sessions.patch handler",
    )({
      req: { type: "req", id: "rename-queued", method: "sessions.patch" },
      params: {
        key: queued.key,
        expectedSessionId: queued.sessionId,
        label: "Operator renamed collector",
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        entry: expect.objectContaining({ label: "Operator renamed collector" }),
      }),
      undefined,
    );
    releaseSwarmRun(first!.runId!);
    await vi.waitFor(() => expect(launchedRunIds).toEqual([first!.runId, second!.runId]));
    const running = (await listChildren(context)).sessions.find((row) => row.key === queued.key);
    expect(running).toMatchObject({
      label: "Operator renamed collector",
      status: "running",
      hasActiveRun: true,
    });
  });

  it("keeps native spawn's normalized duplicate-label contract", async () => {
    const label = `  ${"Shared collector title ".repeat(4)}  `;
    await spawnCollectors([label, label]);
    expect((await listChildren(requestContext())).sessions.map((row) => row.label)).toEqual([
      label.trim(),
      label.trim(),
    ]);
  });

  it("keeps preactivation and held cancellation reservations pending until withdrawal", async () => {
    const { entry } = await createQueuedReservation();
    const context = requestContext();
    const expectPreparing = async () => {
      expect(isSubagentRunQueued(entry)).toBe(true);
      expect(
        resolveVisibleActiveSessionRunState({
          context,
          requestedKey: entry.childSessionKey,
          canonicalKey: entry.childSessionKey,
        }),
      ).toEqual({ active: true, runIds: [entry.runId] });
      expect((await listChildren(context)).sessions).toEqual([
        expect.objectContaining({
          status: "running",
          hasActiveRun: true,
          activeRunIds: [entry.runId],
        }),
      ]);
    };
    await expectPreparing();
    expect(
      resolveVisibleActiveSessionRunState({
        context,
        requestedKey: entry.childSessionKey,
        canonicalKey: entry.childSessionKey,
        agentId: "other",
      }),
    ).toEqual({ active: false, runIds: [] });
    const hold = expectDefined(holdQueuedSwarmRun(entry.runId), "queued hold");
    const start = vi.fn(async () => {});
    try {
      activateSwarmRun({
        groupId: entry.groupId!,
        runId: entry.runId,
        start,
        onStartFailure: () => true,
      });
      const session = expectDefined(
        loadGatewaySessionEntryReadOnly(entry.childSessionKey).entry,
        "created session",
      );
      const claim = expectDefined(
        claimSubagentRunKill({
          runId: entry.runId,
          expected: entry,
          sessionId: session.sessionId,
          sessionLifecycleRevision: session.lifecycleRevision,
        }),
        "kill claim",
      );
      await expectPreparing();
      expect(start).not.toHaveBeenCalled();
      releaseSubagentRunKillClaim({ runId: entry.runId, expected: entry, claim });
      expect(hold.withdraw()).toBe(true);
      expect(isSubagentRunQueued(entry)).toBe(false);
      expect((await listChildren(context)).sessions[0]?.hasActiveRun).toBe(false);
    } finally {
      hold.release();
    }
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects stale copies, replaced owners, and lost reservations without losing compact status", async () => {
    const { entry, registration } = await createQueuedReservation();
    const compact = expectDefined(
      loadSubagentSessionListRunsFromSqlite().get(entry.runId),
      "compact queued record",
    );
    expect(compact.execution).toEqual({ status: "queued" });
    expect(compact.sessionStartedAt).toBeUndefined();
    expect(isSubagentRunQueued(compact)).toBe(false);
    expect(isSubagentRunQueued(structuredClone(entry))).toBe(false);

    registerSubagentRun(registration);
    const replacement = expectDefined(subagentRuns.get(entry.runId), "replacement record");
    expect(replacement).not.toBe(entry);
    expect(isSubagentRunQueued(entry)).toBe(false);
    expect(isSubagentRunQueued(replacement)).toBe(false);
    expect((await listChildren(requestContext())).sessions[0]?.hasActiveRun).toBe(false);

    removeQueuedSwarmRun(entry.runId);
    reserveSwarmRun({
      runId: entry.runId,
      groupId: entry.groupId!,
      maxConcurrent: 1,
      activeRunIds: [],
    });
    registerSubagentRun(registration);
    const current = expectDefined(subagentRuns.get(entry.runId), "new reservation owner");
    expect(isSubagentRunQueued(current)).toBe(true);
    schedulerTesting.reset();
    expect(isSubagentRunQueued(current)).toBe(false);
    expect((await listChildren(requestContext())).sessions[0]?.hasActiveRun).toBe(false);
  });

  it.each([false, true])(
    "allows the exact queued-child requester or administrator (admin=%s)",
    async (admin) => {
      const { entry } = await createQueuedReservation();
      const unrelated = await createQueuedReservation("unrelated");
      const respond = vi.fn();
      await expectDefined(
        sessionAbortHandlers["sessions.abort"],
        "sessions.abort handler",
      )({
        req: { type: "req", id: "exact-queued-stop", method: "sessions.abort" },
        params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
        client: operatorClient(admin ? "administrator" : "parent-requester", admin),
        isWebchatConnect: () => false,
        context: requestContext(),
        respond,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        { ok: true, status: "aborted", abortedRunId: entry.runId },
        undefined,
        undefined,
      );
      expect(entry.collectorCompletion?.status).toBe("killed");
      expect(entry.execution.startedAt).toBeUndefined();
      expect(isSubagentRunQueued(unrelated.entry)).toBe(true);
      expect(launchedRunIds).toEqual([]);
    },
  );

  it.each(["replacement", "retirement"])(
    "publishes queued Stop before the kill result handoff permits %s",
    async (handoff) => {
      const { entry, registration } = await createQueuedReservation();
      const context = requestContext();
      const order: string[] = [];
      vi.mocked(context.broadcastToConnIds).mockImplementation(() => {
        expect(subagentRuns.get(entry.runId)).toBe(entry);
        order.push("published");
      });
      const kill = subagentKill.killSubagentRunAdmin;
      const spy = vi
        .spyOn(subagentKill, "killSubagentRunAdmin")
        .mockImplementation(async (...args) => {
          const result = await kill(...args);
          // Real cancellation is complete; an awaited consumer can now observe
          // another owner before it consumes the predecessor's result.
          releaseSubagentRun(entry.runId);
          if (handoff === "replacement") {
            reserveSwarmRun({
              runId: entry.runId,
              groupId: entry.groupId!,
              maxConcurrent: 1,
              activeRunIds: [],
            });
            registerSubagentRun(registration);
          }
          order.push(handoff);
          return result;
        });
      try {
        const respond = vi.fn();
        await expectDefined(
          sessionAbortHandlers["sessions.abort"],
          "sessions.abort handler",
        )({
          req: { type: "req", id: "publication-queued-stop", method: "sessions.abort" },
          params: { key: entry.childSessionKey },
          client: operatorClient(),
          isWebchatConnect: () => false,
          context,
          respond,
        });
        expect(order).toEqual(["published", handoff]);
        expect(respond).toHaveBeenCalledWith(
          true,
          { ok: true, status: "aborted", abortedRunId: entry.runId },
          undefined,
          undefined,
        );
        expect(context.broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ status: "killed", hasActiveRun: false, activeRunIds: [] }),
          new Set(["observer"]),
          expect.any(Object),
        );
        if (handoff === "replacement") {
          const successor = subagentRuns.get(entry.runId);
          expect(successor).not.toBe(entry);
          expect(isSubagentRunQueued(successor)).toBe(true);
          expect(successor?.execution.endedAt).toBeUndefined();
        }
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([
    "foreign requester",
    "parent replaced",
    "parent closed",
    "parent settled",
    "parent lifecycle retired",
    "session access revoked",
    "reservation withdrawn",
    "registry replaced",
  ])("rejects queued-child Stop when %s", async (failure) => {
    const { entry, registration } = await createQueuedReservation();
    const unrelated = await createQueuedReservation("unrelated");
    const context = requestContext();
    const parent = expectDefined(
      context.chatAbortControllers.get("parent-turn"),
      "parent admission",
    );
    let authorizationObserved = false;
    let accessRevoked = false;
    const assertCurrent = () => {
      if (!authorizationObserved) {
        authorizationObserved = true;
        queueMicrotask(() => {
          if (failure === "parent replaced") {
            context.chatAbortControllers.set("parent-turn", { ...parent });
          }
          if (failure === "parent closed") {
            parent.controller.abort();
          }
          if (failure === "parent settled") {
            parent.isAbortable = () => false;
          }
          if (failure === "parent lifecycle retired") {
            parent.lifecycleGeneration = "retired";
          }
          if (failure === "session access revoked") {
            accessRevoked = true;
          }
          if (failure === "reservation withdrawn") {
            removeQueuedSwarmRun(entry.runId);
          }
          if (failure === "registry replaced") {
            registerSubagentRun(registration);
          }
        });
      }
      if (accessRevoked) {
        throw new Error("Session mutation authorization changed");
      }
    };
    const respond = vi.fn();
    await expectDefined(
      sessionAbortHandlers["sessions.abort"],
      "sessions.abort handler",
    )({
      req: { type: "req", id: "forbidden-queued-stop", method: "sessions.abort" },
      params: { key: entry.childSessionKey, runId: entry.runId, agentId: "main" },
      client: operatorClient(
        failure === "foreign requester" ? "other-requester" : "parent-requester",
      ),
      isWebchatConnect: () => false,
      context,
      respond,
      sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(entry.execution.endedAt).toBeUndefined();
    expect(entry.collectorCompletion).toBeUndefined();
    expect(isSubagentRunQueued(unrelated.entry)).toBe(true);
    expect(launchedRunIds).toEqual([]);
  });

  it.each(["parent requester", "foreign requester", "session access revoked", "parent replaced"])(
    "applies full-session typed Stop to the queued child: %s",
    async (scenario) => {
      const { entry } = await createQueuedReservation();
      const unrelated = await createQueuedReservation("unrelated");
      const context = requestContext();
      let checked = false;
      let revoked = false;
      const assertCurrent = () => {
        if (!checked) {
          checked = true;
          queueMicrotask(() => {
            if (scenario === "session access revoked") {
              revoked = true;
            }
            if (scenario === "parent replaced") {
              const parent = context.chatAbortControllers.get("parent-turn")!;
              context.chatAbortControllers.set("parent-turn", { ...parent });
            }
          });
        }
        if (revoked) {
          throw new Error("Session access changed");
        }
      };
      const respond = vi.fn();
      await handleChatSend({
        req: { type: "req", id: "typed-queued-stop", method: "chat.send" },
        params: {
          sessionKey: entry.childSessionKey,
          message: "/stop",
          idempotencyKey: "typed-stop",
        },
        client: operatorClient(
          scenario === "foreign requester" ? "other-requester" : "parent-requester",
        ),
        context,
        respond,
        isWebchatConnect: () => false,
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: assertCurrent },
      });
      if (scenario === "parent requester") {
        expect(respond).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [entry.runId],
        });
        expect(entry.collectorCompletion?.status).toBe("killed");
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: expect.any(String) }),
        );
        expect(entry.execution.endedAt).toBeUndefined();
        expect(isSubagentRunQueued(entry)).toBe(true);
      }
      expect(isSubagentRunQueued(unrelated.entry)).toBe(true);
      expect(launchedRunIds).toEqual([]);
    },
  );

  it("keeps the controlling parent authoritative when native completion routing differs", async () => {
    const completionOwner = "agent:main:dashboard:completion-recipient";
    const context = requestContext();
    const [, second] = await spawnCollectors(undefined, completionOwner);
    const entry = expectDefined(subagentRuns.get(second!.runId!), "proxied queued collector");
    expect(entry).toMatchObject({
      controllerSessionKey: parentKey,
      requesterSessionKey: completionOwner,
      swarmRequesterSessionKey: parentKey,
    });
    const respond = vi.fn();
    await sessionAbortHandlers["sessions.abort"]!({
      req: { type: "req", id: "proxied-stop", method: "sessions.abort" },
      params: { key: entry.childSessionKey, runId: entry.runId },
      context,
      respond,
      client: operatorClient(),
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      { ok: true, status: "aborted", abortedRunId: entry.runId },
      undefined,
      undefined,
    );
    expect(entry.collectorCompletion?.status).toBe("killed");
  });

  it.each(
    [
      { method: "sessions.abort", exact: false },
      { method: "sessions.abort", exact: true },
      { method: "chat.send", exact: false },
    ].flatMap((request) =>
      (["owned", "foreign", "parent-retired", "mixed"] as const)
        .filter((scenario) => !request.exact || scenario === "owned" || scenario === "foreign")
        .map((scenario) => ({ method: request.method, exact: request.exact, scenario })),
    ),
  )(
    "coordinates queued Stop with a real coexisting chat admission: $method exact=$exact $scenario",
    async ({ method, exact, scenario }) => {
      const foreign = scenario === "foreign";
      const { entry } = await createQueuedReservation();
      const context = requestContext();
      const extraRunId = "additional-admitted-chat";
      const admitOrdinaryChat = async (runId: string, ownerConnId: string) => {
        const prepared = expectDefined(
          await prepareAndAdmitChatSend({
            params: {
              sessionKey: entry.childSessionKey,
              message: "Additional child input",
              idempotencyKey: runId,
            },
            context,
            respond: vi.fn(),
            client: operatorClient(ownerConnId),
          }),
          "ordinary chat admission while collector is queued",
        );
        return prepared.admitted.value;
      };
      const admission = await admitOrdinaryChat(
        extraRunId,
        foreign ? "other-requester" : "parent-requester",
      );
      const foreignRunId = "foreign-admitted-chat";
      const foreignAdmission =
        scenario === "mixed" ? await admitOrdinaryChat(foreignRunId, "other-requester") : undefined;
      admission.activeRunAbort.markExecutionStarted();
      context.chatRunState.getOrCreate(extraRunId).buffer = "Additional run partial";
      const cleanup = () => {
        admission.cleanupAdmittedRun();
        clearAgentRunContext(extraRunId);
      };
      admission.activeRunAbort.controller.signal.addEventListener(
        "abort",
        () =>
          queueMicrotask(() => {
            if (scenario === "parent-retired") {
              context.chatAbortControllers.delete("parent-turn");
            }
            cleanup();
          }),
        { once: true },
      );
      expect(context.chatAbortControllers.get(extraRunId)).toBe(admission.activeRunAbort.entry);
      expect(isSubagentRunQueued(entry)).toBe(true);
      try {
        const respond = vi.fn();
        const options = {
          req: { type: "req" as const, id: "coexisting-stop", method },
          params:
            method === "sessions.abort"
              ? {
                  key: entry.childSessionKey,
                  ...(exact ? { runId: entry.runId } : { clearQueued: true }),
                }
              : {
                  sessionKey: entry.childSessionKey,
                  message: "/stop",
                  idempotencyKey: "typed-stop",
                },
          context,
          respond,
          client: operatorClient(),
          isWebchatConnect: () => false,
        };
        if (method === "sessions.abort") {
          await sessionAbortHandlers["sessions.abort"]!(options);
        } else {
          await handleChatSend(options);
        }
        const stopped = !foreign && !exact;
        const collectorStopped = stopped && scenario === "owned";
        expect.soft(respond.mock.calls[0]?.[0]).toBe(collectorStopped);
        if (foreignAdmission) {
          expect(foreignAdmission.activeRunAbort.controller.signal.aborted).toBe(false);
          expect(context.chatAbortControllers.get(foreignRunId)).toBe(
            foreignAdmission.activeRunAbort.entry,
          );
          expect
            .soft(respond)
            .toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ code: "UNAVAILABLE" }),
            );
        }
        expect.soft(admission.activeRunAbort.controller.signal.aborted).toBe(stopped);
        expect.soft(isSubagentRunQueued(entry)).toBe(!collectorStopped);
        expect.soft(context.chatRunState.hasAbortMarker(extraRunId)).toBe(stopped);
        if (scenario === "parent-retired") {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              message: expect.stringContaining("Unauthorized queued collector Stop"),
            }),
          );
        }
        expect
          .soft(admission.activeRunAbort.entry?.abortStopReason)
          .toBe(stopped ? (method === "chat.send" ? "stop" : "rpc") : undefined);
        const session = loadGatewaySessionEntryReadOnly(entry.childSessionKey);
        const events = await loadTranscriptEvents({
          agentId: "main",
          storePath: session.storePath,
          sessionKey: entry.childSessionKey,
          sessionId: session.entry!.sessionId,
        });
        if (stopped) {
          expect(events).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({
                content: [{ type: "text", text: "Additional run partial" }],
                openclawAbort: expect.objectContaining({ runId: extraRunId, aborted: true }),
              }),
            }),
          );
        } else {
          expect(events).toEqual([]);
        }
        expect(launchedRunIds).toEqual([]);
      } finally {
        cleanup();
        if (foreignAdmission) {
          foreignAdmission.cleanupAdmittedRun();
          clearAgentRunContext(foreignRunId);
        }
      }
    },
  );

  it.each([undefined, "reserved-collector"])(
    "keeps ordinary chat.abort (%s) and mismatched exact Stop from consuming a collector",
    async (runId) => {
      const { entry } = await createQueuedReservation();
      const context = requestContext();
      const chatResponse = vi.fn();
      await handleChatAbortRequest({
        req: { type: "req", id: "ordinary-chat-stop", method: "chat.abort" },
        params: { sessionKey: entry.childSessionKey, ...(runId ? { runId } : {}) },
        client: operatorClient(),
        isWebchatConnect: () => false,
        context,
        respond: chatResponse,
      });
      expect(chatResponse).toHaveBeenCalledWith(true, { ok: true, aborted: false, runIds: [] });
      const sessionResponse = vi.fn();
      await expectDefined(
        sessionAbortHandlers["sessions.abort"],
        "sessions.abort handler",
      )({
        req: { type: "req", id: "wrong-exact-stop", method: "sessions.abort" },
        params: { key: entry.childSessionKey, runId: "other-run", agentId: "main" },
        client: operatorClient(),
        isWebchatConnect: () => false,
        context,
        respond: sessionResponse,
      });
      expect(sessionResponse).toHaveBeenCalledWith(
        true,
        { ok: true, status: "no-active-run", abortedRunId: null },
        undefined,
        undefined,
      );
      expect(isSubagentRunQueued(entry)).toBe(true);
    },
  );
});
