import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import type { AgentSession } from "../../agents/sessions/agent-session.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { TalkRealtimeConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import { loadBundledPluginPublicSurface } from "../../plugin-sdk/test-helpers/public-surface-loader.js";
import { resolveCapabilityProviderRegistration } from "../../plugins/capability-catalog.js";
import { resolvePluginCapabilityCatalogContext } from "../../plugins/loader-runtime-load.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createResponse } from "../server-http.test-harness.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../talk-client-gateway-control.js";
import { cleanupTalkConnection } from "../talk-session-registry.js";
import { talkClientHandlers } from "./talk-client.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const nativeUpstream = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const sockets: NativeSocket[] = [];
  class NativeSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = 0;
    sent: string[] = [];

    constructor(readonly url: string) {
      super();
      sockets.push(this);
    }

    open(): void {
      this.readyState = NativeSocket.OPEN;
      this.emit("open");
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code = 1000, reason = "closed"): void {
      if (this.readyState === NativeSocket.CLOSED) {
        return;
      }
      this.readyState = NativeSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    }

    serverEvent(event: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(event)), false);
    }
  }
  const oauthToken = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "native-test" } }),
    ).toString("base64url"),
    "synthetic-signature",
  ].join(".");
  return {
    NativeSocket,
    sockets,
    fetch: vi.fn<typeof fetch>(),
    runEmbeddedAgent: vi.fn<typeof import("../../agents/embedded-agent.js").runEmbeddedAgent>(),
    authConfigured: vi.fn(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    ),
    resolveAuth: vi.fn(async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
      profileTypes?.includes("oauth") ? oauthToken : undefined,
    ),
  };
});

vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: nativeUpstream.runEmbeddedAgent,
}));
vi.mock("ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ws")>()),
  default: nativeUpstream.NativeSocket,
  WebSocket: nativeUpstream.NativeSocket,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  isProviderAuthProfileConfigured: nativeUpstream.authConfigured,
  resolveProviderAuthProfileApiKey: nativeUpstream.resolveAuth,
}));

export const upstream = nativeUpstream;

const { default: openaiPlugin } = await loadBundledPluginPublicSurface<{
  default: OpenClawPluginDefinition;
}>({ pluginId: "openai", artifactBasename: "index.js" });

type PluginApi = ReturnType<typeof createTestPluginApi>;
type HttpRoute = Parameters<PluginApi["registerHttpRoute"]>[0];
type PluginLifecycle = Parameters<PluginApi["registerRuntimeLifecycle"]>[0];
export const AGENT_ID = "voice";
export const SESSION_KEY = "agent:voice:main";
export const SESSION_ID = "native-control-transcript";
export const CONNECTION_ID = "native-control-client";
const AUDIO_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const DATA_CHANNEL_SDP = `${AUDIO_SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;

export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Expected nonempty ${key}`);
  }
  return value;
}

function requireSuccessfulReply(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  const reply = respond.mock.calls.at(-1);
  if (!reply) {
    throw new Error("Talk handler did not respond");
  }
  const [ok, payload, error] = reply;
  // Report the public rejection, never the credential-bearing session payload.
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  if (!isRecord(payload)) {
    throw new Error("Expected a Talk result object");
  }
  return payload;
}

