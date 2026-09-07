import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { extractText } from "../../ui/src/lib/chat/message-extract.ts";
import { buildChatMarkdown } from "../../ui/src/pages/chat/export.ts";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionEntriesReadOnly,
  listSessionParticipantsReadOnly,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { resetClientVoiceConfirmationStateForTest } from "../talk/client-voice-confirmation.test-support.js";
import { createOrResumeClientVoiceSession } from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";
import { createTalkClientAgentConsultRunner } from "./talk-client-agent-consult.js";
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
let agentId = "main";
let sessionKey = "agent:main:main";
let canonicalKey = sessionKey;
let sessionId: string;
const connectionId = "talk-consult-history-ui";
const spoken = "SPOKEN_133855: Keep the literal labels Context: and Spoken style: in my note.";
const answer = "ANSWER_133855: Both labels are preserved.";
const consultAnswer = "INTERNAL_FINAL_133855: The note contains both requested labels.";
const consultCommentary = "COMMENTARY_133855: Checking the saved note.";
const consultToolResult = "TOOL_RESULT_133855: Context: and Spoken style: are present.";
const args = {
  question: "GENERATED_QUESTION_133855: Check the note requested by the speaker.",
  context: "GENERATED_CONTEXT_133855: The call already has a finalized human transcript.",
  responseStyle: "GENERATED_STYLE_133855: Speak one short sentence.",
};
const syntheticMarkers = Object.values(args);
const broadcast = vi.fn<GatewayBroadcastToConnIdsFn>();
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let context: GatewayRequestContext;
let client: GatewayClient;
let storePath: string;
let voiceSessionId: string | undefined;
let modelStarted = createDeferred();
let releaseModel = createDeferred();
let unsubscribe: (() => void) | undefined;
let publications: Promise<void>[] = [];
let publicationErrors: unknown[] = [];

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  agentId = "main";
  sessionKey = canonicalKey = "agent:main:main";
  sessionId = randomUUID();
  // Voice transcripts use the canonical agent store, not a custom chat-store locator.
  storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: { main: { sessionId, updatedAt: Date.now(), status: "done" } },
  });
  await prepareGatewayReplyRuntimeForTest({ force: true });
  context = createDirectChatContext({ getRuntimeConfig });
  const profile = ensureProfileForEmail("talk-history@example.test");
  client = {
    connId: connectionId,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
  // Admission, the recorder, and publication stay real; only model execution is held.
  gatewayReplyMock.mockImplementation(getReplyFromConfig);
  dispatchInboundMessageMock.mockReset();
  runEmbeddedAgent.mockReset();
  modelStarted = createDeferred();
  releaseModel = createDeferred();
  runEmbeddedAgent.mockImplementation(async (params) => {
    modelStarted.resolve();
    await releaseModel.promise;
    return {
      payloads: [{ text: answer }],
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
  broadcast.mockReset();
  publications = [];
  publicationErrors = [];
  const publish = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds: broadcast,
    sessionEventSubscribers: { getAll: () => new Set([connectionId]) },
    sessionMessageSubscribers: { get: () => new Set([connectionId]) },
    chatAbortControllers: context.chatAbortControllers,
  });
  unsubscribe = onInternalSessionTranscriptUpdate((update) => {
    if ((update.target?.sessionId ?? update.sessionId) !== sessionId) {
      return;
    }
    publications.push(
      publish(update).catch((error: unknown) => {
        publicationErrors.push(error);
      }),
    );
  });
  voiceSessionId = createOrResumeClientVoiceSession({
    agentId: "main",
    sessionKey,
    origin: "client",
    transcriptCapable: true,
  });
});
afterEach(async () => {
  releaseModel.resolve();
  try {
    await waitForDispatchEnd();
    if (voiceSessionId) {
      await rpc("talk.client.close", { sessionKey, voiceSessionId });
    }
    await drainPublications();
  } finally {
    unsubscribe?.();
    unsubscribe = undefined;
    voiceSessionId = undefined;
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    testState.sessionStorePath = undefined;
    gatewayReplyMock.mockReset();
    runEmbeddedAgent.mockReset();
    clearConfigCache();
  }
});

