import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { extractText } from "../../ui/src/lib/chat/message-extract.ts";
import { buildChatMarkdown } from "../../ui/src/pages/chat/export.ts";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { clearConfigCache, getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
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
function expectNoConsultUserFrames(surface: string) {
  const messages = liveMessages();
  // Browser Talk renders speech locally; the consult must not publish a second human turn.
  expect
    .soft(
      messages.filter((message) => asOptionalRecord(message)?.role === "user"),
      surface,
    )
    .toEqual([]);
  expectNoGeneratedInput(messages, surface);
}
function expectVisibleSpeechOnly(messages: unknown[], surface: string, hasAnswer: boolean) {
  const users = messages.filter((message) => asOptionalRecord(message)?.role === "user");
  expect.soft(users.map(extractText), surface).toEqual([spoken]);
  const markdown = buildChatMarkdown(messages, "Voice test assistant");
  expect.soft(markdown, `${surface} Markdown`).toContain(spoken);
  expect.soft(markdown?.match(/^## You(?: \(|$)/gm), `${surface} human headings`).toHaveLength(1);
  expectNoGeneratedInput(messages, surface);
  if (hasAnswer) {
    expect.soft(markdown, `${surface} spoken answer`).toContain(answer);
  }
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
      setRuntimeConfigSnapshot({
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
      });
      await prepareGatewayReplyRuntimeForTest({ force: true });
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
      await rpc("talk.client.transcript", {
        sessionKey,
        voiceSessionId,
        entryId: "spoken-user",
        role: "user",
        text: spoken,
      });
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
      expectNoConsultUserFrames("before model completion");
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
      expectNoConsultUserFrames("live session.message");
      expectVisibleSpeechOnly(await historyMessages(), "chat.history", true);

      const storedMessages = loadTranscriptEventsSync(scope()).flatMap((event) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return message ? [message] : [];
      });
      const generated = storedMessages.filter((message) =>
        extractText(message)?.includes(args.question),
      );
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
        expect(messages.map(extractText)).toEqual(expect.arrayContaining([spoken, answer]));
      }
      expect(loadTranscriptEventsSync(scope())).toEqual(
        expect.arrayContaining([expect.objectContaining({ message: generated[0] })]),
      );
    },
  );
});