type NativePluginFixture = {
  create: (negotiated: boolean, voiceSessionId?: string) => Promise<Record<string, unknown>>;
  invoke: (
    method: keyof typeof talkClientHandlers,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  offer: (
    token: string,
    sdp: string,
  ) => {
    handling: Promise<boolean | void>;
    response: ReturnType<typeof createResponse>;
  };
  broadcast: ReturnType<typeof vi.fn>;
  chatAbortControllers: GatewayRequestContext["chatAbortControllers"];
};

export async function withNativePlugin(
  run: (fixture: NativePluginFixture) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "talk-native-control-", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      const realtimeConfig: TalkRealtimeConfig = { provider: "openai", transport: "webrtc" };
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            voice: { agentDir: state.agentDir(AGENT_ID), workspace: state.workspaceDir },
            other: {},
          },
        },
        talk: { agentId: AGENT_ID, realtime: realtimeConfig },
        plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      };
      const registry = createEmptyPluginRegistry();
      // Native factory binding must retain the fixture's synthetic auth, not resolve operator credentials.
      const capabilityCatalogContext = {
        ...resolvePluginCapabilityCatalogContext(),
        isProviderAuthProfileConfigured: nativeUpstream.authConfigured,
        resolveProviderAuthProfileApiKey: nativeUpstream.resolveAuth,
      };
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const routes: HttpRoute[] = [];
      const lifecycles: PluginLifecycle[] = [];
      const broadcast = vi.fn();
      const profile = ensureProfileForEmail("native-control@example.test");
      const client = {
        ...sharingPolicyClient({
          user: profile.id,
          scopes: ["operator.read", "operator.talk"],
        }),
        connId: CONNECTION_ID,
      };
      const context = {
        getRuntimeConfig: () => config,
        getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
          new Set(!filter || filter(client) ? [CONNECTION_ID] : []),
        chatAbortControllers: new Map(),
        broadcastToConnIds: broadcast,
        logGateway: { warn: vi.fn() },
      } as unknown as GatewayRequestContext;
      const voiceSessionIds: string[] = [];
      try {
        if (!openaiPlugin.register) {
          throw new Error("OpenAI did not expose its public registration entry");
        }
        openaiPlugin.register(
          createTestPluginApi({
            id: "openai",
            registrationMode: "full",
            config,
            runtime: createPluginRuntimeMock({ config: { current: () => config } }),
            registerRealtimeVoiceProvider: (entry) => {
              const provider = resolveCapabilityProviderRegistration(
                entry,
                () => capabilityCatalogContext,
              );
              registry.realtimeVoiceProviders.push({
                pluginId: "openai",
                source: "test",
                provider,
              });
            },
            registerHttpRoute: (route) => routes.push(route),
            registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
          }),
        );
        const provider = registry.realtimeVoiceProviders.find(
          (entry) => entry.provider.id === "openai",
        )?.provider;
        // Choose the registered native family without reading an operator's model setting.
        const nativeModel = provider?.models?.find((model) => model.startsWith("gpt-live-"));
        if (!nativeModel) {
          throw new Error("OpenAI did not register a native realtime model");
        }
        realtimeConfig.model = nativeModel;
        setActivePluginRegistry(registry);
        const offerRoute = routes.find((route) => route.path === "/plugins/openai/realtime/calls");
        if (!offerRoute) {
          throw new Error("OpenAI did not register its realtime offer route");
        }
        await replaceSessionEntry(
          { agentId: AGENT_ID, sessionKey: SESSION_KEY },
          {
            sessionId: SESSION_ID,
            updatedAt: Date.now(),
            createdActor: { type: "human", source: "profile", id: profile.id },
          },
        );
        const call = async (
          method: keyof typeof talkClientHandlers,
          params: Record<string, unknown>,
        ) => {
          const respond = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: { type: "req", id: "native-control-request", method, params },
            respond,
            context,
            client,
            isWebchatConnect: () => false,
            extraHandlers: talkClientHandlers,
          });
          return requireSuccessfulReply(respond);
        };
        await run({
          create: async (negotiated, voiceSessionId) => {
            const result = await call("talk.client.create", {
              sessionKey: SESSION_KEY,
              mode: "realtime",
              transport: "webrtc",
              brain: "agent-consult",
              silenceDurationMs: 400,
              capabilities: negotiated ? ["gateway-control-v1"] : ["voice-transcript"],
              ...(voiceSessionId ? { voiceSessionId } : {}),
            });
            voiceSessionIds.push(requireString(result, "voiceSessionId"));
            return result;
          },
          invoke: async (method, params) => {
            return await call(method, {
              sessionKey: SESSION_KEY,
              ...(method === "talk.client.steer" ? {} : { voiceSessionId: voiceSessionIds.at(-1) }),
              ...params,
            });
          },
          offer: (token, sdp) => {
            const request = Object.assign(createMockIncomingRequest([sdp]), {
              method: "POST",
              url: offerRoute.path,
              headers: { authorization: `Bearer ${token}`, "content-type": "application/sdp" },
            });
            const response = createResponse();
            const handling = Promise.resolve(offerRoute.handler(request, response.res));
            return { handling, response };
          },
          broadcast,
          chatAbortControllers: context.chatAbortControllers,
        });
      } finally {
        for (const voiceSessionId of voiceSessionIds) {
          await closeTalkClientGatewayControlSession({
            voiceSessionId,
            sessionKey: SESSION_KEY,
            connId: CONNECTION_ID,
          });
        }
        cleanupTalkConnection(CONNECTION_ID, context.logGateway);
        for (const lifecycle of lifecycles) {
          await lifecycle.cleanup?.({ reason: "disable" });
        }
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );
}