function scope() {
  return { agentId, sessionKey: canonicalKey, sessionId, storePath };
}
async function rpc(method: string, params: Record<string, unknown>) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: randomUUID(), method, params },
    context,
    client,
    respond,
    isWebchatConnect: () => true,
  });
  expect(respond).toHaveBeenCalledOnce();
  const [ok, result, error] = expectDefined(respond.mock.calls[0], "Gateway RPC response");
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  return expectDefined(asOptionalRecord(result), "Gateway RPC result");
}
async function waitForDispatchEnd() {
  await getSessionWorkAdmissionRelease({ scope: storePath, identities: [canonicalKey, sessionId] });
  expect(context.chatAbortControllers.size).toBe(0);
}
async function drainPublications() {
  await Promise.all(publications);
  expect(publicationErrors).toEqual([]);
}
function liveMessages() {
  return broadcast.mock.calls.flatMap(([event, payload]) => {
    const message = asOptionalRecord(payload)?.message;
    return event === "session.message" && message ? [message] : [];
  });
}
function expectNoGeneratedInput(messages: unknown[], surface: string) {
  const markdown = buildChatMarkdown(messages, "Voice test assistant");
  const serialized = JSON.stringify(messages);
  expect
    .soft(
      syntheticMarkers.filter((marker) => serialized.includes(marker)),
      surface,
    )
    .toEqual([]);
  expect
    .soft(
      syntheticMarkers.filter((marker) => markdown?.includes(marker)),
      `${surface} Markdown`,
    )
    .toEqual([]);
}
function expectVisibleSpeechOnly(messages: unknown[], surface: string, hasAnswer: boolean) {
  const users = messages.filter((message) => asOptionalRecord(message)?.role === "user");
  expect.soft(users.map(extractText), surface).toEqual([spoken]);
  const markdown = buildChatMarkdown(messages, "Voice test assistant");
  expect.soft(markdown, `${surface} Markdown`).toContain(spoken);
  expect.soft(markdown?.match(/^## You(?: \(|$)/gm), `${surface} human headings`).toHaveLength(1);
  expectNoGeneratedInput(messages, surface);
  expect
    .soft(
      messages.map(extractText).filter((text) => text === answer),
      `${surface} spoken answer`,
    )
    .toHaveLength(hasAnswer ? 1 : 0);
  expect
    .soft(markdown?.split(answer).length, `${surface} spoken answer in Markdown`)
    .toBe(hasAnswer ? 2 : 1);
  expect.soft(JSON.stringify(messages), `${surface} internal final`).not.toContain(consultAnswer);
  expect.soft(markdown, `${surface} internal final in Markdown`).not.toContain(consultAnswer);
}
async function historyMessages() {
  const result = await rpc("chat.history", { sessionKey: canonicalKey, agentId });
  expect(Array.isArray(result.messages)).toBe(true);
  return result.messages as unknown[];
}

async function consult(question: string, callId: string) {
  return await rpc("talk.client.toolCall", {
    sessionKey,
    voiceSessionId,
    callId,
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    args: { question },
  });
}

async function startHeldConsult() {
  const ack = await consult("Keep this task running until released.", "held-task");
  await Promise.race([
    modelStarted.promise,
    getSessionWorkAdmissionRelease({ scope: storePath, identities: [canonicalKey, sessionId] }),
  ]);
  const run = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "held model invocation");
  const abortSignal = expectDefined(run.abortSignal, "admitted model cancellation signal");
  expect(abortSignal.aborted).toBe(false);
  return { ack, run, abortSignal };
}

describe("Browser Talk consult target handoff", () => {
  it.each([
    { name: "bare main", key: "main", expected: "agent:voice:main" },
    { name: "new session", key: "main", fresh: true, expected: "agent:voice:main" },
    { name: "custom main", key: "main", mainKey: "home", expected: "agent:voice:home" },
    { name: "global", key: "main", global: true, expected: "global" },
    { name: "scoped global", key: "agent:voice:main", global: true, expected: "global" },
    { name: "fixed store", key: "main", fixed: true, expected: "agent:voice:main" },
    { name: "explicit other agent", key: "agent:primary:chosen", expected: "agent:primary:chosen" },
  ])(
    "executes and cancels the exact $name target without changing voice identity",
    async (entry) => {
      await rpc("talk.client.close", { sessionKey, voiceSessionId });
      voiceSessionId = undefined;
      const previousConfig = getRuntimeConfig();
      testState.sessionStorePath = undefined;
      agentId = entry.key.startsWith("agent:primary:") ? "primary" : "voice";
      sessionKey = entry.key;
      canonicalKey = entry.expected;
      storePath = entry.fixed
        ? resolveOpenClawAgentSqlitePath({ agentId })
        : resolveSessionStorePathCore(undefined, { agentId });
      await writeSessionStore({
        storePath,
        agentId,
        mainKey: entry.mainKey,
        entries: entry.fresh
          ? {}
          : { [canonicalKey]: { sessionId, updatedAt: Date.now(), status: "done" } },
      });
      await prepareGatewayReplyRuntimeForTest({
        force: true,
        config: {
          ...previousConfig,
          agents: {
            ownership: "explicit",
            entries: { primary: {}, voice: {} },
            defaults: {
              ...previousConfig.agents?.defaults,
              ...(entry.fixed ? { sessionStore: { agentId } } : {}),
            },
          },
          talk: { agentId: "voice" },
          session: {
            ...(entry.mainKey ? { mainKey: entry.mainKey } : {}),
            ...(entry.global ? { scope: "global" } : {}),
            ...(entry.fixed ? { store: storePath } : {}),
          },
        },
      });
      voiceSessionId = createOrResumeClientVoiceSession({ agentId, sessionKey, origin: "client" });
      if (!entry.fresh) {
        await rpc("talk.client.transcript", {
          sessionKey,
          voiceSessionId,
          entryId: "spoken-user",
          role: "user",
          text: spoken,
        });
      }
      const { ack, run, abortSignal } = await startHeldConsult();
      expect(run).toMatchObject({
        agentId,
        sessionKey: canonicalKey,
        ...(!entry.fresh ? { sessionId } : {}),
      });
      if (entry.fresh) {
        sessionId = run.sessionId;
      }
      expect(ack).toMatchObject({ agentId, agentSessionKey: canonicalKey });
      expect(clientVoiceSessionTesting.readRecord(agentId, voiceSessionId)).toMatchObject({
        sessionKey,
        status: "open",
        consultRunIds: [ack.runId],
      });
      expect(
        listSessionEntriesReadOnly({ agentId, storePath }).map((row) => row.sessionKey),
      ).toEqual([canonicalKey]);
      expect(
        await rpc("chat.abort", {
          sessionKey: ack.agentSessionKey,
          agentId: ack.agentId,
          runId: ack.runId,
        }),
      ).toMatchObject({ aborted: true, runIds: [ack.runId] });
      expect(abortSignal.aborted).toBe(true);
      const history = await historyMessages();
      if (entry.fresh) {
        expectNoGeneratedInput(history, "new target history");
      } else {
        expectVisibleSpeechOnly(history, "canonical target history", false);
      }
    },
  );
});

describe("Browser Talk literal consult commands", () => {
  it.each(["/stop", "stop"])("dispatches generated %j as literal model input", async (question) => {
    const ack = await consult(question, "literal-command");
    expect(ack).toMatchObject({ runId: expect.any(String), idempotencyKey: ack.runId });
    await Promise.race([
      modelStarted.promise,
      getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] }),
    ]);
    expect({
      acknowledgedRun: ack.runId,
      modelPrompts: runEmbeddedAgent.mock.calls.map(([run]) => run.prompt),
    }).toMatchObject({
      acknowledgedRun: ack.runId,
      modelPrompts: [expect.stringContaining(question)],
    });
  });

  it("does not turn a generated stop question into cancellation of the active consult", async () => {
    const first = await startHeldConsult();
    const ack = await consult("/stop", "literal-stop-during-task");
    expect(ack.runId).not.toBe(first.ack.runId);
    expect
      .soft(first.abortSignal.aborted, "generated input cancelled the existing task")
      .toBe(false);
    releaseModel.resolve();
    await waitForDispatchEnd();
    expect(runEmbeddedAgent.mock.calls.map(([run]) => run.prompt)).toEqual(
      expect.arrayContaining([expect.stringContaining("/stop")]),
    );
  });

  it("preserves an actual human stop command", async () => {
    const first = await startHeldConsult();
    const stopped = await rpc("chat.send", {
      sessionKey,
      message: "/stop",
      idempotencyKey: "human-stop",
    });
    expect(stopped).toMatchObject({ aborted: true, runIds: [first.ack.runId] });
    expect(first.abortSignal.aborted).toBe(true);
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });
});

