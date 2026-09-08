import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
  withSessionTranscriptWriteLock,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { expect, it, vi } from "vitest";
import type { CodexSteeringQueueOptions } from "./attempt-steering.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  queueActiveRunMessageForTest,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";

setupRunAttemptTestHooks();

const prefixText = "Earlier completed answer.";
const steerText = "Use this committed follow-up.";
const codaText = "Completed the steered request.";
const prefix = { id: "prefix", type: "agentMessage", phase: "final_answer", text: prefixText };

async function createFixture() {
  const params = createTestParams();
  await attachSqliteSessionTarget(
    params,
    path.join(tempDir, "steering-settlement.sqlite"),
    "steering-settlement",
  );
  const target = {
    ...params.sessionTarget,
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: expectDefined(params.sessionKey, "steering session key"),
  };
  params.toolAuthorityFingerprint = "steering-settlement-authority";
  params.timeoutMs = 60 * 60_000;
  const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
  const message = {
    role: "user" as const,
    content: steerText,
    timestamp: 1,
    idempotencyKey: "steer-source:user",
  };
  let persisted = false;
  const recorder = {
    message,
    resolveMessage: async () => message,
    getAdmissionReceipt: () => undefined,
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
    hasPersisted: () => persisted,
    persistApproved: vi.fn(async () => {
      if (!persisted) {
        const committed = await appendSessionTranscriptMessageByIdentity({ ...target, message });
        persisted = Boolean(committed);
      }
      return undefined;
    }),
  } satisfies NonNullable<CodexSteeringQueueOptions["userTurnTranscriptRecorder"]>;
  const started = createDeferred<void>();
  const prefixCompleted = createDeferred<void>();
  const abort = new AbortController();
  const onAttemptTimeout = vi.fn();
  params.abortSignal = abort.signal;
  params.onAttemptTimeout = onAttemptTimeout;
  params.onAgentEvent = (event) => {
    if (event.stream === "lifecycle" && event.data.phase === "start") {
      started.resolve();
    }
    if (
      event.stream === "codex_app_server.item" &&
      event.data.phase === "completed" &&
      event.data.itemId === prefix.id
    ) {
      prefixCompleted.resolve();
    }
  };
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params);
  const accepted = vi.fn();
  return {
    params,
    target,
    recorder,
    started,
    abort,
    onAttemptTimeout,
    harness,
    run,
    accepted,
    closeHost,
    completePrefix: async () => {
      await harness.notify(itemNotification("item/started", { ...prefix, text: "" }));
      await harness.notify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: prefix.id, delta: prefixText },
      });
      await harness.notify(itemNotification("item/completed", prefix));
      // Startup can buffer wire receipts before binding projection. The steer
      // follows an observed completed answer, not merely a received frame.
      await prefixCompleted.promise;
    },
    queue: () =>
      queueActiveRunMessageForTest(params.sessionId, steerText, {
        debounceMs: 0,
        isInboundUserMessage: true,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        userTurnTranscriptRecorder: recorder,
        waitForTranscriptCommit: true,
        onQueueAccepted: accepted,
      }),
  };
}

function messageText(message: JsonObject): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return Array.isArray(message.content)
    ? message.content
        .flatMap((block) =>
          isJsonObject(block) && block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("")
    : "";
}

it("seals native steering when terminal receipt arrives behind its queued prefix write", async () => {
  const fixture = await createFixture();
  const release = createDeferred<void>();
  const acquired = createDeferred<void>();
  let writer: Promise<unknown> | undefined;
  let terminal: Promise<unknown> | undefined;
  try {
    await fixture.started.promise;
    await fixture.completePrefix();
    writer = withSessionTranscriptWriteLock(fixture.target, async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const mirror = vi.spyOn(codexTranscriptMirrorRuntime, "mirror");
    expect(fixture.queue()).toBe(true);
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce(), fastWait);
    expect(fixture.recorder.persistApproved).not.toHaveBeenCalled();
    expect(fixture.harness.requests.some((request) => request.method === "turn/steer")).toBe(false);

    terminal = fixture.harness.notify(
      turnCompleted({ id: "turn-1", status: "completed", items: [prefix] }),
    );
    await vi.waitFor(
      () => expect(fixture.accepted).toHaveBeenCalledExactlyOnceWith(false),
      fastWait,
    );
    release.resolve();
    await writer;
    await terminal;
    const result = await fixture.run;

    expect(fixture.harness.requests.some((request) => request.method === "turn/steer")).toBe(false);
    expect(fixture.recorder.persistApproved).not.toHaveBeenCalled();
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
    const messages = (await readSessionTranscriptEvents(fixture.target)).flatMap((event) =>
      isJsonObject(event) && isJsonObject(event.message) ? [event.message] : [],
    );
    expect(messages.filter((message) => messageText(message) === steerText)).toEqual([]);
    expect(messages.filter((message) => messageText(message) === prefixText)).toHaveLength(1);
  } finally {
    release.resolve();
    fixture.abort.abort("test cleanup");
    await Promise.allSettled([
      fixture.run,
      ...(writer ? [writer] : []),
      ...(terminal ? [terminal] : []),
    ]);
    fixture.closeHost();
  }
});