export async function connectNativeSession(
  { create, offer }: Pick<NativePluginFixture, "create" | "offer">,
  negotiated = true,
  voiceSessionId?: string,
) {
  const socketIndex = upstream.sockets.length;
  const fetchCount = upstream.fetch.mock.calls.length;
  const result = await create(negotiated, voiceSessionId);
  expect(result.clientControl).toEqual(negotiated ? { owner: "gateway" } : undefined);
  expect(upstream.fetch).toHaveBeenCalledTimes(fetchCount);
  const sdp = negotiated ? AUDIO_SDP : DATA_CHANNEL_SDP;
  const { handling, response } = offer(requireString(result, "clientSecret"), sdp);
  await vi.waitFor(() => expect(upstream.sockets).toHaveLength(socketIndex + 1));
  expect(response.end).not.toHaveBeenCalled();
  const socket = upstream.sockets[socketIndex];
  if (!socket) {
    throw new Error("Missing native sideband");
  }
  socket.open();
  await handling;
  expect(response.res.statusCode).toBe(200);
  return { result, socket };
}

export function nativeDelegation(id: string, text: string) {
  return {
    type: "delegation.created",
    item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
  };
}

export function talkEventTypes(broadcast: ReturnType<typeof vi.fn>): string[] {
  return broadcast.mock.calls.flatMap(([event, payload]) => {
    if (event !== "talk.event" || !isRecord(payload) || !isRecord(payload.talkEvent)) {
      return [];
    }
    return typeof payload.talkEvent.type === "string" ? [payload.talkEvent.type] : [];
  });
}

type ParkedNativeTask = NativePluginFixture &
  Awaited<ReturnType<typeof connectNativeSession>> & {
    activeRun: RunEmbeddedAgentParams & { abortSignal: AbortSignal };
    abortOwned: ReturnType<typeof vi.fn<() => void>>;
    queueMessage: ReturnType<
      typeof vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>
    >;
    settleBackend: () => Promise<void>;
  };