describe("Browser Talk consult input custody", () => {
  it.each([
    {
      name: "owner",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      tools: undefined,
    },
    {
      name: "read-only Talk operator",
      scopes: ["operator.read", "operator.talk"],
      tools: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
    },
  ])(
    "keeps $name consult scaffolding out of chat and later context but in the raw archive",
    async ({ scopes, tools }) => {
      client.connect.scopes = scopes;
      const completeModel = expectDefined(
        runEmbeddedAgent.getMockImplementation(),
        "held model implementation",
      );
      let modelReply = consultAnswer;
      let modelMessages: Parameters<SessionManager["appendMessage"]>[0][] = [
        Object.assign(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: consultCommentary }],
          }),
          {
            openclawStreamFallback: {
              replacementText: consultCommentary,
              source: "segment",
              itemId: "consult-commentary",
            },
          },
        ),
        makeAgentAssistantMessage({
          content: [
            { type: "toolCall", id: "consult-read", name: "read", arguments: { path: "note.txt" } },
          ],
          stopReason: "toolUse",
        }),
        {
          role: "toolResult",
          toolCallId: "consult-read",
          toolName: "read",
          content: [{ type: "text", text: consultToolResult }],
          isError: false,
          timestamp: 0,
        },
        makeAgentAssistantMessage({ content: [{ type: "text", text: modelReply }] }),
      ];
      runEmbeddedAgent.mockImplementation(async (params) => {
        params.onExecutionPhase?.({ phase: "model_call_started" });
        const result = await completeModel(params);
        params.abortSignal?.throwIfAborted();
        const manager = guardSessionManager(SessionManager.open(scope()), {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
        });
        for (const message of modelMessages) {
          manager.appendMessage(message);
        }
        return { ...result, payloads: [{ text: modelReply }] };
      });
      const userTranscript = {
        sessionKey,
        voiceSessionId,
        entryId: "spoken-user",
        role: "user",
        text: spoken,
      };
      await rpc("talk.client.transcript", userTranscript);
      await rpc("talk.client.transcript", userTranscript);
      await drainPublications();
      const participantsBeforeConsult =
        listSessionParticipantsReadOnly(scope()).get(sessionKey) ?? [];
      const ack = await rpc("talk.client.toolCall", {
        sessionKey,
        voiceSessionId,
        callId: "native-consult",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args,
      });
      expect(ack.runId).toEqual(expect.any(String));
      expect(ack.idempotencyKey).toBe(ack.runId);
      await Promise.race([
        modelStarted.promise,
        getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] }),
      ]);
      expect(context.logGateway.error).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      const run = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "consult model invocation");
      expect(run.toolsAllow).toEqual(tools);
      for (const marker of syntheticMarkers) {
        expect(run.prompt).toContain(marker);
      }
      await drainPublications();
      expectVisibleSpeechOnly(liveMessages(), "before model completion", false);
      expectVisibleSpeechOnly(await historyMessages(), "model-held chat.history", false);

      releaseModel.resolve();
      await waitForDispatchEnd();
      // The browser persists the provider's final spoken answer through this same RPC.
      await rpc("talk.client.transcript", {
        sessionKey,
        voiceSessionId,
        entryId: "spoken-assistant",
        role: "assistant",
        text: answer,
      });
      await drainPublications();
      expectVisibleSpeechOnly(liveMessages(), "live session.message", true);
      expectVisibleSpeechOnly(await historyMessages(), "chat.history", true);

      const storedMessages = loadTranscriptEventsSync(scope()).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message ? [message] : [];
      });
      const generated = storedMessages.filter((message) =>
        extractText(message)?.includes(args.question),
      );
      expect(
        storedMessages.filter((message) => extractText(message) === consultAnswer),
      ).toHaveLength(1);
      expect(
        storedMessages.find((message) => extractText(message) === consultCommentary),
      ).not.toHaveProperty("display", false);
      expect(
        storedMessages.find((message) => extractText(message) === consultToolResult),
      ).toMatchObject({
        role: "toolResult",
        toolCallId: "consult-read",
      });
      expect(
        storedMessages.find((message) => extractText(message) === consultToolResult),
      ).not.toHaveProperty("display", false);
      expect((await historyMessages()).map(extractText)).toContain(consultCommentary);
      expect(generated).toHaveLength(1);
      expect.soft(generated[0]).toMatchObject({
        role: "user",
        display: false,
        excludeFromContext: true,
        provenance: { kind: "internal_system" },
      });
      const metadata = asOptionalRecord(generated[0]?.["__openclaw"]);
      expect.soft(metadata?.senderIdentity).toBeUndefined();
      expect.soft(metadata?.senderIsOwner).not.toBe(true);
      expect
        .soft(listSessionParticipantsReadOnly(scope()).get(sessionKey) ?? [])
        .toEqual(participantsBeforeConsult);

      // Reopen only this fixture's transcript database after dispatch/publication have drained.
      const databasePath = resolveOpenClawAgentSqlitePath(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope())),
      );
      expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
      clearSessionStoreCacheForTest();
      expectVisibleSpeechOnly(await historyMessages(), "reopened chat.history", true);
      for (const manager of [
        SessionManager.open(scope()),
        SessionManager.openModelContext(scope()),
      ]) {
        const messages = manager.buildSessionContext().messages;
        expectNoGeneratedInput(messages, "reopened model context");
        expect(messages.map(extractText)).toEqual(
          expect.arrayContaining([
            spoken,
            answer,
            consultCommentary,
            consultToolResult,
            consultAnswer,
          ]),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "toolCall", id: "consult-read" }),
            ]),
          }),
        );
      }
      expect(loadTranscriptEventsSync(scope())).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: generated[0] })]),
      );

      client.connect.scopes = ["operator.read", "operator.write", "operator.admin"];
      const normalPrompt = "NORMAL_PROMPT_133855: What did you find?";
      modelReply = "NORMAL_REPLY_133855: The saved note contains both labels.";
      modelMessages = [
        makeAgentAssistantMessage({ content: [{ type: "text", text: modelReply }] }),
      ];
      await rpc("chat.send", {
        sessionKey,
        message: normalPrompt,
        idempotencyKey: `normal-after-consult-${sessionId}`,
      });
      await waitForDispatchEnd();
      await drainPublications();
      expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
      for (const messages of [liveMessages(), await historyMessages()]) {
        expect(messages.map(extractText).filter((text) => text === modelReply)).toEqual([
          modelReply,
        ]);
        expect(messages.map(extractText)).toContain(normalPrompt);
        expect(JSON.stringify(messages)).not.toContain(consultAnswer);
      }
    },
  );
});

