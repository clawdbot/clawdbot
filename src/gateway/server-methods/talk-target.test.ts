import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as clientVoiceSession from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../talk-client-gateway-control.js";
import { cleanupTalkConnection } from "../talk-session-registry.js";
import { createTalkClient } from "./talk-client-create.js";
import { talkClientHandlers } from "./talk-client.js";
import { talkSessionHandlers } from "./talk-session.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveConfiguredRealtimeVoiceProvider: vi.fn(),
  bootstrap: vi.fn(async () => undefined),
  createRelay: vi.fn(() => ({
    relaySessionId: "test-relay",
    provider: "test-voice",
    transport: "gateway-relay",
  })),
  createTranscription: vi.fn(() => ({ transcriptionSessionId: "test-dictation" })),
  transcriptionProviders: vi.fn(() => []),
}));

vi.mock("../../talk/provider-resolver.js", () => ({
  resolveConfiguredRealtimeVoiceProvider: mocks.resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceProviderCapabilities: ({
    provider,
  }: {
    provider: RealtimeVoiceProviderPlugin;
  }) => provider.capabilities,
}));
vi.mock("../../talk/provider-registry.js", () => ({ listRealtimeVoiceProviders: () => [] }));
vi.mock("../../agents/realtime-bootstrap-context.js", () => ({
  resolveRealtimeBootstrapContextInstructions: mocks.bootstrap,
}));
vi.mock("../talk-realtime-relay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk-realtime-relay.js")>()),
  createTalkRealtimeRelaySession: mocks.createRelay,
}));
vi.mock("../talk-transcription-relay.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../talk-transcription-relay.js")>()),
  createTalkTranscriptionRelaySession: mocks.createTranscription,
}));
vi.mock("../../realtime-transcription/provider-registry.js", () => ({
  listRealtimeTranscriptionProviders: mocks.transcriptionProviders,
  getRealtimeTranscriptionProvider: () => undefined,
}));

const createParams = {
  mode: "realtime",
  transport: "webrtc",
  brain: "agent-consult",
  silenceDurationMs: 400,
  capabilities: ["gateway-control-v1"],
};

const browserSession = {
  provider: "test-voice",
  transport: "webrtc" as const,
  clientSecret: "synthetic-offer-token",
  offerUrl: "/test/voice/offer",
};

let state: OpenClawTestState;
let config: OpenClawConfig;
let client: ReturnType<typeof sharingPolicyClient> & { connId: string };
const createBrowserSession = vi.fn<
  NonNullable<RealtimeVoiceProviderPlugin["createBrowserSession"]>
>(async () => browserSession);
const createdCalls: Array<{ sessionKey: string; voiceSessionId: string }> = [];
const cancelBrowserSession = vi.fn(async () => undefined);
const context = {
  getRuntimeConfig: () => config,
  getClientConnIds: () => new Set([client.connId]),
  chatAbortControllers: new Map(),
  logGateway: { warn: vi.fn() },
  broadcastToConnIds: vi.fn(),
} as unknown as GatewayRequestContext;

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  handlers: GatewayRequestHandlers = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "talk-request", method, params },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
    extraHandlers: { ...talkClientHandlers, ...talkSessionHandlers, ...handlers },
  });
  if (method === "talk.client.create" && respond.mock.calls[0]?.[0] === true) {
    const { voiceSessionId } = respond.mock.calls[0][1] as { voiceSessionId: string };
    const record = ["voice", "primary"]
      .map((agentId) => clientVoiceSessionTesting.readRecord(agentId, voiceSessionId))
      .find(Boolean);
    if (record) {
      createdCalls.push({ sessionKey: record.sessionKey, voiceSessionId });
    }
  }
  return respond;
}

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "talk-target" });
  client = {
    ...sharingPolicyClient({ user: ensureProfileForEmail("listener@example.test").id }),
    connId: "talk-target-test",
  };
  config = {
    agents: { ownership: "explicit", entries: { primary: {}, voice: {} } },
    talk: { agentId: "voice" },
  };
  vi.clearAllMocks();
  createdCalls.length = 0;
  createBrowserSession.mockReset().mockResolvedValue(browserSession);
  mocks.bootstrap.mockReset().mockResolvedValue(undefined);
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider = {
    id: "test-voice",
    capabilities: { supportsGatewayControl: true, supportsToolCalls: true },
    createBrowserSession,
  };
  Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
    value: { isBrowserSessionConfigured: () => true, cancelBrowserSession },
  });
  mocks.resolveConfiguredRealtimeVoiceProvider.mockReturnValue({ provider, providerConfig: {} });
});

