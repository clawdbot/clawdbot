import { randomUUID } from "node:crypto";
import {
  parseModelRef,
  resolveAgentConfig,
  resolveDefaultModelForAgent,
} from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  convertPcmToMulaw8k,
  ensureRealtimeVoiceAgentSessionEntry,
  mulawToPcm,
  resamplePcm,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

function resolveBoundModelRef(params: {
  cfg: RealtimeVoiceBridgeCreateRequest["cfg"];
  agentId: string;
  providerOverride?: unknown;
  modelOverride?: unknown;
}): { provider: string; model: string } {
  const configured = resolveDefaultModelForAgent({ cfg: params.cfg!, agentId: params.agentId });
  const modelOverride = normalizeOptionalString(params.modelOverride);
  if (!modelOverride) {
    return configured;
  }
  const providerOverride = normalizeOptionalString(params.providerOverride);
  if (providerOverride) {
    const prefix = `${providerOverride.toLowerCase()}/`;
    return {
      provider: providerOverride,
      model: modelOverride.toLowerCase().startsWith(prefix)
        ? modelOverride.slice(providerOverride.length + 1)
        : modelOverride,
    };
  }
  return parseModelRef(modelOverride, configured.provider) ?? configured;
}

function resolveCodexRealtimeConfig(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const version = normalizeOptionalString(rawConfig.version);
  if (version && version !== "v3") {
    throw new Error('Codex realtime supports only version "v3"');
  }
  if (rawConfig.apiKey !== undefined) {
    throw new Error(
      "Codex realtime V3 uses the Codex app-server subscription; apiKey is unsupported",
    );
  }
  return { ...rawConfig, version: "v3" };
}

async function runBoundCodexRealtimeSession(params: {
  runtime: PluginRuntime;
  request: RealtimeVoiceBridgeCreateRequest;
  abortSignal: AbortSignal;
  onBridgeReady: (bridge: RealtimeVoiceBridge) => void;
}): Promise<unknown> {
  const cfg = params.request.cfg;
  const sessionKey = params.request.sessionKey?.trim();
  if (!cfg || !sessionKey) {
    throw new Error("Codex realtime requires an existing OpenClaw session");
  }
  const agentId = params.request.agentId?.trim() || "main";
  const storePath = params.runtime.agent.session.resolveStorePath(cfg.session?.store, { agentId });
  const sessionEntry = await ensureRealtimeVoiceAgentSessionEntry({
    cfg,
    agentRuntime: params.runtime.agent,
    agentId,
    sessionKey,
    storePath,
    logger: { warn: () => undefined },
  });

  const modelRef = resolveBoundModelRef({
    cfg,
    agentId,
    providerOverride: sessionEntry.providerOverride,
    modelOverride: sessionEntry.modelOverride,
  });
  const workspaceDir =
    normalizeOptionalString(sessionEntry.spawnedCwd) ??
    params.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
  const agentConfig = resolveAgentConfig(cfg, agentId);
  return params.runtime.agent.runEmbeddedAgent({
    sessionId: sessionEntry.sessionId,
    sessionKey,
    sessionTarget: { agentId, sessionId: sessionEntry.sessionId, sessionKey, storePath },
    sandboxSessionKey: sessionKey,
    agentId,
    messageProvider: "voice",
    senderId: params.request.senderId,
    senderIsOwner: params.request.senderIsOwner === true,
    toolsAllow: params.request.toolsAllow,
    verboseLevel: (sessionEntry.verboseLevel ?? agentConfig?.verboseDefault) as
      | "off"
      | "on"
      | "full"
      | undefined,
    toolProgressDetail: cfg.agents?.defaults?.toolProgressDetail,
    workspaceDir,
    cwd: workspaceDir,
    agentDir: params.runtime.agent.resolveAgentDir(cfg, agentId),
    config: cfg,
    prompt: "",
    provider: modelRef.provider,
    model: modelRef.model,
    modelSelectionLocked: sessionEntry.modelSelectionLocked === true,
    agentHarnessRuntimeOverride: "codex",
    suppressNextUserMessagePersistence: true,
    suppressTranscriptOnlyAssistantPersistence: true,
    timeoutMs: params.runtime.agent.resolveAgentTimeoutMs({ cfg }),
    runId: `codex-realtime:${randomUUID()}`,
    abortSignal: params.abortSignal,
    onAgentEvent: params.request.onAgentEvent,
    realtimeVoice: {
      request: params.request,
      onBridgeReady: params.onBridgeReady,
    },
  });
}

class CodexBoundRealtimeVoiceBridge implements RealtimeVoiceBridge {
  readonly handlesInputAudioBargeIn = true;
  readonly supportsToolResultContinuation = false;
  readonly supportsToolResultSuppression = false;
  private readonly abortController = new AbortController();
  private readonly audioFormat;
  private readonly codexRequest: RealtimeVoiceBridgeCreateRequest;
  private readonly pendingAudio = createRealtimeVoiceAudioQueue("reject-newest");
  private inner?: RealtimeVoiceBridge;
  private run?: Promise<unknown>;
  private acceptsAudio = false;
  private closed = false;