export async function withParkedNativeTask(
  run: (task: ParkedNativeTask) => Promise<void>,
  prompt = "Keep working until I cancel.",
  embeddedSession?: AgentSession,
): Promise<void> {
  const releaseBackend = createDeferredCore();
  const runAbortController = new AbortController();
  let activeRun: RunEmbeddedAgentParams | undefined;
  let startupError: unknown;
  let backendAborted = false;
  const abortOwned = vi.fn(() => {
    backendAborted = true;
    runAbortController.abort();
    void embeddedSession?.abort();
    releaseBackend.resolve();
  });
  const queueMessage = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
    async () => undefined,
  );
  upstream.runEmbeddedAgent
    .mockImplementationOnce(async (params) => {
      if (!params.preparedRunAdmission) {
        throw new Error("Expected real Talk admission");
      }
      const admittedRunContext = await params.preparedRunAdmission.admit(
        "embedded",
        "native-test-backend",
      );
      return await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        {
          ...params,
          provider: "test-provider",
          modelId: "test-model",
          sessionFile: "/tmp/native-control-test-session.jsonl",
        },
        undefined,
        async (prepared) => {
          let stream:
            | ReturnType<
                typeof import("../../agents/embedded-agent-runner/run/attempt-stream-prepare.js").prepareEmbeddedAttemptStream
              >
            | undefined;
          if (embeddedSession) {
            const { prepareEmbeddedAttemptStream } =
              await import("../../agents/embedded-agent-runner/run/attempt-stream-prepare.js");
            const model = embeddedSession.model;
            if (!model) {
              throw new Error("Expected an embedded test model");
            }
            stream = prepareEmbeddedAttemptStream({
              attempt: {
                ...prepared,
                admittedRunContext,
                model,
                modelRegistry: embeddedSession.modelRegistry,
                authStorage: AuthStorage.inMemory(),
                authProfileStore: { version: 1, profiles: {} },
                thinkLevel: "off",
                fastMode: undefined,
              },
              activeSession: embeddedSession,
              hookRunner: null,
              hookAgentId: AGENT_ID,
              diagnosticTrace: createDiagnosticTraceContext(),
              diagnosticOwner: createDiagnosticEmbeddedRunOwner({
                sessionId: params.sessionId,
                runId: params.runId,
              }),
              clientToolCallSlots: [],
              nestedToolActivities: [],
              isReplaySafeTool: () => false,
              runAbortController,
              abortRun: abortOwned,
              markExternalAbort: () => {},
              getRunState: () => ({
                aborted: backendAborted,
                promptError: undefined,
                timedOut: false,
                yieldDetected: false,
              }),
              hasDeliveredSourceReply: () => false,
              markSourceReplyDelivered: () => {},
              onBlockReply: undefined,
              onBlockReplyFlush: undefined,
              sandboxSessionKey: SESSION_KEY,
              builtinToolNames: new Set(),
              replaySafeToolNames: new Set(),
            });
          }
          const handle =
            stream?.queueHandle ??
            createEmbeddedRunHandle({
              runId: params.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              abort: abortOwned,
              queueMessage,
            });
          const releaseOnAbort = () => releaseBackend.resolve();
          if (!stream) {
            handle.messageInjectionV2 = {
              version: 2,
              isAvailable: () => !backendAborted,
              queueMessage: async (text, options, assertCurrent) => {
                assertCurrent();
                return await queueMessage(text, options);
              },
            };
            setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, prepared.sessionFile);
          }
          activeRun = params;
          params.abortSignal?.addEventListener("abort", releaseOnAbort, { once: true });
          try {
            await embeddedSession?.prompt(params.prompt);
            await releaseBackend.promise;
            return {
              payloads: [{ text: "Original task completed normally." }],
              meta: {
                durationMs: 0,
                aborted: backendAborted || params.abortSignal?.aborted === true,
              },
            };
          } finally {
            params.abortSignal?.removeEventListener("abort", releaseOnAbort);
            stream?.subscription.unsubscribe();
            clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
          }
        },
      ).catch((error: unknown) => {
        startupError = error;
        throw error;
      });
    })
    .mockResolvedValue({
      payloads: [{ text: "Subsequent task completed." }],
      meta: { durationMs: 0 },
    });
  const settleBackend = async () => {
    releaseBackend.resolve();
    await Promise.allSettled(
      upstream.runEmbeddedAgent.mock.results
        .filter((result) => result.type === "return")
        .map((result) => result.value),
    );
    // Let the real consult owner release registration and finish its provider result.
    await nextEventLoopTurn();
  };
  await withNativePlugin(async (fixture) => {
    try {
      const session = await connectNativeSession(fixture);
      session.socket.serverEvent(nativeDelegation("original-task", prompt));
      await vi.waitFor(() => {
        if (startupError) {
          throw new Error("Native backend startup failed", { cause: startupError });
        }
        expect(activeRun).toBeDefined();
      });
      if (!activeRun?.abortSignal) {
        throw new Error("Native delegation did not admit a cancellable model run");
      }
      // Prove the parked backend's real control owner is ready before testing event order.
      // This read-only RPC also keeps cold runtime loading out of negative action assertions.
      expect(
        await fixture.invoke("talk.client.steer", { text: "Status?", mode: "status" }),
      ).toMatchObject({ active: true, sessionId: activeRun.sessionId });
      await run({
        ...fixture,
        ...session,
        activeRun: { ...activeRun, abortSignal: activeRun.abortSignal },
        abortOwned,
        queueMessage,
        settleBackend,
      });
    } finally {
      await settleBackend();
    }
  });
}

export function installNativePluginTestHooks() {
  beforeEach(() => {
    upstream.sockets.length = 0;
    upstream.fetch.mockReset();
    upstream.fetch.mockImplementation(async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.hostname !== "chatgpt.com" || url.pathname !== "/backend-api/codex/realtime/calls") {
        throw new Error("Unexpected provider HTTP request");
      }
      return new Response("v=native-answer\r\n", {
        status: 201,
        headers: { Location: `/v1/live/rtc_native_test_${upstream.fetch.mock.calls.length}` },
      });
    });
    vi.stubGlobal("fetch", upstream.fetch);
    upstream.authConfigured.mockClear();
    upstream.resolveAuth.mockClear();
    upstream.runEmbeddedAgent
      .mockReset()
      .mockRejectedValue(new Error("Unexpected model invocation"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}
