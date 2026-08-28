import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { handleChatSend } from "./server-methods/chat-send-handler.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./server-methods/types.js";
import {
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const runEmbeddedAgent = vi.spyOn(embeddedAgent, "runEmbeddedAgent");

installGatewayTestHooks({ scope: "suite" });
const temporaryDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:main";
const sessionId = "goal-chat-session";
const client: GatewayClient = {
  connId: "goal-chat-ui",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
  },
};
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let context: GatewayRequestContext;
let storePath: string;
let modelStarted = createDeferred();
let modelRelease: Promise<void> = Promise.resolve();

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  storePath = path.join(temporaryDirs.make("openclaw-goal-chat-"), "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: { main: { sessionId, updatedAt: Date.now(), status: "done" } },
  });
  await prepareGatewayReplyRuntimeForTest({ force: true });
  context = createDirectChatContext({ getRuntimeConfig });
  // Keep reply admission and its cleanup real; only the embedded model execution is mocked.
  gatewayReplyMock.mockImplementation(getReplyFromConfig);
  dispatchInboundMessageMock.mockReset();
  runEmbeddedAgent.mockReset();
  modelStarted = createDeferred();
  modelRelease = Promise.resolve();
  runEmbeddedAgent.mockImplementation(async () => {
    modelStarted.resolve(undefined);
    await modelRelease;
    return {
      payloads: [{ text: "Goal work continued." }],
      meta: {
        durationMs: 0,
        agentMeta: { sessionId, provider: "test", model: "test", usage: { input: 1, output: 1 } },
      },
    };
  });
});

afterEach(() => {
  testState.sessionStorePath = undefined;
  gatewayReplyMock.mockReset();
  runEmbeddedAgent.mockReset();
  clearConfigCache();
});

function scope() {
  return { agentId: "main", sessionKey, sessionId, storePath };
}

function userMessages() {
  return loadTranscriptEventsSync(scope()).flatMap((event) => {
    if (!event || typeof event !== "object" || !("message" in event)) {
      return [];
    }
    const message = event.message;
    return message && typeof message === "object" && "role" in message && message.role === "user"
      ? [message]
      : [];
  });
}

function goalStart(message: string, idempotencyKey: string = randomUUID()) {
  return {
    sessionKey,
    sessionId,
    message,
    idempotencyKey,
    intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
  };
}

async function rpc(
  method: "chat.send" | "chat.history" | "sessions.goal.update",
  params: Record<string, unknown>,
  onResponse?: RespondFn,
) {
  const respond = vi.fn<RespondFn>((...response) => onResponse?.(...response));
  await handleGatewayRequest({
    req: { type: "req", id: "goal-chat-rpc", method, params },
    context,
    client,
    respond,
    isWebchatConnect: () => true,
  });
  return respond;
}

async function waitForDispatchEnd() {
  await getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] });
  expect(context.chatAbortControllers.size).toBe(0);
}

async function waitForModelRun(count = 1) {
  await Promise.race([
    modelStarted.promise,
    getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] }),
  ]);
  expect(context.logGateway.error).not.toHaveBeenCalled();
  expect(runEmbeddedAgent).toHaveBeenCalledTimes(count);
}