  constructor(
    private readonly runtime: PluginRuntime,
    private readonly request: RealtimeVoiceBridgeCreateRequest,
  ) {
    this.audioFormat = request.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
    this.codexRequest = {
      ...request,
      providerConfig: resolveCodexRealtimeConfig(request.providerConfig),
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      onAudio: (audio) =>
        request.onAudio(
          this.audioFormat.encoding === "g711_ulaw"
            ? convertPcmToMulaw8k(audio, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz)
            : audio,
        ),
    };
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Codex realtime bridge is closed");
    }
    if (this.inner) {
      await this.inner.connect();
      this.enableAudio();
      return;
    }
    const bridgeReady = createDeferred<RealtimeVoiceBridge>();
    let bridgePublished = false;
    this.run = runBoundCodexRealtimeSession({
      runtime: this.runtime,
      request: this.codexRequest,
      abortSignal: this.abortController.signal,
      onBridgeReady: (bridge) => {
        bridgePublished = true;
        bridgeReady.resolve(bridge);
      },
    })
      .then((result) => {
        if (!bridgePublished) {
          throw new Error("Codex realtime session ended before publishing its bridge");
        }
        return result;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(formatErrorMessage(error));
        this.acceptsAudio = false;
        this.pendingAudio.clear();
        bridgeReady.reject(normalized);
        if (!this.closed && !this.inner) {
          this.request.onError?.(normalized);
          this.request.onClose?.("error");
        }
        throw normalized;
      });
    void this.run.catch(() => undefined);
    this.inner = await bridgeReady.promise;
    if (this.closed) {
      this.inner.close();
      return;
    }
    try {
      await this.inner.connect();
      this.enableAudio();
    } catch (error) {
      this.acceptsAudio = false;
      this.pendingAudio.clear();
      this.abortController.abort(error);
      await this.run.catch(() => undefined);
      throw error;
    }
  }

  sendAudio(audio: Buffer): void {
    const pcm = this.audioFormat.encoding === "g711_ulaw" ? mulawToPcm(audio) : audio;
    const converted = resamplePcm(
      pcm,
      this.audioFormat.sampleRateHz,
      REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    );
    if (!this.acceptsAudio || !this.inner) {
      if (this.closed) {
        throw new Error("Codex realtime bridge is not connected");
      }
      this.pendingAudio.enqueue(converted);
      return;
    }
    this.inner.sendAudio(converted);
  }

  setMediaTimestamp(ts: number): void {
    this.inner?.setMediaTimestamp(ts);
  }

  sendUserMessage(text: string): void {
    this.requireInner().sendUserMessage?.(text);
  }

  triggerGreeting(instructions?: string): void {
    this.requireInner().triggerGreeting?.(instructions);
  }

  handleBargeIn(): void {
    // Codex Realtime V3 owns VAD, cancellation, and interruption.
  }

  submitToolResult(): never {
    throw new Error("Codex realtime executes the bound agent's tools natively");
  }

  acknowledgeMark(markName?: string): void {
    this.inner?.acknowledgeMark(markName);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.acceptsAudio = false;
    this.pendingAudio.clear();
    if (this.inner) {
      this.inner.close();
    } else {
      this.abortController.abort();
    }
  }

  isConnected(): boolean {
    return !this.closed && (this.inner?.isConnected() ?? false);
  }

  private requireInner(): RealtimeVoiceBridge {
    if (!this.inner || this.closed) {
      throw new Error("Codex realtime bridge is not connected");
    }
    return this.inner;
  }

  private enableAudio(): void {
    if (!this.inner || this.closed) {
      this.pendingAudio.clear();
      throw new Error("Codex realtime bridge closed during startup");
    }
    while (true) {
      const audio = this.pendingAudio.dequeue();
      if (!audio) {
        this.acceptsAudio = true;
        return;
      }
      this.inner.sendAudio(audio);
    }
  }
}

export function buildCodexRealtimeVoiceProvider(options: {
  runtime: PluginRuntime;
}): RealtimeVoiceProviderPlugin {
  return {
    id: "codex",
    label: "Codex Realtime",
    autoSelectOrder: 100,
    capabilities: {
      transports: ["gateway-relay"],
      brains: ["codex-realtime"],
      inputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      outputAudioFormats: [
        REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      ],
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
    },
    resolveConfig: ({ rawConfig }) => resolveCodexRealtimeConfig(rawConfig),
    isConfigured: () => true,
    createBridge: (request) => new CodexBoundRealtimeVoiceBridge(options.runtime, request),
  };
}
