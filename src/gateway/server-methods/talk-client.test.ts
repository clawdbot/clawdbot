import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { enqueueCommandInLane, resetCommandLane } from "../../process/command-queue.js";
import {
  beginGatewayRestartSignalAdmission,
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { getActiveSessionWorkAdmissionCount } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  authorizeClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
} from "../../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  resolveClientVoiceRunBinding,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { runWithGatewayHttpWorkAdmission } from "../server/http-work-admission.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import { closeTalkClientGatewayControlSession } from "../talk-client-gateway-control.js";
import { cleanupTalkConnection } from "../talk-session-registry.js";
import { createTalkClient } from "./talk-client-create.js";
import { readLegacyVoiceBinding } from "./talk-client-legacy-voice-bindings.js";
import { talkClientHandlers } from "./talk-client.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const voiceMocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(),
  runEmbeddedAgent: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
}));

vi.mock("../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: voiceMocks.resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceProviderCapabilities: ({
    provider,
  }: {
    provider: { capabilities: unknown };
  }) => provider.capabilities,
}));
vi.mock("../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/provider-registry.js")>()),
  listRealtimeVoiceProviders: () => [],
}));
vi.mock("../../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: voiceMocks.consultRealtimeVoiceAgent,
}));
vi.mock("../../plugins/runtime/index.js", async () => {
  const { createRuntimeAgent } = await import("../../plugins/runtime/runtime-agent.js");
  return { createPluginRuntime: () => ({ agent: createRuntimeAgent() }) };
});
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: voiceMocks.runEmbeddedAgent,
}));
vi.mock("../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeBootstrapContextInstructions: async () => undefined,
}));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const sessionKey = "agent:main:main";
const sessionId = "voice-transcript-session";
let tempDir: string;
let ownedVoiceSessionId: string | undefined;
const offerResources: AsyncResource[] = [];
type BrowserRequest = Parameters<
  NonNullable<import("../../plugins/types.js").RealtimeVoiceProviderPlugin["createBrowserSession"]>
>[0];
const browserSession = {
  provider: "openai",
  transport: "webrtc" as const,
  clientSecret: "test-pending-offer",
  offerUrl: "/plugins/openai/realtime/calls",
};

function configureDelegatedBrowserProvider(
  createBrowserSession: (request: BrowserRequest) => Promise<typeof browserSession>,
) {
  const cancelBrowserSession = vi.fn(async () => undefined);
  const provider = {
    id: "openai",
    capabilities: { transports: ["webrtc"], handlesAgentConsult: true, supportsToolCalls: false },
    createBrowserSession,
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession },
  });
  voiceMocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({
    provider,
    providerConfig: {},
  });
  const client = { connId: "conn-close" };
  const clients = new Set([client]);
  return {
    cancelBrowserSession,
    client,
    clients,
    context: {
      getRuntimeConfig: () => ({
        agents: { defaults: { workspace: path.join(tempDir, "workspace") } },
      }),
      getClientConnIds: (filter?: (candidate: typeof client) => boolean) =>
        new Set(
          [...clients]
            .filter((candidate) => !filter || filter(candidate))
            .map((candidate) => candidate.connId),
        ),
      chatAbortControllers: new Map(),
      logGateway: { warn: vi.fn() },
      broadcastToConnIds: vi.fn(),
    },
  };
}

async function invokeCreate(options: GatewayRequestHandlerOptions) {
  const admission = resolveSessionMutationAuthorization({
    method: "talk.client.create",
    requestParams: options.params,
    context: options.context,
    client: options.client,
  });
  if (admission.error) {
    options.respond(false, undefined, admission.error);
    return;
  }
  await createTalkClient({ ...options, sessionMutationAuthorization: admission.authorization });
}

async function invokeTranscript(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.transcript"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as never);
  return respond;
}

async function invokeClose(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.close"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
    client: { connId: "conn-close" },
  } as never);
  return respond;
}

async function createBrowserConsult() {
  const createBrowserSession = vi.fn(async (_request: BrowserRequest) => browserSession);
  const fixture = configureDelegatedBrowserProvider(createBrowserSession);
  const respond = vi.fn();
  await invokeCreate({
    params: { sessionKey, provider: "openai", model: "gpt-live-test" },
    respond,
    context: fixture.context,
    client: fixture.client,
  } as never);
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(browserSession), undefined);
  const createdSession = respond.mock.calls[0]?.[1];
  if (!createdSession) {
    throw new Error("Expected a browser session response");
  }
  ownedVoiceSessionId = createdSession.voiceSessionId;
  const consult = createBrowserSession.mock.calls[0]?.[0].runAgentConsult;
  if (!consult) {
    throw new Error("Expected a Gateway-owned browser consult callback");
  }
  return { ...fixture, consult };
}

