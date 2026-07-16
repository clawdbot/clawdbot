// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AVATAR_MAX_BYTES } from "../../shared/avatar-policy.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  REAL_PNG,
  REAL_PNG_DATA_URL,
  getAgentTestMocks,
  makeContext,
  type AgentHandlerArgs,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  expectStringFieldContains,
  mockCallArg,
  expectRespondError,
  mockMainSessionEntry,
  setupNewYorkTimeConfig,
  resetTimeConfig,
  expectResetCall,
  primeMainAgentRun,
  runMainAgent,
  runMainAgentAndCaptureEntry,
  waitForAgentCommandCall,
  mockSessionResetSuccess,
  invokeAgent,
  invokeAgentIdentityGet,
  describe0AfterEach0,
} from "./agent.test-harness.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("routes voice wake trigger to configured session target", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:voice",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-1",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:voice");
  });

  it("ignores voice wake session route targeting unknown agent", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { mode: "current" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:ghost:main" });

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-unknown",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-2",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:main");
  });

  it("applies default voice wake route when trigger field is present but empty", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "main" ? "agent:main:main" : sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        voiceWakeTrigger: " ",
        idempotencyKey: "test-voice-route-default-target",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-3",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:voice");
    const routeCall = mocks.resolveVoiceWakeRouteByTrigger.mock.calls.find(([args]) => {
      return (args as Record<string, unknown>).trigger === undefined;
    });
    const routeArgs = expectRecordFields(requireValue(routeCall, "route call missing")[0], {
      trigger: undefined,
    });
    expect(typeof routeArgs.config).toBe("object");
  });

  it("trims whitespace-only delivery fields before disabling voice wake auto-routing", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "main" ? "agent:main:main" : sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        to: "   ",
        replyTo: "   ",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-whitespace-delivery",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-4",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:voice");
    const routeCall = mocks.resolveVoiceWakeRouteByTrigger.mock.calls.find(([args]) => {
      return (args as Record<string, unknown>).trigger === "robot wake";
    });
    const routeArgs = expectRecordFields(requireValue(routeCall, "route call missing")[0], {
      trigger: "robot wake",
    });
    expect(typeof routeArgs.config).toBe("object");
  });

  it("does not auto-route voice wake requests with an explicit session key", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.loadVoiceWakeRoutingConfig.mockClear();
    mocks.resolveVoiceWakeRouteByTrigger.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "agent:main:research",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-explicit-session",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-5",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:research");
    expect(mocks.loadVoiceWakeRoutingConfig).not.toHaveBeenCalled();
    expect(mocks.resolveVoiceWakeRouteByTrigger).not.toHaveBeenCalled();
  });

  it("does not auto-route voice wake requests with another agent's explicit main session", async () => {
    const opsAgentCfg = { agents: { list: [{ id: "main" }, { id: "ops" }] } };
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: opsAgentCfg,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.loadVoiceWakeRoutingConfig.mockClear();
    mocks.resolveVoiceWakeRouteByTrigger.mockClear();
    mocks.agentCommand.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "agent:ops:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-explicit-other-agent-main",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-5b",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:ops:main");
    expect(mocks.loadVoiceWakeRoutingConfig).not.toHaveBeenCalled();
    expect(mocks.resolveVoiceWakeRouteByTrigger).not.toHaveBeenCalled();
  });

  it("treats explicit sessionId as an opt-out for voice wake auto-routing", async () => {
    mocks.loadVoiceWakeRoutingConfig.mockResolvedValue({
      version: 1,
      defaultTarget: { sessionKey: "agent:main:voice" },
      routes: [],
      updatedAtMs: 0,
    });
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });

    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "main" ? "main-session-id" : "voice-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "main" ? "agent:main:main" : sessionKey,
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    mocks.loadVoiceWakeRoutingConfig.mockClear();
    mocks.resolveVoiceWakeRouteByTrigger.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "do thing",
        sessionKey: "main",
        sessionId: "caller-selected-session-id",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: "test-voice-route-explicit-session-id",
      },
      {
        respond,
        context: makeContext(),
        reqId: "voice-6",
      },
    );

    const callArgs = await waitForAgentCommandCall<{ sessionKey?: string }>();
    expect(callArgs.sessionKey).toBe("agent:main:main");
    expect(mocks.loadVoiceWakeRoutingConfig).not.toHaveBeenCalled();
    expect(mocks.resolveVoiceWakeRouteByTrigger).not.toHaveBeenCalled();
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-2");
    // Should be undefined, not cause an error
    expect(capturedEntry.cliSessionIds).toBeUndefined();
    expect(capturedEntry.claudeCliSessionId).toBeUndefined();
  });

  it("prunes legacy main alias keys when writing a canonical session entry", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {
        session: { mainKey: "work" },
        agents: { list: [{ id: "main", default: true }] },
      },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:work",
      storeKeys: ["agent:main:work", "agent:main:main"],
    });

    let capturedStore: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:work": { sessionId: "existing-session-id", updatedAt: 10 },
        "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 5 },
      };
      await updater(store);
      capturedStore = store;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "test",
        agentId: "main",
        sessionKey: "main",
        idempotencyKey: "test-idem-alias-prune",
      },
      { reqId: "3" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    const sessionStore = requireValue(capturedStore, "updated session store missing");
    expect(sessionStore).toHaveProperty("agent:main:work");
    expect(sessionStore["agent:main:main"]).toBeUndefined();
  });

  it("handles bare /new by resetting the same session without running the model", async () => {
    mockSessionResetSuccess({ reason: "new" });
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/new",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new",
      },
      {
        reqId: "4",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId: "test-idem-new",
      status: "ok",
      summary: "completed",
    });
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      payloads?: Array<{ text?: string }>;
      meta?: { agentMeta?: { sessionId?: string } };
    };
    expect(result.payloads?.[0]?.text).toBe("✅ New session started.");
    expect(result.meta?.agentMeta?.sessionId).toBe("reset-session-id");
  });

  it("persists the post-reset follow-up prompt in the canonical user-turn recorder", async () => {
    mockSessionResetSuccess({ reason: "new", sessionId: "reset-session-id" });
    mockMainSessionEntry({ sessionId: "reset-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "/new continue with this prompt",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new-followup-recorder",
      },
      {
        reqId: "4-new-followup-recorder",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    const call = await waitForAgentCommandCall<{
      message?: string;
      userTurnTranscriptRecorder?: { message?: { content?: string } };
    }>();
    expect(call.message).toBe("continue with this prompt");
    expect(call.userTurnTranscriptRecorder?.message?.content).toBe("continue with this prompt");
  });

  it("handles bare /reset by resetting the same session without running the model", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset",
      },
      {
        reqId: "4-reset",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
  });

  it("dedupes bare /reset retries after returning the terminal ack", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const request = {
      message: "/reset",
      sessionKey: "agent:main:main",
      idempotencyKey: "test-idem-reset-retry",
    };
    const client = {
      connect: { scopes: ["operator.admin"] },
    } as AgentHandlerArgs["client"];

    const firstRespond = await invokeAgent(request, {
      reqId: "4-reset-retry-first",
      client,
      context,
    });
    const secondRespond = await invokeAgent(request, {
      reqId: "4-reset-retry-second",
      client,
      context,
    });

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(firstRespond)).toBe(true);
    expect(mockCallArg(secondRespond)).toBe(true);
    expect(mockCallArg(secondRespond, 0, 1)).toEqual(mockCallArg(firstRespond, 0, 1));
    expect(mockCallArg(secondRespond, 0, 3)).toEqual({ cached: true });
  });

  it("honors strict delivery validation for bare /reset without running the model", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mockMainSessionEntry({ sessionId: "reset-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        deliver: true,
        bestEffortDeliver: false,
        idempotencyKey: "test-idem-reset-deliver-missing-target",
      },
      {
        reqId: "4-reset-deliver-missing-target",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(false);
    expect(mockCallArg(respond, 0, 2)).toMatchObject({
      message: expect.stringContaining(
        "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
      ),
    });
  });

  it("keeps main-session bare /reset delivery best-effort by default", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mockMainSessionEntry({ sessionId: "reset-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        deliver: true,
        idempotencyKey: "test-idem-reset-deliver-best-effort",
      },
      {
        reqId: "4-reset-deliver-best-effort",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      deliveryStatus?: { requested?: boolean; reason?: string };
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expect(result.deliveryStatus).toMatchObject({
      requested: true,
      reason: "channel_resolved_to_internal",
    });
  });

  it("uses the selected session target for bare /reset delivery when to is an agent session key", async () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mockSessionResetSuccess({ reason: "reset", key: sessionKey, sessionId: "wechat-session-id" });
    mocks.loadSessionEntry.mockImplementation((key: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: key === sessionKey ? "wechat-session-id" : "main-session-id",
        updatedAt: Date.now(),
        lastChannel: "openclaw-weixin",
        lastTo: "o9cq802hhmfc@im.wechat",
      },
      canonicalKey: key,
    }));
    mocks.getChannelPlugin.mockImplementation((channel: string) =>
      channel === "openclaw-weixin"
        ? {
            id: "openclaw-weixin",
            meta: { label: "WeChat" },
            capabilities: { chatTypes: ["direct"] },
            config: {},
            outbound: {
              resolveTarget: ({ to }: { to?: string }) =>
                to === "o9cq802hhmfc@im.wechat"
                  ? { ok: true, to }
                  : { ok: false, error: new Error(`unexpected target: ${to ?? "none"}`) },
            },
          }
        : undefined,
    );
    mocks.sendDurableMessageBatch.mockResolvedValue({
      status: "sent",
      results: [],
      receipt: {},
    });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        to: sessionKey,
        deliver: true,
        idempotencyKey: "test-idem-reset-deliver-session-key-to",
      },
      {
        reqId: "4-reset-deliver-session-key-to",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
        context: { ...makeContext(), deps: {} } as GatewayRequestContext,
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      deliveryStatus?: { requested?: boolean; status?: string; succeeded?: boolean };
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expect(result.deliveryStatus).toMatchObject({
      requested: true,
      status: "sent",
      succeeded: true,
    });
    expect(mocks.sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "openclaw-weixin",
        to: "o9cq802hhmfc@im.wechat",
      }),
    );
  });

  it("resets the selected global agent session for bare /new without startup context", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.performGatewaySessionReset.mockClear();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { key: string; agentId?: string; reason: string; commandSource: string }) => {
        expect(opts).toMatchObject({
          key: "global",
          agentId: "work",
          reason: "new",
          commandSource: "gateway:agent",
        });
        return {
          ok: true,
          key: "global",
          entry: { sessionId: "global-work-reset-session" },
        };
      },
    );

    const respond = await invokeAgent(
      {
        message: "/new",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "test-idem-new-selected-global",
      },
      {
        reqId: "4c-startup",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      payloads?: Array<{ text?: string }>;
      meta?: { agentMeta?: { sessionId?: string } };
    };
    expect(result.payloads?.[0]?.text).toBe("✅ New session started.");
    expect(result.meta?.agentMeta?.sessionId).toBe("global-work-reset-session");
  });

  it("uses /reset suffix as the post-reset message for LLM-boundary timestamping", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    primeMainAgentRun({
      sessionId: "reset-session-id",
      cfg: mocks.loadConfigReturn,
    });

    await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset-suffix",
      },
      {
        reqId: "4b",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    const call = await expectResetCall("check status");
    expect(call?.sessionId).toBe("reset-session-id");

    resetTimeConfig();
  });

  it("resets the selected global agent session from agent commands", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.performGatewaySessionReset.mockClear();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { key: string; agentId?: string; reason: string; commandSource: string }) => {
        expect(opts).toMatchObject({
          key: "global",
          agentId: "work",
          reason: "reset",
          commandSource: "gateway:agent",
        });
        return {
          ok: true,
          key: "global",
          entry: { sessionId: "global-work-reset-session" },
        };
      },
    );
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-reset-session",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "global",
        agentId: "work",
        idempotencyKey: "test-idem-reset-selected-global",
      },
      {
        reqId: "4c",
        client: { connect: { scopes: ["operator.admin"] } } as AgentHandlerArgs["client"],
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    const call = await waitForAgentCommandCall<{ agentId?: string; sessionKey?: string }>();
    expect(call.agentId).toBe("work");
    expect(call.sessionKey).toBe("global");

    resetTimeConfig();
  });

  it("rejects malformed agent session keys early in agent handler", async () => {
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main",
        idempotencyKey: "test-malformed-session-key",
      },
      { reqId: "4" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "malformed session key");
  });

  it.each(["/reset", "/new", "/reset check status"] as const)(
    "rejects %s for write-scoped gateway callers",
    async (message) => {
      mockMainSessionEntry({ sessionId: "existing-session-id" });
      mocks.performGatewaySessionReset.mockClear();
      mocks.agentCommand.mockClear();

      const respond = await invokeAgent(
        {
          message,
          sessionKey: "agent:main:main",
          idempotencyKey: `test-reset-write-scope-${message.replace(/\W+/g, "-")}`,
        },
        {
          reqId: "4c",
          client: { connect: { scopes: ["operator.write"] } } as AgentHandlerArgs["client"],
        },
      );

      expect(mocks.performGatewaySessionReset).not.toHaveBeenCalled();
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expectRespondError(respond, { message: "missing scope: operator.admin" });
    },
  );

  it("rejects malformed session keys in agent.identity.get", async () => {
    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main",
      },
      { reqId: "5" },
    );

    const error = expectRespondError(respond, {});
    expectStringFieldContains(error, "message", "malformed session key");
  });

  it("redacts unsafe avatar sources in agent.identity.get", async () => {
    mocks.loadConfigReturn = {
      agents: {
        defaults: { workspace: "/tmp/workspace" },
        list: [{ id: "main", identity: { avatar: "/Users/test/private/avatar.png" } }],
      },
    };

    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main:main",
      },
      { reqId: "5-avatar-source" },
    );

    expect(mockCallArg(respond)).toBe(true);
    expectRecordFields(mockCallArg(respond, 0, 1), {
      agentId: "main",
      avatar: "A",
      avatarSource: undefined,
      avatarStatus: "none",
      avatarReason: "outside_workspace",
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
  });

  it("returns workspace-relative avatars as data URLs in agent.identity.get", async () => {
    await withTempDir({ prefix: "openclaw-agent-avatar-" }, async (workspace) => {
      await fs.mkdir(path.join(workspace, "avatars"), { recursive: true });
      await fs.writeFile(path.join(workspace, "avatars", "main.png"), "avatar", "utf8");
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", identity: { avatar: "avatars/main.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-avatar-data" },
      );

      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
        avatarSource: "avatars/main.png",
        avatarStatus: "local",
      });
    });
  });

  it.each([
    ["remote", "https://example.com/avatar.png"],
    ["data", "data:image/png;base64,aaaa"],
    ["text", "PS"],
  ] as const)("preserves %s avatar values in agent.identity.get", async (_kind, avatar) => {
    mocks.loadConfigReturn = { ui: { assistant: { avatar } } };

    const respond = await invokeAgentIdentityGet(
      { sessionKey: "agent:main:main" },
      { reqId: `5-avatar-${_kind}` },
    );

    expect((mockCallArg(respond, 0, 1) as { avatar?: unknown }).avatar).toBe(avatar);
  });

  it("prefixes same-origin avatar routes in agent.identity.get when Control UI has a base path", async () => {
    mocks.loadConfigReturn = {
      gateway: { controlUi: { basePath: "/openclaw" } },
      ui: { assistant: { avatar: "/avatar/main" } },
    };

    const respond = await invokeAgentIdentityGet(
      { sessionKey: "agent:main:main" },
      { reqId: "5-avatar-route-base-path" },
    );

    expect((mockCallArg(respond, 0, 1) as { avatar?: unknown }).avatar).toBe(
      "/openclaw/avatar/main",
    );
  });

  it("replaces rejected local avatar paths with the default instead of a protected route", async () => {
    await withTempDir({ prefix: "openclaw-agent-avatar-missing-" }, async (workspace) => {
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", identity: { avatar: "avatars/missing.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-avatar-missing" },
      );

      expectRecordFields(mockCallArg(respond, 0, 1), {
        avatar: "A",
        avatarSource: "avatars/missing.png",
        avatarStatus: "none",
        avatarReason: "missing",
      });
    });
  });

  it("inlines a workspace-local avatar in agent.identity.get (#97602)", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-avatar-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/avatar.png`, REAL_PNG);
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-local-avatar" },
      );

      expect(mockCallArg(respond)).toBe(true);
      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: REAL_PNG_DATA_URL,
        avatarSource: "avatar.png",
        avatarStatus: "local",
      });
      expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    });
  });

  it("reports a hardlinked avatar as unreadable in agent.identity.get", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-hardlink-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/original.png`, REAL_PNG);
      await fs.link(`${workspace}/original.png`, `${workspace}/avatar.png`);
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-hardlinked-avatar" },
      );

      expect(mockCallArg(respond)).toBe(true);
      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: "A",
        avatarSource: "avatar.png",
        avatarStatus: "none",
        avatarReason: "unreadable",
      });
    });
  });

  it("bounds an agent.identity.get avatar that grows after its descriptor is pinned", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-growth-" }, async (workspace) => {
      const avatarPath = `${workspace}/avatar.png`;
      await fs.writeFile(avatarPath, REAL_PNG);
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { avatar: "avatar.png" } }],
        },
      };
      const originalFstatSync = fsSync.fstatSync;
      const fstatSync = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((fd) => {
        const stat = originalFstatSync(fd);
        fsSync.appendFileSync(avatarPath, Buffer.alloc(AVATAR_MAX_BYTES));
        return stat;
      });

      try {
        const respond = await invokeAgentIdentityGet(
          { sessionKey: "agent:main:main" },
          { reqId: "5-growing-avatar" },
        );

        expect(mockCallArg(respond)).toBe(true);
        expectRecordFields(mockCallArg(respond, 0, 1), {
          agentId: "main",
          avatar: "A",
          avatarSource: "avatar.png",
          avatarStatus: "none",
          avatarReason: "unreadable",
        });
      } finally {
        fstatSync.mockRestore();
      }
    });
  });

  it("keeps configured emoji precedence free of file metadata in agent.identity.get", async () => {
    await withTempDir({ prefix: "openclaw-agent-identity-emoji-" }, async (workspace) => {
      await fs.writeFile(`${workspace}/identity.png`, REAL_PNG);
      await fs.writeFile(`${workspace}/IDENTITY.md`, "- Avatar: identity.png\n");
      mocks.loadConfigReturn = {
        agents: {
          defaults: { workspace },
          list: [{ id: "main", workspace, identity: { emoji: "🦞" } }],
        },
      };

      const respond = await invokeAgentIdentityGet(
        { sessionKey: "agent:main:main" },
        { reqId: "5-emoji-avatar" },
      );

      expect(mockCallArg(respond)).toBe(true);
      expectRecordFields(mockCallArg(respond, 0, 1), {
        agentId: "main",
        avatar: "🦞",
        avatarSource: undefined,
        avatarStatus: undefined,
        avatarReason: undefined,
      });
    });
  });

  it("allows non-delivery agent invocations when sendPolicy is deny", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();
    mocks.resolveSendPolicy.mockReturnValue("deny");

    const respond = await runMainAgent("smoke", "non-delivery-deny");

    expect(mocks.resolveSendPolicy).not.toHaveBeenCalled();
    const rejection = respond.mock.calls.find(
      (call: unknown[]) =>
        call[0] === false &&
        (call[2] as Record<string, unknown> | undefined)?.message ===
          "send blocked by session policy",
    );
    expect(rejection).toBeUndefined();
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));
  });

  it("blocks delivery agent invocations when sendPolicy is deny", async () => {
    primeMainAgentRun();
    mocks.resolveSendPolicy.mockReturnValue("deny");
    mocks.agentCommand.mockClear();

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "smoke",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "delivery-deny",
        deliver: true,
      },
      { respond, reqId: "delivery-deny" },
    );

    expectRespondError(respond, { message: "send blocked by session policy" });
    const sendPolicyArgs = expectRecordFields(mockCallArg(mocks.resolveSendPolicy), {
      sessionKey: "agent:main:main",
    });
    expectRecordFields(sendPolicyArgs.entry, { sessionId: "existing-session-id" });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  describe("groupId session-entry persistence validation", () => {
    async function captureGroupEntryFields(
      sessionKey: string,
      entry: Record<string, unknown>,
      requestGroupId?: string,
    ) {
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "existing-session-id", updatedAt: Date.now(), ...entry },
        canonicalKey: sessionKey,
      });
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store: Record<string, unknown> = {
          [sessionKey]: { sessionId: "existing-session-id", ...entry },
        };
        await updater(store);
        capturedEntry = store[sessionKey] as Record<string, unknown>;
      });
      mocks.agentCommand.mockResolvedValue({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      await invokeAgent({
        message: "hi",
        agentId: "main",
        sessionKey,
        idempotencyKey: `group-persist-${sessionKey}-${requestGroupId ?? "none"}`,
        ...(requestGroupId !== undefined ? { groupId: requestGroupId } : {}),
      });
      return capturedEntry;
    }

    it("drops forged groupId on non-group session before writing session entry", async () => {
      const entry = await captureGroupEntryFields("agent:main:main", {}, "trusted-group");
      expect(entry?.groupId).toBeUndefined();
    });

    it("preserves groupId when session key encodes matching group membership", async () => {
      const entry = await captureGroupEntryFields(
        "agent:main:slack:group:trusted-group",
        {},
        "trusted-group",
      );
      expect(entry?.groupId).toBe("trusted-group");
    });

    it("clears a previously forged groupId from the session entry on reconnection", async () => {
      // Entry carries a forged groupId from a prior request; new request supplies none.
      const entry = await captureGroupEntryFields(
        "agent:main:main",
        { groupId: "trusted-group" },
        undefined,
      );
      expect(entry?.groupId).toBeUndefined();
    });

    it("trusts groupId when spawnedBy session key encodes the matching group", async () => {
      const entry = await captureGroupEntryFields(
        "agent:main:main",
        { spawnedBy: "agent:main:slack:group:trusted-group" },
        "trusted-group",
      );
      expect(entry?.groupId).toBe("trusted-group");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