it("keeps one steering prefix and source through degraded tainted native completion", async () => {
  const fixture = await createFixture();
  const release = createDeferred<void>();
  const acquired = createDeferred<void>();
  let writer: Promise<unknown> | undefined;
  const notifications: Promise<unknown>[] = [];
  try {
    await fixture.started.promise;
    await fixture.completePrefix();
    expect(fixture.queue()).toBe(true);
    await vi.waitFor(
      () => expect(fixture.accepted).toHaveBeenCalledExactlyOnceWith(true),
      fastWait,
    );
    const steer = expectDefined(
      fixture.harness.requests.find((request) => request.method === "turn/steer"),
      "native steer",
    );
    expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
    expect(steer.params).toMatchObject({
      input: [{ type: "text", text: steerText, text_elements: [] }],
    });
    const native = expectDefined(
      isJsonObject(steer.params) ? steer.params : undefined,
      "native steer parameters",
    );
    const clientId = expectDefined(
      typeof native.clientUserMessageId === "string" ? native.clientUserMessageId : undefined,
      "native steer correlation",
    );
    await fixture.harness.notify(
      itemNotification("item/completed", {
        id: "steered-user",
        type: "userMessage",
        clientId,
      }),
    );
    const before = (await readSessionTranscriptEvents(fixture.target)).flatMap((event) =>
      isJsonObject(event) && isJsonObject(event.message) ? [messageText(event.message)] : [],
    );
    expect(before.filter((text) => text === prefixText || text === steerText)).toEqual([
      prefixText,
      steerText,
    ]);

    writer = withSessionTranscriptWriteLock(fixture.target, async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const mirror = vi.spyOn(codexTranscriptMirrorRuntime, "mirror");
    vi.useFakeTimers();
    notifications.push(
      fixture.harness.notify(
        itemNotification("item/completed", {
          id: "checkpoint-command",
          type: "commandExecution",
          command: "echo saved",
          cwd: fixture.params.workspaceDir,
          commandActions: [],
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: "saved",
          exitCode: 0,
          durationMs: 1,
        }),
      ),
    );
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledOnce(), fastWait);
    notifications.push(
      fixture.harness.notify(
        itemNotification("item/completed", {
          id: "queued-search",
          type: "webSearch",
          query: "synthetic result",
          action: { type: "search", query: "synthetic result" },
          results: null,
        }),
      ),
    );
    const receivedAt = Date.now();
    notifications.push(
      fixture.harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "completed",
          items: [
            prefix,
            { id: "coda", type: "agentMessage", phase: "final_answer", text: codaText },
          ],
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(
      receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now(),
    );
    await vi.advanceTimersByTimeAsync(1);
    release.resolve();
    await writer;
    const settled = vi.fn();
    void fixture.run.then(settled, settled);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
    const result = await fixture.run;
    vi.useRealTimers();

    expect(result.terminal).toMatchObject({
      kind: "ok",
      settlementWarning: {
        pendingStage: "transcript/checkpoint",
        timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      },
    });
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
    expect(result.codexAppServerFailure).toBeUndefined();
    expect(result.lastAssistant?.stopReason).toBe("stop");
    expect(fixture.onAttemptTimeout).not.toHaveBeenCalled();
    expect(fixture.recorder.persistApproved).toHaveBeenCalledOnce();
    expect(
      fixture.harness.requests.filter((request) => request.method === "turn/steer"),
    ).toHaveLength(1);
    const messages = (await readSessionTranscriptEvents(fixture.target)).flatMap((event) =>
      isJsonObject(event) && isJsonObject(event.message) ? [event.message] : [],
    );
    expect(
      messages.map(messageText).filter((text) => [prefixText, steerText, codaText].includes(text)),
    ).toEqual([prefixText, steerText, codaText]);
    expect(messages.find((message) => messageText(message) === codaText)).toMatchObject({
      stopReason: "stop",
      __openclaw: { turnTainted: true, settlementWarning: expect.any(Object) },
    });
    expect(resolveActiveEmbeddedRunSessionId(fixture.target.sessionKey)).toBeUndefined();
  } finally {
    release.resolve();
    fixture.abort.abort("test cleanup");
    vi.useRealTimers();
    await Promise.allSettled([fixture.run, ...notifications, ...(writer ? [writer] : [])]);
    fixture.closeHost();
  }
});
