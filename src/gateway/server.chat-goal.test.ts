import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  listSessionParticipantsReadOnly,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
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
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";

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
  runEmbeddedAgent.mockImplementation(async (params) => {
    modelStarted.resolve(undefined);
    await modelRelease;
    return {
      payloads: [{ text: "Goal work continued." }],
      meta: {
        durationMs: 0,
        agentMeta: {
          sessionId: params.sessionId,
          provider: "test",
          model: "test",
          usage: { input: 1, output: 1 },
        },
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
  const transcriptScope = {
    ...scope(),
    sessionId: loadSessionEntry(scope())?.sessionId ?? sessionId,
  };
  return loadTranscriptEventsSync(transcriptScope).flatMap((event) => {
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

function freshGoalStart(message: string, idempotencyKey?: string) {
  const { sessionId: _sessionId, ...request } = goalStart(message, idempotencyKey);
  return request;
}

async function useFreshSessionStore() {
  storePath = path.join(temporaryDirs.make("openclaw-fresh-goal-chat-"), "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({ entries: {} });
  await prepareGatewayReplyRuntimeForTest({ force: true });
  expect(loadSessionEntry(scope())).toBeUndefined();
}

function installReplyDispatchHook(eligibleDispatchKinds?: readonly ["acp"]) {
  const handler = vi.fn(async () => ({
    handled: true,
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  }));
  const registry = getTestPluginRegistry();
  registry.typedHooks.push({
    pluginId: "goal-dispatch-fixture",
    hookName: "reply_dispatch",
    handler,
    ...(eligibleDispatchKinds ? { eligibleDispatchKinds } : {}),
    source: "test",
  });
  initializeGlobalHookRunner(registry);
  return handler;
}

async function rpc(
  method: "chat.send" | "chat.history" | "sessions.goal.update",
  params: Record<string, unknown>,
  onResponse?: RespondFn,
  requestClient: GatewayClient = client,
) {
  const respond = vi.fn<RespondFn>((...response) => onResponse?.(...response));
  await handleGatewayRequest({
    req: { type: "req", id: "goal-chat-rpc", method, params },
    context,
    client: requestClient,
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
  expect(
    runEmbeddedAgent.mock.calls,
    JSON.stringify(vi.mocked(context.logGateway.warn).mock.calls),
  ).toHaveLength(count);
}

describe("Goal chat admission and continuation", () => {
  it("starts the first message as a Goal with an ACP-scoped hook and replays without a second session or run", async () => {
    await useFreshSessionStore();
    const acpDispatch = installReplyDispatchHook(["acp"]);
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const profile = ensureProfileForEmail("goal-first-message@example.test");
    const requestClient: GatewayClient = {
      ...client,
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
    };
    const request = freshGoalStart("Review the sample backlog", sessionId);
    const release = createDeferred();
    modelRelease = release.promise;
    let entryAtAck: SessionEntry | undefined;
    let messagesAtAck: ReturnType<typeof userMessages> = [];
    const creationEvents = () =>
      listSessionStateEventsSince(sessionKey, "main", 0).events.filter(
        (event) =>
          event.sessionId === entryAtAck?.sessionId &&
          (event.kind === "created" || event.kind === "goal_changed"),
      );
    let eventsAtAck: ReturnType<typeof creationEvents> = [];
    try {
      const started = await rpc(
        "chat.send",
        request,
        (ok) => {
          if (ok) {
            entryAtAck = loadSessionEntry(scope());
            messagesAtAck = userMessages();
            eventsAtAck = creationEvents();
          }
        },
        requestClient,
      );
      expect(started.mock.calls[0]).toEqual([
        true,
        expect.objectContaining({ status: "started", runId: sessionId }),
        undefined,
        expect.anything(),
      ]);
      expect(entryAtAck).toMatchObject({
        sessionId: expect.any(String),
        status: "running",
        goal: { objective: request.message, status: "active" },
      });
      expect(entryAtAck?.sessionId).not.toBe(request.idempotencyKey);
      expect(messagesAtAck).toEqual([expect.objectContaining({ content: request.message })]);
      expect(eventsAtAck.map((event) => event.kind)).toEqual(["created", "goal_changed"]);
      await waitForModelRun();
      context.dedupe.clear();
      const replay = await rpc("chat.send", request, undefined, requestClient);
      expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, runId: sessionId });
      expect(userMessages()).toHaveLength(1);
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(creationEvents()).toEqual(eventsAtAck);
      expect(acpDispatch).not.toHaveBeenCalled();
    } finally {
      release.resolve(undefined);
      await waitForDispatchEnd();
    }
  });

  it("keeps an unscoped reply-dispatch hook from admitting a fresh Goal", async () => {
    await useFreshSessionStore();
    const dispatch = installReplyDispatchHook();
    const response = await rpc("chat.send", freshGoalStart("Wait for a replay-safe dispatch"));
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("recoverable history"),
    });
    expect(loadSessionEntry(scope())).toBeUndefined();
    expect(userMessages()).toEqual([]);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.size).toBe(0);
  });

  it("does not revive another deleted session's retained window through a Goal retry ID", async () => {
    await useFreshSessionStore();
    const retainedScope = {
      ...scope(),
      sessionKey: "agent:main:retained-goal-history",
      sessionId: randomUUID(),
    };
    await replaceSessionEntry(retainedScope, {
      sessionId: retainedScope.sessionId,
      updatedAt: Date.now(),
    });
    await appendTranscriptMessage(retainedScope, {
      message: { role: "user", content: "Keep this deleted conversation's history unchanged." },
    });
    await deleteSessionEntryLifecycle({
      agentId: retainedScope.agentId,
      storePath,
      target: { canonicalKey: retainedScope.sessionKey, storeKeys: [retainedScope.sessionKey] },
      archiveTranscript: false,
    });
    expect(loadSessionEntry(retainedScope)).toBeUndefined();
    const retainedEvents = loadTranscriptEventsSync(retainedScope);
    expect(retainedEvents.length).toBeGreaterThan(0);
    const request = freshGoalStart("Start a separate Goal", retainedScope.sessionId);
    const release = createDeferred();
    modelRelease = release.promise;
    try {
      const response = await rpc("chat.send", request);
      expect(response.mock.calls[0]?.[0]).toBe(true);
      const created = loadSessionEntry(scope());
      expect(created?.sessionId).toEqual(expect.any(String));
      expect(created?.sessionId).not.toBe(retainedScope.sessionId);
      expect(created?.goal?.objective).toBe(request.message);
      expect(userMessages()).toEqual([expect.objectContaining({ content: request.message })]);
      expect(loadSessionEntry(retainedScope)).toBeUndefined();
      expect(loadTranscriptEventsSync(retainedScope)).toEqual(retainedEvents);
      await waitForModelRun();
    } finally {
      release.resolve(undefined);
      await waitForDispatchEnd();
    }
  });

  it("rejects a supplied stale session ID instead of creating a fresh Goal", async () => {
    await useFreshSessionStore();
    const response = await rpc("chat.send", goalStart("Do not recreate the old session"));
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
    expect(loadSessionEntry(scope())).toBeUndefined();
    expect(userMessages()).toEqual([]);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.size).toBe(0);
  });

  it.each(["creation revoked", "sandbox now required"] as const)(
    "leaves no fresh Goal when %s after admission",
    async (change) => {
      await useFreshSessionStore();
      const profile = ensureProfileForEmail(`goal-${change.replaceAll(" ", "-")}@example.test`);
      const requestClient: GatewayClient = {
        ...client,
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      const initialConfig = context.getRuntimeConfig();
      const nextConfig: OpenClawConfig = {
        ...initialConfig,
        gateway: {
          ...initialConfig.gateway,
          roles: {
            default: "goal-operator",
            definitions: {
              "goal-operator": {
                agents: change === "creation revoked" ? [] : ["main"],
                sessions: { others: "write" },
                scopes: ["operator.read", "operator.write"],
                ...(change === "sandbox now required" ? { sandbox: "required" as const } : {}),
              },
            },
          },
        },
      };
      const params = freshGoalStart("Only start under the current creator policy");
      const respond = vi.fn<RespondFn>();
      await handleChatSend(
        {
          req: { type: "req", id: "goal-creation-policy", method: "chat.send", params },
          params,
          client: requestClient,
          context,
          respond,
          isWebchatConnect: () => true,
        },
        async () => {
          context.getRuntimeConfig = () => nextConfig;
          return true;
        },
      );
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[2]?.message).toMatch(
        change === "creation revoked" ? /cannot create sessions/ : /creation policy changed/,
      );
      expect(loadSessionEntry(scope())).toBeUndefined();
      expect(userMessages()).toEqual([]);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(context.chatAbortControllers.size).toBe(0);
    },
  );

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

  it.each([
    { caseName: "the existing session is busy", entry: { status: "running" as const } },
    {
      caseName: "the session used an external harness",
      entry: { agentHarnessId: "test-external-runtime" },
    },
    {
      caseName: "the session used an unknown harness",
      entry: { agentHarnessId: "openclaw-custom" },
    },
  ])("leaves no Goal or turn when $caseName", async ({ entry }) => {
    await patchSessionEntryCore(scope(), () => entry);
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
    const profile = ensureProfileForEmail("goal-participant@example.test");
    const requestClient: GatewayClient = {
      ...client,
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
    };
    const participants = () => listSessionParticipantsReadOnly(scope()).get(sessionKey) ?? [];
    expect(participants()).toEqual([]);
    const startRequest = goalStart(objective);
    const started = await rpc("chat.send", startRequest, undefined, requestClient);
    expect(started.mock.calls[0]?.[0]).toBe(true);
    await waitForModelRun();
    await waitForDispatchEnd();
    const startMessage = userMessages()[0];
    const startTimestamp =
      startMessage && "timestamp" in startMessage ? startMessage.timestamp : undefined;
    expect(startTimestamp).toEqual(expect.any(Number));
    const startParticipants = [
      {
        identity: { type: "profile", id: profile.id },
        contributionCount: 1,
        firstPromptedAt: startTimestamp,
        lastPromptedAt: startTimestamp,
      },
    ];
    // Participant persistence is a post-admission microtask, not part of the Goal ACK.
    await vi.waitFor(() => expect(participants()).toEqual(startParticipants));
    const startReplay = await rpc("chat.send", startRequest, undefined, requestClient);
    expect(startReplay.mock.calls[0]?.[1]).toMatchObject({ replayed: true });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(participants()).toEqual(startParticipants);
    const goal = loadSessionEntry(scope())?.goal;
    expect(goal).toBeDefined();
    await patchSessionEntryCore(scope(), (entry) => ({
      status: "done",
      agentHarnessId: "openclaw",
      goal: entry.goal ? { ...entry.goal, status: "paused" } : undefined,
    }));
    expect(loadSessionEntry(scope())?.agentHarnessId).toBe("openclaw");
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
    const resumed = await rpc("sessions.goal.update", request, undefined, requestClient);
    expect(resumed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started", runId: "goal-resume", goalId: goal?.id }),
      undefined,
      expect.anything(),
    );
    await waitForModelRun(2);
    await waitForDispatchEnd();
    expect(participants()).toEqual(startParticipants);
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
    const replay = await rpc("sessions.goal.update", request, undefined, requestClient);
    expect(replay.mock.calls[0]?.[1]).toMatchObject({ replayed: true, runId: "goal-resume" });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(userMessages()).toHaveLength(2);
    expect(participants()).toEqual(startParticipants);

    modelStarted = createDeferred();
    const next = await rpc(
      "chat.send",
      {
        sessionKey,
        sessionId,
        message: "Also review the changelog.",
        idempotencyKey: randomUUID(),
      },
      undefined,
      requestClient,
    );
    expect(next.mock.calls[0]?.[0]).toBe(true);
    await waitForModelRun(3);
    await waitForDispatchEnd();
    const nextMessage = userMessages().at(-1);
    const nextTimestamp =
      nextMessage && "timestamp" in nextMessage ? nextMessage.timestamp : undefined;
    expect(nextTimestamp).toEqual(expect.any(Number));
    await vi.waitFor(() =>
      expect(participants()).toEqual([
        { ...startParticipants[0], contributionCount: 2, lastPromptedAt: nextTimestamp },
      ]),
    );
  });
});