describe("Goal chat admission and continuation", () => {
  it.each([
    "/stop",
    "/btw keep this as the objective",
    "/think high",
    "clear the backlog\nKeep /goal pause as literal text.",
  ])("starts literal objective %j with one durable turn before ACK", async (objective) => {
    const release = createDeferred();
    modelRelease = release.promise;
    const request = goalStart(objective);
    let entryAtAck: SessionEntry | undefined;
    let messagesAtAck: ReturnType<typeof userMessages> = [];
    try {
      const first = await rpc("chat.send", request, (ok) => {
        if (ok) {
          entryAtAck = loadSessionEntry(scope());
          messagesAtAck = userMessages();
        }
      });
      expect(first).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started", runId: request.idempotencyKey }),
        undefined,
        expect.anything(),
      );
      expect(entryAtAck?.goal).toMatchObject({ objective, status: "active" });
      expect(messagesAtAck).toEqual([
        expect.objectContaining({ role: "user", content: objective }),
      ]);
      expect(messagesAtAck[0]).not.toHaveProperty("display", false);
      await waitForModelRun();
      expect(runEmbeddedAgent.mock.calls[0]?.[0].prompt).toContain(objective);
      const replay = await rpc("chat.send", request);
      expect(replay).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ replayed: true, goalId: entryAtAck?.goal?.id }),
        undefined,
        expect.anything(),
      );
      expect(userMessages()).toHaveLength(1);
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    } finally {
      release.resolve(undefined);
      await waitForDispatchEnd();
    }
  });

  it("leaves no Goal or turn when the existing session is busy", async () => {
    await patchSessionEntryCore(scope(), () => ({ status: "running" }));
    const result = await rpc("chat.send", goalStart("Finish the release checklist"));
    expect(result).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringMatching(/idle|active|work/i),
      }),
    );
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(userMessages()).toEqual([]);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("rejects a concurrent operation ID collision without acknowledging the wrong objective", async () => {
    const release = createDeferred();
    modelRelease = release.promise;
    const firstRequest = goalStart("Finish the release checklist", "goal-collision");
    const secondRequest = { ...firstRequest, message: "Review the migration plan" };
    try {
      const responses = await Promise.all([
        rpc("chat.send", firstRequest),
        rpc("chat.send", secondRequest),
      ]);
      const accepted = responses.flatMap((response, index) =>
        response.mock.calls[0]?.[0] ? [index] : [],
      );
      expect(accepted).toHaveLength(1);
      const rejected = responses[accepted[0] === 0 ? 1 : 0];
      expect(rejected?.mock.calls[0]).toEqual([
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          details: expect.objectContaining({ reason: "goal-operation-conflict" }),
        }),
      ]);
      const acceptedRequest = [firstRequest, secondRequest][accepted[0]!];
      expect(loadSessionEntry(scope())?.goal?.objective).toBe(acceptedRequest?.message);
      expect(userMessages()).toEqual([
        expect.objectContaining({ content: acceptedRequest?.message }),
      ]);
      await waitForModelRun();
    } finally {
      release.resolve(undefined);
      await waitForDispatchEnd();
    }
  });

  it("releases rejected admission without creating a Goal or transcript row", async () => {
    const params = goalStart("Finish the release checklist");
    const respond = vi.fn<RespondFn>();
    const options: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "goal-admission-rejected", method: "chat.send", params },
      params,
      client,
      context,
      respond,
      isWebchatConnect: () => true,
    };
    await handleChatSend(options, async () => false);
    expect(loadSessionEntry(scope())?.goal).toBeUndefined();
    expect(userMessages()).toEqual([]);
    expect(context.chatAbortControllers.size).toBe(0);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("keeps simultaneous identical Goal retries to one durable turn and dispatch", async () => {
    const release = createDeferred();
    modelRelease = release.promise;
    const request = goalStart("Finish the release checklist", "goal-identical-retry");
    try {
      const responses = await Promise.all([rpc("chat.send", request), rpc("chat.send", request)]);
      expect(responses.some((response) => response.mock.calls[0]?.[0])).toBe(true);
      const goal = loadSessionEntry(scope())?.goal;
      expect(goal?.objective).toBe(request.message);
      for (const response of responses) {
        const [ok, result, error] = response.mock.calls[0]!;
        if (ok) {
          expect(result).toMatchObject({ status: "started", goalId: goal?.id });
        } else {
          expect(error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
        }
      }
      await waitForModelRun();
      const replay = await rpc("chat.send", request);
      expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, goalId: goal?.id });
      expect(userMessages()).toEqual([expect.objectContaining({ content: request.message })]);
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    } finally {
      release.resolve(undefined);
      await waitForDispatchEnd();
    }
  });

  it("does not let ordinary chat displace a Goal reservation with the same run ID", async () => {
    const writerStarted = createDeferred();
    const releaseWriter = createDeferred();
    const writer = runExclusiveSessionStoreWrite(storePath, async () => {
      writerStarted.resolve();
      await releaseWriter.promise;
    });
    await writerStarted.promise;
    const request = goalStart("Finish the release checklist", "goal-chat-collision");
    const goal = rpc("chat.send", request);
    try {
      await vi.waitFor(() =>
        expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true),
      );
      await rpc("chat.send", {
        sessionKey,
        sessionId,
        message: "An ordinary chat message",
        idempotencyKey: request.idempotencyKey,
      });
      releaseWriter.resolve(undefined);
      const result = await goal;
      expect(result.mock.calls[0]?.[0]).toBe(true);
      await waitForModelRun();
      expect(loadSessionEntry(scope())?.goal?.objective).toBe(request.message);
      expect(userMessages()).toEqual([expect.objectContaining({ content: request.message })]);
    } finally {
      releaseWriter.resolve(undefined);
      await Promise.allSettled([writer, goal]);
      await waitForDispatchEnd();
    }
  });

  it("resumes through the real reply pipeline without a visible synthetic user row", async () => {
    const objective = "Finish the release checklist";
    const started = await rpc("chat.send", goalStart(objective));
    expect(started.mock.calls[0]?.[0]).toBe(true);
    await waitForModelRun();
    await waitForDispatchEnd();
    const goal = loadSessionEntry(scope())?.goal;
    expect(goal).toBeDefined();
    await patchSessionEntryCore(scope(), (entry) => ({
      status: "done",
      goal: entry.goal ? { ...entry.goal, status: "paused" } : undefined,
    }));
    const request = {
      sessionKey,
      sessionId,
      goalId: goal?.id,
      action: "resume",
      note: "Prioritize the changelog; keep /stop as quoted text.",
      operationId: "goal-resume",
      issuedAtMs: Date.now(),
    };
    modelStarted = createDeferred();
    const resumed = await rpc("sessions.goal.update", request);
    expect(resumed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started", runId: "goal-resume", goalId: goal?.id }),
      undefined,
      expect.anything(),
    );
    await waitForModelRun(2);
    await waitForDispatchEnd();
    expect(loadSessionEntry(scope())?.goal?.status).toBe("active");
    expect(userMessages()).toEqual([
      expect.objectContaining({ content: objective }),
      expect.objectContaining({
        display: false,
        provenance: expect.objectContaining({ kind: "internal_system" }),
      }),
    ]);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].currentInboundContext?.text).toContain(objective);
    expect(runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain(request.note);
    const history = await rpc("chat.history", { sessionKey });
    expect(history.mock.calls[0]?.[0]).toBe(true);
    const result = history.mock.calls[0]?.[1] as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    expect(result.messages?.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ content: objective }),
    ]);
    const replay = await rpc("sessions.goal.update", request);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, runId: "goal-resume" });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(userMessages()).toHaveLength(2);
  });
});