async function completeOffer(run?: (resource: AsyncResource) => Promise<void>) {
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket));
  let resource!: AsyncResource;
  try {
    await runWithGatewayHttpWorkAdmission(res, async () => {
      // A socket captures its creator's async context; a retained plain closure does not.
      resource = new AsyncResource("talk-sideband-test");
      offerResources.push(resource);
      await run?.(resource);
      return true;
    });
    return resource;
  } finally {
    socket.destroy();
  }
}

async function useRealConsultRuntime() {
  const actual = await vi.importActual<typeof import("../../talk/agent-consult-runtime.js")>(
    "../../talk/agent-consult-runtime.js",
  );
  voiceMocks.consultRealtimeVoiceAgent.mockImplementation(actual.consultRealtimeVoiceAgent);
  voiceMocks.runEmbeddedAgent.mockImplementation(async (params) => {
    params.abortSignal?.throwIfAborted();
    return await enqueueCommandInLane("talk-admission-test", async () => ({
      payloads: [{ text: "fixture status" }],
      meta: { durationMs: 0 },
    }));
  });
}

describe("talk.client.transcript", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetGatewayWorkAdmission();
    ownedVoiceSessionId = undefined;
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-transcript-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  });

  afterEach(async () => {
    const remainingRootWork = getActiveGatewayRootWorkCount();
    resetGatewayWorkAdmission();
    for (const resource of offerResources.splice(0)) {
      resource.emitDestroy();
    }
    resetCommandLane("talk-admission-test");
    if (ownedVoiceSessionId) {
      await closeTalkClientGatewayControlSession({
        voiceSessionId: ownedVoiceSessionId,
        sessionKey,
        connId: "conn-close",
      });
    }
    cleanupTalkConnection("conn-close", { warn: vi.fn() });
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
    expect(remainingRootWork).toBe(0);
  });

  it("admits a later sideband consult after its HTTP offer has released admission", async () => {
    await useRealConsultRuntime();
    const { consult } = await createBrowserConsult();
    const resource = await completeOffer();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);

    await expect(
      resource.runInAsyncScope(() => consult({ prompt: "Return the fixture status" })),
    ).resolves.toEqual({ text: "fixture status" });
    const [run] = voiceMocks.runEmbeddedAgent.mock.calls[0]!;
    expect(resolveClientVoiceRunBinding(run.runId)).toMatchObject({
      agentId: "main",
      sessionKey,
      voiceSessionId: ownedVoiceSessionId,
    });
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  });

  it("keeps an accepted consult admitted through offer completion and suspension", async () => {
    await useRealConsultRuntime();
    const { consult } = await createBrowserConsult();
    const beforeEnqueue = createDeferred();
    const enqueue = voiceMocks.runEmbeddedAgent.getMockImplementation()!;
    voiceMocks.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      expect(getActiveSessionWorkAdmissionCount()).toBe(1);
      await beforeEnqueue.promise;
      return await enqueue(params);
    });
    let work: Promise<{ text: string }> | undefined;
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    try {
      await completeOffer(async (resource) => {
        work = resource.runInAsyncScope(() => consult({ prompt: "Return the fixture status" }));
        void work.catch(() => undefined);
        await vi.waitFor(() => expect(voiceMocks.runEmbeddedAgent).toHaveBeenCalledOnce());
      });
      expect(getActiveSessionWorkAdmissionCount()).toBe(1);
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension).not.toBeNull();
      beforeEnqueue.resolve();
      await expect(work).resolves.toEqual({ text: "fixture status" });
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
    } finally {
      beforeEnqueue.resolve();
      await work?.catch(() => undefined);
      suspension?.rollback();
    }
  });

  it.each(["suspend", "restart-signal", "restart-drain"] as const)(
    "does not admit a new sideband consult during %s",
    async (fence) => {
      await useRealConsultRuntime();
      const { consult } = await createBrowserConsult();
      const resource = await completeOffer();
      if (fence === "suspend") {
        expect(tryBeginGatewaySuspendAdmission(() => {})).not.toBeNull();
      } else if (fence === "restart-signal") {
        expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
      } else {
        markGatewayRestartDraining();
      }
      await expect(
        resource.runInAsyncScope(() => consult({ prompt: "Must not start" })),
      ).rejects.toThrow(GatewayDrainingError);
      expect(voiceMocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(getActiveSessionWorkAdmissionCount()).toBe(0);
    },
  );

  it.each(["close", "disconnect", "restart"] as const)(
    "does not revive a stale sideband owner after %s",
    async (ending) => {
      await useRealConsultRuntime();
      const { consult, client, clients, context } = await createBrowserConsult();
      const resource = await completeOffer();
      if (ending === "close") {
        expect(
          await invokeClose({ sessionKey, voiceSessionId: ownedVoiceSessionId }),
        ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      } else {
        if (ending === "restart") {
          markGatewayRestartDraining();
        }
        clients.delete(client);
        cleanupTalkConnection(client.connId, context.logGateway);
        if (ending === "restart") {
          resetGatewayWorkAdmission();
        }
      }
      await expect(
        resource.runInAsyncScope(() => consult({ prompt: "Must not start" })),
      ).rejects.toThrow(/closed|disconnected/);
      expect(voiceMocks.runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );

  it("appends finalized messages once by event id", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const params = {
      sessionKey,
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "hello from voice",
      timestamp: 123,
    };

    expect(await invokeTranscript(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await invokeTranscript(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    const events = readSessionTranscriptMessageEvents({ agentId: "main", sessionId });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      id: `voice:${voiceSessionId}:1`,
      message: {
        role: "user",
        content: [{ type: "text", text: "hello from voice" }],
        timestamp: 123,
        provenance: { kind: "realtime_voice", sourceChannel: "talk" },
      },
    });
  });

  it("appends before the session has ever received a chat turn", async () => {
    const talkFirstSessionKey = "agent:main:talk-first";
    await ensureClientVoiceAgentSessionEntry({
      agentId: "main",
      sessionKey: talkFirstSessionKey,
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: talkFirstSessionKey,
      provider: "google",
      origin: "client",
    });

    expect(
      await invokeTranscript({
        sessionKey: talkFirstSessionKey,
        voiceSessionId,
        entryId: "1",
        role: "user",
        text: "heard before the first consult",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);

    const talkFirstEntry = loadSessionEntry({
      agentId: "main",
      sessionKey: talkFirstSessionKey,
    });
    expect(talkFirstEntry?.sessionId).toBeTruthy();
    expect(
      readSessionTranscriptMessageEvents({
        agentId: "main",
        sessionId: talkFirstEntry?.sessionId ?? "missing",
      }),
    ).toHaveLength(1);
  });

  it("uses server observation time for spoken-confirmation freshness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    await invokeTranscript({
      sessionKey,
      voiceSessionId,
      entryId: "early-yes",
      role: "user",
      text: "yes",
      timestamp: 10_000,
    });
    const policy = checkClientVoiceToolConfirmationPolicy({
      agentId: "main",
      voiceSessionId,
      runId: "run-later",
      toolName: "message",
      toolParams: { action: "send", message: "later" },
      now: 200,
    });
    expect(policy.allowed).toBe(false);
    if (policy.allowed) {
      throw new Error("expected confirmation request");
    }
    const confirmationId = policy.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    expect(confirmationId).toBeTruthy();

    expect(() =>
      authorizeClientVoiceConfirmation({
        agentId: "main",
        voiceSessionId,
        confirmationId: confirmationId ?? "missing",
        now: 201,
      }),
    ).toThrow("explicit spoken confirmation");
  });

  it("accepts an idempotent close retry after the first response is lost", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const params = { sessionKey, voiceSessionId };

    expect(await invokeClose(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await invokeClose(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it.each(["close", "disconnect"] as const)(
    "revokes a delegated browser session on %s without abandoning accepted work",
    async (ending) => {
      const createBrowserSession = vi.fn(async (_request: BrowserRequest) => browserSession);
      const { cancelBrowserSession, client, clients, context } =
        configureDelegatedBrowserProvider(createBrowserSession);
      let finishConsult!: (value: { text: string }) => void;
      const acceptedResult = new Promise<{ text: string }>((resolve) => {
        finishConsult = resolve;
      });
      voiceMocks.consultRealtimeVoiceAgent
        .mockResolvedValue({ text: "Late task started" })
        .mockReturnValueOnce(acceptedResult);
      const respond = vi.fn();
      await invokeCreate({
        params: { sessionKey, provider: "openai", model: "gpt-live-test" },
        respond,
        context,
        client,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining(browserSession),
        undefined,
      );
      const result = respond.mock.calls[0]?.[1] as { voiceSessionId: string };
      ownedVoiceSessionId = result.voiceSessionId;
      const runAgentConsult = createBrowserSession.mock.calls[0]?.[0].runAgentConsult;
      expect(runAgentConsult).toBeTypeOf("function");
      const acceptedSignal = new AbortController().signal;
      const accepted = runAgentConsult!({
        prompt: "Read the project status",
        signal: acceptedSignal,
      });
      await vi.waitFor(() => expect(voiceMocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce());

      try {
        if (ending === "close") {
          expect(
            await invokeClose({ sessionKey, voiceSessionId: ownedVoiceSessionId }),
          ).toHaveBeenCalledWith(true, { ok: true }, undefined);
        } else {
          clients.delete(client);
          cleanupTalkConnection("conn-close", context.logGateway);
        }
        await expect(runAgentConsult!({ prompt: "Start another task" })).rejects.toThrow(
          /closed|stopped/i,
        );
        await vi.waitFor(() => expect(cancelBrowserSession).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(readLegacyVoiceBinding(client.connId, sessionKey)).toBeUndefined(),
        );
        const acceptedConsult = voiceMocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0] as {
          abortSignal: AbortSignal;
        };
        expect(acceptedConsult.abortSignal.aborted).toBe(false);
        expect(voiceMocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce();
      } finally {
        finishConsult({ text: "Accepted work finished" });
        await accepted;
      }
    },
  );

  it("cancels a provider that resolves after its browser disconnects without creating a chat", async () => {
    let finishCreation!: (value: typeof browserSession) => void;
    const created = new Promise<typeof browserSession>((resolve) => {
      finishCreation = resolve;
    });
    const createBrowserSession = vi.fn(async (_request: BrowserRequest) => await created);
    const { cancelBrowserSession, client, clients, context } =
      configureDelegatedBrowserProvider(createBrowserSession);
    const pendingSessionKey = "agent:main:pending-voice";
    const respond = vi.fn();
    const starting = invokeCreate({
      params: { sessionKey: pendingSessionKey, provider: "openai", model: "gpt-live-test" },
      respond,
      context,
      client,
    } as never);
    await vi.waitFor(() => expect(createBrowserSession).toHaveBeenCalledOnce());
    const runAgentConsult = createBrowserSession.mock.calls[0]?.[0].runAgentConsult;
    try {
      await expect(runAgentConsult!({ prompt: "Too early" })).rejects.toThrow(/not active/);
      clients.delete(client);
      cleanupTalkConnection(client.connId, context.logGateway);
    } finally {
      finishCreation(browserSession);
      await starting;
    }
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/closed|disconnected/) }),
    );
    expect(cancelBrowserSession).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ agentId: "main", sessionKey: pendingSessionKey })).toBeUndefined();
    expect(voiceMocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
  });

  it("does not create a provider after the browser disconnects during context preparation", async () => {
    const createBrowserSession = vi.fn(async (_request: BrowserRequest) => browserSession);
    const { client, clients, context } = configureDelegatedBrowserProvider(createBrowserSession);
    const respond = vi.fn();
    const starting = invokeCreate({
      params: { sessionKey, provider: "openai", model: "gpt-live-test" },
      respond,
      context,
      client,
    } as never);
    clients.delete(client);
    cleanupTalkConnection(client.connId, context.logGateway);
    await starting;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("disconnected") }),
    );
    expect(createBrowserSession).not.toHaveBeenCalled();
  });

  it("truncates UTF-16 safely and writes assistant metadata", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      provider: "google",
      origin: "client",
    });
    const respond = await invokeTranscript({
      sessionKey,
      voiceSessionId,
      entryId: "assistant-1",
      role: "assistant",
      text: `${"x".repeat(7_999)}😀tail`,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    const event = readSessionTranscriptMessageEvents({ agentId: "main", sessionId })[0]?.event as
      | { message?: { content?: Array<{ text?: string }> } }
      | undefined;
    const text = event?.message?.content?.[0]?.text;
    expect(text).toBe("x".repeat(7_999));
    expect(event).toMatchObject({
      message: {
        api: "realtime",
        provider: "google",
        model: "realtime-voice",
        stopReason: "stop",
      },
    });
  });

  it("uses the neutral provider label for records created before provider tracking", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });

    expect(
      await invokeTranscript({
        sessionKey,
        voiceSessionId,
        entryId: "legacy-assistant",
        role: "assistant",
        text: "legacy provider reply",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(
      readSessionTranscriptMessageEvents({ agentId: "main", sessionId })[0]?.event,
    ).toMatchObject({
      message: { api: "realtime", provider: "realtime", model: "realtime-voice" },
    });
  });

  it.each([
    ["missing", "voice-missing", "voice session not found"],
    ["closed", "voice-closed", "voice session is closed"],
    ["relay", "voice-relay", "does not allow this transcript source"],
  ])("rejects %s voice records", async (kind, voiceSessionId, expected) => {
    if (kind !== "missing") {
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: kind === "relay" ? "relay" : "client",
        voiceSessionId,
      });
    }
    if (kind === "closed") {
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
    }

    const respond = await invokeTranscript({
      sessionKey,
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "hello",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining(expected) }),
    );
  });
});