afterEach(async () => {
  try {
    for (const call of createdCalls) {
      await closeTalkClientGatewayControlSession({ ...call, connId: client.connId });
    }
    cleanupTalkConnection(client.connId, context.logGateway);
  } finally {
    vi.restoreAllMocks();
    clientVoiceSessionTesting.reset();
    setActivePluginRegistry(createEmptyPluginRegistry());
    await state.cleanup();
  }
});

describe("Talk target preparation through Gateway authorization", () => {
  it.each(["main", undefined])("uses the configured Talk owner for %s", async (sessionKey) => {
    const respond = await dispatch("talk.client.create", {
      ...createParams,
      ...(sessionKey ? { sessionKey } : {}),
    });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(browserSession), undefined);
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "voice" }),
    );
    expect(
      loadSessionEntry({ agentId: "voice", sessionKey: "agent:voice:main" })?.sessionId,
    ).toBeTruthy();
  });

  it.each<{ name: string; agents: NonNullable<OpenClawConfig["agents"]> }>([
    { name: "sole agent", agents: { entries: { voice: {} }, ownership: "explicit" as const } },
    {
      name: "system agent",
      agents: {
        entries: { primary: {}, voice: {} },
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "voice" } },
      },
    },
    { name: "legacy default", agents: { entries: { primary: {}, voice: { default: true } } } },
  ])("uses a valid $name default without talk.agentId", async ({ agents }) => {
    config = { agents };
    const respond = await dispatch("talk.client.create", createParams);
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(browserSession), undefined);
    expect(createBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "voice" }),
    );
  });

  it.each([
    { agentId: "voice", withoutOwner: true, name: "missing ambient owner" },
    { agentId: "primary", withoutOwner: false, name: "different Talk owner" },
  ])("honors the explicitly selected session with a $name", async ({ agentId, withoutOwner }) => {
    if (withoutOwner) {
      delete config.talk;
    }
    const sessionKey = `agent:${agentId}:selected`;
    const respond = await dispatch("talk.client.create", { ...createParams, sessionKey });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(browserSession), undefined);
    expect(mocks.bootstrap).toHaveBeenCalledWith(expect.objectContaining({ agentId, sessionKey }));
  });

  it("rejects ambiguous default ownership before loading profile or provider state", async () => {
    delete config.talk;
    const respond = await dispatch("talk.client.create", createParams);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("explicit owner"),
      }),
    );
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(createBrowserSession).not.toHaveBeenCalled();
  });

  it.each(["read-only", "draft", "incognito"] as const)(
    "applies %s restrictions to bare and omitted create targets",
    async (restriction) => {
      await replaceSessionEntry(
        { agentId: "voice", sessionKey: "agent:voice:main" },
        {
          sessionId: "private-session",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "another-person" },
          ...(restriction === "incognito" ? { incognito: true } : { visibility: restriction }),
        },
      );
      for (const method of ["talk.client.create", "talk.session.create"]) {
        for (const sessionKey of ["main", undefined]) {
          const respond = await dispatch(method, {
            mode: "realtime",
            brain: "agent-consult",
            transport: method === "talk.client.create" ? "webrtc" : "gateway-relay",
            ...(sessionKey ? { sessionKey } : {}),
          });
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
        }
      }
      expect(createBrowserSession).not.toHaveBeenCalled();
      expect(mocks.createRelay).not.toHaveBeenCalled();
      expect(mocks.bootstrap).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "custom main", sessionKey: "main", mainKey: "home", canonicalKey: "agent:voice:home" },
    { name: "omitted custom main", mainKey: "home", canonicalKey: "agent:voice:home" },
    { name: "global alias", sessionKey: "main", global: true, canonicalKey: "global" },
    {
      name: "global explicit owner",
      sessionKey: "agent:voice:main",
      global: true,
      canonicalKey: "global",
    },
    { name: "omitted global", global: true, canonicalKey: "global" },
    {
      name: "fixed-store owner",
      sessionKey: "main",
      fixed: true,
      canonicalKey: "agent:primary:main",
    },
    { name: "omitted fixed-store owner", fixed: true, canonicalKey: "agent:primary:main" },
    {
      name: "global fixed-store owner",
      sessionKey: "main",
      fixed: true,
      global: true,
      canonicalKey: "global",
    },
    {
      name: "explicit global fixed-store owner",
      sessionKey: "agent:primary:main",
      fixed: true,
      global: true,
      canonicalKey: "global",
    },
  ])(
    "shares one canonical storage target for $name while retaining the exact voice key",
    async (entry) => {
      const agentId = entry.fixed ? "primary" : "voice";
      config.session = {
        ...(entry.mainKey ? { mainKey: entry.mainKey } : {}),
        ...(entry.global ? { scope: "global" } : {}),
        ...(entry.fixed ? { store: state.statePath("shared", "sessions.sqlite") } : {}),
      };
      if (entry.fixed) {
        config.agents!.defaults = { sessionStore: { agentId } };
      }
      const params = Object.freeze({
        ...createParams,
        ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
      });
      const respond = await dispatch("talk.client.create", params);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining(browserSession),
        undefined,
      );
      const { voiceSessionId } = respond.mock.calls[0]![1] as { voiceSessionId: string };
      const voiceKey = entry.sessionKey ?? `agent:${agentId}:${entry.mainKey ?? "main"}`;
      expect(clientVoiceSessionTesting.readRecord(agentId, voiceSessionId)?.sessionKey).toBe(
        voiceKey,
      );
      const scope = {
        agentId,
        sessionKey: entry.canonicalKey,
        ...(entry.fixed ? { storePath: config.session.store } : {}),
      };
      const stored = loadSessionEntry(scope);
      expect(stored?.sessionId).toBeTruthy();
      expect(mocks.bootstrap).toHaveBeenCalledWith(
        expect.objectContaining({ agentId, sessionKey: entry.canonicalKey }),
      );
      expect(
        await dispatch("talk.client.transcript", {
          sessionKey: voiceKey,
          voiceSessionId,
          entryId: "utterance",
          role: "user",
          text: "Synthetic speech",
        }),
      ).toHaveBeenCalledWith(true, { ok: true }, undefined);
      expect(
        readSessionTranscriptMessageEvents({ ...scope, sessionId: stored!.sessionId }),
      ).toHaveLength(1);
      if (voiceKey !== entry.canonicalKey) {
        expect(
          await dispatch("talk.client.close", { sessionKey: entry.canonicalKey, voiceSessionId }),
        ).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
      }
      expect(
        await dispatch("talk.client.close", { sessionKey: voiceKey, voiceSessionId }),
      ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    },
  );

  it.each([
    { name: "missing key", params: { voiceSessionId: "relay-call" } },
    { name: "missing voice id", params: { sessionKey: "main" } },
    { name: "relay origin", params: { sessionKey: "main", voiceSessionId: "relay-call" } },
  ])("rejects a client close with $name without changing the voice record", async ({ params }) => {
    clientVoiceSession.createOrResumeClientVoiceSession({
      agentId: "voice",
      sessionKey: "main",
      voiceSessionId: "relay-call",
      origin: "relay",
    });
    expect(await dispatch("talk.client.close", params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(clientVoiceSessionTesting.readRecord("voice", "relay-call")?.status).toBe("open");
  });

  it.each(["primary", "retired"])(
    "rejects a global key conflicting with fixed-store owner %s",
    async (owner) => {
      config.session = { scope: "global", store: state.statePath("shared", "sessions.sqlite") };
      config.agents!.defaults = { sessionStore: { agentId: owner } };
      const respond = await dispatch("talk.client.create", {
        ...createParams,
        sessionKey: "agent:voice:main",
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(createBrowserSession).not.toHaveBeenCalled();
      expect(mocks.bootstrap).not.toHaveBeenCalled();
    },
  );

  it.each([
    "owner",
    "removed-agent",
    "main-key",
    "global-main-key",
    "scope",
    "store",
    "sharing",
    "incognito",
  ] as const)(
    "rejects %s changes during provider creation without writing a different target",
    async (change) => {
      const gate = createDeferredCore<typeof browserSession>();
      const started = createDeferredCore();
      createBrowserSession.mockImplementationOnce(async () => {
        started.resolve();
        return await gate.promise;
      });
      if (change === "global-main-key") {
        config.session = { scope: "global" };
      }
      const pending = dispatch("talk.client.create", {
        ...createParams,
        ...(change === "global-main-key" ? {} : { sessionKey: "main" }),
      });
      await started.promise;
      if (change === "removed-agent") {
        config = { ...config, agents: { ownership: "explicit", entries: { primary: {} } } };
      } else if (change === "global-main-key") {
        config = { ...config, session: { scope: "global", mainKey: "changed" } };
      } else if (change === "owner") {
        config = { ...config, talk: { agentId: "primary" } };
      } else if (change === "main-key") {
        config = { ...config, session: { mainKey: "changed" } };
      } else if (change === "scope") {
        config = { ...config, session: { scope: "global" } };
      } else if (change === "store") {
        config = { ...config, session: { store: state.statePath("changed", "sessions.sqlite") } };
      } else {
        await replaceSessionEntry(
          { agentId: "voice", sessionKey: "agent:voice:main" },
          {
            sessionId: "concurrent-session",
            updatedAt: 1,
            ...(change === "incognito"
              ? { incognito: true }
              : { visibility: "read-only" as const }),
          },
        );
      }
      gate.resolve(browserSession);
      const respond = await pending;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(cancelBrowserSession).toHaveBeenCalledOnce();
      expect(
        loadSessionEntry({ agentId: "primary", sessionKey: "agent:primary:main" }),
      ).toBeUndefined();
      expect(
        loadSessionEntry({ agentId: "voice", sessionKey: "agent:voice:changed" }),
      ).toBeUndefined();
      if (change !== "sharing" && change !== "incognito") {
        expect(
          loadSessionEntry({ agentId: "voice", sessionKey: "agent:voice:main" }),
        ).toBeUndefined();
      }
    },
  );

  it.each(["agent", "hidden", "sandbox"] as const)(
    "enforces the %s role boundary on an omitted target",
    async (restriction) => {
      config.gateway = {
        roles: {
          default: "limited",
          definitions: {
            limited: {
              agents: restriction === "agent" ? ["primary"] : "*",
              sessions: { others: restriction === "hidden" ? "none" : "write" },
              scopes: ["operator.read", "operator.write"],
              ...(restriction === "sandbox" ? { sandbox: "required" } : {}),
            },
          },
        },
      };
      if (restriction !== "agent") {
        await replaceSessionEntry(
          { agentId: "voice", sessionKey: "agent:voice:main" },
          {
            sessionId: "host-session",
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: "another-person" },
          },
        );
      }
      const respond = await dispatch("talk.client.create", createParams);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: restriction === "hidden" ? "INVALID_REQUEST" : "FORBIDDEN",
        }),
      );
      expect(createBrowserSession).not.toHaveBeenCalled();
      expect(mocks.bootstrap).not.toHaveBeenCalled();
    },
  );

  it("does not retarget between router authorization and lazy handler dispatch", async () => {
    const gate = createDeferredCore();
    const started = createDeferredCore();
    const pending = dispatch("talk.client.create", createParams, {
      "talk.client.create": async (request) => {
        started.resolve();
        await gate.promise;
        return createTalkClient(request);
      },
    });
    await started.promise;
    config = { ...config, talk: { agentId: "primary" } };
    gate.resolve();
    expect(await pending).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(createBrowserSession).not.toHaveBeenCalled();
  });

  it.each(["main", undefined])(
    "passes the authorized %s target into relay creation",
    async (sessionKey) => {
      config.session = { scope: "global" };
      const respond = await dispatch("talk.session.create", {
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        ...(sessionKey ? { sessionKey } : {}),
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ sessionId: "test-relay" }),
        undefined,
      );
      expect(mocks.createRelay).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionTarget: expect.objectContaining({
            agentId: "voice",
            canonicalKey: "global",
            sessionKey: sessionKey ?? "agent:voice:main",
          }),
        }),
      );
      expect(loadSessionEntry({ agentId: "voice", sessionKey: "global" })?.sessionId).toBeTruthy();
    },
  );

  it("keeps keyless transcription independent of Talk agent selection", async () => {
    delete config.talk;
    mocks.transcriptionProviders.mockReturnValue([
      { id: "test-transcription", isConfigured: () => true },
    ] as never);
    const respond = await dispatch("talk.session.create", {
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ sessionId: "test-dictation" }),
      undefined,
    );
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(createBrowserSession).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "voice", sessionKey: "agent:voice:main" })).toBeUndefined();
  });

  it.each(["owner", "sharing", "incognito", "replacement"] as const)(
    "rechecks %s after the guarded ensure settles and before publishing the call",
    async (change) => {
      if (change === "sharing") {
        await replaceSessionEntry(
          { agentId: "voice", sessionKey: "agent:voice:main" },
          {
            sessionId: "existing-shared-session",
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: "another-person" },
          },
        );
      }
      const ensure = clientVoiceSession.ensureClientVoiceAgentSessionEntry;
      vi.spyOn(clientVoiceSession, "ensureClientVoiceAgentSessionEntry").mockImplementationOnce(
        async (params) => {
          const sessionId = await ensure(params);
          if (change === "owner") {
            config = { ...config, talk: { agentId: "primary" } };
          } else {
            await replaceSessionEntry(params, {
              sessionId: change === "replacement" ? "replacement-session" : sessionId,
              updatedAt: 2,
              createdActor: { type: "human", source: "profile", id: "another-person" },
              ...(change === "incognito" ? { incognito: true } : { visibility: "read-only" }),
            });
          }
          return sessionId;
        },
      );
      const respond = await dispatch("talk.client.create", {
        ...createParams,
        voiceSessionId: "provisional",
      });
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(clientVoiceSessionTesting.readRecord("voice", "provisional")).toBeUndefined();
      expect(cancelBrowserSession).toHaveBeenCalledOnce();
    },
  );

  it("retains the identified creator when a restricted role creates its first Talk session", async () => {
    config.gateway = {
      roles: {
        default: "personal",
        definitions: {
          personal: {
            agents: ["voice"],
            sessions: { others: "none" },
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    };
    expect(await dispatch("talk.client.create", createParams)).toHaveBeenCalledWith(
      true,
      expect.objectContaining(browserSession),
      undefined,
    );
    expect(
      loadSessionEntry({ agentId: "voice", sessionKey: "agent:voice:main" })?.createdActor,
    ).toEqual({ type: "human", source: "profile", id: client.authenticatedUserProfile?.profileId });
  });

  it("rejects a default-owner change while profile preparation is awaited", async () => {
    const gate = createDeferredCore<undefined>();
    const started = createDeferredCore();
    mocks.bootstrap.mockImplementationOnce(async () => {
      started.resolve();
      return await gate.promise;
    });
    const pending = dispatch("talk.client.create", createParams);
    await started.promise;
    config = { ...config, talk: { agentId: "primary" } };
    gate.resolve(undefined);
    expect(await pending).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(createBrowserSession).not.toHaveBeenCalled();
  });
});
