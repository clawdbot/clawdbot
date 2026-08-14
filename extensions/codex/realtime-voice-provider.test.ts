import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { buildCodexRealtimeVoiceProvider } from "./realtime-voice-provider.js";

describe("Codex realtime voice provider", () => {
  const provider = buildCodexRealtimeVoiceProvider({ runtime: {} as PluginRuntime });

  it("selects subscription-backed V3 and preserves provider voice config", () => {
    expect(
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: { voice: "arbor" },
      }),
    ).toEqual({ version: "v3", voice: "arbor" });
    expect(provider.capabilities?.brains).toEqual(["codex-realtime"]);
  });

  it("rejects legacy realtime versions and API keys", () => {
    expect(() => provider.resolveConfig?.({ cfg: {}, rawConfig: { version: "v2" } })).toThrow(
      'supports only version "v3"',
    );
    expect(() => provider.resolveConfig?.({ cfg: {}, rawConfig: { apiKey: "secret" } })).toThrow(
      "uses the Codex app-server subscription",
    );
  });

  it("buffers input until connected and closes the established run gracefully", async () => {
    let resolveInnerConnect!: () => void;
    const innerConnect = new Promise<void>((resolve) => {
      resolveInnerConnect = resolve;
    });
    const connectInner = vi.fn(() => innerConnect);
    const sendInnerAudio = vi.fn();
    const closeInner = vi.fn();
    let runSignal: AbortSignal | undefined;
    const onAgentEvent = vi.fn();
    let sessionEntry: { sessionId: string; updatedAt: number; [key: string]: unknown } | undefined;
    const inner = {
      connect: connectInner,
      sendAudio: sendInnerAudio,
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: closeInner,
      isConnected: vi.fn(() => true),
    } as RealtimeVoiceBridge;
    const runtime = {
      agent: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/codex-realtime-sessions.sqlite"),
          patchSessionEntry: vi.fn(async (params) => {
            const base = sessionEntry ?? {
              ...params.fallbackEntry,
              spawnedCwd: "/tmp/session-worktree",
            };
            sessionEntry = { ...base, ...(await params.update(base)), updatedAt: Date.now() };
            return sessionEntry;
          }),
        },
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentTimeoutMs: vi.fn(() => 60_000),
        runEmbeddedAgent: vi.fn(async (params) => {
          runSignal = params.abortSignal;
          params.realtimeVoice.onBridgeReady(inner);
        }),
      },
    } as unknown as PluginRuntime;
    const boundProvider = buildCodexRealtimeVoiceProvider({ runtime });
    const bridge = boundProvider.createBridge({
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } },
      agentId: "main",
      sessionKey: "agent:main:main",
      senderId: "voice-user",
      senderIsOwner: false,
      toolsAllow: ["read"],
      onAgentEvent,
      providerConfig: {},
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    } as RealtimeVoiceBridgeCreateRequest);
    const beforeConnect = Buffer.from([1, 0, 2, 0]);
    const whileConnecting = Buffer.from([3, 0, 4, 0]);

    expect(() => bridge.sendAudio(beforeConnect)).not.toThrow();
    const connect = bridge.connect();
    await vi.waitFor(() => expect(connectInner).toHaveBeenCalledOnce());
    expect(() => bridge.sendAudio(whileConnecting)).not.toThrow();
    expect(sendInnerAudio).not.toHaveBeenCalled();

    resolveInnerConnect();
    await connect;

    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        sessionKey: "agent:main:main",
        senderId: "voice-user",
        senderIsOwner: false,
        toolsAllow: ["read"],
        onAgentEvent,
        suppressNextUserMessagePersistence: true,
        suppressTranscriptOnlyAssistantPersistence: true,
        workspaceDir: "/tmp/session-worktree",
        cwd: "/tmp/session-worktree",
      }),
    );
    expect(sendInnerAudio.mock.calls.map(([audio]) => audio)).toEqual([
      beforeConnect,
      whileConnecting,
    ]);
    bridge.close();
    expect(closeInner).toHaveBeenCalledOnce();
    expect(runSignal?.aborted).toBe(false);
  });

  it("rejects startup when the embedded run ends before publishing a bridge", async () => {
    let sessionEntry: { sessionId: string; updatedAt: number; [key: string]: unknown } | undefined;
    const runtime = {
      agent: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/codex-realtime-sessions.sqlite"),
          patchSessionEntry: vi.fn(async (params) => {
            const base = sessionEntry ?? params.fallbackEntry;
            sessionEntry = { ...base, ...(await params.update(base)), updatedAt: Date.now() };
            return sessionEntry;
          }),
        },
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentTimeoutMs: vi.fn(() => 60_000),
        runEmbeddedAgent: vi.fn(async () => ({ terminal: { kind: "failed" } })),
      },
    } as unknown as PluginRuntime;
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = buildCodexRealtimeVoiceProvider({ runtime }).createBridge({
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } },
      agentId: "main",
      sessionKey: "agent:main:main",
      providerConfig: {},
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
      onClose,
    } as RealtimeVoiceBridgeCreateRequest);

    await expect(bridge.connect()).rejects.toThrow(
      "Codex realtime session ended before publishing its bridge",
    );
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
  });

  it("aborts an in-flight startup when the host closes", async () => {
    let runSignal: AbortSignal | undefined;
    let sessionEntry: { sessionId: string; updatedAt: number; [key: string]: unknown } | undefined;
    const runtime = {
      agent: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/codex-realtime-sessions.sqlite"),
          patchSessionEntry: vi.fn(async (params) => {
            const base = sessionEntry ?? params.fallbackEntry;
            sessionEntry = { ...base, ...(await params.update(base)), updatedAt: Date.now() };
            return sessionEntry;
          }),
        },
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentTimeoutMs: vi.fn(() => 60_000),
        runEmbeddedAgent: vi.fn(async (params) => {
          runSignal = params.abortSignal;
          await new Promise<void>((resolve) => {
            params.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }),
      },
    } as unknown as PluginRuntime;
    const bridge = buildCodexRealtimeVoiceProvider({ runtime }).createBridge({
      cfg: { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } },
      agentId: "main",
      sessionKey: "agent:main:main",
      providerConfig: {},
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    } as RealtimeVoiceBridgeCreateRequest);

    const connect = bridge.connect();
    await vi.waitFor(() => expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledOnce());
    bridge.close();
    expect(runSignal?.aborted).toBe(true);

    await expect(connect).rejects.toThrow(
      "Codex realtime session ended before publishing its bridge",
    );
  });
});