describe("Direct Talk consult history after call closure", () => {
  it.each(["before-final", "after-final"] as const)(
    "retains the direct answer when the call closes %s without a spoken replacement",
    async (ordering) => {
      const callId = expectDefined(voiceSessionId, "direct voice session");
      const directAnswer = "DIRECT_FINAL_134003: The requested note contains both labels.";
      const finalCommitted = createDeferred();
      const releaseResult = createDeferred();
      const completeModel = expectDefined(
        runEmbeddedAgent.getMockImplementation(),
        "held model implementation",
      );
      runEmbeddedAgent.mockImplementation(async (params) => {
        const recorder = expectDefined(params.userTurnTranscriptRecorder, "direct input recorder");
        await recorder.persistApproved();
        expect(recorder.hasPersisted()).toBe(true);
        const result = await completeModel(params);
        params.abortSignal?.throwIfAborted();
        const manager = guardSessionManager(SessionManager.open(scope()), {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          prepareAssistantTranscriptMessage: params.prepareAssistantTranscriptMessage,
        });
        manager.appendMessage(
          makeAgentAssistantMessage({ content: [{ type: "text", text: directAnswer }] }),
        );
        finalCommitted.resolve();
        await releaseResult.promise;
        return { ...result, payloads: [{ text: directAnswer }] };
      });
      const runner = createTalkClientAgentConsultRunner({
        config: getRuntimeConfig(),
        context,
        sessionTarget: { agentId, sessionKey, canonicalKey, storePath },
        ownerConnId: connectionId,
        getVoiceSessionId: () => callId,
        initialItems: [],
      });
      const providerTask = new AbortController();
      const directRun = runner.runArgs(args, providerTask.signal);
      void directRun.catch(() => undefined);
      try {
        await Promise.race([modelStarted.promise, directRun]);
        const run = expectDefined(runEmbeddedAgent.mock.calls[0]?.[0], "direct core invocation");
        const backingSignal = expectDefined(run.abortSignal, "direct backing signal");
        expect(run).toMatchObject({ agentId, sessionId, sessionKey: canonicalKey });
        expect(backingSignal.aborted).toBe(false);
        if (ordering === "after-final") {
          releaseModel.resolve();
          await Promise.race([finalCommitted.promise, directRun]);
        }
        await rpc("talk.client.close", { sessionKey, voiceSessionId: callId });
        expect(clientVoiceSessionTesting.readRecord(agentId, callId)).toMatchObject({
          status: "closed",
          consultRunIds: [run.runId],
        });
        expect(providerTask.signal.aborted).toBe(false);
        expect(backingSignal.aborted).toBe(false);
        await expect(runner.runArgs(args)).rejects.toThrow("voice session is closed");
        releaseModel.resolve();
        releaseResult.resolve();
        await expect(directRun).resolves.toEqual({ text: directAnswer });
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
        await drainPublications();
        expectNoGeneratedInput(liveMessages(), "direct live publication");

        const storedMessages = loadTranscriptEventsSync(scope()).flatMap((event) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return message ? [message] : [];
        });
        const generated = storedMessages.filter((message) =>
          extractText(message)?.includes(args.question),
        );
        expect(generated).toHaveLength(1);
        expect(generated[0]).toMatchObject({
          role: "user",
          display: false,
          excludeFromContext: true,
        });
        expect(
          storedMessages.filter((message) => message.role === "assistant").map(extractText),
        ).toEqual([directAnswer]);
        const history = await historyMessages();
        const databasePath = resolveOpenClawAgentSqlitePath(
          toDatabaseOptions(resolveSqliteTranscriptReadScope(scope())),
        );
        expect(closeOpenClawAgentDatabaseByPath(databasePath)).toBe(true);
        clearSessionStoreCacheForTest();
        for (const [view, messages] of [
          ["chat.history", history],
          ["reopened chat.history", await historyMessages()],
        ] as const) {
          expect
            .soft(
              messages.map(extractText).filter((text) => text === directAnswer),
              view,
            )
            .toEqual([directAnswer]);
          expectNoGeneratedInput(messages, `closed direct call ${view}`);
        }
        const modelContext =
          SessionManager.openModelContext(scope()).buildSessionContext().messages;
        expectNoGeneratedInput(modelContext, "closed direct call model context");
        expect(modelContext.map(extractText)).toContain(directAnswer);
      } finally {
        releaseModel.resolve();
        releaseResult.resolve();
        await directRun.catch(() => undefined);
      }
    },
  );
});
